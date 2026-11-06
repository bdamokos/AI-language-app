import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function waitFor(check, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail('Timed out waiting for ' + description);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test('hosted ' + signal + ' drains a disconnected token rotation before exit and restart', {
    timeout: 20_000, skip: process.platform === 'win32' ? 'Requires POSIX signals' : false
  }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'language-hosted-shutdown-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const start = async (restart = false) => {
      const child = fork(path.join(root, 'server/hosted.js'), [], {
        cwd: dir, silent: true,
        execArgv: ['--import=' + pathToFileURL(path.join(root, 'test-support/hosted-entrypoint-fixture.js')).href],
        env: {
          ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '', HOST: '127.0.0.1', PORT: String(port),
          APP_ORIGIN: origin, AUTH_DIR: path.join(dir, 'auth'), CACHE_DIR: path.join(dir, 'cache'),
          OPENAI_CLIENT_ID: 'oaiapp_fixture', OPENAI_CLIENT_SECRET: '', OPENAI_TOKEN_AUTH_METHOD: 'none',
          OPENAI_REDIRECT_URI: origin + '/api/auth/callback', TRUSTED_PROXY_CIDRS: '',
          HOSTED_FIXTURE_RESTART: restart ? '1' : ''
        }
      });
      let output = '', result, rotating = false;
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('message', message => { if (message.type === 'rotation') rotating = true; });
      const exited = new Promise(resolve => child.once('exit', (code, exitSignal) => { result = { code, signal: exitSignal }; resolve(); }));
      t.after(async () => { if (!result) { child.kill('SIGKILL'); await exited; } });
      await waitFor(() => output.includes('listening on port'), 'hosted startup: ' + output);
      return { child, exited, result: () => result, rotating: () => rotating, output: () => output };
    };
    const runtime = await start();
    let cookie, csrf;
    const request = async (route, body) => {
      const response = await fetch(origin + route, {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin, 'content-type': 'application/json', 'x-csrf-token': csrf } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    };
    const session = await (await request('/api/auth/session')).json();
    assert.equal(session.configured, true);
    csrf = session.csrfToken;
    const login = await request('/api/auth/login', { enableInference: true });
    assert.equal(login.status, 200);
    const authorization = new URL((await login.json()).url);
    await new Promise((resolve, reject) => runtime.child.send({ type: 'nonce', value: authorization.searchParams.get('nonce') }, error => error ? reject(error) : resolve()));
    const callback = await request('/api/auth/callback?code=fixture-code&state=' + authorization.searchParams.get('state'));
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth'), 'success');
    assert.equal((await (await request('/api/auth/session')).json()).authenticated, true);

    const pending = http.get(origin + '/api/models', { headers: { cookie } });
    pending.on('error', () => {});
    await waitFor(runtime.rotating, 'in-flight token rotation');
    const disconnected = new Promise(resolve => pending.once('close', resolve));
    pending.destroy();
    await disconnected;
    runtime.child.kill(signal);
    await delay(100);
    assert.equal(runtime.result(), undefined, 'The process exited before rotated credentials could persist');
    // Repeated and alternate signals must share the same shutdown operation.
    runtime.child.kill(signal);
    await delay(50);
    assert.equal(runtime.result(), undefined, 'A repeated signal interrupted credential persistence');
    runtime.child.kill(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
    await delay(50);
    assert.equal(runtime.result(), undefined);
    runtime.child.send({ type: 'release' });
    await runtime.exited;
    assert.deepEqual(runtime.result(), { code: 0, signal: null }, runtime.output());

    const restarted = await start(true);
    const models = await request('/api/models');
    assert.equal(models.status, 200, await models.text());
    assert.equal(restarted.rotating(), false, 'Restart should use the persisted rotated access token');
    restarted.child.kill(signal);
    await restarted.exited;
    assert.deepEqual(restarted.result(), { code: 0, signal: null }, restarted.output());
  });
}
