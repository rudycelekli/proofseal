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
