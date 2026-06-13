// Unit tests for findStaleClaims — read-only staleness query over the JSONL
// history. Pure-function tests; the CLI is exercised in integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findStaleClaims,
  DEFAULT_STALE_COMMITS,
  DEFAULT_STALE_DAYS,
} from '../../dist/index.js';

/** Compact entry factory — matches the v:2 SealHistoryEntry shape. */
const mk = (commit, issuedAt, claims, branch = 'main') => ({
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
const cs = (verified) => ({ sha256: 'a'.repeat(64), verified });

// Stable, never-call-the-wall-clock "now" anchors used across tests.
const T0 = '2026-01-01T00:00:00.000Z';
const dayAfter = (iso, d) =>
  new Date(Date.parse(iso) + d * 86_400_000).toISOString();

test('empty history returns empty and does not throw', () => {
  assert.deepEqual(findStaleClaims([]), []);
  assert.deepEqual(findStaleClaims([], { now: T0 }), []);
});

test('never-verified claim is flagged with reason=never-verified and null fields', () => {
  const h = [mk('c'.repeat(40), T0, { c1: cs(false) })];
  const stale = findStaleClaims(h, { now: T0 });
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0], {
    claimId: 'c1',
    lastVerifiedCommit: null,
    lastVerifiedAt: null,
    commitsSinceVerified: null,
    daysSinceVerified: null,
    reason: 'never-verified',
  });
});

test('claim verified recently is NOT flagged', () => {
  const lastPassAt = dayAfter(T0, 60);
  const now = dayAfter(T0, 63);
  const h = [
    mk('a'.repeat(40), T0, { c1: cs(true) }),
    mk('b'.repeat(40), lastPassAt, { c1: cs(true) }),
  ];
  assert.deepEqual(findStaleClaims(h, { now }), []);
});

test('claim past the COMMITS threshold is flagged dormant', () => {
  // lastPass at entry 0, then 12 distinct-commit entries with verified=false.
  // Default staleAfterCommits=10 → trips.
  const entries = [mk('p'.repeat(40), T0, { c1: cs(true) })];
  for (let i = 1; i <= 12; i++) {
    entries.push(mk(String(i).padStart(40, '0'), dayAfter(T0, i), { c1: cs(false) }));
  }
  const stale = findStaleClaims(entries, { now: dayAfter(T0, 12) });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].reason, 'dormant');
  assert.equal(stale[0].commitsSinceVerified, 12);
  assert.ok(stale[0].commitsSinceVerified >= DEFAULT_STALE_COMMITS);
  assert.equal(stale[0].lastVerifiedCommit, 'p'.repeat(40));
});

test('claim past the DAYS threshold (but not commits) is flagged dormant', () => {
  const lastPassAt = T0;
  const now = dayAfter(T0, 91); // > default 90
  const h = [
    mk('p'.repeat(40), lastPassAt, { c1: cs(true) }),
    mk('q'.repeat(40), now, { c1: cs(false) }),
  ];
  const stale = findStaleClaims(h, { now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].reason, 'dormant');
  assert.equal(stale[0].daysSinceVerified, 91);
  assert.equal(stale[0].commitsSinceVerified, 1);
  assert.ok(stale[0].daysSinceVerified >= DEFAULT_STALE_DAYS);
});

test('removed-from-latest claim is NOT flagged (removal ≠ dormancy)', () => {
  const h = [
    mk('p'.repeat(40), T0, { c1: cs(true), c2: cs(true) }),
    // c2 dropped from latest; large gap, but it is removed, not stale.
    mk('q'.repeat(40), dayAfter(T0, 365), { c1: cs(true) }),
  ];
  const stale = findStaleClaims(h, { now: dayAfter(T0, 365) });
  assert.deepEqual(stale.map((s) => s.claimId), []);
});

test('threshold overrides flag claims the defaults would miss', () => {
  const h = [
    mk('p'.repeat(40), T0, { c1: cs(true) }),
    mk('q'.repeat(40), dayAfter(T0, 30), { c1: cs(false) }),
  ];
  // Defaults (10/90): not stale yet.
  assert.deepEqual(findStaleClaims(h, { now: dayAfter(T0, 30) }), []);
  // Override: 7-day threshold trips.
  const stale = findStaleClaims(h, {
    staleAfterDays: 7,
    staleAfterCommits: 100, // disable commit-side
    now: dayAfter(T0, 30),
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].reason, 'dormant');
  assert.equal(stale[0].daysSinceVerified, 30);
});

test('shuffled file order yields identical output to sorted order (union-merge safe)', () => {
  const ordered = [
    mk('p'.repeat(40), T0, { c1: cs(true), c2: cs(false) }),
    mk('q'.repeat(40), dayAfter(T0, 50), { c1: cs(false), c2: cs(false) }),
    mk('r'.repeat(40), dayAfter(T0, 100), { c1: cs(false), c2: cs(false) }),
  ];
  const shuffled = [ordered[2], ordered[0], ordered[1]];
  const a = findStaleClaims(ordered, { now: dayAfter(T0, 120) });
  const b = findStaleClaims(shuffled, { now: dayAfter(T0, 120) });
  assert.deepEqual(b, a);
  assert.ok(a.length > 0, 'sanity: the chosen history should produce some stale claims');
});

test('boundary: claim first-appearing-in-latest with verified=true is NOT flagged', () => {
  const h = [
    mk('p'.repeat(40), T0, { existing: cs(true) }),
    mk('q'.repeat(40), dayAfter(T0, 200), { existing: cs(true), newcomer: cs(true) }),
  ];
  const stale = findStaleClaims(h, { now: dayAfter(T0, 200) });
  // 200-day gap exists, but 'existing' was just re-verified and 'newcomer' is brand-new + passing.
  assert.deepEqual(stale, []);
});

test('boundary: claim first-appearing-in-latest with verified=false IS flagged never-verified', () => {
  const h = [
    mk('p'.repeat(40), T0, { existing: cs(true) }),
    mk('q'.repeat(40), dayAfter(T0, 1), { existing: cs(true), newcomer: cs(false) }),
  ];
  const stale = findStaleClaims(h, { now: dayAfter(T0, 1) });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].claimId, 'newcomer');
  assert.equal(stale[0].reason, 'never-verified');
  assert.equal(stale[0].lastVerifiedCommit, null);
  assert.equal(stale[0].lastVerifiedAt, null);
});

test('--as-of mid-history returns the picture as of that commit, ignoring later entries', () => {
  // c1 passes at T0, regresses at T+200 with 5 intermediate failing seals.
  // As of the T0 entry, c1 is fresh: not stale. As of the latest, it is dormant.
  const entries = [mk('p'.repeat(40), T0, { c1: cs(true) })];
  for (let i = 1; i <= 5; i++) {
    entries.push(mk(`m${i}`.padEnd(40, '0'), dayAfter(T0, 40 + i * 30), { c1: cs(false) }));
  }
  // Without --as-of: dormant (over 90 days, over commit threshold? 5 < 10, but days trips).
  const latestNow = dayAfter(T0, 220);
  const latestView = findStaleClaims(entries, { now: latestNow });
  assert.equal(latestView.length, 1);
  assert.equal(latestView[0].reason, 'dormant');

  // With --as-of pointing at the original pass: c1 is the just-sealed claim,
  // nothing came after, NOT stale.
  const asOfFresh = findStaleClaims(entries, { asOfCommit: 'p'.repeat(40), now: latestNow });
  assert.deepEqual(asOfFresh, []);

  // With --as-of at the first failing seal (40 days, 1 commit after pass):
  // not yet past default thresholds. The future failing seals must not leak in.
  const asOfFirstFail = findStaleClaims(entries, { asOfCommit: 'm1'.padEnd(40, '0'), now: latestNow });
  assert.deepEqual(asOfFirstFail, []);

  // asOfCommit not found throws.
  assert.throws(
    () => findStaleClaims(entries, { asOfCommit: 'z'.repeat(40), now: latestNow }),
    /not found in history/,
  );
});

test('sort order: never-verified before dormant; dormant by days DESC then commits DESC then id ASC', () => {
  // Build a mix: one never-verified, three dormant with different staleness depths.
  const now = dayAfter(T0, 400);
  // One anchor (e3) contains all four claims, with lastPasses staggered so
  // every dormant claim is past the 90-day default.
  const e0 = mk('p'.repeat(40), T0, { a: cs(true), b: cs(true), c: cs(true) });
  const e1 = mk('q'.repeat(40), dayAfter(T0, 100), { a: cs(true), b: cs(true), c: cs(false) }); // c lastPass at e0 (≈400d)
  const e2 = mk('r'.repeat(40), dayAfter(T0, 200), { a: cs(true), b: cs(false), c: cs(false) }); // b lastPass at e1 (≈300d)
  const e3 = mk('s'.repeat(40), dayAfter(T0, 300), { a: cs(false), b: cs(false), c: cs(false), n: cs(false) }); // a lastPass at e2 (≈200d), n never
  const stale = findStaleClaims([e0, e1, e2, e3], { now });
  // n is never-verified → first.
  assert.equal(stale[0].claimId, 'n');
  assert.equal(stale[0].reason, 'never-verified');
  // The rest are dormant, oldest-pass first: c (lastPass T0), b (T+50), a (T+120).
  assert.deepEqual(
    stale.slice(1).map((s) => s.claimId),
    ['c', 'b', 'a'],
  );
});
