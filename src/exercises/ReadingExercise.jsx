import { apiFetch } from '../utils/api.js';
import React from 'react';
import { pickRandomTopicSuggestion, formatTopicSuggestionForPrompt } from './utils.js';

/**
 * Reading Comprehension exercise
 * item shape:
 * {
 *   title: string,
 *   passage: string,
 *   image_prompt?: string,
 *   glossary: Array<{ term: string, pos: 'noun'|'verb'|'adj'|'adv'|'expr', definition: string, translation: string|null, example: string }>,
 *   true_false: Array<{ statement: string, answer: boolean }>,
 *   comprehension_questions: Array<{ question: string, model_answer: string }>,
 *   productive_prompts: Array<string>,
 *   difficulty?: string
 * }
 * value: Record<string, any>
 *   - keys: tf:{index} => boolean | null
 *           qa:{index} => string
 *           pp:{index} => string
 */
export default function ReadingExercise({ item, value, onChange, checked, idPrefix, onFocusKey }) {
  const tfItems = Array.isArray(item?.true_false) ? item.true_false : [];
  const qaItems = Array.isArray(item?.comprehension_questions) ? item.comprehension_questions : [];
  const glossary = Array.isArray(item?.glossary) ? item.glossary : [];
  const opinionQuestions = Array.isArray(item?.opinion_questions)
    ? item.opinion_questions.map((q) => {
        if (q && typeof q === 'object') {
          return { question: q.question || '', model_answers: q.model_answers || {} };
        }
        return { question: String(q || ''), model_answers: {} };
      })
    : [];

  // Normalize productive prompts to objects: { prompt, model_answer? }
  const prompts = Array.isArray(item?.productive_prompts) ? item.productive_prompts.map((p) => {
    if (p && typeof p === 'object') {
      return { prompt: p.prompt || p.question || '', model_answer: p.model_answer || '' };
    }
    return { prompt: String(p || ''), model_answer: '' };
  }) : [];

  const setTF = (i, val) => onChange(`tf:${i}`, val);
  const setQA = (i, val) => onChange(`qa:${i}`, val);
  const setPP = (i, val) => onChange(`pp:${i}`, val);

  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium text-gray-900 mb-2">{item.title}</p>}

      {/* Reading passage */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Passage */}
        <div className="flex-1">
          {item?.passage && (
            <div className="text-gray-800 leading-relaxed whitespace-pre-wrap">{item.passage}</div>
          )}
        </div>

      </div>

      {/* Glossary */}
      {glossary.length > 0 && (
        <div className="mt-4">
          <div className="font-medium text-gray-800 mb-2">Glossary</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-200">
              <thead>
                <tr className="bg-gray-50 text-gray-700">
                  <th className="text-left p-2 border-b border-gray-200">Term</th>
                  <th className="text-left p-2 border-b border-gray-200">POS</th>
                  <th className="text-left p-2 border-b border-gray-200">Definition / Translation</th>
                  <th className="text-left p-2 border-b border-gray-200">Example</th>
                </tr>
              </thead>
              <tbody>
                {glossary.map((g, gi) => (
                  <tr key={gi} className="odd:bg-white even:bg-gray-50">
                    <td className="p-2 border-b border-gray-100 font-semibold text-gray-900">{g.term}</td>
                    <td className="p-2 border-b border-gray-100 text-gray-700 uppercase">{g.pos}</td>
                    <td className="p-2 border-b border-gray-100 text-gray-700">
                      {g.definition}
                      {g.translation ? ` — ${g.translation}` : ''}
                    </td>
                    <td className="p-2 border-b border-gray-100 text-gray-700">{g.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* True / False */}
      {tfItems.length > 0 && (
        <div className="mt-4">
          <div className="font-medium text-gray-800 mb-2">True / False</div>
          <ul className="space-y-1">
            {tfItems.map((t, ti) => {
              const chosen = value?.[`tf:${ti}`];
              const isCorrect = checked && typeof t.answer === 'boolean' && chosen === t.answer;
              const isWrong = checked && chosen !== undefined && chosen !== t.answer;
              return (
                <li key={ti} className="text-sm text-gray-800 flex items-center gap-2">
                  <span className="text-gray-500">{String.fromCharCode(97 + ti)}.</span>
                  <span className={`${isCorrect ? 'text-green-700' : isWrong ? 'text-red-700' : ''}`}>{t.statement}</span>
                  <div className="ml-auto flex items-center gap-3">
                    <label className="inline-flex items-center gap-1 text-xs">
                      <input type="radio" name={`${idPrefix}-tf-${ti}`} checked={chosen === true} onChange={() => setTF(ti, true)} disabled={!!checked} /> True
                    </label>
                    <label className="inline-flex items-center gap-1 text-xs">
                      <input type="radio" name={`${idPrefix}-tf-${ti}`} checked={chosen === false} onChange={() => setTF(ti, false)} disabled={!!checked} /> False
                    </label>
                  </div>
                  {checked && (
                    <span className={`ml-2 text-xs ${isCorrect ? 'text-green-700' : 'text-red-700'}`}>{t.answer ? 'True' : 'False'}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Comprehension Questions */}
      {qaItems.length > 0 && (
        <div className="mt-4">
          <div className="font-medium text-gray-800 mb-2">Comprehension Questions</div>
          <div className="space-y-3">
            {qaItems.map((q, qi) => (
              <div key={qi}>
                <div className="text-sm text-gray-900 mb-1">{qi + 1}. {q.question}</div>
                <textarea
                  data-key={`${idPrefix}:qa:${qi}`}
                  className="w-full min-h-[70px] px-2 py-1 border rounded"
                  placeholder="Write your answer..."
                  value={String(value?.[`qa:${qi}`] || '')}
                  onChange={(e) => setQA(qi, e.target.value)}
                  onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:qa:${qi}`)}
                  disabled={!!checked}
                />
                {checked && q.model_answer && (
                  <div className="text-xs text-green-700 mt-1">Model answer: {q.model_answer}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Productive Prompts */}
      {prompts.length > 0 && (
        <div className="mt-4">
          <div className="font-medium text-gray-800 mb-2">Productive Prompts</div>
          <div className="space-y-3">
            {prompts.map((p, pi) => (
              <div key={pi}>
                <div className="text-sm text-gray-900 mb-1">{pi + 1}. {p.prompt}</div>
                <textarea
                  data-key={`${idPrefix}:pp:${pi}`}
                  className="w-full min-h-[90px] px-2 py-1 border rounded"
                  placeholder="Write your response..."
                  value={String(value?.[`pp:${pi}`] || '')}
                  onChange={(e) => setPP(pi, e.target.value)}
                  onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:pp:${pi}`)}
                  disabled={!!checked}
                />
                {checked && p.model_answer && (
                  <div className="text-xs text-green-700 mt-1">Model answer: {p.model_answer}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Opinion Questions */}
      {opinionQuestions.length > 0 && (
        <div className="mt-4">
          <div className="font-medium text-gray-800 mb-2">Opinion Questions</div>
          <div className="space-y-3">
            {opinionQuestions.map((q, qi) => (
              <div key={qi}>
                <div className="text-sm text-gray-900 mb-1">{qi + 1}. {q.question}</div>
                <textarea
                  data-key={`${idPrefix}:op:${qi}`}
                  className="w-full min-h-[70px] px-2 py-1 border rounded"
                  placeholder="Write a short, personal answer..."
                  value={String(value?.[`op:${qi}`] || '')}
                  onChange={(e) => onChange(`op:${qi}`, e.target.value)}
                  onFocus={() => onFocusKey && onFocusKey(`${idPrefix}:op:${qi}`)}
                  disabled={!!checked}
                />
                {checked && q.model_answers && (q.model_answers.agree || q.model_answers.disagree || q.model_answers.neutral) && (
                  <div className="text-xs text-green-700 mt-1 space-y-0.5">
                    {q.model_answers.agree && (<div><span className="font-semibold">Agree:</span> {q.model_answers.agree}</div>)}
                    {q.model_answers.disagree && (<div><span className="font-semibold">Disagree:</span> {q.model_answers.disagree}</div>)}
                    {q.model_answers.neutral && (<div><span className="font-semibold">Neutral:</span> {q.model_answers.neutral}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Score only the True/False items
export function scoreReading(item, value) {
  const tfItems = Array.isArray(item?.true_false) ? item.true_false : [];
  let correct = 0;
  for (let i = 0; i < tfItems.length; i++) {
    const chosen = value?.[`tf:${i}`];
    if (typeof chosen === 'boolean' && chosen === tfItems[i].answer) correct++;
  }
  return { correct, total: tfItems.length };
}

/**
 * Generate Reading Comprehension exercises - base text aware version
 */
export async function generateReading(topic, count = 1, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const requestedCount = Number(count);
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 10) {
    throw new Error('Choose between 1 and 10 reading sets.');
  }
  const result = languageContext.chapter
    ? await generateReadingFromBaseText(topic, requestedCount, languageContext)
    : await generateStandaloneReading(topic, requestedCount, languageContext);
  if (!Array.isArray(result?.items) || result.items.length !== requestedCount || result.items.some(item => !item || typeof item.passage !== 'string' || !item.passage.trim())) {
    throw new Error(`ChatGPT did not return ${requestedCount} complete reading ${requestedCount === 1 ? 'set' : 'sets'}. Please generate them again.`);
  }
  return result;
}

async function generateStandaloneReading(topic, count, languageContext) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;

  // Derive length ranges by level (A1–C2 supported)
  const levelToLength = (lvl) => {
    switch (String(lvl).toUpperCase()) {
      case 'A1': return challengeMode ? '80-120 words' : '60-100 words';
      case 'A2': return challengeMode ? '120-180 words' : '100-150 words';
      case 'B1': return challengeMode ? '200-260 words' : '150-250 words';
      case 'B2': return challengeMode ? '300-360 words' : '250-350 words';
      case 'C1': return challengeMode ? '400-480 words' : '350-450 words';
      case 'C2': return challengeMode ? '500-580 words' : '450-550 words';
      default: return challengeMode ? '180-260 words' : '140-220 words';
    }
  };

  const lengthTarget = levelToLength(level);
  const maxNewWords = challengeMode ? 8 : 5;
  const system = `Create reading comprehension sets in the target language, matching the JSON schema and CEFR level.
Use distinct, natural passages relevant to the topic. Ground factual questions and answers in each passage.
Include the glossary and question types specified by the schema, with concise model answers and agree/disagree/neutral answers for opinion questions.
Keep image prompts descriptive, without text overlays.`;

  const suggestion = pickRandomTopicSuggestion({ ensureNotEqualTo: topic });
  const topicLine = formatTopicSuggestionForPrompt(suggestion, { prefix: 'Unless the topic relates to specific vocabulary, you may use the following topic suggestion for variety' });

  const user = `Task: Create exactly ${count} reading comprehension sets.
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging; allow more complex syntax and subordinate clauses)' : ''}
Topic: ${topic}
Passage length target: ${lengthTarget}
Max new vocabulary terms: ${maxNewWords}

${topicLine}`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', minItems: count, maxItems: count, items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: 60 },
            passage: { type: 'string' },
            image_prompt: { type: 'string' },
            glossary: {
              type: 'array', minItems: 3, maxItems: 8, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  term: { type: 'string' },
                  pos: { type: 'string', enum: ['noun','verb','adj','adv','expr'] },
                  definition: { type: 'string' },
                  translation: { type: ['string','null'] },
                  example: { type: 'string' }
                },
                required: ['term','pos','definition','translation','example']
              }
            },
            true_false: {
              type: 'array', minItems: 3, maxItems: 5, items: {
                type: 'object', additionalProperties: false,
                properties: { statement: { type: 'string' }, answer: { type: 'boolean' } },
                required: ['statement','answer']
              }
            },
            comprehension_questions: {
              type: 'array', minItems: 2, maxItems: 4, items: {
                type: 'object', additionalProperties: false,
                properties: { question: { type: 'string' }, model_answer: { type: 'string' } },
                required: ['question','model_answer']
              }
            },
            productive_prompts: { 
              type: 'array', minItems: 1, maxItems: 2, items: { 
                type: 'object', additionalProperties: false,
                properties: { prompt: { type: 'string' }, model_answer: { type: 'string' } },
                required: ['prompt','model_answer']
              }
            },
            opinion_questions: { 
              type: 'array', minItems: 3, maxItems: 3, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  question: { type: 'string' },
                  model_answers: { 
                    type: 'object', additionalProperties: false,
                    properties: {
                      agree: { type: 'string' },
                      disagree: { type: 'string' },
                      neutral: { type: 'string' }
                    }
                  }
                },
                required: ['question']
              }
            },
            difficulty: { type: 'string' }
          },
          required: ['title','passage','image_prompt','glossary','true_false','comprehension_questions','productive_prompts','opinion_questions']
        }
      }
    },
    required: ['items']
  };

  const response = await apiFetch('/api/generate', {
    method: 'POST',
    signal: languageContext.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: schema,
      schemaName: 'reading_list',
      metadata: { language: languageName, level, challengeMode, topic, count }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate reading comprehension: ${response.status}`);
  }

  return response.json();
}

/**
 * Generate Reading Comprehension exercises from base text chapters
 */
async function generateReadingFromBaseText(topic, count = 1, languageContext) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  const chapter = languageContext.chapter;
  const baseText = languageContext.baseText;

  if (!chapter || !chapter.passage) {
    throw new Error('No base text chapter provided for reading comprehension');
  }

  const system = `Create reading comprehension sets in the target language, matching the JSON schema and CEFR level.
Use the supplied passage unchanged. Ground factual questions and answers in it, without invented facts.
Include passage vocabulary and the question types specified by the schema, with concise model answers and agree/disagree/neutral answers for opinion questions.
When several sets are requested, vary the questions. Keep image prompts descriptive, without text overlays.`;

  const user = `Task: Create exactly ${count} reading comprehension sets based on the provided passage.
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging analysis)' : ''}
Topic: ${topic}

Source: ${baseText?.title || 'Unknown'}

**Chapter: ${chapter.title}**
**Passage:**
${chapter.passage}`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', minItems: count, maxItems: count, items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: 60 },
            passage: { type: 'string' },
            image_prompt: { type: 'string' },
            glossary: {
              type: 'array', minItems: 4, maxItems: 6, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  term: { type: 'string' },
                  pos: { type: 'string', enum: ['noun','verb','adj','adv','expr'] },
                  definition: { type: 'string' },
                  translation: { type: ['string','null'] },
                  example: { type: 'string' }
                },
                required: ['term','pos','definition','translation','example']
              }
            },
            true_false: {
              type: 'array', minItems: 4, maxItems: 5, items: {
                type: 'object', additionalProperties: false,
                properties: { statement: { type: 'string' }, answer: { type: 'boolean' } },
                required: ['statement','answer']
              }
            },
            comprehension_questions: {
              type: 'array', minItems: 3, maxItems: 4, items: {
                type: 'object', additionalProperties: false,
                properties: { question: { type: 'string' }, model_answer: { type: 'string' } },
                required: ['question','model_answer']
              }
            },
            productive_prompts: { 
              type: 'array', minItems: 1, maxItems: 2, items: { 
                type: 'object', additionalProperties: false,
                properties: { prompt: { type: 'string' }, model_answer: { type: 'string' } },
                required: ['prompt','model_answer']
              }
            },
            opinion_questions: { 
              type: 'array', minItems: 3, maxItems: 3, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  question: { type: 'string' },
                  model_answers: { 
                    type: 'object', additionalProperties: false,
                    properties: {
                      agree: { type: 'string' },
                      disagree: { type: 'string' },
                      neutral: { type: 'string' }
                    },
                    required: ['agree', 'disagree', 'neutral']
                  }
                },
                required: ['question', 'model_answers']
              }
            },
            difficulty: { type: 'string' },
            base_text_info: {
              type: 'object',
              additionalProperties: false,
              properties: {
                base_text_id: { type: 'string' },
                chapter_number: { type: 'number' },
                chapter_title: { type: 'string' }
              }
            }
          },
          required: ['title','passage','image_prompt','glossary','true_false','comprehension_questions','productive_prompts','opinion_questions']
        }
      }
    },
    required: ['items']
  };

  const response = await apiFetch('/api/generate', {
    method: 'POST',
    signal: languageContext.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: schema,
      schemaName: 'reading_from_base_text',
      metadata: { 
        language: languageName, 
        level, 
        challengeMode, 
        topic,
        count,
        baseTextId: baseText?.id,
        chapterNumber: chapter?.number,
        chapterTitle: chapter?.title
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate reading comprehension from base text: ${response.status}`);
  }

  const result = await response.json();
  
  // Add base text metadata to the result
  for (const item of result?.items || []) {
    if (!item || typeof item !== 'object') continue;
    item.base_text_info = {
      base_text_id: baseText?.id,
      chapter_number: chapter?.number, 
      chapter_title: chapter?.title
    };
    // Ensure we use the original passage
    item.passage = chapter.passage;
  }

  return result;
}
