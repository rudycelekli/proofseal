# ProofSeal v0.1 Benchmark Report

Benchmark definition: ADR-0001 §3. Honest-comparison policy: ADR D12 — capability
gaps are recorded as "N/A — capability absent" and missing tools as explicit SKIPPED
cells, never silent omissions.

## Provenance

```json
{
  "benchSchema": "proofseal-bench-report/v1",
  "startedAt": "2026-06-12T06:48:22.237Z",
  "gitSha": "4d9511e71de739200946d1acab39f6be6da107d2",
  "gitDirty": true,
  "seeds": {
    "fixtures": 1337,
    "mutations": 42,
    "harness": [
      42,
      7
    ]
  },
  "os": {
    "platform": "darwin",
    "release": "25.5.0",
    "arch": "arm64",
    "cpus": "Apple M4 Pro"
  },
  "node": "v22.19.0",
  "python3": "Python 3.9.6",
  "gitVersion": "git version 2.50.1 (Apple Git-155)",
  "verifyRunsPerFixture": 20,
  "setupRunsPerFixture": 3,
  "wallClockSeconds": 365.4,
  "mutationCount": 45
}
```

## Tool availability

| Tool | Status | Version / reason |
|------|--------|------------------|
| ProofSeal | ok | proofkit 0.1.0 |
| checksum script | ok | sha256sum (Darwin) 1.0 |
| cosign (keyless) | static | keyless signing needs an OIDC identity (interactive browser or ambient CI token); headless run measures setup steps / config LOC / secrets only — set PROOFKIT_BENCH_COSIGN_KEYLESS=1 to opt in to the interactive flow |
| cosign (keypair) | ok | GitVersion:    v3.1.1 |
| in-toto | ok | in-toto 1.4.0 |

## Comparison table (ADR §3.4)

| Metric                          | ProofSeal | checksum script | cosign (keyless) | cosign (keypair) | in-toto |
|---------------------------------|----------|-----------------|------------------|------------------|---------|
| Setup steps (count) | 4 | 3 | 3 | 3 | 4 |
| Setup time (median, s) | 12.14 | 0.03 | N/A — requires interactive OIDC | 3.07 | 1.47 |
| Config LOC | 7 | 109 | 53 | 53 | 64 |
| Secrets to manage (count) | 0 | 0 | 0 | 1 | 1 |
| Verify latency p50 / p95 (ms) | 117.9 / 270 | 677.3 / 729.4 | N/A — requires interactive OIDC | 714.4 / 1252.7 | 264.5 / 272.2 |
| Tamper signaled (% of 45) | 100% (45/45) | 100% (45/45) | N/A — requires interactive OIDC | 100% (45/45) | 100% (45/45) |
| Four-state classification (ProofSeal taxonomy) | 45/45 (100%) | N/A — taxonomy absent | N/A — taxonomy absent | N/A — taxonomy absent | N/A — taxonomy absent |
| Drift vs regression distinction | yes | N/A — capability absent | N/A — capability absent | N/A — capability absent | N/A — capability absent |
| Temporal history + bisection | yes | N/A — capability absent | N/A — capability absent | N/A — capability absent | N/A — capability absent |

Notes:
- Mutation suite: 45 seeded mutations (seed 42), committed at `bench/mutations/mutations.json`.
- **Tamper signaled** is the only cross-tool score: did the tool raise ANY signal
  on the mutation, judged under the tool's OWN semantics. A cosign or checksum
  hard FAIL on a benign append is CORRECT for a byte-integrity model and counts
  as signaled — it is never stamped "misclassified".
- **Four-state classification** (pass / drift / regressed / missing) is ProofSeal's
  OWN taxonomy. It is scored for ProofSeal only; competitors read
  "N/A — taxonomy absent" because grading them on a rubric only ProofSeal
  subscribes to would be a self-serving metric (premortem round 3 finding).
- checksum script: `SHA256SUMS` is generated over ALL git-tracked fixture files
  (practitioner-grade `git ls-files` coverage). Caveat: it is not tamper-evident —
  an attacker who can edit files can regenerate it. The manifest-byte class only
  measures accidental corruption for B1, not adversarial resistance.

## Per-slice breakdown

### Per fixture

#### repo-a-npm-lib (100 claims: 20 file-hash, 80 marker)

| Tool | Verify p50 (ms) | Verify p95 (ms) | Tamper signaled | Four-state classification (ProofSeal taxonomy) |
|------|-----------------|-----------------|-----------------|------------------------------------------------|
| ProofSeal | 116.8 | 119.3 | 15/15 | 15/15 |
| checksum script | 588.9 | 636.2 | 15/15 | N/A — taxonomy absent |
| cosign (keyless) | N/A — requires interactive OIDC | — | — | N/A — taxonomy absent |
| cosign (keypair) | 1238.3 | 1256.3 | 15/15 | N/A — taxonomy absent |
| in-toto | 266.7 | 272.8 | 15/15 | N/A — taxonomy absent |

#### repo-b-python-tool (100 claims: 5 file-hash, 2 harness, 93 marker)

| Tool | Verify p50 (ms) | Verify p95 (ms) | Tamper signaled | Four-state classification (ProofSeal taxonomy) |
|------|-----------------|-----------------|-----------------|------------------------------------------------|
| ProofSeal | 264.1 | 276.2 | 15/15 | 15/15 |
| checksum script | 679.6 | 697.4 | 15/15 | N/A — taxonomy absent |
| cosign (keyless) | N/A — requires interactive OIDC | — | — | N/A — taxonomy absent |
| cosign (keypair) | 714.4 | 727.2 | 15/15 | N/A — taxonomy absent |
| in-toto | 263.5 | 272.1 | 15/15 | N/A — taxonomy absent |

#### repo-c-docs-site (100 claims: 5 file-hash, 95 marker)

| Tool | Verify p50 (ms) | Verify p95 (ms) | Tamper signaled | Four-state classification (ProofSeal taxonomy) |
|------|-----------------|-----------------|-----------------|------------------------------------------------|
| ProofSeal | 117.1 | 119.8 | 15/15 | 15/15 |
| checksum script | 703.2 | 741 | 15/15 | N/A — taxonomy absent |
| cosign (keyless) | N/A — requires interactive OIDC | — | — | N/A — taxonomy absent |
| cosign (keypair) | 541.1 | 557.8 | 15/15 | N/A — taxonomy absent |
| in-toto | 263.2 | 268 | 15/15 | N/A — taxonomy absent |

### Per mutation class (tamper signaled / total)

| Tool | manifest-byte | marker-removal | edit-marker-intact | file-deletion |
|------|---|---|---|---|
| ProofSeal | 12/12 | 12/12 | 12/12 | 9/9 |
| checksum script | 12/12 | 12/12 | 12/12 | 9/9 |
| cosign (keyless) | N/A | N/A | N/A | N/A |
| cosign (keypair) | 12/12 | 12/12 | 12/12 | 9/9 |
| in-toto | 12/12 | 12/12 | 12/12 | 9/9 |

ProofSeal additionally classified 45/45 mutations into its four-state taxonomy
(per class, correct/total: manifest-byte 12/12, marker-removal 12/12, edit-marker-intact 12/12, file-deletion 9/9). The taxonomy is ProofSeal-specific, so competitors carry no classification score.

### Per claim type (workload composition)

| Claim type | Count (all fixtures) | Expressible by checksum | by cosign | by in-toto | by ProofSeal |
|------------|----------------------|-------------------------|-----------|------------|-------------|
| file-hash | 30 | yes | yes (signed blob) | yes (artifact rule) | yes |
| marker | 268 | yes (grep loop) | N/A — capability absent | N/A — capability absent | yes |
| harness | 2 | N/A — capability absent (hashes the script file only) | N/A — capability absent | N/A — capability absent | yes |

## Sample annotations

### ProofSeal

- All 45 mutations signaled and correctly classified under the four-state taxonomy.

### checksum script

- All 45 mutations signaled under checksum script's own semantics.
- Context — **M-009** (`edit-marker-intact` on `src/module10.ts#A-MK-053`, repo-a-npm-lib): signaled as `fail`. That is CORRECT under checksum script's security model (any byte change breaks integrity); the drift/regression distinction is a ProofSeal capability, not an error here.

### cosign (keypair)

- All 45 mutations signaled under cosign (keypair)'s own semantics.
- Context — **M-009** (`edit-marker-intact` on `src/module10.ts#A-MK-053`, repo-a-npm-lib): signaled as `fail`. That is CORRECT under cosign (keypair)'s security model (any byte change breaks integrity); the drift/regression distinction is a ProofSeal capability, not an error here.

### in-toto

- All 45 mutations signaled under in-toto's own semantics.
- Context — **M-009** (`edit-marker-intact` on `src/module10.ts#A-MK-053`, repo-a-npm-lib): signaled as `fail`. That is CORRECT under in-toto's security model (any byte change breaks integrity); the drift/regression distinction is a ProofSeal capability, not an error here.

