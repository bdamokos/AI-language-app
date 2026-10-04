import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const poppler = spawnSync('pdftotext', ['-v'], { encoding: 'utf8', timeout: 5000 });
if (poppler.error && poppler.error.code !== 'ENOENT') throw poppler.error;
const hasPoppler = poppler.error?.code !== 'ENOENT';
if (hasPoppler && poppler.status !== 0) {
  throw new Error(`pdftotext version check failed (status ${poppler.status}, signal ${poppler.signal}): ${poppler.stderr}`);
}

test('PDF preserves table rows and full solutions while fitting long answer spaces', {
  skip: hasPoppler ? false : 'PDF integration requires Poppler pdftotext',
  timeout: 65000
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'language-pdf-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = join(temporary, 'input'), output = join(temporary, 'output');
  await mkdir(input);
  const sentence = 'Ana ya había terminado los preparativos antes de que llegaran sus compañeros. ';
  const files = {
    explanation: { title: 'Práctica', content_markdown:
      `| Uno | Dos | Tres | Cuatro |\n| --- | --- | --- | --- |\n| Primera fila | | Tercera columna | Final |\n| ${Array(4).fill('_'.repeat(80)).join(' | ')} |` },
    fib: { items: [{ sentence: 'Antes de llegar, _____ .', answers: [sentence.repeat(4)] }] },
    dialogue: { items: [{ studentInstructions: 'Completa el diálogo.', conversationContext: 'Preparativos.',
      suggested_hide_speaker: 'Luis', turns: Array.from({ length: 6 }, (_, index) => ({
        speaker: index % 2 ? 'Luis' : 'Ana', text: index === 3 ? sentence.repeat(5) : sentence.trim(), hint: 'Usa el pluscuamperfecto.'
      })) }] },
    rewriting: { items: [{ original: 'Ana terminó los preparativos.', instruction: 'Usa el pluscuamperfecto.', answer: sentence.repeat(6) }] }
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(input, `${name}.json`), JSON.stringify(value));
  execFileSync(process.execPath, ['scripts/pdf-acceptance.mjs', input, output, '--allow-partial'], {
    cwd: root, timeout: 60000, killSignal: 'SIGKILL', stdio: 'pipe'
  });
  const report = JSON.parse(await readFile(join(output, 'pdf-report.json'), 'utf8'));
  assert.deepEqual(report.textOverflow, []);
  assert.ok(report.pages >= 3 && report.pages < 20, 'Long answers should paginate within a finite document');
  const text = await readFile(join(output, 'language-practice-acceptance.txt'), 'utf8');
  assert.match(text, /Primera fila/);
  assert.match(text, /Tercera columna/);
});

test('PDF paginates padded context text without crossing the bottom margin', {
  skip: hasPoppler ? false : 'PDF integration requires Poppler pdftotext',
  timeout: 65000
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'language-pdf-context-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = join(temporary, 'input'), output = join(temporary, 'output');
  await mkdir(input);
  // Eight saved educational items place the final context at a page break.
  // The original padded Text put its baseline inside the bottom page margin.
  const fixture = await readFile(join(root, 'test-support/pdf-context-page-break.json'), 'utf8');
  await writeFile(join(input, 'fib.json'), fixture);
  execFileSync(process.execPath, ['scripts/pdf-acceptance.mjs', input, output, '--allow-partial'], {
    cwd: root, timeout: 60000, killSignal: 'SIGKILL', stdio: 'pipe'
  });
  const report = JSON.parse(await readFile(join(output, 'pdf-report.json'), 'utf8'));
  assert.deepEqual(report.textOverflow, []);
  assert.ok(report.pages >= 3 && report.pages < 8, 'The context should paginate within a finite document');
  const text = await readFile(join(output, 'language-practice-acceptance.txt'), 'utf8');
  assert.ok(text.includes(JSON.parse(fixture).items.at(-1).context), 'The final context must remain visible');
});
