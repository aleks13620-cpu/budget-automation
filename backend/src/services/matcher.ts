import stringSimilarity from 'string-similarity';
import { getDatabase } from '../database';
import { matchWithGemini } from './llmMatcher';
import { applyDomainAliases } from './matcherAliases';

export interface MatchCandidate {
  specItemId: number;
  invoiceItemId: number;
  confidence: number;
  matchType: 'exact_article' | 'learned_rule' | 'name_similarity' | 'name_characteristics' | 'llm_suggestion';
  source: 'invoice' | 'price_list';
  quantityScore: -1 | 0 | 1;
  dnScore: -1 | 0 | 1;
  matchingRuleId?: number | null;
  matchReason?: string | null;
  isAnalog?: boolean;
}

interface SpecItemRow {
  id: number;
  position_number: string | null;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  article: string | null;
  product_code: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
  parent_item_id: number | null;
  full_name: string | null;
}

interface InvoiceItemRow {
  id: number;
  invoice_id: number;
  article: string | null;
  name: string;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  supplier_id: number | null;
  source?: 'invoice' | 'price_list';
}

interface MatchingRule {
  id: number;
  specification_pattern: string;
  invoice_pattern: string;
  confidence: number;
  times_used: number;
  supplier_id: number | null;
  is_negative: number;
  is_analog: number;
  source?: string;
}

// Stop words to remove during normalization (Russian units, articles, etc.)
const STOP_WORDS = new Set([
  'мм', 'см', 'м', 'шт', 'кг', 'г', 'л', 'мл', 'компл', 'комплект',
  'набор', 'ед', 'пог', 'кв', 'куб', 'п', 'к', 'и', 'в', 'с', 'на',
  'для', 'из', 'по', 'от', 'до', 'счет', 'счете',
]);

let _synonymCache: Map<string,string> | null = null;
let _constructionSynonymCache: Map<string,string> | null = null;

/** Сброс кешей синонимов после записи в БД (learned). */
export function invalidateMatcherSynonymCaches(): void {
  _synonymCache = null;
  _constructionSynonymCache = null;
}

function getSynonymMap(): Map<string,string> {
  if (_synonymCache) return _synonymCache;
  const db = getDatabase();
  const rows = db.prepare('SELECT synonym, canonical FROM size_synonyms').all() as {synonym:string;canonical:string}[];
  _synonymCache = new Map(rows.map(r => [r.synonym.toLowerCase(), r.canonical.toLowerCase()]));
  return _synonymCache;
}

function getConstructionSynonymMap(): Map<string,string> {
  if (_constructionSynonymCache) return _constructionSynonymCache;
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT LOWER(TRIM(abbreviation)) as a, LOWER(TRIM(full_form)) as f FROM construction_synonyms'
  ).all() as { a: string; f: string }[];
  _constructionSynonymCache = new Map(rows.map(r => [r.a, r.f]));
  return _constructionSynonymCache;
}

function normalizeSizeTerms(text: string): string {
  const map = getSynonymMap();
  let result = text;
  for (const [syn, can] of map) {
    const re = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(re, can);
  }
  return result;
}

function normalizeConstructionTerms(text: string): string {
  const map = getConstructionSynonymMap();
  const entries = [...map.entries()].sort((x, y) => y[0].length - x[0].length);
  let result = text;
  for (const [abbr, full] of entries) {
    const re = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(re, full);
  }
  return result;
}

function removeGostBrackets(text: string): string {
  return text
    .replace(/\([^)]*(?:ГОСТ|ТУ)\s*[\d\s\-\.\/]*[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUnitSynonyms(text: string): string {
  return text
    .replace(/\bм\.п\.\b/gi, 'м')
    .replace(/\bм\.пог\.\b/gi, 'м')
    .replace(/\bпог\.м\.\b/gi, 'м')
    .replace(/\bпм\b/gi, 'м')
    .replace(/\bштук[аи]?\b/gi, 'шт')
    .replace(/\bкомплект[аов]?\b/gi, 'компл');
}

function normalizeEngineeringTokens(text: string): string {
  let result = text.toLowerCase().replace(/ё/g, 'е');

  // Normalize decimal comma in sizes/prices to dot FIRST, before the DN-marker
  // rules below. Those rules capture only the integer diameter and reinsert it
  // spaced («Дн108,0» -> «dn 108 …»); if the «,0» tail were still attached when
  // they fire, it would be split off and later leak as a phantom bare size.
  // Converting «108,0»->«108.0» up front lets each DN rule swallow the «.0»
  // fraction in one shot (DN is a nominal integer — the fraction is dropped).
  result = result.replace(/(\d),(\d)/g, '$1.$2');

  // Safe canonicalization: apply only explicit engineering token patterns.
  result = result.replace(/[ø⌀]/g, ' dn ');
  result = result.replace(/(^|\s)ду\.?\s*(\d{1,4})(?:\.\d+)?(?=\s|$)/gi, ' dn $2 ');
  // Cyrillic outer-diameter markers «Дн» / «дп» (e.g. «Дн57х3,5», «дп=15») ->
  // canonical DN. Requires trailing digits so plain words («дно»,
  // «переходной») are never touched. A trailing decimal fraction is consumed and
  // dropped: «Дн57,5» and «Дн57,8» are the same nominal DN (57), not a conflict.
  result = result.replace(/(^|[^a-zа-я0-9])д[нп]\.?\s*=?\s*(\d{1,4})(?:\.\d+)?/gi, '$1 dn $2 ');
  result = result.replace(/\bdn\.?\s*(\d{1,4})(?:\.\d+)?\b/gi, ' dn $1 ');
  result = result.replace(/\bd\s*=\s*(\d{1,4})(?:\.\d+)?\b/gi, ' dn $1 ');
  result = result.replace(/\bd\s*(\d{1,4})(?:\.\d+)?\b/gi, ' dn $1 ');

  // Normalize size separators 500x300, 500×300, 500 X 300, 500*300.
  result = result.replace(/(\d)\s*[xх×*]\s*(\d)/gi, '$1x$2');

  return result;
}

/**
 * Normalize a string for fuzzy matching:
 * - lowercase, trim
 * - remove punctuation, extra spaces
 * - remove stop words
 */
export function normalizeForMatching(text: string, section?: string | null): string {
  let s = removeGostBrackets(text);
  s = normalizeUnitSynonyms(s);
  s = normalizeEngineeringTokens(s);
  s = normalizeSizeTerms(s);
  s = normalizeConstructionTerms(s);
  s = s.toLowerCase().trim();
  // Remove punctuation except letters, digits, spaces
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Remove stop words
  const words = s.split(' ').filter(w => w.length > 0 && !STOP_WORDS.has(w));
  const result = words.join(' ');
  // Append domain-specific canonical tokens (append-not-replace).
  return applyDomainAliases(result, section);
}

function extractEntityWords(text: string): string {
  const m = text.match(/^(.*?)(?:\s+(?:DN|Ду|d=|D=|du)?\s*\d|\s+\d{2,}[xX×\/]|\s+\d+\s*(?:мм|mm))/i);
  if (m) return m[1].trim().toLowerCase();
  return text.toLowerCase();
}

export function isParameterizedSpecName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/^(δ|d|du|dn|ø|⌀)\s*=?\s*\d{1,4}/i.test(n)) return true;
  if (/^\d{2,4}\s*[xх×]\s*\d{2,4}(\s|$)/i.test(n)) return true;
  if (/^[a-zа-я]{0,4}\d{2,4}[-xх×]\d{2,4}([-\s]\d{2,4})?$/i.test(n)) return true;
  return false;
}

/**
 * DB-free structural normalization: GOST/TU bracket stripping + engineering
 * token canonicalization (DN/Ду/Дн/дп/ø, size separators, decimal comma).
 * Intentionally excludes the DB-backed synonym/alias steps — structural feature
 * extraction depends only on lexical form, so it stays pure and testable.
 */
function normalizeStructuralTokens(text: string): string {
  let s = normalizeEngineeringTokens(removeGostBrackets(text));
  // Dimension pairs joined by the word «на» («3600 на 1200») are a cross-section
  // for discrimination, identical to «3600x1200» / «3600*1200» (those symbol
  // separators are already canonicalized inside normalizeEngineeringTokens).
  // Done here, not in the shared normalizer, because the main matching path
  // strips «на» as a stop word; the structural path keeps it as a separator.
  s = s.replace(/(\d)\s*на\s*(\d)/gi, '$1x$2');
  return s;
}

export function extractDnValue(text: string): number | null {
  const normalized = normalizeStructuralTokens(text);
  // Allow separators between «dn» and the digits («dn-50», «dn. 50») — the old
  // full-pipeline normalization stripped them, so preserve that. No trailing \b:
  // a cross-section suffix glues to the digits («dn57x3.5»), and \b would fail
  // between the digit and the `x`.
  const match = normalized.match(/\bdn[\s.\-/]*(\d{1,4})/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function getQuantityScore(specQty: number | null, invQty: number | null): -1 | 0 | 1 {
  if (specQty == null || invQty == null || specQty <= 0 || invQty <= 0) return 0;
  const diff = Math.abs(specQty - invQty);
  if (diff < 0.0001) return 1;
  const relDiff = diff / Math.max(specQty, invQty);
  if (relDiff <= 0.05) return 0;
  return -1;
}

export interface MarkingFeatures {
  dn: number | null;        // diameter (DN / Ду / Дн / дп / ø), null if absent
  cross: string | null;     // cross-section «AxB», e.g. "57x3.5"
  config: string | null;    // multi-way config «NN-NN-NN», e.g. "16-20-16"
  marks: string[];          // short Latin marking codes, e.g. ["cv"], ["cvl"]
  sizes: number[];          // bare dimension integers, e.g. fixator [16]
}

// Multi-way size/config token, e.g. tee «16-20-16» (transition) vs «16-16-16»
// (equal-pass). Requires >= 3 dash-joined numbers so it does not catch a range
// («16-20») or a letter-prefixed equipment code («C22-400-600», whose leading
// letter glues to the first number and removes the boundary before it).
const CONFIG_RE = /\b\d{1,4}-\d{1,4}(?:-\d{1,4})+\b/;
// Cross-section size «AxB», e.g. «57x3.5» (pipe section) or «3600x1200»
// (radiator panel), after separator/comma normalization. Both components allow
// up to 4 digits so a full dimension pair is captured as one ordered entity.
const CROSS_RE = /\b(\d{1,4})x(\d{1,4}(?:\.\d+)?)\b/;
// Short all-caps Latin marking codes (CV, CVL, C). Brand names are Title-case
// and codes glued to digits (DN15, PN16) lack the trailing boundary, so neither
// is picked up.
const MARK_RE = /\b[A-Z]{1,3}\b/g;
// Tokens that look like marks but are diameter markers or standard prefixes —
// excluded so they never drive a marking conflict.
const EXCLUDED_MARKS = new Set(['dn', 'du', 'din', 'iso', 'en']);
// Standard references (ГОСТ/ТУ/DIN/...) whose numbers must not be read as sizes
// or configs. ASCII \b is unreliable around Cyrillic, hence the explicit
// non-letter/non-digit boundary group.
const STANDARD_REF_RE = /(^|[^a-zа-яё0-9])(?:гост|ост|ту|сто|снип|din|iso|en)[\s.№-]*\d[\d.\-/]*/gi;
// Free catalog / article codes («арт. 123», «артикул 456», «код 789»): their
// digits are an order reference, not a physical size, so they must not fabricate
// a bare-size conflict between two lines of the same product. Keyword-gated and
// digit-anchored (a separator run then a digit must follow), so ordinary words
// like «кодовый», «каток», «стандарт» are never stripped. Longest keyword first
// so «артикул»/«каталог» win over their «арт»/«кат» prefixes.
const ARTICLE_REF_RE = /(^|[^a-zа-яё0-9])(?:артикул|каталог|арт|кат|код)[.:№\s-]*\d[\d.\-/]*/gi;

/**
 * Extract structural discriminators from an item name. DB-free and pure, so it
 * is unit-testable without a database.
 */
export function extractMarkingFeatures(text: string): MarkingFeatures {
  const dn = extractDnValue(text);
  const norm = normalizeStructuralTokens(text)
    .replace(STANDARD_REF_RE, ' ')
    .replace(ARTICLE_REF_RE, ' ');

  const configMatch = norm.match(CONFIG_RE);
  const config = configMatch ? configMatch[0] : null;

  // Normalize each component numerically so a trailing-zero spelling does not
  // fork the token: «108,0x4,0» and «108x4» must both yield «108x4», while a real
  // fraction is kept («3.5» stays «3.5», «3.50» -> «3.5»).
  const crossMatch = norm.match(CROSS_RE);
  const cross = crossMatch ? `${Number(crossMatch[1])}x${Number(crossMatch[2])}` : null;

  const marks = [...new Set(
    (text.match(MARK_RE) || []).map(m => m.toLowerCase()).filter(m => !EXCLUDED_MARKS.has(m)),
  )];

  // Bare dimension integers (e.g. fixator sizes 16 / 20 / 25) not already
  // accounted for by the dn / cross / config tokens. Decimal fractions are
  // dropped first so a «.5» tail is not mistaken for a bare size.
  const consumed = new Set<number>();
  if (dn != null) consumed.add(dn);
  if (cross) for (const p of cross.split('x')) { const n = parseInt(p, 10); if (Number.isFinite(n)) consumed.add(n); }
  if (config) for (const p of config.split('-')) { const n = parseInt(p, 10); if (Number.isFinite(n)) consumed.add(n); }
  const ints = (norm.replace(/\d+\.\d+/g, ' ').match(/\b\d{1,4}\b/g) || []).map(Number);
  const sizes = [...new Set(ints.filter(n => !consumed.has(n)))];

  return { dn, cross, config, marks, sizes };
}

/**
 * Structural discriminator score — the original DN logic generalized across
 * feature dimensions, split into STRONG identity features and a WEAK bare-size
 * tail so an insignificant number cannot veto a real match:
 *
 *   STRONG = DN, cross-section «AxB», multi-way config «NN-NN-NN», letter marks.
 *            These ARE the product identity; a conflict here is a different item.
 *   WEAK   = bare dimension integers (a pipe cut length, a cable coil length, a
 *            standalone radiator height). Meaningful only when nothing stronger
 *            spoke.
 *
 * Returns:
 *   -1  a STRONG feature conflicts; or (no strong signal) the bare sizes conflict;
 *       or the spec carries a DN the invoice neither states nor mentions as a
 *       number (the original one-sided-DN penalty)
 *    1  a STRONG feature agrees (a weak bare-size conflict does NOT override it);
 *       or (no strong signal) the bare sizes agree
 *    0  no comparable discriminating feature
 *
 * The key fix over the prior version: a bare-size conflict is no longer a veto.
 * «Труба Дн57х3,5 6000» vs «…3000» now matches (diameter+section agree, only the
 * cut length differs), while «Радиатор 500» vs «600» still differs (the bare
 * height is the only signal, so it decides). A conflict still dominates so the
 * wrong variant cannot win the dnScore-keyed ranking, and strong agreement still
 * outranks a one-sided DN omission («Дн57х3,5» vs «Труба 57х3,5»).
 */
export function getStructuralScore(specText: string, invText: string): -1 | 0 | 1 {
  const spec = extractMarkingFeatures(specText);
  const inv = extractMarkingFeatures(invText);

  // Strong identity features — compared only when BOTH sides carry the dimension.
  let strongConflict = false;
  let strongAgreement = false;
  const strong = (same: boolean) => { if (same) strongAgreement = true; else strongConflict = true; };
  if (spec.dn != null && inv.dn != null) strong(spec.dn === inv.dn);
  if (spec.cross && inv.cross) strong(spec.cross === inv.cross);
  if (spec.config && inv.config) strong(spec.config === inv.config);
  if (spec.marks.length && inv.marks.length) strong(spec.marks.some(m => inv.marks.includes(m)));

  // A strong conflict is a different variant — it dominates.
  if (strongConflict) return -1;
  // Strong agreement is NOT overridden by a weak bare-size conflict (the cut
  // length of a pipe whose diameter and section already match is irrelevant).
  if (strongAgreement) return 1;

  // No strong feature decided — fall back to bare sizes as the weak tiebreaker.
  if (spec.sizes.length && inv.sizes.length) {
    return spec.sizes.some(s => inv.sizes.includes(s)) ? 1 : -1;
  }

  // One-sided DN omission: the spec is DN-typed but the invoice line has no DN.
  // Penalize only when the invoice does not mention that number anywhere (a bare
  // size could be the same diameter), preserving the pipe-vs-insulation catch.
  if (spec.dn != null && inv.dn == null) {
    const invNumbers = new Set<number>(inv.sizes);
    if (inv.cross) for (const p of inv.cross.split('x')) { const n = parseInt(p, 10); if (Number.isFinite(n)) invNumbers.add(n); }
    return invNumbers.has(spec.dn) ? 0 : -1;
  }
  return 0;
}

/**
 * Core matching algorithm: match given spec items against invoice items using rules.
 * Extracted to allow both full and incremental matching to share the same logic.
 */
async function matchSpecItems(
  specItems: SpecItemRow[],
  invoiceItems: InvoiceItemRow[],
  rules: MatchingRule[],
): Promise<MatchCandidate[]> {
  if (specItems.length === 0 || invoiceItems.length === 0) return [];

  // Build synthetic full names for parameter rows when parser did not persist full_name.
  const synthesizedNameById = new Map<number, string>();
  let lastParentByPosition = new Map<string, string>();
  for (const spec of specItems) {
    const position = (spec.position_number || '').trim().toLowerCase();
    const hasPosition = position.length > 0;
    const isParam = isParameterizedSpecName(spec.name);
    if (hasPosition && isParam) {
      const parent = lastParentByPosition.get(position);
      if (parent) synthesizedNameById.set(spec.id, `${parent} ${spec.name}`.trim());
    } else if (hasPosition) {
      lastParentByPosition.set(position, spec.full_name || spec.name);
    }
  }

  // Pre-normalize invoice items. Invoice rows have no section context, so we
  // pass `null` — aliases that require a section will not fire here.
  const normalizedInvoice = invoiceItems.map(item => ({
    ...item,
    normalizedName: normalizeForMatching(item.name, null),
  }));

  // Pre-normalize rules; extract raw tokens for substring fallback.
  // Rules are section-agnostic — section is `null`.
  const normalizedRules = rules.map(rule => ({
    ...rule,
    normalizedSpec: normalizeForMatching(rule.specification_pattern, null),
    normalizedInvoice: normalizeForMatching(rule.invoice_pattern, null),
    invTokens: normalizeForMatching(rule.invoice_pattern, null).split(' ').filter(t => t.length >= 3),
  }));

  const allCandidates: MatchCandidate[] = [];
  const l0l1MatchedSpecIds = new Set<number>();
  const specById = new Map(specItems.map(spec => [spec.id, spec]));
  const specMatchTextById = new Map<number, string>();
  let unmatchedLogged = 0;

  for (const spec of specItems) {
    const nameBase = spec.full_name || synthesizedNameById.get(spec.id) || spec.name;
    const codeTokens = [spec.equipment_code, spec.product_code, spec.article]
      .map(v => v?.trim()).filter(Boolean).join(' ');
    const nameForMatching = codeTokens ? `${nameBase} ${codeTokens}` : nameBase;
    specMatchTextById.set(spec.id, nameForMatching);
    const specNormName = normalizeForMatching(nameForMatching, spec.section);
    const specNormShort = (spec.full_name && spec.full_name !== spec.name)
      ? normalizeForMatching(spec.name, spec.section)
      : null;
    const specNormFull = spec.characteristics
      ? normalizeForMatching(nameForMatching + ' ' + spec.characteristics, spec.section)
      : specNormName;
    const specCode = spec.equipment_code?.trim() || null;
    // Extract a product-code-like PREFIX from spec.name (e.g. "C11-300-500", "VC22-50-80")
    // when equipment_code is missing. Must start with 1-4 letters then digits+dashes
    // (require at least 1 letter so we don't catch pure-numeric sizes like "15-40").
    // Capture only the matched prefix, not the whole name — otherwise descriptive
    // suffix bleeds into compactCode substring search and gives 0.92 false positives.
    const specNameAsCodeMatch = !specCode
      ? spec.name.trim().match(/^([A-Za-zА-Яа-я]{1,4}\s?\d{1,4}(?:[-_]\d{2,4}){1,3})/)
      : null;
    const specNameAsCode = specNameAsCodeMatch ? specNameAsCodeMatch[1] : null;
    const specPositionNumber = spec.position_number?.trim() || null;
    const positionToken = specPositionNumber && /[a-zA-Zа-яА-Я]/.test(specPositionNumber)
      ? normalizeForMatching(specPositionNumber)
      : '';

    const candidates: MatchCandidate[] = [];
    let negativeBlockedCount = 0;
    let bestRawNameSim = 0;
    let bestRawFullSim = 0;
    let bestRawInvName = '';
    const isCompactSpec = /\bcompact\b/i.test(nameForMatching);

    for (const inv of normalizedInvoice) {
      let bestConfidence = 0;
      let bestType: MatchCandidate['matchType'] = 'name_similarity';
      let bestRuleId: number | null = null;
      let bestRuleIsAnalog = 0;
      let quantityScore: -1 | 0 | 1 = 0;
      let dnScore: -1 | 0 | 1 = 0;
      const rawNameSim = stringSimilarity.compareTwoStrings(specNormName, inv.normalizedName);
      if (rawNameSim > bestRawNameSim) {
        bestRawNameSim = rawNameSim;
        bestRawInvName = inv.name;
      }
      if (spec.characteristics) {
        const rawFullSim = stringSimilarity.compareTwoStrings(specNormFull, inv.normalizedName);
        if (rawFullSim > bestRawFullSim) bestRawFullSim = rawFullSim;
      }

      // 0. Spec article vs invoice article (confidence 0.98)
      const specArticle = spec.article?.trim() || spec.product_code?.trim() || null;
      if (specArticle && inv.article) {
        if (specArticle.toLowerCase() === inv.article.trim().toLowerCase()) {
          bestConfidence = 0.98; bestType = 'exact_article';
        }
      }
      // 0b. Spec product_code vs invoice article (confidence 0.95)
      if (bestConfidence < 0.98 && spec.product_code && inv.article) {
        if (spec.product_code.trim().toLowerCase() === inv.article.trim().toLowerCase()) {
          bestConfidence = 0.95; bestType = 'exact_article';
        }
      }

      // 1. Exact article match
      if (specCode && inv.article) {
        const invArticle = inv.article.trim();
        if (specCode.toLowerCase() === invArticle.toLowerCase() && specCode.length > 0) {
          bestConfidence = 0.95;
          bestType = 'exact_article';
        }
      }

      // 1b. Position number token appears in invoice article/name.
      if (
        bestConfidence < 0.95 &&
        positionToken.length >= 3 &&
        (
          (inv.article && normalizeForMatching(inv.article).includes(positionToken)) ||
          inv.normalizedName.includes(positionToken)
        )
      ) {
        bestConfidence = 0.88;
        bestType = 'exact_article';
      }

      // 1c. Equipment code (e.g. "C22-400-600", "MVT") substring in invoice name/article.
      // Also try space-collapsed form to handle "C22" vs "C 22" variants.
      const codeToCheck = specCode || specNameAsCode;
      if (bestConfidence < 0.95 && codeToCheck && codeToCheck.length >= 3) {
        const normCode = normalizeForMatching(codeToCheck);
        const compactCode = normCode.replace(/\s+/g, '');
        if (compactCode.length >= 3) {
          const invNameCompact = inv.normalizedName.replace(/\s+/g, '');
          const invArtCompact = inv.article ? normalizeForMatching(inv.article).replace(/\s+/g, '') : '';
          const inArt = invArtCompact.includes(compactCode);
          const inName = invNameCompact.includes(compactCode);
          if (inArt || inName) {
            bestConfidence = Math.max(bestConfidence, 0.92);
            bestType = 'exact_article';
          }
        }
      }

      // 2. Learned rule match (supplier-scoped: same supplier first, then global, skip other suppliers)
      // First check negative rules — block this pair entirely
      let isNegativeBlocked = false;
      for (const rule of normalizedRules) {
        if (!rule.is_negative) continue;
        if (rule.supplier_id !== null && inv.supplier_id !== null && rule.supplier_id !== inv.supplier_id) continue;
        const specMatch = stringSimilarity.compareTwoStrings(specNormName, rule.normalizedSpec);
        const invMatch = stringSimilarity.compareTwoStrings(inv.normalizedName, rule.normalizedInvoice);
        if (specMatch >= 0.65 && invMatch >= 0.65) { isNegativeBlocked = true; break; }
      }
      if (isNegativeBlocked) {
        negativeBlockedCount++;
        continue;
      }

      if (bestConfidence < 0.95) {
        for (const rule of normalizedRules) {
          if (rule.is_negative) continue;
          if (rule.supplier_id !== null && inv.supplier_id !== null && rule.supplier_id !== inv.supplier_id) {
            continue;
          }
          const specMatch = stringSimilarity.compareTwoStrings(specNormName, rule.normalizedSpec);
          const invMatch = stringSimilarity.compareTwoStrings(inv.normalizedName, rule.normalizedInvoice);

          let matched = specMatch >= 0.65 && invMatch >= 0.65;
          let isFallback = false;

          // Fallback: if rule invoice pattern looks like a short code/model (< 50 chars),
          // check if its significant tokens appear inside the invoice item name.
          // This handles training files where "Наименование в счёте" contains model codes
          // like "TDU.5R DN50-5" while real invoices say "Ридан Узел TDU.5R DN50-5..."
          if (!matched && specMatch >= 0.55 && rule.normalizedInvoice.length < 50 && rule.invTokens.length >= 2) {
            const invLower = inv.normalizedName;
            const tokensHit = rule.invTokens.filter(t => invLower.includes(t)).length;
            const tokenRatio = tokensHit / rule.invTokens.length;
            if (tokenRatio >= 0.6) {
              matched = true;
              isFallback = true;
            }
          }

          // Fallback2: whole normalized invoice pattern is a short substring of the real invoice line
          // (training column often holds a fragment; token split can leave <2 tokens of length >= 3).
          if (
            !matched &&
            specMatch >= 0.6 &&
            rule.normalizedInvoice.length >= 8 &&
            rule.normalizedInvoice.length < 60 &&
            inv.normalizedName.includes(rule.normalizedInvoice)
          ) {
            matched = true;
            isFallback = true;
          }

          if (matched) {
            let ruleConfidence = Math.min(rule.confidence, 0.95);
            if (rule.supplier_id !== null && rule.supplier_id === inv.supplier_id) {
              ruleConfidence = Math.min(ruleConfidence + 0.02, 0.95);
            }
            const isStrongMatch = specMatch >= 0.8 && invMatch >= 0.8;
            if (!isStrongMatch) {
              ruleConfidence = Math.max(0, ruleConfidence - 0.1);
            }
            if (isFallback) {
              ruleConfidence = Math.min(ruleConfidence, 0.80);
            }
            if (ruleConfidence > bestConfidence) {
              bestConfidence = ruleConfidence;
              bestType = 'learned_rule';
              bestRuleId = rule.id;
              bestRuleIsAnalog = rule.is_analog ? 1 : 0;
              if (bestConfidence >= 0.95) break;
            }
          }
        }
      }

      // 3. Name similarity (Dice coefficient)
      // Lower threshold when spec has equipment_code or variant code name (double signal)
      const simThreshold = (specCode || specNameAsCode) ? 0.45 : 0.6;
      if (bestConfidence < 0.95) {
        let nameSim = stringSimilarity.compareTwoStrings(specNormName, inv.normalizedName);
        if (specNormShort) {
          const shortSim = stringSimilarity.compareTwoStrings(specNormShort, inv.normalizedName);
          if (shortSim > nameSim) nameSim = shortSim;
        }
        if (nameSim >= simThreshold) {
          let confidence = nameSim * 0.9;
          if (spec.unit && inv.unit && spec.unit.toLowerCase().trim() === inv.unit.toLowerCase().trim()) {
            confidence += 0.05;
          }
          confidence = Math.min(confidence, 0.94);
          const specEntity = extractEntityWords(specNormName);
          const invEntity = extractEntityWords(inv.normalizedName);
          if (specEntity.length > 3 && invEntity.length > 3) {
            const entitySim = stringSimilarity.compareTwoStrings(specEntity, invEntity);
            if (entitySim < 0.4) confidence *= 0.5;
          }
          if (confidence > bestConfidence) {
            bestConfidence = confidence;
            bestType = 'name_similarity';
          }
        }
      }

      // 4. Name + characteristics vs invoice name
      if (bestConfidence < 0.95 && spec.characteristics) {
        const fullSim = stringSimilarity.compareTwoStrings(specNormFull, inv.normalizedName);
        if (fullSim >= 0.5) {
          let confidence = fullSim * 0.8;
          if (spec.unit && inv.unit && spec.unit.toLowerCase().trim() === inv.unit.toLowerCase().trim()) {
            confidence += 0.05;
          }
          confidence = Math.min(confidence, 0.94);
          if (confidence > bestConfidence) {
            bestConfidence = confidence;
            bestType = 'name_characteristics';
          }
        }
      }

      quantityScore = getQuantityScore(spec.quantity, inv.quantity);
      // `dnScore` carries the structural discriminator score (DN + marking /
      // type-size / config). Kept the field name for ranking-consumer compat
      // (matcher sort, routes auto-#1 selection, replay/bench tools).
      dnScore = getStructuralScore(nameForMatching, inv.name);

      if (quantityScore === 1) bestConfidence += 0.07;
      if (quantityScore === -1) bestConfidence -= 0.12;
      if (dnScore === 1) bestConfidence += 0.1;
      if (dnScore === -1) bestConfidence -= 0.18;
      bestConfidence = Math.max(0, Math.min(bestConfidence, 0.99));

      if (bestConfidence >= 0.3) {
        candidates.push({
          specItemId: spec.id,
          invoiceItemId: inv.id,
          confidence: Math.round(bestConfidence * 1000) / 1000,
          matchType: bestType,
          source: inv.source ?? 'invoice',
          quantityScore,
          dnScore,
          matchingRuleId: bestType === 'learned_rule' ? bestRuleId : null,
          isAnalog: bestType === 'learned_rule' && bestRuleIsAnalog === 1,
        });
      }
    }

    // Sort by confidence DESC, keep top K (больше вариантов без смены алгоритма матчинга)
    if (candidates.some(candidate => candidate.matchType === 'exact_article' || candidate.matchType === 'learned_rule')) {
      l0l1MatchedSpecIds.add(spec.id);
    }

    const TOP_K = 8;
    candidates.sort((a, b) =>
      b.dnScore - a.dnScore
      || b.quantityScore - a.quantityScore
      || b.confidence - a.confidence
      || a.invoiceItemId - b.invoiceItemId
    );
    allCandidates.push(...candidates.slice(0, TOP_K));

    if (candidates.length === 0 && unmatchedLogged < 25) {
      unmatchedLogged++;
    }
  }

  const llmSpecItems = specItems.filter(spec => !l0l1MatchedSpecIds.has(spec.id));
  const llmInvoiceItems = invoiceItems.filter(item => (item.source ?? 'invoice') === 'invoice');

  console.log(`[Matcher] tiers 0-3 done: ${l0l1MatchedSpecIds.size} matched by article/rules, ${llmSpecItems.length} remain for LLM, ${llmInvoiceItems.length} invoice items available`);

  if (llmSpecItems.length > 0 && llmInvoiceItems.length > 0) {
    const invoiceById = new Map(llmInvoiceItems.map(item => [item.id, item]));
    const llmSeenSpecIds = new Set<number>();
    console.log(`[Matcher] calling Gemini for ${llmSpecItems.length} spec items...`);
    const llmMatches = (await matchWithGemini(llmSpecItems, llmInvoiceItems))
      .sort((a, b) => b.confidence - a.confidence || a.invoiceItemId - b.invoiceItemId);
    console.log(`[Matcher] Gemini returned ${llmMatches.length} matches`);

    for (const llmMatch of llmMatches) {
      if (llmSeenSpecIds.has(llmMatch.specItemId)) continue;
      if (l0l1MatchedSpecIds.has(llmMatch.specItemId)) continue;

      const spec = specById.get(llmMatch.specItemId);
      const inv = invoiceById.get(llmMatch.invoiceItemId);
      if (!spec || !inv) continue;

      const cappedConfidence = Math.min(Math.max(llmMatch.confidence, 0), 0.90);
      if (cappedConfidence <= 0) continue;

      const source = inv.source ?? 'invoice';
      const duplicateIndex = allCandidates.findIndex(candidate =>
        candidate.specItemId === llmMatch.specItemId
        && candidate.invoiceItemId === llmMatch.invoiceItemId
        && candidate.source === source
        && (candidate.matchType === 'name_similarity' || candidate.matchType === 'name_characteristics')
      );
      if (duplicateIndex !== -1) allCandidates.splice(duplicateIndex, 1);

      allCandidates.push({
        specItemId: llmMatch.specItemId,
        invoiceItemId: llmMatch.invoiceItemId,
        confidence: Math.round(cappedConfidence * 1000) / 1000,
        matchType: 'llm_suggestion',
        source,
        quantityScore: getQuantityScore(spec.quantity, inv.quantity),
        dnScore: getStructuralScore(specMatchTextById.get(spec.id) || spec.full_name || spec.name, inv.name),
        matchingRuleId: null,
        matchReason: llmMatch.reason,
        isAnalog: false,
      });
      llmSeenSpecIds.add(llmMatch.specItemId);
    }
  }

  return allCandidates;
}

const SPEC_ITEMS_SQL = 'SELECT id, position_number, name, characteristics, equipment_code, article, product_code, unit, quantity, section, parent_item_id, full_name FROM specification_items WHERE project_id = ?';
const INVOICE_ITEMS_SQL = `
  SELECT ii.id, ii.invoice_id, ii.article, ii.name, ii.unit, ii.quantity, ii.price, ii.amount,
         i.supplier_id, 'invoice' as source
  FROM invoice_items ii
  JOIN invoices i ON ii.invoice_id = i.id
  WHERE i.project_id = ? AND ii.is_delivery = 0
`;
const PRICE_LIST_ITEMS_SQL = `
  SELECT pli.id, 0 as invoice_id, pli.article, pli.name, pli.unit,
         NULL as quantity, pli.price, NULL as amount, pl.supplier_id, 'price_list' as source
  FROM price_list_items pli
  JOIN price_lists pl ON pli.price_list_id = pl.id
  WHERE pl.project_id = ?
`;
const RULES_SQL = "SELECT id, specification_pattern, invoice_pattern, confidence, times_used, supplier_id, COALESCE(is_negative,0) as is_negative, COALESCE(is_analog,0) as is_analog, COALESCE(source,'none') as source FROM matching_rules";

function loadAllItems(db: ReturnType<typeof getDatabase>, projectId: number): InvoiceItemRow[] {
  const invoiceItems = db.prepare(INVOICE_ITEMS_SQL).all(projectId) as InvoiceItemRow[];
  const priceListItems = db.prepare(PRICE_LIST_ITEMS_SQL).all(projectId) as InvoiceItemRow[];
  return [...invoiceItems, ...priceListItems];
}

/**
 * Run full matching for all spec items in a project.
 */
export async function runMatching(projectId: number): Promise<MatchCandidate[]> {
  const db = getDatabase();
  const specItems = db.prepare(SPEC_ITEMS_SQL).all(projectId) as SpecItemRow[];
  const allItems = loadAllItems(db, projectId);
  const rules = db.prepare(RULES_SQL).all() as MatchingRule[];
  return matchSpecItems(specItems, allItems, rules);
}

/**
 * Incremental matching: skip spec items that already have confirmed matches.
 * Only processes the remaining unconfirmed spec items.
 */
export async function runMatchingIncremental(projectId: number, skipSpecIds: number[]): Promise<MatchCandidate[]> {
  const db = getDatabase();
  const allSpecs = db.prepare(SPEC_ITEMS_SQL).all(projectId) as SpecItemRow[];
  const skipSet = new Set(skipSpecIds);
  const specItems = allSpecs.filter(s => !skipSet.has(s.id));
  const allItems = loadAllItems(db, projectId);
  const rules = db.prepare(RULES_SQL).all() as MatchingRule[];
  return matchSpecItems(specItems, allItems, rules);
}
