import React, { useState, useEffect } from 'react';
import { normalizeText, splitByBlanks, sanitizeClozeItem } from './utils.js';
import { generateUnifiedCloze, generateUnifiedClozeStepwise, convertToClozeMixed, filterBlanksByDifficulty } from './ClozeUnified.jsx';

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
export async function generateClozeMixed(topic, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  // Always use unified approach - this is the only supported method going forward
  console.log('Using unified cloze generation for ClozeMixed (cached as unified_cloze)');
  
  // Generate unified cloze using unified schema
  // Prefer stepwise generation with prompt caching; fallback to single-shot unified
  let unifiedResult;
  try {
    unifiedResult = await generateUnifiedClozeStepwise(topic, languageContext);
  } catch (e) {
    console.warn('[CLOZE-MIXED] Stepwise generation failed, falling back:', e?.message);
    unifiedResult = await generateUnifiedCloze(topic, 1, languageContext);
  }
  const unifiedItem = unifiedResult.items[0];
  
  // Apply difficulty filtering based on challenge mode and level
  const targetDifficulties = languageContext.challengeMode 
    ? ['easy', 'medium', 'hard'] 
    : ['easy', 'medium'];
  // Dynamically aim for up to 75% sentence coverage, at least baseline (8), capped at 12 and total candidates
  const segs = Array.isArray(unifiedItem.segments) ? unifiedItem.segments : [];
  const isFlat = segs.length > 0 && !('type' in (segs[0] || {}));
  const candidateCount = Number(unifiedItem.total_blanks || (isFlat
    ? segs.filter(s => Array.isArray(s.options) && s.options.some(o => o.correct)).length
    : segs.filter(s => s.type === 'blank').length));
  const sentenceCount = isFlat ? segs.length : Math.max(candidateCount, segs.length || candidateCount);
  const baseline = languageContext.challengeMode ? 12 : 8;
  const coverageAim = Math.ceil(sentenceCount * 0.75);
  const dynamicMax = Math.max(1, Math.min(12, Math.max(baseline, Math.min(candidateCount, coverageAim))))
  
  const filteredItem = filterBlanksByDifficulty(unifiedItem, targetDifficulties, dynamicMax);
  
  // Convert to ClozeMixed format for UI display
  const clozeMixedItem = convertToClozeMixed(filteredItem);
  
  return { items: [clozeMixedItem] };
}

// Deprecated traditional generation functions removed - using unified approach exclusively
