import React from 'react';

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
                disabled={checked}
              />
              <span className={`${correct ? 'text-green-700' : wrongChosen ? 'text-red-700' : ''}`}>{opt.text}</span>
            </li>
          );
        })}
      </ul>
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
 * @returns {Promise<{items: Array}>} Generated MCQ exercises
 */
export async function generateMCQ(topic, count = 5) {
  const system = 'Generate Spanish multiple-choice questions with 4 options, one correct, with rationales.';
  
  const user = `Create exactly ${count} MCQs about: ${topic}. Include plausible distractors.`;

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
      schemaName: 'mcq_list'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate MCQ exercises: ${response.status}`);
  }

  return response.json();
}


