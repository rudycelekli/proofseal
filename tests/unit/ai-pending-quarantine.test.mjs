// The quarantine guarantee: --write touches proofs/pending.json and NOTHING
// else. Specifically, proofseal.json bytes and proofs/manifest.json hash
// must be identical before and after a `suggest --ai --write` run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  seal,
  appendPending,
  readPending,
  claimAddCommandFor,
  PENDING_SCHEMA,
  PENDING_REL_PATH,
} from '../../dist/index.js';

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function makeSealedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pk-ai-quar-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pk@local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'pk'], { cwd: root });
  mkdirSync(join(root, 'proofs'), { recursive: true });
  writeFileSync(
    join(root, 'app.js'),
    'function f(x) {\n  const clampedThreshold = Math.min(x, 100);\n  return clampedThreshold;\n}\n',
  );
  writeFileSync(
    join(root, 'proofseal.json'),
    JSON.stringify(
      {
        schema: 'proofseal/v1',
        claims: [
          { type: 'marker', id: 'clamp', file: 'app.js', marker: 'const clampedThreshold = Math.min(x, 100);' },
        ],
      },
      null,
      2,
    ),
  );
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  await seal({ root });
  return root;
}

test('appendPending: proofseal.json and proofs/manifest.json are byte-identical after write', async () => {
  const root = await makeSealedRepo();
  const configPath = join(root, 'proofseal.json');
  const manifestPath = join(root, 'proofs', 'manifest.json');

  const configBefore = readFileSync(configPath);
  const manifestBefore = readFileSync(manifestPath);
  const configShaBefore = sha(configBefore);
  const manifestShaBefore = sha(manifestBefore);

  const accepted = [
    {
      claim: {
        type: 'harness',
        id: 'fake-totals',
        desc: 'fake AI proposal',
        harness: 'fake-totals',
        cmd: 'node -e "console.log(JSON.stringify([1,2,3]))"',
      },
      confidence: 'high',
      reason: 'looks load-bearing',
    },
  ];

  const r = appendPending(root, accepted, ['clamp']);
  assert.deepEqual(r.written, ['fake-totals']);

  // The sealed bits must be UNCHANGED, byte-for-byte.
  const configAfter = readFileSync(configPath);
  const manifestAfter = readFileSync(manifestPath);
  assert.equal(sha(configAfter), configShaBefore, 'proofseal.json bytes must be unchanged');
  assert.equal(sha(manifestAfter), manifestShaBefore, 'proofs/manifest.json bytes must be unchanged');

  // pending.json must exist with the proposal and the warning.
  assert.ok(existsSync(join(root, PENDING_REL_PATH)));
  const pending = readPending(root);
  assert.equal(pending.schema, PENDING_SCHEMA);
  assert.match(pending.warning, /UNVERIFIED/i);
  assert.equal(pending.proposals.length, 1);
  assert.equal(pending.proposals[0].claim.id, 'fake-totals');
  assert.equal(pending.proposals[0].source, 'ai-suggest');
});

test('appendPending: dedupes against sealed claim ids', async () => {
  const root = await makeSealedRepo();
  const accepted = [
    {
      claim: { type: 'marker', id: 'clamp', file: 'app.js', marker: 'whatever' },
      confidence: 'high',
      reason: 'duplicate of sealed',
    },
  ];
  const r = appendPending(root, accepted, ['clamp']);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.skipped, ['clamp']);
});

test('appendPending: dedupes against existing pending entries', async () => {
  const root = await makeSealedRepo();
  const a1 = [
    {
      claim: { type: 'file-hash', id: 'pinme', file: 'app.js' },
      confidence: 'medium',
      reason: 'first round',
    },
  ];
  appendPending(root, a1, ['clamp']);
  const r = appendPending(root, a1, ['clamp']);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.skipped, ['pinme']);
});

test('claimAddCommandFor: emits the right command per claim type', () => {
  const harness = claimAddCommandFor({
    claim: { type: 'harness', id: 'h', desc: 'd', harness: 'h', cmd: 'node x' },
    confidence: 'high',
    reason: 'r',
  });
  assert.match(harness, /^proofseal claim add --type harness --id "h" --cmd "node x"$/);

  const marker = claimAddCommandFor({
    claim: { type: 'marker', id: 'm', desc: 'd', file: 'a.js', marker: 'return important();' },
    confidence: 'high',
    reason: 'r',
  });
  assert.match(marker, /^proofseal claim add --type marker --id "m" --file "a\.js" --marker "return important\(\);"$/);

  const fh = claimAddCommandFor({
    claim: { type: 'file-hash', id: 'fh', desc: 'd', file: 'b.js' },
    confidence: 'low',
    reason: 'r',
  });
  assert.equal(fh, 'proofseal claim add --type file-hash --id "fh" --file "b.js"');
});
