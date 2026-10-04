import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../server/auth.js';
import { createInference } from '../server/inference.js';
import { createApp } from '../server/app.js';
import { startOpenAIFixture } from '../test-support/openai-fixture.js';

function browser(origin) {
  const cookies = new Map();
  let csrf;
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(new URL(route, origin), { method, redirect: 'manual', headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(method !== 'GET' ? { origin, 'x-csrf-token': csrf || '', 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0]; const offset = pair.indexOf('='); cookies.set(pair.slice(0,offset), pair.slice(offset + 1)); }
    return response;
  };
  return {
    request,
    async session() { const response = await request('/api/auth/session'); assert.equal(response.status, 200); const value = await response.json(); csrf = value.csrfToken; return value; },
    async login(user = 'alice') {
      await this.session();
      const response = await request('/api/auth/login', { method: 'POST', body: { enableInference: true } });
      assert.equal(response.status, 200);
      const { url } = await response.json();
      const approval = new URL(url); approval.pathname = '/approve'; approval.searchParams.set('test_user', user);
      const granted = await fetch(approval, { redirect: 'manual' });
      assert.equal(granted.status, 302);
      const callback = await request(granted.headers.get('location'));
      assert.equal(callback.status, 302);
      assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth'), 'success');
      return this.session();
    }
  };
}

test('hosted OAuth → own inference → cache → model choice → sign-out, isolated across accounts', { timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'language-hosted-e2e-'));
  const provider = await startOpenAIFixture();
  let app;
  const server = http.createServer((req,res) => app(req,res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuth({ issuer: provider.origin, config: { appOrigin: origin, clientId: 'oaiapp_fixture', clientSecret: '', tokenAuthMethod: 'none', authDir: path.join(directory, 'auth'), cacheDir: path.join(directory, 'cache') } });
  const inference = createInference({ auth, baseUrl: `${provider.origin}/v1` });
  app = createApp({ auth, inference, cacheDir: path.join(directory, 'cache'), production: false });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await provider.close(); await fs.rm(directory, { recursive:true, force:true }); });
  const alice = browser(origin), bob = browser(origin);
  const initial = await alice.session();
  assert.equal(initial.authenticated, false);
  assert.equal(initial.configured, true);
  const identityA = await alice.login();
  const identityB = await bob.login('bob');
  assert.equal(identityA.user.email, 'alice@example.test');
  assert.equal(identityB.user.email, 'bob@example.test');
  assert.notEqual(identityA.user.id, identityB.user.id);
  assert.equal(identityA.inferenceEnabled, true);
  assert.doesNotMatch(JSON.stringify(identityA), /fixture-access|fixture-refresh|id_token/);

  const lesson = { topic: 'Ser y estar', language: 'es', level: 'B1' };
  const first = await alice.request('/api/explanations/stream', { method:'POST', body:lesson });
  assert.equal(first.status, 200);
  const firstText = await first.text();
  assert.match(firstText, /"type":"final"/);
  assert.match(firstText, /Alice/);
  const count = provider.stats.requests.length;
  const cached = await alice.request('/api/explanations/stream', { method:'POST', body:lesson });
  const cachedText = await cached.text();
  assert.match(cachedText, /"type":"prefill"/);
  assert.match(cachedText, /"type":"final"/);
  assert.equal(provider.stats.requests.length, count);
  const other = await bob.request('/api/explanations/stream', { method:'POST', body:lesson });
  const otherText = await other.text();
  assert.match(otherText, /Bob/);
  assert.doesNotMatch(otherText, /Alice/);
  assert.equal(provider.stats.requests.length, count + 1);

  const changed = await alice.request('/api/settings', { method:'POST', body:{model:'fixture-alternative'} });
  assert.equal(changed.status, 200);
  assert.equal((await (await alice.request('/api/models')).json()).selectedModel, 'fixture-alternative');
  assert.equal((await (await bob.request('/api/models')).json()).selectedModel, 'fixture-model');

  const exercise = await alice.request('/api/generate', { method:'POST', body:{ system:'Teach Spanish', user:'Create exactly 1 exercise about: ser y estar', schemaName:'fib_list', metadata:{language:'es',level:'B1',topic:'ser y estar',count:1}, jsonSchema:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{sentence:{type:'string'},answers:{type:'array',items:{type:'string'}},difficulty:{type:'string'}}}}}}} });
  assert.equal(exercise.status, 200);
  assert.equal((await exercise.json()).items[0].answers[0], 'está');
  assert.equal(provider.stats.requests.at(-1).user, 'alice');
  assert.equal(provider.stats.requests.at(-1).model, 'fixture-alternative');

  const quota = await alice.request('/api/explanations/stream', {method:'POST',body:{...lesson,topic:'quota-test'}});
  const quotaText = await quota.text();
  assert.match(quotaText, /subscription_sharing_usage_limit_exceeded/);
  assert.doesNotMatch(quotaText, /"type":"final"/);
  const logout = await alice.request('/api/auth/logout', { method:'POST' });
  assert.deepEqual(await logout.json(), {ok:true,revocationConfirmed:true});
  assert.equal((await alice.session()).authenticated, false);
  assert.equal((await alice.request('/api/models')).status, 401);
  assert.equal((await bob.request('/api/models')).status, 200);
  assert.equal(provider.stats.revocations, 1);

  const identityOnly = browser(origin);
  assert.equal((await identityOnly.login('identity')).inferenceEnabled, false);
  assert.equal((await identityOnly.request('/api/models')).status, 403);
});
