import React, { useEffect, useState } from 'react';

export default function SettingsPanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [config, setConfig] = useState({
    provider: 'openrouter',
    openrouter: { model: '', apiKey: '', appUrl: '' },
    ollama: { model: '', host: '' }
  });
  const [showKeys, setShowKeys] = useState(false);
  const [rateInfo, setRateInfo] = useState(null);
  const [ollamaModels, setOllamaModels] = useState([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        setConfig(cfg => ({
          provider: data.provider,
          openrouter: { model: data.openrouter?.model || '', apiKey: '', appUrl: data.openrouter?.appUrl || '' },
          ollama: { model: data.ollama?.model || '', host: data.ollama?.host || '' }
        }));
      } catch (e) {
        setError(e.message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    setOkMsg('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Save failed');
      }
      setOkMsg('Settings saved');
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const checkOpenRouterRate = async () => {
    setError('');
    setRateInfo(null);
    try {
      const res = await fetch('/api/openrouter/rate-limit');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rate limit check failed');
      setRateInfo(data);
    } catch (e) {
      setError(e.message || 'Rate limit check failed');
    }
  };

  const loadOllamaModels = async () => {
    try {
      const res = await fetch('/api/ollama/models');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Ollama models');
      setOllamaModels(data.models || []);
    } catch (e) {
      setError(e.message || 'Failed to load Ollama models');
    }
  };

  const Input = (props) => (
    <input {...props} className={`w-full px-3 py-2 border rounded ${props.className || ''}`} />
  );

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Settings</h2>
        <button onClick={save} disabled={saving} className="bg-gray-800 text-white px-3 py-1 rounded text-sm">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {loading && <p className="text-sm text-gray-600">Loading settings...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {okMsg && <p className="text-sm text-green-600">{okMsg}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm mb-1">Provider</label>
          <select
            value={config.provider}
            onChange={(e) => setConfig({ ...config, provider: e.target.value })}
            className="w-full px-3 py-2 border rounded"
          >
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <input id="showKeys" type="checkbox" checked={showKeys} onChange={e => setShowKeys(e.target.checked)} />
          <label htmlFor="showKeys" className="text-sm">Show API keys in form</label>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <h3 className="font-medium mb-2">OpenRouter</h3>
          <label className="block text-xs mb-1">Model</label>
          <Input value={config.openrouter.model} onChange={e => setConfig({ ...config, openrouter: { ...config.openrouter, model: e.target.value } })} />
          <label className="block text-xs mt-2 mb-1">API Key</label>
          <Input type={showKeys ? 'text' : 'password'} value={config.openrouter.apiKey} onChange={e => setConfig({ ...config, openrouter: { ...config.openrouter, apiKey: e.target.value } })} />
          <label className="block text-xs mt-2 mb-1">App URL (referer)</label>
          <Input value={config.openrouter.appUrl} onChange={e => setConfig({ ...config, openrouter: { ...config.openrouter, appUrl: e.target.value } })} />
          <div className="mt-2">
            <button onClick={checkOpenRouterRate} className="text-sm text-blue-600 underline">Check rate limits</button>
            {rateInfo && (
              <div className="text-xs text-gray-700 mt-1">
                usage: {rateInfo.data?.usage ?? '-'} | limit: {rateInfo.data?.limit ?? '-'} | free tier: {String(rateInfo.data?.is_free_tier)}
              </div>
            )}
          </div>
        </div>
        <div>
          <h3 className="font-medium mb-2">Ollama</h3>
          <label className="block text-xs mb-1">Host</label>
          <Input value={config.ollama.host} onChange={e => setConfig({ ...config, ollama: { ...config.ollama, host: e.target.value } })} />
          <div className="flex items-center justify-between mt-2">
            <label className="block text-xs mb-1">Model</label>
            <button type="button" onClick={loadOllamaModels} className="text-xs text-blue-600 underline">List models</button>
          </div>
          <div className="flex gap-2">
            <Input value={config.ollama.model} onChange={e => setConfig({ ...config, ollama: { ...config.ollama, model: e.target.value } })} />
            {ollamaModels.length > 0 && (
              <select
                className="px-2 py-2 border rounded"
                value={config.ollama.model}
                onChange={e => setConfig({ ...config, ollama: { ...config.ollama, model: e.target.value } })}
              >
                <option value="">Select...</option>
                {ollamaModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


