import Database from 'better-sqlite3';

/**
 * Ф14: вычисление «цена / поставщик / источник / ссылка» по позиции — вынесено из
 * export.ts (было единственным местом), чтобы новая выгрузка «форма Арты с ценами»
 * (routes/exportOriginal.ts) не дублировала эту логику. export.ts остался
 * единственным местом сборки итогового Excel-листа (шапка/разделы/итоги) —
 * то есть, что не изменилось поведением, а не что откуда вызывается.
 */

export const GROUP_LABELS: Record<string, string> = {
  'A. изготавливается': 'изготавливается по чертежу',
  'B. проектное': 'проектное, цена по запросу',
  'C. марка изделия': 'есть заводская марка',
  'D. без марки': 'описано словами',
};

// ponytail: порог разброса 3x подобран на первом прогоне — крутить по словам снабженца,
// а не выводить формулой. Направление ошибки случайное: у грунта дешёвое было верным
// (цена за кг против ведра), у клапана MNF-R2 дешёвое оказалось страницей раздела.
const SPREAD_ALERT = 3;

// Адрес приходит с чужого сайта. Пускаем только http/https: file:// или \сервер\share
// в документе Windows — рабочий способ утечки учётных данных по клику.
// Тем же условием гасим и текст «открыть карточку», иначе он обещает клик, которого нет.
export function isWebLink(u: string | null): boolean {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  // логин:пароль прямо в адресе — у продавца такого не бывает, зато это приём фишинга
  return !u.slice(u.indexOf('//') + 2).split('/')[0].includes('@');
}

function computeUnitPriceWithVat(
  price: number | null,
  vatRate: number | null,
  inclVat: number | null,
  invoiceQuantity: number | null,
  invoiceAmount: number | null,
): { unitPriceWithVat: number | null; source: 'raw' | 'derived_unit' } {
  if (invoiceAmount != null && invoiceQuantity != null && invoiceQuantity > 0) {
    const lineTotalWithVat = inclVat === 0 && vatRate != null && vatRate > 0
      ? invoiceAmount * (1 + vatRate / 100)
      : invoiceAmount;
    return {
      unitPriceWithVat: Math.round((lineTotalWithVat / invoiceQuantity) * 100) / 100,
      source: 'derived_unit',
    };
  }
  if (price == null) return { unitPriceWithVat: null, source: 'raw' };
  if (inclVat === 0 && vatRate != null && vatRate > 0) {
    return {
      unitPriceWithVat: Math.round(price * (1 + vatRate / 100) * 100) / 100,
      source: 'raw',
    };
  }
  return { unitPriceWithVat: price, source: 'raw' };
}

function foundByLabel(
  item: { ext_offers: number | null; ext_price: number | null; ext_price_max: number | null },
  usedExternal: boolean,
  foundBy: string | null,
  mark: string | null,
  notFound: number,
): string {
  if (!usedExternal) return notFound ? 'искали, не нашли' : '';
  const suffix = mark ? ` ${mark}` : '';
  let label = 'без артикула — проверьте';
  if (foundBy === 'артикул') label = `артикул${suffix}`;
  else if (foundBy === 'типоразмер') label = `типоразмер${suffix}`;

  const n = item.ext_offers || 0;
  const lo = item.ext_price;
  const hi = item.ext_price_max;
  if (n <= 1) return `${label} · предложение одно, сравнить не с чем`;
  const plural = (v: number, one: string, few: string, many: string) => {
    const m10 = v % 10, m100 = v % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const offers = `${n} ${plural(n, 'предложение', 'предложения', 'предложений')}`;
  if (lo && hi && hi / lo >= SPREAD_ALERT) {
    const k = Math.round(hi / lo);
    return `${label} · ${offers}, дороже в ${k} ${plural(k, 'раз', 'раза', 'раз')} — проверьте`;
  }
  return `${label} · ${offers}`;
}

export interface ExportRow {
  id: number;
  position_number: string | null;
  name: string;
  unit: string | null;
  quantity: number | null;
  section: string | null;
  price: number | null;
  priceWithVat: number | null;
  amount: number | null;
  supplier: string;
  typeLabel: 'Ориг.' | 'Аналог' | 'Интернет';
  groupLabel: string;
  foundBy: string;
  url: string; // '' when none / not a safe web link
  usedExternal: boolean;
}

export type ExportMode = 'best' | 'original' | 'analog';

/**
 * Одна позиция — одна строка результата, в порядке `si.section, si.id` (как было в
 * export.ts). Значения полей побайтно те же, что раньше строил export.ts инлайн —
 * перенесённый код, не переписанный.
 */
export function computeExportRows(db: Database.Database, projectId: number, mode: ExportMode): ExportRow[] {
  let analogFilter = '';
  if (mode === 'original') {
    analogFilter = 'AND (COALESCE(m.is_analog, 0) = 0)';
  } else if (mode === 'analog') {
    analogFilter = 'AND m.is_analog = 1';
  }

  const rows = db.prepare(`
    -- source='web_search' обязателен во всех трёх CTE: в external_prices лежат ещё
    -- старые прогоны прежних источников, включая тестовые с несуществующим доменом
    -- example-supplier. Без этого фильтра они уехали бы в спецификацию клиента как цены.
    -- Последний прогон по каждой позиции — считается по ВСЕМ статусам, не только по
    -- найденным. Иначе позиция, которая в свежем прогоне перестала находиться, тянула бы
    -- цену из старого среза как текущую, а флаг «не нашли» терялся. Проверено фактом.
    WITH ext_last AS (
      SELECT spec_item_id, project_id, MAX(snapshot_date) as last_date
      FROM external_prices WHERE source = 'web_search'
      GROUP BY spec_item_id, project_id
    ),
    ext_ranked AS (
      SELECT ep.spec_item_id, ep.project_id, ep.price, ep.supplier_name, ep.source_url,
             json_extract(ep.raw_data, '$.found_by') as found_by,
             json_extract(ep.raw_data, '$.mark') as mark,
             COUNT(*) OVER (PARTITION BY ep.spec_item_id) as offers,
             MAX(ep.price) OVER (PARTITION BY ep.spec_item_id) as price_max,
             ROW_NUMBER() OVER (
               PARTITION BY ep.spec_item_id
               ORDER BY ep.price ASC
             ) as rn
      FROM external_prices ep
      JOIN ext_last el ON el.spec_item_id = ep.spec_item_id
                      AND el.project_id IS ep.project_id
                      AND ep.snapshot_date = el.last_date
      WHERE ep.status = 'found' AND ep.source = 'web_search'
    ),
    ext_group AS (
      SELECT spec_item_id, project_id, MIN(json_extract(raw_data, '$.group')) as grp
      FROM external_prices WHERE source = 'web_search' GROUP BY spec_item_id, project_id
    ),
    ext_notfound AS (
      SELECT DISTINCT ep.spec_item_id, ep.project_id FROM external_prices ep
      JOIN ext_last el ON el.spec_item_id = ep.spec_item_id
                      AND el.project_id IS ep.project_id
                      AND ep.snapshot_date = el.last_date
      WHERE ep.status = 'not_found' AND ep.source = 'web_search'
    )
    SELECT si.id, si.position_number, si.name, si.unit, si.quantity, si.section,
           COALESCE(ii.price, pli.price) as price,
           ii.quantity as invoice_quantity,
           ii.amount as invoice_amount,
           COALESCE(ii.name, pli.name) as invoice_name,
           COALESCE(ii.article, pli.article) as article,
           s.name as supplier_name, COALESCE(s.vat_rate, i.vat_rate) as vat_rate, s.prices_include_vat,
           COALESCE(m.is_analog, 0) as is_analog,
           er.price as ext_price, er.supplier_name as ext_supplier,
           er.source_url as ext_url, er.offers as ext_offers, er.price_max as ext_price_max,
           er.found_by as ext_found_by, er.mark as ext_mark,
           eg.grp as ext_group,
           CASE WHEN enf.spec_item_id IS NOT NULL THEN 1 ELSE 0 END as ext_not_found
    FROM specification_items si
    LEFT JOIN matched_items m ON m.specification_item_id = si.id AND m.is_selected = 1 ${analogFilter}
    LEFT JOIN invoice_items ii ON (COALESCE(m.source,'invoice') = 'invoice') AND m.invoice_item_id = ii.id
    LEFT JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN price_list_items pli ON (m.source = 'price_list') AND m.price_list_item_id = pli.id
    LEFT JOIN price_lists pl ON pli.price_list_id = pl.id
    LEFT JOIN suppliers s ON COALESCE(i.supplier_id, pl.supplier_id) = s.id
    LEFT JOIN ext_ranked er ON er.spec_item_id = si.id AND er.rn = 1
    LEFT JOIN ext_group eg ON eg.spec_item_id = si.id
    LEFT JOIN ext_notfound enf ON enf.spec_item_id = si.id
    WHERE si.project_id = ?
    ORDER BY si.section, si.id
  `).all(projectId) as Array<{
    id: number; position_number: string | null; name: string;
    unit: string | null; quantity: number | null; section: string | null;
    price: number | null; invoice_quantity: number | null; invoice_amount: number | null; invoice_name: string | null;
    article: string | null; supplier_name: string | null;
    vat_rate: number | null; prices_include_vat: number | null;
    is_analog: number;
    ext_price: number | null; ext_supplier: string | null;
    ext_url: string | null; ext_offers: number | null; ext_price_max: number | null;
    ext_found_by: string | null; ext_mark: string | null;
    ext_group: string | null; ext_not_found: number;
  }>;

  return rows.map((item) => {
    const qty = item.quantity || 0;
    // Только в обычной выгрузке. В режимах «оригинал»/«аналог» пустая цена — это
    // ответ «такого варианта нет», и подставлять туда интернет-цену нельзя:
    // она не является ни оригиналом, ни аналогом.
    const usedExternal = mode === 'best' && item.price == null && item.ext_price != null;
    const price = usedExternal ? item.ext_price : item.price;
    const supplier = usedExternal ? (item.ext_supplier || '') : (item.supplier_name || '');
    const pricing = computeUnitPriceWithVat(
      price,
      item.vat_rate,
      item.prices_include_vat,
      item.invoice_quantity,
      item.invoice_amount,
    );
    // У интернет-цены ставка НДС неизвестна: у продавца её взять неоткуда.
    // Пустая клетка честнее подстановки той же цифры — иначе читается как «цена без НДС».
    // Сумма для таких строк считается по цене продавца как есть.
    const priceWithVat = usedExternal ? null : pricing.unitPriceWithVat;
    const amountBase = usedExternal ? price : priceWithVat;
    const amount = amountBase != null ? Math.round(amountBase * qty * 100) / 100 : null;

    return {
      id: item.id,
      position_number: item.position_number,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      section: item.section,
      price,
      priceWithVat,
      amount,
      supplier,
      typeLabel: usedExternal ? 'Интернет' : (item.is_analog ? 'Аналог' : 'Ориг.'),
      groupLabel: item.ext_group ? (GROUP_LABELS[item.ext_group] || item.ext_group) : '',
      foundBy: foundByLabel(item, usedExternal, item.ext_found_by, item.ext_mark, item.ext_not_found),
      // Адрес отдельной колонкой, а не только гиперссылкой на домене: библиотека пишет
      // xlsx без стилей, и кликабельная ячейка выглядит обычным чёрным текстом — человек
      // не видит, что по ней можно перейти. Видимый адрес читается как ссылка сам по себе.
      url: usedExternal && isWebLink(item.ext_url) ? item.ext_url! : '',
      usedExternal,
    };
  });
}
