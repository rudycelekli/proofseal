"""pktool CLI entrypoint (bench fixture)."""
import sys


def main() -> int:
    print("pktool", " ".join(sys.argv[1:]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
# PROOFKIT:fix-b-011 merkle-relay-602
# PROOFKIT:fix-b-012 lattice-oracle-164
# PROOFKIT:fix-b-013 sentry-beacon-115
# PROOFKIT:fix-b-014 shard-merkle-288
# PROOFKIT:fix-b-015 sentry-probe-347
# PROOFKIT:fix-b-016 relay-relay-855
# PROOFKIT:fix-b-017 witness-kernel-994
