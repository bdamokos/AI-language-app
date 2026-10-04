// This entrypoint never loads hosted .env configuration or provider API keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalRuntime } from './local-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LANGUAGE_AI_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LANGUAGE_AI_PORT must be a TCP port between 1 and 65535.');
await fs.access(path.join(root, 'dist', 'index.html')).catch(() => { throw new Error('Build the application first with npm run build, or start it with npm run local.'); });

try {
  const runtime = await startLocalRuntime({ port, dataDir: process.env.LANGUAGE_AI_DATA_DIR || undefined });
  console.log(`Language practice: ${runtime.origin}`);
  console.log('Open this address in your browser and continue with ChatGPT. Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    // If shutdown cannot finish, retain the lock for manual recovery rather
    // than allowing a replacement process to race pending credential writes.
    const timeout = setTimeout(() => process.exit(1), 15_000);
    timeout.unref();
    try { await runtime.close(); clearTimeout(timeout); process.exit(0); }
    catch { process.exit(1); }
  });
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the existing app or choose LANGUAGE_AI_PORT.` : error.message);
  process.exitCode = 1;
}
