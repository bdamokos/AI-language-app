import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, 'node_modules/.cache'), { recursive: true });
const temp = await mkdtemp(join(root, 'node_modules/.cache/exercise-generators-'));
const output = join(temp, 'generators.mjs');
await build({
  stdin: {
    contents: [
      "export { generateFIB } from './src/exercises/FIBExercise.jsx';",
      "export { generateMCQ } from './src/exercises/MCQExercise.jsx';",
      "export { generateGuidedDialogues } from './src/exercises/GuidedDialogueExercise.jsx';",
      "export { generateWritingPrompts } from './src/exercises/WritingPromptExercise.jsx';",
      "export { generateRewriting } from './src/exercises/RewritingExercise.jsx';",
      "export { generateCloze } from './src/exercises/ClozeExercise.jsx';",
      "export { generateClozeMixed } from './src/exercises/ClozeMixedExercise.jsx';",
      "export { generateUnifiedClozeStepwise, splitIntoSentences } from './src/exercises/ClozeUnified.jsx';",
      "export { generateReading } from './src/exercises/ReadingExercise.jsx';",
      "export { generateErrorBundles } from './src/exercises/ErrorBundleExercise.jsx';",
      "export { generateExplanation, generateExplanationStream } from './src/exercises/ExplanationComponent.jsx';",
      "export { validateExerciseItem, runExerciseAcceptance } from './scripts/exercise-acceptance.jsx';"
    ].join('\n'), resolveDir: root
  }, outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent'
});
const generators = await import(pathToFileURL(output).href);
after(() => rm(temp, { recursive: true, force: true }));

const context = {
  language: 'Spanish', level: 'B1', challengeMode: false,
  baseText: { id: 'test-base', title: 'Un viaje' },
  chapter: { title: 'La llegada', passage: 'Ana había llegado antes que Luis.' }
};
const fib = { sentence: 'Ana _____ llegado antes que Luis.', answers: ['había'], difficulty: 'medium' };
const mcq = { question: 'Ana _____ llegado antes que Luis.', difficulty: 'medium', options: [
  { text: 'había', correct: true, rationale: 'Expresa anterioridad en el pasado.' },
  { text: 'ha', correct: false, rationale: 'Relaciona el hecho con el presente.' },
  { text: 'es', correct: false, rationale: 'No forma un tiempo compuesto.' },
  { text: 'está', correct: false, rationale: 'No forma el pluscuamperfecto.' }
] };
const dialogue = {
  studentInstructions: 'Completa las intervenciones de Luis.', conversationContext: 'Ana y Luis hablan de su llegada.',
  suggested_hide_speaker: 'Luis', turns: Array.from({ length: 6 }, (_, index) => ({
    speaker: index % 2 ? 'Luis' : 'Ana', text: index % 2 ? 'Ya había llegado.' : '¿Habías llegado?', hint: 'Habla de una llegada anterior.'
  }))
};
const writing = { studentInstructions: 'Describe situaciones anteriores a otro hecho.',
  prompts: Array.from({ length: 3 }, (_, index) => ({ question: `¿Qué habías hecho antes del viaje ${index + 1}?` })),
  example_answers: ['Había comprado el billete.', 'Había preparado la maleta.', 'Había reservado una habitación.'] };
const rewriting = { original: 'Ana llegó antes.', instruction: 'Usa el pluscuamperfecto.', answer: 'Ana había llegado antes.' };

async function generate(name, result, count = 1, languageContext = context) {
  const previous = globalThis.fetch;
  let request, signal;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/session') return Response.json({ csrfToken: 'offline-test-csrf' });
    assert.equal(url, name === 'generateExplanationStream' ? '/api/explanations/stream' : '/api/generate');
    request = JSON.parse(options.body);
    signal = options.signal;
    return Response.json(result);
  };
  try {
    const value = await (name === 'generateExplanation' || name === 'generateExplanationStream'
      ? generators[name]('pluscuamperfecto', languageContext)
      : generators[name]('pluscuamperfecto', count, languageContext));
    return { value, request, signal };
  } finally { globalThis.fetch = previous; }
}

test('FIB accepts an answerable sentence and rejects malformed blanks or missing answers', async () => {
  const { value } = await generate('generateFIB', { items: [fib] });
  assert.deepEqual(generators.validateExerciseItem('fib', value.items[0]).correct, 1);
  for (const malformed of [{ ...fib, sentence: 'Ana ___ llegado.' }, { ...fib, answers: [] }]) {
    await assert.rejects(generate('generateFIB', { items: [malformed] }), /incomplete fill-in-the-blank/);
  }
});

test('MCQ requires four distinct options and exactly one correct answer', async () => {
  const { value } = await generate('generateMCQ', { items: [mcq] });
  assert.equal(generators.validateExerciseItem('mcq', value.items[0]).correct, 1);
  await assert.rejects(generate('generateMCQ', { items: [{ ...mcq, options: mcq.options.map(option => ({ ...option, correct: false })) }] }), /incomplete multiple-choice/);
  await assert.rejects(generate('generateMCQ', { items: [{ ...mcq, options: [mcq.options[0], mcq.options[1], mcq.options[2], mcq.options[2]] }] }), /incomplete multiple-choice/);
});

test('dialogues need visible missing lines, per-turn hints, and a valid hidden speaker', async () => {
  const { value, request } = await generate('generateGuidedDialogues', { items: [dialogue] });
  const checked = generators.validateExerciseItem('dialogue', value.items[0]);
  assert.equal(checked.openEnded, true);
  assert.equal(checked.renderedInputs, 2);
  assert.ok(request.jsonSchema.properties.items.items.properties.turns.items.required.includes('hint'));
  await assert.rejects(generate('generateGuidedDialogues', { items: [{ ...dialogue, suggested_hide_speaker: 'Nobody' }] }), /incomplete guided dialogues/);
  await assert.rejects(generate('generateGuidedDialogues', { items: [{ ...dialogue, turns: dialogue.turns.map(turn => ({ ...turn, hint: '' })) }] }), /incomplete guided dialogues/);
});

test('writing requires one model answer per prompt and renders all response fields', async () => {
  const { value } = await generate('generateWritingPrompts', { items: [writing] });
  assert.equal(generators.validateExerciseItem('writing', value.items[0]).renderedInputs, 3);
  await assert.rejects(generate('generateWritingPrompts', { items: [{ ...writing, example_answers: [] }] }), /incomplete writing/);
});

test('rewriting requires an instruction, original sentence, and nonempty answer', async () => {
  const { value } = await generate('generateRewriting', { items: [rewriting] });
  assert.equal(generators.validateExerciseItem('rewriting', value.items[0]).correct, 1);
  await assert.rejects(generate('generateRewriting', { items: [{ ...rewriting, answer: '' }] }), /incomplete rewriting/);
});

test('explanation requests its JSON contract and rejects an empty lesson', async () => {
  const { request } = await generate('generateExplanation', { title: 'El pluscuamperfecto', content_markdown: 'Expresa una acción anterior a otra acción pasada.' });
  assert.match(request.system, /JSON object/);
  assert.doesNotMatch(request.system, /Return ONLY content/);
  await assert.rejects(generate('generateExplanation', { title: 'El pluscuamperfecto', content_markdown: '' }), /incomplete explanation/);
});

test('fractional and excessive counts agree between prompt, schema, and output validation', async () => {
  const { request } = await generate('generateMCQ', { items: [mcq, mcq] }, 2.9);
  assert.match(request.user, /exactly 2 /);
  assert.equal(request.jsonSchema.properties.items.minItems, 2);
  assert.equal(request.jsonSchema.properties.items.maxItems, 2);
  const capped = await generate('generateWritingPrompts', { items: Array(10).fill(writing) }, 200);
  assert.equal(capped.request.jsonSchema.properties.items.maxItems, 10);
  await assert.rejects(generate('generateFIB', { items: [fib] }, 2), /incomplete fill-in-the-blank/);
});

test('all owned generators forward cancellation without serializing the signal', async () => {
  const controller = new AbortController();
  const cases = [
    ['generateFIB', { items: [fib] }], ['generateMCQ', { items: [mcq] }],
    ['generateGuidedDialogues', { items: [dialogue] }], ['generateWritingPrompts', { items: [writing] }],
    ['generateRewriting', { items: [rewriting] }],
    ['generateExplanation', { title: 'El pluscuamperfecto', content_markdown: 'Una acción anterior a otra acción pasada.' }],
    ['generateExplanationStream', { title: 'El pluscuamperfecto', content_markdown: 'Una acción anterior a otra acción pasada.' }]
  ];
  for (const [name, output] of cases) {
    const { request, signal } = await generate(name, output, 1, { ...context, signal: controller.signal });
    assert.equal(signal, controller.signal, `${name} must use the caller's cancellation signal`);
    assert.ok(!Object.hasOwn(request, 'signal'));
    assert.ok(!Object.hasOwn(request.metadata || {}, 'signal'));
  }
});

test('acceptance harness executes real FIB generator with injected transport and restores globals', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const report = await generators.runExerciseAcceptance({
    topic: 'pluscuamperfecto', languageContext: context, cases: ['fib'],
    fetch: async (url, options) => {
      if (url === '/api/auth/session') return Response.json({ csrfToken: 'offline-test-csrf' });
      assert.equal(url, '/api/generate');
      assert.equal(JSON.parse(options.body).schemaName, 'fib_list');
      return Response.json({ items: [fib] });
    }
  });
  assert.equal(report.passed, true);
  assert.equal(report.results[0].validation[0].renderedInputs, 1);
  assert.equal(globalThis.fetch, previousFetch);
  assert.equal(globalThis.window, previousWindow);
});

function generatorTransport(t, respond) {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/session') return Response.json({ csrfToken: 'offline-test-csrf' });
    const call = { url, body: JSON.parse(options.body), signal: options.signal };
    calls.push(call);
    return respond(call, calls.length);
  };
  return calls;
}

function unifiedCloze(blanks = 6) {
  return { items: [{ title: 'La llegada', student_instructions: 'Completa los huecos.', total_blanks: 99,
    segments: Array.from({ length: blanks }, (_, index) => [
      { type: 'text', content: `${index ? ' ' : ''}Ana ` },
      { type: 'blank', solution: 'había', distractors: ['ha', 'es', 'está'], difficulty_level: 'hard', hint: 'Una acción anterior', explanation: { solution: 'Expresa anterioridad.', distractor_explanations: [] } },
      { type: 'text', content: ' llegado.' }
    ]).flat()
  }] };
}

test('both cloze formats make one request and retain six answerable blanks at the selected level', async t => {
  const calls = generatorTransport(t, () => Response.json(unifiedCloze()));
  const controller = new AbortController();
  for (const name of ['generateCloze', 'generateClozeMixed']) {
    const before = calls.length;
    const result = await generators[name]('pluscuamperfecto', { ...context, signal: controller.signal });
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).body.schemaName, 'unified_cloze');
    assert.equal(calls.at(-1).signal, controller.signal);
    assert.ok(!Object.hasOwn(calls.at(-1).body, 'signal'));
    assert.ok(calls.at(-1).body.user.includes(context.chapter.passage));
    const item = result.items[0];
    assert.equal(generators.validateExerciseItem(name === 'generateCloze' ? 'cloze' : 'clozeMixed', item).correct, 6);
    assert.equal(item.blanks.length, 6);
    assert.equal((item.passage.match(/_____/g) || []).length, 6);
    assert.equal(item.total_blanks_available, 6, 'counts must come from usable blanks rather than model metadata');
    assert.ok(item.blanks.every(blank => name === 'generateCloze'
      ? blank.answer === 'había'
      : blank.options[blank.correct_index] === 'había'));
  }
});

test('cloze rejects insufficient blanks, hidden text blanks and ambiguous answers without retrying', async t => {
  const outputs = [unifiedCloze(0), unifiedCloze(5), unifiedCloze(), unifiedCloze()];
  outputs[2].items[0].segments[0].content = 'Ana _____ llegado.';
  outputs[3].items[0].segments[1].distractors[0] = 'había';
  const calls = generatorTransport(t, () => Response.json(outputs.shift()));
  for (let index = 0; index < 4; index++) {
    await assert.rejects(generators.generateCloze('pluscuamperfecto', context), /cloze/);
    assert.equal(calls.length, index + 1);
  }
});

test('cloze preserves provider failures and never starts a fallback paid request', async t => {
  let status = 429;
  const calls = generatorTransport(t, () => Response.json({ details: 'Provider request failed.', code: 'provider_fixture_error' }, { status }));
  for (const name of ['generateCloze', 'generateClozeMixed']) {
    for (status of [401, 403, 429, 504]) {
      const before = calls.length;
      await assert.rejects(generators[name]('pluscuamperfecto', context), { message: 'Provider request failed.', status, code: 'provider_fixture_error' });
      assert.equal(calls.length, before + 1);
    }
  }
});

test('sentence splitting never duplicates the full passage as a tail', () => {
  for (const [source, expected] of [
    ['Ana llegó. Luis salió.', ['Ana llegó.', 'Luis salió.']],
    ['Ana llegó. Una cola sin punto', ['Ana llegó.', 'Una cola sin punto']],
    ['Hola。 Adiós！', ['Hola。', 'Adiós！']],
    ['Sin punto final', ['Sin punto final']],
    ['', []]
  ]) assert.deepEqual(generators.splitIntoSentences(source), expected);
});

test('retained stepwise cloze stops on presence or segmentation provider failures', async t => {
  let failureAt = 2;
  let step = 0;
  const calls = generatorTransport(t, () => {
    step += 1;
    if (step === failureAt) return Response.json({ details: 'Plan usage exhausted.', code: 'usage_limit' }, { status: 429 });
    return Response.json(step === 1 ? { rewritten_passage: 'Ana había llegado a la estación antes de las ocho.' } : { present: true });
  });
  for (failureAt of [2, 3]) {
    step = 0;
    const before = calls.length;
    await assert.rejects(generators.generateUnifiedClozeStepwise('pluscuamperfecto', context), { status: 429, code: 'usage_limit' });
    assert.equal(calls.length - before, failureAt);
  }
});

test('reading count, schema and returned sets agree for standalone and chapter-based generation', async t => {
  const calls = generatorTransport(t, () => Response.json({ items: [
    { title: 'Primero', passage: 'Generated first passage.' },
    { title: 'Segundo', passage: 'Generated second passage.' }
  ] }));
  const controller = new AbortController();
  for (const chapter of [undefined, { ...context.chapter, number: 2 }]) {
    const result = await generators.generateReading('pluscuamperfecto', 2, { ...context, chapter, signal: controller.signal });
    const request = calls.at(-1);
    assert.equal(request.body.jsonSchema.properties.items.minItems, 2);
    assert.equal(request.body.jsonSchema.properties.items.maxItems, 2);
    assert.equal(request.body.metadata.count, 2);
    assert.equal(request.signal, controller.signal);
    assert.match(request.body.user, /Create exactly 2 /);
    assert.equal(result.items.length, 2);
    if (chapter) assert.ok(result.items.every(item => item.passage === chapter.passage && item.base_text_info.chapter_number === 2));
  }
  assert.equal(calls.length, 2, 'each full reading batch needs only one request');
});

test('reading rejects a partial batch and preserves provider errors without fallback', async t => {
  let failure = false;
  const calls = generatorTransport(t, () => failure
    ? Response.json({ details: 'Inference timed out.', code: 'inference_timeout' }, { status: 504 })
    : Response.json({ items: [{ title: 'Only one', passage: 'Partial batch.' }] }));
  await assert.rejects(generators.generateReading('pluscuamperfecto', 2, context), /2 complete reading sets/);
  failure = true;
  await assert.rejects(generators.generateReading('pluscuamperfecto', 2, { ...context, chapter: undefined }), { status: 504, code: 'inference_timeout' });
  assert.equal(calls.length, 2);
});

const errorBundle = { sentences: [
  { text: 'Ana había llegado.', correct: true, rationale: 'Anterioridad.', fix: '' },
  { text: 'Ana habían llegado.', correct: false, rationale: 'Concordancia.', fix: 'Ana había llegado.' },
  { text: 'Ana había llegar.', correct: false, rationale: 'Participio.', fix: 'Ana había llegado.' },
  { text: 'Ana habido llegado.', correct: false, rationale: 'Auxiliar.', fix: 'Ana había llegado.' }
] };

test('one error bundle uses chapter.passage, exact count and cancellation', async t => {
  const calls = generatorTransport(t, () => Response.json({ items: [errorBundle] }));
  const controller = new AbortController();
  const result = await generators.generateErrorBundles('pluscuamperfecto', 1, { ...context, chapter: { ...context.chapter, content: 'Wrong obsolete field.' }, signal: controller.signal });
  assert.equal(result.items.length, 1);
  assert.equal(generators.validateExerciseItem('errorBundle', result.items[0]).correct, 1);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(JSON.parse(request.body.user).baseText.chapter.passage, context.chapter.passage);
  assert.equal(request.body.jsonSchema.properties.items.minItems, 1);
  assert.equal(request.body.jsonSchema.properties.items.maxItems, 1);
  assert.equal(request.signal, controller.signal);
});

test('error bundles reject multiple correct answers and missing corrections', async t => {
  let item = structuredClone(errorBundle);
  const calls = generatorTransport(t, () => Response.json({ items: [item] }));
  item.sentences[1].correct = true;
  await assert.rejects(generators.generateErrorBundles('pluscuamperfecto', 1, context), /one correct answer/);
  item = structuredClone(errorBundle);
  item.sentences[1].fix = '';
  await assert.rejects(generators.generateErrorBundles('pluscuamperfecto', 1, context), /complete error bundles/);
  assert.equal(calls.length, 2);
});

test('error bundles reject duplicate sentences even when only spacing, case or Unicode composition differs', async t => {
  let item;
  const calls = generatorTransport(t, () => Response.json({ items: [item] }));
  for (const duplicate of [errorBundle.sentences[0].text, '  ANA   HABI\u0301A llegado.  ']) {
    item = structuredClone(errorBundle);
    item.sentences[1].text = duplicate;
    await assert.rejects(generators.generateErrorBundles('pluscuamperfecto', 1, context), /complete error bundles/);
  }
  assert.equal(calls.length, 2, 'invalid choices must not cause an automatic paid retry');
});
