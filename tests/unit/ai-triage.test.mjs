// Build 3 tests — AI failure triage.
//
// Five required cases, mapped 1:1 to the brief:
//   1. verdict-independence: triage cannot mutate the verdict object,
//      and with no API key the verdict stands clean with a triageError note.
//   2. mocked-API classification: intentional vs silent vs cant-tell each
//      route through the projection layer correctly.
//   3. reseal-gate-not-bypassed: a justify-and-reseal annotation does NOT
//      let an MCP-bound agent reseal — the human gate still gates.
//   4. malformed AI response → triageError; verdict + forensics fully shown.
//
// Plus a static-isolation cross-check (the iron rule already covers
// suggest/ai/triage.ts via the existing BFS test — we still pin it here as
// a direct assertion against drift).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  seal,
  verify,
  triageVerify,
  renderTriageHuman,
  toTriageJson,
  RESEAL_GATE_NOTICE,
} from '../../dist/index.js';

// ────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────────

/** A repo with one file-hash claim, then mutate the file so verify regresses. */
async function makeRegressedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pk-triage-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pk@local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'pk'], { cwd: root });
  mkdirSync(join(root, 'proofs'), { recursive: true });
  writeFileSync(
    join(root, 'totals.js'),
    'function total(xs) { return Math.round(xs.reduce((a,b)=>a+b,0)); }\n',
  );
  writeFileSync(
    join(root, 'proofseal.json'),
    JSON.stringify(
      {
        schema: 'proofseal/v1',
        claims: [
          {
            type: 'file-hash',
            id: 'totals-impl',
            desc: 'Q3 reconciliation: total() must round, do not alter',
            file: 'totals.js',
          },
        ],
      },
      null,
      2,
    ),
  );
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  await seal({ root });
  // Now mutate to cause a regression.
  writeFileSync(
    join(root, 'totals.js'),
    'function total(xs) { return Math.floor(xs.reduce((a,b)=>a+b,0)); }\n',
  );
  return root;
}

// ────────────────────────────────────────────────────────────────────────────
// (1) Verdict independence — THE TEST THE WHOLE BUILD HINGES ON.
// ────────────────────────────────────────────────────────────────────────────

test('verdict-independence: triage cannot mutate the verdict object', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  // Snapshot the verdict BEFORE triage touches it.
  const before = JSON.stringify(verdict);
  const beforeRef = verdict; // same reference

  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        {
          claimId: 'totals-impl',
          classification: 'looks-silent',
          recommendation: 'revert',
          confidence: 'high',
          explanation: 'rounding changed from round to floor with no commit message about a numeric change',
        },
      ],
    }),
  });

  // Same reference, same bytes.
  assert.equal(triaged.verdict, beforeRef, 'triage.verdict must be the exact same reference');
  assert.equal(JSON.stringify(triaged.verdict), before, 'verdict bytes must be byte-identical post-triage');
  // Exit code is on the verdict; triage cannot reach it.
  assert.equal(triaged.verdict.exitCode, 1);
  assert.equal(triaged.verdict.summary.regressed, 1);
  // The annotation exists, but on a sibling field.
  assert.equal(triaged.annotations.length, 1);
});

test('verdict-independence: no API key → triageError set, verdict UNCHANGED', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const before = JSON.stringify(verdict);

  // Belt + suspenders: delete env AND replace fetch with a thrower.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = () => {
    throw new Error('FETCH MUST NOT BE CALLED WHEN KEY IS ABSENT');
  };
  try {
    const triaged = await triageVerify(verdict, { root });
    assert.equal(JSON.stringify(triaged.verdict), before);
    assert.equal(triaged.annotations.length, 0);
    assert.ok(triaged.triageError, 'triageError must be set when key is missing');
    assert.match(triaged.triageError, /ANTHROPIC_API_KEY/);
    // Exit code on the verdict is unchanged.
    assert.equal(triaged.verdict.exitCode, 1);
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    globalThis.fetch = prevFetch;
  }
});

test('verdict-independence: an all-passing verify yields no triage call, no error', async () => {
  // Pass case — triage has nothing to do; should not attempt any AI call.
  const root = mkdtempSync(join(tmpdir(), 'pk-triage-pass-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pk@local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'pk'], { cwd: root });
  mkdirSync(join(root, 'proofs'), { recursive: true });
  writeFileSync(join(root, 'app.js'), 'function f(){ return 42; }\n');
  writeFileSync(
    join(root, 'proofseal.json'),
    JSON.stringify({
      schema: 'proofseal/v1',
      claims: [{ type: 'file-hash', id: 'app', file: 'app.js' }],
    }),
  );
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  await seal({ root });

  const verdict = await verify({ root });
  assert.equal(verdict.summary.pass, 1);

  let called = false;
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => {
      called = true;
      return { triage: [] };
    },
  });
  assert.equal(called, false, 'no failures → no AI call');
  assert.equal(triaged.annotations.length, 0);
  assert.equal(triaged.triageError, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) Mocked-API classification: intentional / silent / cant-tell each round-trip.
// ────────────────────────────────────────────────────────────────────────────

test('mocked-API: looks-intentional → justify-and-reseal carries the gate notice', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        {
          claimId: 'totals-impl',
          classification: 'looks-intentional',
          recommendation: 'justify-and-reseal',
          confidence: 'medium',
          explanation: 'the diff swaps round() for floor(); the commit message names the change',
        },
      ],
    }),
  });
  assert.equal(triaged.annotations.length, 1);
  const a = triaged.annotations[0];
  assert.equal(a.classification, 'looks-intentional');
  assert.equal(a.recommendation, 'justify-and-reseal');
  assert.equal(a.resealGate, RESEAL_GATE_NOTICE);
  // Pinned status comes from the verdict, not the AI.
  assert.equal(a.status, 'regressed');
});

test('mocked-API: looks-silent → revert, no reseal-gate string attached', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        {
          claimId: 'totals-impl',
          classification: 'looks-silent',
          recommendation: 'revert',
          confidence: 'high',
          explanation: 'value moved with no commit-message acknowledgement of an intended numeric change',
        },
      ],
    }),
  });
  const a = triaged.annotations[0];
  assert.equal(a.classification, 'looks-silent');
  assert.equal(a.recommendation, 'revert');
  assert.equal(a.resealGate, undefined, 'revert path must not carry a reseal-gate string');
});

test('mocked-API: cant-tell → investigate (not a confident guess)', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        {
          claimId: 'totals-impl',
          classification: 'cant-tell',
          recommendation: 'investigate',
          confidence: 'low',
          explanation: 'diff is large; cannot tell if the rounding change was intended',
        },
      ],
    }),
  });
  const a = triaged.annotations[0];
  assert.equal(a.classification, 'cant-tell');
  assert.equal(a.recommendation, 'investigate');
  assert.equal(a.confidence, 'low');
});

test('mocked-API: AI invents a claimId not in the verdict → dropped, others kept', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        { claimId: 'totals-impl', classification: 'looks-silent', recommendation: 'revert', confidence: 'high', explanation: 'ok' },
        { claimId: 'phantom-claim', classification: 'looks-silent', recommendation: 'revert', confidence: 'high', explanation: 'not real' },
      ],
    }),
  });
  assert.equal(triaged.annotations.length, 1);
  assert.equal(triaged.annotations[0].claimId, 'totals-impl');
});

// ────────────────────────────────────────────────────────────────────────────
// (3) Reseal-gate-not-bypassed: triage cannot unlock the human gate.
// ────────────────────────────────────────────────────────────────────────────

test('reseal-gate-not-bypassed: triage code path does not import seal or touch PROOFSEAL_ALLOW_RESEAL', () => {
  // Structural: triage.ts is forbidden from reaching seal() because of the
  // import-graph BFS rule (verdict-path files cannot reach suggest/ai/*).
  // Conversely, triage.ts itself MUST NOT import manifest/seal.js — verify
  // that directly.
  const HERE = fileURLToPath(import.meta.url);
  const triageSrc = readFileSync(
    resolve(HERE, '..', '..', '..', 'src', 'suggest', 'ai', 'triage.ts'),
    'utf8',
  );
  assert.equal(
    /from\s+['"][^'"]*manifest\/seal[^'"]*['"]/.test(triageSrc),
    false,
    'triage.ts must not import seal — the human reseal gate is the only path to mutation',
  );
  // And the runtime gate env var must not appear as a read anywhere in triage.
  // (It is allowed to mention it inside the disclaimer string — that is the
  // OPPOSITE of using it; that is telling the human the gate exists.)
  assert.equal(
    /process\.env\.PROOFSEAL_ALLOW_RESEAL/.test(triageSrc),
    false,
    'triage.ts must not read PROOFSEAL_ALLOW_RESEAL',
  );
});

test('reseal-gate-not-bypassed: justify-and-reseal recommendation surfaces ONLY a suggestion string', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        {
          claimId: 'totals-impl',
          classification: 'looks-intentional',
          recommendation: 'justify-and-reseal',
          confidence: 'high',
          explanation: 'commit message names the change',
        },
      ],
    }),
  });
  // The reseal "gate" the triage exposes is ONLY a sentence — it is not a
  // function the AI can call. The human gate (PROOFSEAL_ALLOW_RESEAL=1 over
  // MCP, or running `proofseal seal` in a human shell) is enforced
  // independently and is untouched by triage.
  assert.equal(typeof triaged.annotations[0].resealGate, 'string');
  assert.match(triaged.annotations[0].resealGate, /SUGGESTION ONLY/);
  assert.match(triaged.annotations[0].resealGate, /PROOFSEAL_ALLOW_RESEAL|human-owned shell/);
  // And the verdict's exit code did not flip to 0.
  assert.equal(triaged.verdict.exitCode, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) Malformed AI response → graceful, verdict + forensics still shown.
// ────────────────────────────────────────────────────────────────────────────

test('malformed AI response → triageError set, verdict + forensics intact', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const before = JSON.stringify(verdict);

  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({ not_triage: 'wrong shape' }),
  });
  assert.equal(triaged.annotations.length, 0);
  assert.ok(triaged.triageError);
  assert.match(triaged.triageError, /schema/i);
  // Verdict still byte-identical, forensics still shown.
  assert.equal(JSON.stringify(triaged.verdict), before);
  assert.equal(triaged.verdict.results.length, 1);
  assert.equal(triaged.verdict.results[0].status, 'regressed');
});

test('AI throws → triageError captured; verdict unchanged', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const before = JSON.stringify(verdict);
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => {
      const e = new Error('upstream blew up');
      throw e;
    },
  });
  assert.equal(triaged.annotations.length, 0);
  assert.ok(triaged.triageError);
  assert.match(triaged.triageError, /upstream blew up|triage failed/);
  assert.equal(JSON.stringify(triaged.verdict), before);
});

// ────────────────────────────────────────────────────────────────────────────
// Rendering primacy: verdict-first in JSON; AI-tagged in human output.
// ────────────────────────────────────────────────────────────────────────────

test('JSON shape: triage is a SIBLING field, never folded into results[].detail', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        { claimId: 'totals-impl', classification: 'looks-silent', recommendation: 'revert', confidence: 'high', explanation: 'no commit-message change' },
      ],
    }),
  });
  const block = toTriageJson(triaged);
  // The triage block is its own shape; results[] does not contain any of it.
  assert.equal(block.annotations.length, 1);
  assert.equal(block.error, null);
  // Belt: the verdict's results[].detail must not contain the AI explanation.
  for (const r of triaged.verdict.results) {
    assert.equal(/no commit-message change/.test(r.detail ?? ''), false);
  }
});

test('human output: every recommendation line carries the [AI opinion] tag', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({
      triage: [
        { claimId: 'totals-impl', classification: 'looks-silent', recommendation: 'revert', confidence: 'high', explanation: 'value moved silently' },
      ],
    }),
  });
  const out = renderTriageHuman(triaged);
  // The header is there...
  assert.match(out, /TRIAGE ANNOTATION \(AI opinion; NOT a verdict\)/);
  // ...AND every recommendation line carries its own [AI opinion] prefix
  // so a narrow-terminal wrap can never detach the disclaimer from the rec.
  const recLines = out.split('\n').filter((l) => l.includes('recommendation:'));
  assert.ok(recLines.length > 0);
  for (const l of recLines) {
    assert.match(l, /\[AI opinion\]/);
  }
});

test('human output: triageError surfaces a clean note, verdict still printable', async () => {
  const root = await makeRegressedRepo();
  const verdict = await verify({ root });
  const triaged = await triageVerify(verdict, {
    root,
    callOverride: async () => ({ wrong: 'shape' }),
  });
  const out = renderTriageHuman(triaged);
  assert.match(out, /TRIAGE: /);
  assert.match(out, /verdict above stands as-is/);
});
