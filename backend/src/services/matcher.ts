import stringSimilarity from 'string-similarity';
import { getDatabase } from '../database';

export interface MatchCandidate {
  specItemId: number;
  invoiceItemId: number;
  confidence: number;
  matchType: 'exact_article' | 'learned_rule' | 'name_similarity' | 'name_characteristics';
}

interface SpecItemRow {
  id: number;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
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
}

interface MatchingRule {
  id: number;
  specification_pattern: string;
  invoice_pattern: string;
  confidence: number;
  times_used: number;
}

// Stop words to remove during normalization (Russian units, articles, etc.)
const STOP_WORDS = new Set([
  'мм', 'см', 'м', 'шт', 'кг', 'г', 'л', 'мл', 'компл', 'комплект',
  'набор', 'ед', 'пог', 'кв', 'куб', 'п', 'к', 'и', 'в', 'с', 'на',
  'для', 'из', 'по', 'от', 'до',
]);

/**
 * Normalize a string for fuzzy matching:
 * - lowercase, trim
 * - remove punctuation, extra spaces
 * - remove stop words
 */
export function normalizeForMatching(text: string): string {
  let s = text.toLowerCase().trim();
  // Remove punctuation except letters, digits, spaces
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Remove stop words
  const words = s.split(' ').filter(w => w.length > 0 && !STOP_WORDS.has(w));
  return words.join(' ');
}

/**
 * Run matching algorithm for all spec items in a project against all invoice items.
 * Returns top candidates per spec item.
 */
export function runMatching(projectId: number): MatchCandidate[] {
  const db = getDatabase();

  // Load all spec items for the project
  const specItems = db.prepare(
    'SELECT id, name, characteristics, equipment_code, unit, quantity, section FROM specification_items WHERE project_id = ?'
  ).all(projectId) as SpecItemRow[];

  // Load all invoice items for the project (join through invoices)
  const invoiceItems = db.prepare(`
    SELECT ii.id, ii.invoice_id, ii.article, ii.name, ii.unit, ii.quantity, ii.price, ii.amount
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.project_id = ?
  `).all(projectId) as InvoiceItemRow[];

  if (specItems.length === 0 || invoiceItems.length === 0) {
    return [];
  }

  // Load learned matching rules
  const rules = db.prepare(
    'SELECT id, specification_pattern, invoice_pattern, confidence, times_used FROM matching_rules'
  ).all() as MatchingRule[];

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
    const specNormName = normalizeForMatching(spec.name);
    const specNormFull = spec.characteristics
      ? normalizeForMatching(spec.name + ' ' + spec.characteristics)
      : specNormName;
    const specCode = spec.equipment_code?.trim() || null;

    const candidates: MatchCandidate[] = [];

    for (const inv of normalizedInvoice) {
      let bestConfidence = 0;
      let bestType: MatchCandidate['matchType'] = 'name_similarity';

      // 1. Exact article match
      if (specCode && inv.article) {
        const invArticle = inv.article.trim();
        if (specCode.toLowerCase() === invArticle.toLowerCase() && specCode.length > 0) {
          bestConfidence = 0.95;
          bestType = 'exact_article';
        }
      }

      // 2. Learned rule match
      if (bestConfidence < 0.95) {
        for (const rule of normalizedRules) {
          const specMatch = stringSimilarity.compareTwoStrings(specNormName, rule.normalizedSpec);
          const invMatch = stringSimilarity.compareTwoStrings(inv.normalizedName, rule.normalizedInvoice);
          if (specMatch >= 0.8 && invMatch >= 0.8) {
            const ruleConfidence = Math.min(rule.confidence, 0.95);
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

      if (bestConfidence >= 0.4) {
        candidates.push({
          specItemId: spec.id,
          invoiceItemId: inv.id,
          confidence: Math.round(bestConfidence * 1000) / 1000, // Round to 3 decimals
          matchType: bestType,
        });
      }
    }

    // Sort by confidence DESC, keep top 3
    candidates.sort((a, b) => b.confidence - a.confidence);
    allCandidates.push(...candidates.slice(0, 3));
  }

  return allCandidates;
}
