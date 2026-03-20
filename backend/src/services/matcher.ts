import stringSimilarity from 'string-similarity';
import { getDatabase } from '../database';

export interface MatchCandidate {
  specItemId: number;
  invoiceItemId: number;
  confidence: number;
  matchType: 'exact_article' | 'learned_rule' | 'name_similarity' | 'name_characteristics';
  source: 'invoice' | 'price_list';
}

interface SpecItemRow {
  id: number;
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
}

// Stop words to remove during normalization (Russian units, articles, etc.)
const STOP_WORDS = new Set([
  'мм', 'см', 'м', 'шт', 'кг', 'г', 'л', 'мл', 'компл', 'комплект',
  'набор', 'ед', 'пог', 'кв', 'куб', 'п', 'к', 'и', 'в', 'с', 'на',
  'для', 'из', 'по', 'от', 'до',
]);

let _synonymCache: Map<string,string> | null = null;

function getSynonymMap(): Map<string,string> {
  if (_synonymCache) return _synonymCache;
  const db = getDatabase();
  const rows = db.prepare('SELECT synonym, canonical FROM size_synonyms').all() as {synonym:string;canonical:string}[];
  _synonymCache = new Map(rows.map(r => [r.synonym.toLowerCase(), r.canonical.toLowerCase()]));
  return _synonymCache;
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

/**
 * Normalize a string for fuzzy matching:
 * - lowercase, trim
 * - remove punctuation, extra spaces
 * - remove stop words
 */
export function normalizeForMatching(text: string): string {
  let s = normalizeSizeTerms(text);
  s = s.toLowerCase().trim();
  // Remove punctuation except letters, digits, spaces
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Remove stop words
  const words = s.split(' ').filter(w => w.length > 0 && !STOP_WORDS.has(w));
  return words.join(' ');
}

function extractEntityWords(text: string): string {
  const m = text.match(/^(.*?)(?:\s+(?:DN|Ду|d=|D=|du)?\s*\d|\s+\d{2,}[xX×\/]|\s+\d+\s*(?:мм|mm))/i);
  if (m) return m[1].trim().toLowerCase();
  return text.toLowerCase();
}

/**
 * Core matching algorithm: match given spec items against invoice items using rules.
 * Extracted to allow both full and incremental matching to share the same logic.
 */
function matchSpecItems(
  specItems: SpecItemRow[],
  invoiceItems: InvoiceItemRow[],
  rules: MatchingRule[],
): MatchCandidate[] {
  if (specItems.length === 0 || invoiceItems.length === 0) return [];

  // Pre-normalize invoice items
  const normalizedInvoice = invoiceItems.map(item => ({
    ...item,
    normalizedName: normalizeForMatching(item.name),
  }));

  // Pre-normalize rules
  const normalizedRules = rules.map(rule => ({
    ...rule,
    normalizedSpec: normalizeForMatching(rule.specification_pattern),
    normalizedInvoice: normalizeForMatching(rule.invoice_pattern),
  }));

  const allCandidates: MatchCandidate[] = [];

  for (const spec of specItems) {
    // Use full_name (parent.name + child.name) for DN sub-rows, otherwise use name
    const nameForMatching = spec.full_name || spec.name;
    const specNormName = normalizeForMatching(nameForMatching);
    const specNormFull = spec.characteristics
      ? normalizeForMatching(nameForMatching + ' ' + spec.characteristics)
      : specNormName;
    const specCode = spec.equipment_code?.trim() || null;

    const candidates: MatchCandidate[] = [];

    for (const inv of normalizedInvoice) {
      let bestConfidence = 0;
      let bestType: MatchCandidate['matchType'] = 'name_similarity';

      // 0. Spec article vs invoice article (confidence 0.98)
      if (spec.article && inv.article) {
        if (spec.article.trim().toLowerCase() === inv.article.trim().toLowerCase()) {
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

      // 2. Learned rule match (supplier-scoped: same supplier first, then global, skip other suppliers)
      if (bestConfidence < 0.95) {
        for (const rule of normalizedRules) {
          // Skip rules from a different supplier
          if (rule.supplier_id !== null && inv.supplier_id !== null && rule.supplier_id !== inv.supplier_id) {
            continue;
          }
          const specMatch = stringSimilarity.compareTwoStrings(specNormName, rule.normalizedSpec);
          const invMatch = stringSimilarity.compareTwoStrings(inv.normalizedName, rule.normalizedInvoice);
          if (specMatch >= 0.8 && invMatch >= 0.8) {
            let ruleConfidence = Math.min(rule.confidence, 0.95);
            // Boost confidence for supplier-specific rules
            if (rule.supplier_id !== null && rule.supplier_id === inv.supplier_id) {
              ruleConfidence = Math.min(ruleConfidence + 0.02, 0.95);
            }
            if (ruleConfidence > bestConfidence) {
              bestConfidence = ruleConfidence;
              bestType = 'learned_rule';
            }
          }
        }
      }

      // 3. Name similarity (Dice coefficient)
      if (bestConfidence < 0.95) {
        const nameSim = stringSimilarity.compareTwoStrings(specNormName, inv.normalizedName);
        if (nameSim >= 0.6) {
          let confidence = nameSim * 0.9;
          // Bonus if units match
          if (spec.unit && inv.unit && spec.unit.toLowerCase().trim() === inv.unit.toLowerCase().trim()) {
            confidence += 0.05;
          }
          confidence = Math.min(confidence, 0.94); // Cap below exact article
          // Entity word check: penalize if entity words differ significantly
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

      if (bestConfidence >= 0.3) {
        candidates.push({
          specItemId: spec.id,
          invoiceItemId: inv.id,
          confidence: Math.round(bestConfidence * 1000) / 1000,
          matchType: bestType,
          source: inv.source ?? 'invoice',
        });
      }
    }

    // Sort by confidence DESC, keep top 5
    candidates.sort((a, b) => b.confidence - a.confidence);
    allCandidates.push(...candidates.slice(0, 5));
  }

  return allCandidates;
}

const SPEC_ITEMS_SQL = 'SELECT id, name, characteristics, equipment_code, article, product_code, unit, quantity, section, parent_item_id, full_name FROM specification_items WHERE project_id = ?';
const INVOICE_ITEMS_SQL = `
  SELECT ii.id, ii.invoice_id, ii.article, ii.name, ii.unit, ii.quantity, ii.price, ii.amount,
         i.supplier_id, 'invoice' as source
  FROM invoice_items ii
  JOIN invoices i ON ii.invoice_id = i.id
  WHERE i.project_id = ? AND ii.is_delivery = 0
`;
const PRICE_LIST_ITEMS_SQL = `
  SELECT pli.id, 0 as invoice_id, pli.article, pli.name, pli.unit,
         NULL as quantity, pli.price, NULL as amount, NULL as supplier_id, 'price_list' as source
  FROM price_list_items pli
  JOIN price_lists pl ON pli.price_list_id = pl.id
  WHERE pl.project_id = ?
`;
const RULES_SQL = 'SELECT id, specification_pattern, invoice_pattern, confidence, times_used, supplier_id FROM matching_rules';

function loadAllItems(db: ReturnType<typeof getDatabase>, projectId: number): InvoiceItemRow[] {
  const invoiceItems = db.prepare(INVOICE_ITEMS_SQL).all(projectId) as InvoiceItemRow[];
  const priceListItems = db.prepare(PRICE_LIST_ITEMS_SQL).all(projectId) as InvoiceItemRow[];
  return [...invoiceItems, ...priceListItems];
}

/**
 * Run full matching for all spec items in a project.
 */
export function runMatching(projectId: number): MatchCandidate[] {
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
export function runMatchingIncremental(projectId: number, skipSpecIds: number[]): MatchCandidate[] {
  const db = getDatabase();
  const allSpecs = db.prepare(SPEC_ITEMS_SQL).all(projectId) as SpecItemRow[];
  const skipSet = new Set(skipSpecIds);
  const specItems = allSpecs.filter(s => !skipSet.has(s.id));
  const allItems = loadAllItems(db, projectId);
  const rules = db.prepare(RULES_SQL).all() as MatchingRule[];
  return matchSpecItems(specItems, allItems, rules);
}
