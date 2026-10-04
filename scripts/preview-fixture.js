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

const port = Number(process.env.PREVIEW_PORT || 3001);
const origin = `http://127.0.0.1:${port}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'language-ai-preview-'));
const provider = await startOpenAIFixture();
const auth = await createAuth({ issuer: provider.origin, config: { appOrigin: origin, clientId:'oaiapp_fixture', clientSecret:'', tokenAuthMethod:'none', authDir:path.join(directory,'auth'), cacheDir:path.join(directory,'cache') } });
const inference = createInference({ auth, baseUrl:`${provider.origin}/v1` });
const app = createApp({ auth, inference, cacheDir:path.join(directory,'cache'), production:true });
const server = http.createServer(app);
server.listen(port,'127.0.0.1', () => console.log(`Local test preview: ${origin} (simulated OpenAI; no real inference)`));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await provider.close();
  await fs.rm(directory,{recursive:true,force:true});
  process.exit(0);
});
