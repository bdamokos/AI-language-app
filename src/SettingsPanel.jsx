import React, { useEffect, useState } from 'react';

export default function SettingsPanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [config, setConfig] = useState({
    provider: 'openrouter',
    openrouter: { model: '', apiKey: '', appUrl: '' },
    ollama: { model: '', host: '' },
    runware: { 
      model: '', 
      apiKey: '', 
      enabled: false, 
      width: 512, 
      height: 512, 
      steps: 20, 
      cfgScale: 7 
    },
    falai: { 
      model: '', 
      apiKey: '', 
      enabled: false, 
      width: 512, 
      height: 512, 
      steps: 20, 
      cfgScale: 7 
    },
    imageProvider: 'runware'
  });
  const [showKeys, setShowKeys] = useState(false);
  const [rateInfo, setRateInfo] = useState(null);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [openrouterModels, setOpenrouterModels] = useState([]);
  const [runwareModels, setRunwareModels] = useState([]);
  const [falaiModels, setFalaiModels] = useState([]);
  const [modelFilters, setModelFilters] = useState({ structuredOnly: true, freeOnly: false });
  const [selectedModelInfo, setSelectedModelInfo] = useState(null);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        setConfig(cfg => ({
          provider: data.provider,
          openrouter: { model: data.openrouter?.model || '', apiKey: '', appUrl: data.openrouter?.appUrl || '' },
          ollama: { model: data.ollama?.model || '', host: data.ollama?.host || '' },
          runware: { 
            model: data.runware?.model || '', 
            apiKey: '', 
            enabled: data.runware?.enabled || false,
            width: data.runware?.width || 512,
            height: data.runware?.height || 512,
            steps: data.runware?.steps || 20,
            cfgScale: data.runware?.cfgScale || 7
          },
          falai: { 
            model: data.falai?.model || '', 
            enabled: data.falai?.enabled || false,
            width: data.falai?.width || 512,
            height: data.falai?.height || 512,
            steps: data.falai?.steps || 20,
            cfgScale: data.falai?.cfgScale || 7
          },
          imageProvider: data.imageProvider || 'runware'
        }));
        
        // Auto-load models if we're using OpenRouter and have an API key
        if (data.provider === 'openrouter' && data.openrouter?.hasKey) {
          setTimeout(() => loadOpenRouterModels(), 100);
        }
      } catch (e) {
        setError(e.message || 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Auto-select model info when openrouter models load and a model is already selected
  useEffect(() => {
    if (openrouterModels.length > 0 && config.openrouter.model && !selectedModelInfo) {
      const model = openrouterModels.find(m => m.id === config.openrouter.model);
      if (model) {
        setSelectedModelInfo(model);
      }
    }
  }, [openrouterModels, config.openrouter.model, selectedModelInfo]);

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

  const loadRunwareModels = async () => {
    setLoadingModels(true);
    setError('');
    try {
      const res = await fetch('/api/runware/models');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Runware models');
      setRunwareModels(data.models || data || []);
    } catch (e) {
      setError(e.message || 'Failed to load Runware models');
    } finally {
      setLoadingModels(false);
    }
  };

  const loadFalaiModels = async () => {
    setLoadingModels(true);
    setError('');
    try {
      const res = await fetch('/api/falai/models');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load fal.ai models');
      setFalaiModels(data.models || data || []);
    } catch (e) {
      setError(e.message || 'Failed to load fal.ai models');
    } finally {
      setLoadingModels(false);
    }
  };

  const loadOpenRouterModels = async () => {
    setLoadingModels(true);
    setError('');
    try {
      const params = new URLSearchParams();
      // Always filter for structured outputs (required for our app)
      params.set('structured_only', 'true');
      if (modelFilters.freeOnly) params.set('free_only', 'true');
      
      const res = await fetch(`/api/openrouter/models?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load OpenRouter models');
      setOpenrouterModels(data.models || []);
    } catch (e) {
      setError(e.message || 'Failed to load OpenRouter models');
    } finally {
      setLoadingModels(false);
    }
  };

  const handleModelSelect = (modelId) => {
    const model = openrouterModels.find(m => m.id === modelId);
    setSelectedModelInfo(model);
    setConfig({ ...config, openrouter: { ...config.openrouter, model: modelId } });
  };

  const formatPrice = (price) => {
    if (!price || price === '0') return 'Free';
    const num = parseFloat(price);
    return `$${(num * 1000000).toFixed(2)}/M tokens`;
  };

  const formatModelDate = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString('en-UK', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
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
          <h3 className="font-medium mb-3">OpenRouter</h3>
          
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">Model</label>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <input 
                      id="free" 
                      type="checkbox" 
                      checked={modelFilters.freeOnly} 
                      onChange={e => {
                        const newFilters = {...modelFilters, freeOnly: e.target.checked};
                        setModelFilters(newFilters);
                        if (openrouterModels.length > 0) {
                          // Reload models with new filter
                          setTimeout(() => loadOpenRouterModels(), 50);
                        }
                      }}
                    />
                    <label htmlFor="free" className="text-sm">Free only</label>
                  </div>
                  <button 
                    onClick={loadOpenRouterModels} 
                    disabled={loadingModels} 
                    className="text-sm text-blue-600 hover:text-blue-800 underline"
                  >
                    {loadingModels ? 'Loading...' : 'Load Models'}
                  </button>
                </div>
              </div>
              
              <select
                className="w-full px-3 py-2 border rounded text-sm"
                value={config.openrouter.model}
                onChange={e => handleModelSelect(e.target.value)}
                disabled={openrouterModels.length === 0}
              >
                <option value="">
                  {openrouterModels.length === 0 ? 'Load models first...' : 'Select a model...'}
                </option>
                {openrouterModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>

              {selectedModelInfo && (
                <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-start justify-between">
                    <div className="font-medium text-sm">{selectedModelInfo.name}</div>
                    {selectedModelInfo.hugging_face_id && (
                      <a 
                        href={`https://huggingface.co/${selectedModelInfo.hugging_face_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800 underline"
                      >
                        🤗 Hugging Face
                      </a>
                    )}
                  </div>
                  <div className="text-gray-600 text-xs mt-1 leading-relaxed">
                    {selectedModelInfo.description?.slice(0, 200)}...
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>Context: <span className="font-medium">{selectedModelInfo.context_length?.toLocaleString()}</span> tokens</div>
                    <div>Input: <span className="font-medium">{formatPrice(selectedModelInfo.pricing?.prompt)}</span></div>
                    <div>Output: <span className="font-medium">{formatPrice(selectedModelInfo.pricing?.completion)}</span></div>
                    <div className="text-green-600">✓ Structured outputs</div>
                    {selectedModelInfo.created && (
                      <div>Released: <span className="font-medium">{formatModelDate(selectedModelInfo.created)}</span></div>
                    )}
                  </div>
                </div>
              )}
            </div>


            <div>
              <label className="block text-sm font-medium mb-1">App URL (referer)</label>
              <Input 
                value={config.openrouter.appUrl} 
                onChange={e => setConfig({ ...config, openrouter: { ...config.openrouter, appUrl: e.target.value } })}
                placeholder="http://localhost:5173"
              />
            </div>

            <div className="pt-2 border-t">
              <button onClick={checkOpenRouterRate} className="text-sm text-blue-600 hover:text-blue-800 underline">
                Check rate limits
              </button>
              {rateInfo && (
                <div className="text-sm text-gray-600 mt-2 p-2 bg-gray-50 rounded">
                  Usage: {rateInfo.data?.usage ?? '-'} | Limit: {rateInfo.data?.limit ?? '-'} | Free tier: {String(rateInfo.data?.is_free_tier)}
                </div>
              )}
            </div>
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

      <div className="grid grid-cols-1 gap-3">
        <div>
          <h3 className="font-medium mb-3">Image Generation</h3>
          
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-2">Image Provider</label>
              <select
                value={config.imageProvider}
                onChange={(e) => setConfig({ ...config, imageProvider: e.target.value })}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="runware">Runware</option>
                <option value="falai">fal.ai</option>
              </select>
            </div>
          </div>
        </div>
        
                <div>
          <h3 className="font-medium mb-3">Runware Configuration</h3>
          
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input 
                id="runwareEnabled" 
                type="checkbox" 
                checked={config.runware.enabled} 
                onChange={e => setConfig({ ...config, runware: { ...config.runware, enabled: e.target.checked } })}
              />
              <label htmlFor="runwareEnabled" className="text-sm font-medium">Enable image generation</label>
            </div>

            {showKeys && (
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <Input 
                  type="password"
                  value={config.runware.apiKey} 
                  onChange={e => setConfig({ ...config, runware: { ...config.runware, apiKey: e.target.value } })}
                  placeholder="Enter Runware API key"
                />
              </div>
            )}
            
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">Model</label>
                <button 
                  onClick={loadRunwareModels} 
                  disabled={loadingModels || !config.runware.enabled} 
                  className="text-sm text-blue-600 hover:text-blue-800 underline disabled:text-gray-400"
                >
                  {loadingModels ? 'Loading...' : 'Load Models'}
                </button>
              </div>
              
              <div className="flex gap-2">
                <Input 
                  value={config.runware.model} 
                  onChange={e => setConfig({ ...config, runware: { ...config.runware, model: e.target.value } })}
                  placeholder="runware:100@1"
                />
                {runwareModels.length > 0 && (
                  <select
                    className="px-2 py-2 border rounded text-sm"
                    value={config.runware.model}
                    onChange={e => setConfig({ ...config, runware: { ...config.runware, model: e.target.value } })}
                  >
                    <option value="">Select...</option>
                    {runwareModels.map((model) => (
                      <option key={model.id || model} value={model.id || model}>
                        {model.name || model}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Width</label>
                <Input 
                  type="number" 
                  min="64" 
                  max="2048" 
                  step="64"
                  value={config.runware.width} 
                  onChange={e => setConfig({ ...config, runware: { ...config.runware, width: Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Height</label>
                <Input 
                  type="number" 
                  min="64" 
                  max="2048" 
                  step="64"
                  value={config.runware.height} 
                  onChange={e => setConfig({ ...config, runware: { ...config.runware, height: Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Steps</label>
                <Input 
                  type="number" 
                  min="1" 
                  max="100"
                  value={config.runware.steps} 
                  onChange={e => setConfig({ ...config, runware: { ...config.runware, steps: Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">CFG Scale</label>
                <Input 
                  type="number" 
                  min="1" 
                  max="20" 
                  step="0.1"
                  value={config.runware.cfgScale} 
                  onChange={e => setConfig({ ...config, runware: { ...config.runware, cfgScale: Number(e.target.value) } })}
                />
              </div>
            </div>
          </div>
        </div>
        
        <div>
          <h3 className="font-medium mb-3">fal.ai Configuration</h3>
          
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input 
                id="falaiEnabled" 
                type="checkbox" 
                checked={config.falai.enabled} 
                onChange={e => setConfig({ ...config, falai: { ...config.falai, enabled: e.target.checked } })}
              />
              <label htmlFor="falaiEnabled" className="text-sm font-medium">Enable fal.ai image generation</label>
            </div>

            {showKeys && (
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <Input 
                  type="password"
                  value={config.falai.apiKey} 
                  onChange={e => setConfig({ ...config, falai: { ...config.falai, apiKey: e.target.value } })}
                  placeholder="Enter fal.ai API key"
                />
              </div>
            )}
            
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">Model</label>
                <button 
                  onClick={loadFalaiModels} 
                  disabled={loadingModels || !config.falai.enabled} 
                  className="text-sm text-blue-600 hover:text-blue-800 underline disabled:text-gray-400"
                >
                  {loadingModels ? 'Loading...' : 'Load Models'}
                </button>
              </div>
              
              <div className="flex gap-2">
                <Input 
                  value={config.falai.model} 
                  onChange={e => setConfig({ ...config, falai: { ...config.falai, model: e.target.value } })}
                  placeholder="fal-ai/fast-sdxl"
                />
                {falaiModels.length > 0 && (
                  <select
                    className="px-2 py-2 border rounded text-sm"
                    value={config.falai.model}
                    onChange={e => setConfig({ ...config, falai: { ...config.falai, model: e.target.value } })}
                  >
                    <option value="">Select...</option>
                    {falaiModels.map((model) => (
                      <option key={model.id || model} value={model.id || model}>
                        {model.name || model}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Width</label>
                <Input 
                  type="number" 
                  min="64" 
                  max="2048" 
                  step="64"
                  value={config.falai.width} 
                  onChange={e => setConfig({ ...config, falai: { ...config.falai, width: Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Height</label>
                <Input 
                  type="number" 
                  min="64" 
                  max="2048" 
                  step="64"
                  value={config.falai.height} 
                  onChange={e => setConfig({ ...config, falai: { ...config.falai, height: Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Steps</label>
                <Input 
                  type="number" 
                  min="1" 
                  max="100"
                  value={config.falai.steps} 
                  onChange={e => setConfig({ ...config, falai: { ...config.falai, steps: Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">CFG Scale</label>
                <Input 
                  type="number" 
                  min="1" 
                  max="20" 
                  step="0.1"
                  value={config.falai.cfgScale} 
                  onChange={e => setConfig({ ...config, falai: { ...config.falai, cfgScale: Number(e.target.value) } })}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


