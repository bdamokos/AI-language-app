import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Execute the real nested PDF document in a killable process. Only the temporary
// bundle gets a capture callback, following scripts/pdf-acceptance.mjs; the
// shipped parser and PDF element construction are used without substitution.
const probe = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const sourcePath = join(process.cwd(), 'src/components/PDFExport.jsx');
const source = await readFile(sourcePath, 'utf8');
const temporary = process.argv[1];
globalThis.window = { globalImageStore: {} };
const signature = 'export default function PDFExport({ lesson, orchestratorValues, strictAccents = true })';
const marker = '  const generatePDF = async () => {';
assert.equal(source.split(signature).length, 2);
assert.equal(source.split(marker).length, 2);
await build({
  stdin: {
    contents: source.replace(signature,
      'export default function PDFExport({ lesson, orchestratorValues, strictAccents = true, captureDocument })')
      .replace(marker, '  captureDocument(<PDFDocument />);\n' + marker),
    loader: 'jsx', resolveDir: dirname(sourcePath)
  },
  outfile: join(temporary, 'pdf-export.mjs'), bundle: true,
  platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent'
});
const { default: PDFExport } = await import(pathToFileURL(join(temporary, 'pdf-export.mjs')));
function findTable(node) {
  if (Array.isArray(node)) return node.map(findTable).find(Boolean);
  if (!React.isValidElement(node)) return undefined;
  if (node.key?.startsWith('table-')) return node;
  return findTable(node.props.children);
}
function text(node) {
  if (Array.isArray(node)) return node.flatMap(text);
  if (typeof node === 'string') return [node];
  return React.isValidElement(node) ? text(node.props.children) : [];
}
function parse(markdown) {
  let document;
  renderToStaticMarkup(React.createElement(PDFExport, {
    lesson: { explanation: { content_markdown: markdown } }, orchestratorValues: {},
    captureDocument: value => { document = value; }
  }));
  const table = findTable(document.type());
  assert.ok(table, 'The actual PDF document must contain a table');
  return text(table);
}
// A preceding paragraph keeps the payload internal even if callers trim the
// whole document. Cover whitespace encodings and optional-pipe/colon misses.
const start = performance.now();
for (const [whitespace, lead] of [[' ', ''], ['\t', ''], ['\u00a0', ''], [' ', '|'], [' ', ':'], ['\u2003', '|']]) {
  assert.deepEqual(parse('Introduction\n| Uno | Dos |\n' + whitespace.repeat(64000) + lead + 'left|right|'),
    ['Uno', 'Dos', lead === ':' ? ':left' : 'left', 'right']);
}
console.log(JSON.stringify({ craftedRows: 6, prefixLength: 64000, parserMilliseconds: performance.now() - start }));
// Preserve the current prefix-based delimiter behavior, including a single
// dash, alignment colons, optional outer pipes, and mixed delimiter/data rows.
assert.deepEqual(parse([
  'Introduction', '| Uno | Dos |',
  '  | :--- | ---: |', '\t:-: | - |', '\u00a0| - | later data |',
  '| first | |', '| ordinary text | --- |', 'last | value |'
].join('\n')), ['Uno', 'Dos', 'first', '', 'ordinary text', '---', 'last', 'value']);
`;

test('PDF table parser bounds whitespace near misses and preserves table cells', t => {
  const cache = join(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const temporary = mkdtempSync(join(cache, 'pdf-table-security-'));
  // Parent cleanup also runs after SIGKILL interrupts synchronous parser work.
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe, temporary], {
    cwd: root, encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL'
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"craftedRows":6/);
  t.diagnostic(result.stdout.trim());
});
