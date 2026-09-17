// Ф13. Прайс поставщика файлом — поиск «марка + серия + диаметр», порт прототипа
// scripts/f13_seriya_dn.py 1:1 (эталон приёмки: сверка множества spec_id и цены до копейки).
// Общий матчер (services/matcher.ts) для прайса поставщика не используется — решено оркестратором
// по замеру: предел 50 тыс. строк, > 19 мин блокировки, 0/20 верных. Здесь — целевой поиск по
// марке из справочника, без похожести имени и без построчного сравнения с полным прайсом.
import { getDatabase } from '../database';
import { PRICE_FIELDS, UPSERT_EXTERNAL_PRICE, toBindable, nowIso, syncSiteVariants } from '../routes/priceSearch';

const DN_RE = /(?:DN|D[yу]|Д[yу]|∅|Ø)\s*(\d{2,3})/i;
const PN_RE = /(?:PN|P[yу]|Р[yу])\s*(\d{2})/i;
const SIZE_RE = /\b(\d{2})\s*[xх]\s*(\d{3})\b/i; // K-FLEX 04x018
const KVS_RE = /Kvs\s*([\d.,]+)/i;

// Строки-принадлежности: не самостоятельный товар, цену не ставим.
const ACCESSORY = ['ВСТАВКА', 'СЕРДЕЧНИК', 'РЕМКОМПЛЕКТ', 'ЗАПЧАСТ', 'КОРПУС ', 'ПРОКЛАДК', 'РУКОЯТК', 'РУЧКА ДЛЯ'];

// ponytail: alias-справочник марок, как в прототипе — только те бренды, что реально встретились
// в закупке (Ридан, K-FLEX). Новый бренд поставщика — добавить сюда алиас, без правки остального.
const BRANDS: Record<string, string[]> = {
  'РИДАН': ['РИДАН'],
  'K-FLEX': ['K-FLEX', 'KFLEX', 'K-FLEX PE'],
};

function norm(s: string | null | undefined): string {
  return (s || '').toUpperCase().replace(/[\s\-_./]/g, '');
}

function dn(s: string): number | null {
  const m = DN_RE.exec(s || '');
  return m ? parseInt(m[1], 10) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SupplierPriceRow {
  art: string;
  brand: string;
  name: string;
  price: number;
  n: string;
  dn: number | null;
  size: [string, string] | null;
}

function brandOf(manufacturer: string | null, name: string): string | null {
  const text = `${manufacturer || ''} ${name || ''}`.toUpperCase();
  for (const [brand, aliases] of Object.entries(BRANDS)) {
    if (aliases.some(a => text.includes(a))) return brand;
  }
  return null;
}

function seriesOf(productCode: string | null): string | null {
  const code = (productCode || '').trim();
  const n = norm(code);
  return n.length >= 3 ? n : null;
}

export interface SpecForMatch {
  id: number;
  name: string;
  manufacturer: string | null;
  product_code: string | null;
}

export interface FindResult {
  status: string;
  candidates: SupplierPriceRow[];
}

// Порт find() из f13_seriya_dn.py — тот же порядок фильтров, та же сортировка по цене.
export function findSupplierPrice(spec: SpecForMatch, price: SupplierPriceRow[]): FindResult {
  const b = brandOf(spec.manufacturer, spec.name);
  if (!b) return { status: 'нет марки у поставщика', candidates: [] };
  const text = `${spec.name} ${spec.product_code || ''}`;
  const ser = seriesOf(spec.product_code);
  if (!ser) return { status: 'нет серии', candidates: [] };
  let cand = price.filter(p =>
    p.brand === b && p.n.includes(ser) && !ACCESSORY.some(a => p.name.toUpperCase().startsWith(a)));
  if (cand.length === 0) return { status: 'серии нет в прайсе', candidates: [] };

  if (b === 'K-FLEX') {
    const s = SIZE_RE.exec(text);
    if (!s) return { status: 'нет размера', candidates: cand.slice(0, 3) };
    cand = cand.filter(p => p.size && p.size[0] === s[1] && p.size[1] === s[2]);
  } else {
    const d = dn(text);
    if (d === null) return { status: 'нет диаметра', candidates: cand.slice(0, 3) };
    cand = cand.filter(p => p.dn === d);
    const pn = PN_RE.exec(text);
    if (pn) {
      // давление указано у Ивана и в строке прайса — должно совпасть; если у прайса не указано,
      // строка не отсеивается (как в прототипе).
      cand = cand.filter(p => {
        const pm = PN_RE.exec(p.name);
        return !pm || pm[1] === pn[1];
      });
    }
    const kvs = KVS_RE.exec(text);
    if (kvs && cand.length > 0) {
      const k = kvs[1].replace(',', '.').replace(/\.+$/, '');
      const re = new RegExp(`(?:Kvs\\s*|/)${escapeRegExp(k)}\\b`, 'i');
      cand = cand.filter(p => re.test(p.name));
    }
  }
  if (cand.length === 0) return { status: 'нет диаметра/размера в прайсе', candidates: [] };
  return { status: 'найдено', candidates: [...cand].sort((a, c) => a.price - c.price) };
}

// --- Разбор файла прайса (CSV ';' или XLSX) в память, без сохранения на диск. ---

function parseRubPrice(raw: string | number | undefined | null): number {
  if (typeof raw === 'number') return raw;
  const s = String(raw ?? '').replace(/[ \s]/g, '').replace(',', '.');
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

interface Columns { article: number; brand: number; name: number; price: number }

function resolveColumns(headers: string[]): Columns {
  const norm2 = (h: string) => (h || '').trim();
  const findExact = (name: string) => headers.findIndex(h => norm2(h) === name);
  const findStarts = (name: string) => headers.findIndex(h => norm2(h).startsWith(name));
  const article = findExact('Артикул');
  const brand = findExact('Бренд');
  const name = findExact('Наименование');
  let price = findStarts('Цена партнёра');
  if (price === -1) price = findExact('Цена');
  if (article === -1 || brand === -1 || name === -1 || price === -1) {
    throw new Error(
      `Не распознаны колонки прайса (нужны «Артикул», «Бренд», «Наименование», «Цена партнёра» или «Цена»): ${headers.join(', ')}`,
    );
  }
  return { article, brand, name, price };
}

function rowsToPriceIndex(headers: string[], dataRows: string[][]): SupplierPriceRow[] {
  const col = resolveColumns(headers);
  const out: SupplierPriceRow[] = [];
  for (const r of dataRows) {
    const price = parseRubPrice(r[col.price]);
    if (!(price > 0)) continue;
    const name = r[col.name] || '';
    const size = SIZE_RE.exec(name);
    out.push({
      art: r[col.article] || '',
      brand: (r[col.brand] || '').toUpperCase(),
      name,
      price,
      n: norm(name),
      dn: dn(name),
      size: size ? [size[1], size[2]] : null,
    });
  }
  return out;
}

// Простой RFC4180-парсер: кавычки, удвоенные "" как экранированный символ, разделитель ';'.
// Не тянем библиотеку ради одного формата (ladder: stdlib/встроенное решение первым делом,
// здесь его нет — минимальный собственный код).
function parseCsv(text: string, delimiter = ';'): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field); field = '';
    } else if (c === '\r') {
      // пропускаем — перевод строки ловим по \n
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function parseCsvPriceFile(buffer: Buffer): SupplierPriceRow[] {
  const rows = parseCsv(buffer.toString('utf-8'), ';');
  if (rows.length === 0) return [];
  const [headers, ...data] = rows;
  return rowsToPriceIndex(headers, data);
}

export function parseXlsxPriceFile(buffer: Buffer): SupplierPriceRow[] {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (rows.length === 0) return [];
  const [headers, ...data] = rows as string[][];
  return rowsToPriceIndex(headers.map(String), data.map(r => r.map(v => (v == null ? '' : String(v)))));
}

export interface SupplierMatchSummary { found: number; withBrand: number; total: number }

// Записывает находки в external_prices (source='supplier_price') и превращает их в вариант
// сопоставления механизмом Ф12 (syncSiteVariants, обобщённым на несколько источников).
// business_key не зависит от найденного артикула — только от позиции, источника и дня: повторная
// загрузка того же файла в тот же день обновляет ту же строку, а не плодит дубль (как К5 Ф12).
export function matchSupplierPriceToProject(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  supplierName: string,
  priceIndex: SupplierPriceRow[],
  snapshotDate: string,
): SupplierMatchSummary {
  const specs = db.prepare(
    'SELECT id, name, manufacturer, product_code FROM specification_items WHERE project_id = ?',
  ).all(projectId) as SpecForMatch[];

  let found = 0;
  let withBrand = 0;
  const now = nowIso();
  const upsert = db.prepare(UPSERT_EXTERNAL_PRICE);

  const run = db.transaction(() => {
    for (const s of specs) {
      const { status, candidates } = findSupplierPrice(s, priceIndex);
      if (status !== 'нет марки у поставщика') withBrand++;
      if (status !== 'найдено' || candidates.length === 0) continue;
      found++;
      const best = candidates[0];
      const row: Record<string, unknown> = {
        business_key: `supplier_price|${s.id}|${snapshotDate}`,
        project_id: projectId,
        spec_item_id: s.id,
        query_name: s.name,
        source: 'supplier_price',
        source_url: '', // ссылки нет — прайс файлом, не веб-страница
        snapshot_date: snapshotDate,
        supplier_name: supplierName,
        manufacturer: null,
        article: best.art,
        name: best.name,
        unit: null,
        price: best.price,
        currency: 'RUB',
        status: 'found',
      };
      const params: Record<string, string | number | null> = {};
      for (const field of PRICE_FIELDS) params[field] = toBindable(row[field], now, field);
      upsert.run(params);
    }
  });
  run();
  syncSiteVariants(db, projectId);

  return { found, withBrand, total: specs.length };
}
