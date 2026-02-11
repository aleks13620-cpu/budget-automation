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

function extractMetadata(text: string): { invoiceNumber: string | null; invoiceDate: string | null; supplierName: string | null; totalAmount: number | null } {
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
    supplierName = supplierFieldMatch[1].trim();
  }
  // Priority 2: org form (ООО, ЗАО, etc.)
  if (!supplierName) {
    const orgRegex = /(ООО|ОАО|ЗАО|ПАО|НАО|ФГУП|ИП|АО)\s*[«"'(]?([^»"')\n]{2,50})[»"')]?/g;
    let m;
    while ((m = orgRegex.exec(snippet)) !== null) {
      const candidate = `${m[1]} ${m[2]}`.trim();
      const lower = candidate.toLowerCase();
      // Skip bank names and buyer references
      if (lower.includes('банк') || lower.includes('бик') || lower.includes('р/с') || lower.includes('к/с')) continue;
      supplierName = candidate;
      break;
    }
  }

  // Total amount from text
  let totalAmount: number | null = null;
  const totalMatch = snippet.match(/(?:итого|всего|total)\s*[:\s]*([0-9\s]+[.,]\d{2})/i);
  if (totalMatch) {
    totalAmount = parsePrice(totalMatch[1]);
  }

  return { invoiceNumber, invoiceDate, supplierName, totalAmount };
}

function textTo2DArray(text: string): string[][] {
  const lines = text.split('\n');
  const rows: string[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try tab split first
    let cells = trimmed.split('\t').map(c => c.trim());
    // Fallback: split by 2+ spaces if tab didn't produce multiple cells
    if (cells.length < 2) {
      cells = trimmed.split(/\s{2,}/).map(c => c.trim());
    }
    if (cells.length >= 2) {
      rows.push(cells);
    }
  }

  return rows;
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
 * Extract raw rows (string[][]) from a PDF file.
 * Used by preview endpoint and internally by parsePdfFile.
 */
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

      if (allTables.length === 0 && tableResult.pages) {
        for (const page of tableResult.pages) {
          if (page.tables && page.tables.length > 0) {
            allTables.push(...page.tables);
          }
        }
      }

      // Return the largest table found
      if (allTables.length > 0) {
        let largest = allTables[0];
        for (const t of allTables) {
          if (t.length > largest.length) largest = t;
        }
        return { rows: normalizeRowWidths(largest), fullText };
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

  const metadata = extractMetadata(fullText);

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
