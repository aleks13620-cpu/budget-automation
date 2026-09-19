/**
 * Классификатор позиций спецификации — перенос 1:1 из
 * price-harvester/research/klassifikator_pozicij.py (python-версия остаётся на проде,
 * её не трогаем; сверка построчно — scratchpad/sverka_klassifikatora).
 *
 * Делит позиции на 4 группы:
 *   A. изготавливается — по чертежу/ГОСТ 14918, искать в продаже нечего;
 *   B. проектное       — узел/установка «в составе:», собирается под проект;
 *   C. марка изделия   — есть заводская марка/артикул, можно искать цену;
 *   D. без марки       — опознать нечем.
 *
 * Марка ищется ПО ПРИЗНАКУ во всех полях позиции (парсеры кладут её куда придётся),
 * порядок полей — как в python: name, product_code, characteristics, manufacturer,
 * marking, article, full_name. Возвращаем и саму марку, и поле-источник.
 *
 * ВАЖНО про регулярки. Python \b и \w знают кириллицу, JS — нет (\w это [A-Za-z0-9_],
 * \b считает границу по нему же). Поэтому там, где в python стоял \b после кириллицы
 * (NOT_MARK) — здесь ручная проверка границы слова по \p{L}\p{N}_, а где стоял \w
 * (MADE, «оцинк\w*») — класс [\p{L}\p{N}_] с флагом u. Остальные регулярки перенесены
 * символ в символ вместе с флагами.
 */
import { getDatabase } from '../database/connection';
import type { Database } from 'better-sqlite3';

/** Поля позиции, в которых ищется марка, в python-порядке. */
export const MARK_SOURCES = [
  'name', 'product_code', 'characteristics', 'manufacturer', 'marking', 'article', 'full_name',
] as const;
export type MarkSource = (typeof MARK_SOURCES)[number];

export type SpecGroup =
  | 'A. изготавливается'
  | 'B. проектное'
  | 'C. марка изделия'
  | 'D. без марки';

/** Строка specification_items в том объёме, который нужен классификатору. */
export interface SpecItemRow {
  id: number;
  project_id?: number | null;
  parent_item_id?: number | null;
  name?: string | null;
  product_code?: string | null;
  characteristics?: string | null;
  manufacturer?: string | null;
  marking?: string | null;
  article?: string | null;
  full_name?: string | null;
  quantity?: number | null;
}

export interface ClassifiedPosition {
  id: number;
  projectId: number | null;
  /** Полное имя: собрано по родителям (глубина 5), схлопнуты пробелы, обрезано до 120. */
  fullName: string;
  group: SpecGroup;
  mark: string | null;
  markSrc: MarkSource | null;
  /**
   * Все id specification_items с тем же dedupKey (включая сам id представителя), т.е. точные
   * дубли, схлопнутые в эту одну позицию. Ф21.1 (routes/priceOptions.ts): у каждого дубля своя
   * строка external_prices/matched_items, а показывать и выбирать нужно одной позицией —
   * без этого поля вызывающему негде взять список дублей, кроме повтора дедупа руками.
   */
  memberIds: number[];
}

// марка = токен с буквами И цифрами, длиной от 4, допускает дефис/точку/косую
const MARK =
  /(?<![А-Яа-яA-Za-z])(?=[^\s]*[A-ZА-Я])(?=[^\s]*\d)[A-ZА-Я][A-ZА-Яa-zа-я0-9]*(?:[-.\/][A-ZА-Я0-9][A-ZА-Яa-z0-9]*)*(?:\s?\d{1,4}(?:[-х×x\/]\d{1,4})*)?/g;

// НЕ марка: ссылки на стандарты и ТИПОРАЗМЕРЫ. Слитное DN20/Ду25/Ру16 — тоже типоразмер,
// по нему поиск уходит на любой товар того же диаметра (проверено: «прямой DN20» → клапан Herz).
//
// В python это одна регулярка с re.I, первая ветка кончается на \b. Здесь она разрезана:
// ветка со стандартами проверяется отдельно + ручная граница слова. Причина: python-ский \b
// знает кириллицу, JS-ный считает границу по ASCII-\w и ставит её не там.
// Проверено на реальных строках (id 6207, 6907): в «ТУ5769-015-54737814-2008» у python
// между «У» и «5» границы НЕТ (обе — буква/цифра), NOT_MARK не срабатывает и это МАРКА;
// наивный JS-ный \b границу там видит и выкинул бы позицию из группы C в D.
const NOT_MARK_STD = /^(?:ГОСТ|ТУ|СНиП|СП|EI|IP|RAL|ISO|DIN|EN|L|S|Ø|№)/i;
const NOT_MARK_REST =
  /^[TТ]max|^Qmax|^Kvs|^[PР][yуY]\d|^[PР]N\d|^(?:DN|DY|ДУ|DУ|PN|РУ|PУ|D|Ф)\s*\d+|^\d+$/i;

// \w из python = str.isalnum() + underscore, т.е. буквы/цифры любого алфавита.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Граница слова в позиции i строки s — по python-правилам (кириллица тоже буква). */
function atWordBoundary(s: string, i: number): boolean {
  return isWordChar(s[i - 1]) !== isWordChar(s[i]);
}

function isNotMark(tok: string): boolean {
  const m = NOT_MARK_STD.exec(tok);
  // граница обязательна: «ГОСТ 14918» — не марка, «ГОСТовский» — не срабатывает;
  // для «№» граница считается наоборот (№ сам по себе не буква), как и в python.
  if (m && atWordBoundary(tok, m[0].length)) return true;
  return NOT_MARK_REST.test(tok);
}

const MADE =
  /ГОСТ\s*14918|из\s+оцинк[\p{L}\p{N}_]*\.?\s+стали\s+толщиной|толщиной\s+S\s*=|^(?:воздуховод|отвод|переход |врезка|заглушка|зонт |кожух)/iu;
const PROJECT =
  /КЛАД|ПРОК|КПУ|ВРАН|клапан противопожарн|дымоудал|установка приточ|узел этажный|блок ввода|смесительный узел|в составе:|шумоглушител/i;

// Заголовок раздела/узла — не товар (копия HEADER из klassifikator_pozicij.py).
// Граница слова здесь — явный lookahead, а не \b: JS-ный \b считает по ASCII и после
// кириллического «я» границу не видит вовсе.
const HEADER = /^\s*(?:спецификация|ведомость|экспликация)(?![\p{L}])/iu;

// типоразмерный хвост: BVS-R/Dy25/Py63/Tmax180 -> BVS-R, «O80мм 0» -> пусто
const SIZE_SEG = /^(?:DN|DY|ДУ|PN|РУ|D|Ф|O|Ø|L|S|G|Kvs|Tmax|Тmax|Qmax)\s*[\d.\/]+/i;
const PURE_SIZE = /^[\d.,x×х-]+\s*(?:мм|м|кг)?$/i;   // re.fullmatch в python
const TRAIL_NUM = /\s+\d+([.,]\d+)?$/;
const SIZE_HEAD = /^[OØ]\s*\d/i;
const MM_TAIL = /\d\s*мм$/i;

export function trimSizeTail(tok: string): string {
  const parts = tok.split('/');
  const keep: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (i > 0 && (SIZE_SEG.test(seg) || PURE_SIZE.test(seg))) break;
    keep.push(seg);
  }
  let out = keep.join('/').trim();
  // хвост вида «O80мм 0» или «Ду25 Р» — размер, а не марка
  out = out.replace(TRAIL_NUM, '').trim();
  if (SIZE_HEAD.test(out) || MM_TAIL.test(out)) return '';
  return out;
}

// марка вида «SonoSelect 10», «АМР 150х150» — слово и число раздельно
const MARK_WORDNUM =
  /(?<![А-Яа-яA-Za-z])([A-Z][A-Za-z]{2,}|[А-Я]{2,})[\s-]?(\d{1,4}(?:[-х×x\/.]\d{1,4})*)/g;
const WORDNUM_STOP = new Set([
  'ду', 'дн', 'ру', 'pn', 'dn', 'dy', 'py', 'тип', 'класс', 'кран',
  'клапан', 'труба', 'отвод', 'фильтр', 'насос', 'узел', 'блок', 'шт', 'мм',
  'гост', 'tmax', 'qmax', 'kvs', 'тmax', 'ip', 'ral', 'ei', 'din', 'ph',
]);

const HAS_DIGIT = /\d/;
const HAS_UPPER = /[A-ZА-Я]/;

/** Марка из любого поля. Возвращает [марка, из какого поля] — как find_mark в python. */
export function findMark(row: SpecItemRow): [string, MarkSource] | [null, null] {
  for (const fname of MARK_SOURCES) {
    const val = row[fname];
    if (!val) continue;                       // python: `if not val` — None/'' пропускаем
    // Потолок длины поля. Регулярка марки на патологической строке («-A» повторить 32 000 раз)
    // отрабатывает 1,3 секунды и блокирует ВЕСЬ сервер: node однопоточный, а классификация
    // идёт синхронно на каждый открытый проект. В ячейку Excel влезает 32 767 символов,
    // так что вход достижим обычной загрузкой файла. Замерено: 500 символов — доли мс.
    // На реальных данных не срабатывает: самое длинное наименование в базе — 343 символа,
    // разбор после ограничителя сверен с python заново, расхождений ноль.
    const s = String(val).trim().slice(0, 500);

    for (const m of s.matchAll(MARK_WORDNUM)) {
      const word = m[1], num = m[2];
      if (WORDNUM_STOP.has(word.toLowerCase()) || word.length < 3) continue;
      const tok = `${word} ${num}`;
      if (isNotMark(tok)) continue;
      return [tok, fname];
    }

    for (const m of s.matchAll(MARK)) {
      const tok = trimSizeTail(m[0].trim());
      if (tok.length < 4 || isNotMark(tok)) continue;
      if (!HAS_DIGIT.test(tok) || !HAS_UPPER.test(tok)) continue;
      return [tok, fname];
    }
  }
  return [null, null];
}

/**
 * Классификация ОДНОЙ позиции. fullName — собранное по родителям имя (см. buildFullName),
 * а не поле full_name: в python в текст для MADE/PROJECT идёт именно оно.
 */
export function classifySpecItem(
  row: SpecItemRow,
  fullName: string,
): { group: SpecGroup; mark: string | null; markSrc: MarkSource | null } {
  if (HEADER.test(row.name || '')) return { group: 'D. без марки', mark: null, markSrc: null };
  const [mark, markSrc] = findMark(row);
  const text = fullName + ' ' + (row.characteristics || '');
  if (MADE.test(text)) return { group: 'A. изготавливается', mark, markSrc };
  if (PROJECT.test(text)) return { group: 'B. проектное', mark, markSrc };
  if (mark) return { group: 'C. марка изделия', mark, markSrc };
  return { group: 'D. без марки', mark: null, markSrc: null };
}

/**
 * Полное имя позиции: свои имена родителей сверху вниз, глубина 5, дубли не повторяем,
 * пробелы схлопнуты, обрезано до 120 символов. Копия full() из load_layer_c/load_positions.
 */
export function buildFullName(row: SpecItemRow, byId: Map<number, SpecItemRow>): string {
  const parts: string[] = [];
  let cur: SpecItemRow | undefined = row;
  for (let g = 0; cur && g < 5; g++) {
    const nm = (cur.full_name || cur.name || '').trim();
    if (nm && !parts.includes(nm)) parts.unshift(nm);
    const pid: number | null | undefined = cur.parent_item_id;
    cur = pid == null ? undefined : byId.get(pid);
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Поля, из которых складывается ПОИСКОВЫЙ ЗАПРОС (по ним же find_mark ищет марку).
 * Копия KEY_FIELDS из klassifikator_pozicij.py.
 */
const KEY_FIELDS = [
  'name', 'product_code', 'characteristics', 'manufacturer', 'marking', 'article',
] as const;

/**
 * Ключ «это одна и та же позиция спецификации». Копия dedup_key из
 * price-harvester/research/klassifikator_pozicij.py — расхождение ловит сверка
 * (в дампах обеих сторон есть поле `key`).
 *
 * Прежний ключ — срез полного имени в 60 символов + артикул + производитель — склеивал
 * РАЗНЫЕ товары: buildFullName берёт `full_name || name`, поэтому у строк с заполненным
 * full_name собственное имя (а это и есть артикул: C21-500-400, C21-500-500…) в ключ
 * не попадало вовсе, и пять разных радиаторов считались одной позицией.
 *
 * `!v ? '' : String(v).trim()` — та же семантика «ложное → пусто», что и `x or ''` в python:
 * число 0 и null дают одно и то же по обе стороны. JSON — чтобы склейка полей не давала
 * ложных совпадений.
 */
export function dedupKey(row: SpecItemRow, fullName: string): string {
  const v = (f: (typeof KEY_FIELDS)[number]) => (!row[f] ? '' : String(row[f]).trim());
  return JSON.stringify([fullName, ...KEY_FIELDS.map(v)]);
}

/**
 * Позиции спецификации (или всего проекта) с квалификацией.
 * Подготовка входа — как в python load_positions: позиции без количества пропускаем,
 * дедуп по dedupKey.
 */
export function classifySpecPositions(
  opts: { specificationId?: number; projectId?: number },
  db: Database = getDatabase(),
): ClassifiedPosition[] {
  const rows: SpecItemRow[] = opts.specificationId != null
    ? db.prepare('select * from specification_items where specification_id=?')
        .all(opts.specificationId) as SpecItemRow[]
    : db.prepare('select * from specification_items where project_id=?')
        .all(opts.projectId) as SpecItemRow[];

  const byId = new Map<number, SpecItemRow>(rows.map((r) => [r.id, r]));
  const out: ClassifiedPosition[] = [];
  const seen = new Map<string, ClassifiedPosition>();

  for (const r of rows) {
    if (!r.quantity) continue;
    const fullName = buildFullName(r, byId);
    const key = dedupKey(r, fullName);
    const existing = seen.get(key);
    if (existing) { existing.memberIds.push(r.id); continue; }
    const { group, mark, markSrc } = classifySpecItem(r, fullName);
    const position: ClassifiedPosition = {
      id: r.id, projectId: r.project_id ?? null, fullName, group, mark, markSrc, memberIds: [r.id],
    };
    out.push(position);
    seen.set(key, position);
  }
  return out;
}
