import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function cleanFence(text) {
  return String(text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

function tryParseJsonLoose(raw) {
  if (!raw) throw new Error('Empty response');
  let txt = cleanFence(raw);
  // Try direct
  try { return JSON.parse(txt); } catch {}
  // Slice between first { and last }
  const first = txt.indexOf('{');
  const last = txt.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const sliced = txt.slice(first, last + 1);
    try { return JSON.parse(sliced); } catch {}
    // Remove trailing commas
    const noTrailing = sliced.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(noTrailing); } catch {}
  }
  // Last attempt: strip control chars
  const stripped = txt.replace(/[\u0000-\u001F]+/g, '');
  try { return JSON.parse(stripped); } catch (e) {
    const preview = stripped.slice(0, 500);
    const err = new Error(`Model returned invalid JSON: ${e.message}`);
    err.rawPreview = preview;
    throw err;
  }
}

// Provider selection via env (initial default)
// One of: openrouter | ollama
const INITIAL_PROVIDER = (process.env.PROVIDER || 'openrouter').toLowerCase();

// Default models per provider
const DEFAULT_MODELS = {
  openrouter: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
  ollama: process.env.OLLAMA_MODEL || 'qwen2.5:14b'
};

// Runtime-configurable settings (overrides env without server restart)
const runtimeConfig = {
  provider: INITIAL_PROVIDER,
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: DEFAULT_MODELS.openrouter,
    appUrl: process.env.APP_URL || 'Language AI App'
  },
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: DEFAULT_MODELS.ollama
  },
  // Centralized max token cap for all generations
  maxTokens: Number(process.env.MAX_TOKENS || 15000)
};

// Basic request logging
app.use((req, res, next) => {
  const start = Date.now();
  const id = Math.random().toString(36).slice(2, 8);
  console.log(`[REQ ${id}] ${req.method} ${req.path}`);
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[RES ${id}] ${res.statusCode} ${ms}ms`);
  });
  next();
});

function assertEnv(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// LRU Cache implementation for explanations
class LRUCache {
  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  get(key) {
    if (this.cache.has(key)) {
      // Move to end (mark as recently used)
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    return undefined;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      // Update existing key
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Remove least recently used item (first item in Map)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }

  stats() {
    return {
      size: this.cache.size,
      capacity: this.capacity,
      utilizationPercent: Math.round((this.cache.size / this.capacity) * 100)
    };
  }
}

// Create explanation cache instance
const explanationCache = new LRUCache(1000);

async function callLLM({ system, user, maxTokens, jsonSchema, schemaName }) {
  // Enforce application-level token cap regardless of caller
  maxTokens = runtimeConfig.maxTokens;
  const provider = runtimeConfig.provider;
  const startedAt = Date.now();
  const logPrefix = `[LLM ${provider}]`;
  const preview = String(user || '').slice(0, 160).replace(/\s+/g, ' ');
  console.log(`${logPrefix} model=${
    provider === 'openrouter' ? runtimeConfig.openrouter.model :
    runtimeConfig.ollama.model
  } maxTokens=${maxTokens} promptPreview="${preview}..." structured=${jsonSchema ? 'yes' : 'no'}`);
  if (provider === 'openrouter') {
    assertEnv(runtimeConfig.openrouter.apiKey, 'Missing OPENROUTER_API_KEY');
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${runtimeConfig.openrouter.apiKey}`,
        'http-referer': runtimeConfig.openrouter.appUrl || 'http://localhost:5173',
        'x-title': 'Language AI App'
      },
      body: JSON.stringify({
        model: runtimeConfig.openrouter.model,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user }
        ].filter(Boolean),
        max_tokens: maxTokens,
        reasoning: {
          exclude: true
        },


        ...(jsonSchema ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: schemaName || 'structured_output',
              strict: true,
              schema: jsonSchema
            }
          }
        } : {})
      })
    });
    if (!resp.ok) {
      console.error(`${logPrefix} HTTP ${resp.status}`);
      if (resp.status === 429) {
        try {
          const info = await getOpenRouterKeyInfo();
          console.warn(`${logPrefix} 429 rate-limited. usage=${info?.data?.usage} limit=${info?.data?.limit} freeTier=${info?.data?.is_free_tier}`);
        } catch (e) {
          console.warn(`${logPrefix} 429 and failed to fetch key info: ${e?.message}`);
        }
      }
      throw new Error(`OpenRouter error ${resp.status}`);
    }
    const data = await resp.json();
    const responseTime = Date.now() - startedAt;
    
    // Log token usage and attempt to get cost info
    const usage = data.usage || {};
    const generationId = data.id;
    console.log(`${logPrefix} ok in ${responseTime}ms | tokens: ${usage.prompt_tokens || 0}→${usage.completion_tokens || 0} (${usage.total_tokens || 0} total)${generationId ? ` | id: ${generationId}` : ''}`);
    
    // Fetch detailed cost information asynchronously (non-blocking)
    if (generationId) {
      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 500)); // Longer delay to allow generation to be processed
          const costResp = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
            headers: { authorization: `Bearer ${runtimeConfig.openrouter.apiKey}` }
          });
          if (costResp.ok) {
            const costData = await costResp.json();
            if (costData.data && typeof costData.data.total_cost === 'number') {
              console.log(`${logPrefix} cost: $${Number(costData.data.total_cost).toFixed(6)} | native tokens: ${costData.data.tokens_prompt || 0}→${costData.data.tokens_completion || 0} | provider: ${costData.data.provider_name || 'unknown'}`);
            }
          }
          // Note: Cost data may not be immediately available for all models (especially free tiers)
        } catch (e) {
          // Silently ignore cost fetch errors to avoid disrupting the main flow
        }
      })();
    }
    
    return data.choices?.[0]?.message?.content || '';
  }
  if (provider === 'ollama') {
    const host = runtimeConfig.ollama.host || 'http://127.0.0.1:11434';
    const resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: runtimeConfig.ollama.model,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user }
        ].filter(Boolean),
        stream: false,
        ...(jsonSchema ? { format: jsonSchema } : {})
      })
    });
    if (!resp.ok) {
      console.error(`${logPrefix} HTTP ${resp.status}`);
      throw new Error(`Ollama error ${resp.status}`);
    }
    const data = await resp.json();
    console.log(`${logPrefix} ok in ${Date.now() - startedAt}ms`);
    return data.message?.content || data.response || '';
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function getOpenRouterKeyInfo() {
  const key = runtimeConfig.openrouter.apiKey;
  if (!key) throw new Error('Missing OPENROUTER_API_KEY');
  const resp = await fetch('https://openrouter.ai/api/v1/key', {
    method: 'GET',
    headers: { authorization: `Bearer ${key}` }
  });
  if (!resp.ok) throw new Error(`Key endpoint error ${resp.status}`);
  return resp.json();
}

// Attempt to recover from truncated JSON that should be { items: [...] }
function recoverItemsFromPartialJson(raw) {
  try {
    const txt = cleanFence(raw);
    const itemsKeyIdx = txt.search(/"items"\s*:\s*\[|items\s*:\s*\[/);
    if (itemsKeyIdx === -1) return null;
    const bracketStart = txt.indexOf('[', itemsKeyIdx);
    if (bracketStart === -1) return null;
    const items = [];
    let i = bracketStart + 1;
    const len = txt.length;
    while (i < len) {
      // Skip whitespace and commas
      while (i < len && /[\s,]/.test(txt[i])) i++;
      if (i >= len) break;
      if (txt[i] === ']') break; // end of array
      if (txt[i] !== '{') { i++; continue; }
      const startObj = i;
      let depth = 0;
      let inStr = false;
      let esc = false;
      while (i < len) {
        const ch = txt[i];
        if (inStr) {
          if (esc) {
            esc = false;
          } else if (ch === '\\') {
            esc = true;
          } else if (ch === '"') {
            inStr = false;
          }
        } else {
          if (ch === '"') {
            inStr = true;
          } else if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const objText = txt.slice(startObj, i + 1);
              const cleaned = objText.replace(/,(\s*[}\]])/g, '$1');
              try {
                items.push(JSON.parse(cleaned));
              } catch (_) {
                // Ignore malformed object
              }
              i++;
              break;
            }
          }
        }
        i++;
      }
      // If we exited because of truncation (unclosed object/string), stop without adding
      if (inStr || depth > 0) break;
    }
    if (items.length > 0) return { items };
    return null;
  } catch {
    return null;
  }
}

// Generic LLM generation endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const { system, user, jsonSchema, schemaName } = req.body || {};
    if (!user || !String(user).trim()) return res.status(400).json({ error: 'User prompt is required' });
    
    // Generate cache key for explanations
    const isExplanation = schemaName === 'explanation';
    let cacheKey = null;
    if (isExplanation) {
      const currentModel = runtimeConfig.provider === 'openrouter' 
        ? runtimeConfig.openrouter.model 
        : runtimeConfig.ollama.model;
      
      // Extract topic from user prompt (assuming format "Explain the grammar concept: TOPIC. Language...")
      const topicMatch = user.match(/Explain the grammar concept:\s*([^.]+)/i);
      if (topicMatch) {
        const topic = topicMatch[1].trim();
        cacheKey = `${topic}:${currentModel}`;
        
        // Check cache first
        const cached = explanationCache.get(cacheKey);
        if (cached) {
          console.log(`[CACHE HIT] explanation for topic="${topic}" model="${currentModel}"`);
          return res.json(cached);
        }
      }
    }
    
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ 
      system, 
      user, 
      jsonSchema: useStructured ? jsonSchema : undefined, 
      schemaName 
    });
    
    let parsed;
    try {
      parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
    } catch (e) {
      // Attempt recovery for list payloads: salvage completed items and discard last partial
      const expectsItems = !!(jsonSchema && jsonSchema.properties && jsonSchema.properties.items);
      if (expectsItems) {
        const recovered = recoverItemsFromPartialJson(text);
        if (recovered && Array.isArray(recovered.items) && recovered.items.length > 0) {
          console.warn('[PARSE-RECOVER] Returning salvaged items from truncated JSON:', recovered.items.length);
          return res.json(recovered);
        }
      }
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    
    // Cache explanation responses
    if (isExplanation && cacheKey && parsed) {
      explanationCache.set(cacheKey, parsed);
      console.log(`[CACHE SET] explanation for topic="${cacheKey}" (cache size: ${explanationCache.size()}/${explanationCache.capacity})`);
    }
    
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate content', details: err?.message, provider: runtimeConfig.provider });
  }
});

// Routes
// Removed legacy /api/generate-exercises route in favor of component-driven generation via /api/generate

// On-demand: explanation only
// Removed legacy /api/generate/explanation route; frontend components call /api/generate directly

// On-demand: fill-in-blanks only
// Removed legacy /api/generate/fib route; frontend components call /api/generate directly

// On-demand: MCQ only
// Removed legacy /api/generate/mcq route; frontend components call /api/generate directly

// On-demand: Cloze passages only
// Removed legacy /api/generate/cloze route; frontend components call /api/generate directly

// On-demand: Cloze with mixed options
// Removed legacy /api/generate/cloze-mixed route; frontend components call /api/generate directly

// Removed legacy /api/generate-content route; lesson assembly is handled on the client by components

app.post('/api/explain', async (req, res) => {
  try {
    const { topic, exercise, userAnswer } = req.body || {};
    if (!exercise?.sentence) return res.status(400).json({ error: 'exercise is required' });
    const system = `You are a Spanish language tutor. Provide clear, helpful explanations for exercise mistakes using markdown formatting.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        explanation: { type: 'string', description: 'Detailed explanation in markdown format' }
      },
      required: ['explanation']
    };
    const user = `Spanish exercise explanation needed:

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
    
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, jsonSchema: useStructured ? schema : undefined, schemaName: 'explanation' });
    let parsed;
    if (useStructured) {
      try {
        parsed = JSON.parse(text);
        return res.json({ explanation: parsed.explanation });
      } catch (e) {
        console.error('[PARSE]', e.message);
        return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
      }
    } else {
      return res.json({ explanation: text });
    }
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to get explanation', details: err?.message, provider: runtimeConfig.provider });
  }
});

app.post('/api/recommend', async (req, res) => {
  try {
    const { topic, score, percentage, wrongExercises } = req.body || {};
    const system = `You are a Spanish language learning advisor. Analyze user performance and recommend the next optimal practice topic.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        recommendation: { type: 'string', description: 'Specific topic to practice next' },
        reasoning: { type: 'string', description: 'Brief explanation of why this topic would help' }
      },
      required: ['recommendation', 'reasoning']
    };
    const user = `Analyze the user's Spanish practice results and suggest a next topic:

Current topic: ${topic}
Score: ${score?.correct}/${score?.total} (${Number(percentage).toFixed(1)}%)
Wrong answers: ${JSON.stringify(wrongExercises)}

Based on their performance, suggest ONE specific practice topic. Consider:
- If score > 80%: suggest a more advanced related topic
- If score 60-80%: suggest focused practice on their weak areas
- If score < 60%: suggest an easier or more fundamental topic`;
    
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, jsonSchema: useStructured ? schema : undefined, schemaName: 'recommendation' });
    let parsed;
    try {
      parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
    } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to get recommendation', details: err?.message, provider: runtimeConfig.provider });
  }
});

// Ollama: list installed models
app.get('/api/ollama/models', async (req, res) => {
  try {
    const host = runtimeConfig.ollama.host || 'http://127.0.0.1:11434';
    const url = `${host.replace(/\/?$/, '')}/api/tags`;
    console.log(`[OLLAMA] Fetching models from ${url}`);
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[OLLAMA] HTTP ${resp.status} ${text}`);
      return res.status(502).json({ error: `Ollama returned ${resp.status}` });
    }
    const data = await resp.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    const names = models.map(m => m.name).filter(Boolean);
    return res.json({ host, models: names });
  } catch (e) {
    console.error('[OLLAMA] Failed to list models:', e);
    return res.status(500).json({ error: e.message || 'Failed to list Ollama models' });
  }
});

// Settings: get current runtime config (redacted)
app.get('/api/settings', (req, res) => {
  const sanitized = {
    provider: runtimeConfig.provider,
    openrouter: { model: runtimeConfig.openrouter.model, hasKey: !!runtimeConfig.openrouter.apiKey, appUrl: runtimeConfig.openrouter.appUrl },
    ollama: { model: runtimeConfig.ollama.model, host: runtimeConfig.ollama.host }
  };
  res.json(sanitized);
});

// Settings: update runtime config
app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  if (body.provider) runtimeConfig.provider = String(body.provider).toLowerCase();
  if (body.openrouter) {
    if (typeof body.openrouter.apiKey === 'string' && body.openrouter.apiKey.trim()) runtimeConfig.openrouter.apiKey = body.openrouter.apiKey;
    if (typeof body.openrouter.model === 'string') runtimeConfig.openrouter.model = body.openrouter.model;
    if (typeof body.openrouter.appUrl === 'string') runtimeConfig.openrouter.appUrl = body.openrouter.appUrl;
  }
  if (body.ollama) {
    if (typeof body.ollama.host === 'string') runtimeConfig.ollama.host = body.ollama.host;
    if (typeof body.ollama.model === 'string') runtimeConfig.ollama.model = body.ollama.model;
  }

  // Persist to .env
  (async () => {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const envPath = path.resolve(__dirname, '..', '.env');
      const existing = await fs.readFile(envPath, 'utf8').catch(() => '');
      const map = new Map();
      for (const line of existing.split(/\r?\n/)) {
        if (!line || line.trim().startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1);
        if (k) map.set(k, v);
      }
      const set = (k, v) => { if (typeof v === 'string') map.set(k, v); };
      set('PROVIDER', runtimeConfig.provider);
      set('OPENROUTER_API_KEY', runtimeConfig.openrouter.apiKey || map.get('OPENROUTER_API_KEY') || '');
      set('OPENROUTER_MODEL', runtimeConfig.openrouter.model);
      set('APP_URL', runtimeConfig.openrouter.appUrl);
      set('OLLAMA_HOST', runtimeConfig.ollama.host);
      set('OLLAMA_MODEL', runtimeConfig.ollama.model);
      const lines = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`);
      await fs.writeFile(envPath, lines.join('\n') + '\n', 'utf8');
      console.log('[SETTINGS] Persisted to .env at', envPath);
    } catch (e) {
      console.warn('[SETTINGS] Failed to persist .env:', e?.message);
    }
  })();

  console.log('[SETTINGS] Updated provider to', runtimeConfig.provider);
  return res.json({ ok: true, persisted: true });
});

// OpenRouter: rate limit / key info
app.get('/api/openrouter/rate-limit', async (req, res) => {
  try {
    const info = await getOpenRouterKeyInfo();
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// OpenRouter models cache (24 hour refresh)
let modelsCache = {
  data: null,
  lastFetch: 0,
  CACHE_DURATION: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
};

async function fetchOpenRouterModels() {
  const now = Date.now();
  if (modelsCache.data && (now - modelsCache.lastFetch) < modelsCache.CACHE_DURATION) {
    return modelsCache.data;
  }

  console.log('[MODELS] Fetching OpenRouter models...');
  const resp = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { authorization: `Bearer ${runtimeConfig.openrouter.apiKey}` }
  });
  
  if (!resp.ok) {
    throw new Error(`Models API error ${resp.status}`);
  }
  
  const data = await resp.json();
  modelsCache.data = data.data || [];
  modelsCache.lastFetch = now;
  console.log(`[MODELS] Cached ${modelsCache.data.length} models`);
  return modelsCache.data;
}

// OpenRouter: list models with filtering
app.get('/api/openrouter/models', async (req, res) => {
  try {
    assertEnv(runtimeConfig.openrouter.apiKey, 'Missing OPENROUTER_API_KEY');
    
    const models = await fetchOpenRouterModels();
    const { structured_only, free_only } = req.query;
    
    let filtered = models;
    
    // Filter for structured output support
    if (structured_only === 'true') {
      filtered = filtered.filter(model => 
        model.supported_parameters?.includes('structured_outputs') ||
        model.supported_parameters?.includes('response_format')
      );
    }
    
    // Filter for free models
    if (free_only === 'true') {
      filtered = filtered.filter(model => {
        const pricing = model.pricing || {};
        const isFreeByPrice = pricing.prompt === '0' && pricing.completion === '0';
        const isFreeByName = model.id?.toLowerCase().includes('free') || 
                           model.name?.toLowerCase().includes('free');
        return isFreeByPrice || isFreeByName;
      });
    }
    
    // Return simplified model info for dropdown
    const simplified = filtered.map(model => ({
      id: model.id,
      name: model.name,
      description: model.description,
      context_length: model.context_length,
      pricing: model.pricing,
      supported_parameters: model.supported_parameters,
      architecture: model.architecture,
      top_provider: model.top_provider,
      created: model.created,
      hugging_face_id: model.hugging_face_id
    }));
    
    res.json({ models: simplified, cached_at: modelsCache.lastFetch });
  } catch (e) {
    console.error('[MODELS]', e);
    res.status(500).json({ error: e.message || 'Failed to fetch models' });
  }
});

const PORT = process.env.PORT || 3000;
// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const distPath = path.resolve(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (provider=${runtimeConfig.provider})`);
});


