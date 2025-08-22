import React, { useMemo, useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import FIBExercise, { scoreFIB, generateFIB } from './FIBExercise.jsx';
import MCQExercise, { scoreMCQ, generateMCQ } from './MCQExercise.jsx';
import ClozeExercise, { scoreCloze, generateCloze } from './ClozeExercise.jsx';
import ClozeMixedExercise, { scoreClozeMixed, generateClozeMixed } from './ClozeMixedExercise.jsx';
import GuidedDialogueExercise, { scoreGuidedDialogue, generateGuidedDialogues } from './GuidedDialogueExercise.jsx';
import WritingPromptExercise, { scoreWritingPrompt, generateWritingPrompts } from './WritingPromptExercise.jsx';
import ReadingExercise, { scoreReading, generateReading } from './ReadingExercise.jsx';
import ExplanationComponent, { generateExplanation } from './ExplanationComponent.jsx';
import { normalizeText } from './utils.js';
import ErrorBundleExercise, { scoreErrorBundle, generateErrorBundles } from './ErrorBundleExercise.jsx';
import { BaseTextChapterTracker, EXERCISE_CATEGORIES, createChapterContext } from './baseTextOrchestrator.js';

/**
 * Lesson Orchestrator: renders a collection of exercise items with standardized API.
 * Props:
 * - lesson: structured lesson bundle (subset OK)
 * - values: Record<string, any> user response map keyed by orchestrator keys
 * - onChange: (key:string, value:any) => void
 * - checked: boolean (global checked state)
 * - strictAccents: boolean
 * - idBase: string (namespace prefix)
 * - renderGenerationControls: optional function to render exercise generation controls
 */
export default function Orchestrator({ lesson, values, onChange, checked, strictAccents = true, idBase = 'lesson', onFocusKey, renderGenerationControls }) {
  const [ratedGroups, setRatedGroups] = useState({});
  // Create a flat timeline of all exercises in creation order
  const exerciseTimeline = useMemo(() => {
    const timeline = [];
    const exerciseTypes = [
      ['fib', 'fill_in_blanks', 'Fill in the blanks'],
      ['mcq', 'multiple_choice', 'Multiple Choice'],
      ['cloze', 'cloze_passages', 'Cloze Passages'],
      ['clozeMix', 'cloze_with_mixed_options', 'Cloze (Mixed Options)'],
      ['dialogue', 'guided_dialogues', 'Guided Dialogues'],
      ['writing', 'writing_prompts', 'Writing Prompts'],
      ['reading', 'reading_comprehension', 'Reading Comprehension'],
      ['error', 'error_bundles', 'Error Bundles']
    ];

    exerciseTypes.forEach(([typeKey, lessonKey, displayName]) => {
      if (Array.isArray(lesson?.[lessonKey])) {
        lesson[lessonKey].forEach((item, idx) => {
          timeline.push({
            type: typeKey,
            lessonKey,
            displayName,
            item,
            idx,
            // Use createdAt timestamp if available, otherwise use array index as fallback
            createdAt: item.createdAt || 0
          });
        });
      }
    });

    // Sort by creation timestamp first, then by array index as tiebreaker
    return timeline.sort((a, b) => {
      // Primary sort: by createdAt timestamp
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      // Secondary sort: by array index within same type
      return a.idx - b.idx;
    });
  }, [lesson]);

  // Helper function to render an exercise by type
  const renderExercise = (exerciseData) => {
    const { type, item, idx, displayName } = exerciseData;
    const keyPrefix = `${idBase}:${type}:${idx}`;
    const val = values?.[keyPrefix] ?? (type === 'mcq' ? null : {});
    const setVal = (subKey, subVal) => {
      const newValue = type === 'mcq' ? subKey : { ...(val || {}), [String(subKey)]: subVal };
      onChange(keyPrefix, newValue);
    };

    const groupId = item?.exerciseGroupId;
    const hasGroup = typeof groupId === 'string' && groupId.length > 0;
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

    // Check if this is the last exercise of its group
    const currentIndex = exerciseTimeline.findIndex(ex => ex.type === type && ex.idx === idx);
    const nextExercise = currentIndex < exerciseTimeline.length - 1 ? exerciseTimeline[currentIndex + 1] : null;
    const isGroupEnd = hasGroup && (!nextExercise || nextExercise.item?.exerciseGroupId !== groupId);

    const exerciseComponent = () => {
      switch (type) {
        case 'fib':
          return <FIBExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />;
        case 'mcq':
          return <MCQExercise item={item} value={typeof val === 'number' ? val : null} onChange={(i) => onChange(keyPrefix, i)} checked={checked} idPrefix={keyPrefix} />;
        case 'cloze':
          return <ClozeExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />;
        case 'clozeMix':
          return <ClozeMixedExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} />;
        case 'dialogue':
          return <GuidedDialogueExercise item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />;
        case 'writing':
          return <WritingPromptExercise item={item} value={val || {}} onChange={setVal} checked={checked} idPrefix={keyPrefix} onFocusKey={onFocusKey} />;
        case 'reading':
          return <ReadingExercise item={item} value={val || {}} onChange={setVal} checked={checked} idPrefix={keyPrefix} onFocusKey={onFocusKey} />;
        case 'error':
          // For error bundles, determine mode based on position within error bundles
          const errorItems = lesson?.error_bundles || [];
          const errorIdx = errorItems.findIndex(eb => eb === item);
          const total = errorItems.length;
          const fixCount = Math.floor(total * 0.4);
          const isFix = errorIdx >= total - fixCount;
          const currentValue = values?.[keyPrefix];
          return (
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
          );
        default:
          return null;
      }
    };

    return (
      <div key={keyPrefix} className="space-y-2">
        {exerciseComponent()}
        {hasGroup && isGroupEnd && (
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
  };

  return (
    <div className="space-y-3">
      {lesson?.explanation && (
        <ExplanationComponent explanation={lesson.explanation} />
      )}
      {exerciseTimeline.map(renderExercise)}
      {renderGenerationControls && renderGenerationControls()}
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
    error_bundles: Math.max(0, Math.min(12, Number(counts?.error_bundles ?? 0))),
    reading_comprehension: Math.max(0, Math.min(10, Number(counts?.reading_comprehension ?? 0)))
  };

  // Initialize base text orchestration
  const chapterTracker = new BaseTextChapterTracker();
  
  // Fetch base texts for different exercise categories
  const baseTexts = await fetchBaseTextsForLesson(topic, chapterTracker, languageContext, safeCounts);
  
  // Generate exercises with orchestrated base text allocation
  const results = await generateOrchestredExercises(topic, safeCounts, languageContext, chapterTracker);

  // Build lesson bundle with orchestration metadata
  return {
    version: '1.1', // Updated version for orchestrated lessons
    language: languageContext.language,
    topic,
    pedagogy: { 
      approach: 'orchestrated-base-text', 
      strategy_notes: 'Base text chapters allocated to create synergies between exercises'
    },
    base_texts: baseTexts, // Multiple base texts may be used
    orchestration: chapterTracker.getDebugInfo(),
    explanation: results.explanation,
    fill_in_blanks: results.fibData.items || [],
    multiple_choice: results.mcqData.items || [],
    cloze_passages: results.clozeData.items || [],
    cloze_with_mixed_options: results.clozeMixData.items || [],
    guided_dialogues: results.dialogueData.items || [],
    writing_prompts: results.writingData.items || [],
    reading_comprehension: results.readingData.items || [],
    error_bundles: results.errorBundleData.items || [],
    error_bundles_shared_context: results.errorBundleData.shared_context || ''
  };
}

/**
 * Fetch base texts needed for the lesson based on exercise counts
 */
async function fetchBaseTextsForLesson(topic, chapterTracker, languageContext, safeCounts) {
  const baseTexts = [];
  const fetchedIds = new Set();
  
  // Determine how many base texts we need
  const needsSequential = safeCounts.reading_comprehension > 0 || safeCounts.cloze_passages > 0 || safeCounts.cloze_with_mixed_options > 0;
  const needsIsolated = safeCounts.fill_in_blanks > 0 || safeCounts.multiple_choice > 0 || safeCounts.error_bundles > 0;
  
  if (needsSequential) {
    // Fetch primary base text for sequential exercises
    const baseText = await fetchBaseText(topic, languageContext, []);
    if (baseText) {
      chapterTracker.addBaseText(baseText);
      baseTexts.push(baseText);
      fetchedIds.add(baseText.id);
    }
  }
  
  if (needsIsolated) {
    // Fetch secondary base text for isolated exercises if needed
    const exclusions = Array.from(fetchedIds);
    const isolatedBaseText = await fetchBaseText(topic, languageContext, exclusions);
    if (isolatedBaseText && !fetchedIds.has(isolatedBaseText.id)) {
      chapterTracker.addBaseText(isolatedBaseText);
      baseTexts.push(isolatedBaseText);
    }
  }
  
  return baseTexts;
}

/**
 * Fetch a single base text with exclusions
 */
async function fetchBaseText(topic, languageContext, excludeIds = []) {
  try {
    const resp = await fetch('/api/base-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        topic: topic, // Pass lesson topic so server can avoid base texts already used for reading at this topic/difficulty
        language: languageContext.language, 
        level: languageContext.level, 
        challengeMode: languageContext.challengeMode, 
        excludeIds 
      })
    });
    if (resp.ok) return await resp.json();
  } catch (e) {
    console.warn('Failed to fetch base text:', e);
  }
  return null;
}

/**
 * Generate all exercises with orchestrated base text chapter allocation
 */
async function generateOrchestredExercises(topic, safeCounts, languageContext, chapterTracker) {
  // Generate independent exercises (no base text needed)
  const independentPromises = [
    generateExplanation(topic, languageContext),
    safeCounts.guided_dialogues > 0 ? generateGuidedDialogues(topic, safeCounts.guided_dialogues, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.writing_prompts > 0 ? generateWritingPrompts(topic, safeCounts.writing_prompts, languageContext) : Promise.resolve({ items: [] })
  ];
  
  // Generate sequential exercises (reading, cloze, cloze_mixed) - these share chapters
  const sequentialPromises = [
    generateSequentialExercise('reading_comprehension', safeCounts.reading_comprehension, topic, languageContext, chapterTracker),
    generateSequentialExercise('cloze_passages', safeCounts.cloze_passages, topic, languageContext, chapterTracker),
    generateSequentialExercise('cloze_with_mixed_options', safeCounts.cloze_with_mixed_options, topic, languageContext, chapterTracker)
  ];
  
  // Generate isolated exercises (fib, mcq, error) - these avoid sequential chapters
  const isolatedPromises = [
    generateIsolatedExercise('fill_in_blanks', safeCounts.fill_in_blanks, topic, languageContext, chapterTracker),
    generateIsolatedExercise('multiple_choice', safeCounts.multiple_choice, topic, languageContext, chapterTracker),
    generateIsolatedExercise('error_bundles', safeCounts.error_bundles, topic, languageContext, chapterTracker)
  ];

  // Wait for all exercises to complete
  const [
    [explanation, dialogueData, writingData],
    [readingData, clozeData, clozeMixData],
    [fibData, mcqData, errorBundleData]
  ] = await Promise.all([
    Promise.all(independentPromises),
    Promise.all(sequentialPromises),
    Promise.all(isolatedPromises)
  ]);

  return {
    explanation,
    dialogueData,
    writingData,
    readingData,
    clozeData,
    clozeMixData,
    fibData,
    mcqData,
    errorBundleData
  };
}

/**
 * Generate a sequential exercise with chapter allocation
 */
async function generateSequentialExercise(exerciseType, count, topic, languageContext, chapterTracker) {
  if (count <= 0) return { items: [] };
  
  // Try to allocate a chapter from available base texts
  const baseTexts = Object.keys(chapterTracker.baseTexts);
  let chapterAllocation = null;
  
  for (const baseTextId of baseTexts) {
    chapterAllocation = chapterTracker.allocateSequentialChapter(baseTextId, exerciseType);
    if (chapterAllocation) break;
  }
  
  if (!chapterAllocation) {
    console.warn(`No chapter available for sequential exercise: ${exerciseType}`);
    return { items: [] };
  }
  
  // Create context for exercise generation
  const context = createChapterContext(
    chapterTracker.baseTexts[chapterAllocation.baseTextId],
    chapterAllocation.chapterIndex,
    chapterAllocation.allocationInfo
  );
  
  // Generate exercise based on type (placeholder for now)
  return await generateExerciseWithContext(exerciseType, count, topic, languageContext, context);
}

/**
 * Generate an isolated exercise with chapter allocation
 */
async function generateIsolatedExercise(exerciseType, count, topic, languageContext, chapterTracker) {
  if (count <= 0) return { items: [] };
  
  // Try to allocate a chapter from available base texts
  const baseTexts = Object.keys(chapterTracker.baseTexts);
  let chapterAllocation = null;
  
  for (const baseTextId of baseTexts) {
    chapterAllocation = chapterTracker.allocateIsolatedChapter(baseTextId, exerciseType);
    if (chapterAllocation) break;
  }
  
  if (!chapterAllocation) {
    console.warn(`No chapter available for isolated exercise: ${exerciseType}`);
    // Fallback to old generation method without base text
    return await generateExerciseWithoutBaseText(exerciseType, count, topic, languageContext);
  }
  
  // Create context for exercise generation
  const context = createChapterContext(
    chapterTracker.baseTexts[chapterAllocation.baseTextId],
    chapterAllocation.chapterIndex,
    chapterAllocation.allocationInfo
  );
  
  // Generate exercise based on type
  return await generateExerciseWithContext(exerciseType, count, topic, languageContext, context);
}

/**
 * Generate exercise with base text context (placeholder implementations)
 */
async function generateExerciseWithContext(exerciseType, count, topic, languageContext, context) {
  // For now, fallback to existing generation methods
  // TODO: Implement base-text-aware generation for each exercise type
  
  switch (exerciseType) {
    case 'reading_comprehension':
      return generateReading(topic, count, { ...languageContext, baseText: context?.baseText, chapter: context?.chapter });
    case 'cloze_passages':
      return generateCloze(topic, { ...languageContext, baseText: context?.baseText, chapter: context?.chapter });
    case 'cloze_with_mixed_options':
      return generateClozeMixed(topic, { ...languageContext, baseText: context?.baseText, chapter: context?.chapter });
    case 'fill_in_blanks':
      return generateFIB(topic, count, { ...languageContext, baseText: context?.baseText, chapter: context?.chapter });
    case 'multiple_choice':
      return generateMCQ(topic, count, { ...languageContext, baseText: context?.baseText, chapter: context?.chapter });
    case 'error_bundles':
      return generateErrorBundles(topic, count, { ...languageContext, baseText: context?.baseText, chapter: context?.chapter });
    default:
      return { items: [] };
  }
}

/**
 * Fallback generation without base text
 */
async function generateExerciseWithoutBaseText(exerciseType, count, topic, languageContext) {
  switch (exerciseType) {
    case 'reading_comprehension':
      return generateReading(topic, count, languageContext);
    case 'fill_in_blanks':
      return generateFIB(topic, count, languageContext);
    case 'multiple_choice':
      return generateMCQ(topic, count, languageContext);
    case 'error_bundles':
      return generateErrorBundles(topic, count, languageContext);
    default:
      return { items: [] };
  }
}


