// bench/lib/mutate.mjs — applies the committed fault-injection list
// (bench/mutations/mutations.json, seed 42) to a fresh fixture copy.
// Four classes per ADR sub-claim C4.
import fs from 'node:fs';
import path from 'node:path';
import { makeRng } from './util.mjs';

function flipHexNibble(hex, offset) {
  // Replace one nibble with a DIFFERENT char from the same hex alphabet.
  // Staying within [0-9a-f] matters: an out-of-alphabet byte makes e.g.
  // `sha256sum -c` treat the line as "improperly formatted" and SKIP it
  // (exit 0 without --strict) instead of detecting the corruption.
  const i = offset % hex.length;
  const c = hex[i];
  const upper = c >= 'A' && c <= 'F';
  const alphabet = upper ? '0123456789ABCDEF' : '0123456789abcdef';
  const idx = alphabet.indexOf(upper ? c : c.toLowerCase());
  const flipped = alphabet[(idx + 1) % alphabet.length];
  return hex.slice(0, i) + flipped + hex.slice(i + 1);
}

// Mutate ProofKit's sealed manifest at a specific field (single-byte-level
// fault: one hex nibble flipped, or a summary count off by one).
function mutateProofkitManifest(manifestPath, target, offset) {
  const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (target === 'manifest:integrity.signature') {
    if (!doc.integrity?.signature) throw new Error('manifest has no integrity.signature');
    doc.integrity.signature = flipHexNibble(doc.integrity.signature, offset);
  } else if (target === 'manifest:integrity.manifestHash') {
    if (!doc.integrity?.manifestHash) throw new Error('manifest has no integrity.manifestHash');
    doc.integrity.manifestHash = flipHexNibble(doc.integrity.manifestHash, offset);
  } else if (target === 'manifest:claims[].sha256') {
    const claims = doc.manifest?.claims || doc.claims || [];
    const withHash = claims.filter((c) => typeof c.sha256 === 'string' && c.sha256.length >= 8);
    if (!withHash.length) throw new Error('manifest has no claim sha256 to mutate');
    const victim = withHash[offset % withHash.length];
    victim.sha256 = flipHexNibble(victim.sha256, offset);
  } else if (target === 'manifest:manifest.summary.verified') {
    const summary = doc.manifest?.summary || doc.summary;
    if (!summary || typeof summary.verified !== 'number') throw new Error('manifest has no summary.verified');
    summary.verified = summary.verified + 1;
  } else {
    throw new Error(`unknown manifest mutation target: ${target}`);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n');
}

// Generic trust artifact (SHA256SUMS, .sig blob, .link metadata): flip one
// byte. For text artifacts prefer a hex run so the fault is a plausible
// single-character corruption.
function mutateGenericArtifact(artifactPath, offset) {
  const buf = fs.readFileSync(artifactPath);
  const text = buf.toString('latin1');
  const hexRun = text.match(/[0-9a-fA-F]{40,}/);
  if (hexRun) {
    const start = hexRun.index;
    const mutated = text.slice(0, start) + flipHexNibble(hexRun[0], offset) + text.slice(start + hexRun[0].length);
    fs.writeFileSync(artifactPath, Buffer.from(mutated, 'latin1'));
    return;
  }
  const i = offset % buf.length;
  buf[i] = buf[i] ^ 0x01;
  fs.writeFileSync(artifactPath, buf);
}

/**
 * Apply one mutation inside workDir.
 * @param workDir       sealed fixture copy
 * @param mutation      entry from mutations.json
 * @param claimsById    Map(claimId -> claim) for the fixture
 * @param tool          adapter (provides trustArtifactPath + id)
 */
export function applyMutation(workDir, mutation, claimsById, tool) {
  const offset = Number((mutation.operation.match(/@(\d+)$/) || [])[1] ?? 0);

  if (mutation.class === 'manifest-byte') {
    const rel = typeof tool.trustArtifactPath === 'function' ? tool.trustArtifactPath(workDir) : tool.trustArtifactPath;
    if (!rel) throw new Error(`${tool.id}: no trust artifact found to mutate`);
    const artifact = path.isAbsolute(rel) ? rel : path.join(workDir, rel);
    if (tool.id === 'proofkit') mutateProofkitManifest(artifact, mutation.target, offset);
    else mutateGenericArtifact(artifact, offset);
    return;
  }

  const [file, claimId] = mutation.target.split('#');
  const filePath = path.join(workDir, file);

  if (mutation.class === 'marker-removal') {
    const claim = claimsById.get(claimId);
    if (!claim) throw new Error(`mutation ${mutation.id}: claim ${claimId} not found`);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const kept = lines.filter((l) => !l.includes(claim.marker));
    if (kept.length === lines.length) throw new Error(`mutation ${mutation.id}: marker not present in ${file}`);
    fs.writeFileSync(filePath, kept.join('\n'));
    return;
  }

  if (mutation.class === 'edit-marker-intact') {
    // Benign edit; deterministic content (seeded from the mutation id) so the
    // run is reproducible. All markers in the file stay intact.
    const rng = makeRng(42 + Number(mutation.id.slice(2)));
    const isMd = file.endsWith('.md');
    const line = isMd
      ? `<!-- bench-drift-edit ${mutation.id} ${rng.nextInt()} -->`
      : `# bench-drift-edit ${mutation.id} ${rng.nextInt()}`;
    fs.appendFileSync(filePath, '\n' + (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs') ? `// bench-drift-edit ${mutation.id} ${rng.nextInt()}` : line) + '\n');
    return;
  }

  if (mutation.class === 'file-deletion') {
    fs.rmSync(filePath, { force: true });
    return;
  }

  throw new Error(`unknown mutation class: ${mutation.class}`);
}
