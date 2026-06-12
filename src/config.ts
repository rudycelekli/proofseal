/**
 * proofseal.json config loading/saving + path resolution.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { ConfigSchema, SCHEMA_ID, type ProofSealConfig } from './manifest/schema.js';

export const CONFIG_FILENAME = 'proofseal.json';
export const DEFAULT_MANIFEST_PATH = 'proofs/manifest.json';
export const DEFAULT_HISTORY_PATH = 'proofs/history.jsonl';

export interface ResolvedConfig {
  config: ProofSealConfig;
  configPath: string;
  root: string;
  salt: string;
  manifestPath: string;
  historyPath: string;
}

export function configPathFor(root: string): string {
  return join(resolve(root), CONFIG_FILENAME);
}

/** Load and validate proofseal.json; throws with a hint if absent/invalid. */
export function loadConfig(root: string = process.cwd()): ResolvedConfig {
  const absRoot = resolve(root);
  const configPath = configPathFor(absRoot);
  if (!existsSync(configPath)) {
    throw new Error(`${CONFIG_FILENAME} not found in ${absRoot} — run \`proofseal init\` first`);
  }
  const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  return {
    config,
    configPath,
    root: absRoot,
    salt: config.salt ?? basename(absRoot),
    manifestPath: join(absRoot, config.manifest ?? DEFAULT_MANIFEST_PATH),
    historyPath: join(absRoot, config.history ?? DEFAULT_HISTORY_PATH),
  };
}

/** Persist config (pretty-printed, trailing newline). */
export function saveConfig(root: string, config: ProofSealConfig): string {
  const configPath = configPathFor(root);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

/** Default scaffold written by `proofseal init` (ADR R3: green verify in minutes). */
export function defaultConfig(root: string): ProofSealConfig {
  return {
    schema: SCHEMA_ID,
    salt: basename(resolve(root)),
    manifest: DEFAULT_MANIFEST_PATH,
    history: DEFAULT_HISTORY_PATH,
    releases: {},
    claims: [
      {
        id: 'sample-config-schema',
        type: 'marker',
        desc: 'ProofSeal config declares the v1 schema (sample claim — replace with your own)',
        file: CONFIG_FILENAME,
        // The escaped serialization of this marker field cannot collide with
        // the raw schema line, so the marker matches exactly once (R5).
        marker: `"schema": "${SCHEMA_ID}"`,
      },
    ],
  };
}
