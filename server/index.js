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
  }
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

async function callLLM({ system, user, maxTokens = 15000, jsonSchema, schemaName }) {
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

// Generic LLM generation endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const { system, user, maxTokens = 3000, jsonSchema, schemaName } = req.body || {};
    if (!user || !String(user).trim()) return res.status(400).json({ error: 'User prompt is required' });
    
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ 
      system, 
      user, 
      maxTokens, 
      jsonSchema: useStructured ? jsonSchema : undefined, 
      schemaName 
    });
    
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
    return res.status(status).json({ error: 'Failed to generate content', details: err?.message, provider: runtimeConfig.provider });
  }
});

// Routes
app.post('/api/generate-exercises', async (req, res) => {
  try {
    const { topic, exerciseCount = 10 } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const c = buildCounts(exerciseCount, 1, 20, 10);
    const system = `Generate Spanish fill-in-the-blank exercises with exactly five underscores (_____) for blanks.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        exercises: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              sentence: { type: 'string' },
              answer: { type: 'string' },
              hint: { type: 'string' },
              hints: { type: 'array', items: { type: 'string' } },
              context: { type: 'string' }
            },
            required: ['sentence', 'answer']
          }
        }
      },
      required: ['exercises']
    };
    const user = `Create exactly ${c} Spanish fill-in-the-blank exercises about: ${topic}.

Rules:
- Use exactly _____ (5 underscores) for each blank
- Put basic hint in parentheses after the blank
- Provide up to 3 progressive hints in the "hints" array:
  - First hint: general guidance to help user think
  - Second hint: more specific clue
  - Third hint: very specific (e.g., "starts with 'vi...'")
- If exercise is simple, you can provide fewer hints or make the third hint show first letters
- "context" field is optional - include interesting cultural notes, regional differences, or usage tips when relevant
- Make exercises progressively harder`;
    
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, maxTokens: 4000, jsonSchema: useStructured ? schema : undefined, schemaName: 'exercise_list' });
    let parsed;
    try {
      parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
    } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    return res.json({ exercises: parsed.exercises || [] });
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate exercises', details: err?.message, provider: runtimeConfig.provider });
  }
});

function buildCounts(rawCount, min, max, fallback) {
  const n = Number(rawCount);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return fallback;
}

// On-demand: explanation only
app.post('/api/generate/explanation', async (req, res) => {
  try {
    const { topic, language = 'es' } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const system = `You are a language pedagogy expert. Provide a concise, insightful explanation of a Spanish grammar concept with examples and counterexamples.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short title of the concept' },
        content_markdown: { type: 'string', description: 'Well-structured markdown with headings and examples' }
      },
      required: ['title', 'content_markdown']
    };
    const user = `Explain the grammar concept: ${topic}. Language for examples: ${language}. Keep it 200-400 words.`;
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, maxTokens: 2500, jsonSchema: useStructured ? schema : undefined, schemaName: 'explanation' });
    console.log('[EXPLANATION RAW]', (text || '').slice(0, 500));
    let parsed;
    try { parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text); } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate explanation', details: err?.message, provider: runtimeConfig.provider });
  }
});

// On-demand: fill-in-blanks only
app.post('/api/generate/fib', async (req, res) => {
  try {
    const { topic, count = 5 } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const c = buildCounts(count, 1, 20, 5);
    const system = `Generate Spanish fill-in-the-blank exercises with exactly five underscores (_____) for blanks.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        items: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              sentence: { type: 'string' },
              answers: { type: 'array', items: { type: 'string' } },
              hint: { type: 'string' },
              hints: { type: 'array', items: { type: 'string' } },
              context: { type: 'string' },
              difficulty: { type: 'string' }
            },
            required: ['sentence','answers','difficulty']
          }
        }
      },
      required: ['items']
    };
    const user = `Create exactly ${c} items about: ${topic}. Keep progressive difficulty.`;
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, maxTokens: 3000, jsonSchema: useStructured ? schema : undefined, schemaName: 'fib_list' });
    console.log('[FIB RAW]', (text || '').slice(0, 500));
    let parsed;
    try { parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text); } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate FIB', details: err?.message, provider: runtimeConfig.provider });
  }
});

// On-demand: MCQ only
app.post('/api/generate/mcq', async (req, res) => {
  try {
    const { topic, count = 5 } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const c = buildCounts(count, 1, 20, 5);
    const system = `Generate Spanish multiple-choice questions with 4 options, one correct, with rationales.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        items: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              question: { type: 'string' },
              options: { type: 'array', minItems: 4, maxItems: 4, items: {
                type: 'object', additionalProperties: false,
                properties: { text: { type: 'string' }, correct: { type: 'boolean' }, rationale: { type: 'string' } },
                required: ['text','correct','rationale']
              }},
              explanation: { type: 'string' },
              difficulty: { type: 'string' }
            },
            required: ['question','options','difficulty']
          }
        }
      },
      required: ['items']
    };
    const user = `Create exactly ${c} MCQs about: ${topic}. Include plausible distractors.`;
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, maxTokens: 3000, jsonSchema: useStructured ? schema : undefined, schemaName: 'mcq_list' });
    console.log('[MCQ RAW]', (text || '').slice(0, 500));
    let parsed;
    try { parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text); } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    console.log('[MCQ PARSED COUNT]', Array.isArray(parsed.items) ? parsed.items.length : 0);
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate MCQ', details: err?.message, provider: runtimeConfig.provider });
  }
});

// On-demand: Cloze passages only
app.post('/api/generate/cloze', async (req, res) => {
  try {
    const { topic, count = 2 } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const c = buildCounts(count, 1, 10, 2);
    const system = `Generate Spanish cloze passages with several blanks (_____). Include an answers array with index and answer.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        items: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' },
              passage: { type: 'string' },
              blanks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                index: { type: 'integer' }, answer: { type: 'string' }, hint: { type: 'string' }, rationale: { type: 'string' }
              }, required: ['index','answer'] }},
              difficulty: { type: 'string' }
            },
            required: ['passage','blanks','difficulty']
          }
        }
      },
      required: ['items']
    };
    const user = `Create exactly ${c} cloze passages about: ${topic}.`;
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, maxTokens: 3500, jsonSchema: useStructured ? schema : undefined, schemaName: 'cloze_list' });
    console.log('[CLOZE RAW]', (text || '').slice(0, 500));
    let parsed;
    try { parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text); } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate cloze', details: err?.message, provider: runtimeConfig.provider });
  }
});

// On-demand: Cloze with mixed options
app.post('/api/generate/cloze-mixed', async (req, res) => {
  try {
    const { topic, count = 2 } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const c = buildCounts(count, 1, 10, 2);
    const system = `Generate Spanish cloze passages where each blank has a set of options including the target concept and closely-related distractors.`;
    const schema = {
      type: 'object', additionalProperties: false,
      properties: {
        items: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' },
              passage: { type: 'string' },
              blanks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                index: { type: 'integer' }, options: { type: 'array', items: { type: 'string' }, minItems: 3 }, correct_index: { type: 'integer' }
              }, required: ['index','options','correct_index'] }},
              difficulty: { type: 'string' }
            },
            required: ['passage','blanks','difficulty']
          }
        }
      },
      required: ['items']
    };
    const user = `Create exactly ${c} cloze-with-options passages about: ${topic}.`;
    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({ system, user, maxTokens: 3500, jsonSchema: useStructured ? schema : undefined, schemaName: 'cloze_mixed_list' });
    console.log('[CLOZE MIX RAW]', (text || '').slice(0, 500));
    let parsed;
    try { parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text); } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate cloze-mixed', details: err?.message, provider: runtimeConfig.provider });
  }
});

app.post('/api/generate-content', async (req, res) => {
  try {
    const { topic, language = 'es', counts } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });

    const safeCounts = {
      explanation: Math.max(1, Math.min(1, Number(counts?.explanation ?? 1))),
      fill_in_blanks: Math.max(1, Math.min(20, Number(counts?.fill_in_blanks ?? 10))),
      multiple_choice: Math.max(0, Math.min(20, Number(counts?.multiple_choice ?? 5))),
      cloze_passages: Math.max(0, Math.min(10, Number(counts?.cloze_passages ?? 2))),
      cloze_with_mixed_options: Math.max(0, Math.min(10, Number(counts?.cloze_with_mixed_options ?? 2))),
    };

    const system = `You are a language pedagogy expert and curriculum designer. Create high-quality, level-appropriate Spanish learning content using:\n\n- Scaffolding: start simple, gradually increase complexity\n- Spiraling: revisit the same concept in varied contexts to deepen understanding\n- Retrieval practice: reinforce memory through spaced repetition and varied prompts\n- Clear, concise explanations with examples and counterexamples\n\nUse exactly five underscores \"_____\" for blanks. Keep content culturally neutral unless context is requested. Avoid offensive or sensitive topics.`;


    const constraints = `Requirements:\n- Provide exactly ${safeCounts.explanation} explanation section(s)\n- Provide exactly ${safeCounts.fill_in_blanks} fill_in_blanks items\n- Provide exactly ${safeCounts.multiple_choice} multiple_choice items (if 0, provide empty array)\n- Provide exactly ${safeCounts.cloze_passages} cloze_passages items (if 0, provide empty array)\n- Provide exactly ${safeCounts.cloze_with_mixed_options} cloze_with_mixed_options items (if 0, provide empty array)\n- MCQ: exactly 4 options per question, 1 correct, distractors should be plausible (common learner confusions)\n- Use grammar-focused content specifically about: ${topic}\n- Progression: start simpler (A2/B1) and reach more complex usage (B2/C1) where applicable\n- Keep explanations concise but insightful (200-400 words)\n- Use Spanish for examples; English is allowed for meta-explanations in explanation.content_markdown`;

    const user = `${schema}\n\n${constraints}`;

    // Build JSON schema for structured outputs if supported
    const lessonSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string' },
        language: { type: 'string' },
        topic: { type: 'string' },
        pedagogy: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approach: { type: 'string' },
            strategy_notes: { type: 'string' }
          },
          required: ['approach', 'strategy_notes']
        },
        explanation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            content_markdown: { type: 'string' }
          },
          required: ['title', 'content_markdown']
        },
        fill_in_blanks: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              sentence: { type: 'string' },
              answers: { type: 'array', items: { type: 'string' } },
              hint: { type: 'string' },
              hints: { type: 'array', items: { type: 'string' } },
              context: { type: 'string' },
              difficulty: { type: 'string' }
            },
            required: ['sentence', 'answers', 'difficulty']
          }
        },
        multiple_choice: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              question: { type: 'string' },
              options: {
                type: 'array', minItems: 4, maxItems: 4,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    text: { type: 'string' },
                    correct: { type: 'boolean' },
                    rationale: { type: 'string' }
                  },
                  required: ['text', 'correct', 'rationale']
                }
              },
              explanation: { type: 'string' },
              difficulty: { type: 'string' }
            },
            required: ['question', 'options', 'difficulty']
          }
        },
        cloze_passages: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' },
              passage: { type: 'string' },
              blanks: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    answer: { type: 'string' },
                    hint: { type: 'string' },
                    rationale: { type: 'string' }
                  },
                  required: ['index', 'answer']
                }
              },
              context: { type: 'string' },
              difficulty: { type: 'string' }
            },
            required: ['passage', 'blanks', 'difficulty']
          }
        },
        cloze_with_mixed_options: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' },
              passage: { type: 'string' },
              blanks: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    options: { type: 'array', items: { type: 'string' }, minItems: 3 },
                    correct_index: { type: 'integer' },
                    rationale: { type: 'string' }
                  },
                  required: ['index', 'options', 'correct_index']
                }
              },
              notes: { type: 'string' },
              difficulty: { type: 'string' }
            },
            required: ['passage', 'blanks', 'difficulty']
          }
        }
      },
      required: ['version','language','topic','pedagogy','explanation','fill_in_blanks','multiple_choice','cloze_passages','cloze_with_mixed_options']
    };

    const useStructured = ['openrouter', 'ollama'].includes(runtimeConfig.provider);
    const text = await callLLM({
      system,
      user,
      maxTokens: 8000,
      jsonSchema: useStructured ? lessonSchema : undefined,
      schemaName: 'lesson_bundle'
    });
    let parsed;
    try {
      parsed = useStructured ? JSON.parse(text) : tryParseJsonLoose(text);
    } catch (e) {
      console.error('[PARSE]', e.message, e.rawPreview || '');
      return res.status(502).json({ error: 'Upstream returned invalid JSON', details: e.message, provider: runtimeConfig.provider });
    }
    // Minimal shape sanity
    parsed.version = parsed.version || '1.0';
    parsed.language = parsed.language || language;
    parsed.topic = parsed.topic || topic;
    parsed.pedagogy = parsed.pedagogy || { approach: 'scaffolded+spiral', strategy_notes: '' };
    parsed.fill_in_blanks = Array.isArray(parsed.fill_in_blanks) ? parsed.fill_in_blanks : [];
    parsed.multiple_choice = Array.isArray(parsed.multiple_choice) ? parsed.multiple_choice : [];
    parsed.cloze_passages = Array.isArray(parsed.cloze_passages) ? parsed.cloze_passages : [];
    parsed.cloze_with_mixed_options = Array.isArray(parsed.cloze_with_mixed_options) ? parsed.cloze_with_mixed_options : [];
    return res.json(parsed);
  } catch (err) {
    console.error(err);
    const status = /Missing/i.test(err?.message || '') ? 400 : 500;
    return res.status(status).json({ error: 'Failed to generate lesson content', details: err?.message, provider: runtimeConfig.provider });
  }
});

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
    const text = await callLLM({ system, user, maxTokens: 2000, jsonSchema: useStructured ? schema : undefined, schemaName: 'explanation' });
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
    const text = await callLLM({ system, user, maxTokens: 2000, jsonSchema: useStructured ? schema : undefined, schemaName: 'recommendation' });
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


