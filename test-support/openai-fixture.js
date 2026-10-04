// Local protocol fixture. This file is not included in the production image.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from 'jose';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const passage = 'Ana vive en Madrid y aprende idiomas con sus amigos. Cada mañana visita el mercado del barrio. Hoy está contenta porque prepara una cena especial. Su amigo Luis es cocinero y está en la cocina. Juntos eligen verduras frescas y hablan de sus viajes. Por la tarde, todos se reúnen en casa de Ana para compartir historias y practicar español.';

function sample(schema, key = '', index = 0) {
  if (schema?.enum) return schema.enum.includes('B1') ? 'B1' : schema.enum[0];
  const type = Array.isArray(schema?.type) ? schema.type.find(t => t !== 'null') : schema?.type;
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([name, child]) => [name, sample(child, name, index)]));
  if (type === 'array') {
    const count = key === 'items' ? 6 : Math.min(8, Math.max(schema.minItems || 1, key === 'chapters' ? 3 : 1));
    return Array.from({ length: count }, (_, i) => sample(schema.items, key, i));
  }
  if (type === 'boolean') return key === 'correct' ? index === 0 : true;
  if (type === 'number' || type === 'integer') return schema.minimum ?? 1;
  return ({
    title: 'Ser y estar en la vida diaria', synopsis: 'Una tarde entre amigos en Madrid.', passage,
    sentence: `Ana ${index ? 'hoy ' : ''}_____ contenta.`, answers: 'está', hints: 'estar', hint: 'Una situación temporal.',
    question: '¿Qué forma completa «Ana ___ contenta»?', text: ['está', 'es', 'son', 'eres'][index % 4],
    rationale: index === 0 ? 'Estar expresa un estado temporal.' : 'Esta forma no describe el estado de Ana.',
    explanation: 'Usamos estar para un estado temporal.', difficulty: 'B1', content_markdown: 'Usamos **ser** para identidad y **estar** para estados temporales.',
    studentInstructions: 'Escribe sobre un día con tus amigos.', student_instructions: 'Completa las frases.',
    example_answers: 'Hoy estoy contenta.', translation: 'happy', term: 'contenta', definition: 'Que siente alegría.',
    prompt: 'Describe cómo te sientes hoy.', model_answer: 'Hoy estoy contenta porque veo a mis amigos.',
    statement: 'Ana vive en Madrid.', grammarTopic: 'Ser y estar', topic: 'Ser y estar', image_prompt: '',
  })[key] || 'Una tarde en Madrid';
}

export async function startOpenAIFixture({ port = 0, sameEmail = false, tokenLifetimeSeconds = 3600 } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const codes = new Map(), access = new Map(), refresh = new Map(), registrations = new Map();
  // Diagnostics contain protocol identifiers and claims, never credential values.
  const stats = { tokenExchanges: 0, refreshes: 0, revocations: 0, requests: [], authorizations: [], registrations: [], tokenRequests: [], revocationRequests: [] };
  let origin;
  const issue = async context => {
    const accessToken = `fixture-access-${randomBytes(12).toString('hex')}`;
    const refreshToken = `fixture-refresh-${randomBytes(12).toString('hex')}`;
    access.set(accessToken, context);
    refresh.set(refreshToken, { ...context, accessToken });
    const idToken = await new SignJWT({ nonce: context.nonce, email: sameEmail ? 'learner@example.test' : `${context.user}@example.test`, name: context.user === 'alice' ? 'Alice Learner' : 'Bob Learner' })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(origin).setSubject(context.user)
      .setAudience(context.clientId).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return { access_token: accessToken, refresh_token: refreshToken, id_token: idToken, token_type: 'Bearer', expires_in: tokenLifetimeSeconds, scope: context.scope };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/.well-known/openid-configuration') return json(res, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`, revocation_endpoint: `${origin}/revoke`, id_token_signing_alg_values_supported: ['RS256'] });
      if (url.pathname === '/jwks') return json(res, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const buttons = [['alice', 'Continue as Alice'], ['bob', 'Continue as Bob'], ['identity', 'Continue without plan access'], ['deny', 'Decline']].map(([user, label]) => {
          const dest = new URL(url); dest.pathname = '/approve'; dest.searchParams.set('test_user', user);
          return `<p><a href="${escapeHtml(dest.href)}">${label}</a></p>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html lang="en"><title>Local OpenAI test server</title><body style="font:18px system-ui;max-width:620px;margin:80px auto;padding:20px"><h1>Test ChatGPT authorization</h1><p>This local test server exercises OAuth without a real OpenAI account or inference charge.</p>${buttons}</body></html>`);
      }
      if (url.pathname === '/approve') {
        const callback = new URL(url.searchParams.get('redirect_uri'));
        if (!['127.0.0.1', 'localhost'].includes(callback.hostname)) return json(res, { error: 'fixture_requires_loopback' }, 400);
        const requestedClientId = url.searchParams.get('client_id');
        let clientId = requestedClientId;
        const registration = registrations.get(clientId);
        const dynamic = requestedClientId === 'dynamic_agent_client';
        const hostId = url.searchParams.get('ext_agent_host_id');
        const user = url.searchParams.get('test_user') || registration?.user || 'alice';
        if (dynamic || registration) {
          if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !hostId || !/^(urn:uuid:|urn:ietf:params:oauth:jwk-thumbprint:|did:key:)/.test(hostId) || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('resource') !== 'https://api.openai.com/v1' || url.searchParams.has('client_secret')) return json(res, { error: 'invalid_local_authorization' }, 400);
          if (dynamic && !url.searchParams.get('agent_name_hint')) return json(res, { error: 'missing_agent_name_hint' }, 400);
          if (registration && (url.searchParams.has('agent_name_hint') || callback.pathname !== registration.callbackPath || (user !== 'deny' && user !== registration.user))) return json(res, { error: 'registration_mismatch' }, 400);
        }
        callback.searchParams.set('state', url.searchParams.get('state'));
        if (user === 'deny') callback.searchParams.set('error', 'access_denied');
        else {
          if (dynamic) {
            clientId = `oaiapp_fixture_${randomBytes(12).toString('hex')}`;
            const saved = { clientId, user: user === 'identity' ? 'alice' : user, hostId, callbackPath: callback.pathname };
            registrations.set(clientId, saved);
            stats.registrations.push(saved);
            callback.searchParams.set('client_id', clientId);
          }
          // Returning callbacks deliberately omit client_id, which is optional.
          const code = randomBytes(20).toString('hex');
          codes.set(code, { user: user === 'identity' ? 'alice' : user, nonce: url.searchParams.get('nonce'), clientId, redirectUri: url.searchParams.get('redirect_uri'), challenge: url.searchParams.get('code_challenge'), scope: user === 'identity' ? 'openid profile email' : scopes });
          callback.searchParams.set('code', code);
        }
        const hint = url.searchParams.get('id_token_hint');
        const hintClaims = hint ? decodeJwt(hint) : null;
        stats.authorizations.push({ requestedClientId, clientId, user, hostId, agentName: url.searchParams.get('agent_name_hint'), hasIdTokenHint: Boolean(hint), hintSubject: hintClaims?.sub, hintAudience: hintClaims?.aud, loginHint: url.searchParams.get('login_hint'), redirectUri: url.searchParams.get('redirect_uri') });
        res.writeHead(302, { location: callback.href }); return res.end();
      }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2 * 1024 * 1024) { res.writeHead(413); return res.end(); } }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body);
        stats.tokenRequests.push({ grantType: form.get('grant_type'), clientId: form.get('client_id'), resource: form.get('resource'), hasClientSecret: form.has('client_secret'), hasAuthorizationHeader: Boolean(req.headers.authorization), hasScope: form.has('scope') });
        if (registrations.has(form.get('client_id')) && (form.has('client_secret') || req.headers.authorization)) return json(res, { error: 'invalid_client' }, 400);
        if (form.get('grant_type') === 'refresh_token') {
          const previous = refresh.get(form.get('refresh_token'));
          if (!previous || form.get('client_id') !== previous.clientId || form.get('resource') !== 'https://api.openai.com/v1' || form.has('scope')) return json(res, { error: 'invalid_grant' }, 400);
          refresh.delete(form.get('refresh_token')); access.delete(previous.accessToken); stats.refreshes++;
          return json(res, await issue(previous));
        }
        const context = codes.get(form.get('code')); codes.delete(form.get('code'));
        const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!context || context.clientId !== form.get('client_id') || context.redirectUri !== form.get('redirect_uri') || context.challenge !== challenge || form.get('resource') !== 'https://api.openai.com/v1') return json(res, { error: 'invalid_grant' }, 400);
        stats.tokenExchanges++;
        return json(res, await issue(context));
      }
      if (url.pathname === '/revoke') {
        const form = new URLSearchParams(body), token = form.get('token'), context = refresh.get(token);
        stats.revocationRequests.push({ clientId: form.get('client_id'), tokenTypeHint: form.get('token_type_hint'), hasClientSecret: form.has('client_secret'), hasAuthorizationHeader: Boolean(req.headers.authorization) });
        if (context && (form.get('client_id') !== context.clientId || form.get('token_type_hint') !== 'refresh_token')) return json(res, { error: 'invalid_client' }, 400);
        if (registrations.has(form.get('client_id')) && (form.has('client_secret') || req.headers.authorization)) return json(res, { error: 'invalid_client' }, 400);
        if (context) { refresh.delete(token); access.delete(context.accessToken); }
        stats.revocations++; res.writeHead(200); return res.end();
      }
      const context = access.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!context) return json(res, { error: { code: 'subscription_sharing_invalid_user' } }, 401);
      if (!context.scope.includes('chatgpt.tokens.use.direct')) return json(res, { error: { code: 'chatpass_v2_scope_not_authorized' } }, 403);
      if (url.pathname === '/v1/models') return json(res, { models: [{ slug: 'fixture-model', display_name: 'Test language model', visibility: 'list' }, { slug: 'fixture-alternative', display_name: 'Test alternative model', visibility: 'list' }] });
      if (url.pathname === '/v1/responses') {
        const payload = JSON.parse(body);
        if (payload.store !== false || payload.stream !== true || !Array.isArray(payload.input) || ['temperature', 'max_output_tokens', 'previous_response_id'].some(key => key in payload)) return json(res, { error: { code: 'subscription_sharing_unsupported_capability' } }, 400);
        const prompt = payload.input.map(item => item.content).join('\n');
        stats.requests.push({ user: context.user, clientId: context.clientId, model: payload.model, schemaName: payload.text?.format?.name, prompt });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-response' });
        const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (/quota-test/i.test(prompt)) {
          send({ type: 'response.output_text.delta', delta: 'Partial response' });
          send({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }); return res.end();
        }
        const text = payload.text?.format?.schema ? JSON.stringify(sample(payload.text.format.schema)) : `# Ser y estar\n\n**Ser** describe identidad y características. **Estar** describe ubicación y estados temporales.\n\n- Ana **es** profesora.\n- Hoy Ana **está** contenta.\n\nPráctica preparada para ${context.user === 'alice' ? 'Alice' : 'Bob'}.`;
        for (let offset = 0; offset < text.length; offset += 37) send({ type: 'response.output_text.delta', delta: text.slice(offset, offset + 37) });
        send({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
        return res.end();
      }
      return json(res, { error: 'not_found' }, 404);
    } catch { if (!res.headersSent) json(res, { error: 'fixture_error' }, 500); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, stats, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
