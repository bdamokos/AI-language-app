// Deliberately separate entrypoint: local demo with simulated OpenAI responses.
// The production server never imports this file or exposes a test-login route.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../server/auth.js';
import { createInference } from '../server/inference.js';
import { createApp } from '../server/app.js';
import { startOpenAIFixture } from '../test-support/openai-fixture.js';
import { startLocalRuntime } from '../server/local-runtime.js';

const local = process.argv.includes('--local');
const port = Number(process.env.PREVIEW_PORT || (local ? 3002 : 3001));
const origin = `http://127.0.0.1:${port}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'language-ai-preview-'));
const provider = await startOpenAIFixture();
let server, localRuntime, auth;
if (local) {
  localRuntime = await startLocalRuntime({ port, dataDir: directory, issuer: provider.origin, baseUrl: `${provider.origin}/v1` });
  server = localRuntime.server;
} else {
  auth = await createAuth({ issuer: provider.origin, config: { appOrigin: origin, clientId:'oaiapp_fixture', clientSecret:'', tokenAuthMethod:'none', authDir:path.join(directory,'auth'), cacheDir:path.join(directory,'cache') } });
  const inference = createInference({ auth, baseUrl:`${provider.origin}/v1` });
  const app = createApp({ auth, inference, cacheDir:path.join(directory,'cache'), production:true });
  server = http.createServer(app);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
}
console.log(`${local ? 'Local-client' : 'Hosted'} test preview: ${origin} (simulated OpenAI; no real inference)`);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
  if (localRuntime) await localRuntime.close();
  else {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await auth.close();
  }
  await provider.close();
  await fs.rm(directory,{recursive:true,force:true});
  process.exit(0);
});
