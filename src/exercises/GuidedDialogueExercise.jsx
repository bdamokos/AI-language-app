import { apiFetch } from '../utils/api.js';
import React, { useState } from 'react';
import { pickRandomTopicSuggestion, formatTopicSuggestionForPrompt } from './utils.js';
import { hasText, normalizeExerciseCount, validateGeneratedItems } from './generationValidation.js';

/**
 * Guided Dialogue exercise
 * item shape:
 * {
 *   title?: string,
 *   studentInstructions?: string,
 *   context?: string,
 *   conversationContext?: string, // Overall context of the conversation
 *   turns: Array<{
 *     speaker: string,
 *     text: string,
 *     hint?: string // Individual hint for this turn
 *   }>,
 *   suggested_hide_speaker?: string, // which speaker to hide in the UI
 *   hints?: string[], // Legacy: general hints (kept for compatibility)
 *   difficulty?: string
 * }
 * value: Record<string,string> keyed by turn index (string)
 */
export default function GuidedDialogueExercise({ item, value, onChange, checked, strictAccents = true, idPrefix, onFocusKey }) {
  const [showHints, setShowHints] = useState({});
  const turns = Array.isArray(item?.turns) ? item.turns : [];

  // Decide which speaker to hide: prefer explicit, then suggestion, then second distinct speaker
  const distinctSpeakers = Array.from(new Set(turns.map(t => t.speaker).filter(Boolean)));
  const hiddenSpeaker = item?.hide_speaker || item?.suggested_hide_speaker || (distinctSpeakers[1] || distinctSpeakers[0] || '');

  // Always show at least the first turn of the hidden speaker for context
  const showFirstHiddenTurn = turns.findIndex(turn => turn.speaker === hiddenSpeaker) !== -1;

  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium mb-2">{item.title}</p>}

      {item?.conversationContext && (
        <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded">
          <p className="text-sm font-medium text-gray-700 mb-1">Conversation Context:</p>
          <p className="text-sm text-gray-600">{item.conversationContext}</p>
        </div>
      )}

      {item?.studentInstructions && (
        <p className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 mb-2">
          {item.studentInstructions}
        </p>
      )}

      <div className="space-y-2">
        {turns.map((turn, idx) => {
          const isHiddenTurn = hiddenSpeaker && turn.speaker === hiddenSpeaker;
          const shouldShowTurn = !isHiddenTurn || (showFirstHiddenTurn && idx === turns.findIndex(t => t.speaker === hiddenSpeaker));

          return (
            <div key={idx} className="flex items-start gap-2">
              <span className="font-semibold text-gray-700 min-w-[3rem]">{turn.speaker || '—'}:</span>
              {shouldShowTurn ? (
                <div className="flex-1 text-gray-800">{turn.text}</div>
              ) : (
                <div className="flex-1">
                  <input
                    data-key={`${idPrefix}:${idx}`}
                    type="text"
                    value={String(value?.[String(idx)] || '')}
                    onChange={(e) => onChange(String(idx), e.target.value)}
                    onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:${idx}`)}
                    className={`w-full max-w-xl px-2 py-1 border rounded ${checked ? 'bg-gray-50' : ''}`}
                    placeholder="Write the missing line..."
                  />
                  {checked && (
                    <div className="mt-1 px-2 py-1 border rounded bg-green-50 text-green-800 text-xs">
                      Suggested answer: {turn.text}
                    </div>
                  )}
                  {!checked && turn.hint && (
                    <button
                      type="button"
                      onClick={() => setShowHints(prev => ({ ...prev, [idx]: !prev[idx] }))}
                      className="mt-1 text-xs text-blue-600 hover:text-blue-800 underline"
                    >
                      {showHints[idx] ? 'Hide hint' : 'Show hint'}
                    </button>
                  )}
                  {!checked && showHints[idx] && turn.hint && (
                    <div className="mt-1 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1">
                      {turn.hint}
                    </div>
                  )}
                  {!checked && !turn.hint && Array.isArray(item?.hints) && item.hints.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowHints(prev => ({ ...prev, [idx]: !prev[idx] }))}
                      className="mt-1 text-xs text-blue-600 hover:text-blue-800 underline"
                    >
                      {showHints[idx] ? 'Hide hint' : 'Show hint'}
                    </button>
                  )}
                  {!checked && showHints[idx] && !turn.hint && Array.isArray(item?.hints) && item.hints.length > 0 && (
                    <div className="mt-1 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1">
                      {item.hints[0]}
                    </div>
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
export function scoreGuidedDialogue(item, value, eq) {
  return { correct: 0, total: 0 };
}

/**
 * Generate Guided Dialogue exercises
 * Each item contains a complete short dialogue (no blanks). We'll hide one speaker programmatically.
 * If inspiration context is provided, will generate dialogues inspired by that context.
 */
export async function generateGuidedDialogues(topic, count = 2, languageContext = { language: 'es', level: 'B1', challengeMode: false }, inspirationContext = null) {
  count = normalizeExerciseCount(count, 10);
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;

  const system = `Create guided dialogues in the target language, matching the learner's level.
Return only JSON matching the schema.
- Use exactly two consistent speakers and 6–12 complete turns per dialogue, with at least two turns per speaker.
- Each turn needs its full text and a specific hint that helps the learner reconstruct that line; do not insert blanks.
- Give the situation in conversationContext and concise completion instructions in studentInstructions.
- Set suggested_hide_speaker to one of the two speakers; the app hides that speaker's lines after the first example.
- Use natural dialogue that practises the requested topic.`;

  const source = inspirationContext
    ? `Source: ${inspirationContext.chapter_title || 'Prior chapter'} (chapter ${inspirationContext.chapter_number || 1})
${inspirationContext.chapter_passage || ''}
Use this source's situation and vocabulary as inspiration.`
    : formatTopicSuggestionForPrompt(pickRandomTopicSuggestion({ ensureNotEqualTo: topic }), {
      prefix: 'Optional setting, when compatible with the requested topic'
    });
  const user = `Create exactly ${count} guided dialogues.
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}
Topic: ${topic}
${source}`;
  const baseTextContext = inspirationContext;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', minItems: count, maxItems: count, items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            studentInstructions: { type: 'string' },
            conversationContext: { type: 'string' },
            turns: {
              type: 'array', minItems: 6, maxItems: 12, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  speaker: { type: 'string' },
                  text: { type: 'string' },
                  hint: { type: 'string' }
                },
                required: ['speaker','text','hint']
              }
            },
            suggested_hide_speaker: { type: 'string' },
            difficulty: { type: 'string' }
          },
          required: ['studentInstructions','conversationContext','turns','suggested_hide_speaker']
        }
      }
    },
    required: ['items']
  };

  const response = await apiFetch('/api/generate', {
    method: 'POST',
    signal: languageContext?.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: schema,
      schemaName: 'guided_dialogues_list',
      metadata: {
        language: languageName,
        level,
        challengeMode,
        topic,
        ...(baseTextContext && {
          inspiredByChapter: baseTextContext.chapter_title,
          inspiredByChapterNumber: baseTextContext.chapter_number,
          inspiredByExercise: baseTextContext.exercise_type,
          inspiredByBaseText: baseTextContext.base_text_id,
          inspiredByChapterContent: !!baseTextContext.chapter_passage
        })
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate guided dialogues: ${response.status}`);
  }

  const result = await response.json();
  return validateGeneratedItems(result, count, 'guided dialogues', item => {
    if (!hasText(item.studentInstructions) || !hasText(item.conversationContext) ||
        !Array.isArray(item.turns) || item.turns.length < 6 || item.turns.length > 12 ||
        !item.turns.every(turn => hasText(turn?.speaker) && hasText(turn?.text) && hasText(turn?.hint))) return false;
    const speakers = new Set(item.turns.map(turn => turn.speaker));
    return speakers.size === 2 && speakers.has(item.suggested_hide_speaker) &&
      [...speakers].every(speaker => item.turns.filter(turn => turn.speaker === speaker).length >= 2);
  });
}
