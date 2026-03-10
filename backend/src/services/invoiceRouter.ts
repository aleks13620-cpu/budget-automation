/**
 * Invoice Router
 *
 * Единая точка входа для парсинга счетов.
 * Направляет файл на нужный парсер в зависимости от расширения,
 * и применяет GigaChat как fallback при низком confidence.
 */

import path from 'path';
import { parsePdfFile, extractRawRows, parsePdfFromExtracted, SavedMapping } from './pdfParser';
import { parseExcelInvoice, excelToLegacy } from './excelInvoiceParser';
import { parsePdfWithGigaChat, parseExcelWithGigaChat } from './gigachatParser';
import { validateInvoice } from './invoiceValidator';
import { isGigaChatConfigured } from './gigachatService';
import { InvoiceRow, InvoiceMetadata, InvoiceParseResult } from '../types/invoice';
import { ValidationResult } from '../types/validation';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export type InvoiceSource = 'excel' | 'pdf' | 'image' | 'gigachat_fallback';

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
}

const EXCEL_EXTS = new Set(['.xlsx', '.xls']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.bmp']);

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Конвертирует GigaChatInvoiceResult в InvoiceParseResult */
function gigachatToLegacy(
  gigaResult: Awaited<ReturnType<typeof parsePdfWithGigaChat>>
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
    discountDetected: null,
  };
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
): Promise<RouterParseResult> {
  const ext = path.extname(filePath).toLowerCase();

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
        const validation = validateInvoice(gigaParseResult.items, gigaResult.metadata);
        return {
          source: 'gigachat_fallback',
          category: validation.valid ? 'A' : 'B',
          parseResult: gigaParseResult,
          metadata: gigaResult.metadata,
          confidence: 85,
          validation,
        };
      } catch (err) {
        console.warn(`[InvoiceRouter] GigaChat fallback failed: ${err instanceof Error ? err.message : err}`);
        // Возвращаем исходный Excel-результат
      }
    }

    return {
      source: 'excel',
      category: excelResult.category,
      parseResult,
      metadata: excelResult.metadata,
      confidence: excelResult.confidence.overall,
      validation: excelResult.validation,
    };
  }

  // ─── PDF ──────────────────────────────────────────────────────────────
  if (ext === '.pdf') {
    const rawExtraction = await extractRawRows(filePath);
    const pdfResult = parsePdfFromExtracted(rawExtraction.rows, rawExtraction.fullText, savedMapping);

    const hasItems = pdfResult.items.length > 0;

    // Fallback на GigaChat если PDF не распознан и GigaChat доступен
    if (!hasItems && isGigaChatConfigured()) {
      console.log(`[InvoiceRouter] PDF items=0 — GigaChat fallback`);
      try {
        const gigaResult = await parsePdfWithGigaChat(filePath);
        const gigaParseResult = gigachatToLegacy(gigaResult);
        const validation = validateInvoice(gigaParseResult.items, gigaResult.metadata);
        return {
          source: 'gigachat_fallback',
          category: validation.valid ? 'A' : 'B',
          parseResult: gigaParseResult,
          metadata: gigaResult.metadata,
          confidence: 85,
          validation,
        };
      } catch (err) {
        console.warn(`[InvoiceRouter] GigaChat fallback failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    return {
      source: 'pdf',
      category: hasItems ? 'A' : 'B',
      parseResult: pdfResult,
      confidence: hasItems ? 80 : 20,
    };
  }

  throw new Error(`Неподдерживаемый формат файла: ${ext}`);
}
