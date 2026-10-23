import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Address6 } from 'ip-address';
import { ipKeyGenerator } from 'express-rate-limit';
import { createServer, isFileServingAllowed } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));

// GHSA-rxp7-6hxx-x8q5: isolate the synchronous parser so an affected
// dependency fails within a bounded time instead of blocking the test runner.
test('IPv6 zone parsing handles long malformed inputs without stalling', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { Address6 } from 'ip-address';
    for (const ending of ['\\n', '\\r', '\\u2028', '\\u2029', '\\ntrailer']) {
      assert.equal(Address6.isValid('::1%' + '%'.repeat(256 * 1024) + ending), false);
    }
  `], { cwd: root, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('IPv6 scoped addresses and rate-limit subnet keys remain compatible', () => {
  const address = new Address6('fe80::1%en0');
  assert.equal(address.zone, '%en0');
  assert.equal(address.correctForm(), 'fe80::1');
  assert.equal(ipKeyGenerator('fe80::1%en0'), 'fe80::/56');
  assert.equal(ipKeyGenerator('2001:db8:1234:5678::1'), '2001:db8:1234:5600::/56');
  assert.equal(ipKeyGenerator('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(ipKeyGenerator('192.0.2.1'), '192.0.2.1');
});

async function viteFixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'language-vite-advisory-')));
  const project = path.join(directory, 'project');
  await fs.mkdir(project);
  let server;
  t.after(async () => {
    try { await server?.close(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  server = await createServer({
    root: project, configFile: false, envFile: false, logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null, preTransformRequests: false, fs: { allow: [project] } },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return { directory, project, server };
}

// GHSA-rq7h-c2jc-7f22 applies to non-Windows dev servers. No network listener
// or real system file is needed to exercise import analysis and its allow-list.
test('Vite imports cannot authorize a colliding file outside the project', { skip: process.platform === 'win32' }, async t => {
  const { directory, project, server } = await viteFixture(t);
  const outside = path.join(directory, 'outside.js');
  const decoy = path.join(project, outside.slice(1));
  await fs.mkdir(path.dirname(decoy), { recursive: true });
  await fs.writeFile(outside, 'export default "outside";');
  await fs.writeFile(decoy, 'export default "project";');
  await fs.writeFile(path.join(project, 'main.js'), `import value from ${JSON.stringify('./' + outside.slice(1))}; console.log(value);`);
  assert.equal(isFileServingAllowed('/@fs' + outside, server), false);
  const transformed = await server.transformRequest('/main.js');
  assert.ok(transformed.code.includes(outside), 'the colliding project import must be analyzed');
  assert.equal(isFileServingAllowed('/@fs' + outside, server), false);
  assert.equal(isFileServingAllowed('/@fs' + decoy, server), true);
});

// GHSA-9jrq-w75r-8gcw: test the optional custom transform boundary without
// navigating to or requesting the attacker's origin.
test('Vite custom HTML transforms keep inline module URLs on the local origin', async t => {
  const { project, server } = await viteFixture(t);
  await fs.writeFile(path.join(project, 'package.json'), '{}');
  const html = await server.transformIndexHtml('//evil.example/payload.js?/../../package.json', '<script type="module">console.log("safe");</script>');
  assert.doesNotMatch(html, /src=["']\/\/evil\.example\//);
  const ordinary = await server.transformIndexHtml('/index.html', '<script type="module">console.log("safe");</script>');
  assert.match(ordinary, /type="module"/);
  assert.doesNotMatch(ordinary, /evil\.example/);
});
