// Integration test 5 — Tamper evidence (ADR-0001 §5.4, sub-claim C4):
// ANY single mutation of the sealed manifest must yield exit 1 with a
// bad-signature report. Two mutation classes:
//   (a) flip a nibble inside integrity.signature  -> Ed25519 verify fails
//   (b) flip a nibble inside one claim's sha256   -> recomputed manifest
//       hash diverges from integrity.manifestHash -> signature chain fails
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP,
  sealedFixture,
  runCli,
  parseJsonOut,
  readManifest,
  writeManifest,
  flipHexNibble,
  cleanup,
  expectExit,
} from './helpers.mjs';

function assertBadSignatureReported(res, json) {
  // The contract: exit 1 and the machine output reports the signature as
  // invalid. We accept either a boolean signature.ok-style field or any
  // falsy signature validity flag, but ok MUST be false.
  assert.equal(json.ok, false, 'ok must be false on manifest tamper');
  const sigStr = JSON.stringify(json.signature ?? {});
  const looksInvalid =
    /false/.test(sigStr) ||
    /invalid|bad|fail|mismatch/i.test(sigStr) ||
    /signature/i.test(res.stdout + res.stderr) === true;
  assert.ok(
    looksInvalid,
    `verify output must report a bad signature; signature block was: ${sigStr}\n` +
      `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
}

test('tamper: flipped byte in integrity.signature -> verify exit 1, bad signature', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();

    const doc = await readManifest(dir);
    assert.ok(doc.integrity?.signature, 'sealed manifest has integrity.signature');
    doc.integrity.signature = flipHexNibble(doc.integrity.signature, 3);
    await writeManifest(dir, doc);

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'verify with mutated signature hex');
    assertBadSignatureReported(res, parseJsonOut(res));
  } finally {
    await cleanup(dir);
  }
});

test('tamper: flipped byte in a claim sha256 -> verify exit 1, bad signature', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();

    const doc = await readManifest(dir);
    const claims = doc.manifest?.claims;
    assert.ok(Array.isArray(claims) && claims.length > 0, 'manifest.claims present');
    const target = claims.find((c) => typeof c.sha256 === 'string');
    assert.ok(target, 'a claim with sha256 exists');
    target.sha256 = flipHexNibble(target.sha256, 5);
    await writeManifest(dir, doc);

    // Crucial distinction: the live file on disk still matches the ORIGINAL
    // hash, so a naive verifier might call this a claim failure. The contract
    // says the manifest hash/signature check must catch the edit itself —
    // hand-edited manifests break signatures (extraction-map pitfall #13).
    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'verify with mutated claim sha256');
    assertBadSignatureReported(res, parseJsonOut(res));
  } finally {
    await cleanup(dir);
  }
});

test('tamper: mutated manifest body field (gitCommit) -> verify exit 1', { skip: SKIP }, async () => {
  let dir;
  try {
    dir = await sealedFixture();

    // Mutating gitCommit attacks the key-derivation binding (§5.4): the
    // re-derived public key and/or manifest hash must no longer line up.
    const doc = await readManifest(dir);
    assert.match(doc.manifest.gitCommit, /^[0-9a-f]{40}$/);
    doc.manifest.gitCommit = flipHexNibble(doc.manifest.gitCommit, 0);
    await writeManifest(dir, doc);

    const res = await runCli(['verify', '--json'], { cwd: dir });
    expectExit(res, 1, 'verify with mutated gitCommit');
    assert.equal(parseJsonOut(res).ok, false);
  } finally {
    await cleanup(dir);
  }
});
