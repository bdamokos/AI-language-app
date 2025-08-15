import { useState, useCallback, useRef } from 'react';

/**
 * Custom hook for Runware text-to-image generation
 * Provides a simple interface to generate images from text prompts
 */
export default function useRunware() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [imageData, setImageData] = useState(null);
  const [lastRequest, setLastRequest] = useState(null);
  const activeRequestRef = useRef(null);

  /**
   * Generate an image from a text prompt using Runware API
   * @param {string} prompt - The text prompt for image generation
   * @param {Object} options - Optional generation parameters
   * @param {string} options.model - Model to use for generation
   * @param {number} options.width - Image width (must be divisible by 64)
   * @param {number} options.height - Image height (must be divisible by 64)
   * @param {number} options.steps - Number of generation steps
   * @param {number} options.cfgScale - Classifier-free guidance scale
   * @param {string} options.scheduler - Scheduler to use
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
      console.log('[RUNWARE] Request already in progress, returning existing promise');
      return activeRequestRef.current;
    }
    
    // If we already have data for this exact request, return it immediately
    if (imageData && lastRequest === requestSignature) {
      console.log('[RUNWARE] Returning cached result');
      return imageData;
    }

    // Cancel any existing request
    if (activeRequestRef.current) {
      console.log('[RUNWARE] Cancelling previous request');
      activeRequestRef.current = null;
    }

    setLoading(true);
    setError(null);
    setImageData(null);
    setLastRequest(requestSignature);

    try {
      const response = await fetch('/api/runware/generate', {
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

      const data = await response.json();
      
      // Validate the response structure matches Runware API
      if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        throw new Error('Invalid response format from Runware API');
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
   * Get available models from Runware
   * @returns {Promise<Array>} List of available models
   */
  const getModels = useCallback(async () => {
    try {
      const response = await fetch('/api/runware/models');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch models`);
      }
      return await response.json();
    } catch (err) {
      setError(err.message || 'Failed to fetch models');
      throw err;
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
    getModels
  };
}