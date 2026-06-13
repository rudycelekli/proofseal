/**
 * Single source of truth for the package version. Read from package.json at
 * runtime so the CLI's `--version` and the MCP server's advertised version can
 * never drift from what was actually published (the v0.3.1 tarball once shipped
 * a hardcoded `--version` of 0.3.0 — this makes that class of bug impossible).
 *
 * dist/version.js resolves ../package.json; npm always includes package.json in
 * the tarball, so this works in an installed package too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION: string = JSON.parse(
  readFileSync(join(here, '..', 'package.json'), 'utf8'),
).version;
