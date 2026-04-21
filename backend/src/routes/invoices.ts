import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { safeUnlink } from '../utils/safeUnlink';
import { createUploadMiddleware, fixFilename, parseJsonSafe } from '../utils/fileUtils';
import { parsePdfFile, parsePdfFromExtracted, extractRawRows, detectColumns, SavedMapping, categorizeParsingResult, splitTextWithSeparator, parseTableData, SeparatorMethod, extractMetadata, detectDiscount } from '../services/pdfParser';
import { parseExcelInvoice, extractExcelRawRows, extractExcelPreviewData, excelToLegacy } from '../services/excelInvoiceParser';
import { routeInvoiceFile } from '../services/invoiceRouter';
import type { GigaChatParseQuality } from '../services/gigachatParseQuality';
import { parsePdfWithGigaChat, parseExcelWithGigaChat } from '../services/gigachatParser';
import { isGigaChatConfigured } from '../services/gigachatService';
import stringSimilarity from 'string-similarity';
import type { ExcelParseResult } from '../types/invoice';

const upload = createUploadMiddleware({
  allowedExtensions: ['.pdf', '.xlsx', '.xls', '.jpg', '.jpeg', '.png', '.tiff', '.bmp'],
  errorMessage: 'Допустимы только файлы .pdf, .xlsx, .xls, .jpg, .jpeg, .png, .tiff, .bmp',
  maxFileSizeBytes: 50 * 1024 * 1024,
});

const router = Router();

const DELIVERY_KEYWORDS = [
  'доставка', 'транспортные расходы', 'транспортные услуги',
  'транспортировка', 'доставка товара', 'грузоперевозк',
];

function isDeliveryItem(name: string): boolean {
  const lower = name.toLowerCase();
  return DELIVERY_KEYWORDS.some(kw => lower.includes(kw));
}

// Helper: compute needs_amount_review flag
// Returns 1 if Σ(price×quantity) diverges from totalWithVat by more than 15%
function computeNeedsAmountReview(
  items: Array<{ price: number | null; quantity: number | null }>,
  totalWithVat: number | null
): number {
  if (!totalWithVat || totalWithVat <= 0 || items.length === 0) return 0;
  const sumItems = items.reduce((acc, it) => {
    const p = it.price ?? 0;
    const q = it.quantity ?? 0;
    return acc + p * q;
  }, 0);
  if (sumItems === 0) return 0;
  const deviation = Math.abs(sumItems - totalWithVat) / totalWithVat;
  return deviation > 0.15 ? 1 : 0;
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

function saveSnapshot(invoiceId: number, action: string, db: ReturnType<typeof getDatabase>): void {
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
  const maxVerRow = db.prepare('SELECT MAX(version) as v FROM invoice_items_history WHERE invoice_id = ?').get(invoiceId) as { v: number | null } | undefined;
  const maxVer = maxVerRow?.v ?? 0;
  db.prepare('INSERT INTO invoice_items_history (invoice_id, version, items_snapshot, action) VALUES (?,?,?,?)')
    .run(invoiceId, maxVer + 1, JSON.stringify(items), action);
}

// Helper: process a single invoice file (parse, detect supplier, insert into DB)
async function processInvoiceFile(
  file: { originalname: string; path: string },
  projectId: number,
  db: ReturnType<typeof getDatabase>,
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
    const parseResult = routerResult.parseResult;
    const status = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';
    const fileName = fixFilename(file.originalname);
    const supplierNameImg = parseResult.supplierName;
    let supplierIdImg: number | null = null;
    if (supplierNameImg) {
      const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplierNameImg) as { id: number } | undefined;
      supplierIdImg = existing ? existing.id : Number(db.prepare('INSERT INTO suppliers (name, vat_rate) VALUES (?, 22)').run(supplierNameImg).lastInsertRowid);
    }
    let imgReason = `Image/GigaChat confidence=${routerResult.confidence}`;
    if (routerResult.gigachatParseQuality?.warnings.length) {
      imgReason += ` | ${routerResult.gigachatParseQuality.warnings.join('; ')}`;
    }
    let imgNeedsReview = computeNeedsAmountReview(parseResult.items, parseResult.totalAmount ?? null);
    if (routerResult.gigachatParseQuality?.suggestElevatedReview) imgNeedsReview = 1;
    const insertInvoiceImg = db.prepare(`INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, file_name, file_path, total_amount, vat_amount, status, parsing_category, parsing_category_reason, discount_detected, needs_amount_review, vat_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertItemImg = db.prepare(`INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const invoiceIdImg = db.transaction(() => {
      const r = insertInvoiceImg.run(projectId, supplierIdImg, parseResult.invoiceNumber, parseResult.invoiceDate, fileName, file.path, parseResult.totalAmount, parseResult.vatAmount ?? null, status, routerResult.category, imgReason, null, imgNeedsReview, 22);
      const iid = Number(r.lastInsertRowid);
      for (const item of parseResult.items) {
        insertItemImg.run(iid, item.article, item.name, item.unit, item.quantity, item.quantity_packages ?? null, item.price, item.amount, item.row_index, isDeliveryItem(item.name) ? 1 : 0);
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
    const rawExtraction = await extractRawRows(file.path);
    pdfRawRows = rawExtraction.rows;
    pdfFullText = rawExtraction.fullText;
    initialResult = parsePdfFromExtracted(pdfRawRows, pdfFullText);
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

  function isGigaChatOnlyMapping(m: SavedMapping): boolean {
    return !!m.gigachatLearned && !m.separatorMethod;
  }

  // Check for saved parser config and re-parse if available
  let parseResult = initialResult;
  if (supplierId) {
    const savedMapping = loadSavedMapping(supplierId);
    if (savedMapping && !isGigaChatOnlyMapping(savedMapping)) {
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
          parseResult = parsePdfFromExtracted(pdfRawRows, pdfFullText, savedMapping);
        }
      } else {
        lastExcelResult = parseExcelInvoice(file.path, savedMapping);
        parseResult = excelToLegacy(lastExcelResult);
      }
    }
  }

  // Быстрая оценка качества PDF для решения о fallback
  let quickPdfCategory: string | null = null;
  if (ext === '.pdf' && pdfRawRows && pdfFullText !== null && parseResult.items.length > 0) {
    const quickCat = categorizeParsingResult(parseResult, pdfRawRows, pdfFullText);
    quickPdfCategory = quickCat.category;
  }

  // GigaChat fallback: только если позиции не найдены ИЛИ документ нечитаем (C).
  // При категории B с найденными позициями классический парсер оставляем — он точнее.
  const needsGigaChat = parseResult.items.length === 0 ||
    (ext === '.pdf' && quickPdfCategory === 'C') ||
    (lastExcelResult !== null && lastExcelResult.category === 'C');

  let parsedVatRate: number = 22;
  let lastGigaParseQuality: GigaChatParseQuality | undefined;
  let gigachatFallbackSucceeded = false;

  if (needsGigaChat && isGigaChatConfigured()) {
    try {
      const supplierCtx = buildSupplierContext(supplierName, supplierId ? loadSavedMapping(supplierId) : undefined);
      let gigaResult;
      if (ext === '.pdf') {
        console.log(`[InvoiceRouter] PDF category=${quickPdfCategory}, items=${parseResult.items.length} — GigaChat fallback`);
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

        parseResult = {
          items: gigaResult.items,
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
        gigachatFallbackSucceeded = true;
        lastGigaParseQuality = gigaResult.parseQuality;
        parsedVatRate = gigaResult.metadata.vat_rate ?? 22;
        if (lastExcelResult) lastExcelResult = null; // сбрасываем чтобы категория считалась заново
      }
    } catch (err) {
      console.warn(`[InvoiceRouter] GigaChat fallback failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Categorize parsing result
  let parsingCategory: string;
  let parsingCategoryReason: string;

  if (ext === '.pdf' && pdfRawRows && pdfFullText !== null) {
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

  const status = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';
  const fileName = fixFilename(file.originalname);

  console.log(`Invoice parse: file=${fileName}, items=${parseResult.items.length}, status=${status}, errors=${parseResult.errors.length}`);

  // Insert invoice and items in a transaction
  let needsAmountReview = computeNeedsAmountReview(parseResult.items, parseResult.totalAmount ?? null);
  if (lastGigaParseQuality?.suggestElevatedReview) needsAmountReview = 1;

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, file_name, file_path, total_amount, vat_amount, status, parsing_category, parsing_category_reason, discount_detected, needs_amount_review, vat_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
    const invoiceId = Number(invoiceResult.lastInsertRowid);

    for (const item of parseResult.items) {
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
router.post('/api/projects/:id/invoices', upload.single('file'), async (req: Request, res: Response) => {
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
router.post('/api/projects/:id/invoices/bulk', upload.array('files', 100), async (req: Request, res: Response) => {
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
      SELECT i.*, s.name as supplier_name
      FROM invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.id = ?
    `).get(invoiceId);

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    const items = db.prepare(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index'
    ).all(invoiceId);

    // Load saved price formula for this supplier
    let priceCalcFormula: { numerator: string; denominator: string } | null = null;
    const inv = invoice as any;
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
      safeUnlink(invoice.file_path);
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
      'SELECT id, file_name, file_path, supplier_id FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }

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

    // Save snapshot before overwriting items
    saveSnapshot(invoiceId, 'before_reparse', db);

    const ext = path.extname(invoice.file_name).toLowerCase();
    let reparseExcelResult: ExcelParseResult | null = null;
    const parseResult = ext === '.pdf'
      ? await parsePdfFile(invoice.file_path, savedMapping)
      : (() => { reparseExcelResult = parseExcelInvoice(invoice.file_path, savedMapping); return excelToLegacy(reparseExcelResult); })();

    // Replace items in transaction
    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, quantity_packages, price, amount, row_index, is_delivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    db.transaction(() => {
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
      db.prepare('UPDATE invoices SET status = ?, total_amount = ?, parsing_category = ?, parsing_category_reason = ? WHERE id = ?')
        .run(newStatus, parseResult.totalAmount, newCategory, newCategoryReason, invoiceId);
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
    res.status(500).json({ error: 'Ошибка при повторном парсинге', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/invoices/:id/reparse-gigachat — принудительный перепарсинг через GigaChat
router.post('/api/invoices/:id/reparse-gigachat', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null } | undefined;

    if (!invoice) return res.status(404).json({ error: 'Счёт не найден' });
    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }
    if (!isGigaChatConfigured()) {
      return res.status(503).json({ error: 'GigaChat не настроен (нет GIGACHAT_AUTH_KEY)' });
    }

    // Save snapshot before overwriting items
    saveSnapshot(invoiceId, 'before_reparse_gigachat', db);

    const ext = path.extname(invoice.file_name).toLowerCase();

    // Build supplier context from saved parser config
    let reparseSupplierCtx: string | undefined;
    if (invoice.supplier_id) {
      const supplierRow = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { name: string } | undefined;
      reparseSupplierCtx = buildSupplierContext(supplierRow?.name ?? null, loadSavedMapping(invoice.supplier_id));
    }

    let gigaResult;
    if (ext === '.pdf' || ['.jpg', '.jpeg', '.png', '.tiff', '.bmp'].includes(ext)) {
      gigaResult = await parsePdfWithGigaChat(invoice.file_path, reparseSupplierCtx);
    } else {
      gigaResult = await parseExcelWithGigaChat(invoice.file_path, reparseSupplierCtx);
    }

    const items = gigaResult.items;
    const meta  = gigaResult.metadata;
    const newStatus = items.length > 0 ? 'verified' : 'needs_mapping';

    // Fuzzy supplier match: если GigaChat нашёл поставщика — проверить по БД
    let resolvedSupplierName = meta.supplierName;
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
    let resolvedSupplierId: number | null = null;
    if (resolvedSupplierName) {
      const existingS = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(resolvedSupplierName) as { id: number } | undefined;
      resolvedSupplierId = existingS ? existingS.id : Number(db.prepare('INSERT INTO suppliers (name, vat_rate) VALUES (?, 22)').run(resolvedSupplierName).lastInsertRowid);
    }

    let reparsedNeedsReview = computeNeedsAmountReview(items, meta.totalWithVat ?? null);
    const pq = gigaResult.parseQuality;
    let reparseReason = `GigaChat reparse, позиций: ${items.length}`;
    if (pq?.warnings.length) {
      reparseReason += ` | ${pq.warnings.join('; ')}`;
    }
    if (pq?.suggestElevatedReview) reparsedNeedsReview = 1;

    db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      db.prepare(
        'UPDATE invoices SET status=?, supplier_id=?, invoice_number=?, invoice_date=?, total_amount=?, vat_amount=?, parsing_category=?, parsing_category_reason=?, needs_amount_review=? WHERE id=?'
      ).run(
        newStatus,
        resolvedSupplierId,
        meta.documentNumber,
        meta.documentDate,
        meta.totalWithVat,
        meta.vatAmount ?? null,
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
    console.error('POST /api/invoices/:id/reparse-gigachat error:', error);
    res.status(500).json({ error: 'Ошибка GigaChat reparse', details: error instanceof Error ? error.message : 'Unknown error' });
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
      const fullConfig = { ...colMapping, headerRow: mapping.headerRow, separatorMethod, separatorValue };
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
      SELECT COALESCE(SUM(ii.amount), 0) as total
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
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

    const ALLOWED = new Set(['amount', 'quantity', 'quantity_packages', 'price']);
    if (!ALLOWED.has(numerator) || !ALLOWED.has(denominator)) {
      return res.status(400).json({ error: 'Недопустимые колонки для расчёта' });
    }
    if (numerator === denominator) {
      return res.status(400).json({ error: 'Числитель и делитель должны быть разными' });
    }

    saveSnapshot(invoiceId, `calculate_price_formula_${numerator}_div_${denominator}`, db);

    const result = db.prepare(`
      UPDATE invoice_items SET price = ${numerator} / ${denominator}
      WHERE invoice_id = ? AND ${numerator} IS NOT NULL AND ${denominator} IS NOT NULL AND ${denominator} > 0
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
