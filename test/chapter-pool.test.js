import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createChapterPool } from '../src/utils/chapterPool.js';

const context = { topic: 'pluscuamperfect', language: 'Spanish', level: 'B1', challengeMode: false };
const source = { id: 'source', chapters: [{ passage: 'First' }, { passage: 'Second' }] };
test('a failed inference neither consumes its chapter nor replays paid work', async () => {
  let fetches = 0, calls = 0;
  const pool = createChapterPool(async () => { fetches++; return source; });
  await assert.rejects(pool.run({ context, count: 1, generate: async () => { calls++; throw new Error('usage limit'); } }), /usage limit/);
  assert.equal(calls, 1);
  const result = await pool.run({ context, count: 1, generate: async (_, ctx) => ({ items: [ctx.chapter.passage] }) });
  assert.deepEqual(result.items, ['First']);
  assert.equal(fetches, 1);
});
test('concurrent buttons share one base text and distinct chapters', async () => {
  let fetches = 0;
  const pool = createChapterPool(async () => { fetches++; return source; });
  const generate = async (_, ctx) => ({ items: [ctx.chapter.passage] });
  const results = await Promise.all([pool.run({ context, count: 1, generate }), pool.run({ context, count: 1, generate })]);
  assert.deepEqual(results.map(result => result.items[0]), ['First', 'Second']);
  assert.equal(fetches, 1);
});
test('multi-chapter counts exclude exhausted sources and reject short output', async () => {
  const exclusions = [];
  const pool = createChapterPool(async options => { exclusions.push(options.excludeIds); return { ...source, id: `source${exclusions.length}` }; });
  const generate = async (count, ctx) => ({ items: Array.from({ length: count }, () => ctx.chapter.passage) });
  assert.equal((await pool.run({ context, count: 5, batchSize: 2, generate })).items.length, 5);
  assert.deepEqual(exclusions, [[], ['source1']]);
  await assert.rejects(pool.run({ context, count: 2, batchSize: 2, generate: async () => ({ items: [] }) }), /Expected 2/);
});
test('reset invalidates queued and in-flight work before using the new lesson', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const pool = createChapterPool(async () => source);
  const first = pool.run({ context, count: 1, generate: async () => { await pending; return { items: ['old'] }; } });
  await new Promise(resolve => setImmediate(resolve));
  const queued = pool.run({ context, count: 1, generate: async () => { throw new Error('must not run'); } });
  pool.reset(); finish();
  await assert.rejects(first, /lesson changed/);
  await assert.rejects(queued, /lesson changed/);
  const next = await pool.run({ context, count: 1, generate: async (_, ctx) => ({ items: [ctx.chapter.passage] }) });
  assert.deepEqual(next.items, ['First']);
});

test('invalid counts cannot start paid work and reset aborts the request signal', async () => {
  let fetches = 0, activeSignal;
  const pool = createChapterPool(async () => { fetches++; return source; });
  await assert.rejects(pool.run({ context, count: 1.5, generate: () => {} }), /whole number/);
  assert.equal(fetches, 0);
  const pending = pool.run({ context, count: 1, generate: async (_, ctx) => {
    activeSignal = ctx.signal;
    return new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await new Promise(resolve => setImmediate(resolve));
  pool.reset();
  assert.equal(activeSignal.aborted, true);
  await assert.rejects(pending, /aborted/);
});

test('reset starts a new lesson immediately and late old results cannot consume its chapters', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const pool = createChapterPool(async () => source);
  const oldSignal = pool.signal;
  const old = pool.run({ context, count: 1, generate: async () => { await held; return { items: ['old'] }; } });
  const rejected = assert.rejects(old, /lesson changed/);
  await new Promise(resolve => setImmediate(resolve));
  pool.reset();
  assert.equal(oldSignal.aborted, true);
  const currentSignal = pool.signal;
  const generate = async (_, ctx) => ({ items: [ctx.chapter.passage] });
  assert.deepEqual((await pool.run({ context, count: 1, generate })).items, ['First']);
  release(); await rejected;
  assert.equal(currentSignal.aborted, false);
  assert.deepEqual((await pool.run({ context, count: 1, generate })).items, ['Second']);
});

test('a later batch failure returns completed items for display and retains the failed chapter for retry', async () => {
  const pool = createChapterPool(async () => source);
  let calls = 0;
  await assert.rejects(pool.run({ context, count: 2, generate: async (_, ctx) => {
    if (++calls === 2) throw new Error('Usage limit reached');
    return { items: [{ text: ctx.chapter.passage }] };
  } }), error => {
    assert.equal(error.message, 'Usage limit reached');
    assert.deepEqual(error.partialItems, [{ text: 'First' }]);
    return true;
  });
  assert.equal(calls, 2, 'a failed batch is never retried automatically');
  const next = await pool.run({ context, count: 1, generate: async (_, ctx) => ({ items: [{ text: ctx.chapter.passage }] }) });
  assert.deepEqual(next.items, [{ text: 'Second' }]);
});

test('reset never exposes completed batches from the old lesson as partial new-lesson content', async () => {
  const pool = createChapterPool(async () => source);
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const old = pool.run({ context, count: 2, generate: async () => {
    if (++calls === 2) await held;
    return { items: ['old'] };
  } });
  const rejected = assert.rejects(old, error => { assert.equal(error.partialItems, undefined); return /lesson changed/.test(error.message); });
  await new Promise(resolve => setImmediate(resolve));
  pool.reset(); release(); await rejected;
});

test('chapter contexts carry their real one-based number without mutating cached source data', async () => {
  const pool = createChapterPool(async () => source);
  const result = await pool.run({ context, count: 2, generate: async (_, ctx) => ({ items: [{ number: ctx.chapter.number, index: ctx.chapter.index, passage: ctx.chapter.passage }] }) });
  assert.deepEqual(result.items, [{ number: 1, index: 0, passage: 'First' }, { number: 2, index: 1, passage: 'Second' }]);
  assert.equal(source.chapters[0].number, undefined);
});

test('recommendations include the same reading, rewriting and error-bundle mistakes that Check Answers scores', async () => {
  // Tree-shake the UI and import the real diagnostic collector and item scorers.
  const resolveDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = await build({
    stdin: { contents: "export { collectWrongExercises } from './src/AIPracticeApp.jsx';", resolveDir },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'diagnostic-test-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => args.path.startsWith('.')
        ? { path: path.resolve(args.resolveDir, args.path), sideEffects: false }
        : { path: args.path, external: true, sideEffects: false });
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { collectWrongExercises } = module.exports;
  const sentences = [{ text: 'Correct', correct: true }, { text: 'Wrong A', correct: false, fix: 'First correction' }, { text: 'Wrong B', correct: false, fix: 'Second correction' }];
  const lesson = { reading_comprehension: [{ true_false: [{ answer: true }] }], rewriting: [{ answer: 'había llegado' }], error_bundles: [{ sentences }, { sentences }] };
  const wrongValues = { 'lesson:reading:0': { 'tf:0': false }, 'lesson:rewrite:0': 'wrong', 'lesson:error:0': 1, 'lesson:error:1': 'wrong' };
  const wrong = collectWrongExercises(lesson, wrongValues);
  assert.deepEqual(wrong.map(({ type, index }) => [type, index]), [['reading', 0], ['rewrite', 0], ['error', 0], ['error', 1]]);
  assert.deepEqual(wrong.map(item => item.userAnswer), [{ 'tf:0': false }, 'wrong', 1, 'wrong']);
  const correctValues = { 'lesson:reading:0': { 'tf:0': true }, 'lesson:rewrite:0': 'había llegado', 'lesson:error:0': 0, 'lesson:error:1': 'Second correction' };
  assert.deepEqual(collectWrongExercises(lesson, correctValues), [], 'correction mode must use the same stable item-index seed');
});
