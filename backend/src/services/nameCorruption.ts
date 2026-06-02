/**
 * Broken-font name-corruption detector.
 *
 * Some supplier PDFs embed a subset font without a usable ToUnicode CMap, so text
 * extraction interleaves stray Latin letters / digits INSIDE Cyrillic words
 * (e.g. «Радиатор» -> «PР0а0диатор», «кВт» -> «кBт»). Every stray char is plain
 * ASCII, so it is invisible to replacement-char / control-char quality checks and
 * silently poisons matching & training.
 *
 * Signal = a "sandwich": a Latin letter or digit wedged BETWEEN two Cyrillic letters
 * inside one maximal alphanumeric run. Cyrillic х/Х (U+0445/U+0425) are NOT counted
 * as anchors because they are routinely used as the «×» dimension sign (Ду32х25),
 * which would otherwise false-fire. Validated on the full prod corpus in Stage 1:
 * the invoice-level ratio isolates exactly the fully-corrupt invoices, and the
 * Latin-wedge sub-signal had ZERO false positives across 43 invoices.
 *
 * NOTE: keep this logic in lock-step with scripts/name_corruption.py (regression gate).
 * No hardcoded supplier names or words — pure Unicode structure.
 */

/** Invoice-level corruption ratio at/above which the invoice is no longer a silent "success". */
export const NAME_CORRUPTION_RATIO_THRESHOLD = 0.5;

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isLatin = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isCyrillic = (code: number): boolean => code >= 0x0400 && code <= 0x04ff;
/** Cyrillic that can anchor a sandwich — excludes х/Х (used as the × dimension sign). */
const isCyrAnchor = (code: number): boolean =>
  isCyrillic(code) && code !== 0x0445 && code !== 0x0425;
/** Chars that belong to a maximal "word" run (split on anything else: space, -, ., /, (, …). */
const isRunChar = (code: number): boolean =>
  isDigit(code) || isLatin(code) || isCyrillic(code);

export interface NameCheck {
  /** A Latin letter OR digit is wedged between two Cyrillic anchors (broad signal). */
  sandwich: boolean;
  /** A Latin LETTER is wedged between two Cyrillic anchors (high-precision: ~0 false positives). */
  latWedge: boolean;
}

/** Inspect a single item name for intra-word script corruption. */
export function isNameCorrupted(name: string): NameCheck {
  let sandwich = false;
  let latWedge = false;
  if (!name) return { sandwich, latWedge };

  const len = name.length;
  let i = 0;
  while (i < len) {
    if (!isRunChar(name.charCodeAt(i))) { i++; continue; }
    // maximal run [i, j)
    let j = i;
    while (j < len && isRunChar(name.charCodeAt(j))) j++;

    let firstAnchor = -1;
    let lastAnchor = -1;
    for (let k = i; k < j; k++) {
      if (isCyrAnchor(name.charCodeAt(k))) {
        if (firstAnchor === -1) firstAnchor = k;
        lastAnchor = k;
      }
    }
    if (firstAnchor !== -1 && lastAnchor > firstAnchor) {
      for (let k = firstAnchor + 1; k < lastAnchor; k++) {
        const code = name.charCodeAt(k);
        if (isDigit(code) || isLatin(code)) {
          sandwich = true;
          if (isLatin(code)) latWedge = true;
        }
      }
    }
    if (sandwich && latWedge) break; // strongest possible verdict reached
    i = j;
  }
  return { sandwich, latWedge };
}

export interface NameCorruptionResult {
  /** flaggedCount / total — invoice-level corruption ratio. */
  ratio: number;
  /** number of names with a sandwich hit. */
  flaggedCount: number;
  total: number;
  /** indices of rows with a high-precision Latin-wedge (safe to flag per-row). */
  latWedgeRows: number[];
}

/** Aggregate corruption over an invoice's item names. */
export function analyzeNameCorruption(names: string[]): NameCorruptionResult {
  const total = names.length;
  if (total === 0) return { ratio: 0, flaggedCount: 0, total: 0, latWedgeRows: [] };

  let flaggedCount = 0;
  const latWedgeRows: number[] = [];
  for (let idx = 0; idx < total; idx++) {
    const r = isNameCorrupted(names[idx]);
    if (r.sandwich) flaggedCount++;
    if (r.latWedge) latWedgeRows.push(idx);
  }
  return { ratio: flaggedCount / total, flaggedCount, total, latWedgeRows };
}
