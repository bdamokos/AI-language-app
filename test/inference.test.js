import assert from 'node:assert/strict';
import test from 'node:test';
import { createInference, readResponseStream } from '../server/inference.js';

const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const complete = text => ({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
function stream(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-fixture' } });
}

test('SSE handles split UTF-8 and CRLF frames and waits for completed', async () => {
  const wire = new TextEncoder().encode(': heartbeat\r\n\r\n' + event({ type: 'response.output_text.delta', delta: '¡Hola!' }) + event(complete('¡Hola!')));
  const chunks = Array.from(wire, byte => new Uint8Array([byte]));
  const deltas = [];
  assert.equal(await readResponseStream(stream(chunks), { onDelta: text => deltas.push(text) }), '¡Hola!');
  assert.deepEqual(deltas, ['¡Hola!']);
});

test('partial content, DONE sentinel, incomplete and late quota failure never become successful lessons', async () => {
  const partial = event({ type: 'response.output_text.delta', delta: '{"items":[]}' });
  await assert.rejects(readResponseStream(stream([partial, 'data: [DONE]\n\n'])), { code: 'interrupted_stream' });
  await assert.rejects(readResponseStream(stream([partial, event({ type: 'response.incomplete' })])), { code: 'incomplete_response' });
  await assert.rejects(readResponseStream(stream([partial, event({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PRIVATE UPSTREAM MESSAGE' } } })])), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(error.requestId, 'req-fixture');
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});

test('rejects refusal, missing completion status, empty output, malformed and oversized frames', async () => {
  await assert.rejects(readResponseStream(stream([event({ type: 'response.completed', response: {} })])), { code: 'incomplete_response' });
  await assert.rejects(readResponseStream(stream([event(complete(''))])), { code: 'empty_response' });
  await assert.rejects(readResponseStream(stream(['data: {no json}\n\n'])), { code: 'invalid_stream' });
  await assert.rejects(readResponseStream(stream([event({ type: 'response.refusal.delta', delta: 'No' })])), { code: 'generation_refused' });
  await assert.rejects(readResponseStream(stream(['x'.repeat(3 * 1024 * 1024 + 1)])), { code: 'output_too_large' });
});

test('uses each account token/catalog/model and only permitted Responses fields', async () => {
  const calls = [];
  const auth = { async getAccessToken(account) { return `token-${account.accountId}`; } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const account = options.headers.authorization.replace('Bearer token-', '');
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: `${account}-first`, display_name: 'First', visibility: 'list' }, { slug: `${account}-second`, display_name: 'Second', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] });
    return stream([event(complete('{"items":[]}'))]);
  };
  const inference = createInference({ auth, fetchImpl });
  const alice = { auth: { accountId: 'alice' } }, bob = { auth: { accountId: 'bob' } };
  assert.equal((await inference.listModels(alice)).selectedModel, 'alice-first');
  assert.equal((await inference.listModels(bob)).selectedModel, 'bob-first');
  await inference.selectModel(alice, 'alice-second');
  await assert.rejects(inference.selectModel(bob, 'alice-second'), { code: 'invalid_model' });
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } } } } } };
  const original = JSON.stringify(schema);
  assert.equal(await inference.generate(alice, { system: 'Teach Spanish', user: 'Practice', jsonSchema: schema, schemaName: 'practice' }), '{"items":[]}');
  const call = calls.at(-1), payload = JSON.parse(call.body);
  assert.equal(call.headers.authorization, 'Bearer token-alice');
  assert.equal(call.redirect, 'error');
  assert.deepEqual(Object.keys(payload).sort(), ['model', 'input', 'store', 'stream', 'instructions', 'text'].sort());
  assert.equal(payload.model, 'alice-second');
  assert.equal(payload.store, false);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.input, [{ role: 'user', content: 'Practice' }]);
  assert.deepEqual(payload.text.format.schema.required, ['items']);
  assert.equal(payload.text.format.schema.properties.items.items.additionalProperties, false);
  assert.equal(JSON.stringify(schema), original);
  assert.equal(await inference.getModel(bob), 'bob-first');
  const pending = { auth: { accountId: 'alice' } };
  assert.equal(await inference.getModel(pending), 'alice-second');
  await inference.selectModel({ auth: { accountId: 'alice' } }, 'alice-first');
  await inference.generate(pending, { user: 'Another exercise' });
  assert.equal(JSON.parse(calls.at(-1).body).model, 'alice-second');
  assert.equal(await inference.getModel({ auth: { accountId: 'alice' } }), 'alice-first');
});

test('HTTP admission errors preserve status and safe codes without exposing provider bodies', async () => {
  const auth = { getAccessToken: async () => 'fake-token' };
  const inference = createInference({ auth, fetchImpl: async () => Response.json({ detail: 'private-token-may-appear' }, { status: 403, headers: { 'x-request-id': 'request-403' } }) });
  await assert.rejects(inference.listModels({ auth: { accountId: 'a' } }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.requestId, 'request-403');
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
});

test('model catalogs fail closed and cached catalogs still validate the session', async () => {
  let valid = true;
  const auth = { getAccessToken: async () => { if (!valid) throw Object.assign(new Error('signed out'), { status: 401 }); return 'fake'; } };
  const inference = createInference({ auth, fetchImpl: async () => Response.json({ models: [{ slug: 'model', visibility: 'list' }] }) });
  const req = { auth: { accountId: 'a' } };
  assert.equal(await inference.getModel(req), 'model');
  valid = false;
  await assert.rejects(inference.getModel(req), { status: 401 });
  await assert.rejects(inference.getModel({}), { status: 401 });
});

test('request timeout and caller abort cancel upstream fetch', async () => {
  const auth = { getAccessToken: async () => 'fake' };
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  // Keep the event loop alive while the adapter's deliberately unref'd deadline expires.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const inference = createInference({ auth, fetchImpl, timeoutMs: 20 });
    await assert.rejects(inference.getModel({ auth: { accountId: 'a' } }), { status: 504, code: 'inference_timeout' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(inference.getModel({ auth: { accountId: 'b' }, inferenceSignal: controller.signal }), { status: 499, code: 'request_cancelled' });
  } finally { clearInterval(keepAlive); }
});

test('one cancelled cold catalog lookup does not cancel another same-account request', async () => {
  const pending = [];
  const inference = createInference({
    auth: { getAccessToken: async () => 'fake' },
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      pending.push({ resolve, signal });
    }),
  });
  const firstController = new AbortController();
  const first = inference.listModels({ auth: { accountId: 'same' }, inferenceSignal: firstController.signal });
  const second = inference.listModels({ auth: { accountId: 'same' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  firstController.abort();
  await assert.rejects(first, { code: 'request_cancelled' });
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve(Response.json({ models: [{ slug: 'model', visibility: 'list' }] }));
  assert.equal((await second).selectedModel, 'model');
});
