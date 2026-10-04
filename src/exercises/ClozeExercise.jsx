import React, { useState, useEffect } from 'react';
import { normalizeText, countBlanks, splitByBlanks, sanitizeClozeItem } from './utils.js';
import { generateUnifiedCloze, convertToTraditionalCloze } from './ClozeUnified.jsx';

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
  // Sanitize the item when it changes
  useEffect(() => {
    if (item) {
      const sanitization = sanitizeClozeItem(item);
      setSanitizedItem(sanitization.item);
      setWarnings(sanitization.warnings);
      

    }
  }, [item]);

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
      
      {/* Cloze passage */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Text passage */}
        <div className="flex-1">
          <div className="text-gray-800 leading-relaxed">{nodes}</div>
        </div>
        

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
 * @param {Object} languageContext - Language and level context { language, level, challengeMode, chapter?, baseText? }
 * @returns {Promise<{items: Array}>} Generated Cloze exercises in traditional format
 */
export async function generateCloze(topic, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const result = await generateUnifiedCloze(topic, 1, languageContext);
  return { items: [convertToTraditionalCloze(result.items[0])] };
}

// Deprecated traditional generation functions removed - using unified approach exclusively
