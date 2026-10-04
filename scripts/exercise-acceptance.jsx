// Acceptance entry for an explicitly supplied API transport. This module neither
// discovers credentials nor starts a server. Bundle with esbuild (platform: node,
// format: esm, packages: external), then import runExerciseAcceptance in a runner.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { apiFetch, loadSession } from '../src/utils/api.js';
import { BASE_TEXT_SCHEMA } from '../server/baseTextPrompts.js';
import { countBlanks, normalizeText, sanitizeClozeItem } from '../src/exercises/utils.js';
import FIBExercise, { generateFIB, scoreFIB } from '../src/exercises/FIBExercise.jsx';
import MCQExercise, { generateMCQ, scoreMCQ } from '../src/exercises/MCQExercise.jsx';
import ClozeExercise, { generateCloze, scoreCloze } from '../src/exercises/ClozeExercise.jsx';
import ClozeMixedExercise, { generateClozeMixed, scoreClozeMixed } from '../src/exercises/ClozeMixedExercise.jsx';
import ReadingExercise, { generateReading, scoreReading } from '../src/exercises/ReadingExercise.jsx';
import GuidedDialogueExercise, { generateGuidedDialogues, scoreGuidedDialogue } from '../src/exercises/GuidedDialogueExercise.jsx';
import WritingPromptExercise, { generateWritingPrompts, scoreWritingPrompt } from '../src/exercises/WritingPromptExercise.jsx';
import RewritingExercise, { generateRewriting, scoreRewriting } from '../src/exercises/RewritingExercise.jsx';
import ErrorBundleExercise, { generateErrorBundles, scoreErrorBundle } from '../src/exercises/ErrorBundleExercise.jsx';
import ExplanationComponent, { generateExplanation, generateExplanationStream } from '../src/exercises/ExplanationComponent.jsx';
import { scoreLesson } from '../src/exercises/Orchestrator.jsx';

export const EXERCISE_CASES = Object.freeze([
  'explanationStream', 'explanation', 'fib', 'mcq', 'cloze', 'clozeMixed',
  'reading', 'dialogue', 'writing', 'rewriting', 'errorBundle', 'recommendation', 'feedback'
]);

const metadataFields = new Set([
  '_cacheKey', 'exerciseSha', 'exerciseGroupId', 'baseTextId', 'baseTextChapter',
  'base_text_info', 'localImageUrl', 'source', 'id', 'language', 'level',
  'challengeMode', 'topic', 'images'
]);
const nonempty = (value, label) => assert.ok(typeof value === 'string' && value.trim(), `${label} must be nonempty text`);
const eq = (a, b) => normalizeText(a, true) === normalizeText(b, true);
const controls = (html, tag) => (html.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
const noop = () => {};
let running = false;

// Implements every assertion keyword used by the imported generator schemas.
// Server-added cache/source metadata is allowed; generated unknown fields are not.
export function validateSchema(value, schema, path = '$') {
  if (!schema || schema === true) return;
  assert.notEqual(schema, false, `${path} is disallowed`);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.includes(actual) || (types.includes('integer') && Number.isInteger(value)), `${path} expected ${types.join('|')}, got ${actual}`);
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} is outside its enum`);
  if (actual === 'array') {
    if (schema.minItems != null) assert.ok(value.length >= schema.minItems, `${path} has too few items`);
    if (schema.maxItems != null) assert.ok(value.length <= schema.maxItems, `${path} has too many items`);
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  } else if (actual === 'object') {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.ok(metadataFields.has(key), `${path}.${key} is unexpected`);
    }
  } else if (actual === 'string') {
    if (schema.minLength != null) assert.ok([...value].length >= schema.minLength, `${path} is too short`);
    if (schema.maxLength != null) assert.ok([...value].length <= schema.maxLength, `${path} is too long`);
  }
}

function render(Component, item, value, checked, extra = {}) {
  const html = renderToStaticMarkup(<Component item={item} value={value} checked={checked}
    onChange={noop} onFocusKey={noop} idPrefix="acceptance:0" strictAccents {...extra} />);
  assert.ok(html.length > 0, 'Renderer produced no markup');
  return html;
}

function scoreChecks(score, item, correctValue, incorrectValue, expectedTotal) {
  const perfect = score(item, correctValue, eq, true, 0);
  const wrong = score(item, incorrectValue, eq, true, 0);
  assert.equal(perfect.total, expectedTotal, 'Score total differs from visible answer count');
  assert.equal(perfect.correct, expectedTotal, 'Model answers must score correctly');
  assert.equal(wrong.correct, 0, 'Incorrect answers must score zero');
  return perfect;
}

export function validateExerciseItem(type, item) {
  let Component, score, correctValue, incorrectValue = {}, answerCount = 0, inputTag = 'input';
  if (type === 'fib') {
    Component = FIBExercise; score = scoreFIB;
    nonempty(item.sentence, 'FIB sentence');
    answerCount = countBlanks(item.sentence);
    assert.ok(answerCount > 0, 'FIB must contain renderable five-underscore blanks');
    assert.equal(item.answers?.length, answerCount, 'Each FIB blank needs one answer');
    item.answers.forEach(answer => nonempty(answer, 'FIB answer'));
    correctValue = Object.fromEntries(item.answers.map((answer, index) => [String(index), answer]));
  } else if (type === 'mcq') {
    Component = MCQExercise; score = scoreMCQ;
    nonempty(item.question, 'MCQ question');
    assert.equal(item.options?.length, 4, 'MCQ needs four options');
    assert.equal(item.options.filter(option => option.correct).length, 1, 'MCQ needs exactly one correct answer');
    assert.equal(new Set(item.options.map(option => normalizeText(option.text))).size, 4, 'MCQ option text must be distinct');
    item.options.forEach(option => { nonempty(option.text, 'MCQ option'); nonempty(option.rationale, 'MCQ rationale'); });
    correctValue = item.options.findIndex(option => option.correct);
    incorrectValue = item.options.findIndex(option => !option.correct);
    answerCount = 1;
  } else if (type === 'cloze' || type === 'clozeMixed') {
    const mixed = type === 'clozeMixed';
    Component = mixed ? ClozeMixedExercise : ClozeExercise;
    score = mixed ? scoreClozeMixed : scoreCloze;
    nonempty(item.passage, 'Cloze passage');
    answerCount = countBlanks(item.passage);
    assert.ok(answerCount > 0, 'Cloze must contain answerable blanks');
    assert.equal(item.blanks?.length, answerCount, 'Cloze blanks must match the passage');
    correctValue = {};
    item.blanks.forEach((blank, index) => {
      assert.equal(blank.index, index, 'Cloze blank indices must follow rendered passage order');
      if (mixed) {
        assert.ok(blank.options?.length >= 2, 'Mixed cloze needs answer choices');
        assert.ok(Number.isInteger(blank.correct_index) && blank.correct_index >= 0 && blank.correct_index < blank.options.length, 'Mixed cloze answer index is invalid');
        blank.options.forEach(option => nonempty(option, 'Mixed cloze option'));
        assert.equal(new Set(blank.options.map(option => normalizeText(option, true))).size,
          blank.options.length, 'Mixed cloze choices must remain distinct under answer scoring');
      }
      const answer = mixed ? blank.options[blank.correct_index] : blank.answer;
      nonempty(answer, 'Cloze answer');
      correctValue[String(index)] = answer;
    });
    // Also render the post-effect representation used by the browser component.
    const sanitized = sanitizeClozeItem(structuredClone(item));
    assert.equal(countBlanks(sanitized.item.passage), answerCount, 'Sanitization changes answer count');
    assert.deepEqual(score(sanitized.item, correctValue, eq), { correct: answerCount, total: answerCount });
    item = sanitized.item;
    inputTag = mixed ? 'select' : 'input';
  } else if (type === 'reading') {
    Component = ReadingExercise; score = scoreReading;
    nonempty(item.title, 'Reading title'); nonempty(item.passage, 'Reading passage');
    assert.ok(item.true_false?.length > 0, 'Reading needs true/false questions');
    correctValue = {}; incorrectValue = {};
    item.true_false.forEach((question, index) => {
      nonempty(question.statement, 'Reading true/false statement');
      assert.equal(typeof question.answer, 'boolean', 'Reading answer must be boolean');
      correctValue[`tf:${index}`] = question.answer;
      incorrectValue[`tf:${index}`] = !question.answer;
    });
    assert.ok(item.comprehension_questions?.length > 0, 'Reading needs comprehension questions');
    item.comprehension_questions.forEach(question => { nonempty(question.question, 'Reading question'); nonempty(question.model_answer, 'Reading model answer'); });
    item.productive_prompts?.forEach(prompt => { nonempty(prompt.prompt, 'Reading writing prompt'); nonempty(prompt.model_answer, 'Reading writing answer'); });
    item.opinion_questions?.forEach(question => {
      nonempty(question.question, 'Reading opinion question');
      for (const stance of ['agree', 'disagree', 'neutral']) nonempty(question.model_answers?.[stance], `Reading ${stance} answer`);
    });
    answerCount = item.true_false.length;
  } else if (type === 'dialogue') {
    Component = GuidedDialogueExercise; score = scoreGuidedDialogue;
    nonempty(item.studentInstructions, 'Dialogue instructions'); nonempty(item.conversationContext, 'Dialogue context');
    assert.ok(item.turns?.length >= 6, 'Dialogue needs six or more turns');
    const speakers = [...new Set(item.turns.map(turn => turn.speaker))];
    assert.equal(speakers.length, 2, 'Dialogue needs two consistent speakers');
    const hidden = item.hide_speaker || item.suggested_hide_speaker || speakers[1];
    assert.ok(item.turns.filter(turn => turn.speaker === hidden).length >= 2, 'Dialogue needs a missing line after its example');
    item.turns.forEach(turn => { nonempty(turn.text, 'Dialogue line'); nonempty(turn.hint, 'Dialogue hint'); });
    correctValue = Object.fromEntries(item.turns.map((turn, index) => [String(index), turn.text]));
  } else if (type === 'writing') {
    Component = WritingPromptExercise; score = scoreWritingPrompt; inputTag = 'textarea';
    nonempty(item.studentInstructions, 'Writing instructions');
    assert.ok(item.prompts?.length >= 3, 'Writing needs three or more prompts');
    assert.equal(item.example_answers?.length, item.prompts.length, 'Each writing prompt needs a model answer');
    item.prompts.forEach(prompt => nonempty(prompt.question, 'Writing prompt'));
    item.example_answers.forEach(answer => nonempty(answer, 'Writing model answer'));
    correctValue = Object.fromEntries(item.example_answers.map((answer, index) => [String(index), answer]));
  } else if (type === 'rewriting') {
    Component = RewritingExercise; score = scoreRewriting;
    for (const key of ['original', 'instruction', 'answer']) nonempty(item[key], `Rewriting ${key}`);
    correctValue = item.answer; incorrectValue = ''; answerCount = 1;
  } else if (type === 'errorBundle') {
    Component = ErrorBundleExercise; score = scoreErrorBundle;
    assert.equal(item.sentences?.length, 4, 'Error bundle needs four sentences');
    assert.equal(item.sentences.filter(sentence => sentence.correct).length, 1, 'Error bundle needs one correct sentence');
    item.sentences.forEach(sentence => {
      nonempty(sentence.text, 'Error bundle sentence'); nonempty(sentence.rationale, 'Error bundle rationale');
      if (!sentence.correct) nonempty(sentence.fix, 'Error bundle correction');
    });
    assert.equal(new Set(item.sentences.map(sentence => sentence.text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase())).size,
      4, 'Error bundle sentences must be distinct');
    correctValue = item.sentences.findIndex(sentence => sentence.correct);
    incorrectValue = item.sentences.findIndex(sentence => !sentence.correct);
    answerCount = 1;
    const correction = item.sentences.find(sentence => !sentence.correct).fix;
    scoreChecks(score, item, correction, 'this is a deliberately unrelated incorrect answer', 1);
    assert.equal(controls(render(Component, item, correction, true, { mode: 'fix' }), 'input'), 1, 'Correction mode must render an input');
  } else throw new Error(`Unknown exercise type: ${type}`);

  const before = render(Component, item, type === 'rewriting' ? '' : {}, false);
  const after = render(Component, item, correctValue, true);
  const renderedInputs = controls(before, inputTag);
  assert.ok(renderedInputs > 0, `${type} rendered no answer controls`);
  if (['fib', 'cloze', 'clozeMixed', 'rewriting'].includes(type)) assert.equal(renderedInputs, answerCount, 'Rendered controls do not match scored answers');
  if (type === 'writing') assert.equal(renderedInputs, item.prompts.length, 'Missing writing fields');
  const result = scoreChecks(score, item, correctValue, incorrectValue, answerCount);
  return { ...result, renderedInputs, checkedMarkupBytes: Buffer.byteLength(after), openEnded: ['dialogue', 'writing'].includes(type) };
}

/**
 * transport must return a standard Response and implement the app's /api routes,
 * including /api/auth/session with a CSRF token. It owns auth and server isolation.
 * Optional cases/counts permit focused retries; no case automatically retries.
 */
export async function runExerciseAcceptance({ fetch: transport, topic = 'ser vs estar',
  languageContext = { language: 'Spanish', level: 'B1', challengeMode: false },
  cases = EXERCISE_CASES, counts = {}, baseText: providedBaseText,
  seedOutputs = {}, onResult = noop, onRequest = noop, onOutput = noop } = {}) {
  assert.equal(typeof transport, 'function', 'An explicit API transport is required');
  assert.ok(!running, 'Run one acceptance harness at a time in this process');
  for (const type of cases) assert.ok(EXERCISE_CASES.includes(type), `Unknown case: ${type}`);
  running = true;
  const priorFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const events = new EventTarget();
  const requests = [], results = [];
  const outputs = new Map(Object.entries(seedOutputs));
  let currentCase, basePromise;
  const schemaFailures = [];
  globalThis.window = { dispatchEvent: event => events.dispatchEvent(event) };
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(typeof url === 'string' && url.startsWith('/api/'), 'Generator attempted a non-API request');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    const request = { case: currentCase, path: url, schema: body?.schemaName || null, method: options.method || 'GET', durationMs: 0 };
    const started = Date.now();
    requests.push(request);
    onRequest({ ...request, state: 'start' });
    try {
      const response = await transport(url, options);
      request.status = response.status;
      const schema = body?.jsonSchema || (url === '/api/base-text' ? BASE_TEXT_SCHEMA : null);
      if (response.ok && schema) {
        try { validateSchema(await response.clone().json(), schema); request.schemaValid = true; }
        catch (error) { request.schemaValid = false; schemaFailures.push({ case: currentCase, message: error.message }); }
      }
      return response;
    } finally {
      request.durationMs = Date.now() - started;
      onRequest({ ...request, state: 'end' });
    }
  };
  const contextWithChapter = async () => {
    if (languageContext.chapter?.passage) return languageContext;
    if (!basePromise) basePromise = (async () => {
      const baseText = providedBaseText || await (await apiFetch('/api/base-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, language: languageContext.language, level: languageContext.level,
          challengeMode: !!languageContext.challengeMode, excludeIds: [] })
      })).json();
      validateSchema(baseText, BASE_TEXT_SCHEMA);
      nonempty(baseText.chapters?.[0]?.passage, 'Base-text first chapter');
      await onOutput('baseText', baseText);
      return { ...languageContext, baseText, chapter: baseText.chapters[0] };
    })();
    return basePromise;
  };
  try {
    await loadSession();
    for (const type of cases) {
      currentCase = type;
      const started = Date.now(), requestStart = requests.length, failureStart = schemaFailures.length;
      const result = { type, status: 'fail', durationMs: 0 };
      try {
        let output;
        const count = counts[type] ?? (type === 'errorBundle' ? 2 : 1);
        if (type === 'recommendation' || type === 'feedback') {
          // Match AIPracticeApp's actual requests. Only educational answers are
          // used; a prior generated FIB is preferred to the explicit sample.
          const item = outputs.get('fib')?.items?.[0] || {
            sentence: 'Cuando llegué, Ana ya _____ salido.', answers: ['había'], difficulty: 'medium'
          };
          const userAnswer = Object.fromEntries(item.answers.map((_, index) => [String(index), 'respuesta incorrecta']));
          result.answerSource = outputs.has('fib') ? 'generated' : 'educational-sample';
          let body;
          if (type === 'recommendation') {
            const score = scoreLesson({ fill_in_blanks: [item] }, { 'lesson:fib:0': userAnswer }, true);
            assert.ok(score.total > 0, 'Recommendation needs a scored exercise');
            body = { topic, score, percentage: score.correct / score.total * 100,
              wrongExercises: [{ type: 'fib', index: 0, item, userAnswer }] };
          } else {
            body = { topic, exercise: { ...item, answer: item.answers.join(', ') }, userAnswer: Object.values(userAnswer).join(', ') };
          }
          const response = await apiFetch(type === 'recommendation' ? '/api/recommend' : '/api/explain', {
            method: 'POST', signal: languageContext.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          });
          output = await response.json();
          if (type === 'recommendation') {
            nonempty(output.recommendation, 'Recommended topic'); nonempty(output.reasoning, 'Recommendation reasoning');
          } else nonempty(output.explanation, 'Answer feedback');
          result.items = 1;
        } else if (type === 'explanation' || type === 'explanationStream') {
          const updates = [];
          output = type === 'explanation'
            ? await generateExplanation(topic, languageContext)
            : await generateExplanationStream(topic, languageContext, update => updates.push(update.type));
          nonempty(output.title, 'Explanation title'); nonempty(output.content_markdown, 'Explanation markdown');
          assert.ok(renderToStaticMarkup(<ExplanationComponent explanation={output} />).length > 0);
          result.items = 1; result.updates = updates;
        } else {
          const context = ['fib', 'cloze', 'clozeMixed', 'reading', 'rewriting', 'errorBundle'].includes(type)
            ? await contextWithChapter() : languageContext;
          const generators = { fib: generateFIB, mcq: generateMCQ, reading: generateReading,
            dialogue: generateGuidedDialogues, writing: generateWritingPrompts,
            rewriting: generateRewriting, errorBundle: generateErrorBundles };
          output = type === 'cloze' ? await generateCloze(topic, context)
            : type === 'clozeMixed' ? await generateClozeMixed(topic, context)
              : await generators[type](topic, count, context);
          assert.ok(Array.isArray(output?.items), 'Generator did not return an items array');
          assert.equal(output.items.length, ['cloze', 'clozeMixed'].includes(type) ? 1 : count, 'Generator returned the wrong item count');
          result.items = output.items.length;
          result.validation = output.items.map(item => validateExerciseItem(type, item));
        }
        outputs.set(type, output);
        await onOutput(type, output);
        const failures = schemaFailures.slice(failureStart);
        assert.equal(failures.length, 0, failures.map(failure => failure.message).join('; '));
        result.status = 'pass';
      } catch (error) {
        // apiFetch exposes safe provider diagnostics, never request tokens/bodies.
        result.error = error.message;
        if (error.code) result.code = error.code;
      }
      result.durationMs = Date.now() - started;
      result.requests = requests.slice(requestStart);
      results.push(result);
      await onResult(result);
    }
    return { passed: results.length === cases.length && results.every(result => result.status === 'pass'), results, requests };
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
    running = false;
  }
}
