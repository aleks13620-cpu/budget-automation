import stringSimilarity from 'string-similarity';
import { getDatabase } from '../database';

export interface MatchCandidate {
  specItemId: number;
  invoiceItemId: number;
  confidence: number;
  matchType: 'exact_article' | 'learned_rule' | 'name_similarity' | 'name_characteristics';
  source: 'invoice' | 'price_list';
  quantityScore: -1 | 0 | 1;
  dnScore: -1 | 0 | 1;
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

  // Safe canonicalization: apply only explicit engineering token patterns.
  result = result.replace(/[ø⌀]/g, ' dn ');
  result = result.replace(/(^|\s)ду\.?\s*(\d{1,4})(?=\s|$)/gi, ' dn $2 ');
  result = result.replace(/\bdn\.?\s*(\d{1,4})\b/gi, ' dn $1 ');
  result = result.replace(/\bd\s*=\s*(\d{1,4})\b/gi, ' dn $1 ');
  result = result.replace(/\bd\s*(\d{1,4})\b/gi, ' dn $1 ');

  // Normalize size separators 500x300, 500×300, 500 X 300.
  result = result.replace(/(\d)\s*[xх×]\s*(\d)/gi, '$1x$2');

  // Normalize decimal comma in sizes/prices to dot.
  result = result.replace(/(\d),(\d)/g, '$1.$2');

  return result;
}

/**
 * Normalize a string for fuzzy matching:
 * - lowercase, trim
 * - remove punctuation, extra spaces
 * - remove stop words
 */
export function normalizeForMatching(text: string): string {
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
  return words.join(' ');
}

function extractEntityWords(text: string): string {
  const m = text.match(/^(.*?)(?:\s+(?:DN|Ду|d=|D=|du)?\s*\d|\s+\d{2,}[xX×\/]|\s+\d+\s*(?:мм|mm))/i);
  if (m) return m[1].trim().toLowerCase();
  return text.toLowerCase();
}

function isParameterizedSpecName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/^(δ|d|du|dn|ø|⌀)\s*=?\s*\d{1,4}/i.test(n)) return true;
  if (/^\d{2,4}\s*[xх×]\s*\d{2,4}(\s|$)/i.test(n)) return true;
  if (/^[a-zа-я]{0,4}\d{2,4}[-xх×]\d{2,4}([-\s]\d{2,4})?$/i.test(n)) return true;
  return false;
}

function extractDnValue(text: string): number | null {
  const normalized = normalizeForMatching(text);
  const match = normalized.match(/\bdn\s*(\d{1,4})\b/i);
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

function getDnScore(specText: string, invText: string): -1 | 0 | 1 {
  const specDn = extractDnValue(specText);
  if (specDn == null) return 0;
  const invDn = extractDnValue(invText);
  if (invDn == null) return -1;
  return specDn === invDn ? 1 : -1;
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

  // Pre-normalize invoice items
  const normalizedInvoice = invoiceItems.map(item => ({
    ...item,
    normalizedName: normalizeForMatching(item.name),
  }));

  // Pre-normalize rules; extract raw tokens for substring fallback
  const normalizedRules = rules.map(rule => ({
    ...rule,
    normalizedSpec: normalizeForMatching(rule.specification_pattern),
    normalizedInvoice: normalizeForMatching(rule.invoice_pattern),
    invTokens: normalizeForMatching(rule.invoice_pattern).split(' ').filter(t => t.length >= 3),
  }));

  const allCandidates: MatchCandidate[] = [];
  let unmatchedLogged = 0;

  for (const spec of specItems) {
    const nameBase = spec.full_name || synthesizedNameById.get(spec.id) || spec.name;
    const codeTokens = [spec.equipment_code, spec.product_code, spec.article]
      .map(v => v?.trim()).filter(Boolean).join(' ');
    const nameForMatching = codeTokens ? `${nameBase} ${codeTokens}` : nameBase;
    const specNormName = normalizeForMatching(nameForMatching);
    const specNormFull = spec.characteristics
      ? normalizeForMatching(nameForMatching + ' ' + spec.characteristics)
      : specNormName;
    const specCode = spec.equipment_code?.trim() || null;
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
      if (bestConfidence < 0.95 && specCode && specCode.length >= 3) {
        const normCode = normalizeForMatching(specCode);
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
            }
          }
        }
      }

      // 3. Name similarity (Dice coefficient)
      // Lower threshold when spec has equipment_code (double signal: name + code)
      const simThreshold = specCode ? 0.45 : 0.6;
      if (bestConfidence < 0.95) {
        const nameSim = stringSimilarity.compareTwoStrings(specNormName, inv.normalizedName);
        if (nameSim >= simThreshold) {
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

      quantityScore = getQuantityScore(spec.quantity, inv.quantity);
      dnScore = getDnScore(nameForMatching, inv.name);

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
        });
      }
    }

    // Sort by confidence DESC, keep top K (больше вариантов без смены алгоритма матчинга)
    const TOP_K = 8;
    candidates.sort((a, b) =>
      b.dnScore - a.dnScore
      || b.quantityScore - a.quantityScore
      || b.confidence - a.confidence
      || a.invoiceItemId - b.invoiceItemId
    );
    allCandidates.push(...candidates.slice(0, TOP_K));

    if (isCompactSpec) {
      // #region agent log
      fetch('http://127.0.0.1:7830/ingest/9fee685e-d5a8-428b-a924-a36029ab70bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'acd6be'},body:JSON.stringify({sessionId:'acd6be',runId:'v2',hypothesisId:'H2',location:'backend/src/services/matcher.ts:compact_spec_diagnostics',message:'Compact spec diagnostics',data:{specId:spec.id,specName:spec.name,fullName:spec.full_name,equipmentCode:spec.equipment_code,nameUsedForMatching:nameForMatching,specNormName,hasSpecArticle:!!spec.article,hasProductCode:!!spec.product_code,hasEquipmentCode:!!spec.equipment_code,bestRawNameSim:Number(bestRawNameSim.toFixed(3)),bestRawFullSim:Number(bestRawFullSim.toFixed(3)),bestRawInvoiceName:bestRawInvName,candidateCountBeforeTopK:candidates.length,selectedAfterTopK:Math.min(candidates.length,TOP_K),negativeBlockedCount,topCandidateType:candidates[0]?.matchType,topCandidateConf:candidates[0]?.confidence},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }

    if (positionToken.length >= 3 && candidates.length > 0) {
      const top = candidates[0];
      // #region agent log
      fetch('http://127.0.0.1:7830/ingest/9fee685e-d5a8-428b-a924-a36029ab70bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'acd6be'},body:JSON.stringify({sessionId:'acd6be',runId:'initial',hypothesisId:'H5',location:'backend/src/services/matcher.ts:position_number_signal',message:'Position number used as matching signal',data:{specId:spec.id,specName:spec.name,positionNumber:spec.position_number,positionToken,topCandidateInvoiceId:top.invoiceItemId,topCandidateConfidence:top.confidence,topCandidateType:top.matchType,candidateCountBeforeTopK:candidates.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }

    if (candidates.length === 0 && unmatchedLogged < 25) {
      unmatchedLogged++;
      // #region agent log
      fetch('http://127.0.0.1:7830/ingest/9fee685e-d5a8-428b-a924-a36029ab70bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'acd6be'},body:JSON.stringify({sessionId:'acd6be',runId:'initial',hypothesisId:'H3',location:'backend/src/services/matcher.ts:unmatched_spec_diagnostics',message:'Spec produced zero candidates',data:{specId:spec.id,specName:spec.name,fullName:spec.full_name,characteristics:spec.characteristics,hasSpecArticle:!!spec.article,hasProductCode:!!spec.product_code,hasEquipmentCode:!!spec.equipment_code,bestRawNameSim:Number(bestRawNameSim.toFixed(3)),bestRawFullSim:Number(bestRawFullSim.toFixed(3)),bestRawInvoiceName:bestRawInvName,negativeBlockedCount},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }

  // #region agent log
  const tierCount: Record<string,number> = {};
  const uniqueSpecs = new Set(allCandidates.map(c => c.specItemId));
  for (const c of allCandidates) { tierCount[c.matchType] = (tierCount[c.matchType] || 0) + 1; }
  const specsWithEquipCode = specItems.filter(s => s.equipment_code?.trim()).length;
  const specsWithFullName = specItems.filter(s => s.full_name?.trim()).length;
  const specsWithArticle = specItems.filter(s => s.article?.trim()).length;
  const specsWithProductCode = specItems.filter(s => s.product_code?.trim()).length;
  fetch('http://127.0.0.1:7830/ingest/9fee685e-d5a8-428b-a924-a36029ab70bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'acd6be'},body:JSON.stringify({sessionId:'acd6be',runId:'v2',hypothesisId:'H4',location:'backend/src/services/matcher.ts:match_summary',message:'Matching output summary v2',data:{specItemsCount:specItems.length,invoiceItemsCount:invoiceItems.length,totalCandidates:allCandidates.length,uniqueSpecsMatched:uniqueSpecs.size,specsWithoutCandidatesLogged:unmatchedLogged,tierCount,specsWithEquipCode,specsWithFullName,specsWithArticle,specsWithProductCode},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

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
         NULL as quantity, pli.price, NULL as amount, NULL as supplier_id, 'price_list' as source
  FROM price_list_items pli
  JOIN price_lists pl ON pli.price_list_id = pl.id
  WHERE pl.project_id = ?
`;
const RULES_SQL = "SELECT id, specification_pattern, invoice_pattern, confidence, times_used, supplier_id, COALESCE(is_negative,0) as is_negative, COALESCE(source,'none') as source FROM matching_rules";

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
  // #region agent log
  fetch('http://127.0.0.1:7830/ingest/9fee685e-d5a8-428b-a924-a36029ab70bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'acd6be'},body:JSON.stringify({sessionId:'acd6be',runId:'initial',hypothesisId:'H1',location:'backend/src/services/matcher.ts:runMatching',message:'runMatching inputs',data:{projectId,specItemsCount:specItems.length,invoiceAndPriceItemsCount:allItems.length,rulesCount:rules.length,invoiceOnlyCount:allItems.filter(i=>i.source==='invoice').length,priceListCount:allItems.filter(i=>i.source==='price_list').length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
