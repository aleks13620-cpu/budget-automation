/**
 * Извлечение таблицы спецификации из PDF-чертежа через GigaChat Files API.
 */

import {
  chatCompletion,
  uploadFile,
  deleteFile,
  getGigaChatFileJsonModelCandidates,
  looksLikeGigaChatNonJsonRefusal,
  isGigaChatConfigured,
} from './gigachatService';
import { extractJSON, sanitizeJSON, readPdfText } from './gigachatParser';
import { sha256File, getGigaChatFileCache, setGigaChatFileCache } from './gigachatFileCache';
import type { ParseResult, SpecificationRow } from '../types/specification';
import {
  evaluateSpecPdfParseQuality,
  LOW_QUALITY_NOPOS_FRACTION,
} from './gigachatSpecParseQuality';
import { applyVariantMarkersToItems } from './variantMarkers';
import { parseSpecPdfWithGemini } from './geminiSpecFromPdf';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

const PDF_TEXT_HINT_MAX = 40000;
/** Меньше символов — считаем сканом (как в плане для счетов). */
const SCAN_TEXT_THRESHOLD = 200;

/** Bump when parser logic changes to auto-bypass stale cache. */
const SPEC_PDF_PARSER_VERSION = 5;

// ---------------------------------------------------------------------------
// Промпт (формат как INVOICE_PROMPT: JSON, self-check)
// ---------------------------------------------------------------------------

export const SPECIFICATION_PROMPT = `
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
ВАЖНО: СТРОКИ БЕЗ НОМЕРА ПОЗИЦИИ + ИЕРАРХИЯ
═══════════════════════════════════════
Строки без значения в колонке «Позиция» — это дочерние варианты (типоразмеры, DN, «То же») родительской строки выше. ОБЯЗАТЕЛЬНО включай их в items. У них:
- position = null
- name = текст из колонки «Наименование» (например «C11-300-500», «DN 50», «То же, 300x200»)
- unit, quantity, characteristics — как указано в строке документа

Пример: если под строкой «Радиатор С 11, шт, 13» идут строки «C11-300-500, шт, 1», «C11-300-600, шт, 1» без номеров — включи их ВСЕ в items с position: null.

ОБЯЗАТЕЛЬНО для КАЖДОЙ дочерней строки (position = null) укажи, к какому родителю она относится — ровно один признак:
- parent_position — номер позиции родительской строки, ЕСЛИ у родителя есть номер в колонке «Позиция»;
- parent_name_hint — наименование родительской строки (как в её поле name, можно первые 4–6 слов), ЕСЛИ у родителя номера НЕТ.
Предпочитай parent_position, когда номер родителя виден. Если в документе вообще нет колонки «Позиция» — у всех дочерних строк заполняй parent_name_hint.
У родительских строк (со своим наименованием) parent_position и parent_name_hint = null.

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
- parent_position — ТОЛЬКО для строки с position = null: номер позиции её родителя (числом/строкой как в документе); у остальных null
- parent_name_hint — ТОЛЬКО для строки с position = null и БЕЗ номера у родителя: имя родительской строки (как в её поле name); у остальных null
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
      "name": "наименование родителя",
      "characteristics": null,
      "manufacturer": null,
      "marking": null,
      "type_size": null,
      "unit": "шт",
      "quantity": 2.0,
      "note": null,
      "parent_position": null,
      "parent_name_hint": null
    },
    {
      "position": null,
      "name": "C11-300-500",
      "characteristics": null,
      "manufacturer": null,
      "marking": null,
      "type_size": null,
      "unit": "шт",
      "quantity": 1.0,
      "note": null,
      "parent_position": 1,
      "parent_name_hint": null
    }
  ]
}
`;

export interface GigaChatSpecPdfJSON {
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
    /** LLM-разметка иерархии: № родителя для дочерней строки (position=null). */
    parent_position?: number | string | null;
    /** LLM-разметка иерархии: имя родителя, когда у родителя нет номера. */
    parent_name_hint?: string | null;
  }>;
}

const SECTION_HEADER_PATTERN = /^(вентиляция|отопление|водоснабжение|канализация|тепломеханика|автоматизация|кондиционирование|электрика|слаботочка|материалы|оборудование|раздел)\b/i;
const DN_CHILD_PATTERN = /^(DN|Ду|Дн|d=|D=|du)\s*\d{2,}(\s|$|[xXхХ×\/\-,])/i;
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
  if (normalized.length > 25) return false;
  if (PARAMETER_CHILD_PATTERN.test(normalized)) return true;
  if (/^[A-Za-zА-Яа-я]{0,4}\d{2,4}[-xх×]\d{2,4}([-\s]\d{2,4})?$/i.test(normalized)) return true;
  return false;
}

function isChildPattern(name: string): boolean {
  const trimmed = name.trim();
  if (DN_CHILD_PATTERN.test(trimmed)) return true;
  if (isParameterizedChild(trimmed)) return true;
  if (VARIANT_CODE_PATTERN.test(trimmed)) return true;
  return false;
}

/** LLM-разметка иерархии по СМЫСЛУ (а не по номеру), выровнена по индексам items. */
export interface ParentHint {
  position: string | null;
  name: string | null;
}

/** Нормализация имени для нечёткого сопоставления родителя по имени. */
function normName(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

/** Коэффициент Дайса по биграммам (0..1) — без внешних зависимостей. */
function diceBigram(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Подстрока (имя-подсказка часто = начало полного имени родителя).
  if (a.length >= 4 && (b.includes(a) || a.includes(b))) return 0.9;
  return diceBigram(a, b);
}

const NAME_HINT_MIN_SIMILARITY = 0.5;
/** Не сканировать слишком далеко назад в очень больших спеках. */
const HINT_LOOKBACK_LIMIT = 600;

/**
 * Найти родителя для дочерней строки по LLM-подсказке (parent_position/parent_name_hint).
 * Возвращает индекс родителя в items или null, если подсказка не разрешилась —
 * тогда вызывающий код откатывается на текущую эвристику по номеру/паттерну.
 */
function resolveHintedParent(
  items: SpecificationRow[],
  childIdx: number,
  hint: ParentHint,
): number | null {
  const minJ = Math.max(0, childIdx - HINT_LOOKBACK_LIMIT);

  // 1) По номеру родителя — точное совпадение position_number ближайшей строки выше.
  if (hint.position) {
    for (let j = childIdx - 1; j >= minJ; j--) {
      const pn = items[j].position_number;
      if (pn != null && pn.trim() === hint.position) return j;
    }
  }

  // 2) По имени родителя — ближайшая родительская/самостоятельная строка
  //    (не уже-привязанный ребёнок) с достаточным сходством имени.
  if (hint.name) {
    const target = normName(hint.name);
    if (target) {
      let best = -1;
      let bestScore = 0;
      for (let j = childIdx - 1; j >= minJ; j--) {
        if (items[j]._parentIndex !== null) continue; // пропускаем уже-привязанных детей
        const cand = normName(items[j].full_name || items[j].name);
        if (!cand) continue;
        const score = nameSimilarity(target, cand);
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      if (best >= 0 && bestScore >= NAME_HINT_MIN_SIMILARITY) return best;
    }
  }

  return null;
}

function linkPdfParentChildren(
  items: SpecificationRow[],
  hints?: Array<ParentHint | null>,
): Set<number> {
  let lastParentIndex: number | null = null;
  let accumulatedName: string = '';
  const continuationIndices = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // New parent: has position_number
    if (item.position_number !== null) {
      lastParentIndex = i;
      accumulatedName = item.name;
      item._parentIndex = null;
      item.full_name = null;
      continue;
    }

    // LLM-якорь иерархии: ребёнок сам сообщает родителя (по номеру или имени).
    // Доверяем подсказке выше эвристик-паттернов; срабатывает только для строк
    // без своего номера. Если подсказка не разрешилась — откат на старую логику.
    const hint = hints?.[i] ?? null;
    if (hint && (hint.position || hint.name)) {
      const pIdx = resolveHintedParent(items, i, hint);
      if (pIdx !== null) {
        item._parentIndex = pIdx;
        const rootName = items[pIdx].full_name || items[pIdx].name;
        item.full_name = `${rootName} ${item.name}`.trim();
        // Лист: НЕ обновляем lastParentIndex/accumulatedName (как у «То же»).
        continue;
      }
    }

    // "То же" — sibling that references the same root parent with an optional
    // size/type modifier. Each "То же" expands ROOT name + own suffix; it does
    // NOT inherit modifiers from previous "То же" siblings (no cascading) and
    // does NOT become the parent for subsequent children.
    if (isToZheChild(item.name)) {
      if (lastParentIndex !== null) {
        item._parentIndex = lastParentIndex;
        const suffix = item.name.replace(/^то\s+же[,\s]*/i, '').trim();
        const rootName = items[lastParentIndex].full_name || items[lastParentIndex].name;
        const expandedName = suffix ? `${rootName} ${suffix}` : rootName;
        item.name = expandedName;
        item.full_name = expandedName;
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
      // Intentionally do NOT update lastParentIndex / accumulatedName —
      // next sibling "То же" and any subsequent variant/DN child must still
      // bind to the root parent (B.4 fix, 2026-05-16).
      continue;
    }

    // Continuation: no metadata signaling an independent item, not a child pattern.
    // unit/manufacturer being non-null means it's a real spec line (qty may be missing
    // because pdfplumber didn't extract it) — don't merge into the previous parent.
    if (
      lastParentIndex !== null &&
      item.quantity == null &&
      item.unit == null &&
      item.manufacturer == null &&
      !isChildPattern(item.name)
    ) {
      accumulatedName = `${accumulatedName} ${item.name}`.trim();
      items[lastParentIndex].full_name = accumulatedName;
      item._parentIndex = lastParentIndex;
      item.full_name = null;
      continuationIndices.add(i);
      continue;
    }

    // DN child
    if (isDnChild(item.name, item.position_number)) {
      if (lastParentIndex !== null) {
        item._parentIndex = lastParentIndex;
        item.full_name = `${accumulatedName} ${item.name}`.trim();
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
      continue;
    }

    // Parameterized child with matching position
    if (
      lastParentIndex !== null &&
      isParameterizedChild(item.name) &&
      item.position_number !== null &&
      items[lastParentIndex].position_number === item.position_number
    ) {
      item._parentIndex = lastParentIndex;
      item.full_name = `${accumulatedName} ${item.name}`.trim();
      continue;
    }

    // Variant code child
    if (
      lastParentIndex !== null &&
      item.position_number === null &&
      VARIANT_CODE_PATTERN.test(item.name)
    ) {
      item._parentIndex = lastParentIndex;
      item.full_name = `${accumulatedName} ${item.name}`.trim();
      continue;
    }

    // Standalone item (new parent without position)
    lastParentIndex = i;
    accumulatedName = item.name;
    item._parentIndex = null;
    item.full_name = null;
  }

  // CHOKEPOINT: after the hierarchy is linked and full_name assembled, subtract
  // generic variant markers (исполнение/подключение/dп=N мм/Q=…Вт/N этаж/N Вт)
  // from the match key (name + full_name) and fold them into characteristics.
  // Pure, product/supplier-agnostic; bare-orphan rows are left untouched. Runs
  // BEFORE the parse-quality gate so bareOrphanFraction reflects the final state.
  applyVariantMarkersToItems(items);

  return continuationIndices;
}

function filterContinuations(items: SpecificationRow[], continuations: Set<number>): SpecificationRow[] {
  if (continuations.size === 0) return items;
  const indexMap = new Map<number, number>();
  let newIdx = 0;
  for (let i = 0; i < items.length; i++) {
    if (!continuations.has(i)) indexMap.set(i, newIdx++);
  }
  const result: SpecificationRow[] = [];
  for (let i = 0; i < items.length; i++) {
    if (continuations.has(i)) continue;
    const item = items[i];
    if (item._parentIndex !== null) {
      item._parentIndex = indexMap.get(item._parentIndex) ?? null;
    }
    result.push(item);
  }
  return result;
}

export function mapPdfItemsToRows(data: GigaChatSpecPdfJSON): SpecificationRow[] {
  const items = data.items ?? [];
  const rows: SpecificationRow[] = [];
  const hints: Array<ParentHint | null> = [];
  for (const it of items) {
    const name = (it.name ?? '').trim();
    if (!name) continue;
    const pos = it.position;
    const position_number =
      pos === null || pos === undefined ? null : String(pos).trim() || null;
    const quantity = typeof it.quantity === 'number' && !isNaN(it.quantity) ? it.quantity : null;
    const unit = it.unit?.trim() || null;
    if (isSectionHeaderRow(name, quantity, unit)) continue;

    const ph = it.parent_position;
    const parentPosition = ph === null || ph === undefined ? null : String(ph).trim() || null;
    const parentNameHint = it.parent_name_hint?.trim() || null;
    const hint: ParentHint | null =
      parentPosition || parentNameHint ? { position: parentPosition, name: parentNameHint } : null;

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
      // Подсказку иерархии несёт только первичный сплит (idx 0) исходной строки.
      hints.push(idx === 0 ? hint : null);
    });
  }
  const continuations = linkPdfParentChildren(rows, hints);
  return filterContinuations(rows, continuations);
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
 * Кеширует результат парса под ключом sha256(файла), КРОМЕ hardBlock-результатов.
 *
 * FIX-2 (feedback_no_corrupt_through): когда LLM недоступен и парс свалился в
 * низкокачественный pdfplumber-фолбэк (иерархия развалена, `hardBlock=true`), писать
 * его в кеш на 30 дней НЕЛЬЗЯ — иначе повторная загрузка ТОГО ЖЕ PDF (даже когда
 * GigaChat/Gemini поднялись) отдаст кеш с 422, минуя LLM, а workaround «копия с другим
 * именем» не спасает (ключ = содержимое). Не закешировав hardBlock, мы гарантируем, что
 * следующий аплоад снова пройдёт по LLM-пути. Успешные/приемлемые парсы кешируем как раньше.
 *
 * Экспортируется для детерминированной проверки инварианта в тестах.
 */
export function cacheSpecParseResult(filePath: string, res: ParseResult): void {
  if (res.specParseQuality?.hardBlock) {
    console.warn('[parseSpecFromPdf] hardBlock result NOT cached — retry will re-attempt LLM (no_corrupt_through)');
    return;
  }
  try {
    setGigaChatFileCache(sha256File(filePath), `spec_pdf:v${SPEC_PDF_PARSER_VERSION}`, JSON.stringify(res));
  } catch (e) {
    console.warn(`[parseSpecFromPdf] cache write: ${e instanceof Error ? e.message : e}`);
  }
}

/** Превратить разобранный LLM-JSON в ParseResult (карта строк + качество + кеш). */
function finalizeSpecParse(filePath: string, parsed: GigaChatSpecPdfJSON): ParseResult {
  const items = mapPdfItemsToRows(parsed);
  const specParseQuality = evaluateSpecPdfParseQuality(parsed.items, items);
  const res: ParseResult =
    items.length === 0
      ? {
          items: [],
          errors: [],
          totalRows: 0,
          skippedRows: 0,
          category: 'C',
          categoryReason: 'Не удалось извлечь спецификацию из PDF, загрузите Excel',
          specParseQuality,
        }
      : { items, errors: [], totalRows: items.length, skippedRows: 0, specParseQuality };
  cacheSpecParseResult(filePath, res);
  return res;
}

/**
 * Парсит PDF-чертёж: pdfplumber → (если иерархия развалена) LLM-разметка
 * иерархии через GigaChat, затем Gemini-фолбэк (OpenRouter).
 */
export async function parseSpecFromPdf(filePath: string): Promise<ParseResult> {
  try {
    const cached = getGigaChatFileCache(sha256File(filePath), `spec_pdf:v${SPEC_PDF_PARSER_VERSION}`);
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

  // Низкокачественный результат pdfplumber (иерархия развалена): держим как запасной,
  // но СНАЧАЛА пробуем LLM-разметку иерархии. Если LLM не справится — вернём его
  // с hardBlock из specParseQuality (feedback_no_corrupt_through).
  let pdfplumberFallback: ParseResult | null = null;

  // --- pdfplumber-first approach (for non-scan PDFs) ---
  if (!isScan) {
    try {
      console.log('[parseSpecFromPdf] pdfplumber: trying local extraction...');
      const scriptPath = path.resolve(__dirname, '../../../scripts/extract_pdf_table.py');
      const { stdout } = await execFileAsync(PYTHON_CMD, ['-X', 'utf8', scriptPath, filePath], {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const pdfplumberResult = JSON.parse(stdout) as {
        items: Array<{
          position?: string | null;
          name?: string;
          characteristics?: string | null;
          equipment_code?: string | null;
          marking?: string | null;
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
            marking: item.marking?.trim() || null,
            type_size: null,
            manufacturer: item.manufacturer?.trim() || null,
            unit,
            quantity: idx === 0 ? quantity : null,
            full_name: null,
            _parentIndex: null,
          });
        });
      }
      const pdfContinuations = linkPdfParentChildren(pdfplumberRows);
      const pdfplumberFiltered = filterContinuations(pdfplumberRows, pdfContinuations);
      console.log(`[parseSpecFromPdf] pdfplumber: extracted ${pdfplumberFiltered.length} items (${pdfContinuations.size} continuations merged)`);
      if (pdfplumberFiltered.length > 0) {
        const specParseQuality = evaluateSpecPdfParseQuality(pdfplumberResult.items as any, pdfplumberFiltered);
        const okRes: ParseResult = {
          items: pdfplumberFiltered,
          errors: [],
          totalRows: pdfplumberFiltered.length,
          skippedRows: 0,
          specParseQuality,
        };
        // Принимаем pdfplumber только если качество приемлемое (иерархия не развалена).
        // Иначе — НЕ возвращаем и НЕ кешируем: пробуем LLM-разметку иерархии ниже.
        if (specParseQuality.noPosFraction <= LOW_QUALITY_NOPOS_FRACTION) {
          cacheSpecParseResult(filePath, okRes);
          return okRes;
        }
        console.log(
          `[parseSpecFromPdf] pdfplumber low quality (noPos=${Math.round(specParseQuality.noPosFraction * 100)}%, orphans=${Math.round(specParseQuality.orphanFraction * 100)}%) → trying LLM hierarchy`,
        );
        pdfplumberFallback = okRes;
      }
    } catch (error: any) {
      console.warn('[parseSpecFromPdf] pdfplumber failed, falling back to GigaChat:', error.message);
    }
  }

  try {
    // --- LLM #1: GigaChat Files API (основной путь на проде) ---
    if (isGigaChatConfigured()) {
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

            const parsed: GigaChatSpecPdfJSON = JSON.parse(sanitizeJSON(extractJSON(rawResponse)));
            return finalizeSpecParse(filePath, parsed);
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            console.warn(`[parseSpecFromPdf] model=${model} attempt=${attempt}: ${lastError.message}`);
            const msg = lastError.message;
            if (msg.includes('404') && msg.includes('No such model')) break;
            if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
          }
        }
      }
    } else {
      console.log('[parseSpecFromPdf] GigaChat not configured — using Gemini fallback');
    }

    // --- LLM #2: Gemini (OpenRouter), когда GigaChat недоступен/вернул ошибку ---
    try {
      const gemParsed = await parseSpecPdfWithGemini(filePath, SPECIFICATION_PROMPT, userContent);
      if (gemParsed && (gemParsed.items?.length ?? 0) > 0) {
        console.log(`[parseSpecFromPdf] Gemini fallback: parsed ${gemParsed.items!.length} raw items`);
        return finalizeSpecParse(filePath, gemParsed);
      }
      if (gemParsed) console.warn('[parseSpecFromPdf] Gemini returned 0 items');
    } catch (e) {
      console.warn(`[parseSpecFromPdf] Gemini fallback failed: ${e instanceof Error ? e.message : e}`);
    }

    // LLM не справился. Если есть низкокачественный pdfplumber — возвращаем его;
    // specParseQuality.hardBlock заставит роут отклонить загрузку (no_corrupt_through).
    if (pdfplumberFallback) {
      console.warn('[parseSpecFromPdf] LLM unavailable/failed — returning low-quality pdfplumber result (gate decides)');
      // FIX-2: hardBlock-результат НЕ кешируется → следующий аплоад снова пойдёт в LLM.
      cacheSpecParseResult(filePath, pdfplumberFallback);
      return pdfplumberFallback;
    }

    return {
      items: [],
      errors: [
        `Спецификация PDF: не удалось распознать (GigaChat: ${models.join(', ')}; Gemini-фолбэк недоступен). ${lastError?.message ?? ''}`.trim(),
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
