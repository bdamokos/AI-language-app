import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuth } from '../server/auth.js';
import { createLocalProfileStore } from '../server/local-profile-store.js';

const issuer = 'https://identity.example.test';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const fixtureKeys = Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);

async function harness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'language-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const [{ privateKey, publicKey }, invalidKeys] = await fixtureKeys;
  const jwk = { ...await exportJWK(publicKey), kid: 'key-1', alg: 'RS256' };
  const codes = new Map(), issuedRefresh = new Map();
  const state = { now: Date.now(), exchanges: [], refreshes: 0, revocations: 0, revokedTokens: [], sequence: 0, ...options.state };
  const app = express();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = { appOrigin: url, clientId: 'oaiapp_test', clientSecret: '', tokenAuthMethod: 'none', authDir: path.join(dir, 'auth'), cacheDir: path.join(dir, 'cache'), ...options.config };
  const makeToken = async context => {
    const claims = { iss: issuer, aud: context.clientId ?? config.clientId, sub: context.subject ?? 'alice', nonce: context.nonce, iat: Math.floor(state.now / 1000), exp: Math.floor(state.now / 1000) + 3600, name: 'Learner', email: 'learner@example.test', ...context.claims };
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).sign(context.badSignature ? invalidKeys.privateKey : privateKey);
  };
  const makeTokens = async context => {
    const id_token = await makeToken(context);
    if (context.identityOnly) return { id_token };
    const number = ++state.sequence;
    const refreshToken = state.reuseRefreshToken ?? `refresh-${number}`;
    issuedRefresh.set(refreshToken, context);
    return { id_token, access_token: `access-${number}`, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600, scope: context.scope ?? scope };
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input, init = {}) => {
    const pathname = new URL(input).pathname;
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    if (pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, revocation_endpoint: `${issuer}/revoke`, ...state.discovery });
    if (pathname === '/keys') return state.keyFailure ? json({ error: 'temporarily_unavailable' }, 503) : json({ keys: [jwk] });
    if (pathname === '/token') {
      const body = new URLSearchParams(init.body);
      state.exchanges.push({ body, headers: init.headers });
      if (config.mode !== 'local') assert.equal(body.get('client_id'), config.clientId);
      else { assert.notEqual(body.get('client_id'), 'dynamic_agent_client'); assert.equal(init.headers.authorization, undefined); assert.equal(body.has('client_secret'), false); }
      if (body.get('grant_type') === 'refresh_token') {
        state.refreshes++;
        await state.refreshWait;
        if (state.refreshError === 'network') throw new Error('offline');
        if (state.refreshError) return json({ error: state.refreshError }, state.refreshErrorStatus ?? 400);
        const context = issuedRefresh.get(body.get('refresh_token'));
        if (!context) return json({ error: 'invalid_grant' }, 400);
        if (config.mode === 'local') assert.equal(body.get('client_id'), context.clientId);
        assert.equal(body.get('resource'), 'https://api.openai.com/v1');
        assert.equal(body.has('scope'), false);
        issuedRefresh.delete(body.get('refresh_token'));
        return json(await makeTokens({ ...context, ...state.refreshContext }));
      }
      const context = codes.get(body.get('code'));
      codes.delete(body.get('code'));
      if (!context) return json({ error: 'invalid_grant' }, 400);
      if (state.codeError) return json({ error: state.codeError }, 400);
      if (config.mode === 'local') assert.equal(body.get('client_id'), context.clientId);
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), context.challenge);
      assert.equal(body.get('redirect_uri'), `${config.appOrigin}/api/auth/callback`);
      await state.exchangeWait;
      return json(await makeTokens(context));
    }
    if (pathname === '/revoke') {
      state.revocations++;
      const body = new URLSearchParams(init.body);
      state.revokedToken = body.get('token');
      state.revokedTokens.push(state.revokedToken);
      assert.equal(body.get('token_type_hint'), 'refresh_token');
      if (config.mode !== 'local') assert.equal(body.get('client_id'), config.clientId);
      else if (issuedRefresh.has(body.get('token'))) assert.equal(body.get('client_id'), issuedRefresh.get(body.get('token')).clientId);
      if (state.revokeFailure) return new Response('', { status: 503 });
      issuedRefresh.delete(body.get('token'));
      return new Response('', { status: 200 });
    }
    throw new Error(`Unexpected test endpoint ${pathname}`);
  };
  const auth = await createAuth({ config, issuer, fetch: fetchImpl, now: () => state.now });
  app.use(express.json());
  app.use('/api', auth.guard);
  auth.attachRoutes(app);
  app.use('/api', auth.requireCsrf, auth.middleware);
  app.get('/api/protected', (req, res) => { state.lastAuth = req.auth; res.json(req.auth); });
  app.post('/api/protected', (req, res) => res.json({ accountId: req.auth.accountId }));
  app.get('/api/token', async (req, res, next) => {
    try { res.json({ token: await auth.getAccessToken(req.auth) }); } catch (e) { next(e); }
  });
  app.use((e, req, res, next) => res.status(e.status ?? 500).json({ code: e.code ?? 'internal_error', error: e.message }));
  function browser() {
    return {
      cookie: '', csrf: null,
      async request(route, { method = 'GET', body, headers = {} } = {}) {
        const response = await new Promise((resolve, reject) => {
          const request = http.request(`${url}${route}`, { method, headers: { host: new URL(config.appOrigin).host, ...(this.cookie ? { cookie: this.cookie } : {}), ...(method === 'POST' ? { origin: config.appOrigin, 'x-csrf-token': this.csrf ?? '', 'content-type': 'application/json' } : {}), ...headers } }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
              resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
            });
          });
          request.on('error', reject);
          request.end(body !== undefined ? JSON.stringify(body) : undefined);
        });
        if (response.headers.has('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
        return response;
      },
      async status() { const response = await this.request('/api/auth/session'); const data = await response.json(); this.csrf = data.csrfToken; return { response, data }; },
      async start(body = {}) {
        await this.status();
        const response = await this.request('/api/auth/login', { method: 'POST', body });
        const data = await response.json();
        return { response, data, authorization: data.url ? new URL(data.url) : null };
      },
      async login(context = {}, loginBody = {}) {
        const { authorization } = await this.start(loginBody);
        assert.ok(authorization);
        const code = `code-${codes.size}-${state.sequence}`;
        const dynamic = authorization.searchParams.get('client_id') === 'dynamic_agent_client';
        const issuedClientId = dynamic ? context.issuedClientId ?? `oaiapp_local_${state.sequence}` : authorization.searchParams.get('client_id');
        codes.set(code, { nonce: authorization.searchParams.get('nonce'), challenge: authorization.searchParams.get('code_challenge'), clientId: issuedClientId, ...context });
        const callback = `/api/auth/callback?code=${code}&state=${authorization.searchParams.get('state')}${dynamic && !context.omitIssuedClientId ? `&client_id=${encodeURIComponent(issuedClientId)}` : ''}${context.callbackClientId ? `&client_id=${encodeURIComponent(context.callbackClientId)}` : ''}`;
        const response = await this.request(callback);
        return { response, callback, authorization };
      }
    };
  }
  return { auth, browser, state, dir, config, codes, fetchImpl };
}

test('unconfigured hosted auth fails closed; origins, hosts, and CSRF are checked', async t => {
  const h = await harness(t, { config: { clientId: '' } });
  const browser = h.browser();
  const { response, data } = await browser.status();
  assert.equal(data.configured, false);
  assert.equal(data.mode, 'hosted');
  assert.equal(data.authenticated, false);
  assert.deepEqual(data.accounts, []);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await browser.start()).response.status, 503);
  assert.equal((await browser.request('/api/protected')).status, 401);
  assert.equal((await browser.request('/api/auth/session', { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await browser.request('/api/auth/session', { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await browser.request('/api/auth/login', { method: 'POST', headers: { 'x-csrf-token': 'é'.repeat(43) } })).status, 403);
  assert.equal((await browser.request('/api/auth/login', { method: 'POST', headers: { origin: '' } })).status, 403);
  assert.equal((await browser.request('/api/auth/login', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(h.state.exchanges.length, 0);
});

test('PKCE sign-in rotates the browser session and keeps credentials encrypted and private', async t => {
  const h = await harness(t);
  const alice = h.browser();
  await alice.status();
  const initialCookie = alice.cookie;
  const { response, callback, authorization } = await alice.login({ subject: 'alice' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${h.config.appOrigin}/?auth=success`);
  assert.equal(authorization.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(authorization.searchParams.has('ext_agent_host_id'), false);
  assert.notEqual(alice.cookie, initialCookie);
  const status = (await alice.status()).data;
  assert.equal(status.authenticated, true);
  assert.equal(status.inferenceEnabled, true);
  assert.equal(status.accounts.length, 1);
  assert.equal(JSON.stringify(status).includes('access-'), false);
  assert.equal(JSON.stringify(status).includes('refresh-'), false);
  assert.deepEqual(await (await alice.request('/api/token')).json(), { token: 'access-1' });
  const abandoned = h.browser(); abandoned.cookie = initialCookie;
  assert.equal((await abandoned.request('/api/protected')).status, 401);
  assert.match((await alice.request(callback)).headers.get('location'), /auth=error$/);
  for (const filename of await fs.readdir(h.config.authDir)) {
    const stat = await fs.stat(path.join(h.config.authDir, filename));
    assert.equal(stat.mode & 0o777, 0o600);
    if (filename.endsWith('.session')) {
      const bytes = await fs.readFile(path.join(h.config.authDir, filename), 'utf8');
      for (const secret of ['access-1', 'refresh-1', 'learner@example.test', 'alice']) assert.equal(bytes.includes(secret), false);
    }
  }
  assert.equal((await fs.stat(h.config.authDir)).mode & 0o777, 0o700);
});

test('state is browser-bound, expires, is consumed once, and errors never exchange codes', async t => {
  for (const variant of ['wrong-state', 'expired', 'other-browser', 'denied', 'wrong-client', 'duplicate-state']) {
    await t.test(variant, async t => {
      const h = await harness(t), browser = h.browser();
      const { authorization } = await browser.start();
      const state = authorization.searchParams.get('state');
      let callback = `/api/auth/callback?state=${variant === 'wrong-state' ? 'incorrect' : state}&code=code`;
      if (variant === 'expired') h.state.now += 10 * 60 * 1000 + 1;
      if (variant === 'denied') callback += '&error=access_denied';
      if (variant === 'wrong-client') callback += '&client_id=oaiapp_other';
      if (variant === 'duplicate-state') callback += `&state=${state}`;
      const returningBrowser = variant === 'other-browser' ? h.browser() : browser;
      assert.match((await returningBrowser.request(callback)).headers.get('location'), /auth=error$/);
      assert.equal(h.state.exchanges.length, 0);
      assert.equal((await browser.status()).data.authenticated, false);
    });
  }
});

test('ID token verification rejects malicious claims and signatures', async t => {
  const variants = {
    'bad signature': { badSignature: true },
    'wrong issuer': { claims: { iss: 'https://attacker.test' } },
    'wrong audience': { claims: { aud: 'oaiapp_other' } },
    'wrong nonce': { claims: { nonce: 'not-the-nonce' } },
    'missing subject': { claims: { sub: '' } },
    'missing expiration': { claims: { exp: undefined } },
    'expired token': { claims: { exp: 1 } },
    'future issuance': { claims: { iat: Math.floor(Date.now() / 1000) + 3600 } },
    'wrong authorized party': { claims: { azp: 'oaiapp_other' } },
    'multi-audience without authorized party': { claims: { aud: ['oaiapp_test', 'oaiapp_other'] } }
  };
  for (const [name, context] of Object.entries(variants)) {
    await t.test(name, async t => {
      const h = await harness(t), browser = h.browser();
      assert.match((await browser.login(context)).response.headers.get('location'), /auth=error$/);
      assert.equal((await browser.status()).data.authenticated, false);
      assert.equal((await browser.request('/api/token')).status, 401);
    });
  }
});

test('identity-only authorization is valid sign-in but never grants inference', async t => {
  const h = await harness(t), browser = h.browser();
  const { response, authorization } = await browser.login({ identityOnly: true }, { enableInference: false });
  assert.match(response.headers.get('location'), /auth=success$/);
  assert.equal(authorization.searchParams.get('scope'), 'openid profile email');
  assert.equal(authorization.searchParams.has('resource'), false);
  const { data } = await browser.status();
  assert.equal(data.authenticated, true);
  assert.equal(data.inferenceEnabled, false);
  assert.equal((await browser.request('/api/token')).status, 403);
  const recovery = await browser.start({ enableInference: true });
  assert.equal(recovery.authorization.searchParams.get('prompt'), 'consent');
  assert.match(recovery.authorization.searchParams.get('scope'), /chatgpt.tokens.use.direct/);
  const replaced = await browser.login({ subject: 'bob' }, { enableInference: true });
  assert.match(replaced.response.headers.get('location'), /auth=error$/);
  assert.equal((await browser.status()).data.inferenceEnabled, false);
});

test('accounts never enumerate across browsers and returning sign-in cannot replace a selected identity', async t => {
  const h = await harness(t), alice = h.browser(), bob = h.browser(), anonymous = h.browser();
  await alice.login({ subject: 'alice' });
  await bob.login({ subject: 'bob' });
  const aliceStatus = (await alice.status()).data;
  const bobStatus = (await bob.status()).data;
  assert.notEqual(aliceStatus.user.id, bobStatus.user.id);
  assert.equal(aliceStatus.accounts.length, 1);
  assert.equal(bobStatus.accounts.length, 1);
  assert.deepEqual((await anonymous.status()).data.accounts, []);
  assert.equal((await anonymous.start({ accountId: aliceStatus.user.id })).response.status, 400);
  assert.equal((await alice.start({ accountId: bobStatus.user.id })).response.status, 400);
  const changed = await alice.login({ subject: 'bob' }, { accountId: aliceStatus.user.id });
  assert.match(changed.response.headers.get('location'), /auth=error$/);
  assert.equal((await alice.status()).data.user.id, aliceStatus.user.id);
  assert.equal((await bob.status()).data.user.id, bobStatus.user.id);
});

test('replacing a signed-in account revokes its previous grant and preserves revocation warnings', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login({ subject: 'alice' });
  await browser.login({ subject: 'bob' });
  assert.deepEqual(h.state.revokedTokens, ['refresh-1']);
  assert.deepEqual(await (await browser.request('/api/token')).json(), { token: 'access-2' });
  h.state.revokeFailure = true;
  await browser.login({ subject: 'alice' });
  assert.deepEqual(h.state.revokedTokens, ['refresh-1', 'refresh-2', 'refresh-2']);
  h.state.revokeFailure = false;
  await browser.login({ subject: 'bob' });
  await browser.status();
  const logout = await browser.request('/api/auth/logout', { method: 'POST' });
  assert.deepEqual(await logout.json(), { ok: true, revocationConfirmed: false });
  assert.deepEqual(h.state.revokedTokens, ['refresh-1', 'refresh-2', 'refresh-2', 'refresh-3', 'refresh-4']);
});

test('reauthorization never revokes a refresh token reused by the new grant', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login();
  h.state.reuseRefreshToken = 'refresh-1';
  await browser.login();
  assert.deepEqual(h.state.revokedTokens, []);
  h.state.now += 3_550_000;
  assert.deepEqual(await (await browser.request('/api/token')).json(), { token: 'access-3' });
});

test('refresh serializes rotation, survives network failures, and clears terminally invalid grants', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login();
  h.state.now += 3_550_000;
  const replies = await Promise.all(Array.from({ length: 6 }, () => browser.request('/api/token')));
  assert.deepEqual(await Promise.all(replies.map(reply => reply.json())), Array(6).fill({ token: 'access-2' }));
  assert.equal(h.state.refreshes, 1);
  h.state.now += 3_550_000;
  h.state.refreshError = 'network';
  assert.equal((await browser.request('/api/token')).status, 503);
  assert.equal((await browser.status()).data.authenticated, true);
  h.state.refreshError = null;
  assert.deepEqual(await (await browser.request('/api/token')).json(), { token: 'access-3' });
  h.state.now += 3_550_000;
  h.state.refreshError = 'invalid_grant';
  assert.equal((await browser.request('/api/token')).status, 401);
  assert.equal((await browser.status()).data.authenticated, false);
  assert.equal((await browser.request('/api/token')).status, 401);
});

test('refresh recovery distinguishes every terminal provider code from configuration and service failures', async t => {
  const h = await harness(t);
  for (const code of ['invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
    const browser = h.browser();
    await browser.login();
    h.state.now += 3_550_000;
    h.state.refreshError = code;
    assert.equal((await browser.request('/api/token')).status, 401, code);
    assert.equal((await browser.status()).data.authenticated, false, code);
    h.state.refreshError = null;
  }
  const browser = h.browser();
  await browser.login();
  h.state.now += 3_550_000;
  h.state.refreshError = 'invalid_client';
  assert.equal((await (await browser.request('/api/token')).json()).code, 'auth_configuration');
  assert.equal((await browser.status()).data.authenticated, true);
  h.state.refreshError = 'invalid_grant';
  h.state.refreshErrorStatus = 503;
  assert.equal((await browser.request('/api/token')).status, 503);
  assert.equal((await browser.status()).data.authenticated, true);
});

test('rotated refresh credentials survive unavailable identity keys without bypassing verification', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login();
  await browser.request('/api/protected');
  const originalAuth = h.state.lastAuth;
  h.state.now += 3_550_000;
  h.state.keyFailure = true;
  assert.equal((await browser.request('/api/token')).status, 503);
  assert.equal(h.state.refreshes, 1);
  assert.equal((await browser.request('/api/token')).status, 503);
  assert.equal(h.state.refreshes, 1);
  assert.equal((await browser.status()).data.authenticated, true);
  // Quarantine is durable, so a restart cannot use the unverified access token.
  const restarted = await createAuth({ config: h.config, issuer, fetch: h.fetchImpl, now: () => h.state.now });
  await assert.rejects(restarted.getAccessToken(originalAuth), { status: 503 });
  h.state.keyFailure = false;
  assert.equal(await restarted.getAccessToken(originalAuth), 'access-2');
  h.state.now += 3_550_000;
  assert.equal(await restarted.getAccessToken(originalAuth), 'access-3');
  assert.equal(h.state.exchanges.at(-1).body.get('refresh_token'), 'refresh-2');
});

test('a mismatched refreshed identity clears the session immediately or after deferred verification', async t => {
  for (const deferVerification of [false, true]) {
    await t.test(deferVerification ? 'after key service recovery' : 'immediate verification', async t => {
      const h = await harness(t), browser = h.browser();
      await browser.login({ subject: 'alice' });
      await browser.request('/api/protected');
      const signal = h.state.lastAuth.signal;
      h.state.now += 3_550_000;
      h.state.refreshContext = { subject: 'bob' };
      if (deferVerification) {
        h.state.keyFailure = true;
        assert.equal((await browser.request('/api/token')).status, 503);
        h.state.keyFailure = false;
      }
      assert.equal((await browser.request('/api/token')).status, 401);
      assert.equal(signal.aborted, true);
      assert.equal((await browser.status()).data.authenticated, false);
      assert.equal((await browser.request('/api/token')).status, 401);
      assert.equal(h.state.refreshes, 1);
    });
  }
});

test('logout aborts in-flight work, revokes only this browser grant, and blocks queued refresh results', async t => {
  const h = await harness(t), alice = h.browser(), bob = h.browser();
  await alice.login({ subject: 'alice' });
  await bob.login({ subject: 'bob' });
  await alice.status();
  const protectedAuth = await (await alice.request('/api/protected')).json();
  h.state.now += 3_550_000;
  let finishRefresh;
  h.state.refreshWait = new Promise(resolve => { finishRefresh = resolve; });
  const pending = alice.request('/api/token');
  while (!h.state.refreshes) await new Promise(resolve => setTimeout(resolve, 5));
  const aborted = new Promise(resolve => h.state.lastAuth.signal.addEventListener('abort', resolve, { once: true }));
  const logout = alice.request('/api/auth/logout', { method: 'POST' });
  await aborted;
  finishRefresh();
  assert.equal((await pending).status, 401);
  assert.deepEqual(await (await logout).json(), { ok: true, revocationConfirmed: true });
  assert.equal(h.state.revokedToken, 'refresh-3');
  assert.equal((await alice.status()).data.authenticated, false);
  assert.equal((await bob.status()).data.authenticated, true);
  await assert.rejects(h.auth.getAccessToken(protectedAuth), { code: 'sign_in_required' });
});

test('logout reports unconfirmed remote revocation while still ending the local session', async t => {
  const h = await harness(t, { state: { revokeFailure: true } }), browser = h.browser();
  await browser.login(); await browser.status();
  const response = await browser.request('/api/auth/logout', { method: 'POST' });
  assert.deepEqual(await response.json(), { ok: true, revocationConfirmed: false });
  assert.equal(h.state.revocations, 2);
  assert.equal((await browser.request('/api/protected')).status, 401);
});

test('logout during a code exchange cannot resurrect a signed-in session', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login();
  await browser.request('/api/protected');
  let finishExchange;
  h.state.exchangeWait = new Promise(resolve => { finishExchange = resolve; });
  const signIn = browser.login();
  while (h.state.exchanges.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  const aborted = new Promise(resolve => h.state.lastAuth.signal.addEventListener('abort', resolve, { once: true }));
  const logout = browser.request('/api/auth/logout', { method: 'POST' });
  await aborted;
  finishExchange();
  assert.match((await signIn).response.headers.get('location'), /auth=error$/);
  assert.equal((await logout).status, 200);
  assert.equal((await browser.status()).data.authenticated, false);
  assert.equal(h.state.revocations, 2);
});

test('confidential clients use HTTP Basic; hosted cookies are secure', async t => {
  const h = await harness(t, { config: { appOrigin: 'https://language.example.test', tokenAuthMethod: 'client_secret_basic', clientSecret: 'secret:plus+' } });
  const browser = h.browser();
  const { response } = await browser.status();
  assert.match(response.headers.get('set-cookie'), /^__Host-language_session=.*; Secure$/);
  const login = await browser.login();
  assert.match(login.response.headers.get('location'), /auth=success$/);
  const exchange = h.state.exchanges[0];
  assert.equal(exchange.body.has('client_secret'), false);
  assert.equal(exchange.headers.authorization, `Basic ${Buffer.from('oaiapp_test:secret%3Aplus%2B').toString('base64')}`);
});

test('discovery cannot redirect credentials to another origin', async t => {
  const h = await harness(t, { state: { discovery: { token_endpoint: 'https://attacker.test/token' } } });
  const { response, data } = await h.browser().start();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'auth_configuration');
  assert.equal(h.state.exchanges.length, 0);
});

test('a restart resumes only a browser holding its encrypted session cookie', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login();
  const request = await (await browser.request('/api/protected')).json();
  const restarted = await createAuth({ config: h.config, issuer, now: () => h.state.now });
  assert.equal(await restarted.getAccessToken(request), 'access-1');
  assert.equal((await h.browser().status()).data.authenticated, false);
  const reconfigured = await createAuth({ config: { ...h.config, clientId: 'oaiapp_changed' }, issuer, now: () => h.state.now });
  await assert.rejects(reconfigured.getAccessToken(request), { code: 'sign_in_required' });
});

test('startup and periodic maintenance remove expired sessions and abandoned writes', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.status();
  const sessions = (await fs.readdir(h.config.authDir)).filter(name => name.endsWith('.session'));
  assert.equal(sessions.length, 1);
  const old = new Date(h.state.now - 9 * 60 * 60 * 1000);
  await fs.utimes(path.join(h.config.authDir, sessions[0]), old, old);
  const temporary = `${sessions[0]}.abandoned.tmp`;
  await fs.writeFile(path.join(h.config.authDir, temporary), 'incomplete', { mode: 0o600 });
  await fs.utimes(path.join(h.config.authDir, temporary), old, old);
  await createAuth({ config: h.config, issuer, now: () => h.state.now });
  assert.deepEqual(await fs.readdir(h.config.authDir), ['encryption.key']);
  await browser.status();
  const recent = (await fs.readdir(h.config.authDir)).find(name => name.endsWith('.session'));
  await fs.utimes(path.join(h.config.authDir, recent), old, old);
  h.state.now += 5 * 60 * 1000;
  await browser.status();
  assert.equal((await fs.readdir(h.config.authDir)).includes(recent), false);
});

test('corrupt session files are removed and replaced with an anonymous session', async t => {
  const h = await harness(t);
  for (const corrupt of [
    () => '{truncated',
    () => 'null',
    () => JSON.stringify({ iv: 'invalid', tag: 'invalid', data: 'invalid' }),
    contents => { const envelope = JSON.parse(contents); const tag = Buffer.from(envelope.tag, 'base64url'); tag[0] ^= 1; envelope.tag = tag.toString('base64url'); return JSON.stringify(envelope); }
  ]) {
    const browser = h.browser();
    await browser.login();
    const oldCookie = browser.cookie;
    const id = oldCookie.split('=')[1];
    const filename = path.join(h.config.authDir, `${createHash('sha256').update(id).digest('hex')}.session`);
    const contents = await fs.readFile(filename, 'utf8');
    await fs.writeFile(filename, corrupt(contents));
    const { response, data } = await browser.status();
    assert.equal(response.status, 200);
    assert.equal(data.authenticated, false);
    assert.notEqual(browser.cookie, oldCookie);
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
    assert.equal((await browser.request('/api/token')).status, 401);
  }
});

test('filesystem read failures are propagated without deleting session paths', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login();
  const id = browser.cookie.split('=')[1];
  const filename = path.join(h.config.authDir, `${createHash('sha256').update(id).digest('hex')}.session`);
  await fs.rm(filename);
  await fs.mkdir(filename);
  const response = await browser.request('/api/auth/session');
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'EISDIR');
  assert.equal((await fs.stat(filename)).isDirectory(), true);
});

test('private credentials cannot be placed under a public cache directory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'language-auth-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(createAuth({ config: { authDir: path.join(directory, 'credentials'), cacheDir: directory } }), /outside CACHE_DIR/);
});

test('local dynamic registration requires an issued client ID and validates its token audience', async t => {
  for (const context of [
    { omitIssuedClientId: true },
    { issuedClientId: 'dynamic_agent_client' },
    { issuedClientId: 'oaiapp_local_test', claims: { aud: 'dynamic_agent_client' } },
    { issuedClientId: 'oaiapp_local_test', claims: { nonce: 'wrong' } }
  ]) {
    await t.test(JSON.stringify(context), async t => {
      const h = await harness(t, { config: { mode: 'local', clientSecret: 'must-never-be-sent', tokenAuthMethod: 'client_secret_basic' } });
      const browser = h.browser();
      const { response, authorization } = await browser.login(context);
      assert.match(response.headers.get('location'), /auth=error$/);
      assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(authorization.searchParams.get('agent_name_hint'), 'Language AI App');
      assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
      assert.equal((await browser.status()).data.authenticated, false);
      if (context.omitIssuedClientId || context.issuedClientId === 'dynamic_agent_client') assert.equal(h.state.exchanges.length, 0);
    });
  }
});

test('an incomplete local registration is retained for explicit retry without exposing an authenticated profile', async t => {
  const h = await harness(t, { config: { mode: 'local' }, state: { codeError: 'invalid_grant' } });
  const browser = h.browser();
  const attempted = await browser.login({ issuedClientId: 'oaiapp_recover_registration' });
  assert.match(attempted.response.headers.get('location'), /auth=error$/);
  const pending = (await browser.status()).data;
  assert.equal(pending.authenticated, false);
  assert.equal(pending.accounts.length, 1);
  assert.equal(pending.accounts[0].pending, true);
  assert.equal(pending.accounts[0].connected, false);
  assert.equal((await browser.request('/api/token')).status, 401);
  const selected = await browser.start({ accountId: pending.accounts[0].id });
  assert.equal(selected.authorization.searchParams.get('client_id'), 'oaiapp_recover_registration');
  assert.equal(selected.authorization.searchParams.has('agent_name_hint'), false);
  assert.equal(selected.authorization.searchParams.has('id_token_hint'), false);
  assert.equal(selected.authorization.searchParams.get('ext_agent_host_id'), attempted.authorization.searchParams.get('ext_agent_host_id'));
  h.state.codeError = null;
  const retried = await browser.login({}, { accountId: pending.accounts[0].id });
  assert.match(retried.response.headers.get('location'), /auth=success$/);
  const connected = (await browser.status()).data;
  assert.equal(connected.accounts.length, 1);
  assert.equal(connected.accounts[0].pending, false);
  assert.equal(connected.accounts[0].id, connected.user.id);
  assert.match(connected.accounts[0].label, /account 1$/);
});

test('local saved registration checks returning client and subject without disturbing the active account', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.login({ issuedClientId: 'oaiapp_saved', subject: 'alice' });
  const account = (await browser.status()).data.user.id;
  const exchanges = h.state.exchanges.length;
  const swappedClient = await browser.login({ callbackClientId: 'oaiapp_wrong' }, { accountId: account });
  assert.match(swappedClient.response.headers.get('location'), /auth=error$/);
  assert.equal(h.state.exchanges.length, exchanges);
  const swappedSubject = await browser.login({ subject: 'bob' }, { accountId: account });
  assert.match(swappedSubject.response.headers.get('location'), /auth=error$/);
  assert.equal((await browser.status()).data.user.id, account);
  assert.deepEqual(await (await browser.request('/api/token')).json(), { token: 'access-1' });
  const newRegistration = await browser.start();
  assert.equal(newRegistration.authorization.searchParams.get('client_id'), 'dynamic_agent_client');
});

test('local credentials outlive a browser session, stay encrypted, and require OAuth to reactivate', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  const signIn = await browser.login({ issuedClientId: 'oaiapp_persistent' });
  const initial = (await browser.status()).data;
  const cookie = browser.cookie;
  assert.match(cookie, /^language_local_[a-f0-9]{16}=/);
  const vault = await fs.readFile(path.join(h.config.authDir, 'local-profiles.vault'), 'utf8');
  for (const secret of ['access-1', 'refresh-1', 'oaiapp_persistent', 'learner@example.test']) assert.equal(vault.includes(secret), false);
  assert.equal((await fs.stat(path.join(h.config.authDir, 'local-profiles.vault'))).mode & 0o777, 0o600);
  h.state.now += 8 * 60 * 60 * 1000 + 1;
  const expired = (await browser.status()).data;
  assert.equal(expired.authenticated, false);
  assert.equal(expired.accounts[0].id, initial.user.id);
  assert.equal(expired.accounts[0].connected, true);
  assert.equal((await browser.request('/api/token')).status, 401);
  const returning = await browser.start({ accountId: initial.user.id });
  assert.equal(returning.authorization.searchParams.get('ext_agent_host_id'), signIn.authorization.searchParams.get('ext_agent_host_id'));
  assert.equal(returning.authorization.searchParams.get('client_id'), 'oaiapp_persistent');
  assert.ok(returning.authorization.searchParams.get('id_token_hint'));
});

test('local identity-only consent selects the saved registration while Add another remains a new registration', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.login({ issuedClientId: 'oaiapp_identity', identityOnly: true });
  const account = (await browser.status()).data.user.id;
  assert.equal((await browser.request('/api/token')).status, 403);
  const consent = await browser.start({ enableInference: true, accountId: account });
  assert.equal(consent.authorization.searchParams.get('client_id'), 'oaiapp_identity');
  assert.equal(consent.authorization.searchParams.get('prompt'), 'consent');
  const addAnother = await browser.start({ enableInference: true });
  assert.equal(addAnother.authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(addAnother.authorization.searchParams.has('prompt'), false);
});

test('local refresh is serialized per registration and shutdown drains rotation before another process can resume', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.login({ issuedClientId: 'oaiapp_refresh' });
  await browser.request('/api/protected');
  const originalAuth = h.state.lastAuth;
  h.state.now += 3_550_000;
  const requests = await Promise.all(Array.from({ length: 6 }, () => browser.request('/api/token')));
  assert.deepEqual(await Promise.all(requests.map(response => response.json())), Array(6).fill({ token: 'access-2' }));
  assert.equal(h.state.refreshes, 1);
  h.state.now += 3_550_000;
  let finishRefresh;
  h.state.refreshWait = new Promise(resolve => { finishRefresh = resolve; });
  const refreshing = browser.request('/api/token');
  while (h.state.refreshes < 2) await new Promise(resolve => setTimeout(resolve, 5));
  let closed = false;
  const closing = h.auth.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(originalAuth.signal.aborted, true);
  finishRefresh();
  assert.equal((await refreshing).status, 401);
  await closing;
  assert.equal((await browser.request('/api/auth/session')).status, 503);
  const resumed = await createAuth({ config: h.config, issuer, fetch: h.fetchImpl, now: () => h.state.now });
  assert.equal(await resumed.getAccessToken({ ...originalAuth, signal: undefined }), 'access-3');
  await resumed.close();
});

test('local auth rejects non-literal loopback origins and corrupt profile state never silently resets the host identity', async t => {
  for (const appOrigin of ['http://localhost:3000', 'https://127.0.0.1:3000', 'http://0.0.0.0:3000', 'http://127.0.0.1']) await assert.rejects(createAuth({ config: { mode: 'local', appOrigin } }), /127\.0\.0\.1/);
  const h = await harness(t, { config: { mode: 'local' } });
  await h.browser().login({ issuedClientId: 'oaiapp_corrupt_store' });
  await h.auth.close();
  await fs.writeFile(path.join(h.config.authDir, 'local-profiles.vault'), '{truncated');
  await assert.rejects(createAuth({ config: h.config, issuer, fetch: h.fetchImpl }), /profiles could not be read/);
  assert.equal(await fs.readFile(path.join(h.config.authDir, 'local-profiles.vault'), 'utf8'), '{truncated');
});

test('logout during a local profile commit clears the owned grant and retains an unconfirmed-revocation warning', { timeout: 10_000 }, async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.login({ issuedClientId: 'oaiapp_commit_race' });
  const accountId = (await browser.status()).data.user.id;
  await browser.request('/api/protected');
  const signal = h.state.lastAuth.signal;
  const originalRename = fs.rename;
  const vaultPath = path.join(await fs.realpath(h.config.authDir), 'local-profiles.vault');
  let releaseCommit, commitStarted;
  const commitGate = new Promise(resolve => { releaseCommit = resolve; });
  const staged = new Promise(resolve => { commitStarted = resolve; });
  let blockNextVaultWrite = true;
  fs.rename = async (source, target) => {
    if (blockNextVaultWrite && target === vaultPath) {
      blockNextVaultWrite = false;
      commitStarted();
      await commitGate;
    }
    return originalRename(source, target);
  };
  t.after(() => { fs.rename = originalRename; releaseCommit(); });
  h.state.revokeFailure = true;
  const signIn = browser.login({}, { accountId });
  await staged;
  const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  const logout = browser.request('/api/auth/logout', { method: 'POST' });
  await aborted;
  releaseCommit();
  assert.match((await signIn).response.headers.get('location'), /auth=error$/);
  assert.deepEqual(await (await logout).json(), { ok: true, revocationConfirmed: false });
  const status = (await browser.status()).data;
  assert.equal(status.authenticated, false);
  assert.equal(status.accounts.length, 1);
  assert.equal(status.accounts[0].connected, false);
  await h.auth.close();
  const saved = (await createLocalProfileStore(h.config.authDir)).get(accountId);
  assert.equal(saved.credentials, null);
  assert.equal(saved.idToken, null);
  assert.equal(saved.revocationUnconfirmed, true);
});

test('failed local callback publication revokes its grant and removes every provisional session', async t => {
  for (const failurePoint of ['profile rename', 'profile temporary cleanup', 'session rename', 'session temporary cleanup', 'old session removal']) {
    await t.test(failurePoint, async t => {
      const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
      await browser.status();
      const originalCookie = browser.cookie;
      const directory = await fs.realpath(h.config.authDir);
      const oldSessionPath = path.join(directory, `${createHash('sha256').update(originalCookie.split('=')[1]).digest('hex')}.session`);
      const vaultPath = path.join(directory, 'local-profiles.vault');
      const originalRename = fs.rename, originalRemove = fs.rm;
      let injected = false;
      const fail = () => { injected = true; throw Object.assign(new Error('Injected storage failure'), { code: 'EIO' }); };
      fs.rename = async (source, target) => {
        if (!injected && h.state.sequence && ((failurePoint === 'profile rename' && target === vaultPath) || (failurePoint === 'session rename' && target.endsWith('.session') && target !== oldSessionPath))) fail();
        return originalRename(source, target);
      };
      fs.rm = async (target, options) => {
        if (!injected && h.state.sequence && ((failurePoint === 'profile temporary cleanup' && target.startsWith(`${vaultPath}.`)) || (failurePoint === 'session temporary cleanup' && target.includes('.session.') && !target.startsWith(`${oldSessionPath}.`)) || (failurePoint === 'old session removal' && target === oldSessionPath))) fail();
        return originalRemove(target, options);
      };
      t.after(() => { fs.rename = originalRename; fs.rm = originalRemove; });
      const { response } = await browser.login({ issuedClientId: 'oaiapp_failed_publication' });
      assert.equal(injected, true);
      assert.match(response.headers.get('location'), /auth=error$/);
      assert.equal(browser.cookie, originalCookie);
      assert.deepEqual(h.state.revokedTokens, ['refresh-1']);
      assert.equal((await browser.request('/api/token')).status, 401);
      const status = (await browser.status()).data;
      assert.equal(status.authenticated, false);
      assert.equal(status.accounts.length, 1);
      assert.equal(status.accounts[0].connected, false);
      assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.session')), [path.basename(oldSessionPath)]);
      // A pre-commit failure remains the profile store's last failed write;
      // shutdown reports it after draining, without inventing a successful write.
      if (failurePoint === 'profile rename') await assert.rejects(h.auth.close(), { code: 'EIO' });
      else await h.auth.close();
      const profile = (await createLocalProfileStore(h.config.authDir)).get(status.accounts[0].id);
      assert.equal(profile.clientId, 'oaiapp_failed_publication');
      assert.equal(profile.credentials, null);
      assert.equal(profile.idToken, null);
    });
  }
});

test('failed local publication preserves another active account and records unsuccessful revocation', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.login({ issuedClientId: 'oaiapp_preserved', subject: 'alice' });
  const original = (await browser.status()).data;
  const originalCookie = browser.cookie;
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (source, target) => {
    if (!injected && h.state.sequence === 2 && target.endsWith('.session')) {
      injected = true;
      throw Object.assign(new Error('Injected session publication failure'), { code: 'EIO' });
    }
    return originalRename(source, target);
  };
  t.after(() => { fs.rename = originalRename; });
  h.state.revokeFailure = true;
  const { response } = await browser.login({ issuedClientId: 'oaiapp_failed_other', subject: 'bob' });
  assert.match(response.headers.get('location'), /auth=error$/);
  assert.equal(injected, true);
  assert.equal(browser.cookie, originalCookie);
  assert.deepEqual(h.state.revokedTokens, ['refresh-2', 'refresh-2']);
  const status = (await browser.status()).data;
  assert.equal(status.user.id, original.user.id);
  assert.equal(status.accounts.find(account => account.id === original.user.id).connected, true);
  const failed = status.accounts.find(account => account.id !== original.user.id);
  assert.equal(failed.connected, false);
  assert.deepEqual(await (await browser.request('/api/token')).json(), { token: 'access-1' });
  h.state.revokeFailure = false;
  assert.deepEqual(await (await browser.request('/api/auth/logout', { method: 'POST' })).json(), { ok: true, revocationConfirmed: false });
  await h.auth.close();
  const profile = (await createLocalProfileStore(h.config.authDir)).get(failed.id);
  assert.equal(profile.credentials, null);
  assert.equal(profile.idToken, null);
  assert.equal(profile.revocationUnconfirmed, true);
});

test('a cleanup write failure does not prevent revocation or removal of a committed provisional session', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.status();
  const directory = await fs.realpath(h.config.authDir);
  const oldSessionPath = path.join(directory, `${createHash('sha256').update(browser.cookie.split('=')[1]).digest('hex')}.session`);
  const vaultPath = path.join(directory, 'local-profiles.vault');
  const originalRename = fs.rename, originalRemove = fs.rm;
  let publicationFailed = false, cleanupFailed = false;
  fs.rm = async (target, options) => {
    if (!publicationFailed && h.state.sequence && target.includes('.session.') && !target.startsWith(`${oldSessionPath}.`)) {
      publicationFailed = true;
      throw Object.assign(new Error('Injected post-commit publication failure'), { code: 'EIO' });
    }
    return originalRemove(target, options);
  };
  fs.rename = async (source, target) => {
    if (publicationFailed && !cleanupFailed && target === vaultPath) {
      cleanupFailed = true;
      throw Object.assign(new Error('Injected cleanup write failure'), { code: 'EIO' });
    }
    return originalRename(source, target);
  };
  t.after(() => { fs.rename = originalRename; fs.rm = originalRemove; });
  const { response } = await browser.login({ issuedClientId: 'oaiapp_cleanup_disk_failure' });
  assert.match(response.headers.get('location'), /auth=error$/);
  assert.equal(publicationFailed, true);
  assert.equal(cleanupFailed, true);
  assert.deepEqual(h.state.revokedTokens, ['refresh-1']);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.session')), [path.basename(oldSessionPath)]);
  assert.equal((await browser.request('/api/token')).status, 401);
  assert.equal((await browser.status()).data.authenticated, false);
  // The simulated failed cleanup leaves an encrypted copy, but revocation still
  // invalidates it at the provider. Neither action depends on the other succeeding.
  const revoked = await h.fetchImpl(`${issuer}/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1_000), headers: {}, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'oaiapp_cleanup_disk_failure', refresh_token: 'refresh-1', resource: 'https://api.openai.com/v1' }).toString() });
  assert.equal(revoked.status, 400);
  assert.equal((await revoked.json()).error, 'invalid_grant');
});

test('failed identity validation revokes only a newly issued grant, preserving any reused current grant', async t => {
  for (const mode of ['hosted', 'local']) {
    for (const reuse of [false, true]) await t.test(`${mode}, reused grant: ${reuse}`, async t => {
      const h = await harness(t, { config: { mode } }), browser = h.browser();
      await browser.login({ issuedClientId: 'oaiapp_preserved_identity', subject: 'alice' });
      const accountId = (await browser.status()).data.user.id;
      if (reuse) h.state.reuseRefreshToken = 'refresh-1';
      const { response } = await browser.login({ claims: { nonce: 'invalid-nonce' } }, { accountId });
      assert.match(response.headers.get('location'), /auth=error$/);
      assert.deepEqual(h.state.revokedTokens, reuse ? [] : ['refresh-2']);
      assert.equal((await browser.status()).data.user.id, accountId);
      assert.deepEqual(await (await browser.request('/api/token')).json(), { token: 'access-1' });
    });
  }
});

test('failed local replacement never restores a previous grant already revoked before the profile write', async t => {
  const h = await harness(t, { config: { mode: 'local' } }), browser = h.browser();
  await browser.login({ issuedClientId: 'oaiapp_retired_grant' });
  const accountId = (await browser.status()).data.user.id;
  const vaultPath = path.join(await fs.realpath(h.config.authDir), 'local-profiles.vault');
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (source, target) => {
    if (!injected && h.state.sequence === 2 && target === vaultPath) {
      injected = true;
      throw Object.assign(new Error('Injected replacement failure'), { code: 'EIO' });
    }
    return originalRename(source, target);
  };
  t.after(() => { fs.rename = originalRename; });
  const { response } = await browser.login({}, { accountId });
  assert.match(response.headers.get('location'), /auth=error$/);
  assert.deepEqual(h.state.revokedTokens, ['refresh-1', 'refresh-2']);
  const status = (await browser.status()).data;
  assert.equal(status.authenticated, false);
  assert.equal(status.accounts[0].id, accountId);
  assert.equal(status.accounts[0].connected, false);
  await h.auth.close();
  const profile = (await createLocalProfileStore(h.config.authDir)).get(accountId);
  assert.equal(profile.credentials, null);
  assert.equal(profile.idToken, null);
});

test('logout during final callback session removal cancels publication and cleans up the new grant', { timeout: 10_000 }, async t => {
  for (const mode of ['hosted', 'local']) {
    for (const revokeFailure of [false, true]) await t.test(`${mode}, revocation unavailable: ${revokeFailure}`, async t => {
      const h = await harness(t, { config: { mode }, state: { revokeFailure } }), browser = h.browser();
      await browser.status();
      const oldCookie = browser.cookie;
      const logoutBrowser = h.browser();
      logoutBrowser.cookie = oldCookie; logoutBrowser.csrf = browser.csrf;
      const directory = await fs.realpath(h.config.authDir);
      const oldSessionPath = path.join(directory, `${createHash('sha256').update(oldCookie.split('=')[1]).digest('hex')}.session`);
      const originalRemove = fs.rm, originalRead = fs.readFile;
      let releaseRemoval, removalStarted, logoutChecked;
      const removalGate = new Promise(resolve => { releaseRemoval = resolve; });
      const removing = new Promise(resolve => { removalStarted = resolve; });
      const logoutReady = new Promise(resolve => { logoutChecked = resolve; });
      let blocked = false;
      fs.rm = async (target, options) => {
        if (!blocked && target === oldSessionPath) {
          blocked = true;
          removalStarted();
          await removalGate;
        }
        return originalRemove(target, options);
      };
      fs.readFile = async (target, ...args) => {
        const result = await originalRead(target, ...args);
        // Once the paused removal starts, only the logout's CSRF check reads
        // this anonymous session. Let its middleware finish before releasing I/O.
        if (blocked && target === oldSessionPath) setImmediate(logoutChecked);
        return result;
      };
      t.after(() => { fs.rm = originalRemove; fs.readFile = originalRead; releaseRemoval(); });
      const signIn = browser.login({ issuedClientId: 'oaiapp_final_publication' });
      await removing;
      const logout = logoutBrowser.request('/api/auth/logout', { method: 'POST' });
      await logoutReady;
      releaseRemoval();
      const signInResult = await signIn;
      const logoutResult = await logout;
      assert.match(signInResult.response.headers.get('location'), /auth=error$/);
      assert.equal(browser.cookie, oldCookie);
      assert.deepEqual(await logoutResult.json(), { ok: true, revocationConfirmed: !revokeFailure });
      assert.deepEqual(h.state.revokedTokens, Array(revokeFailure ? 2 : 1).fill('refresh-1'));
      const status = (await logoutBrowser.status()).data;
      assert.equal(status.authenticated, false);
      assert.equal((await browser.request('/api/token')).status, 401);
      assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.session')).length, 1);
      if (mode === 'local') {
        assert.equal(status.accounts[0].connected, false);
        await h.auth.close();
        const profile = (await createLocalProfileStore(h.config.authDir)).get(status.accounts[0].id);
        assert.equal(profile.credentials, null);
        assert.equal(profile.idToken, null);
        assert.equal(profile.revocationUnconfirmed, revokeFailure);
      }
    });
  }
});

test('failed hosted publication aborts work authorized by the retired previous grant', async t => {
  const h = await harness(t), browser = h.browser();
  await browser.login({ subject: 'alice' });
  await browser.status();
  await browser.request('/api/protected');
  const previousSignal = h.state.lastAuth.signal;
  const oldSessionPath = path.join(await fs.realpath(h.config.authDir), `${createHash('sha256').update(browser.cookie.split('=')[1]).digest('hex')}.session`);
  const originalRemove = fs.rm;
  let injected = false;
  fs.rm = async (target, options) => {
    if (!injected && target === oldSessionPath) {
      injected = true;
      throw Object.assign(new Error('Injected final session removal failure'), { code: 'EIO' });
    }
    return originalRemove(target, options);
  };
  t.after(() => { fs.rm = originalRemove; });
  const { response } = await browser.login({ subject: 'bob' });
  assert.match(response.headers.get('location'), /auth=error$/);
  assert.equal(injected, true);
  assert.equal(previousSignal.aborted, true);
  assert.deepEqual(h.state.revokedTokens, ['refresh-1', 'refresh-2']);
  assert.equal((await browser.status()).data.authenticated, false);
  assert.equal((await browser.request('/api/token')).status, 401);
});
