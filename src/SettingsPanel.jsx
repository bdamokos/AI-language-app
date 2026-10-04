import React, { useEffect, useState } from 'react';
import { apiFetch } from './utils/api.js';

export default function SettingsPanel({ session, onLogout, busy }) {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    if (!session.inferenceEnabled) { setLoading(false); return; }
    apiFetch('/api/models').then(response => response.json()).then(data => {
      if (!active) return;
      setModels(data.models || []);
      setModel(data.selectedModel || data.models?.[0]?.id || '');
    }).catch(error => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session.inferenceEnabled]);

  const saveModel = async event => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await apiFetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model })
      });
      setSaved(true);
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };

  return (
    <section aria-label="Account settings" className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900">Your ChatGPT account</h2>
        <p className="text-sm text-gray-600 break-words">{session.user?.email || session.user?.name || 'Connected'}</p>
      </div>
      <p className="text-sm text-gray-600">Lessons use your ChatGPT plan. Your plan’s limits apply.</p>
      <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-blue-700 underline">View ChatGPT usage</a>
      {session.inferenceEnabled && (
        <form onSubmit={saveModel} className="space-y-2 border-t pt-4">
          <label htmlFor="inference-model" className="block text-sm font-medium text-gray-800">Lesson model</label>
          <select id="inference-model" value={model} onChange={event => { setModel(event.target.value); setSaved(false); }} disabled={loading || saving || !models.length} className="w-full border border-gray-300 rounded-md p-2 text-sm disabled:bg-gray-50">
            {loading && <option value="">Loading models…</option>}
            {!loading && !models.length && <option value="">No models available</option>}
            {models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select>
          <button type="submit" disabled={loading || saving || !model} className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-gray-400">{saving ? 'Saving…' : 'Save model'}</button>
          {saved && <p role="status" className="text-sm text-green-700">Model saved for your next request.</p>}
        </form>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <p className="text-xs text-gray-500">Image generation is unavailable with this connection.</p>
      <div className="border-t pt-4">
        <button type="button" onClick={onLogout} disabled={busy} className="text-sm rounded-md border border-gray-300 px-3 py-2 hover:bg-gray-50 disabled:opacity-50">{busy ? 'Disconnecting…' : 'Disconnect ChatGPT'}</button>
        <p className="mt-2 text-xs text-gray-500">Disconnecting ends this session and clears the current lesson from this browser.</p>
      </div>
    </section>
  );
}
