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

  if (parserName) {
    const parserOverrides = loadSupplierParserOverrides(options.supplierId, savedMapping);
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

    return {
      source: 'pdf',
      category: hasItems ? 'A' : 'C',
      parseResult: pdfResult,
      confidence: hasItems ? 80 : 20,
    };
  }

  throw new Error(`Неподдерживаемый формат файла: ${ext}`);
}
