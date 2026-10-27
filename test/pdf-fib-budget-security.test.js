import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const self = fileURLToPath(import.meta.url);

async function checkSharedDocument() {
  await mkdir(join(root, 'node_modules/.cache'), { recursive: true });
  const temporary = await mkdtemp(join(root, 'node_modules/.cache/fib-budget-'));
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const oldWindow = globalThis.window;
  globalThis.window = { globalImageStore: {} };
  try {
    const sourcePath = join(root, 'src/components/PDFExport.jsx');
    const source = await readFile(sourcePath, 'utf8');
    const signature = 'export default function PDFExport({ lesson, orchestratorValues, strictAccents = true })';
    const marker = '  const generatePDF = async () => {';
    assert.equal(source.split(signature).length, 2);
    assert.equal(source.split(marker).length, 2);
    // Capture the actual nested document, using the acceptance CLI's approach.
    await build({
      stdin: { contents: source.replace(signature,
        'export default function PDFExport({ lesson, orchestratorValues, strictAccents = true, captureDocument })')
        .replace(marker, '  captureDocument(<PDFDocument />);\n' + marker),
      loader: 'jsx', resolveDir: dirname(sourcePath) },
      outfile: join(temporary, 'export.mjs'), bundle: true, platform: 'node',
      format: 'esm', packages: 'external', logLevel: 'warning'
    });
    const { default: PDFExport } = await import(pathToFileURL(join(temporary, 'export.mjs')).href);
    const documentFor = items => {
      let document;
      renderToStaticMarkup(React.createElement(PDFExport, {
        lesson: { fill_in_blanks: items }, orchestratorValues: {},
        captureDocument: value => { document = value; }
      }));
      assert.ok(document);
      return document;
    };
    const item = (answer = 'había llegado') => ({ sentence: 'Antes, _____.', answers: [answer] });
    let rejected = 0;
    const rejectsBeforeAllocation = (items, message) => {
      // Capture first: validation must happen when exporting, not when the UI
      // merely displays the PDF button. Then observe real document construction.
      const document = documentFor(items);
      const repeat = String.prototype.repeat, createElement = React.createElement;
      let underlines = 0, nodes = 0;
      String.prototype.repeat = function (count) {
        if (String(this) === '_') underlines++;
        return repeat.call(this, count);
      };
      React.createElement = (...args) => { nodes++; return createElement(...args); };
      try { assert.throws(() => document.type(), message); }
      finally { String.prototype.repeat = repeat; React.createElement = createElement; }
      assert.equal(underlines, 0, 'Reject before proportional blank allocation');
      assert.equal(nodes, 0, 'Reject the whole lesson before PDF-node allocation');
      rejected++;
    };
    const valid = items => documentFor(items).type();
    for (const answers of [undefined, [], ['one'], ['one', 'two', 'extra'],
      ['one', ''], ['one', '  \n'], ['one', null], ['one', 42], 'one', ['one', {}]]) {
      rejectsBeforeAllocation([{ sentence: '_____ y _____', answers }], /Cannot export FIB/);
    }
    rejectsBeforeAllocation([{ sentence: Array(100).fill('_____').join(' '), answers: ['x'.repeat(2000)] }], /one answer per blank/);
    rejectsBeforeAllocation([{ sentence: Array(128).fill('_____').join(' '), answers: ['x'.repeat(4096)] }], /one answer per blank/);
    for (const sentence of ['', 'plain sentence', '____', null, 23]) {
      rejectsBeforeAllocation([{ sentence, answers: ['one'] }], /Cannot export FIB/);
    }
    rejectsBeforeAllocation([null], /Cannot export FIB/);
    rejectsBeforeAllocation({}, /Cannot export FIB/);
    for (const length of [5, 6, 10, 11, 16384]) {
      valid([{ sentence: '_'.repeat(length), answers: ['one'] }]);
    }
    rejectsBeforeAllocation([{ sentence: '_'.repeat(10), answers: ['one', 'two'] }], /one answer per blank/);
    valid([{ sentence: 'a'.repeat(16379) + '_____', answers: ['one'] }]);
    rejectsBeforeAllocation([{ sentence: 'a'.repeat(16380) + '_____', answers: ['one'] }], /sentence/);
    valid([item('x'.repeat(4096))]);
    rejectsBeforeAllocation([item('x'.repeat(4097))], /answers/);
    rejectsBeforeAllocation([item(' '.repeat(4096) + 'x')], /answers/);
    valid([{ sentence: Array(128).fill('_____').join(' '), answers: Array(128).fill('one') }]);
    rejectsBeforeAllocation([{ sentence: Array(129).fill('_____').join(' '), answers: Array(129).fill('one') }], /blanks/);
    valid(Array.from({ length: 256 }, () => item()));
    rejectsBeforeAllocation(Array.from({ length: 257 }, () => item()), /at most 256/);
    const manyBlanks = { sentence: Array(128).fill('_____').join(' '), answers: Array(128).fill('a') };
    valid(Array(16).fill(manyBlanks)); // Exactly 2048 blanks.
    rejectsBeforeAllocation([...Array(16).fill(manyBlanks), item()], /expansion budget/);
    rejectsBeforeAllocation([item(), { ...manyBlanks, answers: Array(128).fill('x'.repeat(4096)) }], /expansion budget/);
    // Individually valid items must also share the same cumulative budget.
    rejectsBeforeAllocation(Array.from({ length: 17 }, () => item('x'.repeat(4096))), /expansion budget/);
    // Each 4096-character answer projects to 11980 wrapped underscores plus
    // 4098 solution/spacing characters. Sixteen five-underscore sentences add
    // 160 more characters; 2368 literal characters reach exactly 262144.
    const atBudget = Array.from({ length: 16 }, () => ({ sentence: '_____', answers: ['x'.repeat(4096)] }));
    atBudget[0].sentence = 'a'.repeat(2368) + '_____';
    valid(atBudget);
    rejectsBeforeAllocation([{ ...atBudget[0], sentence: 'a' + atBudget[0].sentence }, ...atBudget.slice(1)], /expansion budget/);
    // Forced lines have a separate page-height cost even below the text budget.
    for (const lineBreak of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      valid([{ sentence: lineBreak.repeat(128) + '_____', answers: ['a'] }]);
      rejectsBeforeAllocation([{ sentence: lineBreak.repeat(129) + '_____', answers: ['a'] }], /line-break budget/);
      rejectsBeforeAllocation([{ sentence: '_____', answers: ['a' + lineBreak.repeat(257)] }], /line-break budget/);
    }
    valid([{ sentence: '\n'.repeat(127) + '_____', answers: ['a\n\n'] }]);
    rejectsBeforeAllocation([{ sentence: '\n'.repeat(127) + '_____', answers: ['a\n\n\n'] }], /line-break budget/);
    rejectsBeforeAllocation(Array(2).fill({ sentence: '\n'.repeat(65) + '_____', answers: ['a'] }), /line-break budget/);
    rejectsBeforeAllocation([{ sentence: '\n'.repeat(16000) + '_____', answers: ['a'] }], /line-break budget/);
    rejectsBeforeAllocation([item(), { sentence: '_____ y _____', answers: ['one'] }], /one answer per blank/);
    const first = 'Ana ya había terminado los preparativos antes de que llegaran sus compañeros. '.repeat(4);
    const second = 'Sus compañeros ya habían llegado.';
    const tree = valid([{ sentence: 'Antes, _____ y _____.', answers: [first, second] }]);
    const strings = [];
    const visit = value => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (React.isValidElement(value)) visit(value.props.children);
    };
    visit(tree);
    assert.equal(strings.filter(value => value === first).length, 1, 'Full first solution is retained once');
    assert.equal(strings.filter(value => value === second).length, 1, 'Distinct second solution is retained once');
    console.log(JSON.stringify({ rejectedBeforeAllocation: rejected, completeLongAnswerCharacters: first.length }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (hadWindow) globalThis.window = oldWindow;
    else delete globalThis.window;
  }
}

if (process.argv.includes('--fib-budget-worker')) {
  await checkSharedDocument();
} else {
  test('FIB shared PDF path rejects malformed and over-budget lessons before allocation', { timeout: 20000 }, () => {
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', self, '--fib-budget-worker'], {
      cwd: root, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /rejectedBeforeAllocation/);
  });

  test('saved FIB CLI explicitly rejects missing answers and preserves complete long solutions', { timeout: 30000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'fib-budget-cli-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const input = join(temporary, 'input'), output = join(temporary, 'output');
    await mkdir(input);
    const run = () => spawnSync(process.execPath, ['scripts/pdf-acceptance.mjs', input, output, '--allow-partial'], {
      cwd: root, encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
    });
    await writeFile(join(input, 'fib.json'), JSON.stringify({ items: [
      { sentence: Array(100).fill('_____').join(' '), answers: ['x'.repeat(2000)] }
    ] }));
    const invalid = run();
    assert.ifError(invalid.error);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Cannot export FIB item 1: expected exactly one answer per blank/);
    await writeFile(join(input, 'fib.json'), JSON.stringify({ items: [
      { sentence: '\n'.repeat(16000) + '_____', answers: ['a'] }
    ] }));
    const forcedLines = run();
    assert.ifError(forcedLines.error);
    assert.notEqual(forcedLines.status, 0);
    assert.match(forcedLines.stderr, /Cannot export FIB item 1: lesson exceeds the FIB PDF line-break budget/);
    const poppler = spawnSync('pdftotext', ['-v'], { encoding: 'utf8', timeout: 5000 });
    if (poppler.error?.code === 'ENOENT') { t.diagnostic('Full PDF text check requires Poppler'); return; }
    assert.ifError(poppler.error);
    assert.equal(poppler.status, 0, poppler.stderr);
    const answers = [
      'Ana ya había terminado los preparativos antes de que llegaran sus compañeros. '.repeat(4),
      'Sus compañeros ya habían llegado.'
    ];
    await writeFile(join(input, 'fib.json'), JSON.stringify({ items: [{ sentence: 'Antes, __________ y _____.', answers }] }));
    const legitimate = run();
    assert.ifError(legitimate.error);
    assert.equal(legitimate.status, 0, legitimate.stderr);
    const report = JSON.parse(await readFile(join(output, 'pdf-report.json'), 'utf8'));
    assert.deepEqual(report.textOverflow, []);
    const text = (await readFile(join(output, 'language-practice-acceptance.txt'), 'utf8')).replace(/-\s*\n\s*/g, '').replace(/\s+/g, '');
    for (const answer of answers) assert.ok(text.includes(answer.replace(/\s+/g, '')), 'Full FIB solution survives PDF layout');
  });
}
