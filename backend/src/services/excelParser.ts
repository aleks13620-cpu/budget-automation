import * as XLSX from 'xlsx';
import { SpecificationRow, ParseResult } from '../types/specification';

export interface ColumnMapping {
  position_number: number | null;
  name: number | null;
  characteristics: number | null;
  equipment_code: number | null;
  article: number | null;
  product_code: number | null;
  marking: number | null;
  type_size: number | null;
  manufacturer: number | null;
  unit: number | null;
  quantity: number | null;
}

const HEADER_KEYWORDS: Record<keyof ColumnMapping, string[]> = {
  position_number: ['№', 'п/п', 'поз', 'номер'],
  name: ['наименование', 'название', 'товар', 'материал'],
  characteristics: ['характеристик', 'описание', 'параметр'],
  equipment_code: ['код', 'article'],
  article:       ['артикул', 'арт.', 'арт ', 'sku'],
  product_code:  ['код продукции', 'код товара', 'код позиции'],
  marking:       ['маркировка', 'обозначение', 'марк'],
  type_size:     ['типоразмер', 'типо-размер', 'размер'],
  manufacturer: ['производител', 'бренд', 'марка', 'завод'],
  unit: ['ед', 'единиц', 'изм'],
  quantity: ['кол', 'количеств', 'qty', 'объём', 'объем'],
};

function normalizeText(text: unknown): string {
  if (text === null || text === undefined) return '';
  return String(text).toLowerCase().trim();
}

function detectHeaderRow(sheet: XLSX.WorkSheet): { rowIndex: number; mapping: ColumnMapping } | null {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');

  for (let row = range.s.r; row <= Math.min(range.e.r, 30); row++) {
    const mapping: ColumnMapping = {
      position_number: null,
      name: null,
      characteristics: null,
      equipment_code: null,
      article: null,
      product_code: null,
      marking: null,
      type_size: null,
      manufacturer: null,
      unit: null,
      quantity: null,
    };

    let matchCount = 0;

    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = sheet[cellAddress];
      if (!cell) continue;

      const cellText = normalizeText(cell.v);
      if (!cellText) continue;

      for (const [field, keywords] of Object.entries(HEADER_KEYWORDS)) {
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

    // Deduplicate: if multiple fields point to the same column, keep only the first one
    const usedCols = new Set<number>();
    for (const field of Object.keys(HEADER_KEYWORDS)) {
      const key = field as keyof ColumnMapping;
      if (mapping[key] === null) continue;
      if (usedCols.has(mapping[key]!)) {
        mapping[key] = null;
        matchCount--;
      } else {
        usedCols.add(mapping[key]!);
      }
    }

    // Require at least "name" and one more column to consider it a header
    if (mapping.name !== null && matchCount >= 2) {
      return { rowIndex: row, mapping };
    }
  }

  return null;
}

function getCellValue(sheet: XLSX.WorkSheet, row: number, col: number): string | null {
  const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[cellAddress];
  if (!cell || cell.v === null || cell.v === undefined || String(cell.v).trim() === '') {
    return null;
  }
  return String(cell.v).trim();
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const str = String(value).replace(',', '.').replace(/\s/g, '');
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

/** DN child row pattern: empty position_number AND name is a short DN/diameter designator */
const DN_CHILD_PATTERN = /^(DN|Ду|d=|D=|du)?\s*\d{2,}(\s|$|[xX×\/\-])/i;

function isDnChild(item: SpecificationRow): boolean {
  return !item.position_number && DN_CHILD_PATTERN.test(item.name.trim());
}

function mergeMultilineItems(items: SpecificationRow[]): SpecificationRow[] {
  const result: SpecificationRow[] = [];
  for (const item of items) {
    const isContinuation =
      item.position_number === null &&
      item.quantity === null &&
      item.unit === null &&
      !isDnChild(item);
    if (isContinuation && result.length > 0) {
      const last = result[result.length - 1];
      last.name = last.name + ' ' + item.name;
      if (last.full_name) last.full_name = last.full_name + ' ' + item.name;
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Link DN sub-rows to their parent:
 * - Walk items in order; track last "full" item (non-DN child)
 * - When a DN child is found, link it to the last full item
 * - Compute full_name = parent.name + " " + child.name
 */
function linkDnChildren(items: SpecificationRow[]): void {
  let lastFullIndex: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isDnChild(item)) {
      lastFullIndex = i;
      item._parentIndex = null;
      item.full_name = null;
    } else if (lastFullIndex !== null) {
      item._parentIndex = lastFullIndex;
      item.full_name = items[lastFullIndex].name + ' ' + item.name;
    } else {
      item._parentIndex = null;
      item.full_name = null;
    }
  }
}

export function parseExcelFile(filePath: string): ParseResult {
  const errors: string[] = [];
  const items: SpecificationRow[] = [];

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { items: [], errors: ['Файл не содержит листов'], totalRows: 0, skippedRows: 0 };
  }

  const sheet = workbook.Sheets[sheetName];
  const headerResult = detectHeaderRow(sheet);

  if (!headerResult) {
    return {
      items: [],
      errors: ['Не удалось определить строку заголовков. Убедитесь, что в таблице есть заголовки: наименование, количество и т.д.'],
      totalRows: 0,
      skippedRows: 0,
    };
  }

  const { rowIndex: headerRow, mapping } = headerResult;
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');

  let totalRows = 0;
  let skippedRows = 0;

  for (let row = headerRow + 1; row <= range.e.r; row++) {
    // Check if the entire row is empty
    let hasData = false;
    for (let col = range.s.c; col <= range.e.c; col++) {
      const val = getCellValue(sheet, row, col);
      if (val) {
        hasData = true;
        break;
      }
    }
    if (!hasData) continue;

    totalRows++;

    const name = mapping.name !== null ? getCellValue(sheet, row, mapping.name) : null;
    if (!name) {
      skippedRows++;
      errors.push(`Строка ${row + 1}: пропущена — отсутствует наименование`);
      continue;
    }

    const rawQuantity = mapping.quantity !== null
      ? sheet[XLSX.utils.encode_cell({ r: row, c: mapping.quantity })]?.v
      : null;
    const quantity = parseNumber(rawQuantity);

    items.push({
      position_number: mapping.position_number !== null ? getCellValue(sheet, row, mapping.position_number) : null,
      name,
      characteristics: mapping.characteristics !== null ? getCellValue(sheet, row, mapping.characteristics) : null,
      equipment_code: mapping.equipment_code !== null ? getCellValue(sheet, row, mapping.equipment_code) : null,
      article: mapping.article !== null ? getCellValue(sheet, row, mapping.article) : null,
      product_code: mapping.product_code !== null ? getCellValue(sheet, row, mapping.product_code) : null,
      marking: mapping.marking !== null ? getCellValue(sheet, row, mapping.marking) : null,
      type_size: mapping.type_size !== null ? getCellValue(sheet, row, mapping.type_size) : null,
      manufacturer: mapping.manufacturer !== null ? getCellValue(sheet, row, mapping.manufacturer) : null,
      unit: mapping.unit !== null ? getCellValue(sheet, row, mapping.unit) : null,
      quantity,
      full_name: null,
      _parentIndex: null,
    });
  }

  // Post-process: merge multiline continuations, then link DN child rows to their parent
  const merged = mergeMultilineItems(items);
  linkDnChildren(merged);

  return { items: merged, errors, totalRows, skippedRows };
}

export function parseFromRawData(
  rawRows: string[][],
  headerRow: number,
  mapping: ColumnMapping,
  mergeMultiline: boolean
): ParseResult {
  const errors: string[] = [];
  const items: SpecificationRow[] = [];
  let totalRows = 0;
  let skippedRows = 0;

  for (let row = headerRow + 1; row < rawRows.length; row++) {
    const rowData = rawRows[row];
    // Check if row is empty
    const hasData = rowData.some(cell => String(cell ?? '').trim() !== '');
    if (!hasData) continue;
    totalRows++;

    const getName = (col: number | null): string | null => {
      if (col === null || col >= rowData.length) return null;
      const v = String(rowData[col] ?? '').trim();
      return v || null;
    };
    const getNum = (col: number | null): number | null => {
      if (col === null || col >= rowData.length) return null;
      const v = String(rowData[col] ?? '').replace(',', '.').replace(/\s/g, '');
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };

    const name = getName(mapping.name);
    if (!name) {
      skippedRows++;
      errors.push(`Строка ${row + 1}: пропущена — отсутствует наименование`);
      continue;
    }

    items.push({
      position_number: getName(mapping.position_number),
      name,
      characteristics: getName(mapping.characteristics),
      equipment_code: getName(mapping.equipment_code),
      article: getName(mapping.article),
      product_code: getName(mapping.product_code),
      marking: getName(mapping.marking),
      type_size: getName(mapping.type_size),
      manufacturer: getName(mapping.manufacturer),
      unit: getName(mapping.unit),
      quantity: getNum(mapping.quantity),
      full_name: null,
      _parentIndex: null,
    });
  }

  const processed = mergeMultiline ? mergeMultilineItems(items) : items;
  linkDnChildren(processed);
  return { items: processed, errors, totalRows, skippedRows };
}
