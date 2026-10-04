import { apiFetch } from '../utils/api.js';
/**
 * Unified Cloze Exercise Generation
 * 
 * This module provides a unified approach to generating both regular Cloze and Cloze-Mixed exercises.
 * The core idea is to generate a comprehensive cloze analysis with all possible blanks, distractors,
 * and explanations, then let the UI components decide how to present them (text input vs dropdowns).
 */

// Stepwise generation schemas (lightweight; do NOT persist steps to disk)
const STEP1_REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rewritten_passage: { type: 'string' }
  },
  required: ['rewritten_passage']
};

const STEP2_PRESENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    present: { type: 'boolean' }
  },
  required: ['present']
};

const STEP3_SEGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    full_sentence: { type: 'string' },
    preceding_text: { type: 'string' },
    succeeding_text: { type: 'string' },
    hint: { type: 'string' },
    options: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          correct: { type: 'boolean' },
          explanation: { type: 'string' }
        },
        required: ['text', 'correct']
      }
    },
    difficulty_level: { type: 'string', enum: ['easy', 'medium', 'hard'] },
    grammar_focus: { type: 'string' }
  },
  required: ['full_sentence', 'preceding_text', 'succeeding_text', 'options']
};

async function llmGenerate({ system, user, jsonSchema, metadata, signal }) {
  const resp = await apiFetch('/api/generate', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    // Use a non-persistent schemaName so steps stay in-memory only on the server
    body: JSON.stringify({ system, user, jsonSchema, schemaName: 'cloze_step', metadata })
  });
  if (!resp.ok) throw new Error(`LLM call failed: ${resp.status}`);
  return await resp.json();
}

export function splitIntoSentences(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  const re = /[^.!?。！？]+[.!?。！？]+(?:["'”’)\]]+)?/g;
  let m;
  let end = 0;
  while ((m = re.exec(s)) !== null) {
    out.push(m[0].trim());
    end = re.lastIndex;
  }
  const rest = s.slice(end).trim();
  if (rest) out.push(rest);
  return out;
}

// Merge very short sentences/fragments into their predecessor to reduce noise
function compactSentences(sentences) {
  const arr = (sentences || []).map(s => String(s || '').trim()).filter(Boolean);
  if (arr.length <= 1) return arr;
  const lengths = arr.map(s => s.length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length || 0;
  // Consider "significantly shorter" as < 45% of average, but at least below 25 chars
  const threshold = Math.max(25, Math.round(avg * 0.45));
  const out = [];
  for (const s of arr) {
    if (out.length === 0) {
      out.push(s);
      continue;
    }
    if (s.length < threshold) {
      // Append to previous sentence with space, avoid double spaces before punctuation
      let merged = `${out[out.length - 1]} ${s}`;
      merged = merged.replace(/\s+([,.;:!?])/g, '$1');
      out[out.length - 1] = merged;
    } else {
      out.push(s);
    }
  }
  return out;
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function reconcileSegmentFromSentence(sentence, seg) {
  // Ensure full_sentence matches concatenation; if not, attempt to derive from original sentence
  const full = seg.full_sentence || sentence;
  let { preceding_text = '', solution = '', succeeding_text = '' } = seg;
  const expected = preceding_text + solution + succeeding_text;
  if (normalizeWhitespace(full) !== normalizeWhitespace(expected)) {
    // Try to locate solution within the sentence and rebuild parts
    const idx = sentence.indexOf(solution);
    if (idx >= 0) {
      preceding_text = sentence.slice(0, idx);
      succeeding_text = sentence.slice(idx + solution.length);
    }
  }
  return {
    ...seg,
    full_sentence: full,
    preceding_text,
    solution,
    succeeding_text
  };
}

function reconcileFlatSegmentFromSentence(sentence, seg) {
  const full = seg.full_sentence || sentence;
  let { preceding_text = '', succeeding_text = '' } = seg;
  const options = Array.isArray(seg.options) ? seg.options : [];
  const correct = options.find(o => o && o.correct) || options[0] || { text: '' };
  const expected = preceding_text + String(correct.text || '') + succeeding_text;
  if (normalizeWhitespace(full) !== normalizeWhitespace(expected)) {
    const sol = String(correct.text || '');
    const idx = sentence.indexOf(sol);
    if (idx >= 0) {
      preceding_text = sentence.slice(0, idx);
      succeeding_text = sentence.slice(idx + sol.length);
    }
  }
  return {
    ...seg,
    full_sentence: full,
    preceding_text,
    succeeding_text,
    options
  };
}

export async function generateUnifiedClozeStepwise(topic, languageContext) {
  const { language: languageName, level, challengeMode, chapter, baseText, signal } = languageContext || {};
  if (!chapter || !chapter.passage) throw new Error('No base text chapter provided for stepwise cloze generation');

  // Step 1: Rewrite full passage (cached) — sentence splitting handled locally
  const step1System = 'You are a language teaching expert. You rewrite passages to include a target grammar structure while preserving coherence. Return strict JSON.';
  const step1User = [
    `Task: Rewrite the passage to include the target grammar.`,
    `Target Language: ${languageName}`,
    `Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}`,
    `Target Grammar: ${topic}`,
    `Original Passage:`,
    chapter.passage,
    '',
    'Requirements:',
    '- Keep the same language as the original.',
    '- Maintain narrative coherence; adapt content to include multiple instances of the target grammar.',
    '- Return JSON with a single field: rewritten_passage (string).',
  ].join('\n');
  const step1 = await llmGenerate({ system: step1System, user: step1User, jsonSchema: STEP1_REWRITE_SCHEMA, metadata: { language: languageName, level, challengeMode, topic }, signal });
  const rewritten = String(step1.rewritten_passage || chapter.passage || '');
  const sentences = compactSentences(splitIntoSentences(rewritten));

  // Step 2: Presence check per sentence (cached), sequential to respect RPM limits
  const presenceSystem = 'You are a strict boolean classifier and language expert. Return JSON { "present": true|false } only.';
  const presenceResults = [];
  for (let idx = 0; idx < sentences.length; idx++) {
    const s = sentences[idx];
    const user = [
      `Target Grammar: ${topic}`,
      `Sentence Index: ${idx}`,
      `Sentence:`,
      s,
      '',
      'Question: Does this sentence contain at least one clear instance of the target grammar (a single contiguous span you could choose)? Respond strictly with {"present": true} or {"present": false}.',
    ].join('\n');
    const pr = await llmGenerate({ system: presenceSystem, user, jsonSchema: STEP2_PRESENCE_SCHEMA, metadata: { language: languageName, level, challengeMode, topic }, signal });
    presenceResults.push(pr);
  }

  // Decide target blanks dynamically: aim for max(8, ceil(0.75 * candidates)), capped at 12
  const candidateIdx = presenceResults.map((r, i) => (r?.present ? i : -1)).filter(i => i >= 0);
  const baseAim = 8;
  const coverageAim = Math.ceil(candidateIdx.length * 0.75);
  const hardCap = 12;
  const targetBlanks = Math.max(1, Math.min(hardCap, Math.max(baseAim, coverageAim)));

  // Select indices evenly across the candidate list to avoid clustering
  function pickEvenlySpaced(indices, k) {
    if (k >= indices.length) return new Set(indices);
    if (k <= 0) return new Set();
    const chosen = new Set();
    const n = indices.length;
    const step = (n - 1) / (k - 1);
    for (let j = 0; j < k; j++) {
      const pos = Math.round(j * step);
      chosen.add(indices[pos]);
    }
    return chosen;
  }
  const selectedForBlank = pickEvenlySpaced(candidateIdx, targetBlanks);
  // Step 3: Segment sentences with target grammar into prefix/blank/suffix (cached per sentence)
const segmentSystem = 'You are a language pedagogy expert. You segment a single sentence for a cloze blank. Return strict JSON matching the schema. Ensure full_sentence = preceding_text + (one correct option text) + succeeding_text. Provide options with exactly one correct=true; include short explanations.';
  const segmented = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const p = selectedForBlank.has(i);
    if (!p) {
      segmented.push({ preceding_text: s, succeeding_text: '', full_sentence: s, hint: '', options: [], difficulty_level: null, grammar_focus: null });
      continue;
    }
    const user = [
      `Target Grammar: ${topic}`,
      `Sentence:`,
      s,
      '',
      'Instructions:',
      '- Choose a single contiguous span within the sentence as the correct option that best captures the target grammar instance.',
      '- Return preceding_text and succeeding_text so that full_sentence = preceding_text + correct_option.text + succeeding_text.',
      '- Provide 3-4 total options with exactly one marked correct=true; give a short explanation for each option.',
      '- Include a helpful hint, difficulty_level (easy|medium|hard), and grammar_focus.',
    ].join('\n');
    const seg = await llmGenerate({ system: segmentSystem, user, jsonSchema: STEP3_SEGMENT_SCHEMA, metadata: { language: languageName, level, challengeMode, topic }, signal });
    const fixed = reconcileFlatSegmentFromSentence(s, seg);
    segmented.push(fixed);
  }

  // Minimal structural repair and warnings (flat)
  const { segments, warnings } = validateAndRepairFlatSegments(segmented);
  // Compute metadata
  const totalBlanks = segments.filter(s => Array.isArray(s.options) && s.options.some(o => o.correct)).length;
  const difficultyCounts = segments.reduce((acc, s) => {
    if (Array.isArray(s.options) && s.options.some(o => o.correct)) {
      const key = s.difficulty_level || 'medium';
      acc[key] = (acc[key] || 0) + 1;
    }
    return acc;
  }, {});
  const item = {
    title: `${baseText?.title || 'Cloze'} — ${topic}`,
    student_instructions: `Reconstruye el texto y completa los huecos con la forma correcta. Tema: ${topic}.`,
    base_text_id: baseText?.id || null,
    chapter_number: chapter?.number || null,
    segments,
    difficulty: 'medium',
    total_blanks: totalBlanks,
    suggested_blanks_easy: Number(difficultyCounts.easy || 0),
    suggested_blanks_medium: Number(difficultyCounts.medium || 0),
    suggested_blanks_hard: Number(difficultyCounts.hard || 0),
    validation_warnings: warnings
  };
  validateUnifiedClozeItem(item);
  // Persist the assembled exercise so downstream features (images, reuse) have a stable exerciseSha
  try {
    const persistResp = await apiFetch('/api/persist-exercise', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'unified_cloze', items: [item], metadata: { language: languageName, level, challengeMode, topic } })
    });
    if (persistResp.ok) {
      const persisted = await persistResp.json();
      if (persisted?.items?.[0]) return { items: [persisted.items[0]] };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return { items: [item] };
}

/**
 * Schema for unified cloze generation using segments approach
 */
export const UNIFIED_CLOZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 80 },
          student_instructions: { type: 'string' },
          base_text_id: { type: ['string', 'null'] },
          chapter_number: { type: ['number', 'null'] },
          segments: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['text', 'blank'] },
                // Text segment properties
                content: { type: ['string', 'null'] },
                // Blank segment properties
                solution: { type: ['string', 'null'] },
                hint: { type: ['string', 'null'] },
                distractors: {
                  type: ['array', 'null'],
                  minItems: 3,
                  maxItems: 4,
                  items: { type: 'string' }
                },
                explanation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    solution: { type: 'string' },
                    distractor_explanations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          distractor: { type: 'string' },
                          explanation: { type: 'string' }
                        },
                        required: ['distractor', 'explanation']
                      }
                    }
                  }
                },
                difficulty_level: {
                  type: ['string', 'null'],
                  enum: ['easy', 'medium', 'hard', null],
                  description: 'Relative difficulty of this blank within the exercise'
                },
                grammar_focus: {
                  type: ['string', 'null'],
                  description: 'The specific grammar point this blank tests (e.g., ser vs estar, preterite vs imperfect)'
                }
              },
              required: ['type']
            }
          },
          difficulty: { type: 'string' },
          total_blanks: { type: 'number' },
          suggested_blanks_easy: { type: 'number' },
          suggested_blanks_medium: { type: 'number' },
          suggested_blanks_hard: { type: 'number' }
        },
        required: ['title', 'student_instructions', 'segments', 'total_blanks', 'suggested_blanks_easy', 'suggested_blanks_medium', 'suggested_blanks_hard']
      }
    }
  },
  required: ['items']
};

/**
 * Check answer structure before an exercise can be presented or scored.
 */
export function validateUnifiedClozeItem(item) {
  if (!Array.isArray(item?.segments) || !item.segments.length) {
    throw new Error('ChatGPT returned a cloze passage without answerable blanks. Please generate it again.');
  }
  const invalid = () => { throw new Error('ChatGPT returned a cloze blank with missing or ambiguous answers. Please generate it again.'); };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const isFlat = item.segments.every(segment => segment && typeof segment === 'object' && !('type' in segment));
  let blankCount = 0;
  for (const segment of item.segments) {
    if (!segment || typeof segment !== 'object') invalid();
    if (segment.type === 'text') {
      if (typeof segment.content !== 'string' || /_{3,}/.test(segment.content)) invalid();
    } else if (segment.type === 'blank') {
      const options = [segment.solution, ...(Array.isArray(segment.distractors) ? segment.distractors : [])];
      if (options.length < 4 || options.some(value => !text(value)) || new Set(options.map(value => value.trim())).size !== options.length) invalid();
      blankCount += 1;
    } else if (isFlat && Array.isArray(segment.options)) {
      // Previously saved stepwise exercises use one flat segment per sentence.
      if (typeof segment.preceding_text !== 'string' || typeof segment.succeeding_text !== 'string' || /_{3,}/.test(segment.preceding_text + segment.succeeding_text)) invalid();
      if (segment.options.length) {
        const options = segment.options;
        if (options.length < 3 || options.some(option => !text(option?.text)) || options.filter(option => option.correct === true).length !== 1 || new Set(options.map(option => option.text.trim())).size !== options.length) invalid();
        blankCount += 1;
      }
    } else invalid();
  }
  if (blankCount < 6) {
    throw new Error(`ChatGPT returned only ${blankCount} cloze blanks; at least 6 are needed. Please generate it again.`);
  }
  item.total_blanks = blankCount;
  return item;
}

/** Generate one passage, shared by text-input and multiple-choice cloze. */
export async function generateUnifiedCloze(topic, count = 1, languageContext) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  const chapter = languageContext.chapter;
  const baseText = languageContext.baseText;

  if (!chapter || !chapter.passage) {
    throw new Error('No base text chapter provided for unified cloze generation');
  }

  const system = `Create one coherent language-learning cloze passage matching the supplied JSON schema.
Adapt the source story to practise the target grammar at the requested CEFR level.
Use 6–8 blank segments, each with one nonempty solution, a helpful hint, 3–4 distinct incorrect distractors, and concise explanations. Keep all options distinct.
Text segments contain only surrounding text, never underscores. Preserve spaces and punctuation so text segments plus solutions reconstruct the complete passage.
Write the passage and learner instructions in the target language.`;

  const user = `Task: Create exactly 1 cloze exercise.
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}
Target Grammar: ${topic}
Source: ${baseText?.title || 'Unknown'}
Chapter: ${chapter.title}
Passage:
${chapter.passage}`;

  const response = await apiFetch('/api/generate', {
    method: 'POST',
    signal: languageContext.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: UNIFIED_CLOZE_SCHEMA,
      schemaName: 'unified_cloze',
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
    throw new Error(`Failed to generate unified cloze: ${response.status}`);
  }

  const result = await response.json();
  if (!Array.isArray(result?.items) || result.items.length !== 1) {
    throw new Error('ChatGPT did not return one complete cloze exercise. Please generate it again.');
  }
  const item = validateUnifiedClozeItem(result.items[0]);
  item.base_text_id = baseText?.id;
  item.chapter_number = chapter?.number;

  return result;
}

/**
 * Convert unified cloze format to traditional Cloze format (text input)
 */
export function convertToTraditionalCloze(unifiedItem) {
  const segments = unifiedItem.segments || [];
  let passage = '';
  const blanks = [];
  let blankIndex = 0;

  const isFlat = segments.length > 0 && !('type' in (segments[0] || {}));

  if (!isFlat) {
    segments.forEach(segment => {
      if (segment.type === 'text') {
        passage += segment.content;
      } else if (segment.type === 'blank') {
        passage += '_____';
        const distractorExplanations = {};
        if (segment.explanation?.distractor_explanations) {
          segment.explanation.distractor_explanations.forEach(item => {
            distractorExplanations[item.distractor] = item.explanation;
          });
        }
        blanks.push({
          index: blankIndex,
          answer: segment.solution,
          hint: segment.hint,
          rationale: segment.explanation?.solution || '',
          difficulty_level: segment.difficulty_level,
          grammar_focus: segment.grammar_focus,
          distractor_explanations: distractorExplanations
        });
        blankIndex++;
      }
    });
  } else {
    segments.forEach(seg => {
      const hasOptions = Array.isArray(seg.options) && seg.options.length > 0;
      const correct = hasOptions ? (seg.options.find(o => o.correct) || seg.options[0]) : null;
      passage += String(seg.preceding_text || '');
      if (correct) {
        passage += '_____';
        const distractorExplanations = {};
        for (const opt of seg.options) {
          if (!opt.correct) distractorExplanations[opt.text] = opt.explanation || '';
        }
        blanks.push({
          index: blankIndex,
          answer: String(correct.text || ''),
          hint: seg.hint || '',
          rationale: correct.explanation || '',
          difficulty_level: seg.difficulty_level || 'medium',
          grammar_focus: seg.grammar_focus || null,
          distractor_explanations: distractorExplanations
        });
        blankIndex++;
      }
      passage += String(seg.succeeding_text || '');
      // Ensure a single space after each sentence
      if (!/\s$/.test(passage)) passage += ' ';
    });
  }

  return {
    title: unifiedItem.title,
    studentInstructions: unifiedItem.student_instructions,
    passage: passage.trim(),
    blanks,
    difficulty: unifiedItem.difficulty,
    base_text_id: unifiedItem.base_text_id,
    chapter_number: unifiedItem.chapter_number,
    exerciseSha: unifiedItem.exerciseSha,
    total_blanks_available: unifiedItem.total_blanks,
    metadata: {
      suggested_blanks_easy: unifiedItem.suggested_blanks_easy,
      suggested_blanks_medium: unifiedItem.suggested_blanks_medium,
      suggested_blanks_hard: unifiedItem.suggested_blanks_hard
    }
  };
}

/**
 * Convert unified cloze format to ClozeMixed format (dropdowns)
 */
export function convertToClozeMixed(unifiedItem) {
  const segments = unifiedItem.segments || [];
  let passage = '';
  const blanks = [];
  let blankIndex = 0;

  const isFlat = segments.length > 0 && !('type' in (segments[0] || {}));

  if (!isFlat) {
    segments.forEach(segment => {
      if (segment.type === 'text') {
        passage += segment.content;
      } else if (segment.type === 'blank') {
        passage += '_____';
        const options = [segment.solution, ...(segment.distractors || [])];
        const shuffledOptions = shuffleArray(options);
        const correctIndex = shuffledOptions.indexOf(segment.solution);
        const distractorExplanations = {};
        if (segment.explanation?.distractor_explanations) {
          segment.explanation.distractor_explanations.forEach(item => {
            distractorExplanations[item.distractor] = item.explanation;
          });
        }
        blanks.push({
          index: blankIndex,
          options: shuffledOptions,
          correct_index: correctIndex,
          hint: segment.hint,
          rationale: segment.explanation?.solution || '',
          difficulty_level: segment.difficulty_level,
          grammar_focus: segment.grammar_focus,
          distractor_explanations: distractorExplanations
        });
        blankIndex++;
      }
    });
  } else {
    segments.forEach(seg => {
      const hasOptions = Array.isArray(seg.options) && seg.options.length > 0;
      const texts = hasOptions ? seg.options.map(o => String(o.text || '')) : [];
      const correctIdx = hasOptions ? seg.options.findIndex(o => o.correct) : -1;
      passage += String(seg.preceding_text || '');
      if (hasOptions) {
        passage += '_____';
        const shuffledOptions = shuffleArray(texts);
        const correctText = correctIdx >= 0 ? texts[correctIdx] : texts[0];
        const correctIndex = shuffledOptions.indexOf(correctText);
        const distractorExplanations = {};
        if (hasOptions) {
          for (const opt of seg.options) {
            if (!opt.correct) distractorExplanations[opt.text] = opt.explanation || '';
          }
        }
        const correctOption = seg.options.find(o => o.text === correctText) || seg.options[correctIdx] || seg.options[0];
        blanks.push({
          index: blankIndex,
          options: shuffledOptions,
          correct_index: correctIndex,
          hint: seg.hint || '',
          rationale: (correctOption && correctOption.explanation) || '',
          difficulty_level: seg.difficulty_level || 'medium',
          grammar_focus: seg.grammar_focus || null,
          distractor_explanations: distractorExplanations
        });
        blankIndex++;
      }
      passage += String(seg.succeeding_text || '');
      if (!/\s$/.test(passage)) passage += ' ';
    });
  }

  return {
    title: unifiedItem.title,
    studentInstructions: unifiedItem.student_instructions,
    passage: passage.trim(),
    blanks,
    difficulty: unifiedItem.difficulty,
    base_text_id: unifiedItem.base_text_id,
    chapter_number: unifiedItem.chapter_number,
    exerciseSha: unifiedItem.exerciseSha,
    total_blanks_available: unifiedItem.total_blanks,
    metadata: {
      suggested_blanks_easy: unifiedItem.suggested_blanks_easy,
      suggested_blanks_medium: unifiedItem.suggested_blanks_medium,
      suggested_blanks_hard: unifiedItem.suggested_blanks_hard
    }
  };
}

/**
 * Filter blanks by difficulty level for adaptive exercises
 */
export function filterBlanksByDifficulty(unifiedItem, targetDifficulties = ['easy', 'medium'], maxBlanks = 8) {
  const segments = unifiedItem.segments || [];
  const filteredSegments = [];
  let blankCount = 0;

  const isFlat = segments.length > 0 && !('type' in (segments[0] || {}));

  if (!isFlat) {
    segments.forEach(segment => {
      if (segment.type === 'text') {
        filteredSegments.push(segment);
      } else if (segment.type === 'blank') {
        if (targetDifficulties.includes(segment.difficulty_level) && blankCount < maxBlanks) {
          filteredSegments.push(segment);
          blankCount++;
        } else {
          // Convert blank back to text with the solution
          filteredSegments.push({ type: 'text', content: segment.solution });
        }
      }
    });
  } else {
    for (const seg of segments) {
      const hasOptions = Array.isArray(seg.options) && seg.options.length > 0;
      const difficulty = seg.difficulty_level || 'medium';
      if (hasOptions && targetDifficulties.includes(difficulty) && blankCount < maxBlanks) {
        filteredSegments.push(seg);
        blankCount++;
      } else if (hasOptions) {
        // Merge correct option into text and drop options
        const correct = seg.options.find(o => o.correct) || seg.options[0];
        filteredSegments.push({
          ...seg,
          preceding_text: String(seg.preceding_text || '') + String(correct?.text || ''),
          options: []
        });
      } else {
        filteredSegments.push(seg);
      }
    }
  }

  return {
    ...unifiedItem,
    segments: filteredSegments,
    filtered_blank_count: blankCount,
    original_blank_count: isFlat
      ? (segments.filter(s => Array.isArray(s.options) && s.options.some(o => o.correct)).length)
      : unifiedItem.total_blanks
  };
}

/**
 * Utility function to shuffle array (Fisher-Yates algorithm)
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Validate that unified cloze segments reconstruct the original passage
 */
export function validateSegmentReconstruction(segments, originalPassage) {
  let reconstructed = '';
  
  segments.forEach(segment => {
    if (segment.type === 'text') {
      reconstructed += segment.content;
    } else if (segment.type === 'blank') {
      reconstructed += segment.solution;
    }
  });
  
  return {
    isValid: reconstructed === originalPassage,
    original: originalPassage,
    reconstructed: reconstructed,
    originalLength: originalPassage.length,
    reconstructedLength: reconstructed.length
  };
}

// Validate and repair flat segments (see above)
export function validateAndRepairFlatSegments(segments) {
  const out = [];
  const warnings = [];
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < (segments || []).length; i++) {
    const seg = { ...(segments[i] || {}) };
    const opts = Array.isArray(seg.options) ? seg.options.filter(Boolean) : [];
    if (opts.length > 0) {
      let correctCount = opts.filter(o => o.correct === true).length;
      if (correctCount === 0) {
        opts[0].correct = true;
        correctCount = 1;
        warnings.push(`Flat seg @${i}: no correct option; marked first as correct.`);
      } else if (correctCount > 1) {
        let seen = false;
        for (const o of opts) {
          if (o.correct && !seen) { seen = true; continue; }
          o.correct = false;
        }
        warnings.push(`Flat seg @${i}: multiple correct options; reduced to one.`);
      }
      const correct = opts.find(o => o.correct) || opts[0];
      const full = String(seg.full_sentence || '');
      const expected = String(seg.preceding_text || '') + String(correct.text || '') + String(seg.succeeding_text || '');
      if (full && norm(full) !== norm(expected)) {
        const sol = String(correct.text || '');
        const sentence = full || '';
        const idx = sentence.indexOf(sol);
        if (idx >= 0) {
          seg.preceding_text = sentence.slice(0, idx);
          seg.succeeding_text = sentence.slice(idx + sol.length);
          warnings.push(`Flat seg @${i}: rebuilt preceding/succeeding from full_sentence.`);
        } else {
          seg.full_sentence = expected;
          warnings.push(`Flat seg @${i}: rewrote full_sentence from parts.`);
        }
      }
    }
    seg.options = opts;
    out.push(seg);
  }
  return { segments: out, warnings };
}
