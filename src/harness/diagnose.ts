/**
 * Harness nondeterminism diagnostic — run a harness N times serially,
 * line-up the outputs, classify every span that varies between runs by
 * which starter normalizer would mask it (single source of truth: same
 * classifySpan() the apply path uses).
 *
 * Read-only. Never writes anything to disk; never mutates the claim;
 * never exits non-zero. The output is a TRIAGE REPORT, not a verdict —
 * the user decides which normalizers to opt in to.
 *
 * Design choices:
 *   1. Serial execution. A stateful harness (write-then-read a temp file,
 *      claim a port, hit a shared cache) run concurrently can produce
 *      FALSE nondeterminism just from the race. Serial mirrors how seal
 *      and verify actually invoke the harness.
 *   2. Line-aligned diff. We compare line-by-line at the same index
 *      across runs. A harness whose line count is itself unstable is
 *      reported as such (`lineCountUnstable: true`) and span analysis
 *      is skipped for those runs — there is no honest "varying span"
 *      when the lines don't even align.
 *   3. Unclassified spans are reported faithfully. If the starter
 *      normalizer set doesn't match, the user has nondeterminism the
 *      tool cannot mask — that is the signal, not a failure.
 *   4. Float-precision hint. We don't ship a `float-precision` named
 *      normalizer (quantizeDecimals already handles it once). But a
 *      varying numeric token IS a common case, so the diagnose layer
 *      surfaces it as a HINT: "looks like floats varying below your
 *      quantizeDecimals — consider raising decimals or check tolerance".
 */
import { spawn } from 'node:child_process';
import { classifySpan, type NormalizerName } from './normalize.js';

export interface DiagnoseOptions {
  /** Repo root / harness cwd. */
  cwd: string;
  /** Harness command (same as the claim's cmd). */
  cmd: string;
  /** Seed passed through PROOFSEAL_SEED (matches seal/verify env). */
  seed: number;
  /** Number of times to run the harness. Default 5. */
  runs?: number;
  /** Per-run timeout in ms. Default 120s, same as runHarness. */
  timeoutMs?: number;
}

export interface VaryingSpan {
  /** 0-based line index where the variation was found. */
  line: number;
  /** Sample values seen at this position across runs (deduped, in run order). */
  samples: string[];
  /** Which normalizer would mask this, or null if none apply. */
  classification: NormalizerName | 'float-hint' | null;
}

export interface DiagnoseResult {
  runs: number;
  /** True if every run produced byte-identical stdout — no nondeterminism. */
  deterministic: boolean;
  /** True if line counts varied across runs (alignment broke). */
  lineCountUnstable?: boolean;
  /** Per-run stdout line counts (helps users spot lineCountUnstable). */
  lineCounts: number[];
  /** Spans that varied (empty when deterministic). */
  varyingSpans: VaryingSpan[];
  /** Spans the starter normalizer set didn't classify — the "you have a real one" signal. */
  unclassifiedCount: number;
  /** Recommended normalizer set to add to the claim (deduped, sorted). */
  recommended: NormalizerName[];
  /** Free-form hints (e.g. "floats varying below quantizeDecimals — raise it"). */
  hints: string[];
  /** Errors from individual runs (e.g. exit non-zero), captured per-run. */
  runErrors: Array<{ runIndex: number; exitCode: number | null; error?: string }>;
}

function execOnce(opts: DiagnoseOptions): Promise<{ stdout: string; exitCode: number | null; error?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(opts.cmd, {
      shell: true,
      cwd: opts.cwd,
      env: {
        ...process.env,
        PROOFSEAL_SEED: String(opts.seed),
        PROOFKIT_SEED: String(opts.seed),
      },
      timeout: opts.timeoutMs ?? 120_000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('error', (err) => resolvePromise({ stdout, exitCode: null, error: err.message }));
    child.on('close', (code) => resolvePromise({ stdout, exitCode: code }));
  });
}

/** Number tokens separated by whitespace/commas — used for the float hint. */
function looksLikeFloatToken(s: string): boolean {
  return /^-?\d+\.\d+$/.test(s.trim()) || /^-?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(s.trim());
}

/**
 * Run N times serially and produce a triage report. Never throws on harness
 * failure — captures errors per-run so the user sees "your harness exited
 * 1 on run 3" rather than the diagnose tool blowing up.
 */
export async function diagnose(opts: DiagnoseOptions): Promise<DiagnoseResult> {
  const runCount = opts.runs ?? 5;
  const outputs: string[] = [];
  const runErrors: DiagnoseResult['runErrors'] = [];
  for (let i = 0; i < runCount; i++) {
    const r = await execOnce(opts);
    if (r.error || r.exitCode !== 0) {
      runErrors.push({ runIndex: i, exitCode: r.exitCode, error: r.error ?? `exit ${r.exitCode}` });
    }
    outputs.push(r.stdout);
  }

  if (outputs.every((s) => s === outputs[0])) {
    return {
      runs: runCount,
      deterministic: true,
      lineCounts: outputs.map((s) => s.split('\n').length),
      varyingSpans: [],
      unclassifiedCount: 0,
      recommended: [],
      hints: [],
      runErrors,
    };
  }

  const lineGrid = outputs.map((s) => s.split('\n'));
  const lineCounts = lineGrid.map((g) => g.length);
  const lineCountUnstable = new Set(lineCounts).size > 1;

  const varyingSpans: VaryingSpan[] = [];
  const recommended = new Set<NormalizerName>();
  const hints = new Set<string>();
  let unclassifiedCount = 0;

  if (!lineCountUnstable) {
    const lineCount = lineCounts[0];
    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
      const lineSamples = lineGrid.map((g) => g[lineIdx]);
      const distinct = Array.from(new Set(lineSamples));
      if (distinct.length === 1) continue;

      // Try to classify the varying line by feeding the concatenation of
      // distinct samples to classifySpan — picks up any pattern visible in
      // any of the variants.
      const probe = distinct.join('\n');
      const cls = classifySpan(probe);

      if (cls) {
        varyingSpans.push({ line: lineIdx, samples: distinct, classification: cls });
        recommended.add(cls);
        continue;
      }

      // Float-hint fallback — varying tokens that look like floats are the
      // "raise quantizeDecimals or tighten tolerance" path, not a named
      // normalizer.
      const allFloatLike = distinct.every((s) =>
        s
          .split(/[\s,]+/)
          .filter((t) => t.length > 0)
          .some(looksLikeFloatToken),
      );
      if (allFloatLike) {
        varyingSpans.push({ line: lineIdx, samples: distinct, classification: 'float-hint' });
        hints.add(
          'floats vary across runs — if the variation is below your quantizeDecimals it is harmless; otherwise raise quantizeDecimals or use --tolerance',
        );
        continue;
      }

      varyingSpans.push({ line: lineIdx, samples: distinct, classification: null });
      unclassifiedCount++;
    }
  }

  if (lineCountUnstable) {
    hints.add(
      'line counts differ between runs — the starter normalizers cannot mask structural variation; investigate the harness itself',
    );
  }
  if (unclassifiedCount > 0) {
    hints.add(
      `${unclassifiedCount} varying span(s) did not match any starter normalizer — investigate (or write a custom mask in the harness itself)`,
    );
  }
  if (runErrors.length > 0) {
    hints.add(
      `${runErrors.length} of ${runCount} runs exited non-zero — diagnose is reporting on the runs that completed; fix the harness errors first`,
    );
  }

  return {
    runs: runCount,
    deterministic: false,
    ...(lineCountUnstable ? { lineCountUnstable: true } : {}),
    lineCounts,
    varyingSpans,
    unclassifiedCount,
    recommended: Array.from(recommended).sort(),
    hints: Array.from(hints),
    runErrors,
  };
}
