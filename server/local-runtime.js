import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { createInference } from './inference.js';
import { createApp } from './app.js';
import { drainCacheWrites } from './cacheStore.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultLocalDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Language AI App');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Language AI App');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'language-ai-app');
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('The local data directory must not be a symbolic link.');
  await fs.chmod(directory, 0o700);
  return fs.realpath(directory);
}

/** One foreground runtime owns a data directory. Never steal a lock on a timer:
 * a suspended computer may still have a rotating refresh request in progress. */
async function acquireLock(directory) {
  const lock = path.join(directory, 'runtime.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`The local app's data is already locked. Stop its other running instance first. If it crashed, verify the previous process has stopped before removing ${lock}.`);
  }
  try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.rm(lock, { recursive: true, force: true });
  };
}

/** Dependency injection is for protocol tests; the executable uses OpenAI only.
 * Binding and callback host are deliberately not configurable. */
export async function startLocalRuntime({ port = 3210, dataDir = defaultLocalDataDir(), distDir = path.join(root, 'dist'), issuer, fetch: fetchImpl, baseUrl, production = true } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The local port must be a valid TCP port.');
  dataDir = await privateDirectory(path.resolve(dataDir));
  const release = await acquireLock(dataDir);
  let handler = (_req, res) => { res.writeHead(503, { 'Retry-After': '1' }); res.end('Starting language practice.'); };
  const server = http.createServer((req, res) => handler(req, res));
  const lifetime = new AbortController();
  server.requestTimeout = 150_000;
  server.headersTimeout = 20_000;
  let auth;
  let closing;
  const close = () => closing ??= (async () => {
    // Also cancels requests that have not finished authentication yet and will
    // create their per-request controller only after shutdown has begun.
    lifetime.abort();
    handler = (_req, res) => { res.writeHead(503); res.end('Language practice is stopping.'); };
    const stopped = new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    server.closeAllConnections();
    await stopped;
    // Auth waits for its active operations before reporting a persistence error.
    // Finish draining other writes and release ownership even in that case.
    let authError, authFailed = false;
    try { await auth?.close?.(); }
    catch (error) { authFailed = true; authError = error; }
    await drainCacheWrites(path.join(dataDir, 'cache'));
    await release();
    if (authFailed) throw authError;
  })();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const cacheDir = await privateDirectory(path.join(dataDir, 'cache'));
    auth = await createAuth({ issuer, fetch: fetchImpl, config: { mode: 'local', appOrigin: origin, redirectUri: `${origin}/api/auth/callback`, authDir: path.join(dataDir, 'auth'), cacheDir } });
    const inference = createInference({ auth, ...(fetchImpl ? { fetchImpl } : {}), ...(baseUrl ? { baseUrl } : {}) });
    const app = createApp({ auth, inference, cacheDir, distDir, production, trustedProxyCidrs: '', lifetimeSignal: lifetime.signal });
    handler = (req, res) => {
      // DNS rebinding and forwarded requests are rejected before any route,
      // including the static UI. Local registration must stay on this computer.
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ code: 'local_only', error: 'Open this app directly on this computer using its 127.0.0.1 address.' }));
        return;
      }
      app(req, res);
    };
    return { origin, dataDir, server, auth, inference, close };
  } catch (error) {
    await close();
    throw error;
  }
}
