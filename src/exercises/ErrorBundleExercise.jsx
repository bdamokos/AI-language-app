import { apiFetch } from '../utils/api.js';
import React from 'react';
import { normalizeText } from './utils.js';

/**
 * Error Bundle exercise renderer (Select-or-Fix)
 * Props:
 * - item: { sentences: [{ text, correct, rationale, fix? }], tags?[] }
 * - value: number | string | null (selected option index OR typed correction)
 * - onChange: (value:number|string) => void
 * - checked: boolean
 * - strictAccents: boolean
 * - idPrefix: string
 * - mode: 'select' | 'fix'
 */
export default function ErrorBundleExercise({ item, value, onChange, checked, strictAccents, idPrefix, onFocusKey, mode = 'select' }) {
  const sentences = Array.isArray(item?.sentences) ? item.sentences : [];
  const correctIndex = sentences.findIndex(s => s && s.correct);

  const pickIncorrectIndex = (idxSeed = 0) => {
    const wrongIndices = sentences.map((s, i) => (s && s.correct ? null : i)).filter(i => i !== null);
    if (wrongIndices.length === 0) return 0;
    return wrongIndices[idxSeed % wrongIndices.length];
  };

  // Derive an index seed from idPrefix to keep stable per-item without relying on external state
  const seedMatch = String(idPrefix || '').match(/:(\d+)$/);
  const idxSeed = seedMatch ? Number(seedMatch[1]) : 0;
  const incorrectIndex = pickIncorrectIndex(idxSeed);

  if (mode === 'select') {
    const selectedIndex = typeof value === 'number' ? value : null;
    return (
      <div className="border rounded p-3">
        <p className="font-medium text-gray-800 mb-2">Choose the correct sentence.</p>
        <ul className="space-y-1">
          {sentences.map((s, si) => {
            const chosen = selectedIndex === si;
            const correct = checked && si === correctIndex;
            const wrongChosen = checked && chosen && si !== correctIndex;
            return (
              <li key={si} className="text-sm text-gray-800 flex items-center gap-2">
                <input
                  type="radio"
                  name={`${idPrefix}`}
                  checked={chosen || false}
                  onChange={() => onChange(si)}
                />
                <span className={`${correct ? 'text-green-700' : wrongChosen ? 'text-red-700' : ''}`}>{s?.text}</span>
              </li>
            );
          })}
        </ul>
        {checked && (() => {
          const selected = (typeof selectedIndex === 'number' && selectedIndex >= 0) ? sentences[selectedIndex] : null;
          const correctSentence = correctIndex >= 0 ? sentences[correctIndex] : null;
          if (selected && selectedIndex !== correctIndex) {
            return (
              <div className="mt-2 space-y-1">
                {selected?.rationale && (
                  <p className="text-xs text-red-700">Why your choice is incorrect: {selected.rationale}</p>
                )}
                {correctSentence && (
                  <p className="text-xs text-green-700">Correct: {correctSentence.text}{correctSentence.rationale ? ` — ${correctSentence.rationale}` : ''}</p>
                )}
              </div>
            );
          }
          if (selected && selectedIndex === correctIndex && selected.rationale) {
            return (
              <p className="text-xs text-green-700 mt-2">Why this is correct: {selected.rationale}</p>
            );
          }
          return null;
        })()}
      </div>
    );
  }

  // Correction mode
  const currentValue = typeof value === 'string' ? value : '';
  const target = sentences[incorrectIndex] || {};
  return (
    <div className="border rounded p-3">
      <p className="font-medium text-gray-800 mb-2">Fix the sentence. Provide a minimal correction.</p>
      <p className="text-sm text-gray-800 mb-2">Incorrect: <span className="font-medium">{target.text}</span></p>
      <input
        type="text"
        value={currentValue}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (typeof onFocusKey === 'function') onFocusKey(`${idPrefix}`);
        }}
        data-key={`${idPrefix}`}
        placeholder="Type the minimal fix"
        className="w-full border rounded px-2 py-1 text-sm"
      />
      {checked && (
        <div className="mt-2 space-y-1">
          {target?.fix && (
            <p className="text-xs text-green-700">Expected minimal fix: {target.fix}</p>
          )}
          {target?.rationale && (
            <p className="text-xs text-gray-600">Rationale: {target.rationale}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Score a single Error Bundle item.
 * - If value is a number: selection mode
 * - If value is a string: correction mode
 * Returns { correct: 0|1, total: 1 }
 */
export function scoreErrorBundle(item, value, eq, strictAccents = true, idxSeed = 0) {
  const sentences = Array.isArray(item?.sentences) ? item.sentences : [];
  if (typeof value === 'number') {
    const isCorrect = sentences[value]?.correct === true;
    return { correct: isCorrect ? 1 : 0, total: 1 };
  }

  // Correction mode
  const pickIncorrectIndex = (seed = 0) => {
    const wrongIndices = sentences.map((s, i) => (s && s.correct ? null : i)).filter(i => i !== null);
    if (wrongIndices.length === 0) return 0;
    return wrongIndices[seed % wrongIndices.length];
  };
  const wrongIdx = pickIncorrectIndex(idxSeed);
  const target = sentences[wrongIdx] || {};
  const expected = target?.fix || '';
  const candidate = typeof value === 'string' ? value : '';

  // Quick exact compare (with app-level accent policy)
  if (eq && eq(candidate, expected)) {
    return { correct: 1, total: 1 };
  }

  // Normalize: lowercase, optional diacritics removal, strip punctuation, collapse spaces
  const normalizeForCorrection = (text) => {
    const base = normalizeText(text || '', strictAccents);
    return base
      // remove punctuation and quotes
      .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const a = normalizeForCorrection(candidate);
  const b = normalizeForCorrection(expected);

  // Levenshtein distance with small tolerance
  const levenshtein = (s1, s2) => {
    const n = s1.length, m = s2.length;
    if (n === 0) return m;
    if (m === 0) return n;
    const dp = new Array(m + 1);
    for (let j = 0; j <= m; j++) dp[j] = j;
    for (let i = 1; i <= n; i++) {
      let prev = i - 1; // dp[i-1][j-1]
      dp[0] = i;
      for (let j = 1; j <= m; j++) {
        const temp = dp[j];
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[j] = Math.min(
          dp[j] + 1,      // deletion
          dp[j - 1] + 1,  // insertion
          prev + cost     // substitution
        );
        prev = temp;
      }
    }
    return dp[m];
  };

  const distance = levenshtein(a, b);
  const len = Math.max(a.length, b.length);
  const threshold = len <= 10 ? 1 : 2;
  const isCloseEnough = distance <= threshold;
  return { correct: isCloseEnough ? 1 : 0, total: 1 };
}

/**
 * Generate Error Bundle exercises using the generic LLM endpoint
 * @param {string} topic
 * @param {number} count
 * @param {{ language: string, level: string, challengeMode: boolean, baseText?: object, chapter?: object }} languageContext
 * @returns {Promise<{shared_context?: string, items: Array}>}
 */
export async function generateErrorBundles(topic, count = 5, languageContext = { language: 'Spanish', level: 'B1', challengeMode: false }) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challenge = !!languageContext.challengeMode;
  const safeCount = Number(count);
  if (!Number.isInteger(safeCount) || safeCount < 1 || safeCount > 12) {
    throw new Error('Choose between 1 and 12 error bundles.');
  }
  const baseText = languageContext.baseText;
  const chapter = languageContext.chapter;

  const system = `Create error bundles in the target language at the requested CEFR level, matching the JSON schema.
Each bundle has four distinct sentences: exactly one correct, and three with one clear error practising the requested topic.
Give each incorrect sentence a minimal correction (fix) and a short rationale. Use an empty fix for the correct sentence.
If a source chapter is provided, draw on its passage and setting. Keep shared_context brief and avoid repetitive sentences.`;

  const userPayload = {
    language: String(languageName || ''),
    level: String(level || ''),
    challenge: challenge,
    topic: String(topic || ''),
    count: safeCount
  };

  // Add base text context if available
  if (chapter) {
    userPayload.baseText = {
      title: baseText?.title || '',
      chapter: {
        title: chapter.title || '',
        passage: chapter.passage || chapter.content || '',
        summary: chapter.summary || ''
      }
    };
  }

  const schema = {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      shared_context: { type: 'string' },
      items: {
        type: 'array', minItems: safeCount, maxItems: safeCount,
        items: {
          type: 'object', additionalProperties: false, required: ['sentences'],
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
            sentences: {
              type: 'array', minItems: 4, maxItems: 4,
              items: {
                type: 'object', additionalProperties: false,
                required: ['text', 'correct', 'rationale'],
                properties: {
                  text: { type: 'string' },
                  correct: { type: 'boolean' },
                  rationale: { type: 'string', maxLength: 120 },
                  fix: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  };

  const response = await apiFetch('/api/generate', {
    method: 'POST',
    signal: languageContext.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user: JSON.stringify(userPayload),
      jsonSchema: schema,
      schemaName: 'error_bundle_list',
      metadata: {
        language: languageName,
        level,
        challengeMode: challenge,
        topic,
        count: safeCount,
        exerciseType: 'error_bundle',
        baseTextId: baseText?.id,
        chapterNumber: chapter?.number,
        chapterTitle: chapter?.title
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate Error Bundle exercises: ${response.status}`);
  }

  const result = await response.json();
  if (!Array.isArray(result?.items) || result.items.length !== safeCount || result.items.some(item =>
    !Array.isArray(item?.sentences) || item.sentences.length !== 4 ||
    item.sentences.filter(sentence => sentence?.correct === true).length !== 1 ||
    item.sentences.some(sentence => !sentence || typeof sentence.text !== 'string' || !sentence.text.trim() || typeof sentence.correct !== 'boolean' || (!sentence.correct && (typeof sentence.fix !== 'string' || !sentence.fix.trim()))) ||
    new Set(item.sentences.map(sentence => sentence.text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase())).size !== 4
  )) {
    throw new Error(`ChatGPT did not return ${safeCount} complete error bundles with one correct answer each. Please generate them again.`);
  }

  // Add base text metadata to the result when base text is provided
  if (result.items && result.items.length > 0 && baseText && chapter) {
    // Calculate the chapter number properly since chapter?.number might not exist
    let chapterNumber = chapter?.number;
    if (!chapterNumber && baseText?.chapters) {
      const chapterIndex = baseText.chapters.findIndex(ch => ch.title === chapter.title);
      if (chapterIndex !== -1) {
        chapterNumber = chapterIndex + 1; // 1-based chapter numbering
      }
    }

    result.items.forEach(item => {
      item.base_text_info = {
        base_text_id: baseText.id,
        chapter_number: chapterNumber,
        chapter_title: chapter.title
      };
    });
  }

  return result;
}
