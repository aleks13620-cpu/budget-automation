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
