import React, { useMemo, useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import FIBExercise, { scoreFIB, generateFIB } from './FIBExercise.jsx';
import MCQExercise, { scoreMCQ, generateMCQ } from './MCQExercise.jsx';
import ClozeExercise, { scoreCloze, generateCloze } from './ClozeExercise.jsx';
import ClozeMixedExercise, { scoreClozeMixed, generateClozeMixed } from './ClozeMixedExercise.jsx';
import GuidedDialogueExercise, { scoreGuidedDialogue, generateGuidedDialogues } from './GuidedDialogueExercise.jsx';
import WritingPromptExercise, { scoreWritingPrompt, generateWritingPrompts } from './WritingPromptExercise.jsx';
import ReadingExercise, { scoreReading } from './ReadingExercise.jsx';
import ExplanationComponent, { generateExplanation } from './ExplanationComponent.jsx';
import { normalizeText } from './utils.js';
import ErrorBundleExercise, { scoreErrorBundle, generateErrorBundles } from './ErrorBundleExercise.jsx';

/**
 * Lesson Orchestrator: renders a collection of exercise items with standardized API.
 * Props:
 * - lesson: structured lesson bundle (subset OK)
 * - values: Record<string, any> user response map keyed by orchestrator keys
 * - onChange: (key:string, value:any) => void
 * - checked: boolean (global checked state)
 * - strictAccents: boolean
 * - idBase: string (namespace prefix)
 */
export default function Orchestrator({ lesson, values, onChange, checked, strictAccents = true, idBase = 'lesson', onFocusKey }) {
  const [ratedGroups, setRatedGroups] = useState({});
  const sections = useMemo(() => {
    const arr = [];
    if (Array.isArray(lesson?.fill_in_blanks)) arr.push(['fib', lesson.fill_in_blanks]);
    if (Array.isArray(lesson?.multiple_choice)) arr.push(['mcq', lesson.multiple_choice]);
    if (Array.isArray(lesson?.cloze_passages)) arr.push(['cloze', lesson.cloze_passages]);
    if (Array.isArray(lesson?.cloze_with_mixed_options)) arr.push(['clozeMix', lesson.cloze_with_mixed_options]);
    if (Array.isArray(lesson?.guided_dialogues)) arr.push(['dialogue', lesson.guided_dialogues]);
    if (Array.isArray(lesson?.writing_prompts)) arr.push(['writing', lesson.writing_prompts]);
    if (Array.isArray(lesson?.reading_comprehension)) arr.push(['reading', lesson.reading_comprehension]);
    if (Array.isArray(lesson?.error_bundles)) arr.push(['error', lesson.error_bundles]);
    return arr;
  }, [lesson]);

  return (
    <div className="space-y-3">
      {lesson?.explanation && (
        <ExplanationComponent explanation={lesson.explanation} />
      )}
      {sections.map(([type, items]) => (
        <div key={type} className="space-y-3">
          {type === 'fib' && items.length > 0 && <h3 className="font-semibold text-gray-800">Fill in the blanks</h3>}
          {type === 'mcq' && items.length > 0 && <h3 className="font-semibold text-gray-800">Multiple Choice</h3>}
          {type === 'cloze' && items.length > 0 && <h3 className="font-semibold text-gray-800">Cloze Passages</h3>}
          {type === 'clozeMix' && items.length > 0 && <h3 className="font-semibold text-gray-800">Cloze (Mixed Options)</h3>}
          {type === 'dialogue' && items.length > 0 && <h3 className="font-semibold text-gray-800">Guided Dialogues</h3>}
          {type === 'writing' && items.length > 0 && <h3 className="font-semibold text-gray-800">Writing Prompts</h3>}
          {type === 'reading' && items.length > 0 && <h3 className="font-semibold text-gray-800">Reading Comprehension</h3>}
          {type === 'error' && items.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-800">Error Bundles (Select or Fix)</h3>
              {typeof lesson?.error_bundles_shared_context === 'string' && lesson.error_bundles_shared_context && (
                <p className="text-xs text-gray-600 mt-1">Context: {lesson.error_bundles_shared_context}</p>
              )}
            </div>
          )}
          {items.map((item, idx) => {
            const keyPrefix = `${idBase}:${type}:${idx}`;
            const val = values?.[keyPrefix] ?? (type === 'mcq' ? null : {});
            const setVal = (subKey, subVal) => {
              const newValue = type === 'mcq' ? subKey : { ...(val || {}), [String(subKey)]: subVal };
              onChange(keyPrefix, newValue);
            };
            const groupId = item?.exerciseGroupId; // present when pulled from cache or freshly added
            const hasGroup = typeof groupId === 'string' && groupId.length > 0;
            const hasAnyGroupInSection = items.some(it => typeof it?.exerciseGroupId === 'string' && it.exerciseGroupId);
            const alreadyRated = hasGroup && ratedGroups[groupId];
            const sendGroupVote = async (like) => {
              if (!hasGroup || alreadyRated) return;
              setRatedGroups(prev => ({ ...prev, [groupId]: like ? 'up' : 'down' }));
              try {
                await fetch('/api/rate/exercise-group', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ groupId, like })
                });
              } catch {}
            };
            const currentGroup = groupId || null;
            const nextGroup = idx < items.length - 1 ? (items[idx + 1]?.exerciseGroupId || null) : null;
            const isGroupEnd = hasGroup && (idx === items.length - 1 || nextGroup !== currentGroup);
            if (type === 'fib') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <FIBExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button
                        type="button"
                        onClick={() => sendGroupVote(true)}
                        disabled={alreadyRated}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`}
                        aria-label="Thumbs up"
                      >
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button
                        type="button"
                        onClick={() => sendGroupVote(false)}
                        disabled={alreadyRated}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`}
                        aria-label="Thumbs down"
                      >
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'mcq') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <MCQExercise item={item} value={typeof val === 'number' ? val : null} onChange={(i) => onChange(keyPrefix, i)} checked={checked} idPrefix={keyPrefix} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'cloze') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <ClozeExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'clozeMix') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <ClozeMixedExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'dialogue') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <GuidedDialogueExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'writing') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <WritingPromptExercise item={item} value={val || {}} onChange={setVal} checked={checked} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'reading') {
              return (
                <div key={keyPrefix} className="space-y-2">
                  <ReadingExercise item={item} value={val || {}} onChange={setVal} checked={checked} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            if (type === 'error') {
              // Deterministic 60/40 split: last 40% are fix mode
              const total = items.length;
              const fixCount = Math.floor(total * 0.4);
              const isFix = idx >= total - fixCount;
              const currentValue = values?.[keyPrefix];
              return (
                <div key={keyPrefix} className="space-y-2">
                  <ErrorBundleExercise
                    item={item}
                    value={typeof currentValue === 'number' || typeof currentValue === 'string' ? currentValue : (isFix ? '' : null)}
                    onChange={(v) => onChange(keyPrefix, v)}
                    checked={checked}
                    strictAccents={strictAccents}
                    idPrefix={keyPrefix}
                    onFocusKey={onFocusKey}
                    mode={isFix ? 'fix' : 'select'}
                  />
                  {hasAnyGroupInSection && isGroupEnd && (
                    <div className="pt-2 border-t border-gray-200 flex items-center gap-2 text-xs text-gray-600">
                      <span>Rate this set</span>
                      <button type="button" onClick={() => sendGroupVote(true)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs up">
                        <ThumbsUp size={14} /> Like
                      </button>
                      <button type="button" onClick={() => sendGroupVote(false)} disabled={alreadyRated} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${alreadyRated === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-gray-300 hover:bg-gray-100'}`} aria-label="Thumbs down">
                        <ThumbsDown size={14} /> Dislike
                      </button>
                      {alreadyRated && <span className="ml-1">Thanks!</span>}
                    </div>
                  )}
                </div>
              );
            }
            return null;
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Compute aggregated score for all sections in a lesson using orchestrator values.
 * @param {object} lesson
 * @param {Record<string,any>} values
 * @param {boolean} strictAccents
 */
export function scoreLesson(lesson, values, strictAccents = true) {
  const eq = (a, b) => normalizeText(a, strictAccents) === normalizeText(b, strictAccents);
  let correct = 0, total = 0;
  const add = (s) => { correct += s.correct; total += s.total; };
  if (Array.isArray(lesson?.fill_in_blanks)) {
    lesson.fill_in_blanks.forEach((item, idx) => {
      const key = `lesson:fib:${idx}`;
      add(scoreFIB(item, values?.[key] || {}, eq));
    });
  }
  if (Array.isArray(lesson?.multiple_choice)) {
    lesson.multiple_choice.forEach((item, idx) => {
      const key = `lesson:mcq:${idx}`;
      add(scoreMCQ(item, values?.[key]));
    });
  }
  if (Array.isArray(lesson?.cloze_passages)) {
    lesson.cloze_passages.forEach((item, idx) => {
      const key = `lesson:cloze:${idx}`;
      add(scoreCloze(item, values?.[key] || {}, eq));
    });
  }
  if (Array.isArray(lesson?.cloze_with_mixed_options)) {
    lesson.cloze_with_mixed_options.forEach((item, idx) => {
      const key = `lesson:clozeMix:${idx}`;
      add(scoreClozeMixed(item, values?.[key] || {}, eq));
    });
  }
  if (Array.isArray(lesson?.guided_dialogues)) {
    lesson.guided_dialogues.forEach((item, idx) => {
      const key = `lesson:dialogue:${idx}`;
      add(scoreGuidedDialogue(item, values?.[key] || {}, eq));
    });
  }
  if (Array.isArray(lesson?.writing_prompts)) {
    lesson.writing_prompts.forEach((item, idx) => {
      const key = `lesson:writing:${idx}`;
      add(scoreWritingPrompt(item, values?.[key] || {}, eq));
    });
  }
  if (Array.isArray(lesson?.reading_comprehension)) {
    lesson.reading_comprehension.forEach((item, idx) => {
      const key = `lesson:reading:${idx}`;
      add(scoreReading(item, values?.[key] || {}));
    });
  }
  if (Array.isArray(lesson?.error_bundles)) {
    const total = lesson.error_bundles.length;
    const fixCount = Math.floor(total * 0.4);
    lesson.error_bundles.forEach((item, idx) => {
      const key = `lesson:error:${idx}`;
      const val = values?.[key];
      const isFix = idx >= total - fixCount;
      // Use idx as seed for stable incorrect selection
      add(scoreErrorBundle(item, val, eq, strictAccents, idx));
    });
  }
  return { correct, total };
}

/**
 * Generate a complete lesson using component-driven generation
 * @param {string} topic - The topic to generate exercises about
 * @param {Object} counts - Exercise counts: { fill_in_blanks, multiple_choice, cloze_passages, cloze_with_mixed_options }
 * @param {Object} languageContext - Language and level context { language, level, challengeMode }
 * @returns {Promise<Object>} Generated lesson bundle
 */
export async function generateLesson(topic, counts = {}, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const safeCounts = {
    explanation: 1,
    fill_in_blanks: Math.max(0, Math.min(20, Number(counts?.fill_in_blanks ?? 0))),
    multiple_choice: Math.max(0, Math.min(20, Number(counts?.multiple_choice ?? 0))),
    cloze_passages: Math.max(0, Math.min(10, Number(counts?.cloze_passages ?? 0))),
    cloze_with_mixed_options: Math.max(0, Math.min(10, Number(counts?.cloze_with_mixed_options ?? 0))),
    guided_dialogues: Math.max(0, Math.min(10, Number(counts?.guided_dialogues ?? 0))),
    writing_prompts: Math.max(0, Math.min(10, Number(counts?.writing_prompts ?? 0))),
    error_bundles: Math.max(0, Math.min(12, Number(counts?.error_bundles ?? 0)))
  };

  // Generate all exercise types in parallel using component generation functions
  const [explanation, fibData, mcqData, clozeData, clozeMixData, dialogueData, writingData, errorBundleData] = await Promise.all([
    generateExplanation(topic, languageContext),
    safeCounts.fill_in_blanks > 0 ? generateFIB(topic, safeCounts.fill_in_blanks, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.multiple_choice > 0 ? generateMCQ(topic, safeCounts.multiple_choice, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.cloze_passages > 0 ? generateCloze(topic, safeCounts.cloze_passages, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.cloze_with_mixed_options > 0 ? generateClozeMixed(topic, safeCounts.cloze_with_mixed_options, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.guided_dialogues > 0 ? generateGuidedDialogues(topic, safeCounts.guided_dialogues, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.writing_prompts > 0 ? generateWritingPrompts(topic, safeCounts.writing_prompts, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.error_bundles > 0 ? generateErrorBundles(topic, safeCounts.error_bundles, { language: languageContext.language, level: languageContext.level, challengeMode: languageContext.challengeMode }) : Promise.resolve({ items: [] })
  ]);

  // Build lesson bundle
  return {
    version: '1.0',
    language: languageContext.language,
    topic,
    pedagogy: { 
      approach: 'scaffolded+spiral', 
      strategy_notes: 'Component-driven generation with distributed prompts' 
    },
    explanation,
    fill_in_blanks: fibData.items || [],
    multiple_choice: mcqData.items || [],
    cloze_passages: clozeData.items || [],
    cloze_with_mixed_options: clozeMixData.items || [],
    guided_dialogues: dialogueData.items || [],
    writing_prompts: writingData.items || []
    ,
    error_bundles: errorBundleData.items || [],
    error_bundles_shared_context: errorBundleData.shared_context || ''
  };
}


