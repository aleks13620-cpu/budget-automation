import * as XLSX from 'xlsx';
import { SpecificationRow, ParseResult } from '../types/specification';

interface ColumnMapping {
  position_number: number | null;
  name: number | null;
  characteristics: number | null;
  equipment_code: number | null;
  manufacturer: number | null;
  unit: number | null;
  quantity: number | null;
}

const HEADER_KEYWORDS: Record<keyof ColumnMapping, string[]> = {
  position_number: ['№', 'п/п', 'поз', 'номер'],
  name: ['наименование', 'название', 'товар', 'материал'],
  characteristics: ['характеристик', 'описание', 'параметр'],
  equipment_code: ['код', 'артикул', 'article'],
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
      manufacturer: mapping.manufacturer !== null ? getCellValue(sheet, row, mapping.manufacturer) : null,
      unit: mapping.unit !== null ? getCellValue(sheet, row, mapping.unit) : null,
      quantity,
    });
  }

  return { items, errors, totalRows, skippedRows };
}
