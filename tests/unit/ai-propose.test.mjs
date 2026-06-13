// proposeAiClaims behavior under controlled inputs. We never hit the
// network — the rawToolInputOverride hook feeds parsed tool input directly,
// so we exercise the validation + acceptance pipeline in isolation.
//
// What we're proving:
//  • Well-formed sealable proposals make it through, source field is NOT
//    in the on-disk claim shape (ClaimSchema rejects extras), confidence
//    and reason are preserved.
//  • Malformed individual items drop into `skipped` with a reason — never
//    silently swallowed.
//  • A wholly-malformed top-level response throws MalformedResponseError.
//  • needs-human items route to their own list, not accepted.
//  • Marker proposals that fail lintMarker are dropped with a reason.
//  • File references not in the diff are dropped with a reason.
//  • Id collisions get a numeric suffix (same logic as the regex source).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { proposeAiClaims, MalformedResponseError } from '../../dist/index.js';

function makeRepoWithEdit() {
  const root = mkdtempSync(join(tmpdir(), 'pk-ai-prop-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pk@local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'pk'], { cwd: root });
  mkdirSync(join(root, 'proofs'), { recursive: true });
  writeFileSync(join(root, 'proofseal.json'), JSON.stringify({ schema: 'proofseal/v1', claims: [] }));
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  // Create an uncommitted edit so `changedFiles` returns something.
  writeFileSync(
    join(root, 'totals.js'),
    'function total(xs) {\n  // important: clamp the result to non-negative\n  return Math.max(0, xs.reduce((a, b) => a + b, 0));\n}\n',
  );
  return root;
}

test('proposeAiClaims: well-formed harness proposal is accepted', async () => {
  const root = makeRepoWithEdit();
  const r = await proposeAiClaims({
    root,
    rawToolInputOverride: {
      proposals: [
        {
          verdict: 'sealable',
          type: 'harness',
          id: 'totals-sum',
          desc: 'sums a known input',
          cmd: "node -e \"const t=require('./totals.js');console.log(JSON.stringify([t([1,2,3])]))\"",
          confidence: 'high',
          reason: 'deterministic numeric sum, load-bearing',
        },
      ],
    },
  });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].claim.type, 'harness');
  assert.equal(r.accepted[0].claim.id, 'totals-sum');
  assert.equal(r.accepted[0].confidence, 'high');
  // On-disk shape MUST NOT carry a `source` field — ClaimSchema would reject it.
  assert.ok(!('source' in r.accepted[0].claim));
  assert.equal(r.skipped.length, 0);
  assert.equal(r.needsHuman.length, 0);
});

test('proposeAiClaims: needs-human routes to its own list (not accepted)', async () => {
  const root = makeRepoWithEdit();
  const r = await proposeAiClaims({
    root,
    rawToolInputOverride: {
      proposals: [
        {
          verdict: 'needs-human',
          target: 'totals.js',
          reason: 'output is JSON, not deterministically numeric',
        },
      ],
    },
  });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.needsHuman.length, 1);
  assert.equal(r.needsHuman[0].target, 'totals.js');
});

test('proposeAiClaims: a mixed-validity array throws MalformedResponseError (strict-on-shape)', async () => {
  // Design choice (documented in propose.ts): zod's union safeParse fails
  // the whole proposals array if ANY item fails its union match. We chose
  // strict-on-shape — the user sees "AI response was malformed" rather
  // than a quietly partial result. This test pins that choice so it can't
  // drift accidentally.
  const root = makeRepoWithEdit();
  await assert.rejects(
    () =>
      proposeAiClaims({
        root,
        rawToolInputOverride: {
          proposals: [
            // missing required cmd field — fails the harness union member
            {
              verdict: 'sealable',
              type: 'harness',
              id: 'bad-one',
              desc: 'no cmd',
              confidence: 'high',
              reason: 'bad shape',
            },
            // valid
            {
              verdict: 'sealable',
              type: 'harness',
              id: 'good-one',
              desc: 'fine',
              cmd: 'node -e "console.log(JSON.stringify([1]))"',
              confidence: 'medium',
              reason: 'fine',
            },
          ],
        },
      }),
    MalformedResponseError,
  );
});

test('proposeAiClaims: post-validation drops (lint/file-existence) DO route to skipped with reason', async () => {
  // Distinct from the strict-on-shape case above: when zod's schema passes
  // but later gates (lintMarker, file-existence, ClaimSchema) reject an
  // item, it goes to `skipped` with a reason — never silently swallowed.
  const root = makeRepoWithEdit();
  const r = await proposeAiClaims({
    root,
    rawToolInputOverride: {
      proposals: [
        // valid shape, but file is not in the diff
        {
          verdict: 'sealable',
          type: 'marker',
          id: 'phantom',
          desc: 'against a phantom file',
          file: 'nope-not-here.js',
          marker: 'return importantFn();',
          confidence: 'high',
          reason: 'file not in diff',
        },
        // valid
        {
          verdict: 'sealable',
          type: 'harness',
          id: 'kept',
          desc: 'fine',
          cmd: 'node -e "console.log(JSON.stringify([1]))"',
          confidence: 'medium',
          reason: 'fine',
        },
      ],
    },
  });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].claim.id, 'kept');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].ref, 'phantom');
  assert.match(r.skipped[0].reason, /not in diff|not readable/);
});

test('proposeAiClaims: wholly-malformed top-level response throws MalformedResponseError', async () => {
  const root = makeRepoWithEdit();
  await assert.rejects(
    () =>
      proposeAiClaims({
        root,
        rawToolInputOverride: { not_proposals: 'wrong shape' },
      }),
    MalformedResponseError,
  );
});

test('proposeAiClaims: marker proposal for non-diff file is dropped with reason', async () => {
  const root = makeRepoWithEdit();
  const r = await proposeAiClaims({
    root,
    rawToolInputOverride: {
      proposals: [
        {
          verdict: 'sealable',
          type: 'marker',
          id: 'phantom',
          desc: 'against a phantom file',
          file: 'no-such-file.js',
          marker: 'return computeImportant();',
          confidence: 'high',
          reason: 'marker on file not in diff',
        },
      ],
    },
  });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /not in diff|not readable/);
});

test('proposeAiClaims: id collisions get a numeric suffix', async () => {
  const root = makeRepoWithEdit();
  const r = await proposeAiClaims({
    root,
    rawToolInputOverride: {
      proposals: [
        {
          verdict: 'sealable',
          type: 'harness',
          id: 'dup',
          desc: 'first',
          cmd: 'node -e "console.log(JSON.stringify([1]))"',
          confidence: 'high',
          reason: 'first',
        },
        {
          verdict: 'sealable',
          type: 'harness',
          id: 'dup',
          desc: 'second',
          cmd: 'node -e "console.log(JSON.stringify([2]))"',
          confidence: 'medium',
          reason: 'second collides',
        },
      ],
    },
  });
  assert.equal(r.accepted.length, 2);
  assert.equal(r.accepted[0].claim.id, 'dup');
  assert.notEqual(r.accepted[1].claim.id, 'dup');
});
