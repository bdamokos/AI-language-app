import React, { useState, useEffect, useRef } from 'react';
import { normalizeText, countBlanks, splitByBlanks, sanitizeClozeItem } from './utils.js';
import useImageGeneration from '../hooks/useImageGeneration.js';

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

  // Generate image when item changes (if image generation is enabled)
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
        
        const imageData = await generateImage(prompt, {
          width: 1024,
          height: 1024,
          steps: 28,
          cfgScale: 3.5
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
            disabled={checked}
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
              {generatedImage.data?.[0]?.cost && ` • $${Number(generatedImage.data[0].cost).toFixed(4)}`}
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
 * Generate Cloze exercises using the generic LLM endpoint
 * @param {string} topic - The topic to generate exercises about
 * @param {number} count - Number of exercises to generate (1-10)
 * @param {Object} languageContext - Language and level context { language, level, challengeMode }
 * @returns {Promise<{items: Array}>} Generated Cloze exercises
 */
export async function generateCloze(topic, count = 2, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  // For single passage, use the original approach
  if (count === 1) {
    return generateSingleClozePassage(topic, null, languageContext);
  }
  
  // For multiple passages, generate them in parallel
  const promises = Array.from({ length: count }, (_, i) => 
    generateSingleClozePassage(topic, i + 1, languageContext)
  );
  
  try {
    const results = await Promise.all(promises);
    
    // Combine all results into a single items array
    const allItems = [];
    results.forEach(result => {
      if (result && result.items && Array.isArray(result.items)) {
        allItems.push(...result.items);
      }
    });
    
    return { items: allItems };
  } catch (error) {
    console.error('Error generating cloze passages in parallel:', error);
    // Fallback to single generation if parallel fails
    return generateSingleClozePassage(topic);
  }
}

/**
 * Generate a single Cloze passage
 * @param {string} topic - The topic to generate exercise about
 * @param {number} passageNumber - Optional passage number for context
 * @returns {Promise<{items: Array}>} Generated Cloze exercise
 */
async function generateSingleClozePassage(topic, passageNumber = null, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const passageContext = passageNumber ? ` (Passage ${passageNumber})` : '';
  
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  
  const system = `Generate a single ${languageName} cloze passage that is engaging and educational. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}. The passage should be 3-5 paragraphs long (approximately 150-250 words) with 8-16 meaningful blanks strategically placed throughout the text (maximum two per sentence). 

Key requirements:
- Create a longer, more engaging passage that tells a story or explains a concept
- Use exactly 5 underscores (_____) to represent each blank - no more, no less
- Provide helpful hints that guide students without giving away the answer
- Include rationale explaining why the answer is correct
- Ensure blanks test different aspects: vocabulary, grammar, verb conjugations, etc.
- Make the content culturally relevant and age-appropriate
- Maximum of 2 blanks per sentence to maintain readability
- Ensure vocabulary and grammar complexity matches ${level} level${challengeMode ? ' with some challenging elements' : ''}

IMPORTANT: Each blank must be represented by exactly 5 underscores (_____). Do not use fewer or more underscores.

Example of proper blank formatting and complete structure:
Passage: "María _____ en Madrid. Ella _____ como profesora. Su casa _____ cerca del centro."

Blanks:
- Blank 0: solution: "vive", hint: "lives", reason: "María is third person singular, present tense"
- Blank 1: solution: "trabaja", hint: "works", reason: "Ella is third person singular, present tense"  
- Blank 2: solution: "está", hint: "is", reason: "Su casa is third person singular, present tense, location is marked by estar"

Complete solution: "María vive en Madrid. Ella trabaja como profesora. Su casa está cerca del centro."

Provide a clear student instruction as a separate field named studentInstructions. Do not include the instruction text inside the passage itself.`;
  
  const user = `Create exactly 1 ${languageName} cloze passage about: ${topic}${passageContext}. 

Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}

The passage should be substantial (3-5 paragraphs) with 8-16 blanks. Remember: each blank must use exactly 5 underscores (_____).`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Descriptive title for the passage' },
            studentInstructions: { type: 'string', description: 'Clear directive for the student about what to fill in' },
            passage: { type: 'string', description: 'The main text with blanks represented as exactly 5 underscores (_____)' },
            blanks: { 
              type: 'array', 
              items: { 
                type: 'object', 
                additionalProperties: false, 
                properties: {
                  index: { type: 'integer', description: 'Position of the blank in the passage (0-based)' },
                  answer: { type: 'string', description: 'The correct answer for this blank' },
                  hint: { type: 'string', description: 'Helpful hint that guides without giving away the answer' },
                  rationale: { type: 'string', description: 'Explanation of why this answer is correct' }
                }, 
                required: ['index', 'answer', 'hint', 'rationale']
              },
              minItems: 8,
              maxItems: 16
            }
          },
          required: ['studentInstructions', 'passage', 'blanks']
        },
        minItems: 1,
        maxItems: 1
      }
    },
    required: ['items']
  };

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: schema,
      schemaName: `cloze_single_${passageNumber || 'passage'}`
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate Cloze exercise: ${response.status}`);
  }

  return response.json();
}


