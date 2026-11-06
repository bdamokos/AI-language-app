// Imported only by the hosted subprocess regression test, never in production.
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const issuer = 'https://auth.openai.com';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'hosted-shutdown', alg: 'RS256' };
let nonce, releaseRotation;
let currentRefresh = process.env.HOSTED_FIXTURE_RESTART ? 'fixture-refresh-2' : 'fixture-refresh-1';
process.on('message', message => {
  if (message.type === 'nonce') nonce = message.value;
  if (message.type === 'release') releaseRotation?.();
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function tokens(number) {
  const idToken = await new SignJWT({ nonce, email: 'alice@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject('alice')
    .setAudience('oaiapp_fixture').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  return {
    id_token: idToken, access_token: 'fixture-access-' + number, refresh_token: 'fixture-refresh-' + number,
    token_type: 'Bearer', expires_in: number === 1 ? 0 : 3600,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
  };
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  assert.equal(init.redirect, 'error');
  if (url.href === issuer + '/.well-known/openid-configuration') return json({
    issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks'
  });
  if (url.href === issuer + '/jwks') return json({ keys: [jwk] });
  if (url.href === issuer + '/token') {
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') === 'authorization_code') return json(await tokens(1));
    if (form.get('refresh_token') !== currentRefresh) return json({ error: 'invalid_grant' }, 400);
    currentRefresh = 'fixture-refresh-2';
    await new Promise(resolve => { releaseRotation = resolve; process.send({ type: 'rotation' }); });
    return json(await tokens(2));
  }
  if (url.href === 'https://api.openai.com/v1/models') {
    assert.equal(init.headers.authorization, 'Bearer fixture-access-2');
    return json({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' }] });
  }
  throw new Error('Unexpected outbound request in hosted entrypoint test');
};
