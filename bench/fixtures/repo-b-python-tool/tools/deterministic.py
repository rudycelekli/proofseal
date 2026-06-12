#!/usr/bin/env python3
"""Deterministic-output harness for the ProofKit bench (ADR D9 pattern).

Inline Park-Miller LCG (NOT the random module) seeded from PROOFKIT_SEED;
prints 16 floats. Integer state stays < 2^31 so state/M is an exact
IEEE-754 double, byte-identical across CPython versions and platforms.
"""
import os

M = 2147483647
A = 48271


def main() -> None:
    seed = int(os.environ.get("PROOFKIT_SEED", "42"))
    state = (seed % (M - 1)) + 1
    if state <= 0:
        state += M - 1
    for _ in range(16):
        state = (state * A) % M
        print(f"{state / M:.17g}")


if __name__ == "__main__":
    main()
