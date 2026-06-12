// Deterministic harness fixture for ProofSeal integration tests.
// Emits a fixed-length list of pseudo-random floats derived ONLY from
// PROOFSEAL_SEED (LCG, integer math -> bit-identical across platforms).
// ADR-0001 §5.3 / D9: harness claims run `cmd` with PROOFSEAL_SEED set and
// quantize numeric stdout to N decimals before hashing.
let s = (Number(process.env.PROOFSEAL_SEED ?? 0) >>> 0) || 1;
const next = () => {
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  return s / 2 ** 32;
};
const out = [];
for (let i = 0; i < 16; i++) out.push(next());
process.stdout.write(out.map((v) => v.toFixed(9)).join('\n') + '\n');
