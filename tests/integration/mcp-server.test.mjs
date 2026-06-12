// Integration test 9 — MCP stdio server (ADR-0001 §4.2):
// raw JSON-RPC over stdin/stdout (no SDK), initialize handshake, all 7 tools
// listed, verify_claims works on a sealed repo, and a broken repo yields the
// fail-open shape {ok:false, warn:true, error, hint} instead of a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SKIP,
  sealedFixture,
  git,
  writeFiles,
  cleanup,
} from './helpers.mjs';
import { McpClient } from './mcp-client.mjs';

const EXPECTED_TOOLS = [
  'verify_claims',
  'seal_manifest',
  'check_drift',
  'claim_history',
  'find_regression',
  'run_harness',
  'list_claims',
];

test('mcp: initialize handshake + tools/list exposes all 7 tools', { skip: SKIP }, async () => {
  let dir;
  let client;
  try {
    dir = await sealedFixture();
    client = new McpClient({ cwd: dir });

    const init = await client.initialize();
    assert.ok(init.serverInfo?.name, 'initialize result must carry serverInfo.name');
    assert.ok(init.protocolVersion, 'initialize result must echo a protocolVersion');

    const listed = await client.listTools();
    const names = (listed.tools ?? []).map((t) => t.name);
    for (const tool of EXPECTED_TOOLS) {
      assert.ok(names.includes(tool), `tools/list must include "${tool}" (got: ${names.join(', ')})`);
    }
    // ADR-112 description rule: agents need "use when ... is wrong because"
    // style guidance — at minimum every tool must HAVE a description.
    for (const t of listed.tools ?? []) {
      assert.ok(
        typeof t.description === 'string' && t.description.length > 0,
        `tool ${t.name} must have a non-empty description`,
      );
    }
  } finally {
    await client?.close();
    await cleanup(dir);
  }
});

test('mcp: verify_claims on a sealed repo returns ok:true with results', { skip: SKIP }, async () => {
  let dir;
  let client;
  try {
    dir = await sealedFixture();
    client = new McpClient({ cwd: dir });
    await client.initialize();

    const result = await client.callTool('verify_claims', {});
    assert.notEqual(result.isError, true, 'tool call must not be a protocol-level error');
    const payload = McpClient.toolPayload(result);
    assert.equal(payload.ok, true, `verify_claims must report ok:true on a sealed repo; got ${JSON.stringify(payload)}`);
    assert.ok(Array.isArray(payload.results), 'verify_claims payload carries results[]');
    assert.ok(payload.summary, 'verify_claims payload carries summary');
  } finally {
    await client?.close();
    await cleanup(dir);
  }
});

test('mcp: verify_claims on a broken repo fails OPEN ({ok:false, warn:true, error, hint}), no crash', { skip: SKIP }, async () => {
  let dir;
  let client;
  try {
    // A git repo with no proofkit state at all — nothing to verify.
    dir = await mkdtemp(path.join(tmpdir(), 'proofkit-it-broken-'));
    await git(dir, 'init', '-q', '-b', 'main');
    await writeFiles(dir, { 'src/a.js': 'export const a = 1;\n' });
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '--no-gpg-sign', '-m', 'no proofkit here');

    client = new McpClient({ cwd: dir });
    await client.initialize();

    // RuView rvagent convention (ADR §4.2): a broken repo must NEVER kill an
    // agent session — the tool returns a warn-shaped result, not a JSON-RPC
    // error and not a server crash.
    const result = await client.callTool('verify_claims', {});
    const payload = McpClient.toolPayload(result);
    assert.equal(payload.ok, false, 'broken repo: ok must be false');
    assert.equal(payload.warn, true, 'broken repo: warn must be true (fail-open)');
    assert.ok(
      typeof payload.error === 'string' && payload.error.length > 0,
      'broken repo: error message present',
    );
    assert.ok(
      typeof payload.hint === 'string' && payload.hint.length > 0,
      'broken repo: actionable hint present',
    );

    // Server must still be alive and serving: a follow-up request succeeds.
    const listed = await client.listTools();
    assert.ok((listed.tools ?? []).length >= 7, 'server still responsive after fail-open result');
  } finally {
    await client?.close();
    await cleanup(dir);
  }
});

test('mcp: client disconnect mid-write (EPIPE) exits 0 quietly, no stack trace', { skip: SKIP }, async () => {
  let dir;
  let client;
  try {
    dir = await sealedFixture();
    client = new McpClient({ cwd: dir });
    await client.initialize();

    // Sever OUR read end of the server's stdout: the server's next write
    // hits a broken pipe (write EPIPE). Then provoke a write with a raw
    // request — bypassing request() because no response can ever arrive.
    client.child.stdout.destroy();
    client.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} }) + '\n',
    );

    const exited = await Promise.race([
      client.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`server did not exit after EPIPE. stderr:\n${client.stderr}`)), 10_000),
      ),
    ]);
    assert.equal(exited.code, 0, `EPIPE must exit 0 (got ${exited.code}, signal ${exited.signal}). stderr:\n${client.stderr}`);
    assert.ok(!client.stderr.includes('EPIPE'), `no EPIPE stack trace on stderr:\n${client.stderr}`);
  } finally {
    await client?.close();
    await cleanup(dir);
  }
});

test('mcp: stdin close shuts the server down with exit 0', { skip: SKIP }, async () => {
  let dir;
  let client;
  try {
    dir = await sealedFixture();
    client = new McpClient({ cwd: dir });
    await client.initialize();

    client.child.stdin.end();
    const exited = await Promise.race([
      client.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`server did not exit after stdin close. stderr:\n${client.stderr}`)), 10_000),
      ),
    ]);
    assert.equal(exited.code, 0, `stdin close must exit 0 (got ${exited.code}, signal ${exited.signal})`);
  } finally {
    await client?.close();
    await cleanup(dir);
  }
});
