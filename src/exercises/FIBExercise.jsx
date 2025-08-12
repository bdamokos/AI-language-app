import React from 'react';
import { Check } from 'lucide-react';
import { normalizeText, countBlanks, splitByBlanks } from './utils.js';

/**
 * Fill-in-the-blank exercise component (renderer-only)
 * Props:
 * - item: { sentence: string, answers: string[], hint?: string, hints?: string[], context?: string }
 * - value: Record<string,string> (user answers map keyed by local blank index as string)
 * - onChange: (key:string, value:string) => void
 * - checked: boolean
 * - strictAccents: boolean
 * - idPrefix: string (unique namespace)
 */
export default function FIBExercise({ item, value, onChange, checked, strictAccents = true, idPrefix, onFocusKey }) {
  const blanks = countBlanks(item?.sentence || '');
  const parts = splitByBlanks(item?.sentence || '');
  const answers = Array.isArray(item?.answers) ? item.answers : [];

  const segments = [];
  for (let i = 0; i < parts.length; i++) {
    segments.push(<span key={`t-${i}`}>{parts[i]}</span>);
    if (i < parts.length - 1) {
      const answer = answers[i] || answers[0] || '';
      const key = String(i);
      const userVal = value?.[key] || '';
      const isCorrect = checked && answer && normalizeText(userVal, strictAccents) === normalizeText(answer, strictAccents);
      const isWrong = checked && userVal && answer && !isCorrect;
      segments.push(
        <input
          key={`i-${i}`}
          data-key={`${idPrefix}:${i}`}
          type="text"
          value={userVal}
          onChange={(e) => onChange(key, e.target.value)}
          onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:${i}`)}
          disabled={checked}
          className={`mx-1 px-2 py-0.5 border rounded-md inline-block w-32 ${
            isCorrect ? 'border-green-500 bg-green-50' : isWrong ? 'border-red-500 bg-red-50' : 'border-gray-300'
          }`}
          placeholder="..."
        />
      );
      if (checked && answer) {
        segments.push(
          <span key={`f-${i}`} className="ml-1">
            {isCorrect ? (
              <Check className="text-green-600 inline" size={16} />
            ) : (
              <span className="text-sm text-red-600">({answer})</span>
            )}
          </span>
        );
      }
    }
  }

  return (
    <div className="text-gray-800 leading-relaxed">
      {segments}
    </div>
  );
}

/**
 * Pure function: compute score for a FIB item
 * @param {object} item
 * @param {Record<string,string>} value
 * @param {(a:string,b:string)=>boolean} eq
 */
export function scoreFIB(item, value, eq) {
  const blanks = countBlanks(item?.sentence || '');
  const answers = Array.isArray(item?.answers) ? item.answers : [];
  let correct = 0;
  for (let i = 0; i < blanks; i++) {
    const answer = answers[i] || answers[0] || '';
    if (eq(String(value?.[String(i)] || ''), String(answer))) correct++;
  }
  return { correct, total: blanks };
}


