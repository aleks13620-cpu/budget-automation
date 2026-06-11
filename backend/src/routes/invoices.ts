import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { safeUnlink } from '../utils/safeUnlink';
import { createUploadMiddleware, fixFilename, parseJsonSafe, UPLOAD_DIR } from '../utils/fileUtils';
import { parsePdfFile, parsePdfFileWithExtraction, extractRawRows, detectColumns, SavedMapping, categorizeParsingResult, splitTextWithSeparator, parseTableData, SeparatorMethod, extractMetadata, detectDiscount } from '../services/pdfParser';
import { parseExcelInvoice, extractExcelRawRows, extractExcelPreviewData, excelToLegacy } from '../services/excelInvoiceParser';
import { applyParserPriceOverrides, loadSupplierParserOverrides, loadSupplierPricesIncludeVat, loadSupplierVatSettings, logSupplierParserOverrides, normalizeGigaChatRowsForSupplierVat, normalizeParsedRowsForSupplierVat, routeInvoiceFile } from '../services/invoiceRouter';
import type { SupplierParserOverrides } from '../services/invoiceRouter';
import type { GigaChatParseQuality } from '../services/gigachatParseQuality';
import { parsePdfWithGigaChat, parseExcelWithGigaChat } from '../services/gigachatParser';
import { isGigaChatConfigured } from '../services/gigachatService';
import { analyzeNameCorruption, NAME_CORRUPTION_RATIO_THRESHOLD } from '../services/nameCorruption';
import stringSimilarity from 'string-similarity';
import type { ExcelParseResult } from '../types/invoice';

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

const upload = createUploadMiddleware({
  allowedExtensions: ['.pdf', '.xlsx', '.xls', '.jpg', '.jpeg', '.png', '.tiff', '.bmp'],
  errorMessage: 'Допустимы только файлы .pdf, .xlsx, .xls, .jpg, .jpeg, .png, .tiff, .bmp',
  maxFileSizeBytes: 50 * 1024 * 1024,
});

const router = Router();

function assertUploadPath(fp: string): void {
  if (!path.resolve(fp).startsWith(UPLOAD_DIR)) {
    throw Object.assign(new Error('invalid_file_path'), { status: 400 });
  }
}

const DELIVERY_KEYWORDS = [
  'доставка', 'транспортные расходы', 'транспортные услуги',
  'транспортировка', 'доставка товара', 'грузоперевозк',
];

function isDeliveryItem(name: string): boolean {
  const lower = name.toLowerCase();
  return DELIVERY_KEYWORDS.some(kw => lower.includes(kw));
}

// Helper: compute needs_amount_review flag
// Returns 1 if VAT-normalized row totals diverge from totalWithVat by more than 15%
function computeNeedsAmountReview(
  items: Array<{ price: number | null; quantity: number | null; amount?: number | null }>,
  totalWithVat: number | null,
  vatRate: number | null = null,
  pricesIncludeVat: number | null = null,
): number {
  if (!totalWithVat || totalWithVat <= 0 || items.length === 0) return 0;
  const sumItems = items.reduce((acc, it) => {
    const lineAmount = it.amount ?? ((it.price ?? 0) * (it.quantity ?? 0));
    const lineAmountWithVat = pricesIncludeVat === 0 && vatRate != null && vatRate > 0
      ? lineAmount * (1 + vatRate / 100)
      : lineAmount;
    return acc + lineAmountWithVat;
  }, 0);
  if (sumItems === 0) return 0;
  const deviation = Math.abs(sumItems - totalWithVat) / totalWithVat;
  return deviation > 0.15 ? 1 : 0;
}

// Helper: detect document-level discount (Form D).
// Form D = document total is less than sum of line amounts by >15%, with no explicit
// "скидка X%" text. Returns the discount factor (0 < factor < 1) when the mismatch is
// clean and consistent, or null when ambiguous / not a discount.
//
// "Clean" means every line-amount participates in the same ratio (no per-line variation):
//   factor = documentTotal / sumLineAmounts
// We check that at least 90% of non-zero lines are within ±tolerance of the ratio (tolerating
// integer rounding), and that the ratio deviation from a round number is ≤ 2% (i.e. total
// lines ratio is stable across lines).
//
// Safety conditions (must ALL be true to return a factor):
//   1. documentTotal > 0 and sumLineAmounts > 0
//   2. sumLineAmounts > documentTotal  (it is a discount, not a surcharge)
//   3. deviation > 0.15 (reuses the same threshold as computeNeedsAmountReview)
//   4. At least 90% of lines with nonzero amount are consistent with the factor (±2%)
//   5. discount_applied == 0 (idempotency; caller checks this)
//
// VAT-awareness (FIX 1): line amounts are scaled by (1 + vatRate/100) when
// pricesIncludeVat===0 — exactly mirroring computeNeedsAmountReview.  When both
// documentTotal and lines share the same VAT convention the scaling cancels in the
// ratio, so a pure-VAT gap does NOT trigger Form D.
//
// Delivery exclusion (FIX 3): items with is_delivery===1 are skipped when computing
// the goods-only factor; their prices must NOT be touched by the apply endpoint.
//
// The function does NOT look at supplier name, percentage text, or any hardcoded value;
// it derives everything from the data.
function detectDocumentLevelDiscount(
  items: Array<{ amount: number | null; is_delivery?: number | null }>,
  documentTotal: number | null,
  vatRate: number | null = null,
  pricesIncludeVat: number | null = null,
): number | null {
  if (!documentTotal || documentTotal <= 0) return null;

  // FIX 3: exclude delivery lines from goods-only factor computation
  const goodsItems = items.filter(it => !it.is_delivery);

  // FIX 1: normalise amounts the same way as computeNeedsAmountReview
  const nonZeroAmounts = goodsItems
    .map(it => {
      const raw = it.amount;
      if (raw == null || raw <= 0) return null;
      return pricesIncludeVat === 0 && vatRate != null && vatRate > 0
        ? raw * (1 + vatRate / 100)
        : raw;
    })
    .filter((a): a is number => a != null && a > 0);

  if (nonZeroAmounts.length === 0) return null;

  const sumLineAmounts = nonZeroAmounts.reduce((s, a) => s + a, 0);
  if (sumLineAmounts <= 0) return null;

  // Must be a discount (total < sum), not a surcharge
  if (documentTotal >= sumLineAmounts) return null;

  const deviation = Math.abs(sumLineAmounts - documentTotal) / documentTotal;
  if (deviation <= 0.15) return null; // within tolerance; not a significant mismatch

  const factor = documentTotal / sumLineAmounts;

  // Consistency check: at least 90% of lines must have amount * factor ≈ rounded value (±2%)
  const TOLERANCE = 0.02;
  const consistentCount = nonZeroAmounts.filter(a => {
    const scaled = a * factor;
    const rounded = Math.round(scaled * 100) / 100; // round to cents
    return Math.abs(scaled - rounded) / (rounded || 1) <= TOLERANCE;
  }).length;

  const consistencyRatio = consistentCount / nonZeroAmounts.length;
  if (consistencyRatio < 0.90) return null; // per-line or mixed discount — not safe to apply

  return factor;
}

function hasValidFinancialCore(items: Array<{ quantity: number | null; price: number | null; amount: number | null }>): boolean {
  return items.some(item =>
    item.quantity != null && item.quantity > 0
    && item.price != null && item.price > 0
    && item.amount != null && item.amount > 0
  );
}

function applySupplierHeuristics(
  supplierName: string | null,
  items: Array<{ quantity: number | null; price: number | null; amount: number | null }>,
): void {
  if (!supplierName || items.length === 0) return;
  const normalized = supplierName.toLowerCase();
  if (!normalized.includes('атм')) return;

  for (const item of items) {
    if ((item.quantity == null || item.quantity <= 0) && item.amount != null && item.price != null && item.price > 0) {
      item.quantity = Math.round((item.amount / item.price) * 1000) / 1000;
    }
    if ((item.price == null || item.price <= 0) && item.amount != null && item.quantity != null && item.quantity > 0) {
      item.price = Math.round((item.amount / item.quantity) * 100) / 100;
    }
    if ((item.amount == null || item.amount <= 0) && item.price != null && item.quantity != null && item.quantity > 0) {
      item.amount = Math.round((item.price * item.quantity) * 100) / 100;
    }
  }
}

function computeUnitPriceWithVat(
  price: number | null,
  amount: number | null,
  quantity: number | null,
  vatRate: number | null,
  pricesIncludeVat: number | null,
): { unitPriceWithVat: number | null; source: 'raw' | 'derived_unit' } {
  if (amount != null && quantity != null && quantity > 0) {
    const lineTotalWithVat = pricesIncludeVat === 0 && vatRate != null && vatRate > 0
      ? amount * (1 + vatRate / 100)
      : amount;
    return { unitPriceWithVat: Math.round((lineTotalWithVat / quantity) * 100) / 100, source: 'derived_unit' };
  }
  if (price == null) return { unitPriceWithVat: null, source: 'raw' };
  if (pricesIncludeVat === 0 && vatRate != null && vatRate > 0) {
    return { unitPriceWithVat: Math.round(price * (1 + vatRate / 100) * 100) / 100, source: 'raw' };
  }
  return { unitPriceWithVat: price, source: 'raw' };
}

// Helper: build supplier context string for GigaChat from saved parser config
function buildSupplierContext(supplierName: string | null, savedMapping: SavedMapping | undefined): string | undefined {
  if (!savedMapping || !supplierName) return undefined;
  if (savedMapping.gigachatLearned) {
    return (
      `КОНТЕКСТ ПОСТАВЩИКА: счёт от "${supplierName}". ` +
      'Ранее позиции этого поставщика надёжно извлекались через GigaChat; восстанови полную таблицу товаров из документа.'
    );
  }
  const colNames: string[] = [];
  if (savedMapping.name) colNames.push(`наименование (колонка ${savedMapping.name})`);
  if (savedMapping.article) colNames.push(`артикул (колонка ${savedMapping.article})`);
  if (savedMapping.quantity) colNames.push(`количество (колонка ${savedMapping.quantity})`);
  if (savedMapping.unit) colNames.push(`единица (колонка ${savedMapping.unit})`);
  if (savedMapping.price) colNames.push(`цена (колонка ${savedMapping.price})`);
  if (savedMapping.amount) colNames.push(`сумма (колонка ${savedMapping.amount})`);
  if (colNames.length === 0) return undefined;
  const context = `КОНТЕКСТ ПОСТАВЩИКА: счёт от "${supplierName}". Структура таблицы: ${colNames.join(', ')}. Ориентируйся на эту структуру при извлечении данных.`;
  console.log(`[GigaChat] Supplier context: ${context}`);
  return context;
}

// Helper: load saved parser config for a supplier
function loadSavedMapping(supplierId: number): SavedMapping | undefined {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT config FROM supplier_parser_configs WHERE supplier_id = ?'
  ).get(supplierId) as { config: string } | undefined;

  if (!row) return undefined;

  try {
    const config = JSON.parse(row.config);
    if (config.gigachatLearned === true) {
      return config as SavedMapping;
    }
    if (typeof config.headerRow === 'number' && config.name !== undefined) {
      return config as SavedMapping;
    }
  } catch {
    // invalid JSON, ignore
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isParserOverrideSource(value: unknown): value is 'gemini' | 'gigachat' {
  return value === 'gemini' || value === 'gigachat';
}

function normalizeParserOverrides(value: unknown): SupplierParserOverrides | null {
  if (!isPlainObject(value)) return null;

  const parserOverrides: SupplierParserOverrides = {};

  if (value.prices_source !== undefined) {
    if (!isParserOverrideSource(value.prices_source)) return null;
    parserOverrides.prices_source = value.prices_source;
  }

  if (value.text_source !== undefined) {
    if (!isParserOverrideSource(value.text_source)) return null;
    parserOverrides.text_source = value.text_source;
  }

  return parserOverrides;
}

function mergeParserOverrides(
  config: Record<string, unknown>,
  parserOverrides: SupplierParserOverrides,
): SupplierParserOverrides {
  const existingOverrides = normalizeParserOverrides(config.parser_overrides) ?? {};
  return { ...existingOverrides, ...parserOverrides };
}

function preserveParserOverrides(
  nextConfig: Record<string, unknown>,
  existingConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (nextConfig.parser_overrides !== undefined) return nextConfig;

  const existingOverrides = normalizeParserOverrides(existingConfig.parser_overrides);
  if (!existingOverrides || Object.keys(existingOverrides).length === 0) {
    return nextConfig;
  }

  return { ...nextConfig, parser_overrides: existingOverrides };
}

function loadSupplierParserConfig(
  db: ReturnType<typeof getDatabase>,
  supplierId: number,
): Record<string, unknown> {
  const existing = db.prepare(
    'SELECT config FROM supplier_parser_configs WHERE supplier_id = ?'
  ).get(supplierId) as { config: string } | undefined;

  if (!existing) return {};

  const parsed = parseJsonSafe<Record<string, unknown>>(
    existing.config,
    {},
    'load supplier_parser_configs'
  );
  return isPlainObject(parsed) ? parsed : {};
}

// PATCH /api/suppliers/:id/parser-overrides - merge supplier parser overrides into saved parser config
router.patch('/api/suppliers/:id/parser-overrides', (req: Request, res: Response) => {
  try {
    const supplierId = Number(req.params.id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return res.status(400).json({ error: 'Invalid supplier id' });
    }

    const parserOverrides = normalizeParserOverrides(req.body?.parser_overrides);
    if (!parserOverrides || Object.keys(parserOverrides).length === 0) {
      return res.status(400).json({ error: 'parser_overrides must be an object with gemini/gigachat sources' });
    }

    const db = getDatabase();
    const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    const existing = db.prepare(
      'SELECT id, config FROM supplier_parser_configs WHERE supplier_id = ?'
    ).get(supplierId) as { id: number; config: string } | undefined;

    const existingConfig = existing
      ? parseJsonSafe<Record<string, unknown>>(
          existing.config,
          {},
          'PATCH /api/suppliers/:id/parser-overrides supplier_parser_configs'
        )
      : {};
    const config = isPlainObject(existingConfig) ? existingConfig : {};
    const nextParserOverrides = mergeParserOverrides(config, parserOverrides);
    const nextConfig = { ...config, parser_overrides: nextParserOverrides };
    const nextConfigJson = JSON.stringify(nextConfig);

    if (existing) {
      db.prepare('UPDATE supplier_parser_configs SET config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextConfigJson, existing.id);
    } else {
      db.prepare('INSERT INTO supplier_parser_configs (supplier_id, config) VALUES (?, ?)').run(
        supplierId,
        nextConfigJson,
      );
    }

    res.json({ ok: true, parser_overrides: nextParserOverrides });
  } catch (error) {
    console.error('PATCH /api/suppliers/:id/parser-overrides error:', error);
    res.status(500).json({ error: 'Failed to save parser overrides' });
  }
});

function saveSnapshot(invoiceId: number, action: string, db: ReturnType<typeof getDatabase>): void {
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);
  const maxVerRow = db.prepare('SELECT MAX(version) as v FROM invoice_items_history WHERE invoice_id = ?').get(invoiceId) as { v: number | null } | undefined;
  const maxVer = maxVerRow?.v ?? 0;
  db.prepare('INSERT INTO invoice_items_history (invoice_id, version, items_snapshot, action) VALUES (?,?,?,?)')
    .run(invoiceId, maxVer + 1, JSON.stringify(items), action);
}

function invoiceItemsSnapshotJson(invoiceId: number, db: ReturnType<typeof getDatabase>): string {
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);
  return JSON.stringify(items);
}

// Helper: process a single invoice file (parse, detect supplier, insert into DB)
// `options.extractedOverride` is a test/DI seam: when set, the PDF first-pass parse uses the
// provided pre-extracted rows/text instead of re-reading the file — lets integration tests drive
// the real upload pipeline deterministically without depending on PDF font/extraction quirks.
export async function processInvoiceFile(
  file: { originalname: string; path: string },
  projectId: number,
  db: ReturnType<typeof getDatabase>,
  options?: { extractedOverride?: { rows: string[][]; fullText: string } },
): Promise<{
  invoiceId: number;
  supplierName: string | null;
  imported: number;
  parsingCategory: string;
  status: string;
  errors: string[];
}> {
  const ext = path.extname(file.originalname).toLowerCase();

  // For PDF: extract raw data once, reuse for parsing and categorization
  let pdfRawRows: string[][] | null = null;
  let pdfFullText: string | null = null;

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.bmp']);

  // For images — delegate entirely to invoiceRouter (GigaChat)
  if (IMAGE_EXTS.has(ext)) {
    const routerResult = await routeInvoiceFile(file.path);
    let parseResult = routerResult.parseResult;
    const status = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';
    const fileName = fixFilename(file.originalname);
    const supplierNameImg = parseResult.supplierName;
    let supplierIdImg: number | null = null;
    if (supplierNameImg) {
      const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplierNameImg) as { id: number } | undefined;
      supplierIdImg = existing ? existing.id : Number(db.prepare('INSERT INTO suppliers (name, vat_rate) VALUES (?, 22)').run(supplierNameImg).lastInsertRowid);
    }
    if (supplierIdImg) {
      const parserOverrides = loadSupplierParserOverrides(supplierIdImg);
      logSupplierParserOverrides('image', supplierIdImg, parserOverrides);
    }
    const imgVatSettings = loadSupplierVatSettings(supplierIdImg);
    const imgVatNormalization = routerResult.metadata
      ? normalizeGigaChatRowsForSupplierVat(
        parseResult.items,
        routerResult.metadata,
        imgVatSettings.pricesIncludeVat,
        imgVatSettings.vatRate,
      )
      : null;
    if (imgVatNormalization) {
      parseResult = { ...parseResult, items: imgVatNormalization.items };
    }
    let imgReason = `Image/GigaChat confidence=${routerResult.confidence}`;
    if (routerResult.gigachatParseQuality?.warnings.length) {
      imgReason += ` | ${routerResult.gigachatParseQuality.warnings.join('; ')}`;
    }
    if (routerResult.parsingReasonAdditions?.length) {
      imgReason += ` | ${routerResult.parsingReasonAdditions.join('; ')}`;
    }
    if (imgVatNormalization?.reasonParts.length) {
      imgReason += ` | ${imgVatNormalization.reasonParts.join('; ')}`;
    }
    const imgVatRate = routerResult.metadata?.vat_rate ?? imgVatSettings.vatRate ?? 22;
    const imgPricesIncludeVat = imgVatSettings.pricesIncludeVat;
    let imgNeedsReview = computeNeedsAmountReview(parseResult.items, parseResult.totalAmount ?? null, imgVatRate, imgPricesIncludeVat);
    if (routerResult.gigachatParseQuality?.suggestElevatedReview) imgNeedsReview = 1;
    if (routerResult.amountReviewRequired || imgVatNormalization?.needsAmountReview) imgNeedsReview = 1;
    // Form D detection for image path (detect+inform only, NOT silent apply)
    const imgFormDApplied = 0; // parse-time never sets this; only the apply endpoint does
    const imgFormDOriginalPrices: Array<number | null> = parseResult.items.map(() => null); // always null at parse time
    if (parseResult.totalAmount != null && parseResult.totalAmount > 0) {
      const imgFormDFactor = detectDocumentLevelDiscount(parseResult.items, parseResult.totalAmount);
      if (imgFormDFactor != null) {
        // Do NOT mutate prices or amounts — detect and inform only
        imgNeedsReview = 1;
        const imgDiscountPct = Math.round((1 - imgFormDFactor) * 10000) / 100;
        imgReason += ` | Form D: вероятная документная скидка ~${imgDiscountPct}% (итог < суммы строк); цена за ед. будет пересчитана при подтверждении (factor=${imgFormDFactor.toFixed(4)})`;
        console.log(`[Invoice] Form D detected (not applied) image path: factor=${imgFormDFactor.toFixed(4)} (${imgDiscountPct}% off), items=${parseResult.items.length} — awaiting operator confirmation`);
      }
    }
    const insertInvoiceImg = db.prepare(`INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, file_name, file_path, total_amount, vat_amount, status, parsing_category, parsing_category_reason, discount_detected, needs_amount_review, vat_rate, discount_applied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertItemImg = db.prepare(`INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery, original_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const invoiceIdImg = db.transaction(() => {
      const r = insertInvoiceImg.run(projectId, supplierIdImg, parseResult.invoiceNumber, parseResult.invoiceDate, fileName, file.path, parseResult.totalAmount, parseResult.vatAmount ?? null, status, routerResult.category, imgReason, null, imgNeedsReview, imgVatRate ?? 22, imgFormDApplied);
      const iid = Number(r.lastInsertRowid);
      for (let i = 0; i < parseResult.items.length; i++) {
        const item = parseResult.items[i];
        insertItemImg.run(iid, item.article, item.name, item.unit, item.quantity, item.quantity_packages ?? null, item.price, item.amount, item.row_index, isDeliveryItem(item.name) ? 1 : 0, imgFormDOriginalPrices[i]);
      }
      return iid;
    })();
    console.log(`[Invoice] image source=${routerResult.source}, items=${parseResult.items.length}, category=${routerResult.category}`);
    return { invoiceId: invoiceIdImg, supplierName: supplierNameImg, imported: parseResult.items.length, parsingCategory: routerResult.category, status, errors: [] };
  }

  // First pass: parse without saved config to get supplier name
  let initialResult;
  let lastExcelResult: ExcelParseResult | null = null;
  if (ext === '.pdf') {
    const pdfParsed = await parsePdfFileWithExtraction(file.path, undefined, options?.extractedOverride);
    pdfRawRows = pdfParsed.rows;
    pdfFullText = pdfParsed.fullText;
    initialResult = pdfParsed.parseResult;
  } else {
    lastExcelResult = parseExcelInvoice(file.path);
    initialResult = excelToLegacy(lastExcelResult);
  }

  // Find or create supplier
  let supplierName = initialResult.supplierName;

  // Fallback: try to match supplier from filename
  if (!supplierName) {
    const fileName = fixFilename(file.originalname);
    const baseName = path.basename(fileName, path.extname(fileName));
    const firstWordMatch = baseName.match(/^[+\s]*([A-Za-zА-Яа-яёЁ]{3,})/);
    if (firstWordMatch) {
      const keyword = firstWordMatch[1];
      const found = db.prepare(
        'SELECT id, name FROM suppliers WHERE name LIKE ? LIMIT 1'
      ).get(`%${keyword}%`) as { id: number; name: string } | undefined;
      if (found) {
        supplierName = found.name;
      }
    }
  }

  let supplierId: number | null = null;
  if (supplierName) {
    const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplierName) as { id: number } | undefined;
    if (existing) {
      supplierId = existing.id;
    } else {
      const result = db.prepare('INSERT INTO suppliers (name, vat_rate) VALUES (?, 22)').run(supplierName);
      supplierId = Number(result.lastInsertRowid);
    }
  }

  let savedMapping: SavedMapping | undefined;
  let parserOverrides: SupplierParserOverrides | undefined;
  if (supplierId) {
    savedMapping = loadSavedMapping(supplierId);
    parserOverrides = loadSupplierParserOverrides(supplierId, savedMapping);
    logSupplierParserOverrides(ext === '.pdf' ? 'pdf' : 'excel', supplierId, parserOverrides);
  }
  const supplierVatSettings = loadSupplierVatSettings(supplierId);

  function isGigaChatOnlyMapping(m: SavedMapping): boolean {
    return !!m.gigachatLearned && !m.separatorMethod;
  }

  // Check for saved parser config and re-parse if available
  let parseResult = initialResult;
  if (supplierId && savedMapping) {
    if (!isGigaChatOnlyMapping(savedMapping)) {
      if (ext === '.pdf' && pdfRawRows && pdfFullText !== null) {
        if (savedMapping.separatorMethod) {
          const splitRows = splitTextWithSeparator(pdfFullText, savedMapping.separatorMethod, savedMapping.separatorValue);
          const colMapping = {
            article: savedMapping.article, name: savedMapping.name, unit: savedMapping.unit,
            quantity: savedMapping.quantity, quantity_packages: savedMapping.quantity_packages ?? null,
            price: savedMapping.price, amount: savedMapping.amount,
          };
          const tableResult = parseTableData(splitRows, colMapping, savedMapping.headerRow + 1);
          let totalAmount: number | null = null;
          if (tableResult.items.length > 0) {
            const sum = tableResult.items.reduce((acc, item) => acc + (item.amount || 0), 0);
            if (sum > 0) totalAmount = sum;
          }
          const metadata = extractMetadata(pdfFullText);
          parseResult = {
            items: tableResult.items,
            errors: tableResult.errors,
            totalRows: splitRows.length - savedMapping.headerRow - 1,
            skippedRows: tableResult.skipped,
            invoiceNumber: metadata.invoiceNumber,
            invoiceDate: metadata.invoiceDate,
            supplierName: metadata.supplierName,
            totalAmount: totalAmount || metadata.totalAmount,
            vatAmount: null,
            discountDetected: detectDiscount(pdfFullText),
          };
        } else {
          const pdfParsed = await parsePdfFileWithExtraction(file.path, savedMapping, {
            rows: pdfRawRows,
            fullText: pdfFullText,
          });
          pdfRawRows = pdfParsed.rows;
          pdfFullText = pdfParsed.fullText;
          parseResult = pdfParsed.parseResult;
        }
      } else {
        lastExcelResult = parseExcelInvoice(file.path, savedMapping);
        parseResult = excelToLegacy(lastExcelResult);
      }
    }
  }

  let parsedVatRate: number = supplierVatSettings.vatRate ?? 22;
  let lastGigaParseQuality: GigaChatParseQuality | undefined;
  let gigachatFallbackSucceeded = false;
  let geminiOcrSucceeded = false;
  let priceOverrideNeedsAmountReview = false;
  let priceOverrideReasonParts: string[] = [];

  applySupplierHeuristics(supplierName, parseResult.items);

  // Feature #1 (НДС ровно один раз): сверяем vat-состояние ВЫБРАННОЙ колонки (classifyColumnVat,
  // прокинуто в parseResult.amount/priceVatIncluded) с флагом поставщика и приводим значения к
  // состоянию, которого ждёт computeUnitPriceWithVat — НДС применяется ровно один раз. Делаем
  // здесь, на upload-пути (он минует routeInvoiceFile), для классического парсера ДО GigaChat-
  // override/fallback (у тех своя нормализация). No-op для нейтральной колонки/согласованного флага.
  const classicVatNorm = normalizeParsedRowsForSupplierVat(
    parseResult.items,
    parseResult.amountVatIncluded,
    parseResult.priceVatIncluded,
    supplierVatSettings.pricesIncludeVat,
    parsedVatRate,
  );
  parseResult = { ...parseResult, items: classicVatNorm.items };
  if (classicVatNorm.needsAmountReview) priceOverrideNeedsAmountReview = true;
  if (classicVatNorm.reasonParts.length) priceOverrideReasonParts.push(...classicVatNorm.reasonParts);

  if (parserOverrides?.prices_source === 'gigachat' && parseResult.items.length > 0) {
    const supplierCtx = buildSupplierContext(supplierName, savedMapping);
    const priceOverride = await applyParserPriceOverrides(
      file.path,
      parseResult,
      parserOverrides,
      ext === '.pdf' ? 'pdf' : 'excel',
      supplierCtx,
      supplierVatSettings.pricesIncludeVat,
      parsedVatRate,
    );
    parseResult = priceOverride.parseResult;
    priceOverrideNeedsAmountReview = priceOverride.needsAmountReview;
    priceOverrideReasonParts = priceOverride.reasonParts;
    if (priceOverride.gigachatParseQuality) lastGigaParseQuality = priceOverride.gigachatParseQuality;
    if (priceOverride.vatRate != null) parsedVatRate = priceOverride.vatRate;
    if (priceOverride.mergedRows > 0) lastExcelResult = null;
  }

  const financialCoreMissing = !hasValidFinancialCore(parseResult.items);
  const preserveBaseRowsForPriceOverride = parserOverrides?.prices_source === 'gigachat' && parseResult.items.length > 0;

  const needsGigaChat = parseResult.items.length === 0 ||
    (!preserveBaseRowsForPriceOverride && financialCoreMissing) ||
    (lastExcelResult !== null && lastExcelResult.category === 'C');

  if (needsGigaChat && isGigaChatConfigured()) {
    try {
      const supplierCtx = buildSupplierContext(supplierName, savedMapping);
      let gigaResult;
      if (ext === '.pdf') {
        console.log(`[InvoiceRouter] PDF items=${parseResult.items.length}, financialCoreMissing=${financialCoreMissing} — GigaChat fallback`);
        gigaResult = await parsePdfWithGigaChat(file.path, supplierCtx);
      } else {
        console.log(`[InvoiceRouter] Excel category=${lastExcelResult?.category}, items=${parseResult.items.length} — GigaChat fallback`);
        gigaResult = await parseExcelWithGigaChat(file.path, supplierCtx);
      }

      // document_type guard: если документ явно не счёт и нет суммы — не перезаписывать результат
      const docType = (gigaResult.documentType || '').toLowerCase();
      const isNonInvoice = docType &&
        !['счёт', 'счет', 'invoice'].some(t => docType.includes(t));
      const hasFinancialData = gigaResult.metadata.totalWithVat != null || gigaResult.items.length >= 3;

      if (isNonInvoice && !hasFinancialData) {
        console.log(`[GigaChat] Skipping non-invoice document (type="${gigaResult.documentType}", items=${gigaResult.items.length}) — keeping classic parser result`);
      } else {
        // Fuzzy supplier match: если GigaChat нашёл поставщика — проверить по БД
        let resolvedSupplierName = gigaResult.metadata.supplierName || parseResult.supplierName;
        if (gigaResult.metadata.supplierName) {
          const allSuppliers = db.prepare('SELECT name FROM suppliers').all() as { name: string }[];
          if (allSuppliers.length > 0) {
            const supplierNames = allSuppliers.map(s => s.name);
            const match = stringSimilarity.findBestMatch(gigaResult.metadata.supplierName, supplierNames);
            if (match.bestMatch.rating >= 0.75) {
              console.log(`[GigaChat] Fuzzy supplier match: "${gigaResult.metadata.supplierName}" → "${match.bestMatch.target}" (score=${match.bestMatch.rating.toFixed(2)})`);
              resolvedSupplierName = match.bestMatch.target;
            }
          }
        }

        const vatNormalization = normalizeGigaChatRowsForSupplierVat(
          gigaResult.items,
          gigaResult.metadata,
          supplierVatSettings.pricesIncludeVat,
          parsedVatRate,
        );
        if (vatNormalization.needsAmountReview) priceOverrideNeedsAmountReview = true;
        if (vatNormalization.reasonParts.length) priceOverrideReasonParts.push(...vatNormalization.reasonParts);

        parseResult = {
          items: vatNormalization.items,
          errors: [],
          totalRows: gigaResult.items.length,
          skippedRows: 0,
          invoiceNumber: gigaResult.metadata.documentNumber,
          invoiceDate: gigaResult.metadata.documentDate,
          supplierName: resolvedSupplierName,
          totalAmount: gigaResult.metadata.totalWithVat,
          vatAmount: gigaResult.metadata.vatAmount,
          discountDetected: null,
        };
        applySupplierHeuristics(resolvedSupplierName, parseResult.items);
        gigachatFallbackSucceeded = gigaResult.items.length > 0;
        lastGigaParseQuality = gigaResult.parseQuality;
        parsedVatRate = vatNormalization.vatRate ?? parsedVatRate;
        if (lastExcelResult) lastExcelResult = null; // сбрасываем чтобы категория считалась заново
      }
    } catch (err) {
      console.warn(`[InvoiceRouter] GigaChat fallback failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Gemini OCR fallback — для сканированных PDF когда текстовый слой отсутствует
  if (
    ext === '.pdf' &&
    !gigachatFallbackSucceeded &&
    parseResult.items.length === 0 &&
    process.env.OPENROUTER_API_KEY
  ) {
    try {
      const { ocrPdfWithGemini } = await import('../services/geminiOcr');
      const geminiResult = await ocrPdfWithGemini(file.path);
      if (geminiResult && geminiResult.items.length > 0) {
        parseResult = geminiResult;
        geminiOcrSucceeded = true;
        console.log(`[GeminiOCR] Extracted ${geminiResult.items.length} items from PDF: ${file.originalname}`);
      }
    } catch (err) {
      console.warn(`[GeminiOCR] Fallback failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Categorize parsing result
  let parsingCategory: string;
  let parsingCategoryReason: string;

  if (geminiOcrSucceeded) {
    const hasCore = hasValidFinancialCore(parseResult.items);
    parsingCategory = hasCore ? 'A' : 'B';
    parsingCategoryReason = `GeminiOCR: ${parseResult.items.length} позиций` + (hasCore ? '' : ', неполные финансовые данные');
  } else if (ext === '.pdf' && pdfRawRows && pdfFullText !== null) {
    const cat = categorizeParsingResult(parseResult, pdfRawRows, pdfFullText);
    parsingCategory = cat.category;
    parsingCategoryReason = cat.reason;
  } else if (lastExcelResult) {
    // Используем confidence-based категорию из Excel-парсера
    parsingCategory = lastExcelResult.category;
    parsingCategoryReason = `Excel confidence: ${lastExcelResult.confidence.overall}%` +
      (lastExcelResult.validation.warnings.length > 0 ? `, предупреждений: ${lastExcelResult.validation.warnings.length}` : '');
    console.log(`[Invoice] Excel category=${parsingCategory}, confidence=${lastExcelResult.confidence.overall}, errors=${lastExcelResult.validation.errors.length}, warnings=${lastExcelResult.validation.warnings.length}`);
  } else {
    if (parseResult.items.length > 0) {
      parsingCategory = 'A';
      parsingCategoryReason = `Успешно: ${parseResult.items.length} позиций`;
    } else if (needsGigaChat) {
      parsingCategory = 'C';
      parsingCategoryReason = 'GigaChat не смог распознать позиции';
    } else {
      parsingCategory = 'B';
      parsingCategoryReason = 'Колонки не распознаны';
    }
  }

  if (lastGigaParseQuality?.warnings.length) {
    parsingCategoryReason += ` | ${lastGigaParseQuality.warnings.join('; ')}`;
  }

  if (parsingCategory === 'A' && !hasValidFinancialCore(parseResult.items)) {
    parsingCategory = 'B';
    parsingCategoryReason = 'Понижено до B: отсутствуют валидные quantity/price/amount';
  }

  if (priceOverrideReasonParts.length > 0) {
    parsingCategoryReason += ` | ${priceOverrideReasonParts.join('; ')}`;
  }

  // Broken-font name corruption (detect→review): silent A is the blind spot here —
  // finances can be perfectly valid while names are scrambled (Cyr+Lat/digit wedges
  // from a font without ToUnicode). We do NOT auto-reparse (would replace correct
  // finances); we only surface the invoice to the operator who can hit /reparse-gigachat.
  const nameCorruption = analyzeNameCorruption(parseResult.items.map(it => it.name || ''));
  if (nameCorruption.ratio >= NAME_CORRUPTION_RATIO_THRESHOLD) {
    const pct = Math.round(nameCorruption.ratio * 100);
    if (parsingCategory === 'A') {
      parsingCategory = 'B';
      parsingCategoryReason += ` | Понижено до B: имена нечитаемы (битый шрифт): ${pct}%`;
    } else {
      parsingCategoryReason += ` | имена нечитаемы (битый шрифт): ${pct}%`;
    }
  }

  const status = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';
  const fileName = fixFilename(file.originalname);

  console.log(`Invoice parse: file=${fileName}, items=${parseResult.items.length}, status=${status}, errors=${parseResult.errors.length}`);

  // Insert invoice and items in a transaction
  const supplierPricesIncludeVatForReview = loadSupplierPricesIncludeVat(supplierId);
  let needsAmountReview = computeNeedsAmountReview(parseResult.items, parseResult.totalAmount ?? null, parsedVatRate, supplierPricesIncludeVatForReview);
  if (lastGigaParseQuality?.suggestElevatedReview) needsAmountReview = 1;
  if (priceOverrideNeedsAmountReview) needsAmountReview = 1;
  if (nameCorruption.ratio >= NAME_CORRUPTION_RATIO_THRESHOLD) needsAmountReview = 1;
  // Фича #3 (detect→review): обнаружена скидка «−X%» в тексте счёта. Суммы строк НЕ трогаем
  // (на проде нет данных для валидации авто-применения) — только помечаем счёт на ревью
  // оператору и дописываем процент в reason. Процент динамический (detectDiscount → number).
  // > 0: detectDiscount возвращает 0 на «скидка 0%» — это не скидка, не флагуем.
  if (parseResult.discountDetected != null && parseResult.discountDetected > 0) {
    needsAmountReview = 1;
    parsingCategoryReason += ` | обнаружена скидка ${parseResult.discountDetected}% — проверьте, учтена ли в ценах строк`;
  }

  // Фича Form D (document-level discount detect+inform, NOT silent apply):
  // Если явная скидка «−X%» не найдена (discount_detected IS NULL) но итог документа
  // существенно меньше суммы строк (>15%) — это вероятная скрытая документальная скидка.
  // БЕЗОПАСНЫЙ путь: НЕ меняем цены/суммы при парсинге; ставим needs_amount_review=1 и
  // сообщаем оператору о предполагаемой скидке. Применение — только через явный эндпоинт
  // POST /api/invoices/:id/apply-document-discount (оператор/владелец подтверждает).
  const formDApplied = 0; // parse-time never sets this; only the apply endpoint does
  const formDOriginalPrices: Array<number | null> = parseResult.items.map(() => null); // always null at parse time
  if ((parseResult.discountDetected == null || parseResult.discountDetected === 0) && parseResult.totalAmount != null && parseResult.totalAmount > 0) {
    // FIX 1: pass VAT settings so a pure-VAT gap is not mistaken for a discount
    // FIX 3: is_delivery field on parseResult.items (set below) lets the helper skip delivery lines;
    //         pass a projected view with is_delivery derived from the item name (same logic as insertItem)
    const itemsWithDelivery = parseResult.items.map(it => ({
      amount: it.amount,
      is_delivery: isDeliveryItem(it.name) ? 1 : 0,
    }));
    const formDFactor = detectDocumentLevelDiscount(itemsWithDelivery, parseResult.totalAmount, parsedVatRate, supplierPricesIncludeVatForReview);
    if (formDFactor != null) {
      // Do NOT mutate prices or amounts — detect and inform only
      needsAmountReview = 1;
      const discountPct = Math.round((1 - formDFactor) * 10000) / 100;
      parsingCategoryReason += ` | Form D: вероятная документная скидка ~${discountPct}% (итог < суммы строк); цена за ед. будет пересчитана при подтверждении (factor=${formDFactor.toFixed(4)})`;
      console.log(`[Invoice] Form D detected (not applied): factor=${formDFactor.toFixed(4)} (${discountPct}% off), items=${parseResult.items.length} — awaiting operator confirmation`);
    }
  }

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, file_name, file_path, total_amount, vat_amount, status, parsing_category, parsing_category_reason, discount_detected, needs_amount_review, vat_rate, discount_applied)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery, original_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = db.transaction(() => {
    const invoiceResult = insertInvoice.run(
      projectId,
      supplierId,
      parseResult.invoiceNumber,
      parseResult.invoiceDate,
      fileName,
      file.path,
      parseResult.totalAmount,
      parseResult.vatAmount ?? null,
      status,
      parsingCategory,
      parsingCategoryReason,
      parseResult.discountDetected ?? null,
      needsAmountReview,
      parsedVatRate,
      formDApplied,
    );
    const invoiceId = Number(invoiceResult.lastInsertRowid);

    for (let i = 0; i < parseResult.items.length; i++) {
      const item = parseResult.items[i];
      insertItem.run(
        invoiceId,
        item.article,
        item.name,
        item.unit,
        item.quantity,
        item.quantity_packages ?? null,
        item.price,
        item.amount,
        item.row_index,
        isDeliveryItem(item.name) ? 1 : 0,
        formDOriginalPrices[i],
      );
    }

    return invoiceId;
  })();

  if (gigachatFallbackSucceeded && supplierId && parseResult.items.length >= 3) {
    const exists = db.prepare('SELECT 1 FROM supplier_parser_configs WHERE supplier_id = ?').get(supplierId);
    if (!exists) {
      const learned: SavedMapping = {
        gigachatLearned: true,
        headerRow: 0,
        name: 0,
        article: null,
        unit: null,
        quantity: null,
        price: null,
        amount: null,
      };
      db.prepare('INSERT INTO supplier_parser_configs (supplier_id, config) VALUES (?, ?)').run(
        supplierId,
        JSON.stringify(learned),
      );
    }
  }

  // Flag items that match unit conversion triggers
  const triggers = db.prepare('SELECT * FROM unit_conversion_triggers').all() as { id: number; keyword: string }[];
  if (triggers.length > 0) {
    const flagItem = db.prepare('UPDATE invoice_items SET needs_unit_review = 1 WHERE id = ?');
    const items = db.prepare('SELECT id, name FROM invoice_items WHERE invoice_id = ?').all(result) as { id: number; name: string }[];
    for (const item of items) {
      const nameLower = item.name.toLowerCase();
      if (triggers.some(t => nameLower.includes(t.keyword.toLowerCase()))) {
        flagItem.run(item.id);
      }
    }
  }

  return {
    invoiceId: result,
    supplierName,
    imported: parseResult.items.length,
    parsingCategory,
    status,
    errors: parseResult.errors,
  };
}

// POST /api/projects/:id/invoices — upload and parse invoice (PDF/Excel)
router.post('/api/projects/:id/invoices', uploadLimiter, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const result = await processInvoiceFile(req.file, projectId, db);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.invoiceId);
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(result.invoiceId);

    res.status(201).json({
      invoice,
      imported: result.imported,
      errors: result.errors,
      items,
      needsMapping: result.status === 'needs_mapping',
      parsingCategory: result.parsingCategory,
    });
  } catch (error) {
    console.error('POST /api/projects/:id/invoices error:', error);
    res.status(500).json({
      error: 'Ошибка при импорте счёта',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/projects/:id/invoices/bulk — bulk upload invoices
router.post('/api/projects/:id/invoices/bulk', uploadLimiter, upload.array('files', 20), async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Файлы не загружены' });
    }

    const results: {
      fileName: string;
      invoiceId: number | null;
      supplierName: string | null;
      imported: number;
      parsingCategory: string | null;
      status: string;
      error?: string;
    }[] = [];

    const BULK_CONCURRENCY = 3;
    for (let i = 0; i < files.length; i += BULK_CONCURRENCY) {
      const chunk = files.slice(i, i + BULK_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(file => processInvoiceFile(file, projectId, db)),
      );
      settled.forEach((out, idx) => {
        const file = chunk[idx]!;
        const fileName = fixFilename(file.originalname);
        if (out.status === 'fulfilled') {
          const result = out.value;
          results.push({
            fileName,
            invoiceId: result.invoiceId,
            supplierName: result.supplierName,
            imported: result.imported,
            parsingCategory: result.parsingCategory,
            status: result.status === 'needs_mapping' ? 'needs_mapping' : 'ok',
          });
        } else {
          const err = out.reason;
          results.push({
            fileName,
            invoiceId: null,
            supplierName: null,
            imported: 0,
            parsingCategory: null,
            status: 'error',
            error: err instanceof Error ? err.message : 'Неизвестная ошибка',
          });
        }
      });
    }

    const summary = {
      total: files.length,
      ok: results.filter(r => r.status === 'ok').length,
      needsMapping: results.filter(r => r.status === 'needs_mapping').length,
      errors: results.filter(r => r.status === 'error').length,
      totalImported: results.reduce((s, r) => s + r.imported, 0),
    };

    res.json({ results, summary });
  } catch (error) {
    console.error('POST /api/projects/:id/invoices/bulk error:', error);
    res.status(500).json({
      error: 'Ошибка при массовой загрузке счетов',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/invoices/:id/preview — preview raw rows + detected/saved mapping
router.get('/api/invoices/:id/preview', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id, parsing_category, parsing_category_reason FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null; parsing_category: string | null; parsing_category_reason: string | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }
    assertUploadPath(invoice.file_path);

    const ext = path.extname(invoice.file_name).toLowerCase();
    let rows: string[][];
    let fullText: string | null = null;

    if (ext === '.pdf') {
      const result = await extractRawRows(invoice.file_path);
      rows = result.rows;
      fullText = result.fullText;
    } else {
      rows = extractExcelRawRows(invoice.file_path);
    }

    // Auto-detect column mapping
    const detected = detectColumns(rows);
    const detectedMapping = detected ? {
      ...detected.mapping,
      headerRow: detected.headerRowIndex,
    } : null;

    // Check for saved supplier config
    let supplierConfig: SavedMapping | null = null;
    if (invoice.supplier_id) {
      const saved = loadSavedMapping(invoice.supplier_id);
      if (saved) supplierConfig = saved;
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    const response: Record<string, any> = {
      rows,
      totalRows: rows.length,
      detectedMapping,
      supplierConfig,
      parsingCategory: invoice.parsing_category,
      parsingCategoryReason: invoice.parsing_category_reason,
    };

    // For Category B: include fullText for raw text display
    if (invoice.parsing_category === 'B' && fullText !== null) {
      response.fullText = fullText;
    }

    res.json(response);
  } catch (error) {
    console.error('GET /api/invoices/:id/preview error:', error);
    res.status(500).json({
      error: 'Ошибка при предпросмотре счёта',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/invoices/:id/preview-excel — Excel preview with sheet selection
router.get('/api/invoices/:id/preview-excel', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    const ext = path.extname(invoice.file_name).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      return res.status(400).json({ error: 'Файл не является Excel' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл не найден на диске' });
    }
    assertUploadPath(invoice.file_path);

    const sheetIndex = parseInt(String(req.query.sheet || '0'), 10);
    const maxRows = parseInt(String(req.query.maxRows || '200'), 10);

    const { rows: rawRows, sheetNames, totalRows } = extractExcelPreviewData(invoice.file_path, sheetIndex, maxRows);

    const colCount = Math.max(...rawRows.map(r => r.length), 0);

    // Первый проход: определяем строку-заголовок на всех данных
    const allCols = Array.from({ length: colCount }, (_, i) => i);
    const rawAllRows = rawRows.map(row => allCols.map(ci => row[ci] ?? ''));
    const preDetected = detectColumns(rawAllRows);
    const dataStartRow = preDetected?.headerRowIndex ?? 0;

    // Фильтруем колонки: непустые начиная со строки-заголовка (игнорируем шапку с реквизитами)
    const dataArea = rawRows.slice(dataStartRow);
    const nonEmptyCols = allCols.filter(ci =>
      dataArea.some(row => String(row[ci] ?? '').trim() !== '')
    );

    // Применяем фильтр ко всем строкам
    const rows = rawRows.map(row => nonEmptyCols.map(ci => row[ci] ?? ''));

    const detected = detectColumns(rows);
    const detectedMapping = detected ? {
      ...detected.mapping,
      headerRow: detected.headerRowIndex,
    } : null;

    let supplierConfig: SavedMapping | null = null;
    if (invoice.supplier_id) {
      const saved = loadSavedMapping(invoice.supplier_id);
      if (saved) supplierConfig = saved;
    }

    const detectedHeaderRow = detected?.headerRowIndex ?? 0;
    const columns = rows[detectedHeaderRow] || [];

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    res.json({
      rows,
      totalRows,
      meta: { sheetNames, detectedHeaderRow, totalRows },
      columns,
      detectedMapping,
      supplierConfig,
    });
  } catch (error) {
    console.error('GET /api/invoices/:id/preview-excel error:', error);
    res.status(500).json({
      error: 'Ошибка предпросмотра Excel',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/invoices — list invoices for project
router.get('/api/projects/:id/invoices', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const invoices = db.prepare(`
      SELECT i.id, i.project_id, i.supplier_id, i.invoice_number, i.invoice_date,
             i.file_name, i.total_amount, i.vat_amount, i.status, i.created_at,
             i.parsing_category, i.parsing_category_reason, i.needs_amount_review,
             s.name as supplier_name, s.vat_rate, s.prices_include_vat,
             (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
      FROM invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.project_id = ?
      ORDER BY i.created_at DESC
    `).all(projectId);

    res.json({ invoices, total: invoices.length });
  } catch (error) {
    console.error('GET /api/projects/:id/invoices error:', error);
    res.status(500).json({ error: 'Ошибка при получении счетов' });
  }
});

// GET /api/invoices/:id — single invoice with items
router.get('/api/invoices/:id', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(`
      SELECT i.*, s.name as supplier_name, s.vat_rate as supplier_vat_rate, s.prices_include_vat as supplier_prices_include_vat
      FROM invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.id = ?
    `).get(invoiceId);

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    const rawItems = db.prepare(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index'
    ).all(invoiceId);
    const inv = invoice as any;
    const vatRate = typeof inv.supplier_vat_rate === 'number'
      ? inv.supplier_vat_rate
      : (typeof inv.vat_rate === 'number' ? inv.vat_rate : null);
    const pricesIncludeVat = typeof inv.supplier_prices_include_vat === 'number' ? inv.supplier_prices_include_vat : null;
    const items = (rawItems as Array<any>).map(item => {
      const pricing = computeUnitPriceWithVat(item.price ?? null, item.amount ?? null, item.quantity ?? null, vatRate, pricesIncludeVat);
      return {
        ...item,
        unit_price_with_vat: pricing.unitPriceWithVat,
        unit_price_source: pricing.source,
      };
    });

    // Load saved price formula for this supplier
    let priceCalcFormula: { numerator: string; denominator: string } | null = null;
    if (inv.supplier_id) {
      const cfg = db.prepare('SELECT config FROM supplier_parser_configs WHERE supplier_id = ?').get(inv.supplier_id) as { config: string } | undefined;
      if (cfg) {
        const parsed = parseJsonSafe<Record<string, any>>(
          cfg.config,
          {},
          'GET /api/invoices/:id supplier_parser_configs'
        );
        if (parsed.price_calc_formula) priceCalcFormula = parsed.price_calc_formula;
      }
    }

    res.json({ invoice, items, priceCalcFormula });
  } catch (error) {
    console.error('GET /api/invoices/:id error:', error);
    res.status(500).json({ error: 'Ошибка при получении счёта' });
  }
});

// DELETE /api/invoices/:id — delete invoice + items + file
router.delete('/api/invoices/:id', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare('SELECT id, file_path FROM invoices WHERE id = ?').get(invoiceId) as { id: number; file_path: string | null } | undefined;
    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    // Delete from DB (cascade deletes invoice_items)
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);

    // Delete file from disk
    if (invoice.file_path) {
      if (path.resolve(invoice.file_path).startsWith(UPLOAD_DIR)) {
        safeUnlink(invoice.file_path);
      } else {
        console.warn('invalid_file_path_on_delete', { file_path: invoice.file_path });
      }
    }

    res.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /api/invoices/:id error:', error);
    res.status(500).json({ error: 'Ошибка при удалении счёта' });
  }
});

// POST /api/invoices/:id/ensure-supplier — auto-create supplier if missing
router.post('/api/invoices/:id/ensure-supplier', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, supplier_id, file_name FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; supplier_id: number | null; file_name: string } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    // Already has supplier
    if (invoice.supplier_id) {
      const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { id: number; name: string };
      return res.json({ supplier_id: supplier.id, supplier_name: supplier.name });
    }

    // Extract name from filename
    const baseName = path.basename(invoice.file_name, path.extname(invoice.file_name));
    const firstWordMatch = baseName.match(/^[+\s]*([A-Za-zА-Яа-яёЁ]{3,})/);
    const supplierName = firstWordMatch ? firstWordMatch[1] : 'Неизвестный поставщик';

    // Find or create supplier
    const existing = db.prepare('SELECT id, name FROM suppliers WHERE name = ?').get(supplierName) as { id: number; name: string } | undefined;
    let supplierId: number;
    let finalName: string;

    if (existing) {
      supplierId = existing.id;
      finalName = existing.name;
    } else {
      const result = db.prepare('INSERT INTO suppliers (name, vat_rate) VALUES (?, 22)').run(supplierName);
      supplierId = Number(result.lastInsertRowid);
      finalName = supplierName;
    }

    // Link supplier to invoice
    db.prepare('UPDATE invoices SET supplier_id = ? WHERE id = ?').run(supplierId, invoiceId);

    res.json({ supplier_id: supplierId, supplier_name: finalName });
  } catch (error) {
    console.error('POST /api/invoices/:id/ensure-supplier error:', error);
    res.status(500).json({ error: 'Ошибка при создании поставщика' });
  }
});

// POST /api/invoices/:id/reparse — re-parse invoice with mapping (from body or saved config)
router.post('/api/invoices/:id/reparse', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id, vat_rate FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null; vat_rate: number | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }
    assertUploadPath(invoice.file_path);

    // Priority: mapping from request body > saved supplier config
    let savedMapping: SavedMapping | undefined;
    if (req.body && req.body.mapping && typeof req.body.mapping.headerRow === 'number') {
      savedMapping = req.body.mapping as SavedMapping;
    } else if (invoice.supplier_id) {
      savedMapping = loadSavedMapping(invoice.supplier_id);
    }

    if (!savedMapping) {
      return res.status(400).json({ error: 'Нет настроек колонок — сохраните mapping или укажите в запросе' });
    }

    const baseItemsSnapshot = invoiceItemsSnapshotJson(invoiceId, db);

    const ext = path.extname(invoice.file_name).toLowerCase();
    const source = ext === '.pdf' ? 'pdf' : 'excel';
    let supplierName: string | null = null;
    let supplierVatRate: number | null = null;
    let supplierPricesIncludeVat: number | null = null;
    if (invoice.supplier_id) {
      const supplierRow = db.prepare('SELECT name, vat_rate, prices_include_vat FROM suppliers WHERE id = ?')
        .get(invoice.supplier_id) as { name: string; vat_rate: number | null; prices_include_vat: number | null } | undefined;
      supplierName = supplierRow?.name ?? null;
      supplierVatRate = supplierRow?.vat_rate ?? null;
      supplierPricesIncludeVat = supplierRow?.prices_include_vat ?? null;
    }
    const parserOverrides = loadSupplierParserOverrides(invoice.supplier_id, savedMapping);
    logSupplierParserOverrides(source, invoice.supplier_id, parserOverrides);

    let reparseExcelResult: ExcelParseResult | null = null;
    let parseResult = ext === '.pdf'
      ? await parsePdfFile(invoice.file_path, savedMapping)
      : (() => { reparseExcelResult = parseExcelInvoice(invoice.file_path, savedMapping); return excelToLegacy(reparseExcelResult); })();
    let priceOverrideApplied = false;
    let priceOverrideNeedsAmountReview = false;
    let priceOverrideReasonParts: string[] = [];
    let priceOverrideVatAmount: number | null = null;
    let priceOverrideVatRate: number | null = null;

    if (parserOverrides?.prices_source === 'gigachat' && parseResult.items.length > 0) {
      const supplierCtx = buildSupplierContext(supplierName, savedMapping);
      const priceOverride = await applyParserPriceOverrides(
        invoice.file_path,
        parseResult,
        parserOverrides,
        source,
        supplierCtx,
        supplierPricesIncludeVat,
        supplierVatRate ?? invoice.vat_rate,
      );
      parseResult = priceOverride.parseResult;
      priceOverrideApplied = priceOverride.applied;
      priceOverrideNeedsAmountReview = priceOverride.needsAmountReview;
      priceOverrideReasonParts = priceOverride.reasonParts;
      priceOverrideVatAmount = priceOverride.metadata?.vatAmount ?? null;
      priceOverrideVatRate = priceOverride.vatRate ?? null;
      if (priceOverride.mergedRows > 0) reparseExcelResult = null;
    }

    // Replace items in transaction
    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    db.transaction(() => {
      if (invoiceItemsSnapshotJson(invoiceId, db) !== baseItemsSnapshot) {
        throw Object.assign(new Error('invoice_items_changed_during_reparse'), { status: 409 });
      }
      saveSnapshot(invoiceId, 'before_reparse', db);
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      for (const item of parseResult.items) {
        insertItem.run(invoiceId, item.article, item.name, item.unit, item.quantity, item.quantity_packages ?? null, item.price, item.amount, item.row_index, isDeliveryItem(item.name) ? 1 : 0);
      }
      const newStatus = parseResult.items.length > 0 ? 'verified' : 'needs_mapping';
      const newCategory = reparseExcelResult ? reparseExcelResult.category
        : (parseResult.items.length > 0 ? 'A' : 'B');
      const newCategoryReason = reparseExcelResult
        ? `Проверено оператором, Excel confidence: ${reparseExcelResult.confidence.overall}%`
        : (parseResult.items.length > 0 ? `Проверено оператором: ${parseResult.items.length} позиций` : 'Колонки не распознаны после пересборки');
      const finalCategoryReason = priceOverrideReasonParts.length > 0
        ? `${newCategoryReason} | ${priceOverrideReasonParts.join('; ')}`
        : newCategoryReason;
      const reviewVatRate = priceOverrideVatRate ?? supplierVatRate ?? invoice.vat_rate;
      let newNeedsAmountReview = computeNeedsAmountReview(parseResult.items, parseResult.totalAmount ?? null, reviewVatRate, supplierPricesIncludeVat);
      if (priceOverrideNeedsAmountReview) newNeedsAmountReview = 1;
      // FIX 4: reparse rewrites items, so any previously applied Form D discount is gone —
      // reset discount_applied so the operator can re-apply if still relevant.
      db.prepare(`
        UPDATE invoices
        SET status = ?,
            total_amount = ?,
            parsing_category = ?,
            parsing_category_reason = ?,
            needs_amount_review = CASE WHEN ? THEN ? ELSE needs_amount_review END,
            vat_amount = CASE WHEN ? THEN ? ELSE vat_amount END,
            vat_rate = CASE WHEN ? THEN ? ELSE vat_rate END,
            discount_applied = 0
        WHERE id = ?
      `).run(
        newStatus,
        parseResult.totalAmount,
        newCategory,
        finalCategoryReason,
        priceOverrideApplied ? 1 : 0,
        newNeedsAmountReview,
        priceOverrideVatAmount != null ? 1 : 0,
        priceOverrideVatAmount,
        priceOverrideVatRate != null ? 1 : 0,
        priceOverrideVatRate,
        invoiceId,
      );
    })();

    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index').all(invoiceId);

    res.json({
      imported: parseResult.items.length,
      errors: parseResult.errors,
      items,
      status: parseResult.items.length > 0 ? 'verified' : 'needs_mapping',
    });
  } catch (error) {
    console.error('POST /api/invoices/:id/reparse error:', error);
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : 500;
    res.status(status).json({
      error: status === 409
        ? 'Строки счёта изменились во время перепарсинга, повторите reparse'
        : 'Ошибка при повторном парсинге',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/invoices/:id/reparse-gigachat — принудительный перепарсинг через GigaChat
router.post('/api/invoices/:id/reparse-gigachat', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id, vat_rate FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null; vat_rate: number | null } | undefined;

    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });
    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }
    assertUploadPath(invoice.file_path);
    if (!isGigaChatConfigured()) {
      return res.status(503).json({ error: 'GigaChat не настроен (нет GIGACHAT_AUTH_KEY)' });
    }

    const baseItemsSnapshot = invoiceItemsSnapshotJson(invoiceId, db);

    const ext = path.extname(invoice.file_name).toLowerCase();

    // Build supplier context from saved parser config
    let reparseSupplierCtx: string | undefined;
    let currentSupplierName: string | null = null;
    if (invoice.supplier_id) {
      const supplierRow = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { name: string } | undefined;
      currentSupplierName = supplierRow?.name ?? null;
      reparseSupplierCtx = buildSupplierContext(currentSupplierName, loadSavedMapping(invoice.supplier_id));
    }

    let gigaResult;
    if (ext === '.pdf' || ['.jpg', '.jpeg', '.png', '.tiff', '.bmp'].includes(ext)) {
      gigaResult = await parsePdfWithGigaChat(invoice.file_path, reparseSupplierCtx);
    } else {
      gigaResult = await parseExcelWithGigaChat(invoice.file_path, reparseSupplierCtx);
    }

    const meta  = gigaResult.metadata;

    // Fuzzy supplier match: если GigaChat нашёл поставщика — проверить по БД
    let resolvedSupplierName = meta.supplierName ?? currentSupplierName;
    if (meta.supplierName) {
      const allSuppliers = db.prepare('SELECT name FROM suppliers').all() as { name: string }[];
      if (allSuppliers.length > 0) {
        const match = stringSimilarity.findBestMatch(meta.supplierName, allSuppliers.map(s => s.name));
        if (match.bestMatch.rating >= 0.75) {
          console.log(`[GigaChat Reparse] Fuzzy supplier: "${meta.supplierName}" → "${match.bestMatch.target}" (${match.bestMatch.rating.toFixed(2)})`);
          resolvedSupplierName = match.bestMatch.target;
        }
      }
    }

    // Найти или создать поставщика по уточнённому имени
    let resolvedSupplierId: number | null = invoice.supplier_id;
    if (resolvedSupplierName) {
      const existingS = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(resolvedSupplierName) as { id: number } | undefined;
      resolvedSupplierId = existingS ? existingS.id : Number(db.prepare('INSERT INTO suppliers (name, vat_rate) VALUES (?, 22)').run(resolvedSupplierName).lastInsertRowid);
    }

    const reparseVatSettings = loadSupplierVatSettings(resolvedSupplierId);
    const effectiveReparseVatRate = meta.vat_rate ?? reparseVatSettings.vatRate ?? invoice.vat_rate ?? null;
    const vatNormalization = normalizeGigaChatRowsForSupplierVat(
      gigaResult.items,
      meta,
      reparseVatSettings.pricesIncludeVat,
      effectiveReparseVatRate,
    );
    const items = vatNormalization.items;
    const newStatus = items.length > 0 ? 'verified' : 'needs_mapping';
    let reparsedNeedsReview = computeNeedsAmountReview(items, meta.totalWithVat ?? null, effectiveReparseVatRate, reparseVatSettings.pricesIncludeVat);
    const pq = gigaResult.parseQuality;
    let reparseReason = `GigaChat reparse, позиций: ${items.length}`;
    if (pq?.warnings.length) {
      reparseReason += ` | ${pq.warnings.join('; ')}`;
    }
    if (vatNormalization.reasonParts.length) {
      reparseReason += ` | ${vatNormalization.reasonParts.join('; ')}`;
    }
    if (pq?.suggestElevatedReview) reparsedNeedsReview = 1;
    if (vatNormalization.needsAmountReview) reparsedNeedsReview = 1;

    db.transaction(() => {
      if (invoiceItemsSnapshotJson(invoiceId, db) !== baseItemsSnapshot) {
        throw Object.assign(new Error('invoice_items_changed_during_reparse'), { status: 409 });
      }
      saveSnapshot(invoiceId, 'before_reparse_gigachat', db);
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      // FIX 4: reparse-gigachat rewrites items; reset discount_applied so re-apply is possible
      db.prepare(
        'UPDATE invoices SET status=?, supplier_id=?, invoice_number=?, invoice_date=?, total_amount=?, vat_amount=?, vat_rate=?, parsing_category=?, parsing_category_reason=?, needs_amount_review=?, discount_applied=0 WHERE id=?'
      ).run(
        newStatus,
        resolvedSupplierId,
        meta.documentNumber,
        meta.documentDate,
        meta.totalWithVat,
        meta.vatAmount ?? null,
        effectiveReparseVatRate,
        items.length > 0 ? 'A' : 'B',
        reparseReason,
        reparsedNeedsReview,
        invoiceId,
      );
      const ins = db.prepare(
        'INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery) VALUES (?,?,?,?,?,?,?,?,?,?)'
      );
      items.forEach(it => ins.run(invoiceId, it.article, it.name, it.unit, it.quantity, it.quantity_packages ?? null, it.price, it.amount, it.row_index, isDeliveryItem(it.name) ? 1 : 0));
    })();

    console.log(`[GigaChat] Reparse invoice=${invoiceId}, items=${items.length}`);
    res.json({
      success: true,
      items: items.length,
      status: newStatus,
      metadata: meta,
      parseQuality: pq ?? null,
    });
  } catch (error) {
    console.error('POST /api/invoices/:id/reparse-gigachat error:', error instanceof Error ? error.message : String(error));
    const details = error instanceof Error ? error.message : 'Unknown error';
    if (typeof (error as { status?: unknown })?.status === 'number') {
      const status = (error as { status: number }).status;
      return res.status(status).json({
        error: status === 409
          ? 'Строки счёта изменились во время перепарсинга, повторите reparse'
          : 'Ошибка GigaChat reparse',
        details,
      });
    }
    // 502 — сбой внешнего GigaChat или отказ модели, не внутренняя логика БД
    res.status(502).json({ error: 'Ошибка GigaChat reparse', details });
  }
});

// POST /api/invoices/:id/request-excel — mark invoice as awaiting Excel replacement
router.post('/api/invoices/:id/request-excel', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, supplier_id FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; supplier_id: number | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run('awaiting_excel', invoiceId);

    // Get supplier email if available
    let supplierEmail: string | null = null;
    if (invoice.supplier_id) {
      const supplier = db.prepare('SELECT email FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { email: string | null } | undefined;
      supplierEmail = supplier?.email || null;
    }

    res.json({ status: 'awaiting_excel', supplierEmail });
  } catch (error) {
    console.error('POST /api/invoices/:id/request-excel error:', error);
    res.status(500).json({ error: 'Ошибка при запросе Excel' });
  }
});

// POST /api/invoices/:id/manual-items — manually enter invoice items
router.post('/api/invoices/:id/manual-items', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId) as { id: number } | undefined;
    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Не указаны позиции (items)' });
    }

    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, price, amount, row_index, is_manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
    );

    db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const amount = (item.quantity && item.price) ? item.quantity * item.price : (item.amount || null);
        insertItem.run(
          invoiceId,
          item.article || null,
          item.name,
          item.unit || null,
          item.quantity || null,
          item.price || null,
          amount,
          i,
        );
      }
      const totalAmount = items.reduce((sum: number, item: any) => {
        const amt = (item.quantity && item.price) ? item.quantity * item.price : (item.amount || 0);
        return sum + amt;
      }, 0);
      db.prepare('UPDATE invoices SET status = ?, parsing_category = ?, parsing_category_reason = ?, total_amount = ? WHERE id = ?')
        .run('parsed', 'A', `Введено вручную: ${items.length} позиций`, totalAmount || null, invoiceId);
    })();

    const savedItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index').all(invoiceId);

    res.json({ imported: items.length, items: savedItems });
  } catch (error) {
    console.error('POST /api/invoices/:id/manual-items error:', error);
    res.status(500).json({ error: 'Ошибка при сохранении позиций' });
  }
});

// POST /api/invoices/:id/skip — skip unreadable invoice
router.post('/api/invoices/:id/skip', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId) as { id: number } | undefined;
    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run('skipped', invoiceId);

    res.json({ status: 'skipped' });
  } catch (error) {
    console.error('POST /api/invoices/:id/skip error:', error);
    res.status(500).json({ error: 'Ошибка при пропуске счёта' });
  }
});

// POST /api/invoices/:id/preview-split — preview text split with a separator method (no save)
router.post('/api/invoices/:id/preview-split', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }
    assertUploadPath(invoice.file_path);

    const { separatorMethod, separatorValue } = req.body;
    if (!separatorMethod) {
      return res.status(400).json({ error: 'Не указан метод разделения (separatorMethod)' });
    }

    const ext = path.extname(invoice.file_name).toLowerCase();
    let fullText: string;

    if (ext === '.pdf') {
      const result = await extractRawRows(invoice.file_path);
      fullText = result.fullText;
    } else {
      return res.status(400).json({ error: 'Разделение текста доступно только для PDF' });
    }

    const rows = splitTextWithSeparator(fullText, separatorMethod as SeparatorMethod, separatorValue);

    // Auto-detect columns on split result
    const detected = detectColumns(rows);
    const detectedMapping = detected ? {
      ...detected.mapping,
      headerRow: detected.headerRowIndex,
    } : null;

    res.json({ rows, totalRows: rows.length, detectedMapping });
  } catch (error) {
    console.error('POST /api/invoices/:id/preview-split error:', error);
    res.status(500).json({ error: 'Ошибка при предпросмотре разделения', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/invoices/:id/reparse-with-separator — apply separator + mapping, replace items
router.post('/api/invoices/:id/reparse-with-separator', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }
    assertUploadPath(invoice.file_path);

    const { separatorMethod, separatorValue, mapping } = req.body;
    if (!separatorMethod || !mapping || typeof mapping.headerRow !== 'number') {
      return res.status(400).json({ error: 'Не указаны separatorMethod и/или mapping с headerRow' });
    }

    // Save snapshot before overwriting items
    saveSnapshot(invoiceId, 'before_reparse_with_separator', db);

    const ext = path.extname(invoice.file_name).toLowerCase();
    if (ext !== '.pdf') {
      return res.status(400).json({ error: 'Разделение текста доступно только для PDF' });
    }

    const rawResult = await extractRawRows(invoice.file_path);
    const rows = splitTextWithSeparator(rawResult.fullText, separatorMethod as SeparatorMethod, separatorValue);

    const colMapping = {
      article: mapping.article ?? null,
      name: mapping.name ?? null,
      unit: mapping.unit ?? null,
      quantity: mapping.quantity ?? null,
      quantity_packages: mapping.quantity_packages ?? null,
      price: mapping.price ?? null,
      amount: mapping.amount ?? null,
    };

    const parseResult = parseTableData(rows, colMapping, mapping.headerRow + 1);

    // Compute total
    let totalAmount: number | null = null;
    if (parseResult.items.length > 0) {
      const sum = parseResult.items.reduce((acc, item) => acc + (item.amount || 0), 0);
      if (sum > 0) totalAmount = sum;
    }

    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      for (const item of parseResult.items) {
        insertItem.run(invoiceId, item.article, item.name, item.unit, item.quantity, item.quantity_packages ?? null, item.price, item.amount, item.row_index, isDeliveryItem(item.name) ? 1 : 0);
      }
      const newStatus = parseResult.items.length > 0 ? 'verified' : 'needs_mapping';
      const newCategory = parseResult.items.length > 0 ? 'A' : 'B';
      const newCategoryReason = parseResult.items.length > 0
        ? `Проверено оператором: ${parseResult.items.length} позиций`
        : 'Колонки не распознаны после разделения';
      db.prepare('UPDATE invoices SET status = ?, total_amount = ?, parsing_category = ?, parsing_category_reason = ? WHERE id = ?')
        .run(newStatus, totalAmount, newCategory, newCategoryReason, invoiceId);
    })();

    // Optionally save separator config for supplier
    if (invoice.supplier_id && parseResult.items.length > 0) {
      const existingConfig = loadSupplierParserConfig(db, invoice.supplier_id);
      const fullConfig = preserveParserOverrides(
        { ...colMapping, headerRow: mapping.headerRow, separatorMethod, separatorValue },
        existingConfig,
      );
      db.prepare(`
        INSERT INTO supplier_parser_configs (supplier_id, config) VALUES (?, ?)
        ON CONFLICT(supplier_id) DO UPDATE SET config = excluded.config, updated_at = CURRENT_TIMESTAMP
      `).run(invoice.supplier_id, JSON.stringify(fullConfig));
    }

    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index').all(invoiceId);

    res.json({
      imported: parseResult.items.length,
      errors: parseResult.errors,
      items,
      status: parseResult.items.length > 0 ? 'verified' : 'needs_mapping',
    });
  } catch (error) {
    console.error('POST /api/invoices/:id/reparse-with-separator error:', error);
    res.status(500).json({ error: 'Ошибка при пересборке с разделителем', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/projects/:id/delivery-total — sum of all delivery rows across project invoices
router.get('/api/projects/:id/delivery-total', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const row = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN s.prices_include_vat = 0 AND COALESCE(s.vat_rate, i.vat_rate) > 0
            THEN COALESCE(ii.amount, COALESCE(ii.price, 0) * COALESCE(ii.quantity, 0), 0) * (1 + COALESCE(s.vat_rate, i.vat_rate) / 100.0)
          ELSE COALESCE(ii.amount, COALESCE(ii.price, 0) * COALESCE(ii.quantity, 0), 0)
        END
      ), 0) as total
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.project_id = ? AND ii.is_delivery = 1
    `).get(projectId) as { total: number };
    res.json({ total: row.total });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении суммы доставки', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/invoices/:id/status — update invoice status (e.g. mark as verified)
router.put('/api/invoices/:id/status', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const { status } = req.body as { status: string };

    const allowed = ['pending', 'parsed', 'needs_mapping', 'verified', 'skipped', 'awaiting_excel'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `Недопустимый статус. Допустимые: ${allowed.join(', ')}` });
    }

    const db = getDatabase();
    const invoice = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });

    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);
    res.json({ updated: true, status });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обновлении статуса', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/invoices/:id/apply-discount { discount_percent } — recalculate prices
router.post('/api/invoices/:id/apply-discount', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const { discount_percent } = req.body as { discount_percent: number };

    if (typeof discount_percent !== 'number' || discount_percent <= 0 || discount_percent >= 100) {
      return res.status(400).json({ error: 'discount_percent должен быть числом от 0 до 100' });
    }

    const db = getDatabase();
    const invoice = db.prepare('SELECT id, discount_applied FROM invoices WHERE id = ?').get(invoiceId) as { id: number; discount_applied: number } | undefined;
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });
    if (invoice.discount_applied) return res.status(409).json({ error: 'Скидка уже применена' });

    const factor = 1 - discount_percent / 100;

    db.transaction(() => {
      db.prepare(`
        UPDATE invoice_items
        SET price = ROUND(price * ?, 2), amount = ROUND(amount * ?, 2)
        WHERE invoice_id = ?
      `).run(factor, factor, invoiceId);

      db.prepare(`
        UPDATE invoices SET discount_applied = 1 WHERE id = ?
      `).run(invoiceId);
    })();

    res.json({ applied: true, discount_percent });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при применении скидки', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/invoices/:id/apply-document-discount
// Form D backfill for already-loaded invoices: detects and applies document-level discount
// (total << sum of line amounts) without re-parsing. Idempotent: noop if discount_applied=1.
// Returns { applied: bool, factor: number, discount_pct: number } or { skipped: reason }.
// FIX 2: refuses 422 when Form C (discount_detected) was already handled (prevents double-discount).
// FIX 3: only goods lines participate; delivery lines are untouched.
router.post('/api/invoices/:id/apply-document-discount', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    // FIX 2: also fetch discount_detected and supplier_id (for VAT-awareness in FIX 1)
    const invoice = db.prepare(
      'SELECT id, discount_applied, discount_detected, total_amount, supplier_id, vat_rate FROM invoices WHERE id = ?'
    ).get(invoiceId) as {
      id: number;
      discount_applied: number;
      discount_detected: number | null;
      total_amount: number | null;
      supplier_id: number | null;
      vat_rate: number | null;
    } | undefined;
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });

    // Idempotency guard
    if (invoice.discount_applied) {
      return res.json({ skipped: 'discount_applied already set — idempotent noop', applied: false });
    }

    // FIX 2: Form C guard — explicit "скидка X%" was already detected; applying Form D now
    // would discount prices that may already reflect the Form C reduction (double-discount).
    if (invoice.discount_detected != null && invoice.discount_detected > 0) {
      return res.status(422).json({
        skipped: `Счёт уже содержит явную скидку ${invoice.discount_detected}% (Form C); применение документной скидки Form D приведёт к двойному дисконту — отменено`,
        applied: false,
      });
    }

    // FIX 1: load supplier VAT settings so detectDocumentLevelDiscount can normalise correctly
    const vatSettings = loadSupplierVatSettings(invoice.supplier_id);
    const effectiveVatRate = vatSettings.vatRate ?? invoice.vat_rate ?? null;
    const effectivePricesIncludeVat = vatSettings.pricesIncludeVat ?? null;

    // FIX 3: fetch is_delivery so the helper can exclude delivery lines from factor computation
    const items = db.prepare(
      'SELECT id, price, amount, is_delivery FROM invoice_items WHERE invoice_id = ?'
    ).all(invoiceId) as Array<{ id: number; price: number | null; amount: number | null; is_delivery: number | null }>;

    // FIX 1 + FIX 3: pass VAT settings and is_delivery-aware items
    const factor = detectDocumentLevelDiscount(items, invoice.total_amount, effectiveVatRate, effectivePricesIncludeVat);
    if (factor == null) {
      return res.status(422).json({ skipped: 'No clean document-level discount detected (ambiguous, per-line, or surcharge)', applied: false });
    }

    saveSnapshot(invoiceId, 'before_formd_discount', db);

    db.transaction(() => {
      // FIX 3: only update goods lines (exclude delivery lines; their prices stay unchanged)
      db.prepare(`
        UPDATE invoice_items
        SET original_price = COALESCE(original_price, price),
            price = ROUND(price * ?, 2),
            amount = ROUND(amount * ?, 2)
        WHERE invoice_id = ? AND (is_delivery = 0 OR is_delivery IS NULL)
      `).run(factor, factor, invoiceId);

      db.prepare(`
        UPDATE invoices SET discount_applied = 1 WHERE id = ?
      `).run(invoiceId);
    })();

    const discountPct = Math.round((1 - factor) * 10000) / 100;
    console.log(`[Invoice] apply-document-discount id=${invoiceId}: factor=${factor.toFixed(4)} (${discountPct}% off)`);
    return res.json({ applied: true, factor, discount_pct: discountPct });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при применении документальной скидки', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/invoices/:id/history
router.get('/api/invoices/:id/history', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const history = db.prepare(`
      SELECT id, version, action, created_at,
             json_array_length(items_snapshot) as item_count
      FROM invoice_items_history
      WHERE invoice_id = ?
      ORDER BY version DESC
    `).all(invoiceId);
    res.json({ history });
  } catch (error) {
    console.error('GET /api/invoices/:id/history error:', error);
    res.status(500).json({ error: 'Ошибка при получении истории' });
  }
});

// POST /api/invoices/:id/rollback
router.post('/api/invoices/:id/rollback', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const { version } = req.body as { version: number };
    const db = getDatabase();
    const snap = db.prepare('SELECT items_snapshot FROM invoice_items_history WHERE invoice_id = ? AND version = ?').get(invoiceId, version) as { items_snapshot: string } | undefined;
    if (!snap) return res.status(404).json({ error: 'Версия не найдена' });
    const items = JSON.parse(snap.items_snapshot) as any[];
    saveSnapshot(invoiceId, `rollback_to_v${version}`, db);
    db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      const ins = db.prepare(`INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery, is_manual, needs_unit_review, original_price, original_unit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of items) {
        ins.run(invoiceId, item.article, item.name, item.unit, item.quantity, item.quantity_packages ?? null, item.price, item.amount, item.row_index, item.is_delivery ?? 0, item.is_manual ?? 0, item.needs_unit_review ?? 0, item.original_price ?? null, item.original_unit ?? null);
      }
      // FIX 4: rollback rewrites items to a past snapshot; reset discount_applied so
      // Form D can be re-applied if still relevant after the rollback.
      db.prepare('UPDATE invoices SET discount_applied = 0 WHERE id = ?').run(invoiceId);
    })();
    res.json({ restored: items.length });
  } catch (error) {
    console.error('POST /api/invoices/:id/rollback error:', error);
    res.status(500).json({ error: 'Ошибка при откате', details: error instanceof Error ? error.message : 'Unknown' });
  }
});

// POST /api/invoices/:id/calculate-prices
router.post('/api/invoices/:id/calculate-prices', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const invoice = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });
    saveSnapshot(invoiceId, 'calculate_prices', db);
    const result = db.prepare(`
      UPDATE invoice_items SET price = amount / quantity
      WHERE invoice_id = ? AND price IS NULL AND amount IS NOT NULL AND quantity IS NOT NULL AND quantity > 0
    `).run(invoiceId);
    res.json({ updated: result.changes });
  } catch (error) {
    console.error('POST /api/invoices/:id/calculate-prices error:', error);
    res.status(500).json({ error: 'Ошибка при расчёте цен' });
  }
});

// POST /api/invoices/:id/calculate-price-formula — recalculate price using operator-chosen columns
router.post('/api/invoices/:id/calculate-price-formula', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const invoice = db.prepare('SELECT id, supplier_id FROM invoices WHERE id = ?').get(invoiceId) as { id: number; supplier_id: number | null } | undefined;
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });

    const { numerator, denominator, saveForSupplier = false } = req.body as {
      numerator: string; denominator: string; saveForSupplier?: boolean;
    };

    const PRICE_COLS: Record<string, string> = {
      amount: 'amount',
      quantity: 'quantity',
      quantity_packages: 'quantity_packages',
      price: 'price',
    };
    const numCol = PRICE_COLS[numerator];
    const denCol = PRICE_COLS[denominator];
    if (!numCol || !denCol) {
      return res.status(400).json({ error: 'Недопустимые колонки для расчёта' });
    }
    if (numCol === denCol) {
      return res.status(400).json({ error: 'Числитель и делитель должны быть разными' });
    }

    saveSnapshot(invoiceId, `calculate_price_formula_${numCol}_div_${denCol}`, db);

    const result = db.prepare(`
      UPDATE invoice_items SET price = ${numCol} / ${denCol}
      WHERE invoice_id = ? AND ${numCol} IS NOT NULL AND ${denCol} IS NOT NULL AND ${denCol} > 0
    `).run(invoiceId);

    // Save formula to supplier config
    if (saveForSupplier && invoice.supplier_id) {
      const existing = db.prepare('SELECT config FROM supplier_parser_configs WHERE supplier_id = ?').get(invoice.supplier_id) as { config: string } | undefined;
      const config = existing
        ? parseJsonSafe<Record<string, any>>(
          existing.config,
          {},
          'POST /api/invoices/:id/calculate-price-formula supplier_parser_configs'
        )
        : {};
      config.price_calc_formula = { numerator, denominator };
      db.prepare('INSERT INTO supplier_parser_configs (supplier_id, config) VALUES (?, ?) ON CONFLICT(supplier_id) DO UPDATE SET config = excluded.config')
        .run(invoice.supplier_id, JSON.stringify(config));
    }

    res.json({ updated: result.changes, numerator, denominator });
  } catch (error) {
    console.error('POST /api/invoices/:id/calculate-price-formula error:', error);
    res.status(500).json({ error: 'Ошибка при расчёте цены' });
  }
});

// GET /api/invoices/:id/unit-review-items — items flagged for unit review
router.get('/api/invoices/:id/unit-review-items', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const items = db.prepare(`
      SELECT id, name, unit, price, amount, quantity, original_price, original_unit, needs_unit_review
      FROM invoice_items
      WHERE invoice_id = ? AND needs_unit_review = 1
      ORDER BY row_index
    `).all(invoiceId);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении позиций', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/invoice-items/:id/apply-unit-conversion { new_unit, factor }
router.put('/api/invoice-items/:id/apply-unit-conversion', (req: Request, res: Response) => {
  try {
    const itemId = parseInt(String(req.params.id), 10);
    const { new_unit, factor } = req.body as { new_unit: string; factor: number };

    if (!new_unit || typeof factor !== 'number' || factor <= 0) {
      return res.status(400).json({ error: 'new_unit и factor (> 0) обязательны' });
    }

    const db = getDatabase();
    const item = db.prepare('SELECT id, price, unit FROM invoice_items WHERE id = ?').get(itemId) as { id: number; price: number | null; unit: string | null } | undefined;
    if (!item) return res.status(404).json({ error: 'Позиция не найдена' });

    db.prepare(`
      UPDATE invoice_items
      SET original_price = ?,
          original_unit  = ?,
          price          = ROUND(? / ?, 4),
          unit           = ?,
          needs_unit_review = 0
      WHERE id = ?
    `).run(item.price, item.unit, item.price ?? 0, factor, new_unit, itemId);

    const updated = db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(itemId);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при конвертации единицы', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/invoices/:id/apply-net-price-mode
// Режим: цена без скидки, сумма со скидкой
// Пересчитывает цены: price = price * (1 - discount/100) для всех позиций
router.post('/api/invoices/:id/apply-net-price-mode', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const { discount_percent } = req.body as { discount_percent: number };
    const db = getDatabase();
    const invoice = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });
    if (!discount_percent || discount_percent <= 0 || discount_percent >= 100) {
      return res.status(400).json({ error: 'Укажите корректный процент скидки (1-99)' });
    }
    saveSnapshot(invoiceId, `net_price_mode_${discount_percent}pct`, db);
    const factor = 1 - discount_percent / 100;
    const result = db.prepare(`
      UPDATE invoice_items
      SET original_price = COALESCE(original_price, price),
          price = ROUND(price * ?, 4)
      WHERE invoice_id = ? AND price IS NOT NULL
    `).run(factor, invoiceId);
    res.json({ updated: result.changes, factor });
  } catch (error) {
    console.error('POST /api/invoices/:id/apply-net-price-mode error:', error);
    res.status(500).json({ error: 'Ошибка при пересчёте цен' });
  }
});

export default router;
