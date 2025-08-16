import React, { useState } from 'react';

/**
 * Writing Prompt exercise (open-ended)
 * item shape:
 * {
 *   title?: string,
 *   studentInstructions?: string,
 *   prompts: Array<{ question: string }>,
 *   example_answers?: Array<string>,
 *   difficulty?: string
 * }
 * value: Record<string,string> where keys are prompt indices as strings
 */
export default function WritingPromptExercise({ item, value, onChange, checked, idPrefix, onFocusKey }) {
  const [expandedExample, setExpandedExample] = useState({});

  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium mb-2">{item.title}</p>}
      {item?.studentInstructions && (
        <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 mb-2">
          {item.studentInstructions}
        </p>
      )}

      <div className="space-y-4">
        {(item?.prompts || []).map((p, idx) => {
          const key = String(idx);
          const text = String(value?.[key] || '');
          const example = Array.isArray(item?.example_answers) ? item.example_answers[idx] : null;
          return (
            <div key={idx} className="space-y-1">
              <div className="font-medium text-gray-800">{idx + 1}. {p.question}</div>
              <textarea
                data-key={`${idPrefix}:${idx}`}
                className="w-full min-h-[90px] px-2 py-1 border rounded"
                placeholder="Write your response..."
                value={text}
                onChange={(e) => onChange(key, e.target.value)}
                onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:${idx}`)}
              />
              {checked && example && (
                <div className="text-xs text-green-700">
                  Example answer: <button type="button" className="underline" onClick={() => setExpandedExample(prev => ({ ...prev, [idx]: !prev[idx] }))}>{expandedExample[idx] ? 'Hide' : 'Show'}</button>
                  {expandedExample[idx] && (
                    <div className="mt-1 text-green-800 bg-green-50 border border-green-200 rounded px-2 py-1 whitespace-pre-wrap">{example}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Open-ended: do not count toward automatic score
export function scoreWritingPrompt(item, value, eq) {
  return { correct: 0, total: 0 };
}

/**
 * Generate Writing Prompt exercises
 */
export async function generateWritingPrompts(topic, count = 2, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;

  const system = `Generate ${languageName} open-ended writing prompts designed to elicit target grammar or vocabulary usage. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}.`;

  const user = `Create exactly ${count} writing prompt sets in ${languageName} about: ${topic}.

For each set:
- Include 3-5 open-ended questions (prompts) that encourage use of the target grammar or vocabulary
- Provide a concise studentInstructions string
- Include example_answers with short sample responses (one per prompt) to show expected complexity and style
- Ensure vocabulary and grammar match ${level}${challengeMode ? ' with some challenging elements' : ''}`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            studentInstructions: { type: 'string' },
            prompts: { type: 'array', minItems: 3, maxItems: 5, items: {
              type: 'object', additionalProperties: false,
              properties: { question: { type: 'string' } },
              required: ['question']
            }},
            example_answers: { type: 'array', items: { type: 'string' } },
            difficulty: { type: 'string' }
          },
          required: ['studentInstructions','prompts']
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
      schemaName: 'writing_prompts_list'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate writing prompts: ${response.status}`);
  }

  return response.json();
}


