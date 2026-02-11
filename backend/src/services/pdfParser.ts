import fs from 'fs';
import { InvoiceRow, InvoiceParseResult } from '../types/invoice';

// pdf-parse v2 CJS import
const { PDFParse } = require('pdf-parse');

export interface ColumnMapping {
  article: number | null;
  name: number | null;
  unit: number | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
}

export const COLUMN_KEYWORDS: Record<keyof ColumnMapping, string[]> = {
  article: ['артикул', 'article', 'код', 'арт.', 'арт', 'код товара', 'каталожный номер', 'номенклатурный номер'],
  name: ['наименование', 'товар', 'название', 'описание', 'номенклатура', 'товар/услуга', 'материал', 'продукция', 'товары'],
  quantity: ['количество', 'кол-во', 'qty', 'кол.', 'кол'],
  price: ['цена', 'price', 'цена за ед', 'цена с ндс', 'цена с учетом ндс', 'стоимость за ед', 'цена за единицу'],
  amount: ['сумма', 'total', 'стоимость', 'итого', 'сумма с ндс', 'всего с ндс', 'сумма с учётом ндс'],
  unit: ['ед.', 'unit', 'ед. изм', 'единица', 'изм', 'ед. измерения', 'ед.изм.', 'ед.изм'],
};

export function normalizeText(text: unknown): string {
  if (text === null || text === undefined) return '';
  return String(text).toLowerCase().trim();
}

export function parsePrice(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value
    .replace(/\s/g, '')
    .replace(/руб\.?/gi, '')
    .replace(/₽/g, '')
    .replace(/р\.?$/i, '')
    .replace(',', '.')
    .trim();
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function detectColumns(rows: string[][]): { mapping: ColumnMapping; headerRowIndex: number } | null {
  const searchLimit = Math.min(rows.length, 10);

  for (let i = 0; i < searchLimit; i++) {
    const row = rows[i];
    const mapping: ColumnMapping = {
      article: null,
      name: null,
      unit: null,
      quantity: null,
      price: null,
      amount: null,
    };
    let matchCount = 0;

    for (let col = 0; col < row.length; col++) {
      const cellText = normalizeText(row[col]);
      if (!cellText) continue;

      for (const [field, keywords] of Object.entries(COLUMN_KEYWORDS)) {
        const key = field as keyof ColumnMapping;
        if (mapping[key] !== null) continue;

        for (const keyword of keywords) {
          if (cellText.includes(keyword.toLowerCase())) {
            mapping[key] = col;
            matchCount++;
            break;
          }
        }
      }
    }

    // Require at least "name" and one more column
    if (mapping.name !== null && matchCount >= 2) {
      return { mapping, headerRowIndex: i };
    }
  }

  return null;
}

export function parseTableData(rows: string[][], mapping: ColumnMapping, startRow: number): { items: InvoiceRow[]; errors: string[]; skipped: number } {
  const items: InvoiceRow[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];

    // Skip empty rows
    const hasData = row.some(cell => cell && cell.trim());
    if (!hasData) continue;

    const name = mapping.name !== null ? (row[mapping.name] || '').trim() : '';
    if (!name) {
      skipped++;
      errors.push(`Строка ${i + 1}: пропущена — отсутствует наименование`);
      continue;
    }

    // Skip rows that look like subtotals/totals
    const nameLower = name.toLowerCase();
    if (nameLower.startsWith('итого') || nameLower.startsWith('всего') || nameLower === 'total') {
      continue;
    }

    const article = mapping.article !== null ? (row[mapping.article] || '').trim() || null : null;
    const unit = mapping.unit !== null ? (row[mapping.unit] || '').trim() || null : null;
    const quantity = mapping.quantity !== null ? parsePrice(row[mapping.quantity]) : null;
    const price = mapping.price !== null ? parsePrice(row[mapping.price]) : null;
    const amount = mapping.amount !== null ? parsePrice(row[mapping.amount]) : null;

    items.push({
      article,
      name,
      unit,
      quantity,
      price,
      amount,
      row_index: i,
    });
  }

  return { items, errors, skipped };
}

const MONTH_NAMES: Record<string, string> = {
  'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
  'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
  'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12',
};

/**
 * Check text quality: returns ratio of "garbage" characters (replacement chars, control chars, etc.)
 * A ratio > 0.3 means the text is likely garbled/unreadable.
 */
export function checkTextQuality(text: string): { ratio: number; isGarbled: boolean } {
  if (!text || text.length === 0) return { ratio: 1, isGarbled: true };

  let garbageCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // U+FFFD replacement character
    if (code === 0xFFFD) { garbageCount++; continue; }
    // Control chars (except \n, \r, \t)
    if (code < 0x20 && code !== 0x0A && code !== 0x0D && code !== 0x09) { garbageCount++; continue; }
    // Private use area
    if (code >= 0xE000 && code <= 0xF8FF) { garbageCount++; continue; }
    // Surrogate halves (shouldn't appear in JS strings normally, but sometimes do in garbled text)
    if (code >= 0xD800 && code <= 0xDFFF) { garbageCount++; continue; }
  }

  const ratio = garbageCount / text.length;
  return { ratio, isGarbled: ratio > 0.3 };
}

const SUPPLIER_BAD_WORDS = [
  'условия', 'самовывоз', 'паспорт', 'доставка', 'отгрузка',
  'оплат', 'гарантия', 'возврат', 'примечан', 'внимание',
];

/**
 * Validate and clean supplier name extracted from text.
 * Returns null if the name looks like garbage/conditions text.
 */
function cleanSupplierName(raw: string | null): string | null {
  if (!raw) return null;
  // Take part before first comma (e.g. "ООО Дюкс, условия..." → "ООО Дюкс")
  let name = raw.split(',')[0].trim();
  // Remove trailing punctuation
  name = name.replace(/[.;:]+$/, '').trim();
  if (name.length < 2) return null;
  const lower = name.toLowerCase();
  for (const bad of SUPPLIER_BAD_WORDS) {
    if (lower.includes(bad)) return null;
  }
  return name;
}

/**
 * Extract BIK (9 digits) and correspondent account from raw text.
 * Handles cases where BIK is concatenated with cor.account.
 */
function extractBikAndCorAccount(text: string): { bik: string | null; corrAccount: string | null } {
  const bikMatch = text.match(/БИК\s*[:\s.]*(\d{9,})/i);
  if (!bikMatch) return { bik: null, corrAccount: null };

  const digits = bikMatch[1];
  const bik = digits.substring(0, 9);
  // Remaining digits may be correspondent account (20 digits)
  const rest = digits.substring(9);
  const corrAccount = rest.length >= 20 ? rest.substring(0, 20) : (rest.length > 0 ? rest : null);
  return { bik, corrAccount };
}

function extractMetadata(text: string): { invoiceNumber: string | null; invoiceDate: string | null; supplierName: string | null; totalAmount: number | null; bik: string | null; corrAccount: string | null } {
  const snippet = text.substring(0, 3000);

  // === Invoice number ===
  let invoiceNumber: string | null = null;
  // Priority 1: счёт/счет/invoice + №/#
  const numMatch = snippet.match(/(?:счёт|счет|invoice)\s*[№#:]\s*([A-Za-zА-Яа-я0-9\-\/]+)/i);
  if (numMatch) {
    invoiceNumber = numMatch[1].trim();
  }
  // Priority 2: заказ клиента/КП/коммерческое предложение — require № or # before the number
  if (!invoiceNumber) {
    const altNumMatch = snippet.match(/(?:заказ\s+клиента|КП|коммерческое\s+предложение)\s*(?:[^№#]*?)[№#]\s*([A-Za-zА-Яа-я0-9\-\/]+)/i);
    if (altNumMatch) {
      invoiceNumber = altNumMatch[1].trim();
    }
  }
  // Priority 3: № followed by alphanumeric (standalone)
  if (!invoiceNumber) {
    const standaloneNum = snippet.match(/№\s*([A-Za-zА-Яа-я0-9\-\/]{2,})/);
    if (standaloneNum) {
      invoiceNumber = standaloneNum[1].trim();
    }
  }

  // === Invoice date ===
  let invoiceDate: string | null = null;
  // Priority 1: от/date/дата + dd.mm.yyyy
  const dateMatch = snippet.match(/(?:от|date|дата)\s*[:\s]*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})/i);
  if (dateMatch) {
    invoiceDate = dateMatch[1].trim();
  }
  // Priority 2: "14 января 2026 г." — written month
  if (!invoiceDate) {
    const monthNames = Object.keys(MONTH_NAMES).join('|');
    const writtenDateRegex = new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})`, 'i');
    const writtenMatch = snippet.match(writtenDateRegex);
    if (writtenMatch) {
      const day = writtenMatch[1].padStart(2, '0');
      const month = MONTH_NAMES[writtenMatch[2].toLowerCase()];
      const year = writtenMatch[3];
      if (month) {
        invoiceDate = `${day}.${month}.${year}`;
      }
    }
  }
  // Priority 3: standalone dd.mm.yyyy (first occurrence)
  if (!invoiceDate) {
    const standaloneDate = snippet.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);
    if (standaloneDate) {
      invoiceDate = standaloneDate[1].trim();
    }
  }

  // === Supplier name ===
  let supplierName: string | null = null;
  // Priority 1: explicit field
  const supplierFieldMatch = snippet.match(/(?:поставщик|продавец|исполнитель)\s*[:\s]*([^\n]{3,60})/i);
  if (supplierFieldMatch) {
    supplierName = cleanSupplierName(supplierFieldMatch[1]);
  }
  // Priority 2: org form (ООО, ЗАО, etc.)
  if (!supplierName) {
    const orgRegex = /(ООО|ОАО|ЗАО|ПАО|НАО|ФГУП|ИП|АО)\s*[«"'(]?([^»"')\n]{2,50})[»"')]?/g;
    let m;
    while ((m = orgRegex.exec(snippet)) !== null) {
      const candidate = `${m[1]} ${m[2]}`.trim();
      const lower = candidate.toLowerCase();
      if (lower.includes('банк') || lower.includes('бик') || lower.includes('р/с') || lower.includes('к/с')) continue;
      const cleaned = cleanSupplierName(candidate);
      if (cleaned) { supplierName = cleaned; break; }
    }
  }

  // === BIK + correspondent account ===
  const { bik, corrAccount } = extractBikAndCorAccount(snippet);

  // Total amount from text
  let totalAmount: number | null = null;
  const totalMatch = snippet.match(/(?:итого|всего|total)\s*[:\s]*([0-9\s]+[.,]\d{2})/i);
  if (totalMatch) {
    totalAmount = parsePrice(totalMatch[1]);
  }

  return { invoiceNumber, invoiceDate, supplierName, totalAmount, bik, corrAccount };
}

/**
 * Extract metadata from 2D table rows (used for Excel and as fallback for garbled PDF text).
 */
export function extractMetadataFromRows(rows: string[][]): {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  supplierName: string | null;
  totalAmount: number | null;
  bik: string | null;
  corrAccount: string | null;
} {
  let invoiceNumber: string | null = null;
  let invoiceDate: string | null = null;
  let supplierName: string | null = null;
  let totalAmount: number | null = null;
  let bik: string | null = null;
  let corrAccount: string | null = null;

  const searchLimit = Math.min(rows.length, 30);

  for (let i = 0; i < searchLimit; i++) {
    const row = rows[i];
    for (const cell of row) {
      if (!cell) continue;
      const text = String(cell);

      // === Invoice number ===
      if (!invoiceNumber) {
        const numMatch = text.match(/(?:счёт|счет|invoice)\s*[№#:]\s*([A-Za-zА-Яа-я0-9\-\/]+)/i);
        if (numMatch) {
          invoiceNumber = numMatch[1].trim();
        }
      }
      if (!invoiceNumber) {
        const altNumMatch = text.match(/(?:заказ\s+клиента|КП|коммерческое\s+предложение)\s*(?:[^№#]*?)[№#]\s*([A-Za-zА-Яа-я0-9\-\/]+)/i);
        if (altNumMatch) {
          invoiceNumber = altNumMatch[1].trim();
        }
      }
      if (!invoiceNumber) {
        const standaloneNum = text.match(/№\s*([A-Za-zА-Яа-я0-9\-\/]{2,})/);
        if (standaloneNum) {
          invoiceNumber = standaloneNum[1].trim();
        }
      }

      // === Date ===
      if (!invoiceDate) {
        const dateMatch = text.match(/(?:от|date|дата)\s*[:\s]*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})/i);
        if (dateMatch) {
          invoiceDate = dateMatch[1].trim();
        }
      }
      if (!invoiceDate) {
        const monthNames = Object.keys(MONTH_NAMES).join('|');
        const writtenDateRegex = new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})`, 'i');
        const writtenMatch = text.match(writtenDateRegex);
        if (writtenMatch) {
          const day = writtenMatch[1].padStart(2, '0');
          const month = MONTH_NAMES[writtenMatch[2].toLowerCase()];
          const year = writtenMatch[3];
          if (month) {
            invoiceDate = `${day}.${month}.${year}`;
          }
        }
      }
      if (!invoiceDate) {
        const standaloneDate = text.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);
        if (standaloneDate) {
          invoiceDate = standaloneDate[1].trim();
        }
      }

      // === Supplier ===
      if (!supplierName) {
        const supplierFieldMatch = text.match(/(?:поставщик|продавец|исполнитель)\s*[:\s]*([^\n]{3,60})/i);
        if (supplierFieldMatch) {
          supplierName = cleanSupplierName(supplierFieldMatch[1]);
        } else {
          const orgMatch = text.match(/(ООО|ОАО|ЗАО|ПАО|НАО|ФГУП|ИП|АО)\s*[«"'(]?([^»"')\n]{2,50})[»"')]?/);
          if (orgMatch) {
            const candidate = `${orgMatch[1]} ${orgMatch[2]}`.trim();
            const lower = candidate.toLowerCase();
            if (!lower.includes('банк') && !lower.includes('бик') && !lower.includes('р/с') && !lower.includes('к/с')) {
              supplierName = cleanSupplierName(candidate);
            }
          }
        }
      }

      // === BIK ===
      if (!bik) {
        const bikResult = extractBikAndCorAccount(text);
        if (bikResult.bik) {
          bik = bikResult.bik;
          corrAccount = bikResult.corrAccount;
        }
      }

      // Total amount
      if (!totalAmount) {
        const totalMatch = text.match(/(?:итого|всего|total)\s*[:\s]*([0-9\s]+[.,]\d{2})/i);
        if (totalMatch) {
          totalAmount = parsePrice(totalMatch[1]);
        }
      }
    }
  }

  return { invoiceNumber, invoiceDate, supplierName, totalAmount, bik, corrAccount };
}

function textTo2DArray(text: string): string[][] {
  const lines = text.split('\n');
  const allRows: string[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try tab split first
    let cells = trimmed.split('\t').map(c => c.trim());
    // Fallback: split by 2+ spaces if tab didn't produce multiple cells
    if (cells.length < 2) {
      cells = trimmed.split(/\s{2,}/).map(c => c.trim());
    }
    // Keep all rows (including single-cell ones)
    allRows.push(cells);
  }

  if (allRows.length === 0) return [];

  // Find the most common column count (the "table" width) among multi-cell rows
  const colCounts = new Map<number, number>();
  for (const row of allRows) {
    if (row.length >= 2) {
      colCounts.set(row.length, (colCounts.get(row.length) || 0) + 1);
    }
  }

  // If no multi-cell rows exist, return all rows as-is
  if (colCounts.size === 0) return allRows;

  // Find the dominant column count
  let dominantCols = 0;
  let dominantCount = 0;
  for (const [cols, count] of colCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantCols = cols;
    }
  }

  // Filter: keep rows that have the dominant column count (± 1 tolerance)
  // This filters out metadata/header lines that have a very different structure
  const filtered = allRows.filter(row =>
    row.length >= dominantCols - 1 && row.length <= dominantCols + 1
  );

  return filtered.length > 0 ? filtered : allRows;
}

export interface SavedMapping {
  article: number | null;
  name: number | null;
  unit: number | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  headerRow: number;
}

/**
 * Check if a table looks like bank requisites (not product items).
 * Returns true if >= 3 negative markers found.
 */
function isRequisitesTable(rows: string[][]): boolean {
  const BAD_KEYWORDS = [
    'бик', 'к/с', 'р/с', 'банк', 'получатель', 'плательщик',
    'инн', 'кпп', 'назначение платежа', 'срок', 'очер', 'корресп',
  ];
  // Check first 5 rows
  const sample = rows.slice(0, 5).map(r => r.join(' ')).join(' ').toLowerCase();
  let badCount = 0;
  for (const kw of BAD_KEYWORDS) {
    if (sample.includes(kw)) badCount++;
  }
  return badCount >= 3;
}

/**
 * Score how likely a table contains product items.
 * Higher score = more likely a product table.
 */
function scoreProductTable(rows: string[][]): number {
  const GOOD_KEYWORDS = [
    'товар', 'работ', 'услуг', 'наименован', 'артикул',
    'колич', 'кол-во', 'цена', 'сумма', 'ед.', 'стоимость',
    'количество', 'название', 'номенклатура',
  ];
  // Check first 3 rows (likely headers)
  const sample = rows.slice(0, 3).map(r => r.join(' ')).join(' ').toLowerCase();
  let score = 0;
  for (const kw of GOOD_KEYWORDS) {
    if (sample.includes(kw)) score++;
  }
  return score;
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

export async function extractRawRows(filePath: string): Promise<{ rows: string[][]; fullText: string }> {
  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);

  const parser = new PDFParse({ data });

  try {
    const textResult = await parser.getText();
    const fullText = textResult.text || '';

    // Try getTable() first for structured tables
    try {
      const tableResult = await parser.getTable();
      const allTables: string[][][] = [];

      if (tableResult.mergedTables && tableResult.mergedTables.length > 0) {
        allTables.push(...tableResult.mergedTables);
      }

      // Also collect per-page tables (multi-page PDFs may have separate tables per page)
      if (tableResult.pages) {
        for (const page of tableResult.pages) {
          if (page.tables && page.tables.length > 0) {
            allTables.push(...page.tables);
          }
        }
      }

      // Filter and score tables to find the product table
      if (allTables.length > 0) {
        // Group tables by their column count (mode of row lengths in each table)
        const groups = new Map<number, string[][]>();
        for (const table of allTables) {
          if (table.length === 0) continue;
          const lengthCounts = new Map<number, number>();
          for (const row of table) {
            const len = row.length;
            lengthCounts.set(len, (lengthCounts.get(len) || 0) + 1);
          }
          let colCount = 0;
          let maxCnt = 0;
          for (const [len, count] of lengthCounts) {
            if (count > maxCnt) { maxCnt = count; colCount = len; }
          }
          const existing = groups.get(colCount) || [];
          existing.push(...table);
          groups.set(colCount, existing);
        }

        // Score each group: prefer product tables, exclude requisites
        let bestRows: string[][] = [];
        let bestScore = -1;
        let bestRowCount = 0;
        for (const [, groupRows] of groups) {
          if (groupRows.length === 0) continue;
          // Skip requisites tables
          if (isRequisitesTable(groupRows)) continue;
          const score = scoreProductTable(groupRows);
          // Prefer higher score; on tie prefer more rows
          if (score > bestScore || (score === bestScore && groupRows.length > bestRowCount)) {
            bestScore = score;
            bestRows = groupRows;
            bestRowCount = groupRows.length;
          }
        }

        // Fallback: if all filtered out, pick group with most rows (original logic)
        if (bestRows.length === 0) {
          for (const [, groupRows] of groups) {
            if (groupRows.length > bestRowCount) {
              bestRowCount = groupRows.length;
              bestRows = groupRows;
            }
          }
        }

        if (bestRows.length > 0) {
          return { rows: normalizeRowWidths(bestRows), fullText };
        }
      }
    } catch {
      // fall through to text fallback
    }

    // Fallback: parse text as 2D array
    return { rows: normalizeRowWidths(textTo2DArray(fullText)), fullText };
  } finally {
    await parser.destroy();
  }
}

export async function parsePdfFile(filePath: string, savedMapping?: SavedMapping): Promise<InvoiceParseResult> {
  const { rows, fullText } = await extractRawRows(filePath);
  const errors: string[] = [];
  let items: InvoiceRow[] = [];
  let totalRows = 0;
  let skippedRows = 0;

  // Check text quality — if garbled, use table rows for metadata instead
  const textQuality = checkTextQuality(fullText);
  let metadata;
  if (textQuality.isGarbled) {
    errors.push(`PDF текст нечитаем (${Math.round(textQuality.ratio * 100)}% мусора), метаданные извлекаются из таблицы`);
    metadata = extractMetadataFromRows(rows);
  } else {
    metadata = extractMetadata(fullText);
  }

  if (rows.length < 2) {
    return {
      items: [],
      errors: ['Не удалось найти таблицу в PDF'],
      totalRows: 0,
      skippedRows: 0,
      invoiceNumber: metadata.invoiceNumber,
      invoiceDate: metadata.invoiceDate,
      supplierName: metadata.supplierName,
      totalAmount: metadata.totalAmount,
    };
  }

  // Use saved mapping or auto-detect
  let mapping: ColumnMapping;
  let headerRowIndex: number;

  if (savedMapping) {
    mapping = {
      article: savedMapping.article,
      name: savedMapping.name,
      unit: savedMapping.unit,
      quantity: savedMapping.quantity,
      price: savedMapping.price,
      amount: savedMapping.amount,
    };
    headerRowIndex = savedMapping.headerRow;
  } else {
    const detected = detectColumns(rows);
    if (!detected) {
      return {
        items: [],
        errors: ['Не удалось определить колонки таблицы в PDF'],
        totalRows: rows.length,
        skippedRows: 0,
        invoiceNumber: metadata.invoiceNumber,
        invoiceDate: metadata.invoiceDate,
        supplierName: metadata.supplierName,
        totalAmount: metadata.totalAmount,
      };
    }
    mapping = detected.mapping;
    headerRowIndex = detected.headerRowIndex;
  }

  const result = parseTableData(rows, mapping, headerRowIndex + 1);
  totalRows = rows.length - headerRowIndex - 1;
  skippedRows = result.skipped;
  items = result.items;
  errors.push(...result.errors);

  // Use parsed total if we found it and our items don't have amounts
  let totalAmount = metadata.totalAmount;
  if (!totalAmount && items.length > 0) {
    const sum = items.reduce((acc, item) => acc + (item.amount || 0), 0);
    if (sum > 0) totalAmount = sum;
  }

  return {
    items,
    errors,
    totalRows,
    skippedRows,
    invoiceNumber: metadata.invoiceNumber,
    invoiceDate: metadata.invoiceDate,
    supplierName: metadata.supplierName,
    totalAmount,
  };
}
