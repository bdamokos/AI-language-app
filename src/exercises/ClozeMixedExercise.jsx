import React from 'react';
import { normalizeText, splitByBlanks } from './utils.js';

/**
 * Cloze with mixed options per blank (dropdowns)
 * item: { title?, passage, blanks: [{ index, options: string[], correct_index: number }], difficulty }
 * value: Record<string,string>
 */
export default function ClozeMixedExercise({ item, value, onChange, checked, strictAccents = true, idPrefix }) {
  const parts = splitByBlanks(item?.passage || '');
  const nodes = [];
  for (let i = 0; i < parts.length; i++) {
    nodes.push(<span key={`t-${i}`}>{parts[i]}</span>);
    if (i < parts.length - 1) {
      const blank = (item?.blanks || []).find(b => b.index === i) || { options: [], correct_index: -1 };
      const correctOpt = blank.options?.[blank.correct_index];
      const key = String(i);
      const val = value?.[key] ?? '';
      nodes.push(
        <select key={`s-${i}`} className="mx-1 px-2 py-1 border rounded" value={val} onChange={e => onChange(key, e.target.value)} disabled={checked}>
          <option value="">...</option>
          {blank.options.map((opt, oi) => (
            <option key={oi} value={opt}>{opt}</option>
          ))}
        </select>
      );
      if (checked) {
        const isCorrect = val && correctOpt && normalizeText(val, strictAccents) === normalizeText(correctOpt, strictAccents);
        nodes.push(
          <span key={`f-${i}`} className={`ml-1 text-xs ${isCorrect ? 'text-green-700' : 'text-red-700'}`}>{isCorrect ? '✓' : `(${correctOpt || ''})`}</span>
        );
      }
    }
  }
  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium mb-2">{item.title}</p>}
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


