#!/usr/bin/env node
// Trivial deterministic 'build': byte-copies src/*.ts to dist/*.js so
// build outputs are byte-stable across machines (bench fixture only).
import fs from 'node:fs';
import path from 'node:path';
const src = 'src';
const dist = 'dist';
fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(src).sort()) {
  if (!f.endsWith('.ts')) continue;
  fs.copyFileSync(path.join(src, f), path.join(dist, f.replace(/\.ts$/, '.js')));
}
