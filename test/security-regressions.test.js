import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { ensureCacheLayout, writeJson, readJson, setExplanation, loadExercisesIndex, addExercisesToPool, makeBucketKey, sha256Hex } from '../server/cacheStore.js';

// Auth is tested against a real local OAuth fixture in auth.test.js. These
// explicit injected identities test application boundaries independently.
async function fixture(t, { rateLimitMax = 120, authRateLimitMax = 120, loginRateLimitMax = 10 } = {}) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'language-private-cache-'));
  const calls = [];
  let cancelledResolve;
  const cancelled = new Promise(resolve => { cancelledResolve = resolve; });
  const auth = {
    guard(req, res, next) { next(); },
    attachRoutes(app) {
      app.get('/api/auth/session', (req, res) => res.json({ authenticated: false }));
      app.post('/api/auth/login', (req, res) => res.json({ authorizationUrl: '/fixture' }));
    },
    requireCsrf(req, res, next) {
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== 'fixture-csrf') return res.status(403).json({ error: 'Invalid CSRF token' });
      next();
    },
    middleware(req, res, next) {
      if (!['alice', 'bob'].includes(req.headers['x-test-account'])) return res.status(401).json({ error: 'Please sign in with ChatGPT.' });
      req.auth = { accountId: req.headers['x-test-account'] };
      next();
    },
  };
  const model = req => `${req.auth.accountId}-model`;
  const inference = {
    getModel: async req => model(req),
    listModels: async req => ({ models: [{ id: model(req), name: 'ChatGPT model' }], selectedModel: model(req) }),
    selectModel: async (req, selected) => {
      if (selected !== model(req)) throw Object.assign(new Error('Choose a model available to your ChatGPT account.'), { status: 400, code: 'invalid_model' });
      return selected;
    },
    generate: async (req, options) => {
      calls.push({ account: req.auth.accountId, options });
      if (options.user.includes('cancel request')) {
        options.onDelta?.('# Partial lesson\n');
        await new Promise(resolve => req.inferenceSignal.addEventListener('abort', resolve, { once: true }));
        cancelledResolve();
        return '# Cancelled lesson\nDo not cache this output.';
      }
      if (options.user.includes('quota failure')) throw Object.assign(new Error('Your ChatGPT usage limit has been reached.'), { status: 429, code: 'subscription_sharing_usage_limit_exceeded' });
      if (options.onDelta) {
        const text = `# ${req.auth.accountId} explanation\nPrivate lesson about grammar.`;
        options.onDelta(text);
        return text;
      }
      if (options.schemaName === 'base_text') return JSON.stringify({ title: `${req.auth.accountId} story`, chapters: [{ chapter_number: 1, title: 'At home', content: 'A short practice text.' }] });
      if (options.schemaName === 'explanation') return JSON.stringify({ explanation: `${req.auth.accountId} feedback` });
      if (options.schemaName === 'recommendation') return JSON.stringify({ recommendation: 'Past tense', reasoning: 'Practice a related skill.' });
      return JSON.stringify({ items: [{ sentence: `${req.auth.accountId} _____ aquí.`, answer: 'está' }] });
    },
  };
  const app = createApp({ auth, inference, cacheDir, production: false, rateLimitMax, authRateLimitMax, loginRateLimitMax });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
  const request = (route, { account = 'alice', body, headers, ...options } = {}) => fetch(`${origin}${route}`, {
    ...options,
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-test-account': account, 'x-csrf-token': 'fixture-csrf', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, calls, cacheDir, cancelled };
}

function events(text) {
  return text.split('\n\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}

test('all lesson routes require identity and retired operator-key routes cannot be reached', async t => {
  const { request, calls } = await fixture(t);
  for (const route of ['/api/settings', '/api/models', '/api/debug', '/api/base-text-content/0000000000000000']) {
    assert.equal((await request(route, { account: '' })).status, 401, route);
  }
  for (const route of ['/api/generate', '/api/explanations/stream', '/api/base-text', '/api/explain', '/api/recommend', '/api/persist-exercise', '/api/cache/exercise-image']) {
    assert.equal((await request(route, { account: '', body: {} })).status, 401, route);
  }
  for (const route of ['/api/debug', '/api/openrouter/models', '/api/openrouter/rate-limit', '/api/ollama/models', '/api/runware/models', '/api/falai/models']) {
    assert.equal((await request(route)).status, 404, route);
  }
  for (const route of ['/api/runware/generate', '/api/falai/generate', '/api/cache/exercise-image', '/api/log']) {
    assert.equal((await request(route, { body: { baseTextId: 'x', url: 'http://127.0.0.1/private' } })).status, 404, route);
  }
  assert.equal((await request('/cache/images/index.json')).status, 404);
  assert.equal(calls.length, 0);
});

test('cached explanations complete correctly and remain private to their account', async t => {
  const { request, calls, cacheDir } = await fixture(t);
  const body = { topic: 'Present tense', language: 'es', level: 'B1' };
  const first = await request('/api/explanations/stream', { body });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /no-store/);
  assert.equal(events(await first.text()).at(-1).type, 'final');
  const cached = events(await (await request('/api/explanations/stream', { body })).text());
  assert.deepEqual(cached.map(event => event.type), ['prefill', 'final']);
  assert.equal(calls.length, 1);
  const other = events(await (await request('/api/explanations/stream', { account: 'bob', body })).text());
  assert.equal(other.at(-1).explanation.title, 'bob explanation');
  assert.equal(calls.length, 2);
  assert.deepEqual((await fs.readdir(path.join(cacheDir, 'accounts'))).sort(), [sha256Hex('alice'), sha256Hex('bob')].sort());
});

test('SSE quota failures are explicit errors, never success or cached lessons', async t => {
  const { request, calls } = await fixture(t);
  const body = { topic: 'quota failure' };
  for (let i = 0; i < 2; i++) {
    const output = events(await (await request('/api/explanations/stream', { body })).text());
    assert.equal(output.at(-1).type, 'error');
    assert.equal(output.at(-1).status, 429);
    assert.equal(output.at(-1).code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(output.some(event => event.type === 'final'), false);
  }
  assert.equal(calls.length, 2);
});

test('exercise generation, persistence and base-text lookup cannot cross accounts', async t => {
  const { request, calls } = await fixture(t);
  const body = { user: 'Create exactly 1 practice exercise.', schemaName: 'fib_list', metadata: { language: 'es', level: 'B1', topic: 'Present tense', count: 1 } };
  const a = await (await request('/api/generate', { body })).json();
  const b = await (await request('/api/generate', { account: 'bob', body })).json();
  assert.equal(a.items[0].sentence, 'alice _____ aquí.');
  assert.equal(b.items[0].sentence, 'bob _____ aquí.');
  assert.deepEqual(calls.map(call => call.account), ['alice', 'bob']);
  const generated = await (await request('/api/generate', { body: { user: 'Read a story.', schemaName: 'base_text', metadata: { language: 'es', level: 'B1', topic: 'Home' } } })).json();
  assert.match(generated.id, /^[a-f0-9]{16}$/);
  assert.equal((await request(`/api/base-text-content/${generated.id}`)).status, 200);
  assert.equal((await request(`/api/base-text-content/${generated.id}`, { account: 'bob' })).status, 404);
  assert.equal((await request('/api/persist-exercise', { body: { type: '__proto__', items: [{}] } })).status, 400);
});

test('settings change only account models and requests enforce CSRF/input/rate limits', async t => {
  const { request, calls } = await fixture(t, { rateLimitMax: 8 });
  assert.equal((await request('/api/settings', { body: { provider: 'openrouter', openrouter: { apiKey: 'must-not-be-used' } } })).status, 400);
  assert.equal((await request('/api/settings', { body: { model: 'bob-model' } })).status, 400);
  assert.equal((await request('/api/settings', { body: { model: 'alice-model' } })).status, 200);
  assert.equal((await request('/api/generate', { headers: { 'x-csrf-token': '' }, body: { user: 'hello' } })).status, 403);
  assert.equal((await request('/api/generate', { body: { user: {} } })).status, 400);
  assert.equal((await request('/api/generate', { body: { user: 'hello', metadata: { topic: {} } } })).status, 400);
  assert.equal((await request('/api/explanations/stream', { body: { topic: '' } })).status, 400);
  assert.equal((await request('/api/settings')).status, 200);
  assert.equal((await request('/api/settings')).status, 200);
  assert.equal((await request('/api/settings')).status, 429);
  assert.equal(calls.length, 0);
});

test('atomic cache writes and concurrent transactions retain all records', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'language-cache-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureCacheLayout(root);
  const target = path.join(root, 'race.json');
  await Promise.all(Array.from({ length: 20 }, (_, n) => writeJson(target, { n, text: 'x'.repeat(5000) })));
  assert.equal(typeof (await readJson(target)).n, 'number');
  await Promise.all(Array.from({ length: 20 }, (_, n) => setExplanation(layout, `exp:${n}`, { model: 'fixture' }, { title: `Lesson ${n}` })));
  assert.equal(Object.keys((await readJson(path.join(layout.explanationsDir, 'index.json'))).items).length, 20);
  const bucketKey = makeBucketKey({ type: 'fib', language: 'es', level: 'B1', challengeMode: false, grammarTopic: 'present' });
  await Promise.all(Array.from({ length: 20 }, (_, n) => addExercisesToPool(layout, { type: 'fib', poolKey: 'fib:es:B1:false:model:1:prompt', bucketKey, language: 'es', level: 'B1', model: 'model', schemaVersion: 1 }, [{ sentence: `Exercise ${n}` }])));
  assert.equal(Object.keys((await loadExercisesIndex(layout)).items).length, 20);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});


test('authentication endpoints are limited before unauthenticated session writes', async t => {
  const { request } = await fixture(t, { authRateLimitMax: 4, loginRateLimitMax: 1 });
  assert.equal((await request('/api/auth/login', { account: '', body: {} })).status, 200);
  assert.equal((await request('/api/auth/login', { account: '', body: {} })).status, 429);
  assert.equal((await request('/api/auth/session', { account: '' })).status, 200);
  assert.equal((await request('/api/auth/session', { account: '' })).status, 200);
  assert.equal((await request('/api/auth/session', { account: '' })).status, 429);
});

test('closing a streamed response cancels inference and leaves the cache empty', async t => {
  const { request, cancelled, cacheDir } = await fixture(t);
  const controller = new AbortController();
  const response = await request('/api/explanations/stream', { body: { topic: 'cancel request' }, signal: controller.signal });
  controller.abort();
  await assert.rejects(response.text());
  await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancellation was not forwarded.')), 2000); timer.unref(); })]);
  const layout = path.join(cacheDir, 'accounts', sha256Hex('alice'), 'explanations');
  assert.equal(Object.keys((await readJson(path.join(layout, 'index.json'))).items).length, 0);
});
