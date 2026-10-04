import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

for (const entrypoint of ['npm start', 'node server/index.js']) {
  test(`${entrypoint} starts an isolated local client despite hosted settings`, {
    timeout: 20_000,
    skip: process.platform === 'win32' ? 'This subprocess test requires POSIX SIGINT shutdown semantics' : false
  }, async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'language-entrypoint-'));
    const dataDir = path.join(temporary, 'local-data');
    const observations = path.join(temporary, 'observations.jsonl');
    const preload = path.join(temporary, 'observe-and-block-network.mjs');
    const port = await freePort();
    let hostedPort = await freePort();
    while (hostedPort === port) hostedPort = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const hostedClient = 'oaiapp_hosted_must_be_ignored';
    const hostedSecret = 'synthetic-hosted-secret-must-not-leave';

    // Observe the real bound socket without changing listen arguments. Only
    // discovery is simulated; all other outbound fetches fail inside the child.
    await fs.writeFile(preload, `
      import fs from 'node:fs';
      import net from 'node:net';
      const record = value => fs.appendFileSync(process.env.ENTRYPOINT_OBSERVATIONS, JSON.stringify(value) + '\\n');
      const listen = net.Server.prototype.listen;
      net.Server.prototype.listen = function (...args) {
        this.once('listening', () => record({ kind: 'listen', address: this.address() }));
        return Reflect.apply(listen, this, args);
      };
      globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        record({ kind: 'fetch', url, headers: Object.fromEntries(new Headers(options.headers)), body: options.body ? String(options.body) : null });
        const issuer = 'https://auth.openai.com';
        if (url !== issuer + '/.well-known/openid-configuration') throw new Error('Unexpected outbound request in entrypoint test');
        return new Response(JSON.stringify({
          issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/keys', revocation_endpoint: issuer + '/revoke'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    `);

    const child = spawn(entrypoint === 'npm start' ? 'npm' : process.execPath,
      entrypoint === 'npm start' ? ['start', '--silent'] : ['server/index.js'], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          ENTRYPOINT_OBSERVATIONS: observations,
          LANGUAGE_AI_PORT: String(port), LANGUAGE_AI_DATA_DIR: dataDir,
          HOST: '0.0.0.0', PORT: String(hostedPort), APP_ORIGIN: 'https://hosted.invalid',
          OPENAI_CLIENT_ID: hostedClient, OPENAI_CLIENT_SECRET: hostedSecret,
          OPENAI_TOKEN_AUTH_METHOD: 'client_secret_basic',
          OPENAI_REDIRECT_URI: 'https://hosted.invalid/api/auth/callback',
          TRUSTED_PROXY_CIDRS: '0.0.0.0/0',
          AUTH_DIR: path.join(temporary, 'unused-hosted-auth'),
          CACHE_DIR: path.join(temporary, 'unused-hosted-cache')
        }
      });
    let output = '', result, spawnError;
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-10_000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-10_000); });
    const exited = new Promise(resolve => {
      child.once('error', error => { spawnError = error; resolve(); });
      child.once('close', (code, signal) => { result = { code, signal }; resolve(); });
    });
    t.after(async () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await exited;
      await fs.rm(temporary, { recursive: true, force: true });
    });

    await waitFor(() => {
      if (spawnError) throw spawnError;
      assert.equal(result, undefined, `Entrypoint stopped before becoming ready: ${output}`);
      return output.includes(`Language practice: ${origin}`);
    }, 'the local launcher');
    const request = (route, options = {}) => fetch(new URL(route, origin), {
      redirect: 'manual', signal: AbortSignal.timeout(3_000), ...options
    });
    assert.equal((await request('/healthz')).status, 200);
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html\b/);
    const html = await page.text();
    assert.match(html, /<title>Language AI App<\/title>/);
    const moduleScript = html.match(/<script\b(?=[^>]*\btype=["']module["'])[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
    assert.ok(moduleScript, 'the built page must load a JavaScript module');
    const assetUrl = new URL(moduleScript[1], origin);
    assert.equal(assetUrl.origin, origin);
    assert.match(assetUrl.pathname, /\.js$/);
    const asset = await request(assetUrl.href);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /^(?:text|application)\/javascript\b/);
    assert.ok((await asset.text()).trim().length > 0, 'the JavaScript bundle must have content');
    const sessionResponse = await request('/api/auth/session');
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.mode, 'local');
    assert.equal(session.configured, true);
    assert.equal(session.authenticated, false);
    assert.deepEqual(session.accounts, []);
    const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^language_local_/);

    for (const headers of [
      { host: 'attacker.invalid' }, { origin: 'https://hosted.invalid' },
      { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }
    ]) {
      // Use raw HTTP so the test actually sends Host overrides; fetch may
      // normalize that header back to the request URL on some Node versions.
      const status = await new Promise((resolve, reject) => {
        const probe = http.get(new URL('/healthz', origin), { headers }, response => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        });
        probe.once('error', reject);
        probe.setTimeout(3_000, () => probe.destroy(new Error('Guard probe timed out')));
      });
      assert.equal(status, 403, `Rejected headers: ${JSON.stringify(headers)}`);
    }

    const login = await request('/api/auth/login', {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ enableInference: true })
    });
    assert.equal(login.status, 200);
    const loginData = await login.json();
    const authorization = new URL(loginData.url);
    assert.equal(authorization.origin, 'https://auth.openai.com');
    assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/api/auth/callback`);
    assert.ok(authorization.searchParams.get('ext_agent_host_id'));
    assert.equal(authorization.searchParams.has('client_secret'), false);

    const events = (await fs.readFile(observations, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter(event => event.kind === 'listen').map(event => event.address), [
      { address: '127.0.0.1', family: 'IPv4', port }
    ]);
    const discovery = events.filter(event => event.kind === 'fetch');
    assert.equal(discovery.length, 1);
    assert.equal(discovery[0].url, 'https://auth.openai.com/.well-known/openid-configuration');
    assert.equal(discovery[0].headers.authorization, undefined);
    const exposed = JSON.stringify({ events, session, loginData, output });
    assert.equal(exposed.includes(hostedClient), false);
    assert.equal(exposed.includes(hostedSecret), false);
    for (const directory of ['unused-hosted-auth', 'unused-hosted-cache']) {
      await assert.rejects(fs.stat(path.join(temporary, directory)), { code: 'ENOENT' });
    }

    const owner = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime.lock', 'owner.json'), 'utf8'));
    assert.ok(Number.isInteger(owner.pid) && owner.pid > 0);
    process.kill(owner.pid, 'SIGINT');
    await waitFor(() => result !== undefined, 'graceful SIGINT shutdown');
    await exited;
    assert.deepEqual(result, { code: 0, signal: null });
    await assert.rejects(fs.stat(path.join(dataDir, 'runtime.lock')), { code: 'ENOENT' });
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => socket.close(resolve));
  });
}
