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
  
  const system = `You are creating fill-in-the-blank exercises using an existing text passage. Extract meaningful sentences from the passage and create blanks that test the target grammar topic. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}.`;

  const user = `Create exactly ${count} ${languageName} language fill-in-the-blank exercises based on the following passage from "${baseText?.title || 'Unknown'}":

**Chapter: ${chapter.title}**
**Passage:**
${chapter.passage}

**Grammar Focus:** ${topic}

Requirements:
- Extract ${count} sentences from the passage that can be used to test "${topic}"
- If the passage doesn't contain enough suitable examples, adapt existing sentences to include the target grammar
- Each exercise should use a different sentence from the passage or an adapted version
- Use exactly _____ (5 underscores) for each blank
- Put basic hint in parentheses after the blank
- Provide up to 3 progressive hints in the "hints" array:
  - First hint: general guidance to help user think
  - Second hint: more specific clue
  - Third hint: very specific (e.g., "starts with 'vi...'")
- If exercise is simple, you can provide fewer hints or make the third hint show first letters
- "context" field is optional - include interesting cultural notes related to the story context
- Make exercises progressively harder
- Target CEFR level: ${level}${challengeMode ? ' with some challenging elements' : ''}

**Important:** Extract as many relevant exercises as possible from this single passage. Each exercise should test the grammar topic while maintaining story coherence. Aim to use ${count} different sentences or sentence variations from the passage.`;

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


