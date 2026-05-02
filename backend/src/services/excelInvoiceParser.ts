import XLSX from 'xlsx';
import { InvoiceRow, InvoiceParseResult, InvoiceMetadata, ParsingConfidence, ExcelParseResult } from '../types/invoice';
import { detectDiscount } from './pdfParser';
import { detectColumns, parseTableData, parsePrice, SavedMapping, extractMetadataFromRows } from './pdfParser';
import { validateInvoice } from './invoiceValidator';

// ---------------------------------------------------------------------------
// Расширенный словарь маркеров колонок (только для Excel-парсера)
// Включает поля, специфичные для Excel: position, vatRate, vatAmount
// ---------------------------------------------------------------------------
const COLUMN_MARKERS = {
  position:  { patterns: ['№', '№ п/п', 'n', 'no', 'п/п', 'поз', 'позиция', '#'],                              valueType: 'integer' as const, priority: 1 },
  article:   { patterns: ['артикул', 'арт', 'арт.', 'код', 'code', 'sku', 'каталожный', 'номенклатура'],        valueType: 'string'  as const, priority: 2 },
  name:      { patterns: ['наименование', 'название', 'товар', 'описание', 'номенклатура',
                           'товары', 'работы', 'услуги', 'товары (работы, услуги)', 'продукция'],
               valueType: 'string' as const, priority: 3, required: true },
  quantity:  { patterns: ['кол-во', 'количество', 'кол.', 'шт', 'qty', 'count', 'ед'],                         valueType: 'number'  as const, priority: 4, required: true },
  unit:      { patterns: ['ед.', 'ед', 'единица', 'ед. изм.', 'ед.изм', 'unit', 'изм'],                        valueType: 'string'  as const, priority: 5 },
  price:     { patterns: ['цена', 'стоимость', 'руб/ед', 'за ед', 'price', 'руб.', 'цена за ед'],               valueType: 'number'  as const, priority: 6, required: true },
  total:     { patterns: ['сумма', 'итого', 'всего', 'стоимость', 'amount', 'total'],                           valueType: 'number'  as const, priority: 7, required: true },
  vatRate:   { patterns: ['ставка ндс', 'ндс %', 'ндс', 'vat', 'налог'],                                       valueType: 'percent' as const, priority: 8 },
  vatAmount: { patterns: ['сумма ндс', 'ндс руб', 'ндс сумма'],                                                 valueType: 'number'  as const, priority: 9 },
} as const;

type MarkerKey = keyof typeof COLUMN_MARKERS;

/**
 * Найти индекс колонки по маркерам с оценкой уверенности.
 * - Точное совпадение → confidence 100
 * - Ячейка содержит паттерн → confidence 70–90 (зависит от доли совпадения)
 */
function findColumnByMarkers(
  headerRow: string[],
  marker: { patterns: readonly string[]; valueType: string; priority: number }
): { index: number; confidence: number } | null {
  let best: { index: number; confidence: number } | null = null;
  for (let i = 0; i < headerRow.length; i++) {
    const cell = headerRow[i].toLowerCase().trim();
    if (!cell) continue;
    for (const pattern of marker.patterns) {
      const p = pattern.toLowerCase();
      if (cell === p) {
        // Точное совпадение
        if (!best || best.confidence < 100) best = { index: i, confidence: 100 };
        break;
      } else if (cell.includes(p)) {
        // Частичное совпадение: чем длиннее паттерн относительно ячейки — тем выше confidence
        const conf = Math.round(70 + (p.length / cell.length) * 20);
        if (!best || conf > best.confidence) best = { index: i, confidence: conf };
      }
    }
  }
  return best;
}

/**
 * Применить все COLUMN_MARKERS к строке-заголовку.
 * Возвращает маппинг индексов и confidence по каждой колонке.
 */
export function mapColumnsWithConfidence(headerRow: string[]): {
  mapping: Record<MarkerKey, number | null>;
  confidenceByColumn: Record<string, number>;
} {
  const mapping = {} as Record<MarkerKey, number | null>;
  const confidenceByColumn: Record<string, number> = {};

  for (const key of Object.keys(COLUMN_MARKERS) as MarkerKey[]) {
    const result = findColumnByMarkers(headerRow, COLUMN_MARKERS[key]);
    if (result) {
      mapping[key] = result.index;
      confidenceByColumn[key] = result.confidence;
    } else {
      mapping[key] = null;
    }
  }

  return { mapping, confidenceByColumn };
}

// ---------------------------------------------------------------------------
// Confidence Score — оценка уверенности парсинга
// ---------------------------------------------------------------------------

// Required-поля COLUMN_MARKERS (name, quantity, price, total)
const REQUIRED_MARKER_KEYS: MarkerKey[] = ['name', 'quantity', 'price', 'total'];

/**
 * Рассчитать confidence score для каждого этапа парсинга.
 * overall = header 30% + columns 30% + data 40%
 */
export function calculateConfidence(
  headerRow: string[],
  columnMapping: Record<MarkerKey, number | null>,
  confidenceByColumn: Record<string, number>,
  metadata: InvoiceMetadata,
  items: InvoiceRow[]
): ParsingConfidence {
  // 1. headerDetection: 25 очков за каждую найденную required колонку (max 100)
  const foundRequired = REQUIRED_MARKER_KEYS.filter(k => columnMapping[k] !== null).length;
  const headerDetection = Math.round((foundRequired / REQUIRED_MARKER_KEYS.length) * 100);

  // 2. columnMapping: среднее confidence по всем найденным колонкам
  const foundConfidences = Object.values(confidenceByColumn).filter(v => v > 0);
  const columnMappingScore = foundConfidences.length > 0
    ? Math.round(foundConfidences.reduce((a, b) => a + b, 0) / foundConfidences.length)
    : 0;

  // 3. metadataExtraction: сколько из 8 полей InvoiceMetadata найдено
  const metaFields: (keyof InvoiceMetadata)[] = [
    'documentNumber', 'documentDate', 'supplierName', 'supplierINN',
    'buyerName', 'buyerINN', 'totalWithVat', 'vatAmount'
  ];
  const foundMeta = metaFields.filter(f => metadata[f] !== null).length;
  const metadataExtraction = Math.round((foundMeta / metaFields.length) * 100);

  // 4. dataExtraction: доля позиций с price AND quantity
  const dataItems = items.filter(i => i.price !== null && i.quantity !== null).length;
  const dataExtraction = items.length > 0
    ? Math.round((dataItems / items.length) * 100)
    : 0;

  // 5. overall: взвешенное среднее
  const overall = Math.round(
    headerDetection      * 0.30 +
    columnMappingScore   * 0.30 +
    dataExtraction       * 0.40
  );

  return {
    headerDetection,
    columnMapping: confidenceByColumn,
    metadataExtraction,
    dataExtraction,
    overall,
  };
}

/**
 * Категоризировать результат парсинга по confidence.overall:
 * A ≥ 80 — готово к использованию
 * B ≥ 50 — нужна проверка оператором
 * C  < 50 — нужен fallback (GigaChat / ручной ввод)
 */
export function categorizeByConfidence(confidence: ParsingConfidence): 'A' | 'B' | 'C' {
  if (confidence.overall >= 80) return 'A';
  if (confidence.overall >= 50) return 'B';
  return 'C';
}

// ---------------------------------------------------------------------------
// Паттерны для извлечения метаданных из шапки счёта
// ---------------------------------------------------------------------------
const METADATA_PATTERNS = {
  inn:         /ИНН[:\s]*(\d{10}|\d{12})/i,
  docNumber:   /(?:счет|счёт|№|номер)[:\s№]*([А-Яа-яA-Za-z0-9\-\/]+)/i,
  docDate:     /(?:от|дата)[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
  totalWithVat:/(?:итого с ндс|всего к оплате|итого)[:\s]*([\d\s]+[,.]?\d*)/i,
  vatAmount:   /(?:в т\.?ч\.? ндс|ндс)[:\s]*([\d\s]+[,.]?\d*)/i,
  supplier:    /(?:поставщик|исполнитель|продавец)[:\s]*([^\n,]{3,60})/i,
  buyer:       /(?:покупатель|заказчик|плательщик)[:\s]*([^\n,]{3,60})/i,
};

/**
 * Извлечь расширенные метаданные из первых 30 строк Excel-файла.
 * Включает ИНН, покупателя и сумму НДС в дополнение к базовым полям.
 */
export function extractExcelMetadata(rows: string[][]): InvoiceMetadata {
  // Используем базовый парсер из pdfParser для основных полей
  const base = extractMetadataFromRows(rows.slice(0, 30));

  // Объединяем первые 30 строк в единый текст для regex-поиска
  const headerText = rows.slice(0, 30).map(r => r.join(' ')).join('\n');

  // ИНН: ищем два вхождения — первое для поставщика, второе для покупателя
  let supplierINN: string | null = null;
  let buyerINN: string | null = null;
  const innMatches = [...headerText.matchAll(/ИНН[:\s]*(\d{10}|\d{12})/gi)];
  if (innMatches.length > 0) supplierINN = innMatches[0][1];
  if (innMatches.length > 1) buyerINN = innMatches[1][1];

  // Покупатель
  let buyerName: string | null = null;
  const buyerMatch = METADATA_PATTERNS.buyer.exec(headerText);
  if (buyerMatch) buyerName = buyerMatch[1].trim().replace(/\s+/g, ' ');

  // Сумма НДС
  let vatAmount: string | number | null = null;
  const vatAmountMatch = METADATA_PATTERNS.vatAmount.exec(headerText);
  if (vatAmountMatch) {
    vatAmount = parsePrice(vatAmountMatch[1]);
  }

  // Итого с НДС (если не нашли в базовом парсере)
  let totalWithVat: number | null = base.totalAmount;
  if (!totalWithVat) {
    const totalMatch = METADATA_PATTERNS.totalWithVat.exec(headerText);
    if (totalMatch) totalWithVat = parsePrice(totalMatch[1]);
  }

  return {
    documentNumber: base.invoiceNumber,
    documentDate:   base.invoiceDate,
    supplierName:   base.supplierName,
    supplierINN,
    buyerName,
    buyerINN,
    totalWithVat,
    vatAmount: typeof vatAmount === 'number' ? vatAmount : null,
    vat_rate: 22,
  };
}

/**
 * Normalize all rows to have the same number of columns (pad shorter rows with empty strings).
 */
function normalizeRowWidths(rows: string[][]): string[][] {
  if (rows.length === 0) return rows;
  const maxCols = Math.max(...rows.map(r => r.length));
  if (maxCols === 0) return rows;
  return rows.map(row => {
    if (row.length < maxCols) {
      return [...row, ...Array(maxCols - row.length).fill('')];
    }
    return row;
  });
}

/**
 * Extract raw rows (string[][]) from an Excel file. Used by preview endpoint.
 * Ensures all columns up to the sheet's last used column are included (preserves empty cells).
 */
export function extractExcelRawRows(filePath: string): string[][] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];

  // Determine total column count from sheet range to ensure empty columns are preserved
  const ref = sheet['!ref'];
  let totalCols = 0;
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    totalCols = range.e.c + 1; // 0-based end column + 1
  }

  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const MAX_ROWS = 50_000;
  if (rawRows.length > MAX_ROWS) {
    throw new Error(`Слишком много строк (${rawRows.length}). Максимум — ${MAX_ROWS}.`);
  }

  const rows = rawRows.map(row => {
    const cells = row.map(cell => (cell === null || cell === undefined) ? '' : String(cell));
    // Pad to totalCols to preserve empty columns at the end
    while (cells.length < totalCols) {
      cells.push('');
    }
    return cells;
  });

  return normalizeRowWidths(rows);
}

/**
 * Extract Excel preview data with sheet metadata. Used by preview-excel endpoint.
 */
export function extractExcelPreviewData(filePath: string, sheetIndex = 0, maxRows = 200): {
  rows: string[][];
  sheetNames: string[];
  totalRows: number;
} {
  const workbook = XLSX.readFile(filePath);
  const sheetNames = workbook.SheetNames;
  const sheetName = sheetNames[sheetIndex] || sheetNames[0];
  if (!sheetName) return { rows: [], sheetNames: [], totalRows: 0 };

  const sheet = workbook.Sheets[sheetName];

  const ref = sheet['!ref'];
  let totalCols = 0;
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    totalCols = range.e.c + 1;
  }

  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const MAX_ROWS = 50_000;
  if (rawRows.length > MAX_ROWS) {
    throw new Error(`Слишком много строк (${rawRows.length}). Максимум — ${MAX_ROWS}.`);
  }

  const allRows = rawRows.map(row => {
    const cells = (row as any[]).map(cell => (cell === null || cell === undefined) ? '' : String(cell));
    while (cells.length < totalCols) cells.push('');
    return cells;
  });

  const rows = normalizeRowWidths(allRows.slice(0, maxRows));
  return { rows, sheetNames, totalRows: allRows.length };
}

/**
 * Основная функция парсинга Excel-счёта.
 * Возвращает ExcelParseResult с категорией A/B/C, confidence score и валидацией.
 * Сохраняет полную обратную совместимость с savedMapping (supplier_parser_configs).
 */
export function parseExcelInvoice(filePath: string, savedMapping?: SavedMapping): ExcelParseResult {
  const errors: string[] = [];

  // 1. Прочитать строки
  const rows = extractExcelRawRows(filePath);

  // Пустой файл → category C
  if (rows.length < 2) {
    const emptyMeta: InvoiceMetadata = {
      documentNumber: null, documentDate: null, supplierName: null,
      supplierINN: null, buyerName: null, buyerINN: null,
      totalWithVat: null, vatAmount: null, vat_rate: 22,
    };
    const emptyConf: ParsingConfidence = {
      headerDetection: 0, columnMapping: {}, metadataExtraction: 0, dataExtraction: 0, overall: 0,
    };
    return {
      category: 'C',
      metadata: emptyMeta,
      items: [],
      errors: ['Файл содержит менее 2 строк'],
      totalRows: 0,
      skippedRows: 0,
      discountDetected: null,
      confidence: emptyConf,
      validation: { valid: false, errors: [{ type: 'MISSING_REQUIRED', message: 'Файл пуст', details: null }], warnings: [] },
      rawData: rows,
    };
  }

  // 2. Извлечь расширенные метаданные (ИНН, покупатель, НДС)
  const metadata = extractExcelMetadata(rows);

  // 3. Определить маппинг колонок
  let columnMapping: Record<MarkerKey, number | null>;
  let confidenceByColumn: Record<string, number> = {};
  let headerRowIndex: number;

  if (savedMapping) {
    // Обратная совместимость: применить сохранённый маппинг поставщика
    const rawMapping = {
      article: savedMapping.article,
      name: savedMapping.name,
      unit: savedMapping.unit,
      quantity: savedMapping.quantity,
      quantity_packages: savedMapping.quantity_packages ?? null,
      price: savedMapping.price,
      amount: savedMapping.amount,
    };
    // Для confidence: считаем сохранённые колонки как 100%
    columnMapping = {
      position: null, article: rawMapping.article, name: rawMapping.name,
      quantity: rawMapping.quantity, unit: rawMapping.unit, price: rawMapping.price,
      total: rawMapping.amount, vatRate: null, vatAmount: null,
    };
    if (rawMapping.article !== null) confidenceByColumn['article'] = 100;
    if (rawMapping.name    !== null) confidenceByColumn['name']    = 100;
    if (rawMapping.unit    !== null) confidenceByColumn['unit']     = 100;
    if (rawMapping.quantity !== null) confidenceByColumn['quantity'] = 100;
    if (rawMapping.price   !== null) confidenceByColumn['price']   = 100;
    if (rawMapping.amount  !== null) confidenceByColumn['total']   = 100;
    headerRowIndex = savedMapping.headerRow;

    // Парсим с оригинальным ColumnMapping для parseTableData
    const tableResult = parseTableData(rows, rawMapping, headerRowIndex + 1);
    const items = tableResult.items;
    errors.push(...tableResult.errors);

    const allText = rows.map(r => r.join(' ')).join(' ');
    const discountDetected = detectDiscount(allText);

    let totalWithVat = metadata.totalWithVat;
    if (!totalWithVat && items.length > 0) {
      const sum = items.reduce((acc, item) => acc + (item.amount || 0), 0);
      if (sum > 0) totalWithVat = sum;
    }
    metadata.totalWithVat = totalWithVat;

    const confidence = calculateConfidence(rows[headerRowIndex] ?? [], columnMapping, confidenceByColumn, metadata, items);
    const category = categorizeByConfidence(confidence);
    const validation = validateInvoice(items, metadata);

    console.log(`[ExcelParser] savedMapping applied, confidence=${confidence.overall}, category=${category}, items=${items.length}`);

    return {
      category,
      metadata,
      items: category !== 'C' ? items : [],
      errors,
      totalRows: rows.length - headerRowIndex - 1,
      skippedRows: tableResult.skipped,
      discountDetected,
      confidence,
      validation,
      rawData: category !== 'A' ? rows : undefined,
    };
  }

  // 4. Авто-определение колонок через COLUMN_MARKERS
  // Сначала пробуем новый mapColumnsWithConfidence, fallback — detectColumns из pdfParser
  const detected = detectColumns(rows);
  if (!detected) {
    // Колонки не найдены → category B (текст есть, маппинг нужен)
    const headerText = rows.slice(0, 10).map(r => r.join(' ')).join(' ');
    const emptyConf: ParsingConfidence = {
      headerDetection: 0, columnMapping: {}, metadataExtraction: 0, dataExtraction: 0, overall: 0,
    };
    return {
      category: 'B',
      metadata,
      items: [],
      errors: ['Не удалось определить колонки таблицы в Excel-файле'],
      totalRows: rows.length,
      skippedRows: 0,
      discountDetected: detectDiscount(headerText),
      confidence: emptyConf,
      validation: { valid: false, errors: [], warnings: [] },
      rawData: rows,
    };
  }

  headerRowIndex = detected.headerRowIndex;
  const headerRow = rows[headerRowIndex] ?? [];

  // Расширяем маппинг через COLUMN_MARKERS для confidence
  const markerResult = mapColumnsWithConfidence(headerRow);
  columnMapping = markerResult.mapping;
  confidenceByColumn = markerResult.confidenceByColumn;

  // 5. Парсим данные (используем ColumnMapping из detectColumns)
  const tableResult = parseTableData(rows, detected.mapping, headerRowIndex + 1);
  const items = tableResult.items;
  errors.push(...tableResult.errors);

  // 6. Уточнить totalWithVat из items если не найдено
  let totalWithVat = metadata.totalWithVat;
  if (!totalWithVat && items.length > 0) {
    const sum = items.reduce((acc, item) => acc + (item.amount || 0), 0);
    if (sum > 0) totalWithVat = sum;
  }
  metadata.totalWithVat = totalWithVat;

  const allText = rows.map(r => r.join(' ')).join(' ');
  const discountDetected = detectDiscount(allText);

  // 7. Рассчитать confidence и категорию
  const confidence = calculateConfidence(headerRow, columnMapping, confidenceByColumn, metadata, items);
  const category = categorizeByConfidence(confidence);

  // 8. Валидация
  const validation = validateInvoice(items, metadata);

  console.log(`[ExcelParser] auto-detect, confidence=${confidence.overall}, category=${category}, items=${items.length}, warnings=${validation.warnings.length}`);

  return {
    category,
    metadata,
    items: category !== 'C' ? items : [],
    errors,
    totalRows: rows.length - headerRowIndex - 1,
    skippedRows: tableResult.skipped,
    discountDetected,
    confidence,
    validation,
    rawData: category !== 'A' ? rows : undefined,
  };
}

/**
 * Адаптер ExcelParseResult → InvoiceParseResult для обратной совместимости с PDF-кодом.
 * Используется в invoices.ts там, где ожидается устаревший тип.
 */
export function excelToLegacy(r: ExcelParseResult): InvoiceParseResult {
  return {
    items: r.items,
    errors: r.errors,
    totalRows: r.totalRows,
    skippedRows: r.skippedRows,
    invoiceNumber: r.metadata.documentNumber,
    invoiceDate:   r.metadata.documentDate,
    supplierName:  r.metadata.supplierName,
    totalAmount:   r.metadata.totalWithVat,
    vatAmount:     r.metadata.vatAmount,
    discountDetected: r.discountDetected,
  };
}
