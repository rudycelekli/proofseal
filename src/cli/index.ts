#!/usr/bin/env node
/**
 * ProofSeal CLI — thin wrapper over the library API (ADR-0001 §4.1).
 * Exit-code contract: 0 ok/drift · 1 regressed/missing/seal-mismatch · 2 precondition.
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { seal } from '../manifest/seal.js';
import { verify, toVerifyJson } from '../manifest/verify.js';
import { lintMarker } from '../core/marker-lint.js';
import { ClaimSchema } from '../manifest/schema.js';
import { loadHistory } from '../history/jsonl.js';
import {
  fixTimeline,
  diffLatest,
  findRegressionIntroductions,
  findStaleClaims,
  DEFAULT_STALE_COMMITS,
  DEFAULT_STALE_DAYS,
} from '../history/queries.js';
import { enrichRegressionsWithGit, UNREACHABLE_TAG } from '../history/gitinfo.js';
import { runHarness } from '../harness/run.js';
import { DEFAULT_TOLERANCE } from '../harness/quantize.js';
import { loadConfig, saveConfig, defaultConfig, configPathFor } from '../config.js';
import type { Claim, HarnessClaim } from '../manifest/schema.js';
import { suggestClaims } from '../suggest/suggest.js';
import { startMcpServer } from '../mcp/server.js';
import { VERSION } from '../version.js';

const program = new Command();
program.name('proofseal').description('Regression memory for coding agents — seal repo behavior, verify edits over MCP or in CI').version(VERSION);

function emit(json: boolean, data: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

function fail(json: boolean, code: number, message: string): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`proofseal: ${message}`);
  process.exit(code);
}

// ─── init ───────────────────────────────────────────────────────────
program
  .command('init')
  .description('Scaffold proofseal.json + proofs/ + a working sample claim')
  .option('--root <path>', 'repo root', '.')
  .option('--force', 'overwrite an existing proofseal.json')
  .option('--json', 'machine-readable output')
  .action((opts: { root: string; force?: boolean; json?: boolean }) => {
    const root = resolve(opts.root);
    const configPath = configPathFor(root);
    if (existsSync(configPath) && !opts.force) {
      fail(!!opts.json, 2, `${configPath} already exists — pass --force to overwrite`);
    }
    const config = defaultConfig(root);
    saveConfig(root, config);
    mkdirSync(join(root, 'proofs'), { recursive: true });
    // Platform honesty (premortem #3): without a .gitattributes, git autocrlf
    // can rewrite line endings per-OS and silently change file hashes. And
    // history-semantics (premortem: concurrent seals): two branches sealing
    // both append to proofs/history.jsonl — `merge=union` keeps both lines on
    // merge, and queries order by issuedAt so interleaving is safe. Print
    // guidance only — never write the file for the user.
    const historyRel = config.history ?? 'proofs/history.jsonl';
    const unionLine = `${historyRel} merge=union`;
    const gitattributesPath = join(root, '.gitattributes');
    let gitattributesHint: string | undefined;
    if (!existsSync(gitattributesPath)) {
      gitattributesHint = `no .gitattributes found — consider adding \`* text=auto eol=lf\` (so git autocrlf cannot rewrite line endings per-OS and change file hashes) and \`${unionLine}\` (so seals from two branches merge without conflict; entries are ordered by issuedAt)`;
    } else if (!readFileSync(gitattributesPath, 'utf8').includes('merge=union')) {
      gitattributesHint = `consider adding \`${unionLine}\` to .gitattributes so seals from two branches merge without conflict (entries are ordered by issuedAt, so union-merge interleaving is safe)`;
    }
    emit(
      !!opts.json,
      {
        ok: true,
        configPath,
        claims: config.claims.length,
        ...(gitattributesHint ? { gitattributesHint } : {}),
      },
      () => {
        console.log(`Initialized ${configPath}`);
        if (gitattributesHint) console.log(`hint: ${gitattributesHint}`);
        console.log('Next: proofseal seal && proofseal verify');
      },
    );
  });

// ─── claim add | list | rm ─────────────────────────────────────────
const claim = program.command('claim').description('Manage claim entries');

/** Marker lint (premortem #7): advisory only — warnings, never failures. */
function lintMarkerClaim(root: string, entry: Claim): string[] {
  if (entry.type !== 'marker') return [];
  const abs = join(root, entry.file);
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  return lintMarker(entry.marker, text);
}

/**
 * Map a batch-file entry onto the config claim shape (`name` is accepted as
 * an alias for `harness`; harness defaults to the claim id, like the flags).
 */
function normalizeBatchEntry(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'harness') return raw;
  const { name, ...rest } = r;
  return {
    ...rest,
    harness: r.harness ?? name ?? r.id,
    seed: r.seed ?? 42,
    quantizeDecimals: r.quantizeDecimals ?? 6,
  };
}

/** Batch authoring: validate ALL entries before adding ANY (all-or-nothing). */
function claimAddFromFile(json: boolean, root: string, config: ReturnType<typeof loadConfig>['config'], fromFile: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(root, fromFile), 'utf8'));
  } catch (e) {
    fail(json, 2, `could not read ${fromFile}: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) fail(json, 2, `${fromFile} must contain a JSON array of claim objects`);

  const errors: string[] = [];
  const entries: Claim[] = [];
  const seen = new Set(config.claims.map((c) => c.id));
  (parsed as unknown[]).forEach((raw, i) => {
    const res = ClaimSchema.safeParse(normalizeBatchEntry(raw));
    if (!res.success) {
      const reasons = res.error.issues
        .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
        .join('; ');
      errors.push(`[${i}] invalid claim: ${reasons}`);
      return;
    }
    if (seen.has(res.data.id)) {
      errors.push(`[${i}] duplicate claim id '${res.data.id}' (already in the file or in proofseal.json)`);
      return;
    }
    seen.add(res.data.id);
    entries.push(res.data);
  });
  if (errors.length > 0) {
    fail(json, 2, `--from-file rejected (no claims were added):\n  ${errors.join('\n  ')}`);
  }

  const warnings: string[] = [];
  for (const entry of entries) {
    for (const w of lintMarkerClaim(root, entry)) warnings.push(`[${entry.id}] ${w}`);
  }
  config.claims.push(...entries);
  saveConfig(root, config);
  for (const w of warnings) console.warn(`warning: ${w}`);
  emit(json, { ok: true, added: entries.length, ids: entries.map((e) => e.id), warnings }, () =>
    console.log(`Added ${entries.length} claims`),
  );
}

claim
  .command('add')
  .option('--id <id>', 'claim id')
  .option('--type <type>', 'file-hash | marker | harness')
  .option('--file <path>', 'file the claim covers (file-hash, marker)')
  .option('--marker <substring>', 'distinctive substring (marker)')
  .option('--name <name>', 'harness name (defaults to the claim id)')
  .option('--cmd <command>', 'harness command (harness)')
  .option('--seed <n>', 'harness seed', '42')
  .option('--quantize-decimals <n>', 'quantize decimals', '6')
  .option('--desc <text>', 'claim description')
  .option('--from-file <path>', 'JSON array of claim objects — all-or-nothing batch add')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action((o: Record<string, string | undefined>) => {
    const json = o.json !== undefined;
    try {
      const { root, config } = loadConfig(o.root ?? '.');
      if (o.fromFile) {
        claimAddFromFile(json, root, config, o.fromFile);
        return;
      }
      if (!o.id || !o.type) fail(json, 2, '--id and --type are required (or use --from-file <path>)');
      if (config.claims.some((c) => c.id === o.id)) fail(json, 2, `claim '${o.id}' already exists`);
      let entry: Claim;
      if (o.type === 'file-hash') {
        if (!o.file) fail(json, 2, '--file required for file-hash claims');
        entry = { id: o.id!, type: 'file-hash', file: o.file!, desc: o.desc };
      } else if (o.type === 'marker') {
        if (!o.file || !o.marker) fail(json, 2, '--file and --marker required for marker claims');
        entry = { id: o.id!, type: 'marker', file: o.file!, marker: o.marker!, desc: o.desc };
      } else if (o.type === 'harness') {
        if (!o.cmd) fail(json, 2, '--cmd required for harness claims');
        entry = {
          id: o.id!,
          type: 'harness',
          harness: o.name ?? o.id!,
          cmd: o.cmd!,
          seed: Number(o.seed ?? 42),
          quantizeDecimals: Number(o.quantizeDecimals ?? 6),
          desc: o.desc,
        };
      } else {
        fail(json, 2, `unknown claim type '${o.type}' (expected file-hash | marker | harness)`);
      }
      const warnings = lintMarkerClaim(root, entry!);
      config.claims.push(entry!);
      saveConfig(root, config);
      for (const w of warnings) console.warn(`warning: ${w}`);
      emit(json, { ok: true, claim: entry!, warnings }, () => console.log(`Added claim '${o.id}' (${o.type})`));
    } catch (e) {
      fail(json, 2, (e as Error).message);
    }
  });

claim
  .command('list')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action((o: { root: string; json?: boolean }) => {
    try {
      const { config } = loadConfig(o.root);
      emit(!!o.json, { ok: true, claims: config.claims }, () => {
        for (const c of config.claims) {
          const target = c.type === 'harness' ? c.cmd : c.file;
          console.log(`${c.id}\t${c.type}\t${target}${c.desc ? `\t${c.desc}` : ''}`);
        }
        if (config.claims.length === 0) console.log('(no claims)');
      });
    } catch (e) {
      fail(!!o.json, 2, (e as Error).message);
    }
  });

claim
  .command('rm <id>')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action((id: string, o: { root: string; json?: boolean }) => {
    try {
      const { root, config } = loadConfig(o.root);
      const before = config.claims.length;
      config.claims = config.claims.filter((c) => c.id !== id);
      if (config.claims.length === before) fail(!!o.json, 2, `claim '${id}' not found`);
      saveConfig(root, config);
      emit(!!o.json, { ok: true, removed: id }, () => console.log(`Removed claim '${id}'`));
    } catch (e) {
      fail(!!o.json, 2, (e as Error).message);
    }
  });

// ─── seal ───────────────────────────────────────────────────────────
program
  .command('seal')
  .description('Refresh claims, derive commit-bound key, seal manifest, append history')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action(async (o: { root: string; json?: boolean }) => {
    try {
      const result = await seal({ root: o.root });
      emit(!!o.json, { ok: result.ok, summary: result.summary, manifestPath: result.manifestPath, manifestHash: result.witness.integrity.manifestHash, warnings: result.warnings, filesWritten: result.filesWritten }, () => {
        console.log(`Sealed ${result.manifestPath}`);
        console.log(`claims: ${result.summary.totalClaims}  verified: ${result.summary.verified}  missing: ${result.summary.missing}`);
        for (const w of result.warnings) console.warn(`warning [${w.id}]: ${w.message}`);
        // CI footgun pack (premortem #5): verify on a clean clone only works
        // if every seal output is committed — print the checklist explicitly.
        console.log('');
        console.log('Seal complete. Now commit these files:');
        for (const f of result.filesWritten) console.log(`  ${f}`);
      });
      process.exit(result.ok ? 0 : 1);
    } catch (e) {
      fail(!!o.json, 2, (e as Error).message);
    }
  });

// ─── verify ─────────────────────────────────────────────────────────
program
  .command('verify')
  .description('Verify the integrity seal + classify every claim (pass/drift/regressed/missing)')
  .option('--manifest <path>', 'manifest path')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .option('--require-signed', 'fail unless the manifest was sealed with a real key (signerMode=key)')
  .option('--pubkey <hex>', 'fail unless the manifest public key equals this pinned 64-hex key (TOFU authentication)')
  .action(async (o: { manifest?: string; root: string; json?: boolean; requireSigned?: boolean; pubkey?: string }) => {
    const result = await verify({
      root: o.root,
      manifestPath: o.manifest,
      requireSigned: o.requireSigned,
      pinnedPublicKey: o.pubkey,
    });
    emit(!!o.json, toVerifyJson(result), () => {
      if (result.precondition) {
        console.error(`precondition: ${result.precondition}`);
        if (result.hint) console.error(`hint: ${result.hint}`);
        return;
      }
      if (result.platformWarning) {
        console.log(`PLATFORM WARNING: ${result.platformWarning}`);
        console.log('');
      }
      const s = result.signature;
      console.log('Manifest integrity seal:');
      console.log(`  signer mode:              ${s.signerMode}`);
      console.log(`  hash matches:             ${s.manifestHashOk ? 'yes' : 'SEAL MISMATCH'}`);
      if (s.signerMode === 'derived') {
        console.log(`  public key reproducible:  ${s.publicKeyReproducible ? 'yes' : 'SEAL MISMATCH'}`);
      }
      console.log(`  seal valid:               ${s.signatureValid ? 'yes' : 'SEAL MISMATCH'}`);
      console.log(`  guarantee:                ${s.guarantee}`);
      if (s.warning) console.log(`  WARNING:                  ${s.warning}`);
      console.log('');
      console.log(`Summary: pass=${result.summary.pass} drift=${result.summary.drift} regressed=${result.summary.regressed} missing=${result.summary.missing}`);
      for (const r of result.results.filter((r) => r.status === 'regressed' || r.status === 'missing')) {
        console.log(`  ${r.status.toUpperCase()}  ${r.id}  ${r.file ?? ''}${r.detail ? `  (${r.detail})` : ''}`);
      }
      console.log(`\nnote: ${result.note}`);
    });
    process.exit(result.exitCode);
  });

// ─── history ────────────────────────────────────────────────────────
program
  .command('history')
  .description('Timeline per claim, latest diff, regression bisection, staleness')
  .option('--id <claimId>', 'timeline for a single claim')
  .option('--diff', 'latest-vs-previous transitions')
  .option('--bisect', 'find regression-introducing commit ranges')
  .option('--stale', 'list claims gone dormant or never once verified (advisory; never affects exit code)')
  .option('--stale-after-commits <n>', `dormant after this many distinct commits without a verified=true seal (default ${DEFAULT_STALE_COMMITS})`)
  .option('--stale-after-days <n>', `dormant after this many days without a verified=true seal (default ${DEFAULT_STALE_DAYS})`)
  .option('--as-of <commit>', 'anchor the staleness picture at this commit instead of the latest seal')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action((o: {
    id?: string;
    diff?: boolean;
    bisect?: boolean;
    stale?: boolean;
    staleAfterCommits?: string;
    staleAfterDays?: string;
    asOf?: string;
    root: string;
    json?: boolean;
  }) => {
    try {
      const { historyPath, root } = loadConfig(o.root);
      const history = loadHistory(historyPath);
      if (o.id) {
        const timeline = fixTimeline(history, o.id);
        emit(!!o.json, { ok: true, id: o.id, timeline }, () => {
          for (const t of timeline) console.log(`${t.issuedAt}  ${t.commit.slice(0, 12)}  ${t.status}`);
        });
      } else if (o.diff) {
        const diff = diffLatest(history);
        emit(!!o.json, { ok: true, diff }, () => console.log(JSON.stringify(diff, null, 2)));
      } else if (o.stale) {
        const parseN = (v: string | undefined, name: string): number | undefined => {
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) fail(!!o.json, 2, `${name} must be a non-negative number`);
          return n;
        };
        // Always thread "now" in at the CLI boundary so findStaleClaims itself
        // never reaches the wall clock — keeps the library function pure.
        const stale = findStaleClaims(history, {
          staleAfterCommits: parseN(o.staleAfterCommits, '--stale-after-commits'),
          staleAfterDays: parseN(o.staleAfterDays, '--stale-after-days'),
          asOfCommit: o.asOf,
          now: new Date().toISOString(),
        });
        emit(!!o.json, { ok: true, stale }, () => {
          if (stale.length === 0) {
            console.log('No stale claims.');
            return;
          }
          for (const s of stale) {
            if (s.reason === 'never-verified') {
              console.log(`${s.claimId}\tnever-verified\t(no verified=true seal on record)`);
            } else {
              console.log(
                `${s.claimId}\tdormant\tlast pass ${s.lastVerifiedCommit!.slice(0, 12)}\t${s.commitsSinceVerified} commit${s.commitsSinceVerified === 1 ? '' : 's'}\t${s.daysSinceVerified} day${s.daysSinceVerified === 1 ? '' : 's'}`,
              );
            }
          }
        });
      } else if (o.bisect) {
        const regressions = enrichRegressionsWithGit(root, findRegressionIntroductions(history));
        emit(!!o.json, { ok: true, regressions }, () => {
          if (regressions.length === 0) console.log('No regressed claims in latest snapshot.');
          const tag = (reachable?: boolean) => (reachable === false ? ` ${UNREACHABLE_TAG}` : '');
          for (const r of regressions) {
            const lastPass = r.lastPassCommit
              ? `${r.lastPassCommit.slice(0, 12)}${tag(r.lastPassReachable)}`
              : '(never)';
            console.log(`${r.id}: last pass ${lastPass} → regressed at ${r.regressedAtCommit.slice(0, 12)}${tag(r.regressedAtReachable)}`);
            if (r.rangeCommitCount != null) {
              const n = r.rangeCommitCount;
              const advice = n > 1 ? ' — seal more often (e.g. in CI on main) for tighter localization' : '';
              console.log(`  range spans ${n} commit${n === 1 ? '' : 's'}${advice}`);
            }
          }
        });
      } else {
        emit(!!o.json, { ok: true, entries: history }, () => {
          for (const e of history) {
            console.log(`${e.issuedAt}  ${e.commit.slice(0, 12)}  claims=${e.summary.totalClaims} verified=${e.summary.verified} missing=${e.summary.missing}`);
          }
          if (history.length === 0) console.log('(no history)');
        });
      }
    } catch (e) {
      fail(!!o.json, 2, (e as Error).message);
    }
  });

// ─── harness run ────────────────────────────────────────────────────
const harness = program.command('harness').description('Deterministic-output harnesses');
harness
  .command('run <name>')
  .option('--update', 'regenerate expectedSha256 + reference vector (reviewed bumps only)')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action(async (name: string, o: { update?: boolean; root: string; json?: boolean }) => {
    const json = !!o.json;
    try {
      const { root, config } = loadConfig(o.root);
      const claimDef = config.claims.find(
        (c): c is HarnessClaim => c.type === 'harness' && (c.harness === name || c.id === name),
      );
      if (!claimDef) fail(json, 2, `no harness claim named '${name}'`);
      const def = claimDef!;
      const result = await runHarness({
        name,
        cmd: def.cmd,
        cwd: root,
        seed: def.seed,
        quantizeDecimals: def.quantizeDecimals,
        exclude: def.exclude,
        expectedSha256: o.update ? undefined : def.expectedSha256,
        referenceVector: def.referenceVector,
        tolerance: def.tolerance,
      });
      if (result.status === 'error') {
        fail(json, 2, `harness '${name}' failed: ${result.error}`);
      }
      if (o.update) {
        const refRel = def.referenceVector ?? `proofs/${name}.reference.json`;
        const refAbs = join(root, refRel);
        mkdirSync(dirname(refAbs), { recursive: true });
        writeFileSync(refAbs, JSON.stringify(result.values) + '\n');
        def.expectedSha256 = result.hash;
        def.referenceVector = refRel;
        def.tolerance = def.tolerance ?? { ...DEFAULT_TOLERANCE };
        saveConfig(root, config);
        emit(json, { ok: true, updated: true, hash: result.hash, referenceVector: refRel }, () => {
          console.log(`Updated harness '${name}': expectedSha256=${result.hash}`);
          console.log(`Reference vector written to ${refRel}. Re-run \`proofseal seal\`.`);
        });
        process.exit(0);
      }
      if (!def.expectedSha256) {
        fail(json, 2, `harness '${name}' has no committed expectedSha256 — run with --update first`);
      }
      emit(json, { ok: result.status === 'pass' || result.status === 'drift', result }, () => {
        console.log(`harness '${name}': ${result.status}  hash=${result.hash}`);
        if (result.forensics?.worst) {
          const w = result.forensics.worst;
          console.log(`  worst divergence: index ${w.index} actual=${w.actual} expected=${w.expected} diff=${w.diff}`);
        }
      });
      process.exit(result.status === 'pass' || result.status === 'drift' ? 0 : 1);
    } catch (e) {
      fail(json, 2, (e as Error).message);
    }
  });

// ─── suggest ────────────────────────────────────────────────────────
program
  .command('suggest')
  .description('Suggest claims from the current git diff (marker for distinctive edits, file-hash otherwise)')
  .option('--base <ref>', 'diff against a ref (e.g. main, HEAD~3) instead of the working tree')
  .option('--staged', 'use staged changes (index vs HEAD)')
  .option('--include-file-hash', 'also suggest whole-file-hash claims when no robust marker is found (off by default — file-hash claims trip on any edit)')
  .option('--write', 'append the suggestions to proofseal.json (skips ids/files already present)')
  .option('--root <path>', 'repo root', '.')
  .option('--json', 'machine-readable output')
  .action((o: { base?: string; staged?: boolean; includeFileHash?: boolean; write?: boolean; root: string; json?: boolean }) => {
    const json = !!o.json;
    try {
      const { root, config } = loadConfig(o.root ?? '.');
      const { suggestions, skipped } = suggestClaims(root, config, {
        base: o.base,
        staged: o.staged,
        includeFileHash: o.includeFileHash,
      });

      if (o.write) {
        // Re-validate through the schema before persisting (suggestions are
        // built in-process, but the config file is a contract — never write
        // an entry that wouldn't load back). Skip any id that now collides.
        const have = new Set(config.claims.map((c) => c.id));
        const added: Claim[] = [];
        for (const s of suggestions) {
          if (have.has(s.claim.id)) continue;
          const parsed = ClaimSchema.safeParse(s.claim);
          if (!parsed.success) continue;
          have.add(parsed.data.id);
          added.push(parsed.data);
        }
        if (added.length > 0) {
          config.claims.push(...added);
          saveConfig(root, config);
        }
        emit(json, { ok: true, written: added.length, ids: added.map((c) => c.id), skipped }, () => {
          console.log(`Wrote ${added.length} claim${added.length === 1 ? '' : 's'} to proofseal.json.`);
          if (added.length > 0) console.log('Next: review the entries, then `proofseal seal`.');
        });
        return;
      }

      emit(json, { ok: true, suggestions, skipped }, () => {
        if (suggestions.length === 0) {
          console.log('No new claims to suggest from the current diff.');
          if (!o.includeFileHash && skipped.some((s) => s.reason.startsWith('no robust marker'))) {
            console.log('Some files had no robust marker — re-run with --include-file-hash to seal their whole-file hash.');
          }
          return;
        }
        for (const s of suggestions) {
          const dot = s.confidence === 'high' ? '●' : '○';
          const detail = s.claim.type === 'marker' ? `marker="${s.claim.marker}"` : 'whole-file hash';
          console.log(`${dot} ${s.claim.id}\t${s.claim.type}\t${s.claim.file}\t${detail}`);
        }
        console.log('');
        console.log('● high confidence (robust marker)   ○ medium (whole-file hash)');
        console.log('Review, then apply with: proofseal suggest --write');
      });
    } catch (e) {
      fail(json, 2, (e as Error).message);
    }
  });

// ─── mcp start ──────────────────────────────────────────────────────
const mcp = program.command('mcp').description('MCP server');
mcp
  .command('start')
  .description('Start the ProofSeal MCP stdio server')
  .action(async () => {
    await startMcpServer();
  });

program.parseAsync(process.argv);
