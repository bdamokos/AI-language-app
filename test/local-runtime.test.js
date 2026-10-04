import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startLocalRuntime } from '../server/local-runtime.js';
import { ensureCacheLayout, setExplanation, getExplanation } from '../server/cacheStore.js';

const request = (origin, headers, route = '/') => new Promise((resolve, reject) => {
  http.get(new URL(route, origin), { headers }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
  }).on('error', reject);
});

async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'language-local-runtime-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

test('local listener is fixed to IPv4 loopback and guards static pages as well as APIs', async t => {
  const dataDir = await directory(t);
  const runtime = await startLocalRuntime({ dataDir, port: 0, production: false });
  t.after(() => runtime.close());
  assert.equal(runtime.server.address().address, '127.0.0.1');
  assert.equal(runtime.auth.mode, 'local');
  assert.equal((await request(runtime.origin, {}, '/healthz')).status, 200);
  for (const route of ['/', '/api/auth/session', '/healthz']) {
    for (const headers of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-host': '127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }]) {
      assert.equal((await request(runtime.origin, headers, route)).status, 403);
    }
  }
});

test('a data directory has one runtime owner until clean shutdown releases it', async t => {
  const dataDir = await directory(t);
  const runtime = await startLocalRuntime({ dataDir, port: 0, production: false });
  t.after(() => runtime.close());
  await assert.rejects(startLocalRuntime({ dataDir, port: 0, production: false }), /already locked/);
  const owner = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime.lock', 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataDir, 'runtime.lock', 'owner.json'))).mode & 0o777, 0o600);
  }
  await runtime.close();
  const next = await startLocalRuntime({ dataDir, port: 0, production: false });
  t.after(() => next.close());
  assert.equal(next.auth.mode, 'local');
});

test('failure to bind releases storage ownership without disturbing an existing listener', async t => {
  const dataDir = await directory(t);
  const listener = http.createServer((_req, res) => res.end('other app'));
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await assert.rejects(startLocalRuntime({ dataDir, port: listener.address().port }), { code: 'EADDRINUSE' });
  await assert.rejects(fs.stat(path.join(dataDir, 'runtime.lock')), { code: 'ENOENT' });
  assert.equal(await (await fetch(`http://127.0.0.1:${listener.address().port}`)).text(), 'other app');
});

test('stale locks are not stolen and symlinked data directories are refused', async t => {
  const parent = await directory(t);
  const locked = path.join(parent, 'locked');
  await fs.mkdir(path.join(locked, 'runtime.lock'), { recursive: true });
  await fs.utimes(path.join(locked, 'runtime.lock'), 0, 0);
  await assert.rejects(startLocalRuntime({ dataDir: locked, port: 0 }), /already locked/);
  const linked = path.join(parent, 'linked');
  await fs.symlink(locked, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(startLocalRuntime({ dataDir: linked, port: 0 }), /symbolic link/);
});

test('shutdown retains exclusive ownership until a pending cache transaction finishes', async t => {
  const dataDir = await directory(t);
  const runtime = await startLocalRuntime({ dataDir, port: 0, production: false });
  t.after(() => runtime.close());
  const layout = await ensureCacheLayout(path.join(dataDir, 'cache', 'accounts', 'test-account'));
  const rename = fs.rename;
  let finishWrite, enteredWrite;
  const entered = new Promise(resolve => { enteredWrite = resolve; });
  const waiting = new Promise(resolve => { finishWrite = resolve; });
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to.startsWith(layout.explanationItemsDir)) { enteredWrite(); await waiting; }
    return rename(from, to);
  });
  const write = setExplanation(layout, 'test-lesson', { language: 'es' }, 'A completed lesson');
  await entered;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  try {
    await assert.rejects(startLocalRuntime({ dataDir, port: 0 }), /already locked/);
    assert.equal(closed, false);
  } finally { finishWrite(); }
  await write;
  await closing;
  const restored = await getExplanation(layout, 'test-lesson');
  assert.equal(restored.content, 'A completed lesson');
  const next = await startLocalRuntime({ dataDir, port: 0, production: false });
  t.after(() => next.close());
});
