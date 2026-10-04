// Account and inference credentials stay in the server session. Only its CSRF
// token is held in JavaScript memory; no credentials enter browser storage.
let csrfToken = null;
let sessionRequest = null;
let sessionRevision = 0;

export async function responseError(response) {
  const data = await response.json().catch(() => null);
  // The server maps provider failures to safe, actionable text. Generic route
  // titles (error) should not hide those details, and raw nested provider objects
  // must never become a displayed message.
  const message = [data?.details, data?.message, data?.error]
    .find(value => typeof value === 'string' && value.trim());
  const error = new Error(message || (response.status === 401
    ? 'Your session has expired. Sign in with ChatGPT again.'
    : response.status === 429
      ? 'Your usage limit has been reached. Check your ChatGPT usage and try again later.'
      : `The request failed (${response.status}). Please try again.`));
  error.status = response.status;
  if (typeof data?.code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(data.code)) {
    error.code = data.code;
  }
  if (typeof data?.requestId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(data.requestId)) {
    error.requestId = data.requestId;
  }
  return error;
}

export async function loadSession() {
  if (!sessionRequest) {
    const revision = sessionRevision;
    const request = (async () => {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw await responseError(response);
      const session = await response.json();
      // A read started before an authentication failure must not restore its
      // stale CSRF token or account state after the recovery read has started.
      if (revision !== sessionRevision) return loadSession();
      csrfToken = session.csrfToken || null;
      return session;
    })().finally(() => { if (sessionRequest === request) sessionRequest = null; });
    sessionRequest = request;
  }
  return sessionRequest;
}

export async function apiFetch(url, options = {}) {
  if (typeof url !== 'string' || !url.startsWith('/api/')) {
    throw new Error('API requests must use a same-origin API path.');
  }
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrfToken) await loadSession();
    if (!csrfToken) throw new Error('Could not verify your session. Reload the page and try again.');
    headers.set('x-csrf-token', csrfToken);
  }
  const response = await fetch(url, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const error = await responseError(response);
    if (error.code === 'csrf_failed' || (response.status === 401 && !url.startsWith('/api/auth/'))) {
      csrfToken = null;
      sessionRevision += 1;
      sessionRequest = null;
      window.dispatchEvent(new Event('language-session-expired'));
    }
    // Refresh account state through the UI, but never replay a paid request.
    throw error;
  }
  return response;
}
