/**
 * Authoring-time marker lint (premortem #7: marker robustness).
 *
 * Heuristics that flag fragile markers at `claim add` time — the moment the
 * user can still pick a better one. Lint results are ADVISORY ONLY: they are
 * printed as warnings and never fail the command (a noisy hard failure here
 * would push users back to file-hash claims, which are MORE fragile).
 */
import { markerOccurrences } from './hash.js';

const SUGGESTION =
  'prefer a function/identifier name or a structural code fragment unique to the fix';

/**
 * Lint a marker string against optional target-file text.
 * Returns human-readable warning strings (empty array = no concerns).
 */
export function lintMarker(marker: string, fileText?: string): string[] {
  const warnings: string[] = [];

  // (i) Non-unique marker: a duplicate occurrence can mask removal of the
  // real fix (the OTHER copy keeps the claim green). Whitespace-normalized,
  // consistent with how presence is verified.
  if (fileText !== undefined) {
    const n = markerOccurrences(fileText, marker);
    if (n > 1) {
      warnings.push(
        `marker appears ${n} times in the target file (whitespace-normalized) — ` +
          `duplicates can mask removal of the real fix; ${SUGGESTION}`,
      );
    }
  }

  // (ii) Looks like a log/exception message. These strings are routinely
  // reworded during refactors, so they make poor long-lived markers.
  const trimmed = marker.trim();
  const quotedWhole = /^["'`].*["'`]$/s.test(trimmed);
  const hasPlaceholders = /%[sdif]|\$\{|\{\}/.test(marker);
  const hasLogWords = /\b(error|warn|fail|cannot|invalid|exception)\b/i.test(marker);
  // "natural-language sentence": several space-separated words starting with a letter.
  const isSentence = /^[A-Za-z]/.test(trimmed) && trimmed.split(/\s+/).length >= 4;
  if (quotedWhole || hasPlaceholders || (hasLogWords && isSentence)) {
    warnings.push(
      'marker looks like a log/exception message — message text is routinely ' +
        `reworded and will read as a false regression; ${SUGGESTION}`,
    );
  }

  // (iii) Formatting-sensitive characters that formatters commonly rewrite.
  const traits: string[] = [];
  if (marker.includes('`')) traits.push('backticks');
  if (/ {2,}/.test(marker)) traits.push('multiple consecutive spaces');
  if (/^\s|\s$/.test(marker)) traits.push('leading/trailing whitespace');
  if (marker.length >= 2 && /^["'].*["']$/s.test(marker)) traits.push('quotes at both ends');
  if (traits.length > 0) {
    warnings.push(
      `marker contains formatting-sensitive characters (${traits.join(', ')}) — ` +
        `formatters like Prettier may rewrite these; ${SUGGESTION}`,
    );
  }

  return warnings;
}
