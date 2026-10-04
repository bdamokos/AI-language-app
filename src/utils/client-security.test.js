import assert from 'node:assert/strict';
import test from 'node:test';
import { readExplanationStream } from './explanationStream.js';
import { authRedirectUrl } from './authRedirect.js';
import { responseError } from './api.js';

test('explanation streams survive fragmented UTF-8 and CRLF frames', async () => {
  const explanation = { title: 'Greeting', content_markdown: 'Hola 👋' };
  const bytes = new TextEncoder().encode(`: keepalive\r\n\r\ndata: ${JSON.stringify({ type: 'final', explanation })}\r\n\r\n`);
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
    controller.close();
  } });
  assert.deepEqual(await readExplanationStream(new Response(stream)), explanation);
});

test('provider errors and truncated explanations are not silently swallowed', async () => {
  await assert.rejects(readExplanationStream(new Response('data: {"type":"error","error":"Plan allowance exceeded"}\n\n')), /Plan allowance exceeded/);
  await assert.rejects(readExplanationStream(new Response('data: {"type":"delta","text":"Partial"}\n\n')), /did not finish/);
  await assert.rejects(readExplanationStream(new Response('data: {broken}\n\n')), /incomplete/);
});

test('hosted sign-in cannot redirect to HTTP, scripts, or credential-bearing URLs', () => {
  const hosted = 'https://languages.example.com';
  assert.equal(authRedirectUrl('https://auth.openai.com/authorize?state=example', hosted), 'https://auth.openai.com/authorize?state=example');
  for (const target of ['http://auth.openai.com/authorize', 'http://127.0.0.1:9876/authorize', 'javascript:alert(1)', 'https://user:secret@auth.openai.com']) {
    assert.throws(() => authRedirectUrl(target, hosted), /invalid/);
  }
  assert.equal(authRedirectUrl('http://127.0.0.1:9876/authorize', 'http://localhost:3001'), 'http://127.0.0.1:9876/authorize');
  assert.throws(() => authRedirectUrl('http://external.example/authorize', 'http://localhost:3001'), /invalid/);
});

test('API mutations attach the in-memory CSRF token and preserve backend errors', async t => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/auth/session') return Response.json({ csrfToken: 'test-csrf-token' });
    if (url === '/api/generate') return Response.json({ error: 'Your ChatGPT connection needs approval.' }, { status: 403 });
    return Response.json({ ok: true });
  };
  const { apiFetch } = await import(`./api.js?test=${Date.now()}`);
  await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"example"}' });
  assert.equal(requests[0].url, '/api/auth/session');
  assert.equal(requests[1].options.headers.get('x-csrf-token'), 'test-csrf-token');
  assert.equal(requests[1].options.headers.get('content-type'), 'application/json');
  assert.equal(requests[1].options.credentials, 'same-origin');
  await assert.rejects(apiFetch('https://external.example/api/log', { method: 'POST' }), /same-origin/);
  assert.equal(requests.length, 2);
  await assert.rejects(apiFetch('/api/generate', { method: 'POST' }), /needs approval/);
});

test('generation errors show mapped usage details and preserve safe support fields', async () => {
  const error = await responseError(Response.json({
    error: 'Failed to generate content',
    details: 'Your ChatGPT usage limit has been reached. Check your plan usage.',
    message: 'Less specific message',
    code: 'subscription_sharing_usage_limit_exceeded',
    requestId: 'req_test-123'
  }, { status: 429 }));
  assert.equal(error.message, 'Your ChatGPT usage limit has been reached. Check your plan usage.');
  assert.equal(error.status, 429);
  assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(error.requestId, 'req_test-123');

  const messageFallback = await responseError(Response.json({
    details: { raw: 'ignored' }, message: 'Reconnect your account.', error: 'Generic failure'
  }, { status: 403 }));
  assert.equal(messageFallback.message, 'Reconnect your account.');

  const authError = await responseError(Response.json({
    error: { message: 'Raw provider payload must not be displayed' },
    code: 'invalid\nprovider payload', requestId: 'invalid request id'
  }, { status: 401 }));
  assert.equal(authError.message, 'Your session has expired. Sign in with ChatGPT again.');
  assert.equal(authError.code, undefined);
  assert.equal(authError.requestId, undefined);
});

test('expired CSRF refreshes account state without replaying inference and permits a fresh sign-in', async t => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const requests = [];
  let sessionReads = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/auth/session') {
      sessionReads += 1;
      return Response.json(sessionReads === 1
        ? { authenticated: true, csrfToken: 'expired-csrf' }
        : { authenticated: false, csrfToken: 'fresh-csrf' });
    }
    if (url === '/api/generate') return Response.json({ code: 'csrf_failed', error: 'Refresh the page and try again.' }, { status: 403 });
    return Response.json({ url: 'https://auth.openai.com/authorize' });
  };
  const { apiFetch, loadSession } = await import(`./api.js?csrf-expiry=${Date.now()}`);
  await loadSession();
  let refreshedSession;
  window.addEventListener('language-session-expired', () => { refreshedSession = loadSession(); });
  await assert.rejects(apiFetch('/api/generate', { method: 'POST' }), { status: 403, code: 'csrf_failed' });
  assert.ok(refreshedSession, 'the UI must be told to refresh its account state');
  assert.equal((await refreshedSession).authenticated, false);
  assert.equal(requests.filter(request => request.url === '/api/generate').length, 1, 'inference is never retried automatically');
  await apiFetch('/api/auth/login', { method: 'POST' });
  assert.equal(requests.at(-1).options.headers.get('x-csrf-token'), 'fresh-csrf');
  assert.equal(sessionReads, 2);
});
