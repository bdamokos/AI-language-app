import React, { useState, useEffect, useRef } from 'react';
import { normalizeText, countBlanks, splitByBlanks, sanitizeClozeItem } from './utils.js';
import useImageGeneration from '../hooks/useImageGeneration.js';
import { generateUnifiedCloze, generateUnifiedClozeStepwise, convertToTraditionalCloze, filterBlanksByDifficulty } from './ClozeUnified.jsx';

/**
 * Cloze passage with free-text blanks
 * item: { title?, studentInstructions?, passage, blanks: [{ index, answer, hint?, rationale? }], difficulty }
 * value: Record<string,string>
 */
export default function ClozeExercise({ item, value, onChange, checked, strictAccents = true, idPrefix, onFocusKey }) {
  const [showHints, setShowHints] = useState(false);
  const [showRationale, setShowRationale] = useState({});
  const [sanitizedItem, setSanitizedItem] = useState(item);
  const [warnings, setWarnings] = useState([]);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const { generateImage, loading: imageLoading, error: imageError } = useImageGeneration();
  const isGeneratingRef = useRef(false);
  const lastItemRef = useRef(null);
  
  // Sanitize the item when it changes
  useEffect(() => {
    if (item) {
      const sanitization = sanitizeClozeItem(item);
      setSanitizedItem(sanitization.item);
      setWarnings(sanitization.warnings);
      
      // Log warnings to server if there are issues
      if (sanitization.warnings.length > 0) {
        fetch('/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            level: 'warn',
            message: 'Cloze passage validation warnings',
            data: { item, warnings: sanitization.warnings }
          })
        }).catch(console.error); // Don't let logging errors break the UI
      }
    }
  }, [item]);

  // Check if image generation is enabled once on mount
  useEffect(() => {
    const checkImageGenerationEnabled = async () => {
      try {
        const settingsRes = await fetch('/api/settings');
        const settings = await settingsRes.json();
        const imageProvider = settings.imageProvider || 'runware';
        setImageGenerationEnabled(settings[imageProvider]?.enabled || false);
      } catch (error) {
        console.log('[CLOZE] Could not check image generation settings:', error.message);
        setImageGenerationEnabled(false);
      }
    };
    
    checkImageGenerationEnabled();
  }, []);

  // Try to use base text image if available (chapter-specific, else cover)
  useEffect(() => {
    const maybeUseBaseTextImage = async () => {
      try {
        const baseTextId = item?.base_text_info?.base_text_id || item?.base_text_id;
        const chapterNumber = item?.base_text_info?.chapter_number || item?.chapter_number;
        if (!baseTextId) return;
        if (lastItemRef.current === `nf:${baseTextId}:${chapterNumber || 'cover'}`) return;
        const resp = await fetch(`/api/base-text-content/${baseTextId}`);
        if (!resp.ok) {
          if (resp.status === 404) lastItemRef.current = `nf:${baseTextId}:${chapterNumber || 'cover'}`;
          return;
        }
        const base = await resp.json();
        const images = base?.images || {};
        let url = null;
        if (chapterNumber && images?.chapters && images.chapters[String(chapterNumber)]?.localUrl) {
          url = images.chapters[String(chapterNumber)].localUrl;
        } else if (images?.cover?.localUrl) {
          url = images.cover.localUrl;
        }
        if (url) {
          const cached = { data: [{ url }] };
          setGeneratedImage(cached);
          if (window.globalImageStore && idPrefix) {
            const exerciseIndex = idPrefix.split(':').pop();
            const imageKey = `cloze:${exerciseIndex}`;
            window.globalImageStore[imageKey] = cached;
          }
          lastItemRef.current = `base:${baseTextId}:${chapterNumber || 'cover'}`;
        }
      } catch {}
    };
    maybeUseBaseTextImage();
  }, [item?.base_text_info?.base_text_id, item?.base_text_info?.chapter_number, item?.base_text_id, item?.chapter_number, idPrefix]);

  // Generate image when item changes (if image generation is enabled and no cached image exists)
  useEffect(() => {
    const generateContextualImage = async () => {
      // Skip if image generation is not enabled
      if (!imageGenerationEnabled) {
        console.log('[CLOZE] Image generation not enabled, skipping');
        return;
      }
      
      // Skip if no title or passage
      if (!sanitizedItem?.title || !sanitizedItem?.passage) {
        console.log('[CLOZE] No title or passage, skipping image generation');
        return;
      }
      
      // If we already have an image (e.g., pre-existing base text image), skip generation
      if (generatedImage && getImageSource(generatedImage)) {
        return;
      }

      // If cached local image URL is present on the item, use it and skip generation
      if (item?.localImageUrl) {
        setGeneratedImage({ data: [{ url: item.localImageUrl }] });
        console.log('[CLOZE] Using cached local image URL:', item.localImageUrl);
        return;
      }

      // Skip if this is the same item we already processed
      const currentItemKey = `${sanitizedItem.title}-${sanitizedItem.passage.substring(0, 100)}`;
      if (lastItemRef.current === currentItemKey) {
        console.log('[CLOZE] Same item, skipping duplicate image generation');
        return;
      }
      
      // Prevent duplicate requests
      if (isGeneratingRef.current) {
        console.log('[CLOZE] Image generation already in progress, skipping');
        return;
      }
      
      // Reset previous image
      setGeneratedImage(null);
      isGeneratingRef.current = true;
      lastItemRef.current = currentItemKey;
      
      try {
        // Clean the passage text by removing blanks for better image generation
        const cleanPassage = sanitizedItem.passage.replace(/_____/g, '[blank]');
        const prompt = `Create a stock photo that goes along with this topic: ${sanitizedItem.title}\n${cleanPassage}`;
        
        console.log('[CLOZE] Starting image generation for:', sanitizedItem.title);
        
        // Prefer existing base-text image if available
        try {
          const baseTextId = item?.base_text_info?.base_text_id || item?.base_text_id;
          const chapterNumber = item?.base_text_info?.chapter_number || item?.chapter_number;
          if (baseTextId) {
            const resp = await fetch(`/api/base-text-content/${baseTextId}`);
            if (resp.ok) {
              const base = await resp.json();
              const images = base?.images || {};
              let url = null;
              if (chapterNumber && images?.chapters && images.chapters[String(chapterNumber)]?.localUrl) {
                url = images.chapters[String(chapterNumber)].localUrl;
              } else if (images?.cover?.localUrl) {
                url = images.cover.localUrl;
              }
              if (url) {
                const cached = { data: [{ url }] };
                setGeneratedImage(cached);
                if (window.globalImageStore && idPrefix) {
                  const exerciseIndex = idPrefix.split(':').pop();
                  const imageKey = `cloze:${exerciseIndex}`;
                  window.globalImageStore[imageKey] = cached;
                }
                return; // Use existing, skip generation
              }
            }
          }
        } catch {}

        const imageData = await generateImage(prompt, {
          width: 1024,
          height: 1024,
          steps: 28,
          cfgScale: 3.5,
          // Persist to server cache if the exercise has a stable ID
          persistToCache: true,
          exerciseSha: item?.exerciseSha,
          baseTextId: item?.base_text_info?.base_text_id || item?.base_text_id,
          chapterNumber: item?.base_text_info?.chapter_number || item?.chapter_number
        });
        
        // Log cost information in development mode
        if (imageData?.data?.[0]?.cost !== undefined) {
          console.log(`[CLOZE] Image generated with cost: $${Number(imageData.data[0].cost).toFixed(6)}`);
        }
        
        // Debug the response structure
        console.log('[CLOZE] Image data received:', imageData);
        
        setGeneratedImage(imageData);
        
        // Store image in global store for PDF export
        if (window.globalImageStore && idPrefix) {
          const exerciseIndex = idPrefix.split(':').pop(); // Extract index from idPrefix
          const imageKey = `cloze:${exerciseIndex}`;
          window.globalImageStore[imageKey] = imageData;
          console.log('[CLOZE] Stored image in global store:', imageKey, imageData);
        }
      } catch (error) {
        // Silently fail - image generation is optional
        console.log('[CLOZE] Image generation failed:', error.message);
      } finally {
        isGeneratingRef.current = false;
      }
    };
    
    generateContextualImage();
  }, [sanitizedItem?.title, sanitizedItem?.passage, imageGenerationEnabled, idPrefix]); // Added idPrefix dependency
  
  const parts = splitByBlanks(sanitizedItem?.passage || '');
  const blanks = Array.isArray(sanitizedItem?.blanks) ? sanitizedItem.blanks : [];
  const nodes = [];
  
  for (let i = 0; i < parts.length; i++) {
    nodes.push(<span key={`t-${i}`}>{parts[i]}</span>);
    if (i < parts.length - 1) {
      const blank = blanks.find(b => b.index === i) || { answer: '', hint: '', rationale: '' };
      const key = String(i);
      const val = value?.[key] || '';
      const isCorrect = checked && blank.answer && normalizeText(val, strictAccents) === normalizeText(blank.answer, strictAccents);
      
      nodes.push(
        <span key={`b-${i}`} className="inline-block">
          <input
            key={`i-${i}`}
            data-key={`${idPrefix}:${i}`}
            type="text"
            value={val}
            onChange={(e) => onChange(key, e.target.value)}
            onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:${i}`)}
            className={`mx-1 px-2 py-0.5 border rounded-md inline-block w-32 ${
              isCorrect ? 'border-green-500 bg-green-50' : checked ? 'border-red-500 bg-red-50' : 'border-gray-300'
            }`}
            placeholder="..."
          />
          {blank.hint && !checked && (
            <button
              type="button"
              onClick={() => setShowHints(prev => ({ ...prev, [i]: !prev[i] }))}
              className="ml-1 text-xs text-blue-600 hover:text-blue-800 underline"
              title="Show hint"
            >
              💡
            </button>
          )}
          {blank.hint && showHints[i] && !checked && (
            <div className="ml-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1 mt-1">
              <strong>Hint:</strong> {blank.hint}
            </div>
          )}
        </span>
      );
      
      if (checked) {
        nodes.push(
          <span key={`f-${i}`} className={`ml-1 text-xs ${isCorrect ? 'text-green-700' : 'text-red-700'}`}>
            {isCorrect ? '✓' : `(${blank.answer || ''})`}
            {!isCorrect && blank.rationale && (
              <button
                type="button"
                onClick={() => setShowRationale(prev => ({ ...prev, [i]: !prev[i] }))}
                className="ml-1 text-blue-600 hover:text-blue-800 underline"
                title="Show explanation"
              >
                ℹ️
              </button>
            )}
          </span>
        );
        
        if (!isCorrect && blank.rationale && showRationale[i]) {
          nodes.push(
            <div key={`r-${i}`} className="ml-2 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-2 py-1 mt-1 w-full">
              <strong>Explanation:</strong> {blank.rationale}
            </div>
          );
        }
      }
    }
  }
  
  // Helper function to get the correct image source
  const getImageSource = (imageData) => {
    if (!imageData?.data?.[0]) return null;
    
    const image = imageData.data[0];
    // Support both fal.ai (url) and Runware (imageURL) formats
    return image.url || image.imageURL || image.imageDataURI || image.imageBase64Data;
  };
  
  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium mb-2">{item.title}</p>}
      {item?.studentInstructions && (
        <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 mb-2">
          {item.studentInstructions}
        </p>
      )}
      
      {/* Display warnings if there are validation issues */}
      {warnings.length > 0 && (
        <div className="mb-3 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-yellow-700">⚠️</span>
            <span className="font-medium text-yellow-800">Validation Warning</span>
          </div>
          <p className="text-yellow-700 text-xs">
            The correction key may not be accurate due to a backend error. 
            {warnings.some(w => w.includes('recovered')) && ' Some issues were automatically fixed.'}
          </p>
          {warnings.length > 0 && (
            <details className="mt-1">
              <summary className="text-yellow-600 cursor-pointer text-xs">View details</summary>
              <ul className="mt-1 text-xs text-yellow-700 list-disc list-inside">
                {warnings.map((warning, idx) => (
                  <li key={idx}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      
      {/* Main content area with text and optional image */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Text passage */}
        <div className="flex-1">
          <div className="text-gray-800 leading-relaxed">{nodes}</div>
        </div>
        
        {/* Generated image */}
        {imageGenerationEnabled && (imageLoading || generatedImage || imageError) && (
          <div className="lg:w-64 xl:w-80 flex-shrink-0">
            {imageLoading && (
              <div className="w-full aspect-square bg-gray-100 border border-gray-200 rounded-lg flex items-center justify-center">
                <div className="text-center">
                  <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2"></div>
                  <p className="text-sm text-gray-600">Generating image...</p>
                </div>
              </div>
            )}
            
                    {generatedImage && getImageSource(generatedImage) && (
          <div className="w-full">
            <img 
              src={getImageSource(generatedImage)}
              alt={`Illustration for: ${item?.title || 'Cloze passage'}`}
              className="w-full aspect-square object-cover rounded-lg border border-gray-200 shadow-sm"
              onError={(e) => {
                console.error('[CLOZE] Failed to load generated image:', e);
                e.target.style.display = 'none';
              }}
            />
            <p className="text-xs text-gray-500 mt-1 text-center">
              AI-generated illustration
            </p>
          </div>
        )}
        

            
            {imageError && !imageLoading && (
              <div className="w-full aspect-square bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-center">
                <div className="text-center p-4">
                  <p className="text-sm text-gray-500">Image generation failed</p>
                  <p className="text-xs text-gray-400 mt-1">{imageError}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function scoreCloze(item, value, eq) {
  const total = countBlanks(item?.passage || '');
  let correct = 0;
  const blanks = Array.isArray(item?.blanks) ? item.blanks : [];
  for (let i = 0; i < total; i++) {
    const blank = blanks.find(b => b.index === i) || { answer: '' };
    if (eq(String(value?.[String(i)] || ''), String(blank.answer || ''))) correct++;
  }
  return { correct, total };
}

/**
 * Generate Cloze exercises using the unified system
 * @param {string} topic - The topic to generate exercises about
 * @param {number} count - Number of exercises to generate (1-10)
 * @param {Object} languageContext - Language and level context { language, level, challengeMode, chapter?, baseText? }
 * @returns {Promise<{items: Array}>} Generated Cloze exercises in traditional format
 */
export async function generateCloze(topic, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  // Always use unified approach - this is the only supported method going forward
  console.log('Using unified cloze generation (cached as unified_cloze)');
  
  // Generate unified cloze using unified schema
  // Prefer stepwise generation with prompt caching; fallback to single-shot unified
  let unifiedResult;
  try {
    unifiedResult = await generateUnifiedClozeStepwise(topic, languageContext);
  } catch (e) {
    console.warn('[CLOZE] Stepwise generation failed, falling back:', e?.message);
    unifiedResult = await generateUnifiedCloze(topic, 1, languageContext);
  }
  const unifiedItem = unifiedResult.items[0];
  
  // Apply difficulty filtering based on challenge mode and level
  const targetDifficulties = languageContext.challengeMode 
    ? ['easy', 'medium', 'hard'] 
    : ['easy', 'medium'];
  const maxBlanks = languageContext.challengeMode ? 12 : 8;
  
  const filteredItem = filterBlanksByDifficulty(unifiedItem, targetDifficulties, maxBlanks);
  
  // Convert to traditional cloze format for UI display
  const traditionalItem = convertToTraditionalCloze(filteredItem);
  
  return { items: [traditionalItem] };
}

// Deprecated traditional generation functions removed - using unified approach exclusively

