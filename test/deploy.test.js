import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posixOnly = { skip: process.platform === 'win32' ? 'Deployment uses POSIX shells and permissions' : false };

async function deployment(t, existing = false, failTransfer = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'language-deploy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), remote = path.join(dir, 'remote');
  await fs.mkdir(bin);
  await fs.copyFile(path.join(root, 'deploy.sh'), path.join(dir, 'deploy.sh'));
  await fs.copyFile(path.join(root, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  await fs.writeFile(path.join(dir, '.env'), [
    'REMOTE_HOST=fixture.invalid', 'REMOTE_USER=fixture', 'DEPLOY_PATH=' + remote,
    'REGISTRY_HOST=registry.invalid', 'OPENAI_CLIENT_SECRET=synthetic-client-secret',
    'CACHE_HOST_DIR=' + path.join(dir, 'data'), ''
  ].join('\n'), { mode: 0o644 });
  if (existing) {
    await fs.mkdir(remote, { mode: 0o755 });
    await fs.writeFile(path.join(remote, '.env'), 'previous configuration', { mode: 0o644 });
  }
  const shim = async (name, source) => fs.writeFile(path.join(bin, name), source, { mode: 0o755 });
  await shim('security', '#!/bin/sh\nprintf "synthetic-password\\n"\n');
  await shim('sshpass', '#!/bin/sh\nshift 2\nexec "$@"\n');
  await shim('ssh', '#!/bin/bash\nset -e\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nif [ "$1" = bash ]; then cat >/dev/null; exit 0; fi\nbash -c "$*"\n');
  await shim('scp', '#!' + process.execPath + '\n' + [
    "const fs = require('node:fs'), path = require('node:path');",
    'const args = process.argv.slice(2);',
    "while (args[0] === '-o') args.splice(0, 2);",
    "const dest = args.pop().split(':').slice(1).join(':');",
    'for (const source of args) {',
    "  if (path.basename(source) === '.env') {",
    "    if ((fs.statSync(dest).mode & 0o077) !== 0) throw new Error('Secret transferred into a public directory');",
    '  }',
    '  fs.copyFileSync(source, path.join(dest, path.basename(source)));',
    '}'
  ].join('\n'));
  if (failTransfer) await shim('cat', '#!/bin/sh\nprintf "partial synthetic data"\nexit ' + (failTransfer === 'short' ? '0' : '1') + '\n');
  const run = () => spawnSync('bash', ['deploy.sh', '--deploy-only'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  });
  return { dir, remote, run };
}

for (const existing of [false, true]) {
  test('deployment keeps configuration private for ' + (existing ? 'an existing directory' : 'a new directory'), posixOnly, async t => {
    const fixture = await deployment(t, existing);
    const result = fixture.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal((await fs.stat(fixture.remote)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(fixture.remote, '.env'))).mode & 0o777, 0o600);
    assert.match(await fs.readFile(path.join(fixture.remote, '.env'), 'utf8'), /OPENAI_CLIENT_SECRET=synthetic-client-secret/);
    assert.equal(await fs.readFile(path.join(fixture.remote, 'docker-compose.yml'), 'utf8'), await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8'));
    assert.deepEqual((await fs.readdir(fixture.remote)).sort(), ['.env', 'docker-compose.yml']);
  });
}

test('a failed configuration transfer preserves the previous file and removes staging files', posixOnly, async t => {
  const fixture = await deployment(t, true, true);
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(path.join(fixture.remote, '.env'), 'utf8'), 'previous configuration');
  assert.equal((await fs.stat(fixture.remote)).mode & 0o777, 0o700);
  assert.deepEqual((await fs.readdir(fixture.remote)).sort(), ['.env', 'docker-compose.yml']);
});

test('deployment refuses a symlinked configuration without writing outside the private directory', posixOnly, async t => {
  const fixture = await deployment(t, true);
  const outside = path.join(fixture.dir, 'outside');
  await fs.writeFile(outside, 'unrelated data');
  await fs.rm(path.join(fixture.remote, '.env'));
  await fs.symlink(outside, path.join(fixture.remote, '.env'));
  assert.notEqual(fixture.run().status, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'unrelated data');
});

test('a truncated upload cannot replace the previous configuration even if the reader succeeds', posixOnly, async t => {
  const fixture = await deployment(t, true, 'short');
  assert.notEqual(fixture.run().status, 0);
  assert.equal(await fs.readFile(path.join(fixture.remote, '.env'), 'utf8'), 'previous configuration');
  assert.deepEqual((await fs.readdir(fixture.remote)).sort(), ['.env', 'docker-compose.yml']);
});
