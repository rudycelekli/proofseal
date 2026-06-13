// The real CLI's reported version MUST equal package.json. v0.3.1 once shipped
// a hardcoded `--version` of 0.3.0; this test makes that drift a red build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli, PROJECT_ROOT, SKIP } from './helpers.mjs';

test('CLI --version matches package.json', { skip: SKIP }, async () => {
  const pkg = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
  );
  const res = await runCli(['--version']);
  assert.equal(res.code, 0, `--version exited nonzero:\n${res.stderr}`);
  assert.equal(res.stdout.trim(), pkg.version);
});
