import React, { useState } from 'react';
import { pickRandomTopicSuggestion, formatTopicSuggestionForPrompt } from './utils.js';

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
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;

  console.log('generateGuidedDialogues received inspirationContext:', inspirationContext);

  let system, user, baseTextContext;

  if (inspirationContext) {
    // Generate dialogues inspired by provided context
    system = `Generate ${languageName} guided dialogues inspired by a previously used text passage. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}.`;

    const chapterInfo = inspirationContext.chapter_passage
      ? `**Chapter Content:**
${inspirationContext.chapter_passage}

**Source Material:** "${inspirationContext.chapter_title}" (Chapter ${inspirationContext.chapter_number})`
      : `**Source Material:** "${inspirationContext.chapter_title}" (Chapter ${inspirationContext.chapter_number})`;

    console.log('Generated chapterInfo for LLM prompt:', chapterInfo);
    console.log('Has chapter passage:', !!inspirationContext.chapter_passage);

    user = `Create exactly ${count} dialogues in ${languageName} inspired by the following chapter that was previously used in the lesson:

${chapterInfo}
**Previously Used For:** ${inspirationContext.exercise_type.replace('_', ' ')}

Requirements:
- Create dialogues that take inspiration from the themes, vocabulary, and situations in the chapter content above
- Two consistent speakers across the whole dialogue (e.g., "A" and "B" or names); 6-12 turns total
- Do NOT include blanks; produce the full conversation text for every turn
- Provide a conversationContext string that explains the overall situation/setting of the dialogue
- Provide detailed studentInstructions that include the conversation context so students understand what's happening
- For EACH turn in the dialogue, provide an individual hint that helps reconstruct that specific turn (not general hints)
- Provide suggested_hide_speaker indicating which speaker's lines would be best to hide pedagogically
- Ensure vocabulary and grammar match ${level}${challengeMode ? ' with some challenging elements' : ''}
- Choose real world sentences, not synthetic ones
- Keep content age-appropriate and culturally relevant

== EXAMPLES ==
If the chapter was about "Luisa and Juan in a restaurant", create a dialogue about "a discussion at a restaurant" or "ordering food" or "restaurant conversation". Each turn should have its own specific hint like "Ask about the menu" or "Express a preference for vegetarian food" or "Make a recommendation".

An example of a dialogue with hints if the topic was "indirect object pronouns", the difficulty was B1 and the challenge mode was false:

- Conversation Context: "Luisa and Juan are at a restaurant discussing their orders. The first speaker is Luisa, the second speaker is Juan."
- Student Instructions: "Complete the missing lines in the conversation, using indirect object pronouns where appropriate."
- Turns:
  - "A: ¿Le puedes pedir al camarero una mesa junto a la ventana?" (hint: "Luisa asks Juan to request a table by the window for them")
  - "B: Claro, le voy a pedir una mesa allí." (hint: "Juan agrees and says he will ask the waiter for a table there")
  - "A: ¿Te gustaría que te recomiende algún plato?" (hint: "Luisa offers to recommend a dish to Juan")
  - "B: Sí, me encantaría que me recomiendes algo típico." (hint: "Juan says he would love a recommendation for something typical")
  - "A: El camarero nos trae el menú." (hint: "Luisa mentions that the waiter is bringing the menu")

== END EXAMPLES ==

`;

    baseTextContext = inspirationContext;
  } else {
    // Fall back to original logic with topic roulette
    system = `Generate ${languageName} guided dialogues. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}.`;

    const suggestion = pickRandomTopicSuggestion({ ensureNotEqualTo: topic });
    const topicLine = formatTopicSuggestionForPrompt(suggestion, { prefix: 'Unless the topic relates to specific vocabulary, you may use the following topic suggestion for variety' });

    user = `Create exactly ${count} dialogues in ${languageName} about: ${topic}.

Requirements:
- Two consistent speakers across the whole dialogue (e.g., "A" and "B" or names); 6-12 turns total
- Do NOT include blanks; produce the full conversation text for every turn
- Provide a conversationContext string that explains the overall situation/setting of the dialogue
- Provide detailed studentInstructions that include the conversation context so students understand what's happening
- For EACH turn in the dialogue, provide an individual hint that helps reconstruct that specific turn (not general hints)
- Provide suggested_hide_speaker indicating which speaker's lines would be best to hide pedagogically
- Ensure vocabulary and grammar match ${level}${challengeMode ? ' with some challenging elements' : ''}
- Choose real world sentences, not synthetic ones.
${topicLine}
- Keep content age-appropriate and culturally relevant

Example: For a topic like "ordering food", each turn should have its own specific hint like "Greet the waiter" or "Ask about daily specials" or "Request the bill".`;
  }



  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' },
            studentInstructions: { type: 'string' },
            conversationContext: { type: 'string' },
            context: { type: 'string' }, // Legacy field for compatibility
            turns: {
              type: 'array', minItems: 6, maxItems: 12, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  speaker: { type: 'string' },
                  text: { type: 'string' },
                  hint: { type: 'string' }
                },
                required: ['speaker','text']
              }
            },
            suggested_hide_speaker: { type: 'string' },
            hints: { type: 'array', items: { type: 'string' } }, // Legacy field for compatibility
            difficulty: { type: 'string' }
          },
          required: ['studentInstructions','conversationContext','turns']
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

  return response.json();
}


