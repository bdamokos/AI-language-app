import React, { useMemo } from 'react';
import FIBExercise, { scoreFIB } from './FIBExercise.jsx';
import MCQExercise, { scoreMCQ } from './MCQExercise.jsx';
import ClozeExercise, { scoreCloze } from './ClozeExercise.jsx';
import ClozeMixedExercise, { scoreClozeMixed } from './ClozeMixedExercise.jsx';
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
    return arr;
  }, [lesson]);

  return (
    <div className="space-y-3">
      {sections.map(([type, items]) => (
        <div key={type} className="space-y-3">
          {type === 'fib' && items.length > 0 && <h3 className="font-semibold text-gray-800">Fill in the blanks</h3>}
          {type === 'mcq' && items.length > 0 && <h3 className="font-semibold text-gray-800">Multiple Choice</h3>}
          {type === 'cloze' && items.length > 0 && <h3 className="font-semibold text-gray-800">Cloze Passages</h3>}
          {type === 'clozeMix' && items.length > 0 && <h3 className="font-semibold text-gray-800">Cloze (Mixed Options)</h3>}
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
  return { correct, total };
}


