import React from 'react';
import { normalizeText, splitByBlanks } from './utils.js';

/**
 * Cloze with mixed options per blank (dropdowns)
 * item: { title?, studentInstructions?, passage, blanks: [{ index, options: string[], correct_index: number }], difficulty }
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
      {item?.studentInstructions && (
        <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 mb-2">
          {item.studentInstructions}
        </p>
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
 * @returns {Promise<{items: Array}>} Generated ClozeMixed exercises
 */
export async function generateClozeMixed(topic, count = 2) {
  const system = 'Generate Spanish cloze passages where each blank has a set of options including the target concept and closely-related distractors. Provide a concise student instruction telling what to choose (e.g., "Choose the correct adjective"), as a separate field named studentInstructions. Do not include the instruction text inside the passage itself.';
  
  const user = `Create exactly ${count} cloze-with-options passages about: ${topic}.`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            studentInstructions: { type: 'string', description: 'Concise directive for the student about what to select for blanks' },
            passage: { type: 'string' },
            blanks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              index: { type: 'integer' }, options: { type: 'array', items: { type: 'string' }, minItems: 3 }, correct_index: { type: 'integer' }
            }, required: ['index','options','correct_index'] }}
            
          },
          required: ['studentInstructions','passage','blanks']
        }
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
      schemaName: 'cloze_mixed_list'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate ClozeMixed exercises: ${response.status}`);
  }

  return response.json();
}


