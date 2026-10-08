import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { smokeModels } from './model-smoke.mjs';

function fixture(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-smoke-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'pi');
  writeFileSync(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return { dir, executable };
}

test('one request per distinct tier, with project context/tools/storage disabled', (t) => {
  const { dir, executable } = fixture(t, `
    require('node:fs').appendFileSync(__dirname + '/calls', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}) + '\\n');
    console.log('OK');
  `);
  smokeModels(['vendor/served:high', '', 'vendor/served:high', 'vendor/worker'], { executable });
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const { args, cwd } of calls) {
    for (const flag of ['--no-tools', '--no-session', '--no-skills', '--no-extensions', '--no-context-files', '--no-prompt-templates', '--no-approve']) assert.ok(args.includes(flag));
    assert.notEqual(cwd, process.cwd());
    assert.equal(existsSync(cwd), false, 'temporary workspace removed');
  }
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'vendor/served:high');
});

test('nonzero exit rejects a catalog-listed but undeployed model without printing provider output', (t) => {
  const { executable } = fixture(t, "console.error('private account data'); process.exit(1)");
  assert.throws(() => smokeModels(['vendor/undeployed'], { executable }), /^Error: model smoke failed for 'vendor\/undeployed'; check provider access and deployment before resetting$/);
});

test('hung probe times out; empty output and missing tier also fail', (t) => {
  const { executable } = fixture(t, 'setInterval(() => {}, 1000)');
  assert.throws(() => smokeModels(['vendor/hung'], { executable, timeout: 100 }), /timed out/);
  writeFileSync(executable, `#!${process.execPath}\n`, { mode: 0o755 });
  assert.throws(() => smokeModels(['vendor/empty'], { executable }), /no response/);
  assert.throws(() => smokeModels([''], { executable }), /requires an explicit model tier/);
});

test('failed smoke stops reset before altering either arm', (t) => {
  const { dir } = fixture(t, 'process.exit(1)');
  const arm1 = join(dir, 'arm1');
  const arm2 = join(dir, 'arm2');
  writeFileSync(arm1, 'preserve arm one');
  writeFileSync(arm2, 'preserve arm two');
  const result = spawnSync('bash', [fileURLToPath(new URL('./reset', import.meta.url)), '--smoke-models', '--design-model', 'vendor/undeployed'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOGFOOD_1: arm1, DOGFOOD_2: arm2 }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /model smoke failed/);
  assert.equal(readFileSync(arm1, 'utf8'), 'preserve arm one');
  assert.equal(readFileSync(arm2, 'utf8'), 'preserve arm two');
});
