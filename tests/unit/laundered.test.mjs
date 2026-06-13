// Unit tests for findResealedOverBreaks — read-only laundering detector.
// Pure-function tests; the CLI is exercised in integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findResealedOverBreaks } from '../../dist/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const dayAfter = (iso, d) =>
  new Date(Date.parse(iso) + d * 86_400_000).toISOString();

/** Compact seal-entry factory. */
const seal = (commit, issuedAt, claims, branch = 'main') => ({
  v: 2,
  kind: 'seal',
  commit,
  issuedAt,
  branch,
  manifestHash: 'f'.repeat(64),
  summary: {
    totalClaims: Object.keys(claims).length,
    verified: Object.values(claims).filter((c) => c.verified).length,
    missing: 0,
  },
  claims,
});

/** Compact verify-entry factory. */
const vfy = (commit, issuedAt, results, branch = 'main') => ({
  v: 2,
  kind: 'verify',
  commit,
  issuedAt,
  branch,
  manifestHash: 'f'.repeat(64),
  results,
});

const cs = (sha, verified) => ({ sha256: sha, verified });
const vr = (sha, status) => ({ sha256: sha, status });
const C = (n) => String(n).padStart(40, '0');

test('empty history returns empty and does not throw', () => {
  assert.deepEqual(findResealedOverBreaks([]), []);
  assert.deepEqual(findResealedOverBreaks([], { asOfCommit: undefined }), []);
});

test('only seals (no verify entries) → no events possible', () => {
  // Without verify outcomes recorded, you can't tell pass from "the seal said so".
  // A seal-self-failed CAN trip a break, but only after a prior verified=true seal.
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    seal(C(2), dayAfter(T0, 1), { c1: cs('b', true) }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('c', true) }),
  ];
  assert.deepEqual(findResealedOverBreaks(h), []);
});

test('rule #1: first seal verified:false (newcomer, no reference yet) is NOT a break', () => {
  // Common case: a brand-new harness claim sealed before its first reference
  // vector exists — verified:false. Then it's established and resealed with a
  // real sha. That must NOT be flagged: nothing was laundered, just bootstrapped.
  const h = [
    seal(C(1), T0, { harn: cs('', false) }), // brand-new, no reference
    seal(C(2), dayAfter(T0, 1), { harn: cs('a', true) }), // established
    seal(C(3), dayAfter(T0, 2), { harn: cs('b', true) }), // routine reseal
  ];
  assert.deepEqual(findResealedOverBreaks(h), []);
});

test('break (verify-regressed) → reseal with new sha → one event', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }), // laundered: sha changed without a verify pass
  ];
  const out = findResealedOverBreaks(h);
  assert.equal(out.length, 1);
  assert.equal(out[0].claimId, 'c1');
  assert.equal(out[0].brokeKind, 'verify-regressed');
  assert.equal(out[0].brokeAtCommit, C(2));
  assert.equal(out[0].brokenSha, 'a');
  assert.equal(out[0].resealedAtCommit, C(3));
  assert.equal(out[0].resealedSha, 'b');
});

test('break → verify(pass) → reseal → NO event (the pass cleared the break)', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    vfy(C(3), dayAfter(T0, 2), { c1: vr('a', 'pass') }), // legitimate fix verified
    seal(C(4), dayAfter(T0, 3), { c1: cs('b', true) }),
  ];
  assert.deepEqual(findResealedOverBreaks(h), []);
});

test('break → reseal-with-same-sha (revert) → NO event; state stays open', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('a', true) }), // revert: same sha as pre-break good
  ];
  assert.deepEqual(findResealedOverBreaks(h), []);
});

test('revert is not a real fix: a later seal with a NEW sha still fires (revert did not clear the break)', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('a', true) }), // revert: no event, but break stays open
    seal(C(4), dayAfter(T0, 3), { c1: cs('b', true) }), // NOW the launder
  ];
  const out = findResealedOverBreaks(h);
  assert.equal(out.length, 1);
  assert.equal(out[0].brokeAtCommit, C(2)); // still the original break
  assert.equal(out[0].brokenSha, 'a');
  assert.equal(out[0].resealedAtCommit, C(4));
  assert.equal(out[0].resealedSha, 'b');
});

test('seal-self-failed as break (after prior good) → later reseal fires', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    seal(C(2), dayAfter(T0, 1), { c1: cs('a', false) }), // self-failed seal — break (rule #1 ok: prior good)
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }),
  ];
  const out = findResealedOverBreaks(h);
  assert.equal(out.length, 1);
  assert.equal(out[0].brokeKind, 'seal-self-failed');
  assert.equal(out[0].brokeAtCommit, C(2));
  assert.equal(out[0].brokenSha, 'a');
  assert.equal(out[0].resealedSha, 'b');
});

test('verify(drift) does NOT break — drift is documented allowed-behavior', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('a2', 'drift') }), // marker present, hash drifted — allowed
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }),
  ];
  assert.deepEqual(findResealedOverBreaks(h), []);
});

test('verify(missing) breaks; reseal fires with brokeKind=verify-missing', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('', 'missing') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }),
  ];
  const out = findResealedOverBreaks(h);
  assert.equal(out.length, 1);
  assert.equal(out[0].brokeKind, 'verify-missing');
});

test('rule #1: verify(regressed) with no prior good state does NOT enter BROKEN', () => {
  // A claim verified=regressed before any prior good state existed cannot
  // be "laundered" — there was nothing to launder. Matches the never-verified
  // concept in findStaleClaims.
  const h = [
    vfy(C(1), T0, { c1: vr('x', 'regressed') }),
    seal(C(2), dayAfter(T0, 1), { c1: cs('a', true) }), // first known-good state
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }),
  ];
  assert.deepEqual(findResealedOverBreaks(h), []);
});

test('multiple sequential break/reseal pairs each fire their own event', () => {
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }), // launder #1
    vfy(C(4), dayAfter(T0, 3), { c1: vr('y', 'regressed') }),
    seal(C(5), dayAfter(T0, 4), { c1: cs('c', true) }), // launder #2
  ];
  const out = findResealedOverBreaks(h);
  assert.equal(out.length, 2);
  assert.equal(out[0].brokeAtCommit, C(2));
  assert.equal(out[0].resealedAtCommit, C(3));
  assert.equal(out[1].brokeAtCommit, C(4));
  assert.equal(out[1].resealedAtCommit, C(5));
});

test('shuffled file order yields identical output to chronological order', () => {
  const chrono = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }),
    vfy(C(4), dayAfter(T0, 3), { c1: vr('y', 'regressed') }),
    seal(C(5), dayAfter(T0, 4), { c1: cs('c', true) }),
  ];
  const shuffled = [chrono[4], chrono[1], chrono[3], chrono[0], chrono[2]];
  assert.deepEqual(findResealedOverBreaks(shuffled), findResealedOverBreaks(chrono));
  assert.ok(findResealedOverBreaks(chrono).length === 2, 'sanity: chosen fixture should fire 2 events');
});

test('--as-of bounds the scan: events after the anchor are ignored (CI-release-gate semantic)', () => {
  // Two launder events: one at seal C(3), one at seal C(5).
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(2), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
    seal(C(3), dayAfter(T0, 2), { c1: cs('b', true) }), // event #1
    vfy(C(4), dayAfter(T0, 3), { c1: vr('y', 'regressed') }),
    seal(C(5), dayAfter(T0, 4), { c1: cs('c', true) }), // event #2
  ];
  // Full scan sees both.
  assert.equal(findResealedOverBreaks(h).length, 2);
  // Bounded at C(3) sees only the first.
  const boundedAt3 = findResealedOverBreaks(h, { asOfCommit: C(3) });
  assert.equal(boundedAt3.length, 1);
  assert.equal(boundedAt3[0].resealedAtCommit, C(3));
  // Bounded at C(1) (pre-break) sees none.
  assert.deepEqual(findResealedOverBreaks(h, { asOfCommit: C(1) }), []);
});

test('--as-of pointing at a verify entry commit throws (anchor must be a seal)', () => {
  // Verify entries are not addressable by --as-of: the anchor concept is
  // "what did this seal-snapshot look like". A verify commit is not a snapshot.
  const h = [
    seal(C(1), T0, { c1: cs('a', true) }),
    vfy(C(99), dayAfter(T0, 1), { c1: vr('x', 'regressed') }),
  ];
  assert.throws(
    () => findResealedOverBreaks(h, { asOfCommit: C(99) }),
    /not found in history/,
  );
});

test('asOfCommit not in history at all throws', () => {
  const h = [seal(C(1), T0, { c1: cs('a', true) })];
  assert.throws(
    () => findResealedOverBreaks(h, { asOfCommit: 'z'.repeat(40) }),
    /not found in history/,
  );
});

test('sort order: by brokeAtIssuedAt asc, then claimId asc — deterministic', () => {
  const h = [
    seal(C(1), T0, { a: cs('a0', true), b: cs('b0', true), c: cs('c0', true) }),
    vfy(C(2), dayAfter(T0, 10), { c: vr('x', 'regressed') }),
    vfy(C(3), dayAfter(T0, 20), { a: vr('x', 'regressed'), b: vr('x', 'regressed') }), // same break time → claimId asc
    seal(C(4), dayAfter(T0, 30), { a: cs('a1', true), b: cs('b1', true), c: cs('c1', true) }),
  ];
  const out = findResealedOverBreaks(h);
  assert.equal(out.length, 3);
  // c broke at T+10 (earliest)
  assert.equal(out[0].claimId, 'c');
  // a and b broke at T+20 — alphabetical by claimId
  assert.equal(out[1].claimId, 'a');
  assert.equal(out[2].claimId, 'b');
});

test('verify entry with claim not in results is silently skipped per-claim', () => {
  // A verify run that excludes a claim (e.g., --no-harness) does not record
  // outcomes for the skipped claim. That claim's state is unaffected.
  const h = [
    seal(C(1), T0, { a: cs('a0', true), b: cs('b0', true) }),
    vfy(C(2), dayAfter(T0, 1), { a: vr('x', 'regressed') }), // b is silently absent
    seal(C(3), dayAfter(T0, 2), { a: cs('a1', true), b: cs('b1', true) }),
  ];
  const out = findResealedOverBreaks(h);
  // Only 'a' broke and got laundered. 'b' was never broken.
  assert.equal(out.length, 1);
  assert.equal(out[0].claimId, 'a');
});
