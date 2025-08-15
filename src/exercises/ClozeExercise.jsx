import React from 'react';
import { normalizeText, countBlanks, splitByBlanks } from './utils.js';

/**
 * Cloze passage with free-text blanks
 * item: { title?, passage, blanks: [{ index, answer }], difficulty }
 * value: Record<string,string>
 */
export default function ClozeExercise({ item, value, onChange, checked, strictAccents = true, idPrefix, onFocusKey }) {
  const parts = splitByBlanks(item?.passage || '');
  const blanks = Array.isArray(item?.blanks) ? item.blanks : [];
  const nodes = [];
  for (let i = 0; i < parts.length; i++) {
    nodes.push(<span key={`t-${i}`}>{parts[i]}</span>);
    if (i < parts.length - 1) {
      const blank = blanks.find(b => b.index === i) || { answer: '' };
      const key = String(i);
      const val = value?.[key] || '';
      const isCorrect = checked && blank.answer && normalizeText(val, strictAccents) === normalizeText(blank.answer, strictAccents);
      nodes.push(
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
      );
      if (checked) {
        nodes.push(
          <span key={`f-${i}`} className={`ml-1 text-xs ${isCorrect ? 'text-green-700' : 'text-red-700'}`}>{isCorrect ? '✓' : `(${blank.answer || ''})`}</span>
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
 * @returns {Promise<{items: Array}>} Generated Cloze exercises
 */
export async function generateCloze(topic, count = 2) {
  const system = 'Generate Spanish cloze passages with several blanks (_____). Include an answers array with index and answer.';
  
  const user = `Create exactly ${count} cloze passages about: ${topic}.`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            passage: { type: 'string' },
            blanks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              index: { type: 'integer' }, answer: { type: 'string' }, hint: { type: 'string' }, rationale: { type: 'string' }
            }, required: ['index','answer'] }},
            difficulty: { type: 'string' }
          },
          required: ['passage','blanks','difficulty']
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
        maxTokens: 15000,
      jsonSchema: schema,
      schemaName: 'cloze_list'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate Cloze exercises: ${response.status}`);
  }

  return response.json();
}


