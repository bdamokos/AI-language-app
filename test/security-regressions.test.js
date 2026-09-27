import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForOutput(getOutput, expected, process, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getOutput().includes(expected)) return;
    if (process.exitCode !== null) {
      throw new Error(`Server exited before producing ${JSON.stringify(expected)}:\n${getOutput()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)}:\n${getOutput()}`);
}

test('client logging keeps format tokens literal and file routes enforce separate limits', { timeout: 20_000 }, async t => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'language-ai-security-'));
  const port = await reservePort();
  let output = '';
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      CACHE_DIR: cacheDir,
      CACHE_PURGE_ON_STARTUP: 'false',
      BASE_TEXT_RATE_LIMIT_MAX: '2',
      SPA_RATE_LIMIT_MAX: '3'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });

  t.after(async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  await waitForOutput(() => output, '[CACHE] Initialized', server);
  await waitForOutput(() => output, 'Server listening', server);
  const baseUrl = `http://127.0.0.1:${port}`;

  const maliciousImageServer = http.createServer((request, response) => {
    response.setHeader('content-type', 'image/../../escaped');
    response.end('not-really-an-image');
  });
  await new Promise((resolve, reject) => {
    maliciousImageServer.once('error', reject);
    maliciousImageServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    maliciousImageServer.close(error => error ? reject(error) : resolve());
  }));
  const maliciousImagePort = maliciousImageServer.address().port;
  const cacheImageResponse = await fetch(`${baseUrl}/api/cache/exercise-image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseTextId: 'security-regression',
      url: `http://127.0.0.1:${maliciousImagePort}/attacker.png`
    })
  });
  assert.equal(cacheImageResponse.status, 200);
  const cachedImage = await cacheImageResponse.json();
  assert.equal(path.dirname(cachedImage.localPath), path.join(cacheDir, 'images'));
  assert.match(cachedImage.localPath, /\.bin$/);
  assert.equal(await fs.readFile(cachedImage.localPath, 'utf8'), 'not-really-an-image');
  await assert.rejects(fs.access(path.join(cacheDir, 'escaped')), { code: 'ENOENT' });

  for (const level of ['debug', 'info', 'warn', 'error']) {
    const logResponse = await fetch(`${baseUrl}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, message: `literal ${level} %s token`, data: 'ATTACKER_DATA' })
    });
    assert.equal(logResponse.status, 200);
    await waitForOutput(() => output, `literal ${level} %s token ATTACKER_DATA`, server);
    assert.doesNotMatch(output, new RegExp(`literal ${level} ATTACKER_DATA token`));
  }

  const firstBaseText = await fetch(`${baseUrl}/api/base-text-content/missing`);
  const secondBaseText = await fetch(`${baseUrl}/api/base-text-content/missing`);
  const limitedBaseText = await fetch(`${baseUrl}/api/base-text-content/missing`);
  assert.equal(firstBaseText.status, 404);
  assert.equal(secondBaseText.status, 404);
  assert.equal(limitedBaseText.status, 429);
  assert.equal(limitedBaseText.headers.get('retry-after'), '60');

  const indexHtml = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'), 'utf8');
  const homepage = await fetch(`${baseUrl}/`);
  assert.equal(homepage.status, 200);
  assert.equal(await homepage.text(), indexHtml);

  for (const route of ['/spa-route', '/lessons/unit/exercise', '/spa-route/']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html\b/);
    assert.equal(await response.text(), indexHtml);
  }
  const limitedSpa = await fetch(`${baseUrl}/spa-route-limited`);
  assert.equal(limitedSpa.status, 429);
  assert.equal(limitedSpa.headers.get('retry-after'), '60');
});
