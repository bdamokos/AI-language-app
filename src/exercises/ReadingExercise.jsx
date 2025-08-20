import React, { useEffect, useRef, useState } from 'react';
import useImageGeneration from '../hooks/useImageGeneration.js';
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
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
  const [generatedImage, setGeneratedImage] = useState(null);
  const { generateImage, loading: imageLoading, error: imageError } = useImageGeneration();
  const lastKeyRef = useRef('');
  const isGeneratingRef = useRef(false);

  // Check settings once
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/settings');
        const settings = await res.json();
        const providerKey = settings.imageProvider || 'runware';
        setImageGenerationEnabled(!!settings[providerKey]?.enabled);
      } catch {
        setImageGenerationEnabled(false);
      }
    };
    check();
  }, []);

  // Generate image based on image_prompt when present
  useEffect(() => {
    const doGen = async () => {
      if (!imageGenerationEnabled) return;
      if (!item?.image_prompt) return;
      const sig = `${item.image_prompt}`;
      if (lastKeyRef.current === sig) return;
      if (isGeneratingRef.current) return;
      isGeneratingRef.current = true;
      lastKeyRef.current = sig;
      try {
        const img = await generateImage(item.image_prompt, {
          width: 1024,
          height: 1024,
          steps: 28,
          cfgScale: 3.5,
          persistToCache: !!item?.exerciseSha,
          exerciseSha: item?.exerciseSha
        });
        setGeneratedImage(img);
        if (typeof window !== 'undefined' && window.globalImageStore && idPrefix) {
          const exerciseIndex = idPrefix.split(':').pop();
          window.globalImageStore[`reading:${exerciseIndex}`] = img;
        }
      } catch (e) {
        // optional, ignore
      } finally {
        isGeneratingRef.current = false;
      }
    };
    doGen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageGenerationEnabled, item?.image_prompt, idPrefix, item?.exerciseSha]);

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

  const getImageSource = (imageData) => {
    if (!imageData?.data?.[0]) return null;
    const img = imageData.data[0];
    return img.url || img.imageURL || img.imageDataURI || img.imageBase64Data;
  };

  return (
    <div className="border rounded p-3">
      {item?.title && <p className="font-medium text-gray-900 mb-2">{item.title}</p>}

      {/* Text + optional image side by side on large screens */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Passage */}
        <div className="flex-1">
          {item?.passage && (
            <div className="text-gray-800 leading-relaxed whitespace-pre-wrap">{item.passage}</div>
          )}
        </div>
        {/* Optional generated image */}
        {imageGenerationEnabled && (imageLoading || generatedImage || imageError) && (
          <div className="lg:w-64 xl:w-80 flex-shrink-0">
            {imageLoading && (
              <div className="w-full aspect-square bg-gray-100 border border-gray-200 rounded-lg flex items-center justify-center">
                <div className="text-center">
                  <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2"></div>
                  <p className="text-sm text-gray-600">Generating image...</p>
                </div>
              </div>
            )}
            {generatedImage && getImageSource(generatedImage) && (
              <div className="w-full">
                <img
                  src={getImageSource(generatedImage)}
                  alt={`Illustration for: ${item?.title || 'Reading passage'}`}
                  className="w-full aspect-square object-cover rounded-lg border border-gray-200 shadow-sm"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
                <p className="text-xs text-gray-500 mt-1 text-center">AI-generated illustration</p>
              </div>
            )}
            {imageError && !imageLoading && (
              <div className="w-full aspect-square bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-center">
                <div className="text-center p-4">
                  <p className="text-sm text-gray-500">Image generation failed</p>
                  <p className="text-xs text-gray-400 mt-1">{imageError}</p>
                </div>
              </div>
            )}
          </div>
        )}
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
  // Check if we have a base text chapter context
  if (languageContext.chapter) {
    return generateReadingFromBaseText(topic, count, languageContext);
  }
  // Single-call path
  if (count === 1) {
    return generateSingleReading(topic, null, languageContext);
  }

  // Multi-call path: sequential requests similar to Cloze/ClozeMixed
  const allItems = [];
  const errors = [];
  for (let i = 0; i < count; i++) {
    try {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const result = await generateSingleReading(topic, i + 1, languageContext);
      if (result && Array.isArray(result.items)) {
        allItems.push(...result.items);
      }
    } catch (e) {
      errors.push({ index: i + 1, error: e.message });
    }
  }
  if (allItems.length === 0) {
    throw new Error(`Failed to generate any reading passages. Errors: ${errors.map(e => `#${e.index}: ${e.error}`).join('; ')}`);
  }
  return { items: allItems };
}

async function generateSingleReading(topic, passageNumber = null, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
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
  const passageContext = passageNumber ? ` (Set ${passageNumber})` : '';

  const system = `Generate ${languageName} reading comprehension passages with supporting materials. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging; allow more complex syntax and subordinate clauses)' : ''}.`;

  const suggestion = pickRandomTopicSuggestion({ ensureNotEqualTo: topic });
  const topicLine = formatTopicSuggestionForPrompt(suggestion, { prefix: 'Unless the topic relates to specific vocabulary, you may use the following topic suggestion for variety' });

  const user = `Create exactly 1 reading comprehension set${passageContext} in ${languageName} about: ${topic}.

Requirements:
- Title: \u2264 60 characters.
- Choose real world sentences, not synthetic ones.
${topicLine}
- Passage length: ${lengthTarget}. Ensure it naturally uses the target grammar/topic: ${topic}.
- Include an image_prompt: short, descriptive, no text overlays.
- New vocabulary: up to ${maxNewWords} terms in a glossary with part of speech, definition, optional translation, and an example sentence in ${languageName}.
- True/False: 3–5 statements, each answerable directly from the passage.
- Comprehension questions: 2–4 short-answer questions with concise model answers.
- Productive prompts: 1–2 open-ended prompts to encourage writing/speaking. For each, also provide a short model answer.
- Opinion questions: exactly 3 short personal questions that invite the learner to reflect on the text. For each, also provide up to three model answers, one aagreeing, one disagreeing, and one neutral.

Return STRICT JSON only per schema.`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', minItems: 1, maxItems: 1, items: {
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

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: schema,
      schemaName: 'reading_list',
      metadata: { language: languageName, level, challengeMode, topic }
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

  const system = `You are creating reading comprehension exercises using an existing text passage. Extract meaningful T/F statements, comprehension questions, and supporting materials directly from the given passage. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging analysis)' : ''}.`;

  const user = `Create reading comprehension exercises based on the following passage from "${baseText?.title || 'Unknown'}":

**Chapter: ${chapter.title}**
**Passage:**
${chapter.passage}

**Grammar Focus:** ${topic}

Requirements:
- Use the EXACT passage provided above - do not modify the text
- Create an appropriate title (≤ 60 characters) that reflects the chapter content
- Generate an image_prompt that captures the scene/mood of this specific chapter
- Identify 4-6 key vocabulary terms from the passage for the glossary (with POS, definition, translation, example)
- Extract 4-5 TRUE/FALSE statements that can be verified directly from the passage text
- Create 3-4 comprehension questions about the content, with model answers
- Generate 1-2 productive prompts that connect to the chapter themes, with model answers
- Create exactly 3 opinion questions that invite reflection on the chapter content, with agree/disagree/neutral model answers

**Important:** All questions and vocabulary must be based on what's actually in the passage. Don't invent facts not present in the text.

Return STRICT JSON only per schema.`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      items: {
        type: 'array', minItems: 1, maxItems: 1, items: {
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

  const response = await fetch('/api/generate', {
    method: 'POST',
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
  if (result.items && result.items[0]) {
    result.items[0].base_text_info = {
      base_text_id: baseText?.id,
      chapter_number: chapter?.number, 
      chapter_title: chapter?.title
    };
    // Ensure we use the original passage
    result.items[0].passage = chapter.passage;
  }

  return result;
}


