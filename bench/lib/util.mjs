// bench/lib/util.mjs — shared helpers for the ProofKit benchmark suite.
// Plain Node ESM, zero npm dependencies. ADR-0001 §3.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Seeded PRNG — Park–Miller LCG (deterministic across platforms; integers
// stay < 2^53 so plain JS number arithmetic is exact).
// ---------------------------------------------------------------------------
export const LCG_M = 2147483647; // 2^31 - 1
export const LCG_A = 48271;

export function makeRng(seed) {
  let state = (Math.trunc(seed) % (LCG_M - 1)) + 1;
  if (state <= 0) state += LCG_M - 1;
  return {
    nextInt() {
      state = (state * LCG_A) % LCG_M;
      return state;
    },
    nextFloat() {
      return this.nextInt() / LCG_M;
    },
    int(maxExclusive) {
      return this.nextInt() % maxExclusive;
    },
    pick(arr) {
      return arr[this.int(arr.length)];
    },
  };
}

// Quantize per ADR D9: N decimals via integer half-up rounding (identical
// double ops in JS and Python), then LE f64 packing → sha256.
export function quantize(value, decimals = 6) {
  const f = 10 ** decimals;
  return Math.floor(value * f + 0.5) / f;
}

export function packLEf64(values) {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => buf.writeDoubleLE(v, i * 8));
  return buf;
}

export function harnessHash(values, decimals = 6) {
  return sha256Bytes(packLEf64(values.map((v) => quantize(v, decimals))));
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath)); // bytes, never text mode (ADR R2)
}

// ---------------------------------------------------------------------------
// Process execution — execFile only, never shell-string interpolation.
// ---------------------------------------------------------------------------
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        timeout: opts.timeoutMs ?? 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          ms,
          error: error ? String(error.message).slice(0, 400) : null,
        });
      },
    );
  });
}

export async function which(tool) {
  const probe = await run(process.platform === 'win32' ? 'where' : 'which', [tool]);
  return probe.ok ? probe.stdout.trim().split('\n')[0] : null;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------
export function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

export function freshTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `proofkit-bench-${label}-`));
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function writeFileEnsured(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode) fs.chmodSync(filePath, mode);
}

export function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

// Config LOC = non-blank, non-comment lines the maintainer authors (ADR §3.2.3).
export function countConfigLoc(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//')).length;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
export function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const idx = Math.min(sortedAscending.length - 1, Math.ceil((p / 100) * sortedAscending.length) - 1);
  return sortedAscending[Math.max(0, idx)];
}

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function round(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Git helpers (fixtures are git-initialized in temp dirs; ProofKit keys are
// commit-bound so a commit must exist).
// ---------------------------------------------------------------------------
export async function gitInitCommit(dir) {
  const cfg = ['-c', 'user.email=bench@proofkit.invalid', '-c', 'user.name=proofkit-bench', '-c', 'commit.gpgsign=false'];
  let r = await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (!r.ok) return r;
  r = await run('git', [...cfg, 'add', '-A'], { cwd: dir });
  if (!r.ok) return r;
  r = await run('git', [...cfg, 'commit', '-q', '-m', 'bench fixture seal point'], { cwd: dir });
  return r;
}
