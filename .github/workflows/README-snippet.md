# GitHub Actions snippet for proofseal users

Copy this into `.github/workflows/proofseal.yml` in your repo:

```yaml
name: Verify proofseal manifest

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      # fetch-depth: 1 is sufficient — verify re-derives the key from the
      # manifest's embedded gitCommit and never shells out to git.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Note: manifest.gitCommit intentionally lags HEAD — it records the
      # commit that was checked out at seal time, not the verifying commit.
      - name: Verify sealed manifest
        run: npx proofseal verify
```
