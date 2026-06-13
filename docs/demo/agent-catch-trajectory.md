# A real agent catch — captured trajectory

This is not a description of the intended pattern. It is a recorded run of an
agent (Claude, via the ProofSeal MCP server) catching a silent regression in a
financial calculation **before the commit landed** — the exact failure that no
unit test was watching for.

Reproduce it yourself: every command below runs against a throwaway git repo.

---

## The setup: a load-bearing number nothing tests

`report.py` — a deterministic quarterly-revenue model. No randomness, no I/O.

```python
def quarterly_revenue(base, growth_rate, quarters):
    total = 0.0
    rev = base
    for _ in range(quarters):
        rev = rev * (1 + growth_rate)
        total += rev
    return round(total, 2)

# quarterly_revenue(100000.0, 0.08, 4) -> 486660.1
```

Seal the behavior (not the file — the *output*):

```console
$ proofseal claim add --id quarterly-revenue --type harness \
    --cmd "python3 report.py" --seed 42 --quantize-decimals 2
Added claim 'quarterly-revenue' (harness)

$ proofseal seal
Sealed proofs/manifest.json
claims: 2  verified: 2  missing: 0
```

## The regression: a refactor that looks equivalent and isn't

An agent "cleans up" the loop — moves one line. It still runs, still returns a
float, would pass any test that only checks the *type* or that the script exits
0. But the compounding is now off by one quarter:

```python
    for _ in range(quarters):
        total += rev          # <-- moved BEFORE the growth step
        rev = rev * (1 + growth_rate)
```

```console
$ python3 report.py
450611.2          # was 486660.1 — a silent 7.4% error in a financial report
```

No test in the repo fails. `git diff` shows a tidy, plausible 2-line refactor.

## The catch: the agent asks ProofSeal before committing

The agent (MCP `clientInfo.name = "claude-code"`) calls the `verify_claims`
tool. Raw JSON-RPC response, structuredContent:

```json
{
  "ok": false,
  "signature": { "valid": true, "publicKeyReproducible": true },
  "summary": { "totalClaims": 2, "pass": 1, "drift": 0, "regressed": 1, "missing": 0 },
  "results": [
    { "id": "sample-config-schema", "type": "marker",  "status": "pass" },
    { "id": "quarterly-revenue",    "type": "harness", "status": "regressed" }
  ]
}
```

`regressed: 1`. Not "drift" (a harmless reformat) — **regressed**. The harness
quantized the seeded output, hashed it, and the hash no longer matches the
sealed reference. A `sha256sum` would only say "different"; `grep` would see
nothing wrong; the tests are green. ProofSeal says: *you broke a promise.*

## The fix: the regression never reaches history

The agent reverts the refactor and re-verifies before committing:

```console
$ python3 report.py
486660.1
$ proofseal verify
Summary: pass=2 drift=0 regressed=0 missing=0
```

The bad number was never committed. The agent caught it the way a careful
teammate would — except it never forgets to look.

---

## What this proves (and what it doesn't)

- **Proves:** an agent, over MCP, distinguished a real behavioral regression
  from benign change and surfaced it pre-commit, with no test covering the
  behavior. That is the whole thesis of the tool, demonstrated rather than
  asserted.
- **Does not prove:** anything about authentication. The `signature.valid` field
  is a commit-bound checksum (re-derivable by anyone with the manifest), not
  third-party identity — see
  [the seal section in the README](../../README.md). The catch above does not
  depend on the signature at all; it depends on the sealed harness reference.
