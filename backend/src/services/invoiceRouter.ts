/**
 * Invoice Router
 *
 * Единая точка входа для парсинга счетов.
 * Направляет файл на нужный парсер в зависимости от расширения,
 * и применяет GigaChat как fallback при низком confidence.
 */

import path from 'path';
import { parsePdfFile, SavedMapping } from './pdfParser';
import { parseExcelInvoice, excelToLegacy } from './excelInvoiceParser';
import { parsePdfWithGigaChat, parseExcelWithGigaChat } from './gigachatParser';
import { validateInvoice } from './invoiceValidator';
import { isGigaChatConfigured } from './gigachatService';
import { InvoiceRow, InvoiceMetadata, InvoiceParseResult } from '../types/invoice';
import { ValidationResult } from '../types/validation';
import type { GigaChatParseQuality } from './gigachatParseQuality';
import { getDatabase } from '../database';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export type InvoiceSource = 'excel' | 'pdf' | 'image' | 'gigachat_fallback';
export type ParserOverrideSource = 'gemini' | 'gigachat';

export interface SupplierParserOverrides {
  prices_source?: ParserOverrideSource;
  text_source?: ParserOverrideSource;
}

export interface RouteInvoiceOptions {
  supplierId?: number | null;
}

export interface RouterParseResult {
  /** Источник данных */
  source: InvoiceSource;
  /** Категория качества A/B/C */
  category: 'A' | 'B' | 'C';
  /** Стандартный результат парсинга (для совместимости с routes/invoices.ts) */
  parseResult: InvoiceParseResult;
  /** Метаданные (расширенные, если GigaChat) */
  metadata?: InvoiceMetadata;
  /** Оценка confidence 0–100 */
  confidence: number;
  /** Результат валидации */
  validation?: ValidationResult;
  /** Если парсинг шёл через GigaChat — эвристики полноты ответа */
  gigachatParseQuality?: GigaChatParseQuality;
  /** Price override could not confidently merge every row. */
  amountReviewRequired?: boolean;
  /** Extra parsing_category_reason fragments from parser overrides. */
  parsingReasonAdditions?: string[];
}

const EXCEL_EXTS = new Set(['.xlsx', '.xls']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.bmp']);
type GigaChatInvoiceResult = Awaited<ReturnType<typeof parsePdfWithGigaChat>>;

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Конвертирует GigaChatInvoiceResult в InvoiceParseResult */
function gigachatToLegacy(
  gigaResult: GigaChatInvoiceResult
): InvoiceParseResult {
  return {
    items: gigaResult.items,
    errors: [],
    totalRows: gigaResult.items.length,
    skippedRows: 0,
    invoiceNumber: gigaResult.metadata.documentNumber,
    invoiceDate: gigaResult.metadata.documentDate,
    supplierName: gigaResult.metadata.supplierName,
    totalAmount: gigaResult.metadata.totalWithVat,
    vatAmount: gigaResult.metadata.vatAmount,
    discountDetected: null,
  };
}

function isParserOverrideSource(value: unknown): value is ParserOverrideSource {
  return value === 'gemini' || value === 'gigachat';
}

export function readParserOverridesFromConfig(config: unknown): SupplierParserOverrides | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;

  const rawOverrides = (config as { parser_overrides?: unknown }).parser_overrides;
  if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    return undefined;
  }

  const overridesRecord = rawOverrides as Record<string, unknown>;
  const overrides: SupplierParserOverrides = {};

  if (isParserOverrideSource(overridesRecord.prices_source)) {
    overrides.prices_source = overridesRecord.prices_source;
  }
  if (isParserOverrideSource(overridesRecord.text_source)) {
    overrides.text_source = overridesRecord.text_source;
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function loadSupplierParserOverrides(
  supplierId: number | null | undefined,
  savedMapping?: SavedMapping,
): SupplierParserOverrides | undefined {
  const mappingOverrides = readParserOverridesFromConfig(savedMapping);
  if (mappingOverrides) return mappingOverrides;
  if (!supplierId) return undefined;

  const row = getDatabase()
    .prepare('SELECT config FROM supplier_parser_configs WHERE supplier_id = ?')
    .get(supplierId) as { config: string } | undefined;

  if (!row) return undefined;

  try {
    return readParserOverridesFromConfig(JSON.parse(row.config));
  } catch (error) {
    console.warn(`[InvoiceRouter] Invalid supplier parser config JSON for supplier_id=${supplierId}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

export function loadSupplierPricesIncludeVat(supplierId: number | null | undefined): number | null {
  if (!supplierId) return null;

  const row = getDatabase()
    .prepare('SELECT prices_include_vat FROM suppliers WHERE id = ?')
    .get(supplierId) as { prices_include_vat: number | null } | undefined;

  return row?.prices_include_vat ?? null;
}

export function logSupplierParserOverrides(
  parserName: Exclude<InvoiceSource, 'gigachat_fallback'>,
  supplierId: number | null | undefined,
  parserOverrides?: SupplierParserOverrides,
): void {
  if (!parserOverrides) return;
  console.log(
    `[InvoiceRouter] supplier_id=${supplierId ?? 'unknown'}, parser=${parserName}, parser_overrides=${JSON.stringify(parserOverrides)}`
  );
}

export interface ParserPriceOverrideResult {
  parseResult: InvoiceParseResult;
  metadata?: InvoiceMetadata;
  vatRate?: number | null;
  gigachatParseQuality?: GigaChatParseQuality;
  applied: boolean;
  needsAmountReview: boolean;
  reasonParts: string[];
  mergedRows: number;
  uncertainRows: number;
  extraGigaRows: number;
}

function cloneParseResult(parseResult: InvoiceParseResult): InvoiceParseResult {
  return {
    ...parseResult,
    items: parseResult.items.map(item => ({ ...item })),
  };
}

function normalizeArticle(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeUnit(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().replace(/[.\s]+/g, '').toLowerCase();
}

function quantitiesMatch(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return false;
  const tolerance = Math.max(0.001, Math.abs(left) * 0.001);
  return Math.abs(left - right) <= tolerance;
}

function quantitiesConflict(left: number | null, right: number | null): boolean {
  return left != null && right != null && !quantitiesMatch(left, right);
}

function unitsMatch(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeUnit(left);
  const normalizedRight = normalizeUnit(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

function unitsConflict(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeUnit(left);
  const normalizedRight = normalizeUnit(right);
  return normalizedLeft.length > 0 && normalizedRight.length > 0 && normalizedLeft !== normalizedRight;
}

function hasFinancialValue(item: InvoiceRow): boolean {
  return item.price != null || item.amount != null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function amountsMatchWithinTolerance(price: number, quantity: number, amount: number): boolean {
  const expectedAmount = price * quantity;
  const tolerance = Math.max(1.0, Math.abs(amount) * 0.02);
  return Math.abs(expectedAmount - amount) <= tolerance;
}

function convertVatSemantics(
  value: number,
  vatIncluded: boolean | null | undefined,
  vatRate: number | null | undefined,
  supplierPricesIncludeVat: number | null | undefined,
): number {
  if (vatRate == null || vatRate <= 0) return value;
  const factor = 1 + vatRate / 100;

  if (vatIncluded === true && supplierPricesIncludeVat === 0) {
    return roundMoney(value / factor);
  }

  if (vatIncluded === false && supplierPricesIncludeVat === 1) {
    return roundMoney(value * factor);
  }

  return value;
}

function buildGigaFinancialOverride(
  baseItem: InvoiceRow,
  gigaItem: InvoiceRow,
  metadata: InvoiceMetadata,
  supplierPricesIncludeVat?: number | null,
): { price: number; amount: number } | null {
  let price = gigaItem.price;
  let amount = gigaItem.amount;

  if (price == null && amount != null && baseItem.quantity != null && baseItem.quantity > 0) {
    price = roundMoney(amount / baseItem.quantity);
  }
  if (amount == null && price != null && baseItem.quantity != null && baseItem.quantity > 0) {
    amount = roundMoney(price * baseItem.quantity);
  }

  if (price == null || amount == null) return null;

  if (baseItem.quantity != null && baseItem.quantity > 0 && !amountsMatchWithinTolerance(price, baseItem.quantity, amount)) {
    console.warn(
      `[InvoiceRouter] price override uncertain: row=${baseItem.row_index}, price*quantity does not match amount`
    );
    return null;
  }

  return {
    price: convertVatSemantics(price, metadata.vatIncluded, metadata.vat_rate, supplierPricesIncludeVat),
    amount: convertVatSemantics(amount, metadata.vatIncluded, metadata.vat_rate, supplierPricesIncludeVat),
  };
}

function chooseConfidentCandidate(
  baseItem: InvoiceRow,
  candidateIndexes: number[],
  gigaItems: InvoiceRow[],
): number | null {
  const compatible = candidateIndexes.filter(index => {
    const candidate = gigaItems[index];
    if (!candidate) return false;
    return !quantitiesConflict(baseItem.quantity, candidate.quantity)
      && !unitsConflict(baseItem.unit, candidate.unit);
  });

  if (compatible.length === 1) return compatible[0] ?? null;
  if (compatible.length === 0) return null;

  const scored = compatible.map(index => {
    const candidate = gigaItems[index]!;
    const score = (quantitiesMatch(baseItem.quantity, candidate.quantity) ? 2 : 0)
      + (unitsMatch(baseItem.unit, candidate.unit) ? 1 : 0);
    return { index, score };
  });
  const bestScore = Math.max(...scored.map(candidate => candidate.score));
  const best = scored.filter(candidate => candidate.score === bestScore);

  if (bestScore > 0 && best.length === 1) return best[0]!.index;
  return null;
}

function findConfidentPriceMatch(
  baseItem: InvoiceRow,
  gigaItems: InvoiceRow[],
  usedGigaIndexes: Set<number>,
): number | null {
  const article = normalizeArticle(baseItem.article);
  if (article) {
    const articleCandidates = gigaItems
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !usedGigaIndexes.has(index) && normalizeArticle(item.article) === article)
      .map(({ index }) => index);

    if (articleCandidates.length > 0) {
      return chooseConfidentCandidate(baseItem, articleCandidates, gigaItems);
    }
  }

  const name = normalizeName(baseItem.name);
  if (!name) return null;

  const nameCandidates = gigaItems
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => !usedGigaIndexes.has(index) && normalizeName(item.name) === name)
    .map(({ index }) => index);

  return chooseConfidentCandidate(baseItem, nameCandidates, gigaItems);
}

function mergeGigaChatPrices(
  baseResult: InvoiceParseResult,
  gigaResult: GigaChatInvoiceResult,
  supplierPricesIncludeVat?: number | null,
): {
  parseResult: InvoiceParseResult;
  mergedRows: number;
  uncertainRows: number;
  extraGigaRows: number;
} {
  const usedGigaIndexes = new Set<number>();
  let mergedRows = 0;
  let uncertainRows = 0;

  const items = baseResult.items.map(baseItem => {
    const matchIndex = findConfidentPriceMatch(baseItem, gigaResult.items, usedGigaIndexes);
    if (matchIndex == null) {
      uncertainRows += 1;
      return { ...baseItem };
    }

    const gigaItem = gigaResult.items[matchIndex]!;
    usedGigaIndexes.add(matchIndex);

    const financialOverride = buildGigaFinancialOverride(baseItem, gigaItem, gigaResult.metadata, supplierPricesIncludeVat);
    if (!financialOverride) {
      uncertainRows += 1;
      return { ...baseItem };
    }

    mergedRows += 1;
    return {
      ...baseItem,
      price: financialOverride.price,
      amount: financialOverride.amount,
    };
  });

  const extraGigaRows = gigaResult.items.filter((item, index) =>
    !usedGigaIndexes.has(index) && hasFinancialValue(item)
  ).length;

  return {
    parseResult: {
      ...baseResult,
      items,
      totalAmount: gigaResult.metadata.totalWithVat ?? baseResult.totalAmount,
      vatAmount: gigaResult.metadata.vatAmount ?? baseResult.vatAmount,
    },
    mergedRows,
    uncertainRows,
    extraGigaRows,
  };
}

export async function applyParserPriceOverrides(
  filePath: string,
  baseResult: InvoiceParseResult,
  parserOverrides: SupplierParserOverrides | undefined,
  source: 'pdf' | 'excel',
  supplierContext?: string,
  supplierPricesIncludeVat?: number | null,
): Promise<ParserPriceOverrideResult> {
  const parseResult = cloneParseResult(baseResult);

  if (parserOverrides?.prices_source !== 'gigachat' || parseResult.items.length === 0) {
    return {
      parseResult,
      applied: false,
      needsAmountReview: false,
      reasonParts: [],
      mergedRows: 0,
      uncertainRows: 0,
      extraGigaRows: 0,
    };
  }

  const reasonParts = ['prices_source=gigachat'];

  if (!isGigaChatConfigured()) {
    return {
      parseResult,
      applied: true,
      needsAmountReview: true,
      reasonParts: [...reasonParts, 'price override uncertain: GigaChat not configured'],
      mergedRows: 0,
      uncertainRows: parseResult.items.length,
      extraGigaRows: 0,
    };
  }

  try {
    const gigaResult = source === 'pdf'
      ? await parsePdfWithGigaChat(filePath, supplierContext)
      : await parseExcelWithGigaChat(filePath, supplierContext);
    const mergeResult = mergeGigaChatPrices(parseResult, gigaResult, supplierPricesIncludeVat);
    const vatSemanticsMismatch =
      (gigaResult.metadata.vatIncluded === true && supplierPricesIncludeVat === 0)
      || (gigaResult.metadata.vatIncluded === false && supplierPricesIncludeVat === 1);
    const nextReasonParts = [
      ...reasonParts,
      `prices merged from GigaChat: ${mergeResult.mergedRows}/${parseResult.items.length} rows`,
    ];

    if (mergeResult.uncertainRows > 0) {
      nextReasonParts.push(`price override uncertain: ${mergeResult.uncertainRows} rows need review`);
    }
    if (mergeResult.extraGigaRows > 0) {
      nextReasonParts.push(`price override uncertain: GigaChat returned ${mergeResult.extraGigaRows} unmatched extra rows`);
    }
    if (vatSemanticsMismatch) {
      nextReasonParts.push(`price override uncertain: GigaChat vat_included=${gigaResult.metadata.vatIncluded} conflicts with supplier prices_include_vat=${supplierPricesIncludeVat}`);
    }

    console.log(
      `[InvoiceRouter] prices_source=gigachat, merged=${mergeResult.mergedRows}/${parseResult.items.length}, uncertain=${mergeResult.uncertainRows}, extra=${mergeResult.extraGigaRows}, vat_included=${gigaResult.metadata.vatIncluded ?? 'unknown'}, prices_include_vat=${supplierPricesIncludeVat ?? 'unknown'}`
    );

    return {
      parseResult: mergeResult.parseResult,
      metadata: gigaResult.metadata,
      vatRate: gigaResult.metadata.vat_rate,
      gigachatParseQuality: gigaResult.parseQuality,
      applied: true,
      needsAmountReview: mergeResult.uncertainRows > 0 || mergeResult.extraGigaRows > 0 || vatSemanticsMismatch,
      reasonParts: nextReasonParts,
      mergedRows: mergeResult.mergedRows,
      uncertainRows: mergeResult.uncertainRows,
      extraGigaRows: mergeResult.extraGigaRows,
    };
  } catch (error) {
    console.warn(`[InvoiceRouter] price override GigaChat failed: ${error instanceof Error ? error.message : error}`);
    return {
      parseResult,
      applied: true,
      needsAmountReview: true,
      reasonParts: [...reasonParts, 'price override uncertain: GigaChat failed'],
      mergedRows: 0,
      uncertainRows: parseResult.items.length,
      extraGigaRows: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Публичное API
// ---------------------------------------------------------------------------

/**
 * Маршрутизирует файл на нужный парсер и возвращает унифицированный результат.
 *
 * @param filePath   Путь к файлу на диске
 * @param savedMapping  Сохранённый маппинг колонок для конкретного поставщика
 */
export async function routeInvoiceFile(
  filePath: string,
  savedMapping?: SavedMapping,
  options: RouteInvoiceOptions = {},
): Promise<RouterParseResult> {
  const ext = path.extname(filePath).toLowerCase();
  const parserName = IMAGE_EXTS.has(ext)
    ? 'image'
    : EXCEL_EXTS.has(ext)
      ? 'excel'
      : ext === '.pdf'
        ? 'pdf'
        : null;

  const parserOverrides = parserName
    ? loadSupplierParserOverrides(options.supplierId, savedMapping)
    : undefined;
  const supplierPricesIncludeVat = parserName
    ? loadSupplierPricesIncludeVat(options.supplierId)
    : null;

  if (parserName) {
    logSupplierParserOverrides(parserName, options.supplierId, parserOverrides);
  }

  // ─── Изображения → GigaChat ───────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    if (!isGigaChatConfigured()) {
      throw new Error(`Изображения не поддерживаются: GigaChat не настроен (нет GIGACHAT_AUTH_KEY)`);
    }
    const gigaResult = await parsePdfWithGigaChat(filePath);
    const parseResult = gigachatToLegacy(gigaResult);
    const validation = validateInvoice(parseResult.items, gigaResult.metadata);
    return {
      source: 'image',
      category: validation.valid ? 'A' : 'B',
      parseResult,
      metadata: gigaResult.metadata,
      confidence: 90,
      validation,
      gigachatParseQuality: gigaResult.parseQuality,
    };
  }

  // ─── Excel ────────────────────────────────────────────────────────────
  if (EXCEL_EXTS.has(ext)) {
    const excelResult = parseExcelInvoice(filePath, savedMapping);
    const parseResult = excelToLegacy(excelResult);

    // Fallback на GigaChat при категории C или когда позиции не найдены
    const needsFallback = excelResult.items.length === 0 || excelResult.category === 'C';
    if (needsFallback && isGigaChatConfigured()) {
      console.log(`[InvoiceRouter] Excel category=${excelResult.category}, items=${excelResult.items.length} — GigaChat fallback`);
      try {
        const gigaResult = await parseExcelWithGigaChat(filePath);
        const gigaParseResult = gigachatToLegacy(gigaResult);
        if (gigaParseResult.items.length === 0) {
          console.log(`[InvoiceRouter] GigaChat also returned 0 items — category C`);
          return {
            source: 'gigachat_fallback',
            category: 'C',
            parseResult: gigaParseResult,
            metadata: gigaResult.metadata,
            confidence: 0,
            gigachatParseQuality: gigaResult.parseQuality,
          };
        }
        const validation = validateInvoice(gigaParseResult.items, gigaResult.metadata);
        return {
          source: 'gigachat_fallback',
          category: validation.valid ? 'A' : 'B',
          parseResult: gigaParseResult,
          metadata: gigaResult.metadata,
          confidence: 85,
          validation,
          gigachatParseQuality: gigaResult.parseQuality,
        };
      } catch (err) {
        console.warn(`[InvoiceRouter] GigaChat fallback failed: ${err instanceof Error ? err.message : err}`);
        // Возвращаем исходный Excel-результат с явной категорией C
        return {
          source: 'excel',
          category: 'C',
          parseResult: excelToLegacy(excelResult),
          metadata: excelResult.metadata,
          confidence: 0,
        };
      }
    }

    const priceOverride = await applyParserPriceOverrides(
      filePath,
      parseResult,
      parserOverrides,
      'excel',
      undefined,
      supplierPricesIncludeVat,
    );
    const metadata = priceOverride.metadata ?? excelResult.metadata;
    const validation = priceOverride.applied
      ? validateInvoice(priceOverride.parseResult.items, metadata)
      : excelResult.validation;

    return {
      source: 'excel',
      category: excelResult.category,
      parseResult: priceOverride.parseResult,
      metadata,
      confidence: excelResult.confidence.overall,
      validation,
      gigachatParseQuality: priceOverride.gigachatParseQuality,
      amountReviewRequired: priceOverride.needsAmountReview,
      parsingReasonAdditions: priceOverride.reasonParts,
    };
  }

  // ─── PDF ──────────────────────────────────────────────────────────────
  if (ext === '.pdf') {
    const pdfResult = await parsePdfFile(filePath, savedMapping);

    const hasItems = pdfResult.items.length > 0;

    if (!hasItems && isGigaChatConfigured()) {
      console.log(`[InvoiceRouter] PDF items=0 — GigaChat fallback`);
      try {
        const gigaResult = await parsePdfWithGigaChat(filePath);
        const gigaParseResult = gigachatToLegacy(gigaResult);
        if (gigaParseResult.items.length === 0) {
          console.log(`[InvoiceRouter] GigaChat PDF also returned 0 items — category C`);
          return {
            source: 'gigachat_fallback',
            category: 'C',
            parseResult: gigaParseResult,
            metadata: gigaResult.metadata,
            confidence: 0,
            gigachatParseQuality: gigaResult.parseQuality,
          };
        }
        const validation = validateInvoice(gigaParseResult.items, gigaResult.metadata);
        return {
          source: 'gigachat_fallback',
          category: validation.valid ? 'A' : 'B',
          parseResult: gigaParseResult,
          metadata: gigaResult.metadata,
          confidence: 85,
          validation,
          gigachatParseQuality: gigaResult.parseQuality,
        };
      } catch (err) {
        console.warn(`[InvoiceRouter] GigaChat fallback failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const priceOverride = await applyParserPriceOverrides(
      filePath,
      pdfResult,
      parserOverrides,
      'pdf',
      undefined,
      supplierPricesIncludeVat,
    );

    return {
      source: 'pdf',
      category: priceOverride.parseResult.items.length > 0 ? 'A' : 'C',
      parseResult: priceOverride.parseResult,
      metadata: priceOverride.metadata,
      confidence: hasItems ? 80 : 20,
      gigachatParseQuality: priceOverride.gigachatParseQuality,
      amountReviewRequired: priceOverride.needsAmountReview,
      parsingReasonAdditions: priceOverride.reasonParts,
    };
  }

  throw new Error(`Неподдерживаемый формат файла: ${ext}`);
}
