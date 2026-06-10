/**
 * variantMarkers — generic, product/supplier-AGNOSTIC subtraction of variant
 * markers from a specification line so the match key carries the CLEAN product,
 * while the removed variant spans are preserved as structured characteristics.
 *
 * WHY (proven lever, not a hypothesis):
 *   On project 11 (Ласточка ОВ) the spec rows carry a noisy variant prefix/suffix:
 *     "Левое исполнение. Боковое подключение dп=15 мм Радиатор настенный EVRA
 *      Compact C33-400-700 Q=1222 Вт"
 *   The matcher key (max(sim(name), sim(full_name))) drowns in that noise: the
 *   structural score is dragged negative and Dice similarity falls below the
 *   candidate threshold. Subtracting the variant spans from the key (leaving
 *   "Радиатор настенный EVRA Compact C33-400-700") lifted durable@1 from 2.7%
 *   to ~53.3% AI-OFF on proj 11 with 0 regressions, multi-project non-regression
 *   clean (gate `worker_brief_lastochka_clean_repr_generic_gate_result.md`).
 *   This module PRODUCTIONIZES that subtraction inside the parser so NEW uploads
 *   get a clean key; the matcher is NOT touched.
 *
 * DESIGN — ATTRIBUTE SYNTAX ONLY (no-hardcode):
 *   Every pattern targets a variant-ATTRIBUTE *syntax* (an adjective+noun phrase,
 *   a `key=value` annotation, a digit-led floor list) — NEVER a product/brand/
 *   supplier literal. There is no "Радиатор"/"Конвектор"/"EVRA"/"Tepla" anywhere.
 *   The lexicon is documented and extensible (append a pattern + a test).
 *
 * no_corrupt_through GUARANTEES (each enforced + tested):
 *   - BARE-ORPHAN: if subtraction empties the string (markers only, no product
 *     head) → return the ORIGINAL untouched. We have no clean head to offer and
 *     must not feed an empty/garbage key into the matcher.
 *   - NO LETTERS LEFT: if what remains has no alphabetic character (only digits/
 *     punctuation survived) → also treat as bare-orphan, keep ORIGINAL.
 *   - BARE DIMENSIONS PRESERVED: the connection-diameter pattern requires the
 *     literal `dп=` token; it does NOT touch a bare DN/Ду/Дн/Ø dimension
 *     (`Дн57х3,5`, `Ду15`) which on pipes/supports IS the discriminator.
 *   - ADJECTIVE `этажный` PRESERVED: the floor pattern is digit-led (`2 этаж`,
 *     `6, 7 этажи`); it never strips the adjective "этажный" inside a product name.
 *   - characteristics are APPENDED (never overwritten) — no loss of existing data.
 */

/** Collapse internal whitespace and trim. */
function collapse(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * One removable variant span.
 *  - `re`     : global regex matching the span. NB: JS `\b` is ASCII-only and
 *               never fires next to Cyrillic, so spans anchor on `(?:^|\s)`
 *               (input is space-padded before matching) instead of `\b`.
 *  - `label`  : short human label used when serializing markers to characteristics.
 */
interface MarkerPattern {
  re: RegExp;
  label: string;
}

/**
 * VARIANT MARKER LEXICON (attribute syntax). Order is not semantically
 * significant for correctness (each is applied independently); markers are
 * re-ordered by original position before serialization.
 */
const MARKER_PATTERNS: MarkerPattern[] = [
  {
    // Execution: "<Adj-neuter> исполнение[.]"  e.g. "Левое исполнение." / "Правое исполнение".
    // Adjective restricted to neuter -ое/-ее ending so it cannot swallow a noun head
    // (a product head is a noun, not a neuter adjective immediately before "исполнение").
    re: /(?:^|\s)[А-Яа-яЁё]+(?:ое|ее)\s+исполнени\S*/gi,
    label: 'исполнение',
  },
  {
    // Connection/direction: "<Adj-neuter> подключение"  e.g. "Нижнее подключение",
    // "Боковое подключение". Requires the nominative neuter -ее/-ое adjective so it
    // won't match a genitive "нижнего подключения" embedded inside a product name.
    re: /(?:^|\s)[А-Яа-яЁё]+(?:ое|ее)\s+подключени[ея]/gi,
    label: 'подключение',
  },
  {
    // Connection-diameter annotation: "dп=15 мм" / "d п = 20 мм" — the *connection*
    // diameter, an explicit `dп=` key=value. Deliberately requires the `dп=` token so
    // it does NOT touch a bare product dimension (Дн57х3,5 / Ду15 / Ø22).
    re: /(?:^|\s)d\s*п\s*=\s*\d+\s*мм/gi,
    label: 'dп',
  },
  {
    // Heat-output annotation: "Q=2430 Вт" / "Q=841 W" (power), plus the rare unit-LESS
    // "...Q=2430" that ends the string (source dropped the unit). Stripped ONLY when the
    // value is followed by a Вт/W power unit (anywhere) OR by end-of-string. A SPACED
    // flow quantity — e.g. pump "Q=5,36 м3/час" — is NOT matched: its trailing token is
    // `м3/час`, neither a Вт-unit nor end, so the flow stays in the key. Glued flow
    // "Q=8,5м3/ч" is likewise untouched. Heat output is the variant axis; flow rate is a
    // product discriminator and must survive. (F1 fix: was unit-OPTIONAL → over-stripped
    // spaced flow. Verified lever-preserving on real proj-11 incl. its 1 unit-less row.)
    re: /(?:^|\s)Q\s*=\s*[\d.,]+(?:\s*[ВвWw]т?\.?(?=\s|$)|\s*(?=$))/gi,
    label: 'Q',
  },
  {
    // Floor markers: "2 этаж", "6, 7, 8, 9 этажи" — a DIGIT-led list followed by
    // этаж/этажи/этажа/этажей. Digit-led so it never touches the adjective "этажный".
    re: /(?:^|\s)\d+(?:\s*,\s*\d+)*\s*этаж(?:и|а|ей)?(?=\s|$)/gi,
    label: 'этаж',
  },
  {
    // Trailing bare power "1222 Вт" at end-of-string. Some rows have a bare "N Вт"
    // tail left after the "Q=" head is consumed elsewhere; only strip at the very end.
    re: /\s\d+\s*Вт\.?\s*$/i,
    label: 'Вт',
  },
];

export interface VariantMarkerResult {
  /** Product name with variant spans removed (the clean match key). */
  cleanName: string;
  /** Removed variant spans, in original document order (deduped, trimmed). */
  markers: string[];
  /**
   * True when variant-marker syntax WAS present but subtraction was refused by a
   * no_corrupt_through guard (bare-orphan / letterless remainder), so `cleanName`
   * is the untouched original and `markers` is empty. Lets callers distinguish a
   * refused bare-orphan from a row that simply had no markers. Diagnostic only.
   */
  refused: boolean;
}

/** A "head" must contain at least one Cyrillic/Latin letter — otherwise it is not a product name. */
const HAS_LETTER_RE = /[A-Za-zА-Яа-яЁё]/;

/**
 * Subtract variant markers from a single spec line.
 *
 * Pure: depends only on its input. Returns the original (markers=[]) whenever
 * subtraction would empty the string or leave a letterless fragment
 * (no_corrupt_through bare-orphan guard).
 */
export function extractVariantMarkers(name: string | null | undefined): VariantMarkerResult {
  const original = String(name ?? '');
  if (!original.trim()) return { cleanName: original, markers: [], refused: false };

  // Space-pad so `(?:^|\s)` anchors fire at both string ends.
  let key = ` ${original} `;
  const spans: Array<{ index: number; text: string }> = [];

  for (const { re } of MARKER_PATTERNS) {
    re.lastIndex = 0; // defensive: global regexes are stateful across calls
    key = key.replace(re, (match, offset: number) => {
      spans.push({ index: offset, text: match.trim() });
      return ' ';
    });
  }

  const cleaned = collapse(key);

  // no_corrupt_through: nothing left, or only digits/punctuation left → keep ORIGINAL.
  // `refused` is true only if marker syntax actually matched (spans non-empty) but
  // we could not offer a clean product head.
  if (!cleaned || !HAS_LETTER_RE.test(cleaned)) {
    return { cleanName: collapse(original), markers: [], refused: spans.length > 0 };
  }

  // Order markers by their position in the source line, dedupe (case-insensitive).
  spans.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const markers: string[] = [];
  for (const s of spans) {
    const t = s.text;
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    markers.push(t);
  }

  return { cleanName: cleaned, markers, refused: false };
}

/**
 * Merge extracted marker spans into an existing characteristics string without
 * losing what is already there. Appends only markers not already present
 * (case-insensitive substring check). Returns the (possibly unchanged) value.
 */
export function mergeMarkersIntoCharacteristics(
  existing: string | null | undefined,
  markers: string[],
): string | null {
  const base = collapse(existing);
  if (markers.length === 0) return existing ?? null;
  const lowerBase = base.toLowerCase();
  // F2 fix: dedupe within the batch too — `name` and `full_name` (= parent+child) often
  // yield the SAME marker, which previously produced "Q=1222 Вт; Q=1222 Вт".
  const seenAdd = new Set<string>();
  const toAdd = markers.filter(m => {
    if (!m) return false;
    const k = m.toLowerCase();
    if (lowerBase.includes(k) || seenAdd.has(k)) return false;
    seenAdd.add(k);
    return true;
  });
  if (toAdd.length === 0) return existing ?? null;
  const joined = toAdd.join('; ');
  return base ? `${base}; ${joined}` : joined;
}

/**
 * Minimal shape this transform needs from a parsed spec row. Kept structural so
 * it works for both the PDF (`SpecificationRow`) and any equivalent row object.
 */
interface CleanableSpecRow {
  name: string;
  full_name: string | null;
  characteristics: string | null;
}

/**
 * Apply variant-marker subtraction to an array of parsed spec rows IN PLACE.
 *
 * For each row this cleans BOTH the standalone `name` and the hierarchy-built
 * `full_name` (the matcher uses max(sim(name), sim(full_name)), so whichever is
 * the product-bearing field must be cleaned). Removed markers are appended to
 * `characteristics`. Bare-orphan rows are left untouched by `extractVariantMarkers`,
 * so their original name/full_name survive (no_corrupt_through).
 *
 * Returns a small summary for the parse-quality gate / diagnostics.
 */
export function applyVariantMarkersToItems<T extends CleanableSpecRow>(
  items: T[],
): { touched: number; bareOrphanKept: number } {
  let touched = 0;
  let bareOrphanKept = 0;

  for (const item of items) {
    const collected: string[] = [];
    let rowTouched = false;
    let rowRefused = false;

    // Clean `name`.
    if (item.name) {
      const r = extractVariantMarkers(item.name);
      if (r.refused) rowRefused = true;
      if (r.markers.length > 0 && r.cleanName !== item.name) {
        item.name = r.cleanName;
        collected.push(...r.markers);
        rowTouched = true;
      }
    }

    // Clean `full_name` (independently — it is built from parent+child and may
    // carry the product head when `name` is a bare marker fragment).
    if (item.full_name) {
      const r = extractVariantMarkers(item.full_name);
      if (r.refused) rowRefused = true;
      if (r.markers.length > 0 && r.cleanName !== item.full_name) {
        item.full_name = r.cleanName;
        collected.push(...r.markers);
        rowTouched = true;
      }
    }

    if (rowTouched) {
      touched++;
      item.characteristics = mergeMarkersIntoCharacteristics(item.characteristics, collected);
    } else if (rowRefused) {
      // Marker syntax was present but subtraction was refused (bare-orphan/letterless):
      // original kept. Counted for diagnostics, not corruption.
      bareOrphanKept++;
    }
  }

  return { touched, bareOrphanKept };
}
