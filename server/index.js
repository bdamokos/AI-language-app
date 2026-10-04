import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { createInference } from './inference.js';
import { createApp } from './app.js';

dotenv.config();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.resolve(process.env.CACHE_DIR || path.join(root, '.cache'));
const auth = await createAuth({ config: { cacheDir } });
const inference = createInference({ auth });
const app = createApp({ auth, inference, cacheDir, distDir: path.join(root, 'dist'), trustedProxyCidrs: process.env.TRUSTED_PROXY_CIDRS || '' });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const server = app.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`Language AI App listening on port ${port}`);
});
server.requestTimeout = 150_000;
server.headersTimeout = 20_000;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
