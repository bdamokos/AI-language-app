import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';

const OPENAI_ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const IDENTITY_SCOPES = 'openid profile email';
const PLAN_SCOPES = 'offline_access resource.invoke chatgpt.tokens.use.direct';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const TRANSACTION_TTL = 10 * 60 * 1000;
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const error = (status, code, message) => Object.assign(new Error(message), { status, httpStatus: status, code });
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const within = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const isLoopback = url => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);

function validatedUrl(value, label, originOnly = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !isLoopback(url)) || url.username || url.password || url.hash || url.search || (originOnly && url.pathname !== '/')) {
    throw new Error(`${label} must be an HTTPS ${originOnly ? 'origin' : 'URL'} (HTTP loopback is allowed for development).`);
  }
  return url;
}

// This store belongs to one server process. Persist the private AUTH_DIR volume,
// and run one replica; clustered deployments need a transactional shared store.
async function createStore(authDir, cacheDir) {
  const resolved = path.resolve(authDir);
  if (cacheDir && within(path.resolve(cacheDir), resolved)) throw new Error('AUTH_DIR must be outside CACHE_DIR.');
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(resolved)).isSymbolicLink()) throw new Error('AUTH_DIR must not be a symbolic link.');
  await fs.chmod(resolved, 0o700);
  const realDir = await fs.realpath(resolved);
  const realCache = cacheDir ? await fs.realpath(path.resolve(cacheDir)).catch(() => path.resolve(cacheDir)) : null;
  if (realCache && within(realCache, realDir)) throw new Error('AUTH_DIR must be outside CACHE_DIR.');
  const keyPath = path.join(realDir, 'encryption.key');
  try {
    await fs.writeFile(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if ((await fs.lstat(keyPath)).isSymbolicLink()) throw new Error('The credential encryption key must not be a symbolic link.');
  await fs.chmod(keyPath, 0o600);
  const key = await fs.readFile(keyPath);
  if (key.length !== 32) throw new Error('Invalid credential encryption key.');
  const filename = id => path.join(realDir, `${digest(id)}.session`);
  return {
    async prune(timestamp) {
      for (const name of await fs.readdir(realDir)) {
        if (!/^[a-f0-9]{64}\.session(?:\.[A-Za-z0-9_-]+\.tmp)?$/.test(name)) continue;
        const location = path.join(realDir, name);
        const stat = await fs.lstat(location).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        // A file cannot outlive its last write + the maximum session lifetime.
        // Use lstat so cleanup never follows a planted symlink.
        if (stat && stat.mtimeMs <= timestamp - (name.endsWith('.tmp') ? 60 * 60 * 1000 : SESSION_TTL)) await fs.rm(location, { force: true });
      }
    },
    async read(id) {
      let raw;
      try { raw = await fs.readFile(filename(id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const envelope = JSON.parse(raw);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8'));
    },
    async write(id, value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      const temporary = `${filename(id)}.${random()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename(id));
      } finally { await fs.rm(temporary, { force: true }); }
    },
    remove: id => fs.rm(filename(id), { force: true })
  };
}

/** Explicit dependency injection supports protocol tests without a runtime auth bypass. */
export async function createAuth({ config = {}, fetch: fetchImpl = globalThis.fetch, issuer = OPENAI_ISSUER, now = Date.now } = {}) {
  const appOrigin = validatedUrl(config.appOrigin ?? process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.NODE_ENV === 'production' ? '3000' : '5173'}`, 'APP_ORIGIN', true).origin;
  const redirect = validatedUrl(config.redirectUri ?? (process.env.OPENAI_REDIRECT_URI?.trim() || `${appOrigin}/api/auth/callback`), 'OPENAI_REDIRECT_URI');
  if (redirect.origin !== appOrigin || redirect.pathname !== '/api/auth/callback') throw new Error('OPENAI_REDIRECT_URI must use APP_ORIGIN and /api/auth/callback.');
  const issuerUrl = validatedUrl(issuer, 'Issuer', true);
  issuer = issuerUrl.origin;
  const clientId = config.clientId ?? process.env.OPENAI_CLIENT_ID ?? '';
  const clientSecret = config.clientSecret ?? process.env.OPENAI_CLIENT_SECRET ?? '';
  const tokenAuthMethod = config.tokenAuthMethod ?? process.env.OPENAI_TOKEN_AUTH_METHOD ?? (clientSecret ? 'client_secret_basic' : 'none');
  if (!['none', 'client_secret_basic'].includes(tokenAuthMethod)) throw new Error('OPENAI_TOKEN_AUTH_METHOD must be none or client_secret_basic.');
  if (tokenAuthMethod === 'none' && clientSecret) throw new Error('A public OAuth client must not use OPENAI_CLIENT_SECRET.');
  const configured = Boolean(clientId && clientId !== 'dynamic_agent_client' && (tokenAuthMethod !== 'client_secret_basic' || clientSecret));
  const configurationError = !configured ? 'The operator must configure an approved OpenAI website client with ChatGPT plan access.' : null;
  const secureCookie = new URL(appOrigin).protocol === 'https:';
  const cookieName = secureCookie ? '__Host-language_session' : 'language_session';
  const store = await createStore(config.authDir ?? process.env.AUTH_DIR ?? path.resolve('.auth'), config.cacheDir ?? process.env.CACHE_DIR ?? path.resolve('.cache'));
  const locks = new Map();
  const controllers = new Map();
  let lastMaintenance = now();
  let maintenancePending;
  await store.prune(now());
  let metadataCache;
  let keyCache;
  let discoveryPending;

  async function locked(id, task) {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    locks.set(id, current);
    try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
  }
  const controller = (id, expiresAt) => {
    if (!controllers.has(id)) controllers.set(id, { value: new AbortController(), expiresAt });
    return controllers.get(id).value;
  };
  async function maintain() {
    if (maintenancePending) return maintenancePending;
    if (now() - lastMaintenance < 5 * 60 * 1000) return;
    lastMaintenance = now();
    for (const [id, item] of controllers) {
      if (item.expiresAt <= now()) { item.value.abort(); controllers.delete(id); }
    }
    maintenancePending = store.prune(now());
    try { await maintenancePending; } finally { maintenancePending = null; }
  }
  async function drop(id) {
    controllers.get(id)?.value.abort();
    controllers.delete(id);
    await store.remove(id);
  }
  async function load(id) {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const session = await store.read(id);
    if (session && (session.expiresAt <= now() || (session.user && (session.issuer !== issuer || session.clientId !== clientId)))) { await drop(id); return null; }
    return session;
  }
  const sessionId = req => {
    const matches = String(req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : null;
  };
  function setCookie(res, id) {
    res.setHeader('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secureCookie ? '; Secure' : ''}`);
  }
  function newSession() { return { csrfToken: random(), expiresAt: now() + SESSION_TTL, user: null, accountId: null }; }
  async function ensureSession(req, res) {
    await maintain();
    let id = sessionId(req);
    let session = await load(id);
    if (!session) {
      id = random(); session = newSession();
      await store.write(id, session);
      setCookie(res, id);
    }
    return { id, session };
  }
  async function remote(url, options = {}) {
    try { return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw error(503, 'auth_unavailable', 'ChatGPT sign-in is temporarily unavailable. Please try again.'); }
  }
  async function readResponse(response) {
    let data;
    try { const text = await response.text(); if (text.length > 1_000_000) throw new Error(); data = JSON.parse(text); }
    catch { throw error(503, 'auth_unavailable', 'ChatGPT returned an invalid authentication response. Please try again.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw error(503, 'auth_unavailable', 'ChatGPT returned an invalid authentication response.');
    return data;
  }
  async function metadata() {
    if (metadataCache && metadataCache.expiresAt > now()) return metadataCache.value;
    if (discoveryPending) return discoveryPending;
    discoveryPending = (async () => {
      const response = await remote(`${issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw error(503, 'auth_unavailable', 'ChatGPT sign-in is temporarily unavailable.');
      const value = await readResponse(response);
      if (value.issuer !== issuer) throw error(503, 'auth_configuration', 'ChatGPT identity configuration could not be verified.');
      for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
        if (field === 'revocation_endpoint' && !value[field]) continue;
        let endpoint;
        try { endpoint = validatedUrl(value[field], 'Identity endpoint'); } catch { throw error(503, 'auth_configuration', 'ChatGPT identity configuration could not be verified.'); }
        if (endpoint.origin !== issuer) throw error(503, 'auth_configuration', 'ChatGPT identity configuration could not be verified.');
      }
      metadataCache = { value, expiresAt: now() + 60 * 60 * 1000 };
      return value;
    })();
    try { return await discoveryPending; } finally { discoveryPending = null; }
  }
  async function keySet(force = false) {
    if (!force && keyCache && keyCache.expiresAt > now()) return keyCache.value;
    const response = await remote((await metadata()).jwks_uri);
    if (!response.ok) throw error(503, 'auth_unavailable', 'ChatGPT identity keys are temporarily unavailable.');
    const value = createLocalJWKSet(await readResponse(response));
    keyCache = { value, expiresAt: now() + 5 * 60 * 1000 };
    return value;
  }
  async function verifyIdentity(idToken, expectedNonce, expectedSubject) {
    if (typeof idToken !== 'string' || idToken.length > 32_768) throw error(401, 'invalid_identity', 'ChatGPT sign-in could not be verified.');
    const options = { issuer, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(now()) };
    let result;
    try {
      try { result = await jwtVerify(idToken, await keySet(), options); }
      catch (e) { if (e.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw e; result = await jwtVerify(idToken, await keySet(true), options); }
    } catch (e) { if (e.status === 503) throw e; throw error(401, 'invalid_identity', 'ChatGPT sign-in could not be verified.'); }
    const identity = result.payload;
    if (typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 1024 || identity.iat > now() / 1000 + 5 || (expectedNonce !== undefined && !safeEqual(identity.nonce, expectedNonce)) || (expectedSubject && identity.sub !== expectedSubject) || (identity.azp !== undefined && identity.azp !== clientId) || (Array.isArray(identity.aud) && identity.aud.length > 1 && identity.azp !== clientId)) {
      throw error(401, 'invalid_identity', 'ChatGPT sign-in could not be verified.');
    }
    return identity;
  }
  function tokenHeaders() {
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (tokenAuthMethod === 'client_secret_basic') {
      const encode = value => new URLSearchParams({ value }).toString().slice(6);
      headers.authorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
    }
    return headers;
  }
  async function exchange(body) {
    const response = await remote((await metadata()).token_endpoint, { method: 'POST', headers: tokenHeaders(), body: new URLSearchParams({ client_id: clientId, ...body }) });
    const tokens = await readResponse(response);
    if (!response.ok) {
      const terminal = response.status < 500 && ['invalid_grant', 'invalid_token', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(tokens.error);
      if (tokens.error === 'invalid_client' && response.status < 500) throw error(503, 'auth_configuration', 'The operator must check the OpenAI client configuration.');
      throw Object.assign(error(terminal ? 401 : 503, terminal ? 'session_expired' : 'auth_unavailable', terminal ? 'Your ChatGPT connection expired. Please sign in again.' : 'ChatGPT sign-in is temporarily unavailable. Please try again.'), { terminal });
    }
    return tokens;
  }
  async function revoke(refreshToken) {
    if (!refreshToken) return true;
    try {
      const endpoint = (await metadata()).revocation_endpoint;
      if (!endpoint) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await remote(endpoint, { method: 'POST', headers: tokenHeaders(), body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }) });
          if (response.status === 200) return true;
          if (response.status < 500) return false;
        } catch { /* Retry a transient revocation failure once. */ }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch { /* Local sign-out still succeeds if discovery is unavailable. */ }
    return false;
  }
  function credentials(tokens, previous) {
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? []);
    const accessToken = tokens.access_token;
    if (accessToken !== undefined && (typeof accessToken !== 'string' || !accessToken || !Number.isFinite(tokens.expires_in) || tokens.expires_in < 0 || String(tokens.token_type).toLowerCase() !== 'bearer')) throw error(503, 'auth_unavailable', 'ChatGPT returned invalid credentials. Please sign in again.');
    if (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)) throw error(503, 'auth_unavailable', 'ChatGPT returned invalid credentials. Please sign in again.');
    return { accessToken: accessToken ?? null, refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null, expiresAt: accessToken ? now() + tokens.expires_in * 1000 : 0, scopes };
  }
  const inferenceEnabled = session => Boolean(session.credentials?.accessToken && session.credentials.scopes.includes('chatgpt.tokens.use.direct') && session.credentials.scopes.includes('resource.invoke'));

  function guard(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(appOrigin).host || (req.headers.origin && req.headers.origin !== appOrigin)) return res.status(403).json({ code: 'untrusted_origin', error: 'This request did not come from the application.' });
    next();
  }
  const requireCsrf = wrap(async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const session = await load(sessionId(req));
    if (req.headers.origin !== appOrigin || req.headers['sec-fetch-site'] === 'cross-site' || !session || !safeEqual(req.headers['x-csrf-token'], session.csrfToken)) return res.status(403).json({ code: 'csrf_failed', error: 'Refresh the page and try again.' });
    next();
  });
  const middleware = wrap(async (req, res, next) => {
    await maintain();
    const id = sessionId(req);
    const session = await load(id);
    if (!configured || !session?.user) return res.status(401).json({ code: 'sign_in_required', error: 'Sign in with ChatGPT to continue.' });
    req.auth = { sessionId: id, accountId: session.accountId, user: session.user, inferenceEnabled: inferenceEnabled(session), signal: controller(id, session.expiresAt).signal };
    next();
  });

  async function getAccessToken(auth) {
    if (!configured || !auth?.sessionId) throw error(401, 'sign_in_required', 'Sign in with ChatGPT to continue.');
    return locked(auth.sessionId, async () => {
      const session = await load(auth.sessionId);
      if (!session?.user || session.accountId !== auth.accountId || auth.signal?.aborted) throw error(401, 'sign_in_required', 'Sign in with ChatGPT to continue.');
      if (!inferenceEnabled(session)) throw error(403, 'inference_not_enabled', 'Allow this app to use your ChatGPT plan to continue.');
      if (session.credentials.expiresAt > now() + 60_000) return session.credentials.accessToken;
      if (!session.credentials.refreshToken) throw error(401, 'session_expired', 'Your ChatGPT connection expired. Please sign in again.');
      let tokens;
      try { tokens = await exchange({ grant_type: 'refresh_token', refresh_token: session.credentials.refreshToken, resource: RESOURCE }); }
      catch (e) {
        if (e.terminal) {
          delete session.credentials; session.user = null; session.accountId = null;
          controllers.get(auth.sessionId)?.value.abort(); controllers.delete(auth.sessionId);
          await store.write(auth.sessionId, session);
        }
        throw e;
      }
      if (tokens.id_token) await verifyIdentity(tokens.id_token, undefined, session.subject);
      if (!tokens.access_token) throw error(503, 'auth_unavailable', 'ChatGPT returned invalid credentials. Please try again.');
      const updated = credentials(tokens, session.credentials);
      session.credentials = updated;
      await store.write(auth.sessionId, session);
      if (auth.signal?.aborted) throw error(401, 'sign_in_required', 'Sign in with ChatGPT to continue.');
      if (!inferenceEnabled(session)) throw error(403, 'inference_not_enabled', 'Allow this app to use your ChatGPT plan to continue.');
      return updated.accessToken;
    });
  }

  function attachRoutes(app) {
    app.get('/api/auth/session', guard, wrap(async (req, res) => {
      const { session } = await ensureSession(req, res);
      res.json({ authenticated: Boolean(configured && session.user), configured, mode: 'hosted', user: configured ? session.user : null, inferenceEnabled: configured && inferenceEnabled(session), csrfToken: session.csrfToken, accounts: session.user && configured ? [{ id: session.accountId, label: session.user.email || session.user.name || 'ChatGPT account', connected: true }] : [], ...(configurationError ? { error: configurationError } : {}) });
    }));
    app.post('/api/auth/login', guard, requireCsrf, wrap(async (req, res) => {
      if (!configured) return res.status(503).json({ code: 'auth_not_configured', error: configurationError });
      const id = sessionId(req);
      await locked(id, async () => {
        const session = await load(id);
        if (!session) throw error(403, 'csrf_failed', 'Refresh the page and try again.');
        const selectedAccount = req.body?.accountId;
        if (selectedAccount && selectedAccount !== session.accountId) throw error(400, 'invalid_account', 'Sign in to select another ChatGPT account.');
        const enableInference = req.body?.enableInference !== false;
        const consentRecovery = req.body?.enableInference === true && session.user && !inferenceEnabled(session);
        const transaction = { state: random(), nonce: random(), verifier: crypto.randomBytes(48).toString('base64url'), expiresAt: now() + TRANSACTION_TTL, subject: selectedAccount || consentRecovery ? session.subject : null };
        const url = new URL((await metadata()).authorization_endpoint);
        url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect.href, scope: `${IDENTITY_SCOPES}${enableInference ? ` ${PLAN_SCOPES}` : ''}`, state: transaction.state, nonce: transaction.nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(transaction.verifier).digest('base64url'), ...(enableInference ? { resource: RESOURCE } : {}), ...(consentRecovery ? { prompt: 'consent' } : !selectedAccount && session.user ? { prompt: 'select_account' } : {}) }).toString();
        transaction.enableInference = enableInference;
        session.transaction = transaction;
        await store.write(id, session);
        res.json({ url: url.href });
      });
    }));
    app.get('/api/auth/callback', guard, wrap(async (req, res) => {
      const id = sessionId(req);
      const finish = outcome => res.redirect(302, `${appOrigin}/?auth=${outcome}`);
      if (!configured || !id) return finish('error');
      try {
        await locked(id, async () => {
          const session = await load(id);
          const transaction = session?.transaction;
          if (session?.transaction) { delete session.transaction; await store.write(id, session); }
          if (!transaction || transaction.expiresAt <= now() || !safeEqual(req.query.state, transaction.state) || req.query.error || typeof req.query.code !== 'string' || !req.query.code || (req.query.client_id !== undefined && req.query.client_id !== clientId)) throw error(401, 'invalid_callback', 'ChatGPT sign-in could not be verified.');
          const signInSignal = controller(id, session.expiresAt).signal;
          const tokens = await exchange({ grant_type: 'authorization_code', code: req.query.code, code_verifier: transaction.verifier, redirect_uri: redirect.href, ...(transaction.enableInference ? { resource: RESOURCE } : {}) });
          const identity = await verifyIdentity(tokens.id_token, transaction.nonce, transaction.subject);
          const cancelSignIn = async () => {
            if (!await revoke(tokens.refresh_token)) {
              session.revocationUnconfirmed = true;
              await store.write(id, session);
            }
            throw error(401, 'sign_in_cancelled', 'Sign-in was cancelled.');
          };
          if (signInSignal.aborted) await cancelSignIn();
          const accountId = digest(`${issuer}\0${clientId}\0${identity.sub}`);
          const fresh = newSession();
          fresh.accountId = accountId;
          fresh.subject = identity.sub;
          fresh.issuer = issuer;
          fresh.clientId = clientId;
          fresh.user = { id: accountId, name: typeof identity.name === 'string' ? identity.name : null, email: typeof identity.email === 'string' ? identity.email : null };
          fresh.credentials = credentials(tokens);
          const freshId = random();
          await store.write(freshId, fresh);
          if (signInSignal.aborted) { await drop(freshId); await cancelSignIn(); }
          await drop(id);
          setCookie(res, freshId);
        });
        return finish('success');
      } catch { return finish('error'); }
    }));
    app.post('/api/auth/logout', guard, requireCsrf, wrap(async (req, res) => {
      const id = sessionId(req);
      // Abort current work before waiting behind a token refresh.
      controllers.get(id)?.value.abort();
      let revocationConfirmed = true;
      await locked(id, async () => {
        const session = await load(id);
        const refreshToken = session?.credentials?.refreshToken;
        await drop(id);
        revocationConfirmed = await revoke(refreshToken) && !session?.revocationUnconfirmed;
      });
      const freshId = random();
      await store.write(freshId, newSession());
      setCookie(res, freshId);
      res.json({ ok: true, revocationConfirmed });
    }));
  }
  return { attachRoutes, middleware, requireCsrf, guard, getAccessToken, configured, mode: 'hosted' };
}
