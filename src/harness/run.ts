/**
 * Deterministic-output harness runner (ADR-0001 D9, RuView verify.py port).
 *
 * Spawns the harness command with PROOFSEAL_SEED in the environment,
 * parses numeric output from stdout, quantizes (round-half-even, N
 * decimals), packs LE float64, streams SHA-256, and renders a dual
 * verdict: bit-exact hash match OR rtol/atol tolerance vs a committed
 * reference vector (JSON array of numbers).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allClose,
  hashQuantized,
  quantizeValues,
  DEFAULT_DECIMALS,
  DEFAULT_TOLERANCE,
  type AllCloseResult,
} from './quantize.js';

export interface HarnessDef {
  name: string;
  /** Shell command; spawned with PROOFSEAL_SEED set. */
  cmd: string;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  seed?: number;
  quantizeDecimals?: number;
  /** Named output blocks to skip when stdout is a JSON object (pitfall 6). */
  exclude?: string[];
  /** Committed expectation hash; absent = no expectation yet. */
  expectedSha256?: string;
  /** Path to committed JSON array of full-precision reference numbers. */
  referenceVector?: string;
  tolerance?: { rtol: number; atol: number };
  timeoutMs?: number;
}

export type HarnessStatus = 'pass' | 'drift' | 'regressed' | 'missing' | 'error';

export interface HarnessResult {
  name: string;
  status: HarnessStatus;
  /** sha256 of quantized LE-f64 output (present when the run produced output). */
  hash?: string;
  expectedSha256?: string;
  hashMatch?: boolean;
  toleranceMatch?: boolean;
  forensics?: AllCloseResult;
  /** Full-precision parsed values (for --update reference regeneration). */
  values?: number[];
  quantized?: number[];
  seed: number;
  quantizeDecimals: number;
  exitCode: number | null;
  error?: string;
  /**
   * The harness command itself could not be found (spawn ENOENT or shell
   * exit 127). CI footgun: a missing interpreter is an environment
   * precondition, not a regression.
   */
  commandNotFound?: boolean;
  /**
   * A referenceVector path is declared but the file is absent at run time.
   * CI footgun: the seal outputs were probably never committed.
   */
  referenceVectorMissing?: boolean;
}

/**
 * Parse numeric output from harness stdout.
 * Accepted shapes:
 *  - JSON array of numbers (arbitrarily nested) → flattened in order
 *  - JSON object of named numeric blocks → keys sorted, excluded keys
 *    skipped, values flattened
 *  - plain whitespace/comma-separated numbers
 */
export function parseNumericOutput(stdout: string, exclude: string[] = []): number[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return flattenNumbers(parsed, exclude);
  } catch {
    return text
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }
}

function flattenNumbers(value: unknown, exclude: string[]): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => flattenNumbers(v, exclude));
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .filter((k) => !exclude.includes(k))
      .flatMap((k) => flattenNumbers(obj[k], exclude));
  }
  return [];
}

function execHarness(
  def: HarnessDef,
  seed: number,
): Promise<{ stdout: string; exitCode: number | null; error?: string; commandNotFound?: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(def.cmd, {
      shell: true,
      cwd: def.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PROOFSEAL_SEED: String(seed),
        // Legacy alias kept one release for harnesses written pre-rename
        // (and the bench fixtures); PROOFSEAL_SEED is the documented name.
        PROOFKIT_SEED: String(seed),
      },
      timeout: def.timeoutMs ?? 120_000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('error', (err) =>
      resolvePromise({
        stdout,
        exitCode: null,
        error: err.message,
        commandNotFound: (err as NodeJS.ErrnoException).code === 'ENOENT',
      }),
    );
    child.on('close', (code) =>
      // shell:true means "command not found" surfaces as exit 127 on POSIX
      // (cmd.exe uses other codes; the ENOENT path above covers direct spawn).
      resolvePromise({ stdout, exitCode: code, commandNotFound: code === 127 }),
    );
  });
}

/** Run a harness and render the dual hash/tolerance verdict. */
export async function runHarness(def: HarnessDef): Promise<HarnessResult> {
  const seed = def.seed ?? 42;
  const decimals = def.quantizeDecimals ?? DEFAULT_DECIMALS;
  const base = { name: def.name, seed, quantizeDecimals: decimals };

  const run = await execHarness(def, seed);
  if (run.error || run.exitCode !== 0) {
    return {
      ...base,
      status: 'error',
      exitCode: run.exitCode,
      error: run.error ?? `harness exited with code ${run.exitCode}`,
      ...(run.commandNotFound ? { commandNotFound: true } : {}),
    };
  }

  const values = parseNumericOutput(run.stdout, def.exclude ?? []);
  const quantized = quantizeValues(values, decimals);
  const hash = hashQuantized(values, decimals);

  if (!def.expectedSha256) {
    return { ...base, status: 'missing', exitCode: run.exitCode, hash, values, quantized, error: 'no committed expectedSha256 — run `proofseal harness run --update`' };
  }

  const hashMatch = hash === def.expectedSha256;
  if (hashMatch) {
    return { ...base, status: 'pass', exitCode: run.exitCode, hash, expectedSha256: def.expectedSha256, hashMatch, values, quantized };
  }

  // Tolerance fallback against the committed full-precision reference vector.
  let toleranceMatch = false;
  let forensics: AllCloseResult | undefined;
  let referenceVectorMissing = false;
  if (def.referenceVector) {
    const refPath = resolve(def.cwd ?? process.cwd(), def.referenceVector);
    if (existsSync(refPath)) {
      const reference = JSON.parse(readFileSync(refPath, 'utf8')) as number[];
      const tol = def.tolerance ?? DEFAULT_TOLERANCE;
      forensics = allClose(values, reference, tol.rtol, tol.atol);
      toleranceMatch = forensics.ok;
    } else {
      // Declared but absent — almost always "seal outputs never committed".
      referenceVectorMissing = true;
    }
  }

  return {
    ...(referenceVectorMissing ? { referenceVectorMissing: true } : {}),
    ...base,
    status: toleranceMatch ? 'drift' : 'regressed',
    exitCode: run.exitCode,
    hash,
    expectedSha256: def.expectedSha256,
    hashMatch,
    toleranceMatch,
    forensics,
    values,
    quantized,
  };
}
