// Batch claim authoring: `proofseal claim add --from-file <path>` —
// all-or-nothing validation, duplicate-id rejection, marker lint, --json.
// Spawns the real built CLI (the feature is CLI surface, not library API).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig, defaultConfig } from '../../dist/index.js';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli/index.js');

function runCli(args, cwd) {
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pk-fromfile-'));
  saveConfig(root, defaultConfig(root));
  writeFileSync(join(root, 'src.js'), 'export function stableAnchor() { return 1; }\n');
  return root;
}

function configClaims(root) {
  return JSON.parse(readFileSync(join(root, 'proofseal.json'), 'utf8')).claims;
}

test('--from-file happy path: adds all claims, prints "Added N claims"', async () => {
  const root = freshRepo();
  writeFileSync(
    join(root, 'batch.json'),
    JSON.stringify([
      { id: 'f1', type: 'file-hash', file: 'src.js', desc: 'src integrity' },
      { id: 'm1', type: 'marker', file: 'src.js', marker: 'stableAnchor()' },
      { id: 'h1', type: 'harness', name: 'det', cmd: 'node det.mjs', seed: 7, quantizeDecimals: 4 },
    ]),
  );
  const r = await runCli(['claim', 'add', '--from-file', 'batch.json'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Added 3 claims/);
  const claims = configClaims(root);
  assert.equal(claims.length, 4); // sample claim + 3
  const h = claims.find((c) => c.id === 'h1');
  assert.equal(h.harness, 'det'); // `name` alias mapped to `harness`
  assert.equal(h.seed, 7);
  assert.equal(h.quantizeDecimals, 4);
});

test('--from-file all-or-nothing: one bad entry rejects everything, lists each index+reason', async () => {
  const root = freshRepo();
  const before = JSON.stringify(configClaims(root));
  writeFileSync(
    join(root, 'batch.json'),
    JSON.stringify([
      { id: 'good', type: 'file-hash', file: 'src.js' },
      { id: 'bad-no-file', type: 'file-hash' }, // missing required `file`
      { id: 'bad-no-cmd', type: 'harness' }, // missing required `cmd`
    ]),
  );
  const r = await runCli(['claim', 'add', '--from-file', 'batch.json'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[1\]/, 'must list invalid index 1');
  assert.match(r.stderr, /\[2\]/, 'must list invalid index 2');
  assert.match(r.stderr, /no claims were added/);
  assert.equal(JSON.stringify(configClaims(root)), before, 'config untouched');
});

test('--from-file: duplicate id (within file and vs existing config) ⇒ exit 2', async () => {
  const root = freshRepo();
  writeFileSync(
    join(root, 'batch.json'),
    JSON.stringify([
      { id: 'dup', type: 'file-hash', file: 'src.js' },
      { id: 'dup', type: 'marker', file: 'src.js', marker: 'stableAnchor()' },
      { id: 'sample-config-schema', type: 'file-hash', file: 'src.js' }, // exists in config
    ]),
  );
  const r = await runCli(['claim', 'add', '--from-file', 'batch.json'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /duplicate claim id 'dup'/);
  assert.match(r.stderr, /duplicate claim id 'sample-config-schema'/);
  assert.equal(configClaims(root).length, 1, 'all-or-nothing');
});

test('--from-file --json: ok payload with added count and lint warnings array', async () => {
  const root = freshRepo();
  writeFileSync(join(root, 'dup.js'), 'twice()\ntwice()\n');
  writeFileSync(
    join(root, 'batch.json'),
    JSON.stringify([{ id: 'm-dup', type: 'marker', file: 'dup.js', marker: 'twice()' }]),
  );
  const r = await runCli(['claim', 'add', '--from-file', 'batch.json', '--json'], root);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.added, 1);
  assert.deepEqual(j.ids, ['m-dup']);
  assert.equal(Array.isArray(j.warnings), true);
  assert.match(j.warnings[0], /\[m-dup\].*appears 2 times/);
});

test('--from-file: non-array JSON rejected with exit 2', async () => {
  const root = freshRepo();
  writeFileSync(join(root, 'batch.json'), JSON.stringify({ id: 'x' }));
  const r = await runCli(['claim', 'add', '--from-file', 'batch.json'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /JSON array/);
});

test('single claim add: marker lint warnings go to stderr, command still exits 0', async () => {
  const root = freshRepo();
  const r = await runCli(
    ['claim', 'add', '--id', 'noisy', '--type', 'marker', '--file', 'src.js', '--marker', 'Cannot find the user record anywhere'],
    root,
  );
  assert.equal(r.code, 0, 'lint never fails the command');
  assert.match(r.stderr, /log\/exception message/);
  assert.match(r.stdout, /Added claim 'noisy'/);
});

test('single claim add --json: warnings array included in JSON output', async () => {
  const root = freshRepo();
  const r = await runCli(
    ['claim', 'add', '--id', 'tick', '--type', 'marker', '--file', 'src.js', '--marker', 'see `stableAnchor` here', '--json'],
    root,
  );
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.match(j.warnings.join('\n'), /backticks/);
});

test('claim add without --id/--type and without --from-file ⇒ exit 2', async () => {
  const root = freshRepo();
  const r = await runCli(['claim', 'add', '--type', 'file-hash', '--file', 'src.js'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--id and --type are required/);
});
