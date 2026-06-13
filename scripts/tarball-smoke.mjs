#!/usr/bin/env node
// Tarball smoke — exercises the literal npm-installed path that unit and
// integration tests never touch: `npm pack` artifact, `files` whitelist,
// bin resolution, shebang + exec bit on the installed bin.
//
// Flow:
//   1. npm pack (into a temp dir, repo stays clean)
//   2. npm init -y && npm i <tarball> in a fresh temp project
//   3. MCP handshake against the INSTALLED bin (node_modules/.bin/proofseal
//      on POSIX — this is what proves shebang + exec bit; on Windows the
//      shim is a .cmd wrapper, so we run node on the installed entry file
//      and rely on the `npx proofseal --help` step to exercise the shim)
//   4. Assert: serverInfo present, 7 tools listed, stdout is pure NDJSON,
//      exit 0 on stdin close
//   5. `npx proofseal --help` exits 0
//
// Run locally: npm run smoke:tarball   (CI job: tarball-smoke)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../tests/integration/mcp-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const EXPECTED_TOOLS = [
  'verify_claims',
  'seal_manifest',
  'check_drift',
  'claim_history',
  'find_regression',
  'run_harness',
  'list_claims',
];

function fail(msg) {
  console.error(`\nTARBALL SMOKE FAIL: ${msg}`);
  process.exit(1);
}

function check(cond, label) {
  if (!cond) fail(label);
  console.log(`  ok: ${label}`);
}

/** Run a shell command (npm/npx need shell:true for the .cmd shims on Windows). */
function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}${opts.cwd ? `   (cwd: ${opts.cwd})` : ''}`);
  const res = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    ...opts,
  });
  if (res.status !== 0) {
    fail(`command exited ${res.status}: ${cmd}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  return res.stdout;
}

const packDest = mkdtempSync(path.join(tmpdir(), 'proofseal-pack-'));
const projDir = mkdtempSync(path.join(tmpdir(), 'proofseal-smoke-'));

try {
  // 1. Pack the publishable artifact.
  const packJson = JSON.parse(
    sh(`npm pack --json --pack-destination "${packDest}"`, { cwd: ROOT }),
  );
  const tarball = path.join(packDest, packJson[0].filename);
  check(existsSync(tarball), `npm pack produced ${packJson[0].filename}`);

  // 2. Install it into a fresh temp project — the literal consumer path.
  sh('npm init -y', { cwd: projDir });
  sh(`npm install "${tarball}"`, { cwd: projDir });

  // 3. MCP handshake against the installed bin.
  const posixBin = path.join(projDir, 'node_modules', '.bin', 'proofseal');
  const installedEntry = path.join(projDir, 'node_modules', 'proofseal', 'dist', 'cli', 'index.js');
  check(existsSync(installedEntry), '`files` whitelist shipped dist/cli/index.js');

  const spawnSpec = isWin
    ? { command: process.execPath, args: [installedEntry, 'mcp', 'start'] }
    : { command: posixBin, args: ['mcp', 'start'] }; // shebang + exec bit
  if (!isWin) check(existsSync(posixBin), 'bin link node_modules/.bin/proofseal exists');

  console.log(`\nMCP handshake via: ${spawnSpec.command} ${spawnSpec.args.join(' ')}`);
  const client = new McpClient({ cwd: projDir, ...spawnSpec });

  const init = await client.initialize();
  check(!!init?.serverInfo?.name, `initialize returned serverInfo (name=${init?.serverInfo?.name})`);

  const listed = await client.listTools();
  const names = (listed.tools ?? []).map((t) => t.name);
  check(names.length === 7, `tools/list returned exactly 7 tools (got ${names.length}: ${names.join(', ')})`);
  for (const tool of EXPECTED_TOOLS) {
    check(names.includes(tool), `tools/list includes "${tool}"`);
  }

  // 4a. stdout purity: every non-empty line so far must be valid JSON.
  const lines = client.rawStdout.split('\n').filter((l) => l.trim().length > 0);
  check(lines.length > 0, 'server wrote at least one stdout line');
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      fail(`stdout is not pure NDJSON — offending line:\n${line}`);
    }
  }
  console.log(`  ok: stdout is pure NDJSON (${lines.length} lines)`);

  // 4b. Closing stdin must shut the server down with exit 0.
  client.child.stdin.end();
  const exited = await Promise.race([
    client.exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('server did not exit within 10s of stdin close')), 10_000),
    ),
  ]).catch((e) => {
    client.child.kill('SIGKILL');
    fail(`${e.message}\nstderr:\n${client.stderr}`);
  });
  check(exited.code === 0, `exit 0 on stdin close (got code=${exited.code}, signal=${exited.signal})`);

  // 5. The advertised CLI entrypoint works through real bin resolution.
  sh('npx proofseal --help', { cwd: projDir });
  console.log('  ok: `npx proofseal --help` exited 0');

  // 5b. The INSTALLED bin must report the version it was published as. v0.3.1
  // shipped a hardcoded `--version` of 0.3.0; this asserts the installed path
  // (not just the source tree) agrees with package.json.
  const installedPkg = sh('npm pkg get version', { cwd: ROOT }).trim().replace(/"/g, '');
  const reported = sh('npx proofseal --version', { cwd: projDir }).trim();
  check(reported === installedPkg, `installed \`npx proofseal --version\` reports ${installedPkg} (got ${reported})`);

  console.log('\nTARBALL SMOKE PASS');
} finally {
  rmSync(packDest, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
}
