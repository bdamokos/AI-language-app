import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { BookOpen, Settings as SettingsIcon } from 'lucide-react';
import SettingsPanel from './SettingsPanel.jsx';
import SavedAccounts from './SavedAccounts.jsx';
import { apiFetch, loadSession } from './utils/api.js';
import { authRedirectUrl } from './utils/authRedirect.js';

const AIPracticeApp = lazy(() => import('./AIPracticeApp.jsx'));

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lessonKey, setLessonKey] = useState(0);
  const busy = pendingAction !== null;
  const localMode = session?.mode === 'local';
  const savedAccounts = localMode && Array.isArray(session.accounts) ? session.accounts : [];

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const current = await loadSession();
      setSession(current);
      return current;
    }
    catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refreshSession();
    const url = new URL(window.location.href);
    const result = url.searchParams.get('auth');
    if (result && result !== 'success') setError('ChatGPT sign-in was not completed. Please try again.');
    if (url.searchParams.get('disconnected') === 'unconfirmed') {
      setNotice('You are signed out here. To finish disconnecting, remove this app in your ChatGPT account settings.');
    }
    if (result || url.searchParams.has('disconnected')) {
      url.searchParams.delete('auth');
      url.searchParams.delete('disconnected');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    const onExpired = async () => {
      setSession(null);
      setSettingsOpen(false);
      window.globalImageStore = {};
      const current = await refreshSession();
      if (current) setError(current.authenticated
        ? 'Your session was refreshed. Please try your request again.'
        : 'Your session has expired. Sign in with ChatGPT again.');
    };
    window.addEventListener('language-session-expired', onExpired);
    return () => window.removeEventListener('language-session-expired', onExpired);
  }, [refreshSession]);

  useEffect(() => {
    if (!session) return;
    let checking = false;
    const checkAccount = async () => {
      if (checking) return;
      checking = true;
      try {
        const current = await loadSession();
        if (current.user?.id !== session.user?.id || current.authenticated !== session.authenticated
            || current.inferenceEnabled !== session.inferenceEnabled) {
          // Another tab may have disconnected or signed in to a different account.
          // Reload to discard its predecessor's lesson state and module caches.
          window.location.reload();
        }
      } catch { /* Keep the existing page usable during a temporary network failure. */ }
      finally { checking = false; }
    };
    window.addEventListener('focus', checkAccount);
    return () => window.removeEventListener('focus', checkAccount);
  }, [session]);

  const signIn = async (accountId) => {
    setPendingAction('login');
    setError('');
    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableInference: true, ...(typeof accountId === 'string' && accountId ? { accountId } : {}) })
      });
      const { url } = await response.json();
      window.location.assign(authRedirectUrl(url, window.location.origin));
    } catch (error) {
      setError(error.message);
      setPendingAction(null);
      if (localMode) {
        // A failed attempt may still have saved a resumable account. Update the
        // chooser while leaving the current account and lesson mounted.
        try { setSession(await loadSession()); } catch { /* Keep the sign-in error visible. */ }
      }
    }
  };

  const signOut = async () => {
    setPendingAction('logout');
    setError('');
    try {
      const response = await apiFetch('/api/auth/logout', { method: 'POST' });
      const result = await response.json();
      // Navigation clears module-level exercise caches and pending UI state too.
      window.location.replace(result.revocationConfirmed === false ? '/?disconnected=unconfirmed' : '/');
    } catch (error) { setError(error.message); setPendingAction(null); }
  };

  const ready = session?.authenticated && session.inferenceEnabled;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold"><BookOpen size={21} className="text-blue-600" /><span>Language practice{localMode && <span className="block text-xs font-normal text-gray-500">On this computer</span>}</span></div>
          {session?.authenticated && <button type="button" aria-label={settingsOpen ? 'Close account settings' : 'Open account settings'} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)} className="flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"><SettingsIcon size={17} /><span>Account</span></button>}
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">
        {error && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
        {notice && <div role="status" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">{notice}</div>}
        {loading ? <p role="status" className="py-16 text-center text-gray-600">Checking your connection…</p> : (
          <div className={settingsOpen && session?.authenticated ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-6 items-start' : ''}>
            {ready ? <Suspense fallback={<p role="status" className="py-12 text-center text-gray-600">Opening language practice…</p>}><AIPracticeApp key={`${session.user?.id || 'connected'}:${lessonKey}`} onNewLesson={() => { window.globalImageStore = {}; setLessonKey(value => value + 1); }} /></Suspense> : (
              <section className="max-w-xl mx-auto my-10 rounded-xl border border-gray-200 bg-white p-6 sm:p-9 shadow-sm">
                <BookOpen className="text-blue-600 mb-5" size={32} />
                <h1 className="text-3xl font-semibold tracking-tight mb-3">Practice a language with your ChatGPT account</h1>
                <p className="text-gray-600 leading-relaxed mb-6">Choose your language, level, and topic. Get an explanation, practise with exercises, and check your answers.</p>
                {localMode && <p className="mb-5 text-sm text-gray-500">This app runs on this computer. Lessons use your own ChatGPT plan.</p>}
                {!session ? <button type="button" onClick={refreshSession} className="rounded-md bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700">Try again</button> : !session.configured ? (
                  <p role="status" className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">{localMode ? 'ChatGPT sign-in is unavailable. Restart the app and try again.' : 'ChatGPT sign-in is not configured yet. Contact the site owner.'}</p>
                ) : <>
                  {localMode && !session.authenticated && savedAccounts.length > 0 && <div className="mb-4"><SavedAccounts accounts={savedAccounts} onConnect={signIn} busy={busy} connecting={pendingAction === 'login'} /></div>}
                  <button type="button" onClick={() => signIn(localMode && session.authenticated ? session.user?.id : undefined)} disabled={busy} className="w-full rounded-lg bg-gray-900 px-4 py-3 font-medium text-white hover:bg-gray-800 disabled:opacity-60">{busy ? 'Opening ChatGPT…' : session.authenticated ? 'Enable ChatGPT plan usage' : savedAccounts.length ? 'Add another ChatGPT account' : 'Continue with ChatGPT'}</button>
                  <p className="mt-3 text-sm text-gray-500">Authorize this app to generate lessons using your ChatGPT plan. Your plan’s usage limits apply.</p>
                </>}
              </section>
            )}
            {settingsOpen && session?.authenticated && <SettingsPanel session={session} onLogout={signOut} onConnect={signIn} busy={busy} connecting={pendingAction === 'login'} disconnecting={pendingAction === 'logout'} />}
          </div>
        )}
      </main>
    </div>
  );
}
