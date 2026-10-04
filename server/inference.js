// ChatGPT plan inference uses the public Responses API, never a shared API key.
const API_URL = 'https://api.openai.com/v1';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 3 * 1024 * 1024;

export class InferenceError extends Error {
  constructor(message, status = 502, code = 'inference_failed', requestId) {
    super(message);
    this.name = 'InferenceError';
    this.status = this.httpStatus = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const RECOVERY = {
  subscription_sharing_user_not_eligible: [403, 'Your ChatGPT account or workspace is not eligible to use its plan here.'],
  subscription_sharing_usage_limit_exceeded: [429, 'Your ChatGPT usage limit for this app has been reached. Review your limits in ChatGPT Settings → Usage.'],
  subscription_sharing_usage_unavailable: [503, 'ChatGPT usage is temporarily unavailable. Please try again later.'],
  subscription_sharing_user_unavailable: [503, 'Your ChatGPT workspace is temporarily unavailable. Please try again later.'],
  subscription_sharing_unsupported_capability: [400, 'The selected model cannot perform this request. Choose another model.'],
  subscription_sharing_route_not_supported: [403, 'ChatGPT plan usage is not enabled for this integration. Contact the site owner.'],
  subscription_sharing_invalid_user: [401, 'ChatGPT could not verify this connection. Please sign in again.'],
  chatpass_v2_scope_not_authorized: [403, 'This connection does not have permission to use your ChatGPT plan.'],
  chatpass_v2_invalid_authorization_context: [403, 'ChatGPT plan access is not configured correctly. Contact the site owner.'],
};

function upstreamError(status, body, requestId) {
  const upstream = body?.error || body?.response?.error || body || {};
  // Codes are useful diagnostics; raw upstream messages may contain private input.
  const code = typeof upstream.code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(upstream.code)
    ? upstream.code : 'inference_failed';
  const known = RECOVERY[code];
  const message = known?.[1] || ({
    401: 'Your ChatGPT connection needs attention. Please sign in again.',
    403: 'ChatGPT declined this request. Check your account permissions and site configuration.',
    429: 'ChatGPT is limiting requests. Please try again later or review your usage settings.',
    503: 'ChatGPT is temporarily unavailable. Please try again later.',
  }[status]) || 'ChatGPT could not complete this request. Please try again.';
  const error = new InferenceError(message, known?.[0] || (status >= 400 && status <= 599 ? status : 502), code, requestId);
  if (typeof upstream.param === 'string' && /^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(upstream.param)) error.param = upstream.param;
  return error;
}

function schemaForResponses(schema, depth = 0) {
  if (depth > 30) throw new InferenceError('The exercise schema is too deeply nested.', 400, 'invalid_schema');
  if (Array.isArray(schema)) return schema.map(value => schemaForResponses(value, depth + 1));
  if (!schema || typeof schema !== 'object') return schema;
  const output = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, schemaForResponses(value, depth + 1)]));
  if (output.type === 'object' && output.properties) {
    output.additionalProperties = false;
    output.required = Object.keys(output.properties);
  }
  return output;
}

/** Consume SSE through a terminal event. Partial output is never a successful lesson. */
export async function readResponseStream(response, { onDelta, signal } = {}) {
  const contentType = response.headers.get('content-type');
  // Some live plan responses omit Content-Type despite carrying valid SSE.
  // The parser still requires valid events and an explicit completed response.
  if (!response.body || (contentType && !/text\/event-stream/i.test(contentType))) {
    throw new InferenceError('ChatGPT returned an unexpected response.', 502, 'invalid_stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const requestId = response.headers.get('x-request-id') || response.headers.get('openai-request-id') || undefined;
  let buffer = '', text = '', outputBytes = 0, completed = false;
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  function parseFrame(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); }
    catch { throw new InferenceError('ChatGPT returned an unreadable stream.', 502, 'invalid_stream'); }
    if (event.type === 'response.output_text.delta') {
      if (typeof event.delta !== 'string') throw new InferenceError('ChatGPT returned an unreadable stream.', 502, 'invalid_stream');
      outputBytes += Buffer.byteLength(event.delta);
      if (outputBytes > MAX_OUTPUT_BYTES) throw new InferenceError('The generated lesson was too large. Try a smaller request.', 502, 'output_too_large');
      text += event.delta;
      onDelta?.(event.delta);
    } else if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed') throw new InferenceError('ChatGPT did not finish the response.', 502, 'incomplete_response');
      const content = (event.response.output || []).flatMap(item => item.type === 'message' ? item.content || [] : []);
      if (content.some(item => item.type === 'refusal')) throw new InferenceError('ChatGPT declined to generate this lesson. Try another topic.', 422, 'generation_refused');
      // The final output is authoritative; it also covers streams without deltas.
      const finalText = content.filter(item => item.type === 'output_text').map(item => item.text || '').join('');
      if (finalText) text = finalText;
      if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new InferenceError('The generated lesson was too large.', 502, 'output_too_large');
      completed = true;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw upstreamError(502, event.response || event, requestId);
    } else if (event.type === 'response.incomplete') {
      throw new InferenceError('ChatGPT stopped before finishing the lesson. Please try again.', 502, 'incomplete_response', requestId);
    } else if (event.type === 'response.refusal.delta') {
      throw new InferenceError('ChatGPT declined to generate this lesson. Try another topic.', 422, 'generation_refused', requestId);
    }
  }
  try {
    while (!completed) {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) throw new InferenceError('ChatGPT returned an oversized event.', 502, 'output_too_large');
        parseFrame(frame);
        if (completed) break;
      }
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw new InferenceError('ChatGPT returned an oversized event.', 502, 'output_too_large');
      if (done) {
        if (buffer.trim() && !completed) parseFrame(buffer);
        break;
      }
    }
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    if (!completed) throw new InferenceError('The connection ended before ChatGPT finished. Please try again.', 502, 'interrupted_stream', requestId);
    if (!text.trim()) throw new InferenceError('ChatGPT returned an empty lesson. Please try again.', 502, 'empty_response', requestId);
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createInference({ auth, fetchImpl = fetch, baseUrl = API_URL, timeoutMs = 120_000, catalogTtlMs = 60_000 } = {}) {
  if (!auth) throw new Error('Inference requires the account authentication service.');
  const accounts = new Map();
  const requestModel = Symbol('chatgptModel');
  const endpoint = new URL(baseUrl);
  if (endpoint.origin !== 'https://api.openai.com' && !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('The inference endpoint must be OpenAI or a loopback test fixture.');
  }
  function state(req) {
    const id = req.auth?.accountId;
    if (!id) throw new InferenceError('Please sign in with ChatGPT.', 401, 'sign_in_required');
    if (!accounts.has(id)) {
      // Bound inactive preference/catalog state. No credentials are stored here.
      if (accounts.size >= 1000) accounts.delete(accounts.keys().next().value);
      accounts.set(id, { models: [], selected: null, fetchedAt: 0 });
    }
    return accounts.get(id);
  }
  async function request(req, pathname, options, consume) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = [req.inferenceSignal, req.auth?.signal].filter(Boolean);
    const externalSignal = signals.length ? AbortSignal.any(signals) : undefined;
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    try {
      const token = await auth.getAccessToken(req.auth);
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${pathname}`, {
        ...options,
        headers: { accept: 'application/json', ...options?.headers, authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        let body;
        try { body = await response.json(); } catch {}
        throw upstreamError(response.status, body, response.headers.get('x-request-id') || response.headers.get('openai-request-id'));
      }
      return await consume(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new InferenceError(externalSignal?.aborted ? 'The request was cancelled.' : 'ChatGPT took too long to respond. Please try again.', externalSignal?.aborted ? 499 : 504, externalSignal?.aborted ? 'request_cancelled' : 'inference_timeout');
      if (error instanceof InferenceError || error.status) throw error;
      throw new InferenceError('Could not connect to ChatGPT. Please try again later.', 503, 'upstream_unavailable');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
  async function loadModels(req, force = false) {
    const entry = state(req);
    // Validate the session even on a cached catalog hit (logout/expiry/consent).
    await auth.getAccessToken(req.auth);
    if (!force && entry.models.length && Date.now() - entry.fetchedAt < catalogTtlMs) return entry;
    // Each cold lookup belongs to its own request/session. Sharing an in-flight
    // lookup would let a closing tab or logging-out session cancel other users
    // of the same account. Completed catalogs are still cached per account.
    await request(req, 'models', {}, async response => {
        const body = await response.json();
        if (!Array.isArray(body.models)) throw new InferenceError('ChatGPT returned an unreadable model catalog.', 502, 'invalid_model_catalog');
        const seen = new Set();
        const models = body.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string' && /^[\w.:-]{1,150}$/.test(model.slug)).filter(model => !seen.has(model.slug) && seen.add(model.slug)).map(model => ({ id: model.slug, name: typeof model.display_name === 'string' ? model.display_name.slice(0,150) : model.slug }));
        if (!models.length) throw new InferenceError('No models are available for this ChatGPT account.', 403, 'no_models_available');
        entry.models = models;
        if (!models.some(model => model.id === entry.selected)) entry.selected = models[0].id;
        entry.fetchedAt = Date.now();
      });
    return entry;
  }
  return {
    async listModels(req) {
      const entry = await loadModels(req);
      return { models: entry.models, selectedModel: entry.selected };
    },
    async getModel(req) {
      await auth.getAccessToken(req.auth);
      // One request must use the same model for its cache key and generation,
      // even if another browser tab changes the account preference meanwhile.
      req[requestModel] ??= (await loadModels(req)).selected;
      return req[requestModel];
    },
    async selectModel(req, model) {
      const entry = await loadModels(req, true);
      if (!entry.models.some(item => item.id === model)) throw new InferenceError('Choose a model available to your ChatGPT account.', 400, 'invalid_model');
      entry.selected = model;
      return model;
    },
    async generate(req, { system, user, jsonSchema, schemaName, onDelta } = {}) {
      if (typeof user !== 'string' || !user.trim() || user.length > 150_000 || (system != null && (typeof system !== 'string' || system.length > 50_000))) {
        throw new InferenceError('Provide a valid lesson request.', 400, 'invalid_prompt');
      }
      const model = await this.getModel(req);
      const body = { model, input: [{ role: 'user', content: user }], store: false, stream: true };
      if (system) body.instructions = system;
      if (jsonSchema) body.text = { format: { type: 'json_schema', name: /^[a-zA-Z0-9_-]{1,64}$/.test(schemaName || '') ? schemaName : 'lesson', strict: true, schema: schemaForResponses(jsonSchema) } };
      return request(req, 'responses', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) }, (response, signal) => readResponseStream(response, { onDelta, signal }));
    },
  };
}
