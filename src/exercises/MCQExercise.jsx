import React from 'react';
import { pickRandomTopicSuggestion, formatTopicSuggestionForPrompt } from './utils.js';

/**
 * Multiple-choice exercise renderer
 * Props:
 * - item: { question, options: [{text, correct, rationale}], explanation?, difficulty }
 * - value: number | null (selected option index)
 * - onChange: (index:number) => void
 * - checked: boolean
 * - idPrefix: string
 */
export default function MCQExercise({ item, value, onChange, checked, idPrefix }) {
  const selectedIndex = typeof value === 'number' ? value : null;
  const options = Array.isArray(item?.options) ? item.options : [];
  return (
    <div className="border rounded p-3">
      <p className="font-medium text-gray-800 mb-2">{item?.question}</p>
      <ul className="space-y-1">
        {options.map((opt, oi) => {
          const chosen = selectedIndex === oi;
          const correct = checked && opt.correct;
          const wrongChosen = checked && chosen && !opt.correct;
          return (
            <li key={oi} className="text-sm text-gray-800 flex items-center gap-2">
              <input
                type="radio"
                name={`${idPrefix}`}
                checked={chosen || false}
                onChange={() => onChange(oi)}
              />
              <span className={`${correct ? 'text-green-700' : wrongChosen ? 'text-red-700' : ''}`}>{opt.text}</span>
            </li>
          );
        })}
      </ul>
      {checked && (() => {
        const correctIndex = options.findIndex(o => o && o.correct);
        const selectedOpt = (typeof selectedIndex === 'number' && selectedIndex >= 0) ? options[selectedIndex] : null;
        const correctOpt = correctIndex >= 0 ? options[correctIndex] : null;
        if (selectedOpt && !selectedOpt.correct) {
          return (
            <div className="mt-2 space-y-1">
              {selectedOpt.rationale && (
                <p className="text-xs text-red-700">Why your choice is incorrect: {selectedOpt.rationale}</p>
              )}
              {correctOpt && (
                <p className="text-xs text-green-700">Correct answer: {correctOpt.text}{correctOpt.rationale ? ` — ${correctOpt.rationale}` : ''}</p>
              )}
            </div>
          );
        }
        if (selectedOpt && selectedOpt.correct && selectedOpt.rationale) {
          return (
            <p className="text-xs text-green-700 mt-2">Why this is correct: {selectedOpt.rationale}</p>
          );
        }
        return null;
      })()}
      {checked && item?.explanation && (
        <p className="text-xs text-gray-600 mt-2">{item.explanation}</p>
      )}
    </div>
  );
}

export function scoreMCQ(item, value) {
  const options = Array.isArray(item?.options) ? item.options : [];
  const isCorrect = typeof value === 'number' && options[value]?.correct;
  return { correct: isCorrect ? 1 : 0, total: 1 };
}

/**
 * Generate MCQ exercises using the generic LLM endpoint
 * @param {string} topic - The topic to generate exercises about
 * @param {number} count - Number of exercises to generate (1-20)
 * @param {Object} languageContext - Language and level context { language, level, challengeMode }
 * @returns {Promise<{items: Array}>} Generated MCQ exercises
 */
export async function generateMCQ(topic, count = 5, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  
  const system = `You are a language pedagogy assistant that generates multiple-choice questions in the target language.

Requirements:
- Each item has exactly 4 options with exactly one correct answer
- Provide a short rationale for each option (why correct/incorrect)
- Use natural, real-world sentences (avoid synthetic phrasing)
- Keep content age-appropriate and culturally relevant
- Return ONLY fields that match the provided JSON schema (no extra text)`;

  const suggestion = pickRandomTopicSuggestion({ ensureNotEqualTo: topic });
  const topicLine = formatTopicSuggestionForPrompt(suggestion, { prefix: 'Unless the topic relates to specific vocabulary, you may use the following topic suggestion for variety' });

  const user = `Task: Create exactly ${count} multiple-choice questions.
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}
Topic: ${topic}

Notes:
- Include plausible distractors
- Ensure vocabulary and grammar complexity matches the target level
${topicLine}`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            question: { type: 'string' },
            options: { type: 'array', minItems: 4, maxItems: 4, items: {
              type: 'object', additionalProperties: false,
              properties: { text: { type: 'string' }, correct: { type: 'boolean' }, rationale: { type: 'string' } },
              required: ['text','correct','rationale']
            }},
            explanation: { type: 'string' },
            difficulty: { type: 'string' }
          },
          required: ['question','options','difficulty']
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
      schemaName: 'mcq_list',
      metadata: {
        language: languageName,
        level,
        challengeMode,
        topic
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate MCQ exercises: ${response.status}`);
  }

  return response.json();
}

