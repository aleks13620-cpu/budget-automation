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
  price: number | null;
  amount: number | null;
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
  price: ['цена', 'стоимость ед', 'цена ед', 'price'],
  amount: ['сумма', 'итого', 'стоимость', 'amount', 'total'],
};

function normalizeText(text: unknown): string {
  if (text === null || text === undefined) return '';
  return String(text).toLowerCase().trim();
}

function postDebugLog(payload: {
  runId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
}): void {
  // #region agent log
  fetch('http://127.0.0.1:7830/ingest/9fee685e-d5a8-428b-a924-a36029ab70bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'acd6be'},body:JSON.stringify({sessionId:'acd6be',runId:payload.runId,hypothesisId:payload.hypothesisId,location:payload.location,message:payload.message,data:payload.data,timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

function detectHeaderRow(sheet: XLSX.WorkSheet): { rowIndex: number; mapping: ColumnMapping } | null {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const candidates: Array<{ row: number; matchCount: number; mapping: ColumnMapping; preview: string[] }> = [];

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
      price: null,
      amount: null,
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
      const candidate = {
        row,
        matchCount,
        mapping: { ...mapping },
        preview: Array.from({ length: Math.min(10, range.e.c - range.s.c + 1) }, (_, i) => {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: range.s.c + i })];
          return String(cell?.v ?? '').trim();
        }),
      };
      candidates.push(candidate);
      postDebugLog({
        runId: 'spec-mapping',
        hypothesisId: 'H3',
        location: 'backend/src/services/excelParser.ts:detectHeaderRow',
        message: 'Header row selected',
        data: {
          selectedRow: row,
          selectedMatchCount: matchCount,
          selectedMapping: mapping,
          selectedPreview: candidate.preview,
          scannedRows: Math.min(range.e.r, 30) + 1,
        },
      });
      return { rowIndex: row, mapping };
    }
  }

  postDebugLog({
    runId: 'spec-mapping',
    hypothesisId: 'H3',
    location: 'backend/src/services/excelParser.ts:detectHeaderRow',
    message: 'Header row detection fallback details',
    data: {
      scannedRows: Math.min(range.e.r, 30) + 1,
      candidates,
    },
  });

  return null;
}

/**
 * Авто-определение строки заголовка и маппинга колонок из сырых строк (string[][]).
 * Используется в редакторе спецификации когда нет сохранённого конфига.
 */
export function detectMappingFromRawData(rawRows: string[][]): { headerRow: number; columnMapping: ColumnMapping } | null {
  const normalizeCell = (v: unknown) => String(v ?? '').toLowerCase().trim();

  for (let row = 0; row < Math.min(rawRows.length, 30); row++) {
    const rowData = rawRows[row];
    const mapping: ColumnMapping = {
      position_number: null, name: null, characteristics: null, equipment_code: null,
      article: null, product_code: null, marking: null, type_size: null,
      manufacturer: null, unit: null, quantity: null, price: null, amount: null,
    };
    let matchCount = 0;
    const usedCols = new Set<number>();

    for (let col = 0; col < rowData.length; col++) {
      const cellText = normalizeCell(rowData[col]);
      if (!cellText) continue;

      for (const [field, keywords] of Object.entries(HEADER_KEYWORDS)) {
        const key = field as keyof ColumnMapping;
        if (mapping[key] !== null || usedCols.has(col)) continue;
        for (const keyword of keywords) {
          if (cellText.includes(keyword.toLowerCase())) {
            mapping[key] = col;
            usedCols.add(col);
            matchCount++;
            break;
          }
        }
      }
    }

    if (mapping.name !== null && matchCount >= 2) {
      postDebugLog({
        runId: 'spec-mapping',
        hypothesisId: 'H1',
        location: 'backend/src/services/excelParser.ts:detectMappingFromRawData',
        message: 'Auto mapping detected from raw data',
        data: {
          headerRow: row,
          mapping,
          headerPreview: rowData.slice(0, 16),
        },
      });
      return { headerRow: row, columnMapping: mapping };
    }
  }
  postDebugLog({
    runId: 'spec-mapping',
    hypothesisId: 'H1',
    location: 'backend/src/services/excelParser.ts:detectMappingFromRawData',
    message: 'Auto mapping not detected',
    data: {
      scannedRows: Math.min(rawRows.length, 30),
      firstRowPreview: rawRows[0]?.slice(0, 16) ?? [],
    },
  });
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

/**
 * "То же" child pattern — строка ссылается на предыдущую позицию ("то же, но другой размер").
 * Является ОТДЕЛЬНОЙ позицией, но для матчера нужен full_name с контекстом родителя.
 */
const TO_ZHE_PATTERN = /^то\s+же/i;

/**
 * Continuation keyword pattern — строки, начинающиеся с этих слов,
 * являются продолжением описания предыдущей позиции даже если имеют
 * собственные единицы/количество (например, детализация размера/материала).
 */
const CONTINUATION_KEYWORD_PATTERN = /^(толщиной|толщ\.|сечение|сеч\.|длиной|дл\.|шириной|высотой|диаметром|ø|h=|l=|w=|b=|с\s+нанесением|с\s+покрытием|класса\s+герметичности)/i;
const PARAMETER_CHILD_PATTERN = /^(δ|d|du|dn|ø|⌀)\s*=?\s*\d{1,4}|\b\d{1,4}\s*[xх×]\s*\d{1,4}\b|^\d{2,4}[xх×]\d{2,4}$/i;

function isDnChild(item: SpecificationRow): boolean {
  return !item.position_number && DN_CHILD_PATTERN.test(item.name.trim());
}

function isToZheChild(item: SpecificationRow): boolean {
  return TO_ZHE_PATTERN.test(item.name.trim());
}

function isContinuationByKeyword(item: SpecificationRow): boolean {
  return item.position_number === null && CONTINUATION_KEYWORD_PATTERN.test(item.name.trim());
}

function isParameterizedChild(item: SpecificationRow): boolean {
  const name = item.name.trim();
  if (!name) return false;
  // Parameter rows are typically short size/designation values and should
  // inherit parent context for matching while staying separate line items.
  if (PARAMETER_CHILD_PATTERN.test(name)) return true;
  if (/^[A-Za-zА-Яа-я]{0,4}\d{2,4}[-xх×]\d{2,4}([-\s]\d{2,4})?$/i.test(name)) return true;
  return false;
}

function mergeMultilineItems(items: SpecificationRow[]): SpecificationRow[] {
  const result: SpecificationRow[] = [];
  let mergedByKeyword = 0;
  let mergedByEmpty = 0;
  let sizeLikeRowsSeen = 0;
  let sizeLikeRowsMerged = 0;
  const sizeLikeRowsSample: Array<{
    name: string;
    position_number: string | null;
    quantity: number | null;
    unit: string | null;
    treatedAsKeywordContinuation: boolean;
    treatedAsEmptyContinuation: boolean;
  }> = [];
  for (const item of items) {
    // Явное продолжение по ключевым словам — объединяем в предыдущую позицию
    // даже если у строки есть своя единица/кол-во (берём данные родителя)
    const isByKeyword = isContinuationByKeyword(item) && !isDnChild(item);
    // Классическое продолжение — нет позиции, кол-ва и единицы
    const isByEmpty =
      item.position_number === null &&
      item.quantity === null &&
      item.unit === null &&
      !isDnChild(item);
    const looksLikeSizeSuffix = /^(δ|d|du|dn|ø|⌀)\s*=?\s*\d{1,4}|\b\d{1,4}\s*[xх×]\s*\d{1,4}\b/i.test(item.name.trim());
    if (looksLikeSizeSuffix) {
      sizeLikeRowsSeen++;
      if (sizeLikeRowsSample.length < 20) {
        sizeLikeRowsSample.push({
          name: item.name,
          position_number: item.position_number,
          quantity: item.quantity,
          unit: item.unit,
          treatedAsKeywordContinuation: isByKeyword,
          treatedAsEmptyContinuation: isByEmpty,
        });
      }
    }

    if ((isByKeyword || isByEmpty) && result.length > 0) {
      const last = result[result.length - 1];
      last.name = last.name + ' ' + item.name;
      if (last.full_name) last.full_name = last.full_name + ' ' + item.name;
      // при keyword-продолжении: данные родителя сохраняются
      if (isByKeyword) mergedByKeyword++;
      if (isByEmpty) mergedByEmpty++;
      if (looksLikeSizeSuffix) sizeLikeRowsMerged++;
    } else {
      result.push(item);
    }
  }
  postDebugLog({
    runId: 'spec-mapping',
    hypothesisId: 'H6',
    location: 'backend/src/services/excelParser.ts:mergeMultilineItems',
    message: 'Multiline merge diagnostics',
    data: {
      inputCount: items.length,
      outputCount: result.length,
      mergedByKeyword,
      mergedByEmpty,
      sizeLikeRowsSeen,
      sizeLikeRowsMerged,
      sizeLikeRowsSample,
    },
  });
  return result;
}

/**
 * Link DN sub-rows and "То же" rows to their parent:
 * - DN children: нет позиции + имя начинается с DN/Ду/числа
 * - "То же" дети: имя начинается с "То же" — отдельная позиция, но
 *   full_name = parent.name + " " + child.name для корректного матчинга
 * - Обычные строки: сбрасывают lastFull (новый "родитель" для следующих)
 */
function linkDnChildren(items: SpecificationRow[]): void {
  let lastFullIndex: number | null = null;
  let parameterChildrenExpanded = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isDnChild(item)) {
      // DN-дочерняя строка — связываем с родителем
      if (lastFullIndex !== null) {
        item._parentIndex = lastFullIndex;
        item.full_name = items[lastFullIndex].name + ' ' + item.name;
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
    } else if (isToZheChild(item)) {
      // "То же" — отдельная позиция с полным самодостаточным наименованием.
      // Разворачиваем: убираем "То же," и добавляем суффикс к имени родителя.
      // Результат записывается в name (для UI и матчера) и full_name.
      if (lastFullIndex !== null) {
        item._parentIndex = lastFullIndex;
        const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
        const suffix = item.name.replace(/^то\s+же[,\s]*/i, '').trim();
        const expandedName = suffix ? parentName + ' ' + suffix : parentName;
        item.name = expandedName;      // самодостаточное имя
        item.full_name = expandedName; // для матчера (совпадает с name)
      } else {
        item._parentIndex = null;
        item.full_name = null;
        // без родителя — оставляем как есть
      }
      // "То же" сам становится родителем для следующего "То же"
      lastFullIndex = i;
    } else if (
      lastFullIndex !== null &&
      isParameterizedChild(item) &&
      item.position_number !== null &&
      items[lastFullIndex].position_number === item.position_number
    ) {
      // Parameterized child line (e.g. "δ=30мм Ø22", "04x018"):
      // keep it as a separate row, but enrich with parent context in full_name.
      item._parentIndex = lastFullIndex;
      const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
      item.full_name = `${parentName} ${item.name}`.trim();
      parameterChildrenExpanded++;
    } else {
      // Обычная позиция — становится новым родителем
      lastFullIndex = i;
      item._parentIndex = null;
      item.full_name = null;
    }
  }
  postDebugLog({
    runId: 'spec-mapping',
    hypothesisId: 'H7',
    location: 'backend/src/services/excelParser.ts:linkDnChildren',
    message: 'Parent context expansion for parameter child rows',
    data: {
      totalItems: items.length,
      parameterChildrenExpanded,
    },
  });
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

  let articleFilled = 0;
  let productCodeFilled = 0;
  let equipmentCodeFilled = 0;
  let compactRows = 0;
  let compactRowsWithCodeSignals = 0;
  for (const item of processed) {
    if (item.article) articleFilled++;
    if (item.product_code) productCodeFilled++;
    if (item.equipment_code) equipmentCodeFilled++;
    if (/\bcompact\b/i.test(item.name)) {
      compactRows++;
      if (item.article || item.product_code || item.equipment_code || /\bcv?\s*\d{2}[-\s]?\d{2,4}[-\s]?\d{2,4}\b/i.test(item.name)) {
        compactRowsWithCodeSignals++;
      }
    }
  }

  postDebugLog({
    runId: 'spec-mapping',
    hypothesisId: 'H2',
    location: 'backend/src/services/excelParser.ts:parseFromRawData',
    message: 'Parsed spec fields distribution after mapping',
    data: {
      headerRow,
      mapping,
      totalParsed: processed.length,
      articleFilled,
      productCodeFilled,
      equipmentCodeFilled,
      compactRows,
      compactRowsWithCodeSignals,
    },
  });
  return { items: processed, errors, totalRows, skippedRows };
}
