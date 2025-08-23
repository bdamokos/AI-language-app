import React from 'react';
import { Check } from 'lucide-react';
import { normalizeText } from './utils.js';

/**
 * Sentence Rewriting exercise
 * item shape:
 * {
 *   original: string,
 *   instruction: string, // what to do (e.g., "Rewrite in past tense", "Use pronouns")
 *   answer: string,      // expected rewritten sentence
 *   hint?: string,
 *   hints?: string[],
 *   rationale?: string,
 *   context?: string,
 *   difficulty?: string,
 *   base_text_info?: { base_text_id, chapter_number, chapter_title }
 * }
 * value: string (user's rewritten sentence)
 */
export default function RewritingExercise({ item, value, onChange, checked, strictAccents = true, idPrefix, onFocusKey, showInstruction = true }) {
  const userVal = typeof value === 'string' ? value : '';
  const expected = String(item?.answer || '');
  const isCorrect = checked && expected && normalizeText(userVal, strictAccents) === normalizeText(expected, strictAccents);
  const isWrong = checked && userVal && expected && !isCorrect;

  return (
    <div className="border rounded p-3">
      {showInstruction && item?.instruction && (
        <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 mb-2">
          {item.instruction}
        </p>
      )}
      {item?.original && (
        <p className="text-gray-800 mb-2">
          <span className="font-medium">Original:</span> {item.original}
        </p>
      )}

      <div className="space-y-1">
        <input
          data-key={`${idPrefix}`}
          type="text"
          className={`w-full px-2 py-1 border rounded ${isCorrect ? 'border-green-500 bg-green-50' : isWrong ? 'border-red-500 bg-red-50' : 'border-gray-300'}`}
          placeholder="Rewrite here..."
          value={userVal}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => onFocusKey && onFocusKey(`${idPrefix}`)}
        />
        {checked && expected && (
          <div className="text-sm">
            {isCorrect ? (
              <span className="text-green-700 inline-flex items-center gap-1"><Check size={14} /> Correct</span>
            ) : (
              <span className="text-red-700">Answer: {expected}</span>
            )}
          </div>
        )}
      </div>

      {(() => {
        const firstHint = (Array.isArray(item?.hints) && item.hints.length > 0) ? item.hints[0] : (item?.hint || null);
        return (!checked && firstHint) ? (
          <div className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            Hint: {firstHint}
          </div>
        ) : null;
      })()}

      {item?.context && (
        <div className="mt-2 text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded px-2 py-1">
          Context: {item.context}
        </div>
      )}
    </div>
  );
}

/**
 * Score a rewriting item: 1 if normalized equality, else 0.
 */
export function scoreRewriting(item, value, eq) {
  const expected = String(item?.answer || '');
  const given = String(value || '');
  const correct = expected && eq(given, expected) ? 1 : 0;
  return { correct, total: 1 };
}

/**
 * Generate Rewriting exercises from a base text chapter.
 * @param {string} topic - Target grammar topic (e.g., "past tense", "pronouns")
 * @param {number} count - Number of exercises
 * @param {Object} languageContext - { language, level, challengeMode, baseText, chapter }
 * @returns {Promise<{items: Array}>}
 */
export async function generateRewriting(topic, count = 5, languageContext) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  const chapter = languageContext.chapter;
  const baseText = languageContext.baseText;

  if (!chapter || !chapter.passage) {
    throw new Error('No base text chapter provided for Rewriting generation');
  }

  const system = `You are a language pedagogy expert.You are creating sentence rewriting exercises using an existing passage. Each item should ask the student to rewrite a sentence according to the target grammar focus. Keep difficulty appropriate for ${level}${challengeMode ? ' (slightly challenging)' : ''}.`;

  const user = `Create exactly ${count} ${languageName} sentence rewriting exercises based on the chapter below from "${baseText?.title || 'Unknown'}".

Chapter: ${chapter.title}
Passage:
${chapter.passage}

Grammar Focus: ${topic}

For each exercise, provide:
- original: a short sentence from the passage (or minimally adapted to fit the focus)
- instruction: a clear rewriting instruction (e.g., "Rewrite in the past tense", "Replace the object with a pronoun")
- answer: the correctly rewritten sentence
- hint: brief guidance that does not give away the answer
- rationale: why the rewriting is correct

Constraints:
- Use real sentences aligned with the passage context
- Keep answers concise and grammatical
- Do not include multiple valid answers for the same item
- Avoid ambiguous prompts where multiple rewrites are defensible`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            original: { type: 'string' },
            instruction: { type: 'string' },
            answer: { type: 'string' },
            hint: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['original','instruction','answer']
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
      schemaName: 'rewriting_list',
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
    throw new Error(`Failed to generate Rewriting exercises: ${response.status}`);
  }

  const result = await response.json();
  if (result.items && result.items.length > 0) {
    result.items.forEach(it => {
      it.base_text_info = {
        base_text_id: baseText?.id,
        chapter_number: chapter?.number,
        chapter_title: chapter?.title
      };
    });
  }
  return result;
}


