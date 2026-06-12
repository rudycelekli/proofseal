// Integration: `claim add --from-file` end-to-end (init → batch add → seal →
// verify), plus the v0.1 premortem surfaces: init's .gitattributes guidance
// and the platform block recorded in the sealed manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  SKIP,
  MARKER,
  makeTempRepo,
  commitAll,
  runCli,
  expectExit,
  parseJsonOut,
  readManifest,
  cleanup,
} from './helpers.mjs';

test('batch claim authoring: --from-file → seal → verify green', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({
      'src/feature.js': `export function feature() { return 42; } // ${MARKER}\n`,
      'src/util.js': 'export const util = 1;\n',
    });
    const init = expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    // No .gitattributes in the fixture repo → init prints the autocrlf hint.
    assert.match(init.stdout, /\.gitattributes/);
    assert.match(init.stdout, /text=auto eol=lf/);

    await writeFile(
      path.join(dir, 'claims-batch.json'),
      JSON.stringify([
        { id: 'util-hash', type: 'file-hash', file: 'src/util.js', desc: 'util integrity' },
        { id: 'feature-marker', type: 'marker', file: 'src/feature.js', marker: MARKER },
      ]),
    );
    const add = expectExit(
      await runCli(['claim', 'add', '--from-file', 'claims-batch.json'], { cwd: dir }),
      0,
      'claim add --from-file',
    );
    assert.match(add.stdout, /Added 2 claims/);

    await commitAll(dir, 'batch claims');
    expectExit(await runCli(['seal'], { cwd: dir }), 0, 'seal');

    // Platform honesty: the sealed (signed) manifest records the environment.
    const witness = await readManifest(dir);
    assert.equal(witness.manifest.platform.os, process.platform);
    assert.equal(witness.manifest.platform.node, process.versions.node);

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 0, 'verify');
    const json = parseJsonOut(res);
    assert.equal(json.ok, true);
    assert.equal(json.summary.totalClaims, 3); // sample + 2 batch claims
    assert.equal('platformWarning' in json, false, 'same OS ⇒ no additive warning field');
  } finally {
    await cleanup(dir);
  }
});

test('batch claim authoring: invalid entry rejects the whole file (exit 2)', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await makeTempRepo({ 'src/util.js': 'export const util = 1;\n' });
    expectExit(await runCli(['init'], { cwd: dir }), 0, 'init');
    await writeFile(
      path.join(dir, 'claims-batch.json'),
      JSON.stringify([
        { id: 'ok-claim', type: 'file-hash', file: 'src/util.js' },
        { id: 'broken', type: 'marker', file: 'src/util.js' }, // missing `marker`
      ]),
    );
    const add = await runCli(['claim', 'add', '--from-file', 'claims-batch.json'], { cwd: dir });
    expectExit(add, 2, 'claim add --from-file (invalid)');
    assert.match(add.stderr, /\[1\]/);
    const list = parseJsonOut(await runCli(['claim', 'list', '--json'], { cwd: dir }));
    assert.equal(
      list.claims.some((c) => c.id === 'ok-claim'),
      false,
      'all-or-nothing: the valid entry must NOT have been added',
    );
  } finally {
    await cleanup(dir);
  }
});
