import XLSX from 'xlsx';
import { InvoiceRow, InvoiceParseResult } from '../types/invoice';
import { detectColumns, parseTableData, parsePrice, SavedMapping } from './pdfParser';

const MONTH_NAMES: Record<string, string> = {
  'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
  'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
  'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12',
};

export function extractMetadataFromRows(rows: string[][]): {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  supplierName: string | null;
  totalAmount: number | null;
} {
  let invoiceNumber: string | null = null;
  let invoiceDate: string | null = null;
  let supplierName: string | null = null;
  let totalAmount: number | null = null;

  // Search first 30 rows for metadata
  const searchLimit = Math.min(rows.length, 30);

  for (let i = 0; i < searchLimit; i++) {
    const row = rows[i];
    for (const cell of row) {
      if (!cell) continue;
      const text = String(cell);

      // === Invoice number ===
      if (!invoiceNumber) {
        // Priority 1: счёт/счет/invoice
        const numMatch = text.match(/(?:счёт|счет|invoice)\s*[№#:]\s*([A-Za-zА-Яа-я0-9\-\/]+)/i);
        if (numMatch) {
          invoiceNumber = numMatch[1].trim();
        }
      }
      if (!invoiceNumber) {
        // Priority 2: заказ клиента/КП — require № or # before the number
        const altNumMatch = text.match(/(?:заказ\s+клиента|КП|коммерческое\s+предложение)\s*(?:[^№#]*?)[№#]\s*([A-Za-zА-Яа-я0-9\-\/]+)/i);
        if (altNumMatch) {
          invoiceNumber = altNumMatch[1].trim();
        }
      }
      if (!invoiceNumber) {
        // Priority 3: standalone №
        const standaloneNum = text.match(/№\s*([A-Za-zА-Яа-я0-9\-\/]{2,})/);
        if (standaloneNum) {
          invoiceNumber = standaloneNum[1].trim();
        }
      }

      // === Date ===
      if (!invoiceDate) {
        // Priority 1: от/date/дата + dd.mm.yyyy
        const dateMatch = text.match(/(?:от|date|дата)\s*[:\s]*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})/i);
        if (dateMatch) {
          invoiceDate = dateMatch[1].trim();
        }
      }
      if (!invoiceDate) {
        // Priority 2: "14 января 2026 г."
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
        // Priority 3: standalone dd.mm.yyyy
        const standaloneDate = text.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);
        if (standaloneDate) {
          invoiceDate = standaloneDate[1].trim();
        }
      }

      // === Supplier ===
      if (!supplierName) {
        const supplierFieldMatch = text.match(/(?:поставщик|продавец|исполнитель)\s*[:\s]*([^\n]{3,60})/i);
        if (supplierFieldMatch) {
          supplierName = supplierFieldMatch[1].trim();
        } else {
          const orgMatch = text.match(/(ООО|ОАО|ЗАО|ПАО|НАО|ФГУП|ИП|АО)\s*[«"'(]?([^»"')\n]{2,50})[»"')]?/);
          if (orgMatch) {
            const candidate = `${orgMatch[1]} ${orgMatch[2]}`.trim();
            const lower = candidate.toLowerCase();
            if (!lower.includes('банк') && !lower.includes('бик') && !lower.includes('р/с') && !lower.includes('к/с')) {
              supplierName = candidate;
            }
          }
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

  return { invoiceNumber, invoiceDate, supplierName, totalAmount };
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
 */
export function extractExcelRawRows(filePath: string): string[][] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const rows = rawRows.map(row =>
    row.map(cell => (cell === null || cell === undefined) ? '' : String(cell))
  );

  return normalizeRowWidths(rows);
}

export function parseExcelInvoice(filePath: string, savedMapping?: SavedMapping): InvoiceParseResult {
  const errors: string[] = [];

  // Read workbook
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      items: [],
      errors: ['Файл не содержит листов'],
      totalRows: 0,
      skippedRows: 0,
      invoiceNumber: null,
      invoiceDate: null,
      supplierName: null,
      totalAmount: null,
    };
  }

  const sheet = workbook.Sheets[sheetName];

  // Convert sheet to 2D string array (header: 1 gives array of arrays)
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Convert all cell values to strings
  const rows: string[][] = rawRows.map(row =>
    row.map(cell => (cell === null || cell === undefined) ? '' : String(cell))
  );

  if (rows.length < 2) {
    return {
      items: [],
      errors: ['Файл содержит менее 2 строк'],
      totalRows: 0,
      skippedRows: 0,
      invoiceNumber: null,
      invoiceDate: null,
      supplierName: null,
      totalAmount: null,
    };
  }

  // Extract metadata from header area
  const metadata = extractMetadataFromRows(rows);

  // Use saved mapping or auto-detect columns
  let mapping;
  let headerRowIndex;

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
        errors: ['Не удалось определить колонки таблицы в Excel-файле'],
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

  const totalRows = rows.length - headerRowIndex - 1;
  const items = result.items;
  errors.push(...result.errors);

  // Calculate total if not found in metadata
  let totalAmount = metadata.totalAmount;
  if (!totalAmount && items.length > 0) {
    const sum = items.reduce((acc, item) => acc + (item.amount || 0), 0);
    if (sum > 0) totalAmount = sum;
  }

  return {
    items,
    errors,
    totalRows,
    skippedRows: result.skipped,
    invoiceNumber: metadata.invoiceNumber,
    invoiceDate: metadata.invoiceDate,
    supplierName: metadata.supplierName,
    totalAmount,
  };
}
