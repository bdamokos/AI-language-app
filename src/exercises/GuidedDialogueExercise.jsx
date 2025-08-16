import React, { useState } from 'react';

/**
 * Guided Dialogue exercise
 * item shape:
 * {
 *   title?: string,
 *   studentInstructions?: string,
 *   context?: string,
 *   turns: Array<{ speaker: string, text: string }>,
 *   suggested_hide_speaker?: string, // which speaker to hide in the UI
 *   hints?: string[],
 *   difficulty?: string
 * }
 * value: Record<string,string> keyed by turn index (string)
 */
export default function GuidedDialogueExercise({ item, value, onChange, checked, strictAccents = true, idPrefix, onFocusKey }) {
  const [showHints, setShowHints] = useState(false);
  const turns = Array.isArray(item?.turns) ? item.turns : [];
  // Decide which speaker to hide: prefer explicit, then suggestion, then second distinct speaker
  const distinctSpeakers = Array.from(new Set(turns.map(t => t.speaker).filter(Boolean)));
  const hiddenSpeaker = item?.hide_speaker || item?.suggested_hide_speaker || (distinctSpeakers[1] || distinctSpeakers[0] || '');

  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium mb-2">{item.title}</p>}
      {item?.studentInstructions && (
        <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 mb-2">
          {item.studentInstructions}
        </p>
      )}
      {item?.context && (
        <p className="text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded px-2 py-1 mb-2">
          {item.context}
        </p>
      )}

      <div className="space-y-2">
        {turns.map((turn, idx) => {
          const isHiddenTurn = hiddenSpeaker && turn.speaker === hiddenSpeaker;
          return (
            <div key={idx} className="flex items-start gap-2">
              <span className="font-semibold text-gray-700 min-w-[3rem]">{turn.speaker || '—'}:</span>
              {isHiddenTurn ? (
                <div className="flex-1">
                  {checked ? (
                    <div className="px-2 py-1 border rounded bg-green-50 text-green-800 text-sm">
                      {turn.text}
                    </div>
                  ) : (
                  <input
                    data-key={`${idPrefix}:${idx}`}
                    type="text"
                    value={String(value?.[String(idx)] || '')}
                    onChange={(e) => onChange(String(idx), e.target.value)}
                    onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:${idx}`)}
                    disabled={checked}
                    className={`w-full max-w-xl px-2 py-1 border rounded ${checked ? 'bg-gray-50' : ''}`}
                    placeholder="Write the missing line..."
                  />
                  )}
                  {!checked && Array.isArray(item?.hints) && item.hints.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowHints(v => !v)}
                      className="mt-1 text-xs text-blue-600 hover:text-blue-800 underline"
                    >
                      {showHints ? 'Hide hint' : 'Show hint'}
                    </button>
                  )}
                  {!checked && showHints && Array.isArray(item?.hints) && item.hints.length > 0 && (
                    <div className="mt-1 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1">
                      {item.hints[0]}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 text-gray-800">{turn.text}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Open-ended: do not count toward automatic score
export function scoreGuidedDialogue(item, value, eq) {
  return { correct: 0, total: 0 };
}

/**
 * Generate Guided Dialogue exercises
 * Each item contains a complete short dialogue (no blanks). We'll hide one speaker programmatically.
 */
export async function generateGuidedDialogues(topic, count = 2, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;

  const system = `Generate ${languageName} guided dialogues. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}.`;

  const user = `Create exactly ${count} dialogues in ${languageName} about: ${topic}.

Requirements:
- Two consistent speakers across the whole dialogue (e.g., "A" and "B" or names); 6-12 turns total
- Do NOT include blanks; produce the full conversation text for every turn
- Provide a short studentInstructions string (we will hide one speaker in the UI)
- Provide suggested_hide_speaker indicating which speaker’s lines would be best to hide pedagogically
- Provide 1-2 short hints that guide the student without giving away the full answers
- Ensure vocabulary and grammar match ${level}${challengeMode ? ' with some challenging elements' : ''}
- Keep content age-appropriate and culturally relevant`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            studentInstructions: { type: 'string' },
            context: { type: 'string' },
            turns: {
              type: 'array', minItems: 6, maxItems: 12, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  speaker: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['speaker','text']
              }
            },
            suggested_hide_speaker: { type: 'string' },
            hints: { type: 'array', items: { type: 'string' } },
            difficulty: { type: 'string' }
          },
          required: ['studentInstructions','turns']
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
      schemaName: 'guided_dialogues_list'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate guided dialogues: ${response.status}`);
  }

  return response.json();
}


