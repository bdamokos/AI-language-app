// Render the app's actual nested PDF document from saved educational outputs.
// Usage: node scripts/pdf-acceptance.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY
// Add --allow-partial only for a diagnostic document with incomplete coverage.
// This checks PDF generation, content and links; it does not test browser download.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pdf } from '@react-pdf/renderer';
import { PDFDocument } from 'pdf-lib';

const [inputArgument, outputArgument, ...flags] = process.argv.slice(2);
assert.ok(inputArgument && outputArgument, 'Provide input and output directories');
assert.ok(flags.every(flag => flag === '--allow-partial'), 'Unsupported argument');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputDirectory = resolve(inputArgument), outputDirectory = resolve(outputArgument);
const types = [
  ['fib', 'fill_in_blanks', 'Fill in the Blanks'],
  ['mcq', 'multiple_choice', 'Multiple Choice'],
  ['cloze', 'cloze_passages', 'Cloze Passages'],
  ['clozeMixed', 'cloze_with_mixed_options', 'Cloze (Mixed Options)'],
  ['dialogue', 'guided_dialogues', 'Guided Dialogues'],
  ['writing', 'writing_prompts', 'Writing Prompts'],
  ['reading', 'reading_comprehension', 'Reading Comprehension'],
  ['errorBundle', 'error_bundles', 'Error Bundles'],
  ['rewriting', 'rewriting', 'Sentence Rewriting']
];
async function readOutput(name) {
  try { return JSON.parse(await readFile(join(inputDirectory, `${name}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const lesson = { topic: 'pluscuamperfecto', language: 'Spanish', level: 'B1' };
lesson.explanation = await readOutput('explanationStream') || await readOutput('explanation');
const included = [], missing = [];
for (const [type, key, heading] of types) {
  const value = await readOutput(type);
  if (!Array.isArray(value?.items) || value.items.length === 0) { missing.push(type); continue; }
  // Match the UI's creation ordering without modifying saved source outputs.
  lesson[key] = value.items.map((item, index) => ({ ...item, createdAt: included.length * 1000 + index + 1 }));
  included.push({ type, key, heading, count: value.items.length });
}
if (!lesson.explanation) missing.push('explanation');
assert.ok(included.length > 0, 'No generated exercises were found');
if (!flags.includes('--allow-partial')) assert.equal(missing.length, 0, `Missing generated outputs: ${missing.join(', ')}`);

await mkdir(outputDirectory, { recursive: true });
await mkdir(join(root, 'node_modules/.cache'), { recursive: true });
const temporary = await mkdtemp(join(root, 'node_modules/.cache/pdf-acceptance-'));
const sourcePath = join(root, 'src/components/PDFExport.jsx');
const source = await readFile(sourcePath, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const oldWindow = globalThis.window;
const hadWindow = Object.hasOwn(globalThis, 'window');
globalThis.window = { globalImageStore: {} };
try {
  await build({
    entryPoints: [sourcePath], outfile: join(temporary, 'pdf-export.mjs'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
    plugins: [{
      name: 'capture-existing-document', setup(builder) {
        builder.onLoad({ filter: /PDFExport\.jsx$/ }, () => {
          const signature = 'export default function PDFExport({ lesson, orchestratorValues, strictAccents = true })';
          const marker = '  const generatePDF = async () => {';
          assert.equal(source.split(signature).length, 2, 'PDFExport signature changed; review instrumentation');
          assert.equal(source.split(marker).length, 2, 'PDFExport handler changed; review instrumentation');
          // Only the temporary test bundle gains a document callback. The actual
          // document, helper functions, and shipped source remain unchanged.
          const contents = source.replace(signature,
            'export default function PDFExport({ lesson, orchestratorValues, strictAccents = true, captureDocument })')
            .replace(marker, '  captureDocument(<PDFDocument />);\n' + marker);
          return { contents, loader: 'jsx', resolveDir: dirname(sourcePath) };
        });
      }
    }]
  });
  const { default: PDFExport } = await import(pathToFileURL(join(temporary, 'pdf-export.mjs')).href);
  let document;
  renderToStaticMarkup(React.createElement(PDFExport, {
    lesson, orchestratorValues: {}, strictAccents: true,
    captureDocument: value => { document = value; }
  }));
  assert.ok(document, 'The existing PDF document was not captured');
  const blob = await pdf(document).toBlob();
  const bytes = Buffer.from(await blob.arrayBuffer());
  const pdfPath = join(outputDirectory, 'language-practice-acceptance.pdf');
  await writeFile(pdfPath, bytes);
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() >= 2, 'Exercises and solutions should be present');
  const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(outputDirectory, 'language-practice-acceptance.txt'), text);
  for (const heading of ['Language Practice Lesson', 'Solutions and Answers', ...included.map(entry => entry.heading)]) {
    assert.ok(text.includes(heading), `PDF is missing section: ${heading}`);
  }
  assert.ok(!text.includes('\uFFFD'), 'PDF contains undecodable replacement characters');
  const report = {
    pdfPath, sourceHash, pages: loaded.getPageCount(), bytes: bytes.length,
    included, missing, textCharacters: text.length,
    scope: 'Actual PDF document rendered offline; browser download and image loading are not exercised.'
  };
  await writeFile(join(outputDirectory, 'pdf-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (hadWindow) globalThis.window = oldWindow;
  else delete globalThis.window;
}
