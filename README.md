# ProofSeal

**README claims that stay true.**

ProofSeal seals the claims your README makes — by file hash, by a marker in the code, or by a test harness that backs the claim — once, at the moment they are true. In CI, `proofseal verify` re-checks every seal and classifies each claim as **pass**, **drift** (the sealed artifact changed), **regressed** (it used to pass and no longer does), or **missing** (the artifact is gone). When a claim breaks somewhere in your history, `proofseal history --bisect` walks the commits to find the range where it broke. The result: a README you can trust, enforced the same way you enforce tests.

## Status

**v0.1.0 is in private beta.**

## Want in?

Comment on the [Notify me issue](../../issues) or DM [@rudycelekli](https://github.com/rudycelekli).

## Example (coming in v0.1.0)

```bash
# Seal the claims in your README
npx proofseal init

# Re-verify in CI: pass / drift / regressed / missing
npx proofseal verify

# Find where a claim broke
npx proofseal history --bisect
```

## License

MIT © 2026 rudycelekli

## Credit

Builds on ideas from the ruvnet open-source ecosystem (ruflo witness manifests, RuVector marker verification).
