import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { getCacheDir, ensureCacheLayout, readJson, writeJson, downloadImageToCache, getExplanation, setExplanation, getBaseText, setBaseText, loadBaseTextsIndex, sha256Hex, readExerciseItem, makeExerciseFileName, updateExerciseRecord, selectUnseenFromPool, selectUnseenFromPoolGrouped, selectUnseenCrossModel, selectUnseenCrossModelGrouped, addExercisesToPool, makeBucketKey, purgeOutdatedSchemas, incrementExerciseHits, rateExplanation, rateExerciseGroup, updateBaseTextRecord, rebuildBaseTextsIndex, loadExercisesIndex } from './cacheStore.js';
import { BASE_TEXT_SYSTEM_PROMPT, generateBaseTextUserPrompt, BASE_TEXT_SCHEMA, addSourceMetadata, calculateTextSuitability, checkTextSuitability } from './baseTextPrompts.js';
import { pickRandomTopicSuggestion } from '../shared/topicRoulette.js';
import { schemaVersions } from '../shared/schemaVersions.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Persistent cache directories (lazy-init)
// Default fallback is a local .cache directory; override via CACHE_DIR env in prod
const CACHE_DIR = getCacheDir(process.env.CACHE_DIR, path.resolve(process.cwd(), '.cache'));
// Register static image route immediately to avoid being shadowed by SPA fallback
try {
  const imagesDirAbsolute = path.join(CACHE_DIR, 'images');
  app.use('/cache/images', express.static(imagesDirAbsolute, { fallthrough: false }));
  console.log('[CACHE] Static image route mounted at /cache/images ->', imagesDirAbsolute);
} catch {}
let cacheLayout = null;
const initCache = (async () => {
  try {
    cacheLayout = await ensureCacheLayout(CACHE_DIR);
    console.log('[CACHE] Initialized at', CACHE_DIR);
    try {
      console.log('[CACHE] Directories', {
        env_CACHE_DIR: process.env.CACHE_DIR || '(unset)',
        resolved_CACHE_DIR: CACHE_DIR,
        explanationsDir: cacheLayout.explanationsDir,
        explanationItemsDir: cacheLayout.explanationItemsDir,
        exercisesDir: cacheLayout.exercisesDir,
        exerciseItemsDir: cacheLayout.exerciseItemsDir,
        imagesDir: cacheLayout.imagesDir,
        baseTextsDir: cacheLayout.baseTextsDir
      });
    } catch {}
    // Purge outdated schemas (can be disabled on constrained devices)
    try {
      const purgeEnabledEnv = String(process.env.CACHE_PURGE_ON_STARTUP || 'true').toLowerCase();
      const purgeEnabled = purgeEnabledEnv !== 'false' && purgeEnabledEnv !== '0' && purgeEnabledEnv !== 'no';
      if (purgeEnabled) {
        await purgeOutdatedSchemas(cacheLayout, schemaVersions);
      } else {
        console.log('[CACHE] Startup purge disabled via CACHE_PURGE_ON_STARTUP=false');
      }
    } catch (e) {
      console.warn('[CACHE] Failed to purge outdated schemas:', e?.message);
    }
    // Rebuild base texts index if empty or corrupted
    try {
      const baseIdx = await loadBaseTextsIndex(cacheLayout);
      if (!baseIdx.items || Object.keys(baseIdx.items).length === 0) {
        const ok = await rebuildBaseTextsIndex(cacheLayout);
        console.log(`[CACHE] Base texts reindex ${ok ? 'completed' : 'skipped/failed'}`);
      }
    } catch (e) {
      console.warn('[CACHE] Failed to reindex base texts:', e?.message);
    }
  } catch (e) {
    console.warn('[CACHE] Failed to initialize cache directories:', e?.message);
  }
})();

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

function coerceSchemaRequiredAll(inputSchema) {
  try {
    const schema = JSON.parse(JSON.stringify(inputSchema));
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
        node.required = Object.keys(node.properties);
        for (const key of Object.keys(node.properties)) {
          walk(node.properties[key]);
        }
      }
      if (node.type === 'array' && node.items) {
        walk(node.items);
      }
      // Also process common nested container keywords if present
      for (const k of ['oneOf','anyOf','allOf']) {
        if (Array.isArray(node[k])) node[k].forEach(walk);
      }
    };
    walk(schema);
    return schema;
  } catch {
    return inputSchema;
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
  runware: {
    apiKey: process.env.RUNWARE_API_KEY || '',
    model: process.env.RUNWARE_MODEL || 'runware:100@1',
    enabled: process.env.RUNWARE_ENABLED === 'true',
    width: Number(process.env.RUNWARE_WIDTH || 512),
    height: Number(process.env.RUNWARE_HEIGHT || 512),
    steps: Number(process.env.RUNWARE_STEPS || 20),
    cfgScale: Number(process.env.RUNWARE_CFG_SCALE || 7)
  },
  falai: {
    apiKey: process.env.FALAI_API_KEY || '',
    model: process.env.FALAI_MODEL || 'fal-ai/fast-sdxl',
    enabled: process.env.FALAI_ENABLED === 'true',
    width: Number(process.env.FALAI_WIDTH || 512),
    height: Number(process.env.FALAI_HEIGHT || 512),
    steps: Number(process.env.FALAI_STEPS || 20),
    cfgScale: Number(process.env.FALAI_CFG_SCALE || 7)
  },
  imageProvider: process.env.IMAGE_PROVIDER || 'runware',
  // Centralized max token cap for all generations
  maxTokens: Number(process.env.MAX_TOKENS || 15000)
};

// Validate and normalize Ollama host to prevent SSRF
function validateAndNormalizeOllamaHost(input) {
  try {
    const urlString = String(input || '').trim();
    const u = new URL(urlString);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    // Allow only loopback by default; extendable via OLLAMA_HOST_ALLOWLIST (comma-separated hostnames)
    const allowedHostnames = new Set(['127.0.0.1', 'localhost', '::1']);
    const allowlistEnv = String(process.env.OLLAMA_HOST_ALLOWLIST || '').trim();
    if (allowlistEnv) {
      for (const raw of allowlistEnv.split(',').map(s => s.trim()).filter(Boolean)) {
        // Support either bare hostname or full URL entries
        try {
          const parsed = raw.includes('://') ? new URL(raw) : null;
          allowedHostnames.add(parsed ? parsed.hostname : raw);
        } catch {
          // Ignore malformed entries
        }
      }
    }
    if (!allowedHostnames.has(u.hostname)) return null;
    const portPart = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname}${portPart}`;
  } catch {
    return null;
  }
}

// Static fal.ai pricing for default models (sourced from the public pricing gist)
// You can update these amounts manually if prices change
// See: https://gist.github.com/azer/6e8ffa228cb5d6f5807cd4d895b191a4
const FALAI_MODEL_PRICING = {
  // TODO: fill exact amount from gist for fast-sdxl if different
  'fal-ai/fast-sdxl': { pricePerComputeSecond: { currency: 'USD', amount: 0.00111 } },
  // Verified from gist: pricePerComputeSecond 0.00111
  'fal-ai/fast-lightning-sdxl': { pricePerComputeSecond: { currency: 'USD', amount: 0.00111 } },
  // TODO: fill exact amount from gist for turbo and 1.0 if different
  'fal-ai/fast-sdxl-turbo': { pricePerComputeSecond: { currency: 'USD', amount: 0.00111  } },
  'fal-ai/fast-sdxl-1.0': { pricePerComputeSecond: { currency: 'USD', amount: 0.00111  } }
};

function computeFalaiCostFromInference(modelId, timings, gen) {
  const pricing = FALAI_MODEL_PRICING[modelId];
  const inferenceSeconds = typeof timings?.inference === 'number' ? Number(timings.inference) : 0;
  if (!pricing || inferenceSeconds <= 0) {
    return {
      cost: 0,
      details: {
        reason: !pricing ? 'pricing_not_found' : 'no_inference_time',
        modelId,
        inferenceSeconds
      }
    };
  }
  const entry = Array.isArray(pricing) ? pricing[0] : pricing;
  const unitKey = Object.keys(entry).find(k => /^pricePer/.test(k));
  const val = entry[unitKey];
  const amount = typeof val?.amount === 'number' ? val.amount : Number(val);
  const currency = val?.currency || 'USD';
  const width = Number(gen?.width) || 0;
  const height = Number(gen?.height) || 0;
  const numImages = Math.max(1, Number(gen?.numImages) || 1);
  const megapixels = width && height ? (width * height) / 1_000_000 : 0;
  let cost = 0;
  let basis = unitKey || 'unknown';
  switch (unitKey) {
    case 'pricePerComputeSecond':
    case 'pricePerSecond':
      cost = inferenceSeconds * amount;
      basis = 'inference_seconds';
      break;
    case 'pricePerTenSeconds':
      cost = Math.ceil(inferenceSeconds / 10) * amount;
      basis = 'ceil(inference_seconds/10)';
      break;
    case 'pricePerMinute':
      cost = (inferenceSeconds / 60) * amount;
      basis = 'inference_seconds/60';
      break;
    case 'pricePerMegapixel':
      cost = megapixels * amount * numImages;
      basis = 'megapixels * images';
      break;
    case 'pricePerImage':
    case 'pricePerGeneration':
    case 'pricePerRequest':
      cost = amount * numImages;
      basis = 'images';
      break;
    default:
      cost = 0;
      basis = 'unknown_unit';
  }
  return {
    cost,
    details: {
      currency,
      unit: unitKey,
      unitAmount: amount,
      inferenceSeconds,
      width,
      height,
      megapixels: Number.isFinite(megapixels) ? Number(megapixels.toFixed(3)) : 0,
      numImages,
      basis
    }
  };
}

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

// In-memory debug store for last N LLM requests/responses
const DEBUG_CAPACITY = 100;
const debugLogs = new Map();
const debugOrder = [];
function addDebugLog(entry) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    timestamp: Date.now(),
    ...entry
  };
  debugLogs.set(id, record);
  debugOrder.push(id);
  if (debugOrder.length > DEBUG_CAPACITY) {
    const oldest = debugOrder.shift();
    if (oldest) debugLogs.delete(oldest);
  }
  return id;
}

async function callLLM({ system, user, maxTokens, jsonSchema, schemaName }) {
  // Enforce application-level token cap regardless of caller
  maxTokens = runtimeConfig.maxTokens;
  const provider = runtimeConfig.provider;
  const startedAt = Date.now();
  const logPrefix = `[LLM ${provider}]`;
  const systemPreview = String(system || '').replace(/\s+/g, ' ');
  const userPreview = String(user || '').replace(/\s+/g, ' ');
  console.log(`${logPrefix} model=${
    provider === 'openrouter' ? runtimeConfig.openrouter.model :
    runtimeConfig.ollama.model
  } maxTokens=${maxTokens} systemPreview="${systemPreview}" userPreview="${userPreview}" structured=${jsonSchema ? 'yes' : 'no'}`);
  if (provider === 'openrouter') {
    assertEnv(runtimeConfig.openrouter.apiKey, 'Missing OPENROUTER_API_KEY');
    const buildOpenRouterPayload = (maxTokensValue) => {
      const modelId = runtimeConfig.openrouter.model || '';
      const enableReasoningByDefault = /^openai\/gpt-/i.test(String(modelId));
      return {
        model: modelId,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user }
        ].filter(Boolean),
        max_tokens: maxTokensValue,
        // Enable low-effort reasoning by default for OpenAI GPT models to avoid mandatory reasoning errors
        reasoning: enableReasoningByDefault ? { effort: 'low' } : { exclude: true, effort: 'low', enabled: false },
        ...(jsonSchema ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: schemaName || 'structured_output',
              strict: true,
              // Some providers (e.g., OpenAI) require `required` to include all properties recursively
              schema: coerceSchemaRequiredAll(jsonSchema)
            }
          }
        } : {})
      };
    };

    const doOpenRouterRequest = async (maxTokensValue) => {
      const payload = buildOpenRouterPayload(maxTokensValue);
      let resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${runtimeConfig.openrouter.apiKey}`,
          'http-referer': runtimeConfig.openrouter.appUrl || 'http://localhost:5173',
          'x-title': 'Language AI App'
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        // Capture error body for diagnostics
        const errorText = await resp.text().catch(() => '');
        const debugId = addDebugLog({
          provider: 'openrouter',
          model: runtimeConfig.openrouter.model,
          status: resp.status,
          request: payload,
          responseText: errorText
        });
        console.error(`${logPrefix} HTTP ${resp.status} body: ${errorText || '(empty)'} | debug=/api/debug/${debugId}`);
        // If provider requires reasoning enabled, retry once with reasoning enabled
        if (/Reasoning is mandatory/i.test(errorText || '') && payload?.reasoning?.exclude === true) {
          console.warn(`${logPrefix} enabling reasoning and retrying once`);
          const enabledPayload = { ...payload, reasoning: { effort: 'low' } };
          resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'authorization': `Bearer ${runtimeConfig.openrouter.apiKey}`,
              'http-referer': runtimeConfig.openrouter.appUrl || 'http://localhost:5173',
              'x-title': 'Language AI App'
            },
            body: JSON.stringify(enabledPayload)
          });
          if (!resp.ok) {
            const secondBody = await resp.text().catch(() => '');
            const debugId2 = addDebugLog({
              provider: 'openrouter',
              model: runtimeConfig.openrouter.model,
              status: resp.status,
              request: enabledPayload,
              responseText: secondBody
            });
            console.error(`${logPrefix} HTTP ${resp.status} after enabling reasoning: ${secondBody || '(empty)'} | debug=/api/debug/${debugId2}`);
          }
        }
        // Log exact JSON payload and a curl template to reproduce
        try {
          const payloadStr = JSON.stringify(payload);
          const curlDebugId = addDebugLog({ provider: 'openrouter', model: runtimeConfig.openrouter.model, curlPayload: payload });
          console.error(`${logPrefix} request payload: ${payloadStr} | curl=/api/debug/${curlDebugId}`);
          const curl = [
            'curl -X POST https://openrouter.ai/api/v1/chat/completions',
            "-H 'Content-Type: application/json'",
            "-H 'Authorization: Bearer $OPENROUTER_API_KEY'",
            `-H 'HTTP-Referer: ${runtimeConfig.openrouter.appUrl || 'http://localhost:5173'}'`,
            "-H 'X-Title: Language AI App'",
            '--data @payload.json'
          ].join(' \\\n');
          console.error(`${logPrefix} repro: save payload from curl debug endpoint above to payload.json then run:\n${curl}`);
        } catch {}
      }
      return resp;
    };

    let resp = await doOpenRouterRequest(maxTokens);
    if (!resp.ok && resp.status === 400) {
      const fallbackOrder = [8000, 4000, 2000].filter(t => t < maxTokens);
      let tried = [maxTokens];
      for (const t of fallbackOrder) {
        console.warn(`${logPrefix} 400 with max_tokens=${tried[tried.length-1]}; retrying with max_tokens=${t}`);
        resp = await doOpenRouterRequest(t);
        tried.push(t);
        if (resp.ok) {
          maxTokens = t;
          break;
        }
      }
    }
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

    // Log token usage, response data, and attempt to get cost info
    const usage = data.usage || {};
    const generationId = data.id;
    console.log(
      `${logPrefix} ok in ${responseTime}ms | tokens: ${usage.prompt_tokens || 0}→${usage.completion_tokens || 0} (${usage.total_tokens || 0} total)${generationId ? ` | id: ${generationId}` : ''}\nresponse data: ${JSON.stringify(data)}`
    );
    
    // Fetch detailed cost information asynchronously (non-blocking)
    if (generationId) {
      // Validate generationId to prevent URL injection
      if (typeof generationId === 'string' && /^[a-zA-Z0-9_-]+$/.test(generationId)) {
        (async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, 500)); // Longer delay to allow generation to be processed
            const costResp = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
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
    }
    
    return data.choices?.[0]?.message?.content || '';
  }
  if (provider === 'ollama') {
    const normalizedHost = validateAndNormalizeOllamaHost(runtimeConfig.ollama.host) || 'http://127.0.0.1:11434';

    const resp = await fetch(`${normalizedHost}/api/chat`, {
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

// Generic LLM generation endpoint (will be extended for persistent cache)
app.post('/api/generate', async (req, res) => {
  try {
    const { system, user, jsonSchema, schemaName, metadata } = req.body || {};
    if (!user || !String(user).trim()) return res.status(400).json({ error: 'User prompt is required' });
    
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
    const currentModel = runtimeConfig.provider === 'openrouter' ? runtimeConfig.openrouter.model : runtimeConfig.ollama.model;
    const schemaVersion = schemaVersions[type] || (type === 'explanation' ? schemaVersions.explanation : 1);
    const promptSha = sha256Hex(`${system || ''}\n${user}\n${schemaName}\n${languageName}:${level}:${challengeMode}`);
    const promptSha12 = promptSha.slice(0, 12);

    // Base text persistent cache handling
    if (cacheLayout && type === 'base_text') {
      const currentModel = runtimeConfig.provider === 'openrouter' ? runtimeConfig.openrouter.model : runtimeConfig.ollama.model;
      const topic = (metadata?.topic || (user.match(/about:\s*([^\n]+)/i)?.[1] || 'unknown')).trim();
      const baseKey = `base:${languageName}:${level}:${challengeMode}:${topic}:${currentModel}:${schemaVersion}:${promptSha12}`;
      const rec = await getBaseText(cacheLayout, baseKey);
      if (rec && rec.content) {
        return res.json({ ...rec.content, _cacheKey: baseKey });
      }
      const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
      const text = await callLLM({ system, user, jsonSchema: useStructured ? jsonSchema : undefined, schemaName });
      let parsed;
      try {
        parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
      } catch (e) {
        console.error('[PARSE]', e.message, e.rawPreview || '');
        return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
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
        console.warn('[CACHE] Failed to persist base text:', e?.message);
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
      const cookieName = `seen_exercises_${type}_v${schemaVersion}`;
      const seenCookieMatch = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
      const seenList = seenCookieMatch ? decodeURIComponent(seenCookieMatch[1]).split(',').filter(Boolean) : [];
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
                const cookieName = `seen_exercises_${type}_v${schemaVersion}`;
                const prefixes = [String(foundSha).slice(0, 12)];
                const cookieHeader = String(req.headers['cookie'] || '');
                const seenCookieMatch = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
                const seenList = seenCookieMatch ? decodeURIComponent(seenCookieMatch[1]).split(',').filter(Boolean) : [];
                const maxSeen = Number(process.env.COOKIE_MAX_SEEN_PER_TYPE || 50);
                const merged = Array.from(new Set([...seenList, ...prefixes])).slice(-maxSeen);
                const cookieVal = encodeURIComponent(merged.join(','));
                res.append('Set-Cookie', `${cookieName}=${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax`);
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
        const before = resultPairs.length;
        let dedupedCount = 0;
        resultPairs = resultPairs.map(({ item, sha }) => {
          const { item: fixed, changed, valid } = dedupeMcqItemOptions(item);
          if (changed) dedupedCount++;
          return valid ? { item: fixed, sha } : null;
        }).filter(Boolean);
        if (dedupedCount > 0) {
          console.warn(`[MCQ] Deduped option texts for ${dedupedCount}/${before} cached items (removed duplicates).`);
        }
      }

      let resultItems = resultPairs.map(p => p.item);
      let resultShas = resultPairs.map(p => p.sha);

      // If not enough, call LLM for the shortfall
      if (resultItems.length < desiredCount) {
        const need = desiredCount - resultItems.length;
        const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
        const text = await callLLM({ system, user, jsonSchema: useStructured ? jsonSchema : undefined, schemaName });
        let parsed;
        try {
          parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
        } catch (e) {
          const expectsItems = !!(jsonSchema && jsonSchema.properties && jsonSchema.properties.items);
          if (expectsItems) {
            const recovered = recoverItemsFromPartialJson(text);
            if (recovered && Array.isArray(recovered.items) && recovered.items.length > 0) {
              parsed = recovered;
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
        let generated = Array.isArray(parsed?.items) ? parsed.items : [];
        // MCQ: dedupe option texts in newly generated items; drop invalid ones (< 2 distinct options)
        if (type === 'mcq') {
          const beforeGen = generated.length;
          let changedGen = 0;
          generated = generated.map(it => {
            const { item: fixed, changed, valid } = dedupeMcqItemOptions(it);
            if (changed) changedGen++;
            return valid ? fixed : null;
          }).filter(Boolean);
          if (changedGen > 0) {
            console.warn(`[MCQ] Deduped option texts for ${changedGen}/${beforeGen} newly generated items (removed duplicates).`);
          }
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
        res.append('Set-Cookie', `${cookieName}=${cookieVal}; Path=/; Max-Age=2592000; SameSite=Lax`);
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
      const currentModel = runtimeConfig.provider === 'openrouter' 
        ? runtimeConfig.openrouter.model 
        : runtimeConfig.ollama.model;
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
        console.log(`[CACHE HIT] explanation ${grammarConcept} | model=${currentModel} | v=${schemaVersion}`);
        const withKey = { ...rec.content, _cacheKey: explanationPersistentKey };
        return res.json(withKey);
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
    
    // Persistent cache write for explanations
    if (isExplanation && explanationPersistentKey && parsed && cacheLayout) {
      try {
        const currentModel = runtimeConfig.provider === 'openrouter' 
          ? runtimeConfig.openrouter.model 
          : runtimeConfig.ollama.model;
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
        console.log(`[CACHE SET] explanation ${grammarConcept} | model=${currentModel} | v=${schemaVersion}`);
      } catch (e) {
        console.warn('[CACHE] Failed to persist explanation:', e?.message);
      }
    }
    
    if (isExplanation && explanationPersistentKey) {
      const withKey = { ...parsed, _cacheKey: explanationPersistentKey };
      return res.json(withKey);
    }
    // Fallback path (no persistent cache or not an explanation): apply MCQ dedupe if applicable
    if (type === 'mcq' && parsed && Array.isArray(parsed.items)) {
      const before = parsed.items.length;
      let changed = 0;
      const deduped = parsed.items.map(it => {
        const { item: fixed, changed: c, valid } = dedupeMcqItemOptions(it);
        if (c) changed++;
        return valid ? fixed : null;
      }).filter(Boolean);
      if (changed > 0) {
        console.warn(`[MCQ] Deduped option texts for ${changed}/${before} items (no-cache path).`);
      }
      parsed.items = deduped;
    }
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate content', details: err?.message, provider: runtimeConfig.provider });
  }
});

// Streaming explanation generation (SSE)
// Produces Server-Sent Events with JSON payloads:
// { type: 'prefill', explanation } when served from cache
// { type: 'delta', text } for incremental markdown chunks
// { type: 'final', explanation } at completion
app.post('/api/explanations/stream', async (req, res) => {
  try {
    const { topic, language = 'es', level = 'B1', challengeMode = false } = req.body || {};
    const languageName = String(language || 'es');
    const lvl = String(level || 'B1');
    const ch = !!challengeMode;

    const system = `You are a language pedagogy expert. Provide a concise, insightful explanation of a ${languageName} grammar concept with examples. Target CEFR level: ${lvl}${ch ? ' (slightly challenging)' : ''}. Where relevant, add a section on common mistakes and how to avoid them. Additionally, where relevant, include a section on cultural context, regional differences, usage tips, etymology and other relevant information.\n Explanations should be in the target language, with the target level of difficulty. If necessary, depending on the user's level, you may include translations in English.`;
    const user = `Explain the grammar concept: ${String(topic || '').trim()}.

Target Language: ${languageName}
Target Level: ${lvl}${ch ? ' (slightly challenging)' : ''}

Keep it 200-600 words and ensure vocabulary and grammar complexity matches ${lvl} level${ch ? ' with separate advanced explanations for more eager learners' : ''}.
Output as markdown. Start with a top-level heading (#) for the title, then the explanation.`;

    // Build persistent cache key consistent with /api/generate
    let explanationPersistentKey = null;
    const schemaVersion = schemaVersions.explanation || 1;
    const currentModel = runtimeConfig.provider === 'openrouter' ? runtimeConfig.openrouter.model : runtimeConfig.ollama.model;
    const promptSha = sha256Hex(`${system}\n${user}\nexplanation\n${languageName}:${lvl}:${ch}`);
    const promptSha12 = promptSha.slice(0, 12);
    explanationPersistentKey = `exp:${languageName}:${lvl}:${ch}:${String(topic || '').trim() || 'unknown'}:${currentModel}:${schemaVersion}:${promptSha12}`;

    // Logging parity with non-streaming generation
    const startedAt = Date.now();
    const provider = runtimeConfig.provider;
    const logPrefix = `[LLM ${provider}]`;
    const systemPreview = String(system || '').replace(/\s+/g, ' ');
    const userPreview = String(user || '').replace(/\s+/g, ' ');
    try {
      console.log(`${logPrefix} stream start model=${currentModel} maxTokens=${runtimeConfig.maxTokens} topic="${String(topic || '').trim()}" lang=${languageName} level=${lvl} challenging=${ch} systemPreview="${systemPreview}" userPreview="${userPreview}"`);
    } catch {}

    // SSE headers
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.flushHeaders?.();
    const sse = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

    // If cached, prefill and end
    if (cacheLayout && explanationPersistentKey) {
      try {
        const rec = await getExplanation(cacheLayout, explanationPersistentKey);
        if (rec && rec.content) {
          try { console.log(`[CACHE HIT] explanation (stream) ${String(topic || '').trim()} | model=${currentModel} | v=${schemaVersion}`); } catch {}
          sse({ type: 'prefill', explanation: { ...rec.content, _cacheKey: explanationPersistentKey } });
          clearInterval(keepAlive);
          return res.end();
        }
      } catch {}
    }

    // Helper to parse title from accumulated markdown
    const extractTitle = (md, fallback) => {
      const lines = String(md || '').split(/\r?\n/);
      for (const ln of lines) {
        const m = ln.match(/^\s*#{1,3}\s+(.+)$/);
        if (m) return m[1].trim();
      }
      // Also handle possible "Title: ..." patterns
      const t = String(md || '').match(/\bTitle\s*:\s*([^\n]+)/i);
      return (t ? t[1].trim() : null) || String(fallback || '').trim() || 'Explanation';
    };

    // Streaming per provider
    let aborted = false;
    req.on('close', () => { aborted = true; });
    let content = '';
    let title = `Generating “${String(topic || '').trim()}”...`;

    if (provider === 'openrouter') {
      assertEnv(runtimeConfig.openrouter.apiKey, 'Missing OPENROUTER_API_KEY');
      const payload = {
        model: runtimeConfig.openrouter.model,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user }
        ].filter(Boolean),
        max_tokens: runtimeConfig.maxTokens,
        stream: true,
        reasoning: /^openai\/gpt-/i.test(String(runtimeConfig.openrouter.model)) ? { effort: 'low' } : { exclude: true, effort: 'low', enabled: false }
      };
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${runtimeConfig.openrouter.apiKey}`,
          'http-referer': runtimeConfig.openrouter.appUrl || 'http://localhost:5173',
          'x-title': 'Language AI App'
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok || !resp.body) {
        try {
          const errorText = await resp.text().catch(() => '');
          const debugId = addDebugLog({ provider: 'openrouter', model: runtimeConfig.openrouter.model, status: resp.status, request: payload, responseText: errorText });
          console.error(`${logPrefix} stream HTTP ${resp.status} body: ${errorText || '(empty)'} | debug=/api/debug/${debugId}`);
          try {
            const payloadStr = JSON.stringify(payload);
            const curlDebugId = addDebugLog({ provider: 'openrouter', model: runtimeConfig.openrouter.model, curlPayload: payload });
            console.error(`${logPrefix} stream request payload: ${payloadStr} | curl=/api/debug/${curlDebugId}`);
            const curl = [
              'curl -X POST https://openrouter.ai/api/v1/chat/completions',
              "-H 'Content-Type: application/json'",
              "-H 'Authorization: Bearer $OPENROUTER_API_KEY'",
              `-H 'HTTP-Referer: ${runtimeConfig.openrouter.appUrl || 'http://localhost:5173'}'`,
              "-H 'X-Title: Language AI App'",
              '--data @payload.json'
            ].join(' \\\n');
            console.error(`${logPrefix} stream repro: save payload from curl debug endpoint above to payload.json then run:\n${curl}`);
          } catch {}
        } catch {}
        clearInterval(keepAlive);
        return res.end();
      }
      // Try to capture a generation id from headers if provided (may not always exist)
      const headerGenId = resp.headers?.get('x-openrouter-generation-id') || resp.headers?.get('openrouter-generation-id') || resp.headers?.get('x-request-id') || null;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          try {
            const evt = JSON.parse(jsonStr);
            const choice = evt.choices?.[0] || {};
            const delta = choice.delta?.content || choice.message?.content || '';
            if (delta) {
              content += delta;
              // Try to extract title early
              title = extractTitle(content, title);
              sse({ type: 'delta', text: delta, title });
            }
          } catch {}
        }
      }
      // Log completion summary
      try {
        const ms = Date.now() - startedAt;
        const preview = String(content || '').slice(0, 400);
        console.log(`${logPrefix} stream ok in ${ms}ms | chars=${content.length}${headerGenId ? ` | id: ${headerGenId}` : ''}\npreview: ${preview}`);
        // Attempt cost fetch if we have a valid generation id
        if (headerGenId && /^[a-zA-Z0-9_-]+$/.test(headerGenId)) {
          (async () => {
            try {
              await new Promise(r => setTimeout(r, 500));
              const costResp = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(headerGenId)}`, { headers: { authorization: `Bearer ${runtimeConfig.openrouter.apiKey}` } });
              if (costResp.ok) {
                const costData = await costResp.json();
                if (costData.data && typeof costData.data.total_cost === 'number') {
                  console.log(`${logPrefix} cost: $${Number(costData.data.total_cost).toFixed(6)} | native tokens: ${costData.data.tokens_prompt || 0}→${costData.data.tokens_completion || 0} | provider: ${costData.data.provider_name || 'unknown'}`);
                }
              }
            } catch {}
          })();
        }
      } catch {}
    } else if (provider === 'ollama') {
      const normalizedHost = validateAndNormalizeOllamaHost(runtimeConfig.ollama.host) || 'http://127.0.0.1:11434';
      const resp = await fetch(`${normalizedHost}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: runtimeConfig.ollama.model,
          messages: [
            system ? { role: 'system', content: system } : null,
            { role: 'user', content: user }
          ].filter(Boolean),
          stream: true
        })
      });
      if (!resp.ok || !resp.body) {
        clearInterval(keepAlive);
        return res.end();
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            const delta = evt?.message?.content || evt?.response || '';
            if (delta) {
              content += delta;
              title = extractTitle(content, title);
              sse({ type: 'delta', text: delta, title });
            }
          } catch {}
        }
      }
      // Log completion summary for Ollama
      try {
        const ms = Date.now() - startedAt;
        const preview = String(content || '').slice(0, 400);
        console.log(`${logPrefix} stream ok in ${ms}ms | model=${runtimeConfig.ollama.model} | chars=${content.length}\npreview: ${preview}`);
      } catch {}
    } else {
      // Unsupported provider for streaming; end gracefully
      clearInterval(keepAlive);
      return res.end();
    }

    // Finalize explanation object
    const finalTitle = extractTitle(content, topic);
    // Remove the title heading line from content if present
    let finalContent = String(content || '');
    finalContent = finalContent.replace(/^\s*#{1,3}\s+.+\r?\n?/, '');
    const explanation = { title: finalTitle, content_markdown: finalContent };

    // Persist to cache
    if (cacheLayout && explanationPersistentKey) {
      try {
        const meta = { language: languageName, level: lvl, challengeMode: ch, grammarConcept: String(topic || '').trim(), model: currentModel, schemaVersion, promptSha, promptSha12 };
        const cap = Number(process.env.CACHE_EXPLANATIONS_MAX || 1000);
        await setExplanation(cacheLayout, explanationPersistentKey, meta, explanation, cap);
        try { console.log(`[CACHE SET] explanation (stream) ${String(topic || '').trim()} | model=${currentModel} | v=${schemaVersion}`); } catch {}
      } catch {}
    }
    sse({ type: 'final', explanation: explanationPersistentKey ? { ...explanation, _cacheKey: explanationPersistentKey } : explanation });
    clearInterval(keepAlive);
    return res.end();
  } catch (err) {
    try {
      res.set({ 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'error', error: err?.message || 'Failed to stream explanation' })}\n\n`);
      res.end();
    } catch {}
    try { console.error('[STREAM]', err?.message || err); } catch {}
  }
});

// Base text selection/generation endpoint
app.get('/api/base-text-content/:baseTextId', async (req, res) => {
  try {
    const { baseTextId } = req.params;
    if (!baseTextId) return res.status(400).json({ error: 'Base text ID required' });

    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });

    // Resolve the cache key from the index using the human-friendly baseTextId
    const idx = await loadBaseTextsIndex(cacheLayout);
    let cacheKeyForId = null;
    let foundVia = null;
    for (const [key, entry] of Object.entries(idx.items || {})) {
      const meta = entry?.meta || {};
      // Match against meta.baseTextId which is stored in the index
      if (String(meta.baseTextId || '').trim() === String(baseTextId).trim()) {
        cacheKeyForId = key;
        foundVia = 'index.meta.baseTextId';
        break;
      }
    }

    // Fallback: scan record content.id for older entries that may not have meta.baseTextId
    if (!cacheKeyForId) {
      for (const [key] of Object.entries(idx.items || {})) {
        try {
          const rec = await getBaseText(cacheLayout, key);
          const contentId = rec?.content?.id || rec?.content?.baseTextId;
          if (contentId && String(contentId).trim() === String(baseTextId).trim()) {
            cacheKeyForId = key;
            foundVia = 'index.file.content.id';
            break;
          }
        } catch {}
      }
    }

    // Last-resort recovery: scan base_texts/items directory and rehydrate index if we find a match
    // If we find the record here, return it immediately to avoid races between concurrent requests
    if (!cacheKeyForId) {
      try {
        const dir = cacheLayout.baseTextItemsDir;
        const files = await fs.readdir(dir);
        let directRecord = null;
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const recPath = path.join(dir, f);
            const rec = await readJson(recPath, null);
            if (!rec) continue;
            const contentId = rec?.content?.id || rec?.meta?.baseTextId;
            if (contentId && String(contentId).trim() === String(baseTextId).trim()) {
              // Rehydrate index entry for future lookups
              const baseIdxPath = path.join(cacheLayout.baseTextsDir, 'index.json');
              const baseIdx = (await readJson(baseIdxPath)) || { items: {}, lru: [] };
              baseIdx.items = baseIdx.items || {};
              baseIdx.lru = baseIdx.lru || [];
              const now = new Date().toISOString();
              const cacheKey = rec.key || `base:${rec?.meta?.language || 'unknown'}:${rec?.meta?.level || 'unknown'}:${!!rec?.meta?.challengeMode}:${rec?.meta?.topic || 'unknown'}:${rec?.meta?.model || 'unknown'}:${rec?.meta?.schemaVersion || 1}:${(rec?.meta?.promptSha || '').slice(0,12) || contentId}`;
              baseIdx.items[cacheKey] = { file: f, createdAt: rec.createdAt || now, lastAccessAt: now, hits: Number(rec.hits || 0), likes: Number(rec.likes || 0), dislikes: Number(rec.dislikes || 0), meta: rec.meta || {} };
              baseIdx.lru = baseIdx.lru.filter(k => k !== cacheKey).concat(cacheKey);
              await writeJson(baseIdxPath, baseIdx);
              cacheKeyForId = cacheKey;
              directRecord = rec; // allow immediate return to avoid race
              break;
            }
          } catch {}
        }
        if (directRecord) {
          console.log(`[BASE-TEXT] ${baseTextId} -> 200 via filescan`);
          return res.json(directRecord.content || directRecord);
        }
      } catch {}
    }

    if (!cacheKeyForId) {
      console.warn(`[BASE-TEXT] ${baseTextId} -> 404 not found`);
      return res.status(404).json({ error: 'Base text not found' });
    }

    // Load the base text record via the resolved cache key
    let record = await getBaseText(cacheLayout, cacheKeyForId);
    if (!record) {
      // Attempt recovery by scanning files and returning the record directly
      try {
        const dir = cacheLayout.baseTextItemsDir;
        const files = await fs.readdir(dir);
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          const recPath = path.join(dir, f);
          const rec = await readJson(recPath, null);
          const contentId = rec?.content?.id || rec?.meta?.baseTextId;
          if (contentId && String(contentId).trim() === String(baseTextId).trim()) {
            console.log(`[BASE-TEXT] ${baseTextId} -> 200 via filescan(recovery)`);
            return res.json(rec.content || rec);
          }
        }
      } catch {}
      return res.status(404).json({ error: 'Base text not found' });
    }

    // Return the content only for client consumption (include images map if present)
    const payload = record.content || record;
    console.log(`[BASE-TEXT] ${baseTextId} -> 200 via ${foundVia || 'index'}`);
    res.json(payload);
  } catch (error) {
    console.error('Error fetching base text content:', error);
    res.status(500).json({ error: 'Failed to fetch base text content' });
  }
});

app.post('/api/base-text', async (req, res) => {
  try {
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { topic: userTopic, language = 'es', level = 'B1', challengeMode = false, excludeIds = [], focus } = req.body || {};
    
    // Use topic roulette instead of user grammar topic for base text generation
    const topicSuggestion = pickRandomTopicSuggestion({ ensureNotEqualTo: userTopic });
    const topic = topicSuggestion?.topic || 'daily life';
    
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'topic generation failed' });

    const currentModel = runtimeConfig.provider === 'openrouter' ? runtimeConfig.openrouter.model : runtimeConfig.ollama.model;
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
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system: baseSystem, user: baseUser, jsonSchema: useStructured ? baseSchema : undefined, schemaName: 'base_text' });
    let parsed;
    try {
      parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
    } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
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
    console.error('[BASE-TEXT]', e);
    return res.status(500).json({ error: e?.message || 'Failed to select or generate base text' });
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

// Ratings: explanations and exercise groups
app.post('/api/rate/explanation', async (req, res) => {
  try {
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { key, like } = req.body || {};
    if (typeof key !== 'string' || !key.startsWith('exp:')) return res.status(400).json({ error: 'Invalid explanation key' });
    const ok = await rateExplanation(cacheLayout, key, like !== false);
    if (!ok) return res.status(404).json({ error: 'Explanation not found' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to rate explanation' });
  }
});

app.post('/api/rate/exercise-group', async (req, res) => {
  try {
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { groupId, like } = req.body || {};
    if (typeof groupId !== 'string' || !/^[a-f0-9]{8,32}$/i.test(groupId)) return res.status(400).json({ error: 'Invalid groupId' });
    const ok = await rateExerciseGroup(cacheLayout, groupId, like !== false);
    if (!ok) return res.status(404).json({ error: 'Group not found' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to rate exercise group' });
  }
});

app.post('/api/recommend', async (req, res) => {
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
    const normalizedHost = validateAndNormalizeOllamaHost(runtimeConfig.ollama.host) || 'http://127.0.0.1:11434';
    const url = `${normalizedHost}/api/tags`;
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
    ollama: { model: runtimeConfig.ollama.model, host: runtimeConfig.ollama.host },
            runware: {
          model: runtimeConfig.runware.model,
          enabled: runtimeConfig.runware.enabled,
          hasKey: !!runtimeConfig.runware.apiKey,
          width: runtimeConfig.runware.width,
          height: runtimeConfig.runware.height,
          steps: runtimeConfig.runware.steps,
          cfgScale: runtimeConfig.runware.cfgScale
        },
        falai: {
          model: runtimeConfig.falai.model,
          enabled: runtimeConfig.falai.enabled,
          hasKey: !!runtimeConfig.falai.apiKey,
          width: runtimeConfig.falai.width,
          height: runtimeConfig.falai.height,
          steps: runtimeConfig.falai.steps,
          cfgScale: runtimeConfig.falai.cfgScale
        },
        imageProvider: runtimeConfig.imageProvider || 'runware'
  };
  res.json(sanitized);
});

// Settings: update runtime config
app.post('/api/settings', (req, res) => {
  // Disable settings endpoint in production
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Settings endpoint disabled in production' });
  }
  
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
      if (body.runware) {
      if (typeof body.runware.apiKey === 'string' && body.runware.apiKey.trim()) runtimeConfig.runware.apiKey = body.runware.apiKey;
      if (typeof body.runware.model === 'string') runtimeConfig.runware.model = body.runware.model;
      if (typeof body.runware.enabled === 'boolean') runtimeConfig.runware.enabled = body.runware.enabled;
      if (typeof body.runware.width === 'number' && body.runware.width > 0) runtimeConfig.runware.width = body.runware.width;
      if (typeof body.runware.height === 'number' && body.runware.height > 0) runtimeConfig.runware.height = body.runware.height;
      if (typeof body.runware.steps === 'number' && body.runware.steps > 0) runtimeConfig.runware.steps = body.runware.steps;
      if (typeof body.runware.cfgScale === 'number' && body.runware.cfgScale > 0) runtimeConfig.runware.cfgScale = body.runware.cfgScale;
    }
    if (body.falai) {
      if (typeof body.falai.apiKey === 'string' && body.falai.apiKey.trim()) runtimeConfig.falai.apiKey = body.falai.apiKey;
      if (typeof body.falai.model === 'string') runtimeConfig.falai.model = body.falai.model;
      if (typeof body.falai.enabled === 'boolean') runtimeConfig.falai.enabled = body.falai.enabled;
      if (typeof body.falai.width === 'number' && body.falai.width > 0) runtimeConfig.falai.width = body.falai.width;
      if (typeof body.falai.height === 'number' && body.falai.height > 0) runtimeConfig.falai.height = body.falai.height;
      if (typeof body.falai.steps === 'number' && body.falai.steps > 0) runtimeConfig.falai.steps = body.falai.steps;
      if (typeof body.falai.cfgScale === 'number' && body.falai.cfgScale > 0) runtimeConfig.falai.cfgScale = body.falai.cfgScale;
    }
    if (typeof body.imageProvider === 'string') runtimeConfig.imageProvider = body.imageProvider;

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
        let v = line.slice(eq + 1);
        // Handle quoted values (both single and double quotes)
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1); // Remove quotes
        }
        if (k) map.set(k, v);
      }
      const set = (k, v) => {
        if (typeof v === 'string') {
          // Quote values that contain spaces to maintain .env format compliance
          const stringValue = v;
          map.set(k, stringValue.includes(' ') ? `"${stringValue}"` : stringValue);
        }
      };
      const setNum = (k, v) => { if (typeof v === 'number') map.set(k, v.toString()); };
      const setBool = (k, v) => { if (typeof v === 'boolean') map.set(k, v.toString()); };
      set('PROVIDER', runtimeConfig.provider);
      set('OPENROUTER_API_KEY', runtimeConfig.openrouter.apiKey || map.get('OPENROUTER_API_KEY') || '');
      set('OPENROUTER_MODEL', runtimeConfig.openrouter.model);
      set('APP_URL', runtimeConfig.openrouter.appUrl);
      set('OLLAMA_HOST', runtimeConfig.ollama.host);
      set('OLLAMA_MODEL', runtimeConfig.ollama.model);
          set('RUNWARE_API_KEY', runtimeConfig.runware.apiKey || map.get('RUNWARE_API_KEY') || '');
    set('RUNWARE_MODEL', runtimeConfig.runware.model);
    setBool('RUNWARE_ENABLED', runtimeConfig.runware.enabled);
    setNum('RUNWARE_WIDTH', runtimeConfig.runware.width);
    setNum('RUNWARE_HEIGHT', runtimeConfig.runware.height);
    setNum('RUNWARE_STEPS', runtimeConfig.runware.steps);
    setNum('RUNWARE_CFG_SCALE', runtimeConfig.runware.cfgScale);
    set('FALAI_API_KEY', runtimeConfig.falai.apiKey || map.get('FALAI_API_KEY') || '');
    set('FALAI_MODEL', runtimeConfig.falai.model);
    setBool('FALAI_ENABLED', runtimeConfig.falai.enabled);
    setNum('FALAI_WIDTH', runtimeConfig.falai.width);
    setNum('FALAI_HEIGHT', runtimeConfig.falai.height);
    setNum('FALAI_STEPS', runtimeConfig.falai.steps);
    setNum('FALAI_CFG_SCALE', runtimeConfig.falai.cfgScale);
    set('IMAGE_PROVIDER', runtimeConfig.imageProvider);
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

// Runware: text-to-image generation
app.post('/api/runware/generate', async (req, res) => {
  try {
    if (!runtimeConfig.runware.enabled) {
      return res.status(400).json({ error: 'Runware image generation is disabled' });
    }
    
    assertEnv(runtimeConfig.runware.apiKey, 'Missing RUNWARE_API_KEY');
    
    const { prompt, model, width, height, steps, cfgScale, seed, scheduler } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    // Validate prompt to prevent injection attacks
    const cleanPrompt = String(prompt).trim();
    if (cleanPrompt.length > 5000) {
      return res.status(400).json({ error: 'Prompt too long (max 5000 characters)' });
    }
    
    // Validate numeric parameters
    const validWidth = Number(width || runtimeConfig.runware.width);
    const validHeight = Number(height || runtimeConfig.runware.height);
    const validSteps = Number(steps || runtimeConfig.runware.steps);
    const validCfgScale = Number(cfgScale || runtimeConfig.runware.cfgScale);
    
    if (!Number.isInteger(validWidth) || validWidth < 64 || validWidth > 2048 || validWidth % 64 !== 0) {
      return res.status(400).json({ error: 'Invalid width (must be 64-2048, divisible by 64)' });
    }
    if (!Number.isInteger(validHeight) || validHeight < 64 || validHeight > 2048 || validHeight % 64 !== 0) {
      return res.status(400).json({ error: 'Invalid height (must be 64-2048, divisible by 64)' });
    }
    if (!Number.isInteger(validSteps) || validSteps < 1 || validSteps > 100) {
      return res.status(400).json({ error: 'Invalid steps (must be 1-100)' });
    }
    if (typeof validCfgScale !== 'number' || validCfgScale < 1 || validCfgScale > 20) {
      return res.status(400).json({ error: 'Invalid CFG scale (must be 1-20)' });
    }
    
    // Validate optional parameters
    let validSeed = undefined;
    if (seed !== undefined) {
      validSeed = Number(seed);
      if (!Number.isInteger(validSeed) || validSeed < 0 || validSeed > 4294967295) {
        return res.status(400).json({ error: 'Invalid seed (must be 0-4294967295)' });
      }
    }
    
    let validScheduler = undefined;
    if (scheduler !== undefined) {
      validScheduler = String(scheduler);
      const allowedSchedulers = ['euler', 'euler_a', 'heun', 'dpm_2', 'dpm_2_a', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_a', 'dpmpp_sde', 'dpmpp_2m', 'ddim', 'uni_pc', 'uni_pc_bh2'];
      if (!allowedSchedulers.includes(validScheduler)) {
        return res.status(400).json({ error: 'Invalid scheduler' });
      }
    }
    
    // Use provided values or fallback to configured defaults
    const taskUUID = crypto.randomUUID();
    const requestBody = [{
      taskType: 'imageInference',
      taskUUID,
      includeCost: true,
      positivePrompt: cleanPrompt,
      model: model || runtimeConfig.runware.model,
      numberResults: 1,
      outputFormat: 'WEBP',
      width: validWidth,
      height: validHeight,
      steps: validSteps,
      CFGScale: validCfgScale,
      outputType: 'URL',
      ...(validSeed !== undefined && { seed: validSeed }),
      ...(validScheduler && { scheduler: validScheduler })
    }];
    
    const startedAt = Date.now();
    const promptPreview = cleanPrompt.slice(0, 80).replace(/\s+/g, ' ');
    console.log('[RUNWARE] model=', requestBody[0].model, 'size=', requestBody[0].width, 'x', requestBody[0].height, 'steps=', requestBody[0].steps, 'promptPreview="', promptPreview, '..."');
    
    const response = await fetch('https://api.runware.ai/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${runtimeConfig.runware.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('[RUNWARE] HTTP', response.status, errorText);
      return res.status(response.status).json({ 
        error: `Runware API error ${response.status}`,
        details: errorText
      });
    }
    
    const data = await response.json();
    
    const responseTime = Date.now() - startedAt;
    
    // Log response structure for debugging
    console.log(`[RUNWARE] Response structure:`, JSON.stringify(data, null, 2));
    
    // Log cost information if available
    if (Array.isArray(data) && data.length > 0) {
      const result = data[0];
      if (result.cost !== undefined) {
        console.log(`[RUNWARE] ok in ${responseTime}ms | cost: $${Number(result.cost).toFixed(6)} | model: ${requestBody[0].model} | size: ${requestBody[0].width}x${requestBody[0].height} | id: ${taskUUID}`);
      } else {
        console.log(`[RUNWARE] ok in ${responseTime}ms | model: ${requestBody[0].model} | size: ${requestBody[0].width}x${requestBody[0].height} | id: ${taskUUID}`);
      }
      
      // Log any additional cost details if present
      if (result.costDetails) {
        console.log(`[RUNWARE] Cost breakdown: ${JSON.stringify(result.costDetails)}`);
      }
    } else {
      console.log(`[RUNWARE] ok in ${responseTime}ms | id: ${taskUUID}`);
      console.log(`[RUNWARE] Unexpected response format:`, data);
    }
    
    // Return the generated image data
    res.json({
      taskUUID,
      success: true,
      data
    });
  } catch (err) {
    console.error('[RUNWARE]', err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    res.status(status).json({ 
      error: 'Failed to generate image', 
      details: err?.message 
    });
  }
});

// Runware: list available models
app.get('/api/runware/models', async (req, res) => {
  try {
    assertEnv(runtimeConfig.runware.apiKey, 'Missing RUNWARE_API_KEY');
    
    const response = await fetch('https://api.runware.ai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${runtimeConfig.runware.apiKey}`
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('[RUNWARE] Models API HTTP', response.status, errorText);
      return res.status(response.status).json({ 
        error: `Runware models API error ${response.status}`,
        details: errorText
      });
    }
    
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[RUNWARE] Models fetch error:', err);
    const status = /Missing|not configured/i.test(err?.message || '') ? 400 : 500;
    res.status(status).json({ 
      error: 'Failed to fetch Runware models', 
      details: err?.message 
    });
  }
});

// fal.ai: text-to-image generation
app.post('/api/falai/generate', async (req, res) => {
  try {
    if (!runtimeConfig.falai.enabled) {
      return res.status(400).json({ error: 'fal.ai image generation is disabled' });
    }

    const { prompt, model, width, height, steps, cfgScale } = req.body;
    assertEnv(runtimeConfig.falai.apiKey, 'Missing FALAI_API_KEY');

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required and must be a non-empty string' });
    }
    
    // Validate prompt to prevent injection attacks
    const cleanPrompt = prompt.trim();
    if (cleanPrompt.length > 5000) {
      return res.status(400).json({ error: 'Prompt too long (max 5000 characters)' });
    }
    
    // Validate numeric parameters
    const validWidth = Number(width || runtimeConfig.falai.width);
    const validHeight = Number(height || runtimeConfig.falai.height);
    const validSteps = Number(steps || runtimeConfig.falai.steps);
    const validCfgScale = Number(cfgScale || runtimeConfig.falai.cfgScale);
    
    if (!Number.isInteger(validWidth) || validWidth < 64 || validWidth > 2048 || validWidth % 64 !== 0) {
      return res.status(400).json({ error: 'Invalid width (must be 64-2048, divisible by 64)' });
    }
    if (!Number.isInteger(validHeight) || validHeight < 64 || validHeight > 2048 || validHeight % 64 !== 0) {
      return res.status(400).json({ error: 'Invalid height (must be 64-2048, divisible by 64)' });
    }
    if (!Number.isInteger(validSteps) || validSteps < 1 || validSteps > 100) {
      return res.status(400).json({ error: 'Invalid steps (must be 1-100)' });
    }
    if (typeof validCfgScale !== 'number' || validCfgScale < 1 || validCfgScale > 20) {
      return res.status(400).json({ error: 'Invalid CFG scale (must be 1-20)' });
    }

    const requestBody = {
      prompt: cleanPrompt,
      model: model || runtimeConfig.falai.model,
      width: validWidth,
      height: validHeight,
      steps: validSteps,
      cfg_scale: validCfgScale,
      num_images: 1
    };

    const promptPreview = cleanPrompt.length > 50 ? cleanPrompt.slice(0, 50) : cleanPrompt;
    console.log('[FALAI] model=', requestBody.model, 'size=', requestBody.width, 'x', requestBody.height, 'steps=', requestBody.steps, 'promptPreview="', promptPreview, '..."');

    const startTime = Date.now();
    const response = await fetch('https://fal.run/fal-ai/fast-sdxl', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${runtimeConfig.falai.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[FALAI] HTTP', response.status, errorText);
      return res.status(response.status).json({
        error: `fal.ai API error ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();
    const responseTime = Date.now() - startTime;

    console.log(`[FALAI] Response structure:`, JSON.stringify(data, null, 2));

    // fal.ai returns the image data directly
    if (data && data.images && Array.isArray(data.images) && data.images.length > 0) {
      const { cost: inferredCost, details: costDetails } = computeFalaiCostFromInference(
        requestBody.model,
        data.timings || { inference: responseTime / 1000 },
        { width: requestBody.width, height: requestBody.height, numImages: requestBody.num_images || 1 }
      );

      const result = {
        data: [{
          url: data.images[0].url,
          width: requestBody.width,
          height: requestBody.height,
          model: requestBody.model,
          prompt: requestBody.prompt,
          cost: Number(inferredCost || 0),
          costDetails: costDetails || {}
        }],
        cost: Number(inferredCost || 0),
        costDetails: costDetails || {},
        taskUUID: data.task_id || `falai_${Date.now()}`
      };

      console.log(`[FALAI] ok in ${responseTime}ms | cost: $${Number(result.cost).toFixed(6)} | model: ${requestBody.model} | size: ${requestBody.width}x${requestBody.height} | id: ${result.taskUUID}`);
      if (result.costDetails && Object.keys(result.costDetails).length > 0) {
        console.log(`[FALAI] Cost breakdown: ${JSON.stringify(result.costDetails)}`);
      }
      res.json(result);
    } else {
      console.log(`[FALAI] ok in ${responseTime}ms | id: falai_${Date.now()}`);
      console.log(`[FALAI] Unexpected response format:`, data);
      res.status(500).json({ error: 'Unexpected response format from fal.ai API' });
    }
  } catch (err) {
    console.error('[FALAI]', err);
    res.status(500).json({
      error: 'Failed to generate image',
      details: err.message
    });
  }
});

// Persist an external image to local cache and link to an existing exercise
app.post('/api/cache/exercise-image', async (req, res) => {
  try {
    // Rate limiting for file system access
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
    }
    
    if (!cacheLayout) return res.status(503).json({ error: 'Cache not initialized' });
    const { exerciseSha, url, baseTextId, chapterNumber } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    
    // Validate exerciseSha if provided to prevent path traversal
    if (exerciseSha !== undefined && exerciseSha !== null) {
      if (typeof exerciseSha !== 'string' || !/^[a-f0-9]{12,64}$/.test(exerciseSha)) {
        return res.status(400).json({ error: 'Invalid exerciseSha format' });
      }
    }
    
    // Validate URL to prevent SSRF
    try {
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return res.status(400).json({ error: 'Invalid URL protocol' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    // Choose a storage key: prefer exerciseSha; otherwise derive a deterministic key from baseTextId+chapter+url
    const storageKey = exerciseSha || (baseTextId ? sha256Hex(`${baseTextId}:${chapterNumber ?? 'cover'}:${url}`).slice(0, 32) : null);
    if (!storageKey) {
      return res.status(400).json({ error: 'exerciseSha or baseTextId is required' });
    }

    const dl = await downloadImageToCache({ imagesDir: cacheLayout.imagesDir, exerciseSha: storageKey, url, fetchImpl: fetch, publicBase: '/cache/images' });
    // Update exercise record to reference local image
    if (exerciseSha) {
      await updateExerciseRecord(cacheLayout, exerciseSha, (rec) => {
        const updated = { ...rec, localImagePath: dl.localPath, localImageUrl: dl.localUrl };
        return updated;
      });
    }

    // If this image is associated with a base text, persist it under the base text record as well
    if (baseTextId) {
      try {
        const idx = await loadBaseTextsIndex(cacheLayout);
        let baseKey = null;
        for (const [key, entry] of Object.entries(idx.items || {})) {
          const meta = entry?.meta || {};
          if (String(meta.baseTextId || '').trim() === String(baseTextId).trim()) {
            baseKey = key; break;
          }
        }
        if (baseKey) {
          await updateBaseTextRecord(cacheLayout, baseKey, (rec) => {
            const content = rec?.content || rec;
            const images = content.images && typeof content.images === 'object' ? content.images : { cover: null, chapters: {} };
            // Decide target slot: chapter-specific or cover
            if (typeof chapterNumber === 'number') {
              images.chapters = images.chapters || {};
              images.chapters[String(chapterNumber)] = {
                localUrl: dl.localUrl,
                localPath: dl.localPath,
                filename: dl.filename,
                contentType: dl.contentType || null,
                updatedAt: new Date().toISOString()
              };
            } else if (!images.cover) {
              images.cover = {
                localUrl: dl.localUrl,
                localPath: dl.localPath,
                filename: dl.filename,
                contentType: dl.contentType || null,
                updatedAt: new Date().toISOString()
              };
            }
            content.images = images;
            return { ...rec, content };
          });
        }
      } catch (e) {
        console.warn('[CACHE-IMG] Failed to annotate base text with image:', e?.message);
      }
    }
    return res.json({ ok: true, localUrl: dl.localUrl, localPath: dl.localPath });
  } catch (e) {
    console.error('[CACHE-IMG]', e);
    return res.status(500).json({ error: e?.message || 'Failed to cache exercise image' });
  }
});

// fal.ai: list available models
app.get('/api/falai/models', async (req, res) => {
  try {
    assertEnv(runtimeConfig.falai.apiKey, 'Missing FALAI_API_KEY');

    // fal.ai has a limited set of models, return the most common ones
    const models = [
      { id: 'fal-ai/fast-sdxl', name: 'Fast SDXL', description: 'Fast Stable Diffusion XL model' },
      { id: 'fal-ai/fast-lightning-sdxl', name: 'Fast Lightning SDXL', description: 'Ultra-fast SDXL model' },
      { id: 'fal-ai/fast-sdxl-turbo', name: 'Fast SDXL Turbo', description: 'Fast SDXL Turbo model' },
      { id: 'fal-ai/fast-sdxl-1.0', name: 'Fast SDXL 1.0', description: 'Fast SDXL 1.0 model' }
    ];

    res.json({ models });
  } catch (err) {
    console.error('[FALAI] Models fetch error:', err);
    res.status(500).json({
      error: 'Failed to fetch fal.ai models',
      details: err.message
    });
  }
});

// Logging endpoint for frontend validation warnings and errors
app.post('/api/log', (req, res) => {
  try {
    const { level = 'info', message, data } = req.body;
    
    // Validate log level
    const validLevels = ['debug', 'info', 'warn', 'error'];
    const logLevel = validLevels.includes(level) ? level : 'info';
    
    // Format the log message
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${logLevel.toUpperCase()}] ${message}`;
    
    // Log to console with appropriate level
    switch (logLevel) {
      case 'error':
        console.error(logMessage, data || '');
        break;
      case 'warn':
        console.warn(logMessage, data || '');
        break;
      case 'debug':
        console.debug(logMessage, data || '');
        break;
      default:
        console.log(logMessage, data || '');
    }
    
    // Store in debug logs for debugging purposes
    const id = Math.random().toString(36).slice(2, 8);
    debugLogs.set(id, {
      id,
      timestamp,
      level: logLevel,
      message,
      data,
      source: 'frontend'
    });
    debugOrder.push(id);
    
    // Keep only last 100 debug records
    if (debugOrder.length > 100) {
      const oldId = debugOrder.shift();
      debugLogs.delete(oldId);
    }
    
    res.json({ success: true, logged: true, id });
  } catch (e) {
    console.error('[LOG] Failed to process log entry:', e);
    res.status(500).json({ error: 'Failed to log entry' });
  }
});

// Debug endpoints: expose last N LLM debug records
app.get('/api/debug/:id', (req, res) => {
  const id = req.params.id;
  const record = debugLogs.get(id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

app.get('/api/debug', (req, res) => {
  const list = debugOrder.slice().reverse().map(id => debugLogs.get(id));
  res.json({ count: list.length, items: list });
});

// Simple in-memory rate limiter for file system access
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // max 10 requests per minute per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }
  
  const requests = rateLimitStore.get(ip);
  // Remove old requests outside the window
  const validRequests = requests.filter(timestamp => timestamp > windowStart);
  
  if (validRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limited
  }
  
  // Add current request
  validRequests.push(now);
  rateLimitStore.set(ip, validRequests);
  return true; // Allowed
}

// Clean up old rate limit data periodically
setInterval(() => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  for (const [ip, requests] of rateLimitStore.entries()) {
    const validRequests = requests.filter(timestamp => timestamp > windowStart);
    if (validRequests.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, validRequests);
    }
  }
}, RATE_LIMIT_WINDOW);

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
  console.log(`[RUNWARE] Startup - API key loaded: ${!!runtimeConfig.runware.apiKey}, enabled: ${runtimeConfig.runware.enabled}`);
  console.log(`[RUNWARE] Environment - API key: ${!!process.env.RUNWARE_API_KEY}, enabled: ${process.env.RUNWARE_ENABLED}`);
  console.log(`[FALAI] Startup - API key loaded: ${!!runtimeConfig.falai.apiKey}, enabled: ${runtimeConfig.falai.enabled}`);
  console.log(`[FALAI] Environment - API key: ${!!process.env.FALAI_API_KEY}, enabled: ${process.env.FALAI_ENABLED}`);
});
