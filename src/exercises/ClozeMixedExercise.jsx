import React, { useState, useEffect } from 'react';
import { normalizeText, splitByBlanks, sanitizeClozeItem } from './utils.js';

/**
 * Cloze with mixed options per blank (dropdowns)
 * item: { title?, studentInstructions?, passage, blanks: [{ index, options: string[], correct_index: number, hint?, rationale? }], difficulty }
 * value: Record<string,string>
 */
export default function ClozeMixedExercise({ item, value, onChange, checked, strictAccents = true, idPrefix }) {
  const [showHints, setShowHints] = useState(false);
  const [showRationale, setShowRationale] = useState({});
  const [sanitizedItem, setSanitizedItem] = useState(item);
  const [warnings, setWarnings] = useState([]);
  
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
            message: 'ClozeMixed passage validation warnings',
            data: { item, warnings: sanitization.warnings }
          })
        }).catch(console.error); // Don't let logging errors break the UI
      }
    }
  }, [item]);
  
  const parts = splitByBlanks(sanitizedItem?.passage || '');
  const nodes = [];
  
  for (let i = 0; i < parts.length; i++) {
    nodes.push(<span key={`t-${i}`}>{parts[i]}</span>);
    if (i < parts.length - 1) {
      const blank = (sanitizedItem?.blanks || []).find(b => b.index === i) || { options: [], correct_index: -1, hint: '', rationale: '' };
      const correctOpt = blank.options?.[blank.correct_index];
      const key = String(i);
      const val = value?.[key] ?? '';
      
      nodes.push(
        <span key={`b-${i}`} className="inline-block">
          <select 
            key={`s-${i}`} 
            className="mx-1 px-2 py-1 border rounded" 
            value={val} 
            onChange={e => onChange(key, e.target.value)} 
            disabled={checked}
          >
            <option value="">...</option>
            {blank.options.map((opt, oi) => (
              <option key={oi} value={opt}>{opt}</option>
            ))}
          </select>
          {blank.hint && !checked && (
            <button
              type="button"
              onClick={() => setShowHints(prev => ({ ...prev, [i]: !prev[i] }))}
              className="ml-1 text-xs text-blue-600 hover:text-blue-800 underline"
              title="Show hint"
              disabled={checked}
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
        const isCorrect = val && correctOpt && normalizeText(val, strictAccents) === normalizeText(correctOpt, strictAccents);
        nodes.push(
          <span key={`f-${i}`} className={`ml-1 text-xs ${isCorrect ? 'text-green-700' : 'text-red-700'}`}>
            {isCorrect ? '✓' : `(${correctOpt || ''})`}
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
      
      <div className="text-gray-800 leading-relaxed">{nodes}</div>
    </div>
  );
}

export function scoreClozeMixed(item, value, eq) {
  const blanks = Array.isArray(item?.blanks) ? item.blanks : [];
  const total = blanks.length;
  let correct = 0;
  for (const b of blanks) {
    const correctOpt = b.options?.[b.correct_index];
    if (eq(String(value?.[String(b.index)] || ''), String(correctOpt || ''))) correct++;
  }
  return { correct, total };
}

/**
 * Generate ClozeMixed exercises using the generic LLM endpoint
 * @param {string} topic - The topic to generate exercises about
 * @param {number} count - Number of exercises to generate (1-10)
 * @param {Object} languageContext - Language and level context { language, level, challengeMode }
 * @returns {Promise<{items: Array}>} Generated ClozeMixed exercises
 */
export async function generateClozeMixed(topic, count = 2, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  // For single passage, use the original approach
  if (count === 1) {
    return generateSingleClozeMixedPassage(topic, null, languageContext);
  }
  
  // For multiple passages, generate them sequentially to avoid overwhelming the API
  const allItems = [];
  const errors = [];
  
  for (let i = 0; i < count; i++) {
    try {
      // Add a small delay between requests to avoid overwhelming the API
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }
      
      const result = await generateSingleClozeMixedPassage(topic, i + 1, languageContext);
      
      if (result && result.items && Array.isArray(result.items)) {
        allItems.push(...result.items);
      }
    } catch (error) {
      console.error(`Error generating ClozeMixed passage ${i + 1}:`, error);
      errors.push({ passage: i + 1, error: error.message });
      
      // Continue with other passages even if one fails
      continue;
    }
  }
  
  // If we got no items at all, throw an error
  if (allItems.length === 0) {
    throw new Error(`Failed to generate any ClozeMixed passages. Errors: ${errors.map(e => `Passage ${e.passage}: ${e.error}`).join('; ')}`);
  }
  
  // Log if we had partial failures
  if (errors.length > 0) {
    console.warn(`Generated ${allItems.length} passages with ${errors.length} failures:`, errors);
  }
  
  return { items: allItems };
}

/**
 * Generate a single ClozeMixed passage
 * @param {string} topic - The topic to generate exercise about
 * @param {number} passageNumber - Optional passage number for context
 * @returns {Promise<{items: Array}>} Generated ClozeMixed exercise
 */
async function generateSingleClozeMixedPassage(topic, passageNumber = null, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const passageContext = passageNumber ? ` (Passage ${passageNumber})` : '';
  
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  
  const system = `Generate a single ${languageName} cloze passage with multiple-choice options for each blank. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}. The passage should be 3-5 paragraphs long (approximately 150-250 words) with 8-16 meaningful blanks strategically placed throughout the text (maximum two per sentence).

Key requirements:
- Create a longer, more engaging passage that tells a story or explains a concept
- Use exactly 5 underscores (_____) to represent each blank - no more, no less
- For each blank, provide 4 options: the correct answer plus 3 plausible distractors
- Provide helpful hints that guide students without giving away the answer
- Include rationale explaining why the correct answer is right and why distractors are wrong
- Ensure blanks test different aspects: vocabulary, grammar, verb conjugations, etc.
- Make the content culturally relevant and age-appropriate
- Distractors should be plausible but clearly incorrect to avoid confusion
- Maximum of 2 blanks per sentence to maintain readability
- Ensure vocabulary and grammar complexity matches ${level} level${challengeMode ? ' with some challenging elements' : ''}

IMPORTANT: Each blank must be represented by exactly 5 underscores (_____). Do not use fewer or more underscores.

Example of proper blank formatting and complete structure:
Passage: "María _____ en Madrid. Ella _____ como profesora. Su casa _____ cerca del centro."

Blanks:
- Blank 0: options: ["vive", "vives", "viven", "vivimos"], correct_index: 0, hint: "lives", reason: "María is third person singular, present tense"
- Blank 1: options: ["trabaja", "trabajas", "trabajan", "trabajamos"], correct_index: 0, hint: "works", reason: "Ella is third person singular, present tense"
- Blank 2: options: ["está", "estás", "están", "estamos"], correct_index: 0, hint: "is", reason: "Su casa is third person singular, present tense"

Complete solution: "María vive en Madrid. Ella trabaja como profesora. Su casa está cerca del centro."

Provide a clear student instruction as a separate field named studentInstructions. Do not include the instruction text inside the passage itself.`;
  
  const user = `Create exactly 1 ${languageName} cloze-with-options passage about: ${topic}${passageContext}. 

Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}

The passage should be substantial (3-5 paragraphs) with 8-16 blanks (maximum two per sentence), each having 4 options. Remember: each blank must use exactly 5 underscores (_____).`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Descriptive title for the passage' },
            studentInstructions: { type: 'string', description: 'Clear directive for the student about what to select for blanks' },
            passage: { type: 'string', description: 'The main text with blanks represented as exactly 5 underscores (_____)' },
            blanks: { 
              type: 'array', 
              items: { 
                type: 'object', 
                additionalProperties: false, 
                properties: {
                  index: { type: 'integer', description: 'Position of the blank in the passage (0-based)' },
                  options: { 
                    type: 'array', 
                    items: { type: 'string' }, 
                    minItems: 4,
                    maxItems: 4,
                    description: 'Exactly 4 options: correct answer plus 3 plausible distractors'
                  },
                  correct_index: { type: 'integer', description: 'Index of the correct option (0-3)' },
                  hint: { type: 'string', description: 'Helpful hint that guides without giving away the answer' },
                  rationale: { type: 'string', description: 'Explanation of why the correct answer is right' }
                }, 
                required: ['index', 'options', 'correct_index', 'hint', 'rationale']
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
      schemaName: `cloze_mixed_single_${passageNumber || 'passage'}`
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate ClozeMixed exercise: ${response.status}`);
  }

  return response.json();
}


