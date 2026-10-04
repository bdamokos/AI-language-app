import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLocalRuntime } from '../server/local-runtime.js';
import { startOpenAIFixture } from '../test-support/openai-fixture.js';

function browser(initialOrigin) {
  let origin = initialOrigin, csrf;
  const cookies = new Map();
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(new URL(route, origin), { method, redirect: 'manual', headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...(method !== 'GET' ? { origin, 'x-csrf-token': csrf || '', 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0], offset = pair.indexOf('=');
      cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
    }
    return response;
  };
  const session = async () => {
    const response = await request('/api/auth/session');
    assert.equal(response.status, 200);
    const value = await response.json();
    csrf = value.csrfToken;
    assert.doesNotMatch(JSON.stringify(value), /fixture-access|fixture-refresh|id_token|refresh_token|access_token/);
    return value;
  };
  const beginLogin = async (accountId) => {
    await session();
    const response = await request('/api/auth/login', { method: 'POST', body: { enableInference: true, ...(accountId ? { accountId } : {}) } });
    assert.equal(response.status, 200);
    return new URL((await response.json()).url);
  };
  const approve = async (authorization, user) => {
    const approval = new URL(authorization);
    approval.pathname = '/approve';
    if (user) approval.searchParams.set('test_user', user);
    const grant = await fetch(approval, { redirect: 'manual' });
    assert.equal(grant.status, 302);
    const callbackUrl = new URL(grant.headers.get('location'));
    const callback = await request(callbackUrl);
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.headers.get('location')).searchParams.get('auth'), 'success');
    return { session: await session(), callbackUrl };
  };
  return { request, session, beginLogin, approve, setOrigin(value) { origin = value; }, async login(user, accountId) { return (await approve(await beginLogin(accountId), user)).session; } };
}

async function fixture(t, providerOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'language-local-e2e-'));
  const dataDir = path.join(directory, 'data'), distDir = path.join(directory, 'dist');
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Local language app fixture</title>');
  await fs.writeFile(path.join(distDir, 'asset.js'), '/* local fixture */');
  const provider = await startOpenAIFixture(providerOptions);
  const options = { port: 0, dataDir, distDir, issuer: provider.origin, baseUrl: `${provider.origin}/v1` };
  let runtime;
  t.after(async () => { await runtime?.close(); await provider.close(); await fs.rm(directory, { recursive: true, force: true }); });
  runtime = await startLocalRuntime(options);
  return {
    provider, options, dataDir,
    get runtime() { return runtime; },
    async restart() { const port = runtime.server.address().port; await runtime.close(); runtime = await startLocalRuntime({ ...options, port }); return runtime; },
  };
}

const lesson = { topic: 'Ser y estar', language: 'es', level: 'B1' };
const explanation = async client => {
  const response = await client.request('/api/explanations/stream', { method: 'POST', body: lesson });
  assert.equal(response.status, 200);
  const value = await response.text();
  assert.match(value, /"type":"final"/);
  return value;
};

test('local registration, inference, restart, saved reauthorization and logout preserve distinct account registrations', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { sameEmail: true });
  const client = browser(f.runtime.origin);
  const initial = await client.session();
  assert.equal(initial.mode, 'local');
  assert.equal(initial.configured, true);
  assert.equal(initial.authenticated, false);
  assert.deepEqual(initial.accounts, []);

  const firstAuthorization = await client.beginLogin();
  assert.equal(firstAuthorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.ok(firstAuthorization.searchParams.get('agent_name_hint'));
  const hostId = firstAuthorization.searchParams.get('ext_agent_host_id');
  assert.match(hostId, /^(urn:uuid:|urn:ietf:params:oauth:jwk-thumbprint:|did:key:)/);
  const grantedA = await client.approve(firstAuthorization, 'alice');
  const alice = grantedA.session, accountA = alice.user.id;
  const clientA = grantedA.callbackUrl.searchParams.get('client_id');
  assert.match(clientA, /^oaiapp_/);
  assert.equal(alice.inferenceEnabled, true);
  assert.match(await explanation(client), /Alice/);
  assert.equal(f.provider.stats.requests.at(-1).clientId, clientA);

  const secondAuthorization = await client.beginLogin();
  assert.equal((await client.session()).user.id, accountA, 'pending registration must not replace the active account');
  const grantedB = await client.approve(secondAuthorization, 'bob');
  const bob = grantedB.session, accountB = bob.user.id;
  const clientB = grantedB.callbackUrl.searchParams.get('client_id');
  assert.notEqual(clientA, clientB);
  assert.notEqual(accountA, accountB);
  assert.equal(alice.user.email, bob.user.email);
  assert.equal(bob.accounts.length, 2);
  assert.equal(new Set(bob.accounts.map(account => account.label)).size, 2);
  assert.equal(bob.accounts.every(account => account.connected), true);
  const bobLesson = await explanation(client);
  assert.match(bobLesson, /Bob/);
  assert.doesNotMatch(bobLesson, /Alice/);
  assert.equal(f.provider.stats.requests.at(-1).clientId, clientB);
  assert.equal(f.provider.stats.requests.length, 2, 'the same lesson must not reuse another registration cache');

  await f.restart();
  client.setOrigin(f.runtime.origin);
  const restored = await client.session();
  assert.equal(restored.accounts.length, 2);
  assert.equal(restored.user.id, accountB);
  assert.equal((await client.request('/api/models')).status, 200);
  assert.equal(f.provider.stats.tokenExchanges, 2, 'restart must reuse the saved connection');

  const returning = await client.beginLogin(accountA);
  assert.equal(returning.searchParams.get('client_id'), clientA);
  assert.equal(returning.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
  assert.ok(returning.searchParams.get('id_token_hint'));
  assert.equal(returning.searchParams.get('login_hint'), alice.user.email);
  for (const field of ['state', 'nonce', 'code_challenge']) assert.notEqual(returning.searchParams.get(field), firstAuthorization.searchParams.get(field), field);
  const reauthorized = await client.approve(returning, 'alice');
  assert.equal(reauthorized.callbackUrl.searchParams.has('client_id'), false);
  assert.equal(reauthorized.session.user.id, accountA);
  assert.equal(f.provider.stats.authorizations.at(-1).hintSubject, 'alice');
  assert.equal(f.provider.stats.authorizations.at(-1).hintAudience, clientA);
  assert.match(await explanation(client), /"type":"prefill"/);
  assert.equal(f.provider.stats.requests.length, 2);

  const logout = await client.request('/api/auth/logout', { method: 'POST' });
  assert.deepEqual(await logout.json(), { ok: true, revocationConfirmed: true });
  assert.equal(f.provider.stats.revocationRequests.at(-1).clientId, clientA);
  const signedOut = await client.session();
  assert.equal(signedOut.authenticated, false);
  assert.equal(signedOut.accounts.find(account => account.id === accountA).connected, false);
  assert.equal(signedOut.accounts.find(account => account.id === accountB).connected, true);
  const afterLogout = await client.beginLogin(accountA);
  assert.equal(afterLogout.searchParams.get('client_id'), clientA);
  assert.equal(afterLogout.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(afterLogout.searchParams.has('id_token_hint'), false);
  assert.equal((await client.approve(afterLogout, 'alice')).session.user.id, accountA);
  assert.equal(f.provider.stats.registrations.length, 2);

  assert.equal(f.provider.stats.authorizations.every(attempt => attempt.hostId === hostId), true);
  assert.equal(f.provider.stats.tokenRequests.every(request => [clientA, clientB].includes(request.clientId) && !request.hasClientSecret && !request.hasAuthorizationHeader), true);
  assert.equal((await fs.readdir(path.join(f.dataDir, 'cache', 'accounts'))).length, 2);
});

test('two registrations for the same identity keep separate model choice and cached lessons', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const client = browser(f.runtime.origin);
  const first = await client.login('alice');
  assert.match(await explanation(client), /Alice/);
  assert.equal((await client.request('/api/settings', { method: 'POST', body: { model: 'fixture-alternative' } })).status, 200);
  const second = await client.login('alice');
  assert.equal(first.user.email, second.user.email);
  assert.notEqual(first.user.id, second.user.id);
  assert.equal((await (await client.request('/api/models')).json()).selectedModel, 'fixture-model');
  assert.match(await explanation(client), /Alice/);
  assert.equal(f.provider.stats.requests.length, 2);
  assert.notEqual(f.provider.stats.requests[0].clientId, f.provider.stats.requests[1].clientId);
  assert.equal(second.accounts.length, 2);
});

test('local token refresh after restart uses the registration issued ID without a client secret', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { tokenLifetimeSeconds: 30 });
  const client = browser(f.runtime.origin);
  await client.login('alice');
  const clientId = f.provider.stats.registrations[0].clientId;
  assert.equal((await client.request('/api/models')).status, 200);
  assert.ok(f.provider.stats.refreshes > 0);
  const beforeRestart = f.provider.stats.refreshes;
  await f.restart();
  client.setOrigin(f.runtime.origin);
  assert.equal((await client.session()).authenticated, true);
  assert.equal((await client.request('/api/models')).status, 200);
  assert.ok(f.provider.stats.refreshes > beforeRestart);
  assert.equal(f.provider.stats.tokenExchanges, 1);
  const refreshes = f.provider.stats.tokenRequests.filter(request => request.grantType === 'refresh_token');
  assert.equal(refreshes.every(request => request.clientId === clientId && request.resource === 'https://api.openai.com/v1' && !request.hasClientSecret && !request.hasAuthorizationHeader && !request.hasScope), true);
});

function rawRequest(origin, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, origin), { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('local runtime binds only loopback and protects every path from hostile Host, Origin and forwarding headers', async t => {
  const f = await fixture(t);
  assert.equal(f.runtime.server.address().address, '127.0.0.1');
  const origin = new URL(f.runtime.origin);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  for (const route of ['/', '/asset.js', '/healthz', '/api/auth/session', '/api/auth/callback?state=invalid']) {
    for (const headers of [
      { host: 'attacker.example' },
      { host: `localhost:${origin.port}` },
      { origin: 'https://attacker.example' },
      { forwarded: 'for=127.0.0.1;host=127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-host': origin.host },
      { 'x-forwarded-proto': 'http' },
    ]) assert.equal((await rawRequest(origin, route, headers)).status, 403, `${route}: ${Object.keys(headers)[0]}`);
  }
  assert.equal((await rawRequest(origin, '/')).status, 200);
  assert.equal((await rawRequest(origin, '/healthz')).status, 200);
  await assert.rejects(startLocalRuntime(f.options), /already|running|lock/i);
  assert.equal((await rawRequest(origin, '/healthz')).status, 200, 'refusing a second process must preserve the active runtime');
});
