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

/**
 * Generate FIB exercises from base text chapters
 * @param {string} topic - The topic to generate exercises about
 * @param {number} count - Number of exercises to generate (1-20)
 * @param {Object} languageContext - Language and level context { language, level, challengeMode, chapter, baseText }
 * @returns {Promise<{items: Array}>} Generated FIB exercises
 */
export async function generateFIB(topic, count = 5, languageContext) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  const chapter = languageContext.chapter;
  const baseText = languageContext.baseText;

  if (!chapter || !chapter.passage) {
    throw new Error('No base text chapter provided for FIB generation');
  }
  
  const system = `You are creating fill-in-the-blank exercises using an existing text passage.

Requirements:
- Extract meaningful sentences from the given passage (or minimally adapt when needed)
- Create blanks that test the target grammar topic using exactly 5 underscores (_____)
- Provide a basic hint after each blank in parentheses
- Also provide up to 3 progressive hints in a "hints" array (general → specific → very specific)
- Optional: include a brief "context" note when helpful
- Make exercises progressively harder
- Return ONLY fields that match the provided JSON schema (no extra text)`;

  const user = `Task: Create exactly ${count} fill-in-the-blank exercises.
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}
Grammar Focus: ${topic}
Source: ${baseText?.title || 'Unknown'} — Chapter: ${chapter.title}

Passage:
${chapter.passage}

Important:
- Aim to use ${count} different sentences or minimal variations from the passage
- Maintain story coherence and keep difficulty appropriate for the target level`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            sentence: { type: 'string' },
            answers: { type: 'array', items: { type: 'string' } },
            hint: { type: 'string' },
            hints: { type: 'array', items: { type: 'string' } },
            context: { type: 'string' },
            difficulty: { type: 'string' }
          },
          required: ['sentence','answers','difficulty']
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
      schemaName: 'fib_list',
      metadata: { 
        language: languageName, 
        level, 
        challengeMode, 
        topic,
        count: Number(count) || 1,
        baseTextId: baseText?.id,
        chapterNumber: chapter?.number,
        chapterTitle: chapter?.title
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate FIB exercises: ${response.status}`);
  }

  const result = await response.json();
  
  // Add base text metadata to the result
  if (result.items && result.items.length > 0) {
    result.items.forEach(item => {
      item.base_text_info = {
        base_text_id: baseText?.id,
        chapter_number: chapter?.number,
        chapter_title: chapter?.title
      };
    });
  }

  return result;
}

