import XLSX from 'xlsx';
import { InvoiceRow, InvoiceParseResult } from '../types/invoice';
import { detectColumns, parseTableData, parsePrice, SavedMapping, extractMetadataFromRows } from './pdfParser';

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
  const allRows = rawRows.map(row => {
    const cells = (row as any[]).map(cell => (cell === null || cell === undefined) ? '' : String(cell));
    while (cells.length < totalCols) cells.push('');
    return cells;
  });

  const rows = normalizeRowWidths(allRows.slice(0, maxRows));
  return { rows, sheetNames, totalRows: allRows.length };
}

export function parseExcelInvoice(filePath: string, savedMapping?: SavedMapping): InvoiceParseResult {
  const errors: string[] = [];

  // Read all rows with proper column padding (preserves right-side columns)
  const rows = extractExcelRawRows(filePath);

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
      quantity_packages: savedMapping.quantity_packages ?? null,
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
