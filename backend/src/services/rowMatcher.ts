/**
 * Ф14: привязка позиции спецификации к строке ИСХОДНОГО файла (`specifications.raw_data`).
 * Связи «позиция → номер строки» в базе нет (см. план, Ф14) — разбор (excelParser.ts,
 * specifications.ts) не трогаем, строку ищем по содержимому, в порядке файла.
 *
 * Алгоритм (замер на копии прода 18.09, спец. 31/32/33 — см. отчёт Ф14):
 *  - имена нормализуются: `[^0-9a-zа-яё]` вырезается, регистр — нижний (как в python-прототипе
 *    оркестратора, f14_probe.py).
 *  - позиции перебираются по id (порядок файла); для каждой ищем первую ЕЩЁ НЕ занятую строку
 *    начиная с (строка предыдущей находки + 1) — только вперёд, назад не ищем (замер: 0 совпадений
 *    назад по файлу).
 *  - совпадение строки: ЛЮБАЯ её ячейка либо (А) начинается с первых 40 нормализованных символов
 *    имени позиции (исходное правило прототипа — ловит длинные описания), либо (Б) сама является
 *    префиксом полного нормализованного имени и не короче MIN_PREFIX_LEN (ловит имя, склеенное из
 *    НЕСКОЛЬКИХ строк файла excelParser.ts::mergeMultilineItems — первая строка сама по себе
 *    короче 40 символов).
 *  - позиция, для которой рунда А/Б не нашла свободную строку, проверяется ДОПОЛНИТЕЛЬНО против
 *    ПОСЛЕДНЕЙ занятой строки: если имя позиции целиком входит в одну из её ячеек (не короче
 *    MIN_SUBSTRING_LEN) — это `excelParser.ts::splitMonsterRow`, где ОДНА строка файла разошлась
 *    на НЕСКОЛЬКО позиций (например «Трасса для кондиционера (медная труба...; медная труба...;
 *    трубная изоляция...)» → 3 позиции). Такая строка не помечается занятой повторно: следующий
 *    «осколок» тоже может её разделить.
 *  - используется `name`, не `full_name`: full_name у DN/«то же»/параметризованных дочерних строк
 *    (linkDnChildren) — это имя РОДИТЕЛЯ + своё, для матчера цен, а не то, что физически лежит в
 *    ЭТОЙ строке файла; со своим `name` (коротким) они находят свою же строку напрямую.
 *
 * Порог 6/8 символов подобран замером: короче — растёт риск ложной привязки на случайных цифрах
 * («1», «25»); длиннее — теряются короткие, но настоящие совпадения. Итог на копии прода:
 * спец. 31 — 193/193, 32 — 251/259 (8 не найдено — обрывки типа «EI 45», короче порога, дальше
 * не режем: риск ложной привязки на них ощутимее восьми строк), 33 — 156/156.
 */

const MIN_PREFIX_LEN = 6;
const MIN_SUBSTRING_LEN = 8;
const NAME_PREFIX_WINDOW = 40;

export function normalizeCell(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^0-9a-zа-яё]/g, '');
}

export interface RowMatchItem {
  id: number;
  name: string;
}

export interface RowMatchResult {
  /** itemId -> индекс строки в raw_data (0-based, как пришло из JSON.parse) */
  matched: Map<number, number>;
  /** id позиций, для которых строку не нашли */
  unmatched: number[];
}

function cellMatchesPrimary(cell: string, name40: string, fullNorm: string): boolean {
  if (!cell) return false;
  if (name40 && cell.startsWith(name40)) return true;
  if (cell.length >= MIN_PREFIX_LEN && fullNorm.startsWith(cell)) return true;
  return false;
}

function cellMatchesSplitSibling(cell: string, fullNorm: string): boolean {
  return fullNorm.length >= MIN_SUBSTRING_LEN && cell.includes(fullNorm);
}

/**
 * `items` — позиции этой спецификации, УЖЕ отсортированные по id (порядок файла).
 * `rawRows` — `JSON.parse(specifications.raw_data)`, каждая строка — массив ячеек как есть
 * (числа/строки/null из исходного листа).
 */
export function matchItemsToRawRows(rawRows: unknown[][], items: RowMatchItem[]): RowMatchResult {
  const normRows: string[][] = rawRows.map((row) => row.map(normalizeCell));

  const matched = new Map<number, number>();
  const unmatched: number[] = [];
  const used = new Set<number>();
  let pos = 0;
  let lastClaimed: number | null = null;

  for (const item of items) {
    const fullNorm = normalizeCell(item.name);
    const name40 = fullNorm.slice(0, NAME_PREFIX_WINDOW);

    // Позиция-мусор с вырожденным именем (напр. «2» — обрывок нумерации шапки, попавший
    // в specification_items) иначе трогает ЛЮБУЮ ближайшую строку с такой же короткой
    // ячейкой — случайное совпадение, не привязка. Ей всё равно нечего писать в форму
    // (цены у таких позиций не бывает), поэтому просто не ищем для неё строку.
    if (fullNorm.length < MIN_PREFIX_LEN) {
      unmatched.push(item.id);
      continue;
    }

    let found: number | null = null;
    for (let j = pos; j < normRows.length; j++) {
      if (used.has(j)) continue;
      if (normRows[j].some((cell) => cellMatchesPrimary(cell, name40, fullNorm))) {
        found = j;
        break;
      }
    }

    let shared = false;
    if (found === null && lastClaimed !== null) {
      if (normRows[lastClaimed].some((cell) => cellMatchesSplitSibling(cell, fullNorm))) {
        found = lastClaimed;
        shared = true;
      }
    }

    if (found === null) {
      unmatched.push(item.id);
      continue;
    }
    matched.set(item.id, found);
    if (!shared) {
      used.add(found);
      pos = found + 1;
      lastClaimed = found;
    }
    // shared: строка остаётся доступной для следующего осколка той же monster-row, указатель
    // и множество «занято» не двигаем.
  }

  return { matched, unmatched };
}
