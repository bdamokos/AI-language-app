import { useState, useCallback, useRef } from 'react';

/**
 * Universal hook for image generation using either Runware or fal.ai
 * Automatically selects the provider based on settings
 */
export default function useImageGeneration() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [imageData, setImageData] = useState(null);
  const [lastRequest, setLastRequest] = useState(null);
  const activeRequestRef = useRef(null);

  /**
   * Generate an image from a text prompt using the configured image provider
   * @param {string} prompt - The text prompt for image generation
   * @param {Object} options - Optional generation parameters
   * @param {string} options.model - Model to use for generation (overrides default)
   * @param {number} options.width - Image width (must be divisible by 64)
   * @param {number} options.height - Image height (must be divisible by 64)
   * @param {number} options.steps - Number of generation steps
   * @param {number} options.cfgScale - Classifier-free guidance scale
   * @param {string} options.scheduler - Scheduler to use (Runware only)
   * @param {number} options.seed - Seed for reproducible generation
   * @returns {Promise<Object>} Generated image data
   */
  const generateImage = useCallback(async (prompt, options = {}) => {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Prompt is required and must be a non-empty string');
    }

    // Create request signature to prevent duplicates
    const requestSignature = JSON.stringify({ prompt: prompt.trim(), ...options });
    
    // If this exact request is already in progress, return the existing promise
    if (activeRequestRef.current && lastRequest === requestSignature) {
      console.log('[IMAGE] Request already in progress, returning existing promise');
      return activeRequestRef.current;
    }
    
    // If we already have data for this exact request, return it immediately
    if (imageData && lastRequest === requestSignature) {
      console.log('[IMAGE] Returning cached result');
      return imageData;
    }

    // Cancel any existing request
    if (activeRequestRef.current) {
      console.log('[IMAGE] Cancelling previous request');
      activeRequestRef.current = null;
    }

    setLoading(true);
    setError(null);
    setImageData(null);
    setLastRequest(requestSignature);

    try {
      // Get current settings to determine which provider to use
      const settingsResponse = await fetch('/api/settings');
      if (!settingsResponse.ok) {
        throw new Error('Failed to fetch settings');
      }
      
      const settings = await settingsResponse.json();
      const imageProvider = settings.imageProvider || 'runware';
      
      if (!settings[imageProvider]?.enabled) {
        throw new Error(`${imageProvider === 'falai' ? 'fal.ai' : 'Runware'} image generation is disabled`);
      }

      // Determine the API endpoint based on provider
      const endpoint = imageProvider === 'falai' ? '/api/falai/generate' : '/api/runware/generate';
      
      console.log(`[IMAGE] Using ${imageProvider} provider at ${endpoint}`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt.trim(),
          ...options
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to generate image`);
      }

      let data = await response.json();
      
      // Validate the response structure
      if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        throw new Error(`Invalid response format from ${imageProvider} API`);
      }
      
      // Persist image to server cache if exerciseSha provided and a remote URL exists
      try {
        const first = data?.data?.[0] || null;
        const remoteUrl = first?.url || first?.imageURL || null;
        const exerciseSha = options?.exerciseSha;
        const persistToCache = options?.persistToCache;
        if (persistToCache && exerciseSha && remoteUrl) {
          const cacheResp = await fetch('/api/cache/exercise-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exerciseSha, url: remoteUrl })
          });
          if (cacheResp.ok) {
            const cached = await cacheResp.json();
            if (cached?.localUrl && data?.data?.[0]) {
              // Preserve original
              data.data[0].originalUrl = data.data[0].url || data.data[0].imageURL || null;
              // Replace URL with local served URL for stable reuse
              data.data[0].url = cached.localUrl;
            }
          }
        }
      } catch (e) {
        // Non-fatal; continue with provider URL
        console.log('[IMAGE] Failed to persist image to cache:', e?.message);
      }

      setImageData(data);
      return data;
    } catch (err) {
      const errorMessage = err.message || 'Failed to generate image';
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
      activeRequestRef.current = null;
    }
  }, []); // Empty dependency array to prevent infinite re-renders

  /**
   * Clear any stored image data and errors
   */
  const clear = useCallback(() => {
    setImageData(null);
    setError(null);
    setLastRequest(null);
    activeRequestRef.current = null;
  }, []);

  /**
   * Get available models from the configured image provider
   * @returns {Promise<Array>} List of available models
   */
  const getModels = useCallback(async () => {
    try {
      // Get current settings to determine which provider to use
      const settingsResponse = await fetch('/api/settings');
      if (!settingsResponse.ok) {
        throw new Error('Failed to fetch settings');
      }
      
      const settings = await settingsResponse.json();
      const imageProvider = settings.imageProvider || 'runware';
      
      if (!settings[imageProvider]?.enabled) {
        throw new Error(`${imageProvider === 'falai' ? 'fal.ai' : 'Runware'} image generation is disabled`);
      }

      // Determine the API endpoint based on provider
      const endpoint = imageProvider === 'falai' ? '/api/falai/models' : '/api/runware/models';
      
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch models`);
      }
      return await response.json();
    } catch (err) {
      setError(err.message || 'Failed to fetch models');
      throw err;
    }
  }, []);

  /**
   * Get the current image provider from settings
   * @returns {Promise<string>} Current image provider ('runware' or 'falai')
   */
  const getCurrentProvider = useCallback(async () => {
    try {
      const settingsResponse = await fetch('/api/settings');
      if (!settingsResponse.ok) {
        throw new Error('Failed to fetch settings');
      }
      
      const settings = await settingsResponse.json();
      return settings.imageProvider || 'runware';
    } catch (err) {
      console.error('Failed to get current provider:', err);
      return 'runware'; // fallback
    }
  }, []);

  return {
    // State
    loading,
    error,
    imageData,
    
    // Actions
    generateImage,
    clear,
    getModels,
    getCurrentProvider
  };
}
