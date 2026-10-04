import express from 'express';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { isIP } from 'node:net';
import { ensureCacheLayout, getExplanation, setExplanation, getBaseText, setBaseText, loadBaseTextsIndex, sha256Hex, readExerciseItem, selectUnseenCrossModel, selectUnseenCrossModelGrouped, addExercisesToPool, makeBucketKey, incrementExerciseHits, rateExplanation, rateExerciseGroup, loadExercisesIndex } from './cacheStore.js';
import { BASE_TEXT_SYSTEM_PROMPT, generateBaseTextUserPrompt, BASE_TEXT_SCHEMA, addSourceMetadata, calculateTextSuitability, checkTextSuitability } from './baseTextPrompts.js';
import { pickRandomTopicSuggestion } from '../shared/topicRoulette.js';
import { schemaVersions } from '../shared/schemaVersions.js';

function errorStatus(error) {
  const status = Number(error?.status || error?.httpStatus);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}
function safeMessage(error) {
  return errorStatus(error) !== 500 && typeof error?.message === 'string' ? error.message : 'The request could not be completed. Please try again.';
}
function safeDecodeCookie(value) { try { return decodeURIComponent(value); } catch { return ''; } }

function parseGenerated(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error('ChatGPT returned an invalid exercise. Please try again.'), { status: 502, code: 'invalid_output' });
  }
}

// MCQ option deduplication: remove duplicate option.text values within an item.
// Prefer keeping the option marked as correct among duplicates; otherwise keep the earliest.
// Returns { item, changed, valid } where valid requires at least 2 distinct options.
function dedupeMcqItemOptions(originalItem) {
  try {
    const item = originalItem && typeof originalItem === 'object' ? { ...originalItem } : originalItem;
    const options = Array.isArray(item?.options) ? item.options.slice() : [];
    if (!Array.isArray(options) || options.length === 0) {
      return { item: originalItem, changed: false, valid: false };
    }
    const textToChoice = new Map();
    const order = [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i] || {};
      const text = String(opt.text || '');
      if (!textToChoice.has(text)) {
        textToChoice.set(text, opt);
        order.push(text);
      } else {
        const kept = textToChoice.get(text);
        if (opt && opt.correct && !kept.correct) {
          // Prefer the correct one if duplicate texts differ in correctness
          textToChoice.set(text, opt);
        }
        // otherwise, keep the first seen
      }
    }
    const newOptions = order.map(t => textToChoice.get(t));
    const changed = newOptions.length !== options.length;
    const valid = newOptions.length >= 2;
    if (!changed) {
      return { item: originalItem, changed: false, valid };
    }
    const nextItem = { ...item, options: newOptions };
    return { item: nextItem, changed: true, valid };
  } catch {
    return { item: originalItem, changed: false, valid: true };
  }
}

// Only network peers controlled by the operator may supply client addresses.
// Named shortcuts and hop counts can accidentally trust a shorter public route.
export function parseTrustedProxyCidrs(value = '') {
  if (typeof value !== 'string') throw new Error('TRUSTED_PROXY_CIDRS must be a comma-separated list of explicit IP addresses or CIDRs.');
  if (!value.trim()) return [];
  return [...new Set(value.split(',').map(part => {
    const entry = part.trim();
    const [address, prefixText, extra] = entry.split('/');
    const family = isIP(address);
    const fail = () => { throw new Error('TRUSTED_PROXY_CIDRS accepts explicit IP addresses and nonzero CIDR prefixes only; wildcards, names and hop counts are not allowed.'); };
    if (!family || address.includes('%') || extra !== undefined) return fail();
    if (prefixText === undefined) return address;
    if (!/^[0-9]{1,3}$/.test(prefixText)) return fail();
    const prefix = Number(prefixText);
    if (prefix < 1 || prefix > (family === 4 ? 32 : 128)) return fail();
    // proxy-addr converts mapped IPv6 ranges to IPv4. Require ordinary IPv4
    // notation so a /96 cannot silently become an all-addresses IPv4 /0.
    if (family === 6 && new URL(`http://[${address}]/`).hostname.startsWith('[::ffff:')) return fail();
    return `${address}/${prefix}`;
  }))];
}

function ipRateLimiter(limit, message) {
  return rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    // With no trusted proxy, forged X-Forwarded-For is deliberately ignored.
    validate: { xForwardedForHeader: false }, message: { error: message } });
}

/** Account credentials are supplied only by auth; legacy operator keys are never read. */
export function createApp({ auth, inference, cacheDir = path.resolve('.cache'), distDir = path.resolve('dist'), production = process.env.NODE_ENV === 'production', rateLimitMax = 120, authRateLimitMax = 120, loginRateLimitMax = 10, frontendRateLimitMax = 600, trustedProxyCidrs = '', lifetimeSignal } = {}) {
  if (!auth || !inference) throw new Error('Authentication and inference services are required.');
  const proxies = parseTrustedProxyCidrs(trustedProxyCidrs);
  const app = express();
  app.set('trust proxy', proxies.length ? proxies : false);
  app.disable('x-powered-by');
  // Host validation uses APP_ORIGIN in auth, not untrusted forwarded headers.
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (production) res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://auth.openai.com");
    if (req.path.startsWith('/api') || req.path.startsWith('/cache')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', auth.guard);
  app.use('/api/auth', ipRateLimiter(authRateLimitMax, 'Too many sign-in requests. Please try again shortly.'));
  app.use('/api/auth/login', ipRateLimiter(loginRateLimitMax, 'Too many sign-in attempts. Please wait a minute.'));
  app.use(express.json({ limit: '1mb' }));
  auth.attachRoutes(app);
  app.use('/api', auth.requireCsrf, auth.middleware);
  app.use('/api', rateLimit({ windowMs: 60_000, limit: rateLimitMax, keyGenerator: req => req.auth.accountId, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please try again shortly.' } }));
  app.use('/api', (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    if (res.destroyed || res.writableEnded) controller.abort();
    req.inferenceSignal = AbortSignal.any([controller.signal, req.auth.signal, lifetimeSignal].filter(Boolean));
    next();
  });
  // Old anonymous cache and images are intentionally not mounted or imported.
  // A fresh, private layout is selected for every authenticated account.
  const layouts = new Map();
  const contentRoutes = new Set(['/api/generate', '/api/explanations/stream', '/api/base-text', '/api/explain', '/api/recommend', '/api/rate/explanation', '/api/rate/exercise-group', '/api/persist-exercise']);
  app.use('/api', async (req, res, next) => {
    if (!contentRoutes.has(req.originalUrl.split('?')[0]) && !req.originalUrl.startsWith('/api/base-text-content/')) return next();
    if (req.inferenceSignal.aborted) throw Object.assign(new Error('The request was cancelled.'), { status: 499, code: 'request_cancelled' });
    const namespace = sha256Hex(String(req.auth.accountId));
    req.cacheNamespace = namespace;
    if (!layouts.has(namespace)) {
      if (layouts.size >= 1000) layouts.delete(layouts.keys().next().value);
      const pending = ensureCacheLayout(path.join(cacheDir, 'accounts', namespace)).catch(error => { layouts.delete(namespace); throw error; });
      layouts.set(namespace, pending);
    }
    req.cacheLayout = { ...await layouts.get(namespace), signal: req.inferenceSignal };
    next();
  });
  async function generateForRequest(req, options) {
    const text = await inference.generate(req, options);
    if (req.inferenceSignal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { status: 499, code: 'request_cancelled' });
    return text;
  }
  app.get('/api/models', async (req, res) => res.json(await inference.listModels(req)));
  app.get('/api/settings', async (req, res) => {
    const model = await inference.getModel(req);
    res.json({ provider: 'chatgpt', model, chatgpt: { model }, imageProvider: 'none', runware: { enabled: false }, falai: { enabled: false } });
  });
  app.post('/api/settings', async (req, res) => {
    if (!req.body || typeof req.body.model !== 'string' || Object.keys(req.body).some(key => key !== 'model')) return res.status(400).json({ error: 'Choose a ChatGPT model.' });
    const model = await inference.selectModel(req, req.body.model);
    res.json({ ok: true, model });
  });
// Generic LLM generation endpoint (will be extended for persistent cache)
app.post('/api/generate', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    const { system, user, jsonSchema, schemaName, metadata } = req.body || {};
    if (typeof user !== 'string' || !user.trim() || user.length > 150_000) return res.status(400).json({ error: 'User prompt is required' });
    
    if (system != null && (typeof system !== 'string' || system.length > 50_000)) return res.status(400).json({ error: 'Invalid system prompt' });
    if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) return res.status(400).json({ error: 'Invalid metadata' });
    for (const key of ['language', 'level', 'topic']) { if (metadata?.[key] != null && (typeof metadata[key] !== 'string' || metadata[key].length > 2000)) return res.status(400).json({ error: 'Invalid lesson context' }); }

    // Identify type from schemaName
    const type = (() => {
      if (schemaName === 'explanation') return 'explanation';
      if (schemaName === 'base_text') return 'base_text';
      if (schemaName === 'fib_list') return 'fib';
      if (schemaName === 'mcq_list') return 'mcq';
      if (schemaName === 'writing_prompts_list') return 'writing_prompts';
      if (schemaName === 'rewriting_list') return 'rewriting';
      if (/^cloze_single_/.test(String(schemaName))) return 'cloze';
      if (/^cloze_mixed_single_/.test(String(schemaName))) return 'cloze_mixed';
      if (schemaName === 'unified_cloze') return 'unified_cloze';
      if (schemaName === 'guided_dialogues_list') return 'guided_dialogues';
      if (schemaName === 'reading_list') return 'reading';
      if (schemaName === 'reading_from_base_text') return 'reading';
      if (schemaName === 'error_bundle_list') return 'error_bundle';
      return 'unknown';
    })();

    // Extract common context from prompt
    // Prefer explicit metadata over regex parsing
    const languageMatch = user.match(/Target Language:\s*([^\n]+)/i);
    const levelMatch = user.match(/Target Level:\s*([^\n]+)/i);
    const languageName = (metadata?.language || (languageMatch ? languageMatch[1].trim() : '') || 'unknown');
    const levelFromPrompt = levelMatch ? levelMatch[1].trim() : '';
    const level = (metadata?.level || String(levelFromPrompt).replace(/\(slightly challenging\)/i, '').trim() || 'unknown');
    const challengeMode = typeof metadata?.challengeMode === 'boolean' ? metadata.challengeMode : /slightly challenging/i.test(levelFromPrompt);
    const topicMatchGeneric = user.match(/about:\s*([^\n]+)/i);
    const grammarTopic = (metadata?.topic || (topicMatchGeneric ? topicMatchGeneric[1] : '')).trim() || 'unknown';
    const currentModel = await inference.getModel(req);
    const schemaVersion = schemaVersions[type] || (type === 'explanation' ? schemaVersions.explanation : 1);
    const promptSha = sha256Hex(`${system || ''}\n${user}\n${schemaName}\n${languageName}:${level}:${challengeMode}`);
    const promptSha12 = promptSha.slice(0, 12);

    // Base text persistent cache handling
    if (cacheLayout && type === 'base_text') {
      const currentModel = await inference.getModel(req);
      const topic = (metadata?.topic || (user.match(/about:\s*([^\n]+)/i)?.[1] || 'unknown')).trim();
      const baseKey = `base:${languageName}:${level}:${challengeMode}:${topic}:${currentModel}:${schemaVersion}:${promptSha12}`;
      const rec = await getBaseText(cacheLayout, baseKey);
      if (rec && rec.content) {
        return res.json({ ...rec.content, _cacheKey: baseKey });
      }
      const text = await generateForRequest(req, { system, user, jsonSchema, schemaName });
      let parsed;
      try {
        parsed = parseGenerated(text);
      } catch (e) {
        return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: 'chatgpt' });
      }
      try {
        // Deterministic ID for the base text
        const idSource = `${languageName}:${level}:${challengeMode}:${topic}:${currentModel}:${schemaVersion}:${promptSha}`;
        const baseTextId = sha256Hex(idSource).slice(0, 16);
        const withId = { ...parsed, id: baseTextId, language: languageName, level, challengeMode, topic };
        const meta = { language: languageName, level, challengeMode, topic, model: currentModel, schemaVersion, promptSha, promptSha12, baseTextId };
        const cap = Number(process.env.CACHE_BASE_TEXTS_MAX || 500);
        await setBaseText(cacheLayout, baseKey, meta, withId, cap);
        return res.json({ ...withId, _cacheKey: baseKey });
      } catch (e) {
        return res.json(parsed);
      }
    }

    // If this is an exercise request, try persistent cache first with per-user unseen selection
    if (cacheLayout && type && type !== 'explanation' && type !== 'unknown') {
      const poolKey = `${type}:${languageName}:${level}:${challengeMode}:${currentModel}:${schemaVersion}:${promptSha12}`;
      const bucketKey = makeBucketKey({ type, language: languageName, level, challengeMode, grammarTopic });
      // Parse desired count if present (supports prompt text, JSON payloads, and metadata)
      let desiredCount = 1;
      if (metadata && typeof metadata.count === 'number' && Number.isFinite(metadata.count)) {
        desiredCount = Math.max(1, Math.min(50, Math.floor(metadata.count)));
      }
      const countMatch = user.match(/Create exactly\s+(\d+)\b/i);
      if (countMatch) desiredCount = Math.max(1, Math.min(50, Number(countMatch[1])));
      try {
        const parsedUser = JSON.parse(user);
        if (parsedUser && typeof parsedUser.count === 'number') {
          desiredCount = Math.max(1, Math.min(50, Number(parsedUser.count)));
        }
      } catch {}
      // For cloze and cloze_mixed single schema, clamp to 1
      if (type === 'cloze' || type === 'cloze_mixed') desiredCount = 1;

      // Parse seen cookie
      const cookieHeader = String(req.headers['cookie'] || '');
      const cookieName = `seen_${req.cacheNamespace.slice(0, 12)}_${type}_v${schemaVersion}`;
      const seenCookieMatch = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
      const seenList = seenCookieMatch ? safeDecodeCookie(seenCookieMatch[1]).split(',').filter(Boolean) : [];
      const seenSet = new Set(seenList);

      const useGrouped = type === 'fib' || type === 'mcq' || type === 'error_bundle' || type === 'rewriting';

      // Special-case: For reading requests tied to a specific base text, if an item for this
      // base text already exists for the same topic/language/level/challenge combo, return it
      // instead of generating a new one (ignore seen to prevent duplicates per base text).
      if (type === 'reading' && metadata && typeof metadata.baseTextId === 'string' && metadata.baseTextId.trim()) {
        try {
          const exIdx = await loadExercisesIndex(cacheLayout);
          let foundSha = null;
          for (const [sha, entry] of Object.entries(exIdx.items || {})) {
            if (!entry) continue;
            if (entry.type !== 'reading') continue;
            const m = entry.meta || {};
            if (
              (m.language === languageName) &&
              (m.level === level) &&
              (Boolean(m.challengeMode) === Boolean(challengeMode)) &&
              (m.grammarTopic === grammarTopic) &&
              (m.baseTextId === metadata.baseTextId)
            ) {
              foundSha = sha; break;
            }
          }
          if (foundSha) {
            const rec = await readExerciseItem(cacheLayout, foundSha);
            if (rec && rec.content) {
              // Update seen cookie with this sha prefix so weighting logic remains consistent
              try {
                const cookieName = `seen_${req.cacheNamespace.slice(0, 12)}_${type}_v${schemaVersion}`;
                const prefixes = [String(foundSha).slice(0, 12)];
                const cookieHeader = String(req.headers['cookie'] || '');
                const seenCookieMatch = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
                const seenList = seenCookieMatch ? safeDecodeCookie(seenCookieMatch[1]).split(',').filter(Boolean) : [];
                const maxSeen = Number(process.env.COOKIE_MAX_SEEN_PER_TYPE || 50);
                const merged = Array.from(new Set([...seenList, ...prefixes])).slice(-maxSeen);
                const cookieVal = encodeURIComponent(merged.join(','));
                res.append('Set-Cookie', `${cookieName}=${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${production && auth.mode !== 'local' ? "; Secure" : ""}`);
              } catch {}
              return res.json({ items: [{ ...rec.content, exerciseSha: foundSha }] });
            }
          }
        } catch {}
      }
      // Build a cross-model family key so we include other-model pools too
      const family = { type, language: languageName, level, challengeMode, schemaVersion, promptSha12 };
      const { items: cachedItems, shas: cachedShas } = useGrouped
        ? await selectUnseenCrossModelGrouped(cacheLayout, family, seenSet, desiredCount, currentModel, grammarTopic)
        : await selectUnseenCrossModel(cacheLayout, family, seenSet, desiredCount, currentModel, grammarTopic);
      // Build initial results from cache
      let resultPairs = cachedItems.map((r, idx) => {
        const it = { ...r.content };
        if (r.localImageUrl) it.localImageUrl = r.localImageUrl;
        if (r.groupId) it.exerciseGroupId = r.groupId;
        if (r.meta && r.meta.baseTextId) it.baseTextId = r.meta.baseTextId;
        if (r.meta && r.meta.baseTextChapter !== undefined) it.baseTextChapter = r.meta.baseTextChapter;
        return { item: it, sha: cachedShas[idx] };
      });

      // MCQ: dedupe option texts in cached items before deciding shortfall
      if (type === 'mcq') {
        resultPairs = resultPairs.map(({ item, sha }) => {
          const { item: fixed, valid } = dedupeMcqItemOptions(item);
          return valid ? { item: fixed, sha } : null;
        }).filter(Boolean);
      }

      let resultItems = resultPairs.map(p => p.item);
      let resultShas = resultPairs.map(p => p.sha);

      // If not enough, call LLM for the shortfall
      if (resultItems.length < desiredCount) {
        const need = desiredCount - resultItems.length;
        const text = await generateForRequest(req, { system, user, jsonSchema, schemaName });
        const parsed = parseGenerated(text);
        let generated = Array.isArray(parsed?.items) ? parsed.items : [];
        if (!generated.length || generated.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw Object.assign(new Error('ChatGPT returned no valid exercises. Please try again.'), { status: 502, code: 'invalid_output' });
        // MCQ: dedupe option texts in newly generated items; drop invalid ones (< 2 distinct options)
        if (type === 'mcq') {
          generated = generated.map(it => {
            const { item: fixed, valid } = dedupeMcqItemOptions(it);
            return valid ? fixed : null;
          }).filter(Boolean);
        }
        const toAdd = generated.slice(0, need);
        const baseLimit = Number(process.env.CACHE_EXERCISES_PER_TYPE_MAX || 100);
        const factor = (() => {
          switch (type) {
            case 'fib': return Number(process.env.CACHE_PER_TYPE_FACTOR_FIB || 10);
            case 'mcq': return Number(process.env.CACHE_PER_TYPE_FACTOR_MCQ || 5);
            case 'reading': return Number(process.env.CACHE_PER_TYPE_FACTOR_READING || 2);
            case 'error_bundle': return Number(process.env.CACHE_PER_TYPE_FACTOR_ERROR_BUNDLE || 5);
            case 'rewriting': return Number(process.env.CACHE_PER_TYPE_FACTOR_REWRITING || 8);
            default: return 1;
          }
        })();
        const perTypeLimit = Math.max(baseLimit, Math.floor(baseLimit * (Number.isFinite(factor) && factor > 0 ? factor : 1)));
        const { addedShas, groupId } = await addExercisesToPool(cacheLayout, { type, poolKey, bucketKey, language: languageName, level, challengeMode, grammarTopic, model: currentModel, schemaVersion, baseTextId: metadata?.baseTextId, baseTextChapter: metadata?.baseTextChapter }, toAdd, perTypeLimit);
        // Attach groupId to items so frontend can rate the batch
        resultItems = resultItems.concat(toAdd.map(it => ({ ...it, exerciseGroupId: groupId, ...(metadata?.baseTextId ? { baseTextId: metadata.baseTextId } : {}), ...(metadata?.baseTextChapter !== undefined ? { baseTextChapter: metadata.baseTextChapter } : {}) })));
        resultShas = resultShas.concat(addedShas);
      }

      // Update seen cookie with 12-char prefixes
      try {
        const prefixes = resultShas.map(s => String(s).slice(0, 12));
        const maxSeen = Number(process.env.COOKIE_MAX_SEEN_PER_TYPE || 50);
        const merged = Array.from(new Set([...seenList, ...prefixes])).slice(-maxSeen);
        const cookieVal = encodeURIComponent(merged.join(','));
        res.append('Set-Cookie', `${cookieName}=${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${production && auth.mode !== 'local' ? "; Secure" : ""}`);
      } catch {}

      const itemsWithIds = resultItems.map((it, i) => ({ ...it, exerciseSha: resultShas[i] }));
      // Increment hits for analytics
      try { await incrementExerciseHits(cacheLayout, type, languageName, level, challengeMode, grammarTopic, itemsWithIds.length); } catch {}
      return res.json({ items: itemsWithIds });
    }

    // Persistent cache for explanations (model + schemaVersion + promptSha)
    const isExplanation = schemaName === 'explanation';
    let explanationPersistentKey = null;
    if (isExplanation && cacheLayout) {
      const currentModel = await inference.getModel(req);
      const topicMatch = user.match(/Explain the grammar concept:\s*([^\.\n]+)/i);
      const languageName = metadata?.language || (user.match(/Target Language:\s*([^\n]+)/i)?.[1]?.trim() || 'unknown');
      const levelRaw = metadata?.level || (user.match(/Target Level:\s*([^\n]+)/i)?.[1]?.trim() || '');
      const challengeMode = typeof metadata?.challengeMode === 'boolean' ? metadata.challengeMode : /slightly challenging/i.test(levelRaw);
      const level = String(levelRaw).replace(/\(slightly challenging\)/i, '').trim() || 'unknown';
      const grammarConcept = (metadata?.topic || (topicMatch ? topicMatch[1].trim() : '') || 'unknown');
      const schemaVersion = schemaVersions.explanation || 1;
      const promptSha = sha256Hex(`${system || ''}\n${user}\n${schemaName}\n${languageName}:${level}:${challengeMode}`);
      const promptSha12 = promptSha.slice(0, 12);
      explanationPersistentKey = `exp:${languageName}:${level}:${challengeMode}:${grammarConcept}:${currentModel}:${schemaVersion}:${promptSha12}`;
      const rec = await getExplanation(cacheLayout, explanationPersistentKey);
      if (rec && rec.content) {
        const withKey = { ...rec.content, _cacheKey: explanationPersistentKey };
        return res.json(withKey);
      }
    }
    const text = await generateForRequest(req, { 
      system, 
      user, 
      jsonSchema, 
      schemaName 
    });
    
    let parsed;
    try {
      parsed = parseGenerated(text);
    } catch (e) {
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: 'chatgpt' });
    }
    
    // Persistent cache write for explanations
    if (isExplanation && explanationPersistentKey && parsed && cacheLayout) {
      try {
        const currentModel = await inference.getModel(req);
        const topicMatch = user.match(/Explain the grammar concept:\s*([^\.\n]+)/i);
        const languageName = metadata?.language || (user.match(/Target Language:\s*([^\n]+)/i)?.[1]?.trim() || 'unknown');
        const levelRaw = metadata?.level || (user.match(/Target Level:\s*([^\n]+)/i)?.[1]?.trim() || '');
        const challengeMode = typeof metadata?.challengeMode === 'boolean' ? metadata.challengeMode : /slightly challenging/i.test(levelRaw);
        const level = String(levelRaw).replace(/\(slightly challenging\)/i, '').trim() || 'unknown';
        const grammarConcept = (metadata?.topic || (topicMatch ? topicMatch[1].trim() : '') || 'unknown');
        const schemaVersion = schemaVersions.explanation || 1;
        const promptSha = sha256Hex(`${system || ''}\n${user}\n${schemaName}\n${languageName}:${level}:${challengeMode}`);
        const promptSha12 = promptSha.slice(0, 12);
        const meta = { language: languageName, level, challengeMode, grammarConcept, model: currentModel, schemaVersion, promptSha, promptSha12 };
        const cap = Number(process.env.CACHE_EXPLANATIONS_MAX || 1000);
        await setExplanation(cacheLayout, explanationPersistentKey, meta, parsed, cap);
      } catch (e) {
      }
    }
    
    if (isExplanation && explanationPersistentKey) {
      const withKey = { ...parsed, _cacheKey: explanationPersistentKey };
      return res.json(withKey);
    }
    // Fallback path (no persistent cache or not an explanation): apply MCQ dedupe if applicable
    if (type === 'mcq' && parsed && Array.isArray(parsed.items)) {
      const deduped = parsed.items.map(it => {
        const { item: fixed, valid } = dedupeMcqItemOptions(it);
        return valid ? fixed : null;
      }).filter(Boolean);
      parsed.items = deduped;
    }
    return res.json(parsed);
  } catch (err) {
    const status = errorStatus(err);
    return res.status(status).json({ error: 'Failed to generate content', details: safeMessage(err), provider: 'chatgpt', code: err.code });
  }
});

app.post('/api/base-text', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { topic: userTopic, language = 'es', level = 'B1', challengeMode = false, excludeIds = [], focus } = req.body || {};
    if ((userTopic != null && (typeof userTopic !== 'string' || userTopic.length > 2000)) || typeof language !== 'string' || language.length > 100 || typeof level !== 'string' || level.length > 30 || !Array.isArray(excludeIds) || excludeIds.length > 100) return res.status(400).json({ error: 'Invalid base text request' });
    
    // Use topic roulette instead of user grammar topic for base text generation
    const topicSuggestion = pickRandomTopicSuggestion({ ensureNotEqualTo: userTopic });
    const topic = topicSuggestion?.topic || 'daily life';
    
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'topic generation failed' });

    const currentModel = await inference.getModel(req);
    const schemaVersion = schemaVersions.base_text || 1;

    // Try to find existing base texts using suitability matrix - topic-agnostic selection
    // This allows reusing any suitable base text regardless of original topic
    const idx = await loadBaseTextsIndex(cacheLayout);
    // Build a set of baseTextIds that already have a reading exercise for this topic+language+level+challenge
    // This helps us avoid picking a base text that already has a reading, so we don't create duplicates
    // when a new reading must be generated.
    let usedReadingBaseTextIds = new Set();
    try {
      const exIdx = await loadExercisesIndex(cacheLayout);
      for (const entry of Object.values(exIdx.items || {})) {
        const m = entry?.meta || {};
        if (
          entry?.type === 'reading' &&
          m.language === language &&
          m.level === level &&
          Boolean(m.challengeMode) === Boolean(challengeMode) &&
          String(m.grammarTopic || '') === String(userTopic || '') &&
          typeof m.baseTextId === 'string' && m.baseTextId.trim()
        ) {
          usedReadingBaseTextIds.add(m.baseTextId);
        }
      }
    } catch {}
    const excludeSet = new Set((Array.isArray(excludeIds) ? excludeIds : []).map(id => String(id)));
    const suitableCandidates = [];
    
    for (const [key, entry] of Object.entries(idx.items || {})) {
      const m = entry?.meta || {};
      // Match by language and schema version only (topic-agnostic for reusability)
      if (m.language === language && Number(m.schemaVersion) === Number(schemaVersion)) {
        const rec = await getBaseText(cacheLayout, key);
        const id = rec?.content?.id || rec?.content?.baseTextId || m.baseTextId;
        if (!id || excludeSet.has(id)) continue; // Respect exclusions to prevent spoilers
        
        // Check suitability using the new matrix logic
        const suitabilityCheck = checkTextSuitability(rec?.content, level, challengeMode);
        if (suitabilityCheck.suitable) {
          suitableCandidates.push({
            content: rec.content,
            priority: suitabilityCheck.priority,
            reason: suitabilityCheck.reason,
            originalTopic: m.topic // Keep track of original topic for debugging
          });
        }
      }
    }
    
    if (suitableCandidates.length > 0) {
      // Prefer base texts that haven't been used for a reading at this topic/difficulty
      const unusedPreferred = suitableCandidates.filter(c => !usedReadingBaseTextIds.has(c.content?.id));
      const pickFrom = unusedPreferred.length > 0 ? unusedPreferred : suitableCandidates;
      // Randomize selection with weighting by priority so we don't always reuse the same text
      const weights = pickFrom.map(c => Math.max(1, Number(c.priority || 1)));
      const total = weights.reduce((a, b) => a + b, 0) || pickFrom.length;
      let r = Math.random() * total;
      let chosenIdx = 0;
      for (let i = 0; i < pickFrom.length; i++) {
        r -= (weights[i] || 1);
        if (r <= 0) { chosenIdx = i; break; }
        if (i === pickFrom.length - 1) chosenIdx = i;
      }
      return res.json(pickFrom[chosenIdx].content);
    }

    // Otherwise, generate a new one via /api/generate with schemaName base_text
    const baseSystem = BASE_TEXT_SYSTEM_PROMPT;
    const baseUser = generateBaseTextUserPrompt(topic, language, level, challengeMode, focus);
    const baseSchema = BASE_TEXT_SCHEMA;
    const text = await generateForRequest(req, { system: baseSystem, user: baseUser, jsonSchema: baseSchema, schemaName: 'base_text' });
    let parsed;
    try {
      parsed = parseGenerated(text);
    } catch (e) {
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: 'chatgpt' });
    }
    // Persist with deterministic id and source metadata
    const promptSha = sha256Hex(`${baseSystem}\n${baseUser}\nbase_text\n${language}:${level}:${challengeMode}`);
    const promptSha12 = promptSha.slice(0, 12);
    const baseKey = `base:${language}:${level}:${challengeMode}:${topic}:${currentModel}:${schemaVersion}:${promptSha12}`;
    const idSource = `${language}:${level}:${challengeMode}:${topic}:${currentModel}:${schemaVersion}:${promptSha}`;
    const baseTextId = sha256Hex(idSource).slice(0, 16);
    const withSourceMeta = addSourceMetadata(parsed, currentModel);
    const withId = { ...withSourceMeta, id: baseTextId, language, level, challengeMode, topic };
    // Initialize images container on base text for later association
    withId.images = withId.images && typeof withId.images === 'object' ? withId.images : { cover: null, chapters: {} };
    
    // Calculate and store suitability matrix in metadata for efficient lookups
    const suitability = calculateTextSuitability(withId.chapters || []);
    const meta = { 
      language, 
      level, 
      challengeMode, 
      topic, 
      model: currentModel, 
      schemaVersion, 
      promptSha, 
      promptSha12, 
      baseTextId,
      suitability // Store calculated suitability for efficient filtering
    };
    
    const cap = Number(process.env.CACHE_BASE_TEXTS_MAX || 500);
    await setBaseText(cacheLayout, baseKey, meta, withId, cap);
    return res.json(withId);
  } catch (e) {
    return res.status(errorStatus(e)).json({ error: safeMessage(e), code: e.code });
  }
});

app.post('/api/explain', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    const { topic, exercise, userAnswer } = req.body || {};
    if (!exercise?.sentence) return res.status(400).json({ error: 'exercise is required' });
    const system = `You are a language tutor. Provide clear, helpful explanations for exercise mistakes using markdown formatting.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        explanation: { type: 'string', description: 'Detailed explanation in markdown format' }
      },
      required: ['explanation']
    };
    const user = `Language learning exercise explanation needed:

Topic: ${topic}
Exercise: ${exercise.sentence}
Correct answer(s): ${exercise.answer}
User's answer(s): ${userAnswer}

Please explain:
1. Why "${exercise.answer}" is correct
2. If the user's answer is wrong, why it doesn't work
3. Grammar rule or concept involved
4. Tips to remember this

Use markdown formatting for clarity (bold for **important terms**, code blocks for conjugations, ### for headers, etc.).`;
    const text = await generateForRequest(req, { system, user, jsonSchema: schema, schemaName: 'explanation' });
    const parsed = parseGenerated(text);
    return res.json({ explanation: parsed.explanation });
  } catch (err) {
    const status = errorStatus(err);
    return res.status(status).json({ error: 'Failed to get explanation', details: safeMessage(err), provider: 'chatgpt', code: err.code });
  }
});

// Ratings: explanations and exercise groups
app.post('/api/rate/explanation', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { key, like } = req.body || {};
    if (typeof key !== 'string' || !key.startsWith('exp:')) return res.status(400).json({ error: 'Invalid explanation key' });
    const ok = await rateExplanation(cacheLayout, key, like !== false);
    if (!ok) return res.status(404).json({ error: 'Explanation not found' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: safeMessage(e) });
  }
});

app.post('/api/rate/exercise-group', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { groupId, like } = req.body || {};
    if (typeof groupId !== 'string' || !/^[a-f0-9]{8,32}$/i.test(groupId)) return res.status(400).json({ error: 'Invalid groupId' });
    const ok = await rateExerciseGroup(cacheLayout, groupId, like !== false);
    if (!ok) return res.status(404).json({ error: 'Group not found' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: safeMessage(e) });
  }
});

app.post('/api/recommend', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    const { topic, score, percentage, wrongExercises } = req.body || {};
    const system = `You are a language learning advisor. Analyze user performance and recommend the next optimal practice topic.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        recommendation: { type: 'string', description: 'Specific topic to practice next' },
        reasoning: { type: 'string', description: 'Brief explanation of why this topic would help' }
      },
      required: ['recommendation', 'reasoning']
    };
    const user = `Analyze the user's practice results and suggest a next topic:

Current topic: ${topic}
Score: ${score?.correct}/${score?.total} (${Number(percentage).toFixed(1)}%)
Wrong answers: ${JSON.stringify(wrongExercises)}

Based on their performance, suggest ONE specific practice topic. Consider:
- If score > 80%: suggest a more advanced related topic
- If score 60-80%: suggest focused practice on their weak areas
- If score < 60%: suggest an easier or more fundamental topic`;
    const text = await generateForRequest(req, { system, user, jsonSchema: schema, schemaName: 'recommendation' });
    let parsed;
    try {
      parsed = parseGenerated(text);
    } catch (e) {
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: 'chatgpt' });
    }
    return res.json(parsed);
  } catch (err) {
    const status = errorStatus(err);
    return res.status(status).json({ error: 'Failed to get recommendation', details: safeMessage(err), provider: 'chatgpt', code: err.code });
  }
});

// Persist a fully assembled exercise from the client (used by stepwise pipelines)
app.post('/api/persist-exercise', async (req, res) => {
  const cacheLayout = req.cacheLayout;
  try {
    const body = req.body || {};
    const type = String(body.type || 'unified_cloze');
    if (!['fib', 'mcq', 'cloze', 'cloze_mixed', 'unified_cloze', 'writing_prompts', 'guided_dialogues', 'reading', 'error_bundle', 'rewriting'].includes(type)) return res.status(400).json({ error: 'Invalid exercise type' });
    const items = Array.isArray(body.items) ? body.items : [];
    const languageName = String(body.metadata?.language || 'unknown');
    const level = String(body.metadata?.level || 'unknown');
    const challengeMode = !!body.metadata?.challengeMode;
    const grammarTopic = String(body.metadata?.topic || 'unknown');

    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    if (items.length > 50 || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return res.status(400).json({ error: 'Invalid exercises' });
    if (items.length === 0) return res.status(400).json({ error: 'No items to persist' });

    const currentModel = await inference.getModel(req);
    const schemaVersion = schemaVersions[type] || 1;
    const poolKey = `persist:${type}:${languageName}:${level}:${challengeMode ? '1' : '0'}:${currentModel}:${schemaVersion}:${grammarTopic}`;
    const bucketKey = makeBucketKey({ type, language: languageName, level, challengeMode, grammarTopic });

    const baseTextId = items[0]?.base_text_id || null;
    const baseTextChapter = items[0]?.chapter_number ?? undefined;

    const { addedShas, groupId } = await addExercisesToPool(
      cacheLayout,
      { type, poolKey, bucketKey, language: languageName, level, challengeMode, grammarTopic, model: currentModel, schemaVersion, baseTextId, baseTextChapter },
      items,
      Number(process.env.CACHE_EXERCISES_MAX || 1000)
    );

    const withIds = items.map((it, i) => ({ ...it, exerciseSha: addedShas[i] }));
    try { await incrementExerciseHits(cacheLayout, type, languageName, level, challengeMode, grammarTopic, withIds.length); } catch {}
    res.json({ items: withIds, groupId });
  } catch (e) {
    res.status(errorStatus(e)).json({ error: 'Failed to persist exercise', details: safeMessage(e), code: e.code });
  }
});


  app.post('/api/explanations/stream', async (req, res) => {
    let keepAlive;
    const sse = payload => { if (!res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
    try {
      const { topic, language = 'es', level = 'B1', challengeMode = false } = req.body || {};
      if (typeof topic !== 'string' || !topic.trim() || topic.length > 2000 || typeof language !== 'string' || language.length > 100 || typeof level !== 'string' || level.length > 30) return res.status(400).json({ error: 'Provide a topic, language and level.' });
      const currentModel = await inference.getModel(req);
      const system = 'You are a language pedagogy expert. Explain the requested grammar concept in the target language at the target level, in 200–600 words. Use examples, useful headings, common mistakes and brief translations where helpful. Start with a markdown title heading. Return only the lesson.';
      const user = `Concept: ${topic.trim()}\nTarget Language: ${language}\nTarget Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}`;
      const key = `exp:${language}:${level}:${!!challengeMode}:${topic.trim()}:${currentModel}:${schemaVersions.explanation}:${sha256Hex(system + user).slice(0, 12)}`;
      const cached = await getExplanation(req.cacheLayout, key);
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      if (cached?.content) {
        const explanation = { ...cached.content, _cacheKey: key };
        sse({ type: 'prefill', explanation });
        sse({ type: 'final', explanation });
        return res.end();
      }
      keepAlive = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15_000);
      keepAlive.unref?.();
      const content = await generateForRequest(req, { system, user, onDelta: text => sse({ type: 'delta', text }) });
      if (req.inferenceSignal.aborted) return res.end();
      const heading = content.match(/^\s*#{1,3}\s+([^\n]+)/);
      const explanation = { title: heading?.[1]?.trim() || topic.trim(), content_markdown: content.replace(/^\s*#{1,3}\s+[^\n]+\r?\n?/, '').trim() };
      if (!explanation.content_markdown) throw Object.assign(new Error('ChatGPT returned an empty explanation. Please try again.'), { status: 502, code: 'empty_response' });
      await setExplanation(req.cacheLayout, key, { language, level, challengeMode: !!challengeMode, grammarConcept: topic.trim(), model: currentModel, schemaVersion: schemaVersions.explanation }, explanation);
      sse({ type: 'final', explanation: { ...explanation, _cacheKey: key } });
      res.end();
    } catch (error) {
      if (!res.headersSent) return res.status(errorStatus(error)).json({ error: safeMessage(error), code: error.code });
      sse({ type: 'error', error: safeMessage(error), message: safeMessage(error), code: error.code, status: errorStatus(error) });
      res.end();
    } finally { clearInterval(keepAlive); }
  });

  app.get('/api/base-text-content/:baseTextId', async (req, res) => {
    if (!/^[a-f0-9]{16}$/.test(req.params.baseTextId)) return res.status(400).json({ error: 'Invalid base text ID' });
    const index = await loadBaseTextsIndex(req.cacheLayout);
    for (const [key, entry] of Object.entries(index.items || {})) {
      if (entry.meta?.baseTextId !== req.params.baseTextId) continue;
      const record = await getBaseText(req.cacheLayout, key);
      if (record?.content) return res.json(record.content);
    }
    return res.status(404).json({ error: 'Base text not found' });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use('/cache', (req, res) => res.status(404).json({ error: 'Not found' }));
  if (production) {
    // Apply before both assets and the SPA fallback, which read from disk.
    app.use(ipRateLimiter(frontendRateLimitMax, 'Too many page requests. Please try again shortly.'));
    app.use(express.static(distDir, { dotfiles: 'deny' }));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return res.end();
    const status = error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && error.status === 400 ? 400 : errorStatus(error);
    res.status(status).json({ error: status === 400 ? 'Invalid request.' : status === 413 ? 'The request is too large.' : safeMessage(error), ...(typeof error.code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(error.code) ? { code: error.code } : {}) });
  });
  return app;
}
