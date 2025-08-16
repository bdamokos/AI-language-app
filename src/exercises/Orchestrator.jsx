import React, { useMemo } from 'react';
import FIBExercise, { scoreFIB, generateFIB } from './FIBExercise.jsx';
import MCQExercise, { scoreMCQ, generateMCQ } from './MCQExercise.jsx';
import ClozeExercise, { scoreCloze, generateCloze } from './ClozeExercise.jsx';
import ClozeMixedExercise, { scoreClozeMixed, generateClozeMixed } from './ClozeMixedExercise.jsx';
import GuidedDialogueExercise, { scoreGuidedDialogue, generateGuidedDialogues } from './GuidedDialogueExercise.jsx';
import WritingPromptExercise, { scoreWritingPrompt, generateWritingPrompts } from './WritingPromptExercise.jsx';
import ExplanationComponent, { generateExplanation } from './ExplanationComponent.jsx';
import { normalizeText } from './utils.js';

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
  const sections = useMemo(() => {
    const arr = [];
    if (Array.isArray(lesson?.fill_in_blanks)) arr.push(['fib', lesson.fill_in_blanks]);
    if (Array.isArray(lesson?.multiple_choice)) arr.push(['mcq', lesson.multiple_choice]);
    if (Array.isArray(lesson?.cloze_passages)) arr.push(['cloze', lesson.cloze_passages]);
    if (Array.isArray(lesson?.cloze_with_mixed_options)) arr.push(['clozeMix', lesson.cloze_with_mixed_options]);
    if (Array.isArray(lesson?.guided_dialogues)) arr.push(['dialogue', lesson.guided_dialogues]);
    if (Array.isArray(lesson?.writing_prompts)) arr.push(['writing', lesson.writing_prompts]);
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
          {items.map((item, idx) => {
            const keyPrefix = `${idBase}:${type}:${idx}`;
            const val = values?.[keyPrefix] ?? (type === 'mcq' ? null : {});
            const setVal = (subKey, subVal) => {
              const newValue = type === 'mcq' ? subKey : { ...(val || {}), [String(subKey)]: subVal };
              onChange(keyPrefix, newValue);
            };
            if (type === 'fib') {
              return (
                <FIBExercise key={keyPrefix} item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
              );
            }
            if (type === 'mcq') {
              return (
                <MCQExercise key={keyPrefix} item={item} value={typeof val === 'number' ? val : null} onChange={(i) => onChange(keyPrefix, i)} checked={checked} idPrefix={keyPrefix} />
              );
            }
            if (type === 'cloze') {
              return (
                <ClozeExercise key={keyPrefix} item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
              );
            }
            if (type === 'clozeMix') {
              return (
                <ClozeMixedExercise key={keyPrefix} item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} />
              );
            }
            if (type === 'dialogue') {
              return (
                <GuidedDialogueExercise key={keyPrefix} item={item} value={val || {}} onChange={setVal} checked={checked} strictAccents={strictAccents} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
              );
            }
            if (type === 'writing') {
              return (
                <WritingPromptExercise key={keyPrefix} item={item} value={val || {}} onChange={setVal} checked={checked} idPrefix={keyPrefix} onFocusKey={onFocusKey} />
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
    writing_prompts: Math.max(0, Math.min(10, Number(counts?.writing_prompts ?? 0)))
  };

  // Generate all exercise types in parallel using component generation functions
  const [explanation, fibData, mcqData, clozeData, clozeMixData, dialogueData, writingData] = await Promise.all([
    generateExplanation(topic, languageContext),
    safeCounts.fill_in_blanks > 0 ? generateFIB(topic, safeCounts.fill_in_blanks, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.multiple_choice > 0 ? generateMCQ(topic, safeCounts.multiple_choice, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.cloze_passages > 0 ? generateCloze(topic, safeCounts.cloze_passages, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.cloze_with_mixed_options > 0 ? generateClozeMixed(topic, safeCounts.cloze_with_mixed_options, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.guided_dialogues > 0 ? generateGuidedDialogues(topic, safeCounts.guided_dialogues, languageContext) : Promise.resolve({ items: [] }),
    safeCounts.writing_prompts > 0 ? generateWritingPrompts(topic, safeCounts.writing_prompts, languageContext) : Promise.resolve({ items: [] })
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
  };
}


