#!/usr/bin/env node
// bench/run.mjs — ProofSeal v0.1 benchmark orchestrator (ADR-0001 §3).
//
// Protocol per ADR §3.3: clean-copy each vendored fixture into a temp dir →
// git init + commit (the simulated clean clone / seal point) → scripted,
// timed setup per tool → 20 cold-process verify runs (p50/p95) → seeded
// mutation suite (seed 42, committed list) → emit bench/results/report.md +
// report.json with provenance, the exact §3.4 comparison table, per-fixture
// and per-claim-type slices, and sample failure annotations.
//
// Honest-comparison policy (ADR D12): capability gaps are recorded as
// "N/A — capability absent"; missing tools as "SKIPPED (not installed)" —
// never silently omitted. When ProofSeal itself is not yet built, the report
// is emitted marked INCOMPLETE with the ProofSeal column pending.
//
// NOTE: the internal tool id stays 'proofkit' (adapter path, result keys) —
// only display strings are renamed; the bench agent owns the functional ids.
//
// Usage: node bench/run.mjs
// Zero npm dependencies. Plain Node ESM. execFile only — no shell strings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  run, sha256File, copyDir, freshTempDir, rmrf, gitInitCommit,
  percentile, median, round, harnessHash, makeRng,
} from './lib/util.mjs';
import { applyMutation } from './lib/mutate.mjs';
import * as proofkit from './lib/proofkit-adapter.mjs';
import * as checksum from './baselines/checksum/baseline.mjs';
import { keypair as cosignKeypair, keyless as cosignKeyless } from './baselines/cosign/baseline.mjs';
import * as intoto from './baselines/intoto/baseline.mjs';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = ['repo-a-npm-lib', 'repo-b-python-tool', 'repo-c-docs-site'];
const VERIFY_RUNS = 20; // ADR §3.2.5
const SETUP_RUNS = 3; // ADR §3.2.2 (median of 3)
const MUTATION_SEED = 42;

// Tool order matches the ADR §3.4 table columns.
const TOOLS = [proofkit, checksum, cosignKeyless, cosignKeypair, intoto];

const log = (...a) => console.log('[bench]', ...a);

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
async function gatherProvenance() {
  const projectRoot = path.dirname(BENCH_DIR);
  const git = await run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
  const gitDirty = git.ok ? await run('git', ['status', '--porcelain'], { cwd: projectRoot }) : null;
  const python = await run('python3', ['--version']);
  const gitV = await run('git', ['--version']);
  return {
    benchSchema: 'proofseal-bench-report/v1',
    startedAt: new Date().toISOString(),
    gitSha: git.ok ? git.stdout.trim() : 'no-git (project not yet a git repo)',
    gitDirty: gitDirty ? gitDirty.stdout.trim().length > 0 : null,
    seeds: { fixtures: 1337, mutations: MUTATION_SEED, harness: [42, 7] },
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus()[0]?.model || 'unknown' },
    node: process.version,
    python3: python.ok ? (python.stdout + python.stderr).trim() : 'not installed',
    gitVersion: gitV.ok ? gitV.stdout.trim() : 'not installed',
    verifyRunsPerFixture: VERIFY_RUNS,
    setupRunsPerFixture: SETUP_RUNS,
  };
}

// ---------------------------------------------------------------------------
// Fixture loading + integrity self-check (the bench refuses to run on a
// tampered fixture tree — claims.json carries generation-time hashes).
// ---------------------------------------------------------------------------
function loadFixture(name) {
  const dir = path.join(BENCH_DIR, 'fixtures', name);
  const claimsDoc = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'));
  if (claimsDoc.claims.length !== 100) throw new Error(`${name}: expected 100 claims, got ${claimsDoc.claims.length}`);
  return { name, dir, claims: claimsDoc.claims };
}

async function selfCheckFixtures(fixtures, pythonAvailable) {
  const problems = [];
  for (const f of fixtures) {
    for (const c of f.claims.filter((c) => c.type === 'file-hash')) {
      const actual = sha256File(path.join(f.dir, c.file));
      if (actual !== c.sha256) problems.push(`${f.name}/${c.file}: hash drift vs claims.json (regenerate with fixtures/generate.mjs)`);
    }
    if (pythonAvailable) {
      for (const c of f.claims.filter((c) => c.type === 'harness')) {
        const r = await run('python3', ['tools/deterministic.py'], { cwd: f.dir, env: { PROOFKIT_SEED: String(c.seed) } });
        if (!r.ok) { problems.push(`${f.name}/${c.id}: harness run failed: ${r.error}`); continue; }
        const values = r.stdout.trim().split('\n').map(Number);
        const h = harnessHash(values, c.quantizeDecimals);
        if (h !== c.expectedSha256) problems.push(`${f.name}/${c.id}: harness hash mismatch (${h} != ${c.expectedSha256})`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Per-tool benchmark
// ---------------------------------------------------------------------------
async function prepareWorkDir(fixture, label) {
  const dir = freshTempDir(label);
  copyDir(fixture.dir, dir);
  const g = await gitInitCommit(dir);
  if (!g.ok) throw new Error(`git init/commit failed in ${dir}: ${g.error} ${g.stderr.slice(0, 200)}`);
  return dir;
}

async function benchTool(tool, fixtures, mutations) {
  const result = {
    id: tool.id, name: tool.name, status: 'ok', reason: null, version: null,
    capabilities: tool.capabilities,
    setup: { steps: null, medianSeconds: null, configLoc: null, secretsCount: null },
    latency: { all: [], p50: null, p95: null, perFixture: {} },
    // `correct` = four-state classification accuracy. That taxonomy belongs to
    // ProofSeal alone, so it is tracked for ProofSeal only and is null —
    // "N/A — taxonomy absent" — for every other tool (never a percentage).
    mutations: { total: 0, signaled: 0, correct: tool.id === 'proofkit' ? 0 : null, byClass: {}, records: [] },
  };

  const det = await tool.detect();
  result.version = det.version || null;
  if (!det.available) {
    // Static-only tools (e.g. cosign keyless without an OIDC identity):
    // the tool is installed but its sign ceremony cannot run headless.
    // Setup steps / config LOC / secrets are properties of the procedure
    // itself and are measured statically; every wall-clock or execution
    // cell becomes "N/A — <reason>" rather than SKIPPED (ADR D12: an
    // adoption-cost finding, not a hidden gap).
    if (det.staticOnly && typeof tool.staticSetup === 'function') {
      result.status = 'static';
      result.reason = det.reason;
      result.naReason = det.naReason || det.reason;
      const metas = fixtures.map((f) => tool.staticSetup(f.claims));
      result.setup.steps = Math.max(...metas.map((m) => m.steps));
      result.setup.configLoc = Math.max(...metas.map((m) => m.configLoc));
      result.setup.secretsCount = Math.max(...metas.map((m) => m.secretsCount));
      log(`${tool.name}: STATIC-ONLY — ${det.reason}`);
      return result;
    }
    result.status = tool.id === 'proofkit' ? 'pending' : 'skipped';
    result.reason = det.reason;
    log(`${tool.name}: ${result.status.toUpperCase()} — ${det.reason}`);
    return result;
  }
  log(`${tool.name}: available (${det.version})`);

  const setupSamples = [];
  const setupMeta = [];
  const masters = {}; // fixture -> sealed work dir reused for latency + mutations

  try {
    for (const fixture of fixtures) {
      // --- Setup: median of SETUP_RUNS fresh scripted runs (ADR §3.2.2) ---
      for (let i = 0; i < SETUP_RUNS; i++) {
        const wd = await prepareWorkDir(fixture, `${tool.id}-setup`);
        const t0 = process.hrtime.bigint();
        const meta = await tool.setup(wd, fixture.claims);
        setupSamples.push(Number(process.hrtime.bigint() - t0) / 1e9);
        if (i === 0) setupMeta.push(meta);
        if (i === SETUP_RUNS - 1) masters[fixture.name] = wd; // keep last as sealed master
        else rmrf(wd);
      }

      // --- Latency: VERIFY_RUNS cold-process verifies (ADR §3.2.5) ---
      const times = [];
      for (let i = 0; i < VERIFY_RUNS; i++) {
        const v = await tool.verify(masters[fixture.name]);
        if (v.code !== 0) throw new Error(`${fixture.name}: baseline verify failed on pristine sealed tree (exit ${v.code}): ${v.output.slice(0, 300)}`);
        times.push(v.ms);
      }
      const sorted = [...times].sort((a, b) => a - b);
      result.latency.perFixture[fixture.name] = {
        p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)),
      };
      result.latency.all.push(...times);
      log(`  ${fixture.name}: verify p50=${result.latency.perFixture[fixture.name].p50}ms p95=${result.latency.perFixture[fixture.name].p95}ms`);

      // --- Mutation suite (seed 42, committed list — ADR C4) ---
      // Headline metric: "tamper signaled" — did the tool raise ANY signal,
      // under ITS OWN semantics (a cosign hard FAIL on a benign append is
      // CORRECT for cosign's security model). The four-state classification
      // (pass/drift/regressed/missing) is ProofSeal's OWN taxonomy: it is
      // scored for ProofSeal only and NEVER graded against competitors
      // (premortem round 3 — no percentages on a rubric only ProofSeal
      // subscribes to).
      const isProofSeal = tool.id === 'proofkit';
      const claimsById = new Map(fixture.claims.map((c) => [c.id, c]));
      for (const m of mutations.filter((m) => m.fixture === fixture.name)) {
        const wd = freshTempDir(`${tool.id}-mut`);
        copyDir(masters[fixture.name], wd);
        let record;
        try {
          applyMutation(wd, m, claimsById, tool);
          const v = await tool.verify(wd);
          const observed = tool.classify(v);
          const signaled = observed !== 'pass';
          record = { id: m.id, class: m.class, fixture: m.fixture, target: m.target, proofsealExpectedClass: m.expectedDetection, observed, signaled, output: v.output.slice(0, 240) };
          if (isProofSeal) record.correctClassification = observed === m.expectedDetection;
        } catch (e) {
          record = { id: m.id, class: m.class, fixture: m.fixture, target: m.target, proofsealExpectedClass: m.expectedDetection, observed: 'error', signaled: false, output: String(e.message).slice(0, 240) };
          if (isProofSeal) record.correctClassification = false;
        }
        rmrf(wd);
        result.mutations.total += 1;
        if (record.signaled) result.mutations.signaled += 1;
        if (isProofSeal && record.correctClassification) result.mutations.correct += 1;
        const bc = (result.mutations.byClass[m.class] ||= { total: 0, signaled: 0, ...(isProofSeal ? { correct: 0 } : {}) });
        bc.total += 1;
        if (record.signaled) bc.signaled += 1;
        if (isProofSeal && record.correctClassification) bc.correct += 1;
        result.mutations.records.push(record);
      }
      log(`  ${fixture.name}: mutations done (${result.mutations.signaled}/${result.mutations.total} signaled so far)`);
    }

    const sortedAll = [...result.latency.all].sort((a, b) => a - b);
    result.latency.p50 = round(percentile(sortedAll, 50));
    result.latency.p95 = round(percentile(sortedAll, 95));
    result.setup.medianSeconds = round(median(setupSamples), 2);
    result.setup.steps = Math.max(...setupMeta.map((m) => m.steps));
    result.setup.configLoc = Math.max(...setupMeta.map((m) => m.configLoc));
    result.setup.secretsCount = Math.max(...setupMeta.map((m) => m.secretsCount));
  } catch (e) {
    result.status = 'error';
    result.reason = String(e.message).slice(0, 500);
    log(`${tool.name}: ERROR — ${result.reason}`);
  } finally {
    for (const wd of Object.values(masters)) rmrf(wd);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Report rendering — the EXACT table from ADR §3.4.
// ---------------------------------------------------------------------------
function cell(tool, render, staticMeasured = false) {
  if (tool.status === 'skipped') return `SKIPPED (${tool.reason && tool.reason.includes('not installed') ? 'not installed' : tool.reason})`;
  if (tool.status === 'pending') return 'pending (not built)';
  if (tool.status === 'error') return `ERROR (${(tool.reason || '').slice(0, 60)})`;
  if (tool.status === 'static') {
    return staticMeasured ? render(tool) : `N/A — ${tool.naReason}`;
  }
  return render(tool);
}

function capCell(tool, key) {
  if (tool.status === 'skipped') return 'SKIPPED (not installed)';
  if (tool.status === 'pending') return 'pending (not built)';
  // Capabilities are properties of the tool's model — known even when the
  // sign ceremony cannot run headless (static-only columns).
  return tool.capabilities[key] ? 'yes' : 'N/A — capability absent';
}

function renderTable(tools) {
  const order = ['proofkit', 'checksum', 'cosign-keyless', 'cosign-keypair', 'intoto'];
  const cols = order.map((id) => tools.find((t) => t.id === id));
  const header = '| Metric                          | ProofSeal | checksum script | cosign (keyless) | cosign (keypair) | in-toto |';
  const sep = '|---------------------------------|----------|-----------------|------------------|------------------|---------|';
  const row = (label, fn) => `| ${label} | ${cols.map(fn).join(' | ')} |`;
  return [
    header,
    sep,
    row('Setup steps (count)', (t) => cell(t, (x) => String(x.setup.steps), true)),
    row('Setup time (median, s)', (t) => cell(t, (x) => String(x.setup.medianSeconds))),
    row('Config LOC', (t) => cell(t, (x) => String(x.setup.configLoc), true)),
    row('Secrets to manage (count)', (t) => cell(t, (x) => String(x.setup.secretsCount), true)),
    row('Verify latency p50 / p95 (ms)', (t) => cell(t, (x) => `${x.latency.p50} / ${x.latency.p95}`)),
    // Headline comparable metric: did the tool raise ANY signal on the
    // mutation, under its own semantics (cosign FAIL counts as signaled).
    row('Tamper signaled (% of 45)', (t) => cell(t, (x) => {
      const pctSignaled = Math.round((100 * x.mutations.signaled) / x.mutations.total);
      return `${pctSignaled}% (${x.mutations.signaled}/${x.mutations.total})`;
    })),
    // ProofSeal's OWN four-state taxonomy (pass/drift/regressed/missing) —
    // a capability row, never a competitor score (premortem round 3).
    row('Four-state classification (ProofSeal taxonomy)', (t) => {
      if (t.status === 'skipped') return `SKIPPED (${t.reason && t.reason.includes('not installed') ? 'not installed' : t.reason})`;
      if (t.status === 'pending') return 'pending (not built)';
      if (t.id !== 'proofkit') return 'N/A — taxonomy absent';
      return cell(t, (x) => `${x.mutations.correct}/${x.mutations.total} (${Math.round((100 * x.mutations.correct) / x.mutations.total)}%)`);
    }),
    row('Drift vs regression distinction', (t) => capCell(t, 'driftDistinction')),
    row('Temporal history + bisection', (t) => (t.status === 'skipped' ? 'SKIPPED (not installed)' : t.status === 'pending' ? 'pending (not built)' : t.capabilities.history && t.capabilities.bisection ? 'yes' : 'N/A — capability absent')),
  ].join('\n');
}

function renderSlices(tools, fixtures) {
  const lines = ['## Per-slice breakdown', '', '### Per fixture'];
  for (const f of fixtures) {
    const byType = {};
    for (const c of f.claims) byType[c.type] = (byType[c.type] || 0) + 1;
    lines.push('', `#### ${f.name} (${f.claims.length} claims: ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')})`, '');
    lines.push('| Tool | Verify p50 (ms) | Verify p95 (ms) | Tamper signaled | Four-state classification (ProofSeal taxonomy) |');
    lines.push('|------|-----------------|-----------------|-----------------|------------------------------------------------|');
    for (const t of tools) {
      if (t.status !== 'ok' && t.status !== 'error') {
        const label = t.status === 'pending' ? 'pending (not built)' : t.status === 'static' ? `N/A — ${t.naReason}` : 'SKIPPED';
        lines.push(`| ${t.name} | ${label} | — | — | ${t.id === 'proofkit' ? '—' : 'N/A — taxonomy absent'} |`);
        continue;
      }
      const lat = t.latency.perFixture[f.name] || { p50: '—', p95: '—' };
      const recs = t.mutations.records.filter((r) => r.fixture === f.name);
      const signaled = recs.filter((r) => r.signaled).length;
      const taxonomyCell = t.id === 'proofkit'
        ? `${recs.filter((r) => r.correctClassification).length}/${recs.length}`
        : 'N/A — taxonomy absent';
      lines.push(`| ${t.name} | ${lat.p50} | ${lat.p95} | ${signaled}/${recs.length} | ${taxonomyCell} |`);
    }
  }

  lines.push('', '### Per mutation class (tamper signaled / total)', '');
  const classes = ['manifest-byte', 'marker-removal', 'edit-marker-intact', 'file-deletion'];
  lines.push(`| Tool | ${classes.join(' | ')} |`);
  lines.push(`|------|${classes.map(() => '---').join('|')}|`);
  for (const t of tools) {
    if (t.status !== 'ok' && t.status !== 'error') {
      const label = t.status === 'pending' ? 'pending' : t.status === 'static' ? 'N/A' : 'SKIPPED';
      lines.push(`| ${t.name} | ${classes.map(() => label).join(' | ')} |`);
      continue;
    }
    lines.push(`| ${t.name} | ${classes.map((c) => {
      const b = t.mutations.byClass[c];
      return b ? `${b.signaled}/${b.total}` : '—';
    }).join(' | ')} |`);
  }
  const pk = tools.find((t) => t.id === 'proofkit');
  if (pk && (pk.status === 'ok' || pk.status === 'error') && pk.mutations.total) {
    lines.push('');
    lines.push(`ProofSeal additionally classified ${pk.mutations.correct}/${pk.mutations.total} mutations into its four-state taxonomy`);
    lines.push(`(per class, correct/total: ${classes.map((c) => {
      const b = pk.mutations.byClass[c];
      return b ? `${c} ${b.correct}/${b.total}` : `${c} —`;
    }).join(', ')}). The taxonomy is ProofSeal-specific, so competitors carry no classification score.`);
  }

  lines.push('', '### Per claim type (workload composition)', '');
  const typeTotals = {};
  for (const f of fixtures) for (const c of f.claims) typeTotals[c.type] = (typeTotals[c.type] || 0) + 1;
  lines.push('| Claim type | Count (all fixtures) | Expressible by checksum | by cosign | by in-toto | by ProofSeal |');
  lines.push('|------------|----------------------|-------------------------|-----------|------------|-------------|');
  lines.push(`| file-hash | ${typeTotals['file-hash'] || 0} | yes | yes (signed blob) | yes (artifact rule) | yes |`);
  lines.push(`| marker | ${typeTotals['marker'] || 0} | yes (grep loop) | N/A — capability absent | N/A — capability absent | yes |`);
  lines.push(`| harness | ${typeTotals['harness'] || 0} | N/A — capability absent (hashes the script file only) | N/A — capability absent | N/A — capability absent | yes |`);
  return lines.join('\n');
}

function renderFailureSamples(tools) {
  // Each tool is judged on ITS OWN semantics: a hard FAIL on a benign append
  // is CORRECT for a byte-integrity tool (cosign/checksum/in-toto). The only
  // failure mode for a competitor here is "NOT SIGNALED". ProofSeal alone is
  // additionally judged on its own four-state taxonomy.
  const lines = ['## Sample annotations', ''];
  let any = false;
  for (const t of tools) {
    if (t.status !== 'ok' && t.status !== 'error') continue;
    any = true;
    lines.push(`### ${t.name}`, '');
    const missed = t.mutations.records.filter((r) => !r.signaled);
    const misclassified = t.id === 'proofkit'
      ? t.mutations.records.filter((r) => r.signaled && r.correctClassification === false)
      : [];
    if (!missed.length && !misclassified.length) {
      lines.push(t.id === 'proofkit'
        ? `- All ${t.mutations.total} mutations signaled and correctly classified under the four-state taxonomy.`
        : `- All ${t.mutations.total} mutations signaled under ${t.name}'s own semantics.`);
    }
    for (const r of missed.slice(0, 5)) {
      lines.push(`- **${r.id}** (\`${r.class}\` on \`${r.target}\`, ${r.fixture}): NOT SIGNALED — no problem reported.`);
      if (r.output) lines.push(`  - output: \`${r.output.replace(/\n/g, ' ').replace(/`/g, "'").slice(0, 180)}\``);
    }
    for (const r of misclassified.slice(0, 5)) {
      lines.push(`- **${r.id}** (\`${r.class}\` on \`${r.target}\`, ${r.fixture}): signaled, but classified \`${r.observed}\` where the taxonomy expects \`${r.proofsealExpectedClass}\`.`);
      if (r.output) lines.push(`  - output: \`${r.output.replace(/\n/g, ' ').replace(/`/g, "'").slice(0, 180)}\``);
    }
    if (t.id !== 'proofkit') {
      const driftExample = t.mutations.records.find((r) => r.class === 'edit-marker-intact' && r.signaled);
      if (driftExample) {
        lines.push(`- Context — **${driftExample.id}** (\`edit-marker-intact\` on \`${driftExample.target}\`, ${driftExample.fixture}): signaled as \`${driftExample.observed}\`. That is CORRECT under ${t.name}'s security model (any byte change breaks integrity); the drift/regression distinction is a ProofSeal capability, not an error here.`);
      }
    }
    lines.push('');
  }
  if (!any) lines.push('_No tool produced mutation results in this run (all skipped or pending)._');
  return lines.join('\n');
}

function renderReport(provenance, tools, fixtures, mutations, incomplete, selfCheckProblems, wallClockSeconds) {
  const md = [];
  md.push(`# ProofSeal v0.1 Benchmark Report${incomplete ? ' — **INCOMPLETE**' : ''}`);
  md.push('');
  if (incomplete) {
    const pk = tools.find((t) => t.id === 'proofkit');
    md.push(`> **INCOMPLETE:** the ProofSeal column is ${pk.status} — ${(pk.reason || 'unknown').replace(/\n/g, ' ')}`);
    md.push('> Fix the above (build ProofSeal with `npm run build` if missing) and re-run `node bench/run.mjs`.');
    md.push('> Per ADR-0001 the README claim may ONLY be copy-pasted from a COMPLETE report.');
    md.push('');
  }
  md.push('Benchmark definition: ADR-0001 §3. Honest-comparison policy: ADR D12 — capability');
  md.push('gaps are recorded as "N/A — capability absent" and missing tools as explicit SKIPPED');
  md.push('cells, never silent omissions.');
  md.push('');
  md.push('## Provenance');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify({ ...provenance, wallClockSeconds, mutationCount: mutations.length }, null, 2));
  md.push('```');
  md.push('');
  md.push('## Tool availability');
  md.push('');
  md.push('| Tool | Status | Version / reason |');
  md.push('|------|--------|------------------|');
  for (const t of tools) {
    const detail = (t.status === 'ok' ? (t.version || '') : (t.reason || '')).replace(/\n/g, ' ').replace(/\|/g, '/');
    md.push(`| ${t.name} | ${t.status} | ${detail} |`);
  }
  md.push('');
  md.push('## Comparison table (ADR §3.4)');
  md.push('');
  md.push(renderTable(tools));
  md.push('');
  md.push('Notes:');
  md.push(`- Mutation suite: ${mutations.length} seeded mutations (seed ${MUTATION_SEED}), committed at \`bench/mutations/mutations.json\`.`);
  md.push('- **Tamper signaled** is the only cross-tool score: did the tool raise ANY signal');
  md.push('  on the mutation, judged under the tool\'s OWN semantics. A cosign or checksum');
  md.push('  hard FAIL on a benign append is CORRECT for a byte-integrity model and counts');
  md.push('  as signaled — it is never stamped "misclassified".');
  md.push('- **Four-state classification** (pass / drift / regressed / missing) is ProofSeal\'s');
  md.push('  OWN taxonomy. It is scored for ProofSeal only; competitors read');
  md.push('  "N/A — taxonomy absent" because grading them on a rubric only ProofSeal');
  md.push('  subscribes to would be a self-serving metric (premortem round 3 finding).');
  md.push('- checksum script: `SHA256SUMS` is generated over ALL git-tracked fixture files');
  md.push('  (practitioner-grade `git ls-files` coverage). Caveat: it is not tamper-evident —');
  md.push('  an attacker who can edit files can regenerate it. The manifest-byte class only');
  md.push('  measures accidental corruption for B1, not adversarial resistance.');
  md.push('');
  md.push(renderSlices(tools, fixtures));
  md.push('');
  md.push(renderFailureSamples(tools));
  if (selfCheckProblems.length) {
    md.push('', '## Fixture self-check problems', '');
    for (const p of selfCheckProblems) md.push(`- ${p}`);
  }
  md.push('');
  return md.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = process.hrtime.bigint();
  const provenance = await gatherProvenance();
  log(`node ${provenance.node} on ${provenance.os.platform}/${provenance.os.arch}; git sha: ${provenance.gitSha}`);

  const fixtures = FIXTURES.map(loadFixture);
  const mutationsDoc = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'mutations', 'mutations.json'), 'utf8'));
  if (mutationsDoc.seed !== MUTATION_SEED) throw new Error(`mutations.json seed ${mutationsDoc.seed} != ${MUTATION_SEED}`);
  const mutations = mutationsDoc.mutations;
  if (mutations.length < 40) throw new Error(`mutation suite must have >= 40 entries, has ${mutations.length}`);
  log(`${fixtures.length} fixtures x 100 claims; ${mutations.length} mutations (seed ${MUTATION_SEED})`);

  const pythonAvailable = provenance.python3 !== 'not installed';
  const selfCheckProblems = await selfCheckFixtures(fixtures, pythonAvailable);
  if (selfCheckProblems.length) {
    for (const p of selfCheckProblems) console.error('[bench] FIXTURE INTEGRITY:', p);
    throw new Error('fixture self-check failed — regenerate fixtures with node bench/fixtures/generate.mjs');
  }
  log('fixture integrity self-check passed (file hashes + harness expected outputs)');

  const toolResults = [];
  for (const tool of TOOLS) {
    toolResults.push(await benchTool(tool, fixtures, mutations));
  }

  const proofkitResult = toolResults.find((t) => t.id === 'proofkit');
  const incomplete = proofkitResult.status !== 'ok';
  const wallClockSeconds = round(Number(process.hrtime.bigint() - t0) / 1e9, 1);

  const resultsDir = path.join(BENCH_DIR, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportJson = {
    incomplete,
    provenance: { ...provenance, wallClockSeconds, finishedAt: new Date().toISOString() },
    fixtures: fixtures.map((f) => ({ name: f.name, claims: f.claims.length })),
    mutationCount: mutations.length,
    tools: toolResults,
    selfCheckProblems,
  };
  fs.writeFileSync(path.join(resultsDir, 'report.json'), JSON.stringify(reportJson, null, 2) + '\n');
  fs.writeFileSync(
    path.join(resultsDir, 'report.md'),
    renderReport(provenance, toolResults, fixtures, mutations, incomplete, selfCheckProblems, wallClockSeconds),
  );
  // comparison-table.md: JUST the final §3.4 table (consumed by the README
  // pipeline — same provenance as report.md, regenerated together).
  fs.writeFileSync(path.join(resultsDir, 'comparison-table.md'), renderTable(toolResults) + '\n');
  log(`wrote bench/results/report.md, comparison-table.md and report.json (wall-clock ${wallClockSeconds}s)`);
  if (incomplete) log('REPORT IS INCOMPLETE — ProofSeal column pending (not built).');
}

main().catch((e) => {
  console.error('[bench] FATAL:', e.message);
  process.exit(2);
});
