/**
 * Извлечение таблицы спецификации из PDF-чертежа через GigaChat Files API.
 */

import {
  chatCompletion,
  uploadFile,
  deleteFile,
  getGigaChatFileJsonModelCandidates,
  looksLikeGigaChatNonJsonRefusal,
} from './gigachatService';
import { extractJSON, sanitizeJSON, readPdfText } from './gigachatParser';
import { sha256File, getGigaChatFileCache, setGigaChatFileCache } from './gigachatFileCache';
import type { ParseResult, SpecificationRow } from '../types/specification';
import { evaluateSpecPdfParseQuality } from './gigachatSpecParseQuality';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const PDF_TEXT_HINT_MAX = 40000;
/** Меньше символов — считаем сканом (как в плане для счетов). */
const SCAN_TEXT_THRESHOLD = 200;

// ---------------------------------------------------------------------------
// Промпт (формат как INVOICE_PROMPT: JSON, self-check)
// ---------------------------------------------------------------------------

const SPECIFICATION_PROMPT = `
Ты — эксперт по извлечению таблиц из российских проектных чертежей и спецификаций.

ЗАДАЧА: Найти на документе таблицу спецификации оборудования / материалов и извлечь строки в JSON.
Работай как сканер — копируй текст из документа, не выдумывай позиции.

═══════════════════════════════════════
ГДЕ ИСКАТЬ ТАБЛИЦУ:
═══════════════════════════════════════
Ищи заголовки вроде:
- «Спецификация оборудования»
- «Ведомость материалов и изделий»
- «Ведомость материалов»
- «Экспликация»
- «Спецификация»

Если документ многостраничный — ищи продолжение таблицы на всех страницах.
Если несколько таблиц — объедини релевантные строки в один массив items (оборудование и материалы по разделу).
Если внутри таблицы есть строки-заголовки разделов (например «I. Оборудование», «II. Материалы»), пропускай их — бери только строки с конкретным наименованием и количеством.

═══════════════════════════════════════
ВАЖНО: СТРОКИ БЕЗ НОМЕРА ПОЗИЦИИ
═══════════════════════════════════════
Строки без значения в колонке «Позиция» — это дочерние варианты (типоразмеры, DN, «То же») родительской строки выше. ОБЯЗАТЕЛЬНО включай их в items. У них:
- position = null
- name = текст из колонки «Наименование» (например «C11-300-500», «DN 50», «То же, 300x200»)
- unit, quantity, characteristics — как указано в строке документа

Пример: если под строкой «Радиатор С 11, шт, 13» идут строки «C11-300-500, шт, 1», «C11-300-600, шт, 1» без номеров — включи их ВСЕ в items с position: null.

═══════════════════════════════════════
ПРОВЕРЬ СЕБЯ ПЕРЕД ОТВЕТОМ:
═══════════════════════════════════════
1. Посчитай ВСЕ строки таблицы с непустым наименованием (по всем страницам!), включая строки без номера позиции
2. Посчитай элементы в массиве items
3. Числа должны совпадать (проверь что строки без номеров позиций тоже включены и имеют position: null)
4. У каждой позиции должно быть непустое name

═══════════════════════════════════════
ПРАВИЛА:
═══════════════════════════════════════
- position — номер позиции из первой колонки. Может быть числом (1) или строкой ("1а", "3.1") — передавай как есть
- name — наименование / обозначение
- characteristics — технические данные, марка, ГОСТ, если в отдельной колонке; иначе null
- manufacturer — завод-изготовитель / производитель, если указан; иначе null
- marking — маркировка / артикул, если указан в отдельной колонке; иначе null
- type_size — типоразмер (Ду, DN, диаметр и т.п.), если указан в отдельной колонке; иначе null
- unit — единица измерения (м, шт, компл, кг и т.д.) или null
- quantity — число; если не указано, null
- note — примечание, если есть колонка «Примечание»; иначе null
- Числа в JSON: 10.5 без кавычек
- Дробная запятая в документе → точка в JSON

═══════════════════════════════════════
ОТВЕТ — ТОЛЬКО JSON:
═══════════════════════════════════════

{
  "section": "краткое название раздела или null",
  "items_count_check": "N позиций в таблице, N в массиве — ОК",
  "items": [
    {
      "position": 1,
      "name": "наименование",
      "characteristics": null,
      "manufacturer": null,
      "marking": null,
      "type_size": null,
      "unit": "шт",
      "quantity": 2.0,
      "note": null
    }
  ]
}
`;

interface GigaChatSpecPdfJSON {
  section?: string | null;
  items_count_check?: string | null;
  items?: Array<{
    position?: number | string | null;
    name?: string | null;
    characteristics?: string | null;
    manufacturer?: string | null;
    marking?: string | null;
    type_size?: string | null;
    unit?: string | null;
    quantity?: number | null;
    note?: string | null;
  }>;
}

const SECTION_HEADER_PATTERN = /^(вентиляция|отопление|водоснабжение|канализация|тепломеханика|автоматизация|кондиционирование|электрика|слаботочка|материалы|оборудование|раздел)\b/i;
const DN_CHILD_PATTERN = /^(DN|Ду|d=|D=|du)?\s*\d{2,}(\s|$|[xX×\/\-])/i;
const TO_ZHE_PATTERN = /^то\s+же/i;
const PARAMETER_CHILD_PATTERN = /^(δ|d|du|dn|ø|⌀)\s*=?\s*\d{1,4}|\b\d{1,4}\s*[xх×]\s*\d{1,4}\b|^\d{2,4}[xх×]\d{2,4}$/i;
const VARIANT_CODE_PATTERN = /^[A-Za-zА-Яа-я]{1,3}\s?\d{1,4}([-_]\d{2,4}){1,3}$/;

function isSectionHeaderRow(name: string, quantity: number | null, unit: string | null): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (quantity != null) return false;
  if (unit && unit.trim().length > 0) return false;
  if (TO_ZHE_PATTERN.test(name.trim())) return false;
  if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)\.?\s+/i.test(normalized)) return true;
  if (SECTION_HEADER_PATTERN.test(normalized)) return true;
  return /^[а-яa-z\s/-]{3,40}$/.test(normalized) && normalized.split(/\s+/).length <= 3;
}

function splitMonsterRow(name: string): string[] {
  const normalized = name.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const separators = (normalized.match(/[+;•]/g) || []).length;
  if (separators < 2) return [normalized];
  const parts = normalized
    .split(/[+;•]/)
    .map(part => part.trim().replace(/^[-–—]\s*/, ''))
    .filter(part => part.length >= 3);
  return parts.length >= 2 ? parts : [normalized];
}

function isDnChild(name: string, positionNumber: string | null): boolean {
  return !positionNumber && DN_CHILD_PATTERN.test(name.trim());
}

function isToZheChild(name: string): boolean {
  return TO_ZHE_PATTERN.test(name.trim());
}

function isParameterizedChild(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  if (PARAMETER_CHILD_PATTERN.test(normalized)) return true;
  if (/^[A-Za-zА-Яа-я]{0,4}\d{2,4}[-xх×]\d{2,4}([-\s]\d{2,4})?$/i.test(normalized)) return true;
  return false;
}

function linkPdfParentChildren(items: SpecificationRow[]): void {
  let lastFullIndex: number | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (isDnChild(item.name, item.position_number)) {
      if (lastFullIndex !== null) {
        item._parentIndex = lastFullIndex;
        item.full_name = `${items[lastFullIndex].name} ${item.name}`.trim();
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
      continue;
    }

    if (isToZheChild(item.name)) {
      if (lastFullIndex !== null) {
        item._parentIndex = lastFullIndex;
        const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
        const suffix = item.name.replace(/^то\s+же[,\s]*/i, '').trim();
        const expandedName = suffix ? `${parentName} ${suffix}` : parentName;
        item.name = expandedName;
        item.full_name = expandedName;
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
      lastFullIndex = i;
      continue;
    }

    if (
      lastFullIndex !== null &&
      isParameterizedChild(item.name) &&
      item.position_number !== null &&
      items[lastFullIndex].position_number === item.position_number
    ) {
      item._parentIndex = lastFullIndex;
      const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
      item.full_name = `${parentName} ${item.name}`.trim();
      continue;
    }

    if (
      lastFullIndex !== null &&
      item.position_number === null &&
      VARIANT_CODE_PATTERN.test(item.name)
    ) {
      item._parentIndex = lastFullIndex;
      const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
      item.full_name = `${parentName} ${item.name}`.trim();
      continue;
    }

    lastFullIndex = i;
    item._parentIndex = null;
    item.full_name = null;
  }
}

export function mapPdfItemsToRows(data: GigaChatSpecPdfJSON): SpecificationRow[] {
  const items = data.items ?? [];
  const rows: SpecificationRow[] = [];
  for (const it of items) {
    const name = (it.name ?? '').trim();
    if (!name) continue;
    const pos = it.position;
    const position_number =
      pos === null || pos === undefined ? null : String(pos).trim() || null;
    const quantity = typeof it.quantity === 'number' ? it.quantity : null;
    const unit = it.unit?.trim() || null;
    if (isSectionHeaderRow(name, quantity, unit)) continue;

    const splitNames = splitMonsterRow(name);
    splitNames.forEach((splitName, idx) => {
      rows.push({
        position_number: idx === 0 ? position_number : null,
        name: splitName,
        characteristics: it.characteristics?.trim() || null,
        equipment_code: null,
        article: null,
        product_code: null,
        marking: it.marking?.trim() || null,
        type_size: it.type_size?.trim() || null,
        manufacturer: it.manufacturer?.trim() || null,
        unit,
        quantity: idx === 0 ? quantity : null,
        full_name: null,
        _parentIndex: null,
      });
    });
  }
  linkPdfParentChildren(rows);
  return rows;
}

function buildUserContent(isScan: boolean, pdfText: string): string {
  if (isScan) {
    return (
      'Это скан документа (текст из PDF почти отсутствует). Внимательно разбери изображение вложенного файла ' +
      'и извлеки таблицу спецификации согласно системной инструкции.'
    );
  }
  const hint = pdfText.slice(0, PDF_TEXT_HINT_MAX);
  return (
    'Ниже извлечённый текст из PDF (для ориентира). Обязательно сверь с вложенным файлом и извлеки таблицу спецификации.\n\n' +
    '---\n' +
    hint +
    '\n---'
  );
}

/** Сырые строки для specification.raw_data (совместимость с редактором). */
export function buildRawDataFromPdfItems(rows: SpecificationRow[]): string[][] {
  const header = ['№', 'Наименование', 'Характеристики', 'Ед.', 'Кол-во'];
  const body = rows.map(r => [
    r.position_number ?? '',
    r.name,
    r.characteristics ?? '',
    r.unit ?? '',
    r.quantity != null ? String(r.quantity) : '',
  ]);
  return [header, ...body];
}

export const PDF_SPEC_EMPTY_RAW_DATA: string[][] = [
  ['№', 'Наименование', 'Характеристики', 'Ед.', 'Кол-во'],
];

/**
 * Парсит PDF-чертёж: загрузка в Files API + GigaChat (как parsePdfViaFileApi для счетов).
 */
export async function parseSpecFromPdf(filePath: string): Promise<ParseResult> {
  try {
    const cached = getGigaChatFileCache(sha256File(filePath), 'spec_pdf');
    if (cached) {
      console.log('[parseSpecFromPdf] spec_pdf cache hit');
      return JSON.parse(cached) as ParseResult;
    }
  } catch (e) {
    console.warn(`[parseSpecFromPdf] cache read failed: ${e instanceof Error ? e.message : e}`);
  }

  const mimeType = 'application/pdf';
  let fileId: string | null = null;
  let rawResponse = '';
  let lastError: Error | null = null;
  const models = getGigaChatFileJsonModelCandidates();

  let pdfText = '';
  try {
    pdfText = (await readPdfText(filePath)).trim();
  } catch (e) {
    console.warn(`[parseSpecFromPdf] readPdfText: ${e instanceof Error ? e.message : e}`);
  }
  const isScan = pdfText.length <= SCAN_TEXT_THRESHOLD;
  const userContent = buildUserContent(isScan, pdfText);

  // --- pdfplumber-first approach (for non-scan PDFs) ---
  if (!isScan) {
    try {
      console.log('[parseSpecFromPdf] pdfplumber: trying local extraction...');
      const scriptPath = path.resolve(__dirname, '../../../scripts/extract_pdf_table.py');
      const { stdout } = await execFileAsync('python3', ['-X', 'utf8', scriptPath, filePath], {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const pdfplumberResult = JSON.parse(stdout) as {
        items: Array<{
          position?: string | null;
          name?: string;
          characteristics?: string | null;
          equipment_code?: string | null;
          manufacturer?: string | null;
          unit?: string | null;
          quantity?: string | number | null;
          mass_per_unit?: string | number | null;
          total_mass?: string | number | null;
          note?: string | null;
        }>;
      };
      const pdfplumberRows: SpecificationRow[] = [];
      for (const item of pdfplumberResult.items) {
        const name = (item.name ?? '').trim();
        if (!name) continue;
        const position_number = item.position != null ? String(item.position).trim() || null : null;
        const quantity = item.quantity != null ? (isNaN(Number(item.quantity)) ? null : Number(item.quantity)) : null;
        const unit = item.unit?.trim() || null;
        if (isSectionHeaderRow(name, quantity, unit)) continue;

        const splitNames = splitMonsterRow(name);
        splitNames.forEach((splitName, idx) => {
          pdfplumberRows.push({
            position_number: idx === 0 ? position_number : null,
            name: splitName,
            characteristics: item.characteristics?.trim() || null,
            equipment_code: item.equipment_code?.trim() || null,
            article: null,
            product_code: null,
            marking: null,
            type_size: null,
            manufacturer: item.manufacturer?.trim() || null,
            unit,
            quantity: idx === 0 ? quantity : null,
            full_name: null,
            _parentIndex: null,
          });
        });
      }
      linkPdfParentChildren(pdfplumberRows);
      console.log(`[parseSpecFromPdf] pdfplumber: extracted ${pdfplumberRows.length} items`);
      if (pdfplumberRows.length > 0) {
        const specParseQuality = { warnings: [] as string[], suggestElevatedReview: false };
        const okRes: ParseResult = {
          items: pdfplumberRows,
          errors: [],
          totalRows: pdfplumberRows.length,
          skippedRows: 0,
          specParseQuality,
        };
        try {
          setGigaChatFileCache(sha256File(filePath), 'spec_pdf', JSON.stringify(okRes));
        } catch (e) {
          console.warn(`[parseSpecFromPdf] cache write: ${e instanceof Error ? e.message : e}`);
        }
        return okRes;
      }
    } catch (error: any) {
      console.warn('[parseSpecFromPdf] pdfplumber failed, falling back to GigaChat:', error.message);
    }
  }

  try {
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (!fileId) {
            fileId = await uploadFile(filePath, mimeType);
          }

          rawResponse = await chatCompletion(
            [
              { role: 'system', content: SPECIFICATION_PROMPT },
              {
                role: 'user',
                content: userContent,
                attachments: [fileId],
              },
            ],
            { model, temperature: 0.1, maxTokens: 16384 },
          );

          if (looksLikeGigaChatNonJsonRefusal(rawResponse)) {
            throw new Error(
              `Модель ${model} отказалась разобрать PDF: ${rawResponse.trim().slice(0, 280)}`,
            );
          }

          const jsonStr = sanitizeJSON(extractJSON(rawResponse));
          const parsed: GigaChatSpecPdfJSON = JSON.parse(jsonStr);
          const items = mapPdfItemsToRows(parsed);
          const specParseQuality = evaluateSpecPdfParseQuality(parsed.items, items);

          if (items.length === 0) {
            const emptyRes: ParseResult = {
              items: [],
              errors: [],
              totalRows: 0,
              skippedRows: 0,
              category: 'C',
              categoryReason: 'Не удалось извлечь спецификацию из PDF, загрузите Excel',
              specParseQuality,
            };
            try {
              setGigaChatFileCache(sha256File(filePath), 'spec_pdf', JSON.stringify(emptyRes));
            } catch (e) {
              console.warn(`[parseSpecFromPdf] cache write: ${e instanceof Error ? e.message : e}`);
            }
            return emptyRes;
          }

          const okRes: ParseResult = {
            items,
            errors: [],
            totalRows: items.length,
            skippedRows: 0,
            specParseQuality,
          };
          try {
            setGigaChatFileCache(sha256File(filePath), 'spec_pdf', JSON.stringify(okRes));
          } catch (e) {
            console.warn(`[parseSpecFromPdf] cache write: ${e instanceof Error ? e.message : e}`);
          }
          return okRes;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.warn(`[parseSpecFromPdf] model=${model} attempt=${attempt}: ${lastError.message}`);
          const msg = lastError.message;
          if (msg.includes('404') && msg.includes('No such model')) break;
          if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    return {
      items: [],
      errors: [
        `GigaChat (спецификация PDF): не удалось распознать (модели: ${models.join(', ')}). ${lastError?.message ?? ''}`.trim(),
      ],
      totalRows: 0,
      skippedRows: 0,
    };
  } finally {
    if (fileId) {
      await deleteFile(fileId).catch(e =>
        console.warn(`[parseSpecFromPdf] deleteFile: ${e instanceof Error ? e.message : e}`)
      );
    }
  }
}
