import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasPoppler = !spawnSync('pdftotext', ['-v']).error;

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
