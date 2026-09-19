import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import { classifySpecPositions } from '../services/specClassifier';
import {
  getOrCreatePriceListMatchId, setSelectedMatch, WEB_MATCH_TYPE,
  UPSERT_EXTERNAL_PRICE, PRICE_FIELDS, toBindable, nowIso,
} from './priceSearch';
import { ensureMatchingNotRunning } from './matching';

/**
 * Ф21.1 — «API вариантов цены». Снабженец Иван на одном экране видит у каждой позиции
 * спецификации все варианты цены (поставщик, тип, дата, цена → скидка Арты → предварительно)
 * и выбирает одним нажатием.
 *
 * Правка после приёмки оркестратора: позиция = classifySpecPositions({projectId}) — ТОТ ЖЕ вход
 * и дедуп, что у /spec-groups (там total/searched уже используют этот классификатор), иначе
 * Иван видел бы разные числа «искали N из M» на двух экранах. Точные дубли (одинаковый
 * dedupKey — то же наименование/артикул/производитель, разные specification_items.id, напр.
 * одна и та же арматура в двух узлах) classifySpecPositions схлопывает в ОДНУ позицию с полем
 * memberIds — но у каждого дубля в external_prices/matched_items СВОЯ строка (Ф13 нашёл цену
 * каждому по отдельности). Поэтому options позиции = находки ВСЕХ её members (одинаковые
 * предложения показаны один раз), а PUT применяет выбор ко всем members разом (см. ниже).
 *
 * options строятся напрямую из external_prices (ВСЕ found-строки последнего среза каждого
 * source, не только rn=1 — в отличие от syncSiteVariants/exportPricing, которым для
 * автоподстановки и сопоставления хватает одной, самой дешёвой). Выбор позиции по-прежнему
 * идёт через matched_items(source='price_list') — тот же путь, что и Ф12/Ф13, поэтому
 * выгрузка (routes/export.ts, services/exportPricing.ts) не меняется этой фазой.
 */

const router = Router();

type PriceType = 'own' | 'base' | 'public';

// Причина, по которой позицию не ищем — те же 3 группы классификатора, что и «искали, C».
const REASON_BY_GROUP: Record<string, string> = {
  'A. изготавливается': 'изготавливается по чертежу — цену не ищем',
  'B. проектное': 'проектное — собирается под проект, цену не ищем',
  'D. без марки': 'нет марки/артикула — искать не по чему',
};

// Источники экрана «Цены по позициям» — единственные, чьи price_list_items считаются вариантом
// ЭТОГО экрана (row_index = external_prices.id, file_path = source, см. insertPriceListVariant
// в priceSearch.ts). Обычный прайс-лист поставщика (файл, загруженный оператором) под эти
// значения file_path никогда не попадает — имя файла другое.
const OPTION_SOURCES = ['web_search', 'supplier_price', 'rusklimat_api', 'santech_price'] as const;

function priceTypeForSource(source: string): PriceType {
  if (source === 'rusklimat_api' || source === 'supplier_price') return 'own';
  if (source === 'santech_price') return 'base';
  return 'public'; // web_search и прочий будущий поиск по рынку
}

type SiteRow = {
  id: number; name: string; domain: string | null; price_source: string;
  source_key: string | null; discount_pct: number;
};

function fmtRub(n: number): string {
  return `${n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch { return null; }
}

// Поставщик строки external_prices среди supplier_sites — правило зависит от source (см. план
// Ф21.1): rusklimat_api/santech_price по source_key, supplier_price по имени, web_search по
// хосту source_url (без 'www.', совпадает с domain или оканчивается на '.'+domain).
function findSite(sites: SiteRow[], source: string, supplierName: string | null, sourceUrl: string): SiteRow | null {
  if (source === 'rusklimat_api' || source === 'santech_price') {
    return sites.find(s => s.source_key === source) ?? null;
  }
  if (source === 'supplier_price') {
    const name = (supplierName || '').trim();
    if (!name) return null;
    return sites.find(s => s.name === name) ?? null;
  }
  const host = hostOf(sourceUrl);
  if (!host) return null;
  return sites.find(s => {
    if (!s.domain) return false;
    const d = s.domain.toLowerCase();
    return host === d || host.endsWith('.' + d);
  }) ?? null;
}

type OptionRow = {
  id: number; spec_item_id: number; source: string; source_url: string;
  supplier_name: string | null; price: number; snapshot_date: string;
};

// Ключ «то же самое предложение» — одинаковые source/url/поставщик/цена у разных members
// показываются одним вариантом, а не по одному на каждый дубль позиции.
function optionGroupKey(row: OptionRow): string {
  const SEP = String.fromCharCode(31); // разделитель собран в рантайме, не встроен спецсимволом в исходник
  return `${row.source}${SEP}${row.source_url}${SEP}${row.supplier_name ?? ''}${SEP}${row.price}`;
}

// Поставщик + скидка одной строки external_prices — правило (findSite выше) плюс «скидка 0
// для price_source='api' и для ненайденного поставщика». Общее место для экрана (buildOption)
// и выгрузок (exportPricing.ts::computePrelimPrice ниже) — считать один раз, не дважды.
function resolveDiscountPct(
  sites: SiteRow[], source: string, supplierName: string | null, sourceUrl: string,
): { site: SiteRow | null; discountPct: number } {
  const site = findSite(sites, source, supplierName, sourceUrl);
  return { site, discountPct: site && site.price_source !== 'api' ? site.discount_pct : 0 };
}

export interface PrelimPriceInput {
  source: string;
  source_url: string;
  supplier_name: string | null;
  price: number;
}

// Ф21.4: цена со скидкой Арты для строки external_prices — тот же расчёт, что видит Иван на
// экране «Цены по позициям» (buildOption ниже). Экспортирована для exportPricing.ts, чтобы
// выгрузки не считали поставщика/скидку вторым кодом.
export function computePrelimPrice(sites: SiteRow[], row: PrelimPriceInput): number {
  const { discountPct } = resolveDiscountPct(sites, row.source, row.supplier_name, row.source_url);
  return Math.round(row.price * (1 - discountPct / 100) * 100) / 100;
}

// Список поставщиков Арты одним запросом — общее место для экрана и выгрузок, чтобы не
// дублировать этот SELECT и не бить по БД в цикле по позициям.
export function loadSupplierSites(db: ReturnType<typeof getDatabase>): SiteRow[] {
  return db.prepare(
    'SELECT id, name, domain, price_source, source_key, discount_pct FROM supplier_sites'
  ).all() as SiteRow[];
}

// Ф21.4 (exportPricing.ts): цена для выгрузки — со скидкой, только когда она реально есть
// (>0). Экран Ивана (buildOption/computePrelimPrice) округляет цену до копеек ВСЕГДА, даже
// без скидки — так и должно остаться для экрана. Но приёмка выгрузки требует: «при всех
// скидках 0 результат идентичен сегодняшнему» — а сегодня выгрузка отдаёт цену продавца как
// есть, без округления. Поэтому без скидки — исходная цена без изменений, со скидкой —
// computePrelimPrice (тот же расчёт, что на экране).
export function computeExportPrice(sites: SiteRow[], row: PrelimPriceInput): number {
  const { discountPct } = resolveDiscountPct(sites, row.source, row.supplier_name, row.source_url);
  return discountPct > 0 ? computePrelimPrice(sites, row) : row.price;
}

function buildOption(sites: SiteRow[], row: OptionRow, stale: boolean): PriceOption {
  const { site, discountPct } = resolveDiscountPct(sites, row.source, row.supplier_name, row.source_url);
  const priceType = priceTypeForSource(row.source);
  const prelimPrice = computePrelimPrice(sites, row);
  const domain = site?.domain ?? hostOf(row.source_url);
  return {
    option_id: row.id,
    supplier_label: site?.name ?? (row.supplier_name || domain || 'без названия'),
    domain: domain ?? null,
    source: row.source,
    price_type: priceType,
    base_price: row.price,
    discount_pct: discountPct,
    prelim_price: prelimPrice,
    snapshot_date: row.snapshot_date,
    url: /^https?:\/\//i.test(row.source_url) ? row.source_url : '',
    is_own_supplier: !!site,
    stale,
  };
}

export interface PriceOption {
  option_id: number;
  supplier_label: string;
  domain: string | null;
  source: string;
  price_type: PriceType;
  base_price: number;
  discount_pct: number;
  prelim_price: number;
  snapshot_date: string;
  url: string;
  is_own_supplier: boolean;
  /** Выбранный вариант, чья строка выпала из последнего среза (более новый поиск её не нашёл) —
   *  не прячем, только помечаем; см. п.5 приёмки оркестратора. */
  stale: boolean;
}

export interface PriceOptionItem {
  spec_item_id: number;
  /** Все specification_items.id, схлопнутые в эту позицию (дубли по содержимому); PUT по этой
   *  позиции применяет выбор ко всем сразу. Для позиции без дублей — массив из одного id. */
  member_ids: number[];
  name: string;
  mark: string | null;
  qty: number | null;
  searched: boolean;
  reason_not_searched: string | null;
  selected_option_id: number | null;
  auto_option_id: number | null;
  /** П.1: непусто, если у части членов позиции выгрузка ничего не подставит без выбора. */
  auto_note: string | null;
  /** П.2: цена счёта, которую сейчас реально возьмёт выгрузка (exportPricing.ts), если Иван
   *  вариант не выбирал — только когда у представителя выбран matched_items source='invoice'. */
  invoice_price: number | null;
  invoice_supplier: string | null;
  /** П.3: представитель выбрал обычный (не этого экрана) прайс-лист — цена оттуда, экран её не
   *  считает своим вариантом (auto_option_id обнулён). */
  other_selected_label: string | null;
  /** П.2: «сбросить выбор» вернёт цену счёта представителя (findInvoiceRestoreCandidate) —
   *  фронт меняет подпись ссылки на «вернуть цену из счёта». Только когда selected_option_id
   *  не null (есть что сбрасывать). */
  invoice_restorable: boolean;
  skipped: boolean;
  options: PriceOption[];
}

export interface PriceOptionsResult {
  summary: {
    total: number; searched: number; with_price: number; own_price: number;
    selected: number; last_search_at: string | null;
  };
  items: PriceOptionItem[];
  not_searched_items: Array<{ spec_item_id: number; name: string }>;
}

// Собирает весь экран для проекта. Общая функция для GET и для ответа PUT (после правки
// пересчитывается заново — тот же код, второй реализации нет).
export function buildPriceOptions(db: ReturnType<typeof getDatabase>, projectId: number): PriceOptionsResult {
  // Тот же вход и дедуп, что у /spec-groups (services/specClassifier.ts): total/searched на
  // этом экране обязаны совпадать с числами страницы проекта.
  const positions = classifySpecPositions({ projectId }, db);
  const specRows = db.prepare(
    'SELECT id, name, quantity FROM specification_items WHERE project_id = ?'
  ).all(projectId) as Array<{ id: number; name: string | null; quantity: number | null }>;
  const specById = new Map(specRows.map(r => [r.id, r]));

  const sites = loadSupplierSites(db);

  // Все found-строки последнего среза КАЖДОГО source по проекту (не только rn=1 — этим и
  // отличается от syncOneSourceVariants/exportPricing, которым хватало одного варианта).
  // Ключ по-прежнему сырой spec_item_id — членов позиции сводим ниже, по memberIds.
  const optionRows = db.prepare(`
    WITH ext_last AS (
      SELECT ep.spec_item_id, ep.source, MAX(ep.snapshot_date) AS last_date
      FROM external_prices ep
      JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
      WHERE ep.project_id = ?
      GROUP BY ep.spec_item_id, ep.source
    )
    SELECT ep.id, ep.spec_item_id, ep.source, ep.source_url, ep.supplier_name, ep.price, ep.snapshot_date
    FROM external_prices ep
    JOIN ext_last el ON el.spec_item_id = ep.spec_item_id AND el.source = ep.source AND ep.snapshot_date = el.last_date
    WHERE ep.project_id = ? AND ep.status = 'found' AND ep.price IS NOT NULL
    ORDER BY ep.spec_item_id, ep.price ASC, ep.id ASC
  `).all(projectId, projectId) as OptionRow[];

  const optionsByMember = new Map<number, OptionRow[]>();
  for (const row of optionRows) {
    if (!optionsByMember.has(row.spec_item_id)) optionsByMember.set(row.spec_item_id, []);
    optionsByMember.get(row.spec_item_id)!.push(row);
  }

  // Выбор/skip по-прежнему живут на сыром specification_item.id — считаем их для КАЖДОГО
  // member, но на экран отдаём только состояние представителя (п.4 приёмки: «selected_option_id
  // позиции = выбор представителя»; PUT синхронизирует всех members, так что в норме они не
  // расходятся).
  const anySelectedByMember = new Set<number>();
  const selectedByMember = new Map<number, number>();
  // П.3: matched_items(source='price_list') выбор — вариант ЭТОГО экрана, только если
  // price_lists.file_path — один из 4 источников экрана (OPTION_SOURCES) И row_index указывает
  // на СВОЮ строку external_prices того же проекта/позиции (та же связка, что использует
  // getOrCreatePriceListMatchId/exportPricing.ts). Иначе — обычный прайс-лист поставщика,
  // отдельный текст (otherSelectedByMember), не вариант экрана.
  const otherSelectedByMember = new Map<number, string>();
  // П.2: цена счёта, которую реально возьмёт выгрузка — только когда у представителя сейчас
  // выбран matched_items source='invoice' (тот же join, что exportPricing.ts делает для строк
  // с m.source='invoice').
  const invoiceByMember = new Map<number, { price: number; supplier: string | null }>();
  const selectedRows = db.prepare(`
    SELECT si.id AS spec_item_id, m.source AS m_source, pli.row_index AS row_index,
           pl.file_path AS file_path, pli.price AS pli_price, pls.name AS pl_supplier_name,
           ep.id AS ep_id, ii.price AS invoice_price, isup.name AS invoice_supplier_name
    FROM matched_items m
    JOIN specification_items si ON si.id = m.specification_item_id
    LEFT JOIN price_list_items pli ON pli.id = m.price_list_item_id
    LEFT JOIN price_lists pl ON pl.id = pli.price_list_id
    LEFT JOIN suppliers pls ON pls.id = pl.supplier_id
    LEFT JOIN external_prices ep ON ep.id = pli.row_index AND ep.project_id = si.project_id AND ep.spec_item_id = si.id
    LEFT JOIN invoice_items ii ON (m.source = 'invoice') AND ii.id = m.invoice_item_id
    LEFT JOIN invoices inv ON inv.id = ii.invoice_id
    LEFT JOIN suppliers isup ON isup.id = inv.supplier_id
    WHERE si.project_id = ? AND m.is_selected = 1
  `).all(projectId) as Array<{
    spec_item_id: number; m_source: string; row_index: number | null; file_path: string | null;
    pli_price: number | null; pl_supplier_name: string | null; ep_id: number | null;
    invoice_price: number | null; invoice_supplier_name: string | null;
  }>;
  for (const r of selectedRows) {
    anySelectedByMember.add(r.spec_item_id);
    if (r.m_source === 'price_list' && r.row_index != null) {
      const isOptionSource = r.file_path != null && (OPTION_SOURCES as readonly string[]).includes(r.file_path) && r.ep_id != null;
      if (isOptionSource) {
        selectedByMember.set(r.spec_item_id, r.row_index);
      } else if (r.pli_price != null) {
        otherSelectedByMember.set(r.spec_item_id, `выбрана цена из прайса ${r.pl_supplier_name || 'без названия'}: ${fmtRub(r.pli_price)}`);
      }
    } else if (r.m_source === 'invoice' && r.invoice_price != null) {
      invoiceByMember.set(r.spec_item_id, { price: r.invoice_price, supplier: r.invoice_supplier_name });
    }
  }

  const skipByMember = new Set<number>(
    (db.prepare(`
      SELECT pos.specification_item_id AS id FROM price_option_skip pos
      JOIN specification_items si ON si.id = pos.specification_item_id
      WHERE si.project_id = ?
    `).all(projectId) as Array<{ id: number }>).map(r => r.id)
  );

  let searched = 0, withPrice = 0, ownPrice = 0, selectedCount = 0;
  const notSearched: Array<{ spec_item_id: number; name: string }> = [];
  const items: PriceOptionItem[] = [];

  for (const p of positions) {
    const specRow = specById.get(p.id);
    const name = specRow?.name ?? '';
    const isSearched = p.group.startsWith('C');
    if (isSearched) searched++;
    // not_searched_items = только «описано словами» (D) — А/Б искать не пытаемся в принципе,
    // это не то же самое, что «не нашли марку».
    if (p.group === 'D. без марки') notSearched.push({ spec_item_id: p.id, name });

    // Находки ВСЕХ members позиции, сгруппированные по «то же самое предложение».
    const memberRows: OptionRow[] = [];
    for (const mid of p.memberIds) memberRows.push(...(optionsByMember.get(mid) ?? []));
    if (memberRows.length > 0) withPrice++;

    const groups = new Map<string, OptionRow[]>();
    for (const row of memberRows) {
      const key = optionGroupKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    let hasOwn = false;
    const options: PriceOption[] = [];
    for (const rows of groups.values()) {
      // Отображаемая строка группы — своя строка представителя, если у него есть это
      // предложение, иначе любая (детерминированно — с наименьшим id).
      const display = rows.find(r => r.spec_item_id === p.id) ?? rows.slice().sort((a, b) => a.id - b.id)[0];
      const opt = buildOption(sites, display, false);
      if (opt.price_type === 'own') hasOwn = true;
      options.push(opt);
    }
    if (hasOwn) ownPrice++;

    // П.1: автоподстановка выгрузки — ровно та строка, которую подставит exportPricing.ts
    // (ext_ranked) ПРЕДСТАВИТЕЛЮ: его собственные web_search-строки последнего среза, price ASC,
    // id ASC. Минимум по ВСЕМ members (как было) обещал бы этому конкретному члену чужую цену,
    // которую выгрузка на самом деле возьмёт с другого member — экран должен обещать то, что
    // реально подставится.
    const ownWebSearchRows = (optionsByMember.get(p.id) ?? [])
      .filter(r => r.source === WEB_MATCH_TYPE)
      .slice()
      .sort((a, b) => a.price - b.price || a.id - b.id);
    const autoOptionId = ownWebSearchRows.length > 0 ? ownWebSearchRows[0].id : null;

    // auto_note: члены позиции, которым выгрузка НЕ подставит цену без явного выбора Ивана —
    // нет своих web_search found-строк последнего среза И нет выбора/счёта (anySelectedByMember,
    // источник-агностично — invoice тоже считается). Показываем только когда есть из чего
    // выбирать (options.length>0) — иначе это не «выберите вариант», а «цена не найдена»
    // (уже отдельным текстом).
    const uncoveredMembers = p.memberIds.filter(mid =>
      !anySelectedByMember.has(mid) && !(optionsByMember.get(mid) ?? []).some(r => r.source === WEB_MATCH_TYPE)
    ).length;
    const autoNote = options.length > 0 && uncoveredMembers > 0
      ? `в выгрузке цена будет только у ${p.memberIds.length - uncoveredMembers} из ${p.memberIds.length} строк этой позиции — выберите вариант, чтобы заполнить все`
      : null;

    const selectedOptionId = selectedByMember.get(p.id) ?? null;
    // Устаревший выбор: строка выбрана, но в последний срез уже не входит (свежий поиск её не
    // вернул) — не прячем результат прошлого выбора Ивана, добавляем отдельно со stale:true.
    if (selectedOptionId != null && !options.some(o => o.option_id === selectedOptionId)) {
      const staleRow = db.prepare(
        'SELECT id, spec_item_id, source, source_url, supplier_name, price, snapshot_date FROM external_prices WHERE id = ? AND project_id = ?'
      ).get(selectedOptionId, projectId) as OptionRow | undefined;
      if (staleRow) options.push(buildOption(sites, staleRow, true));
    }
    if (selectedOptionId != null) selectedCount++;

    // На экран — позиции группы C (искали) и любые позиции, у чьих members нашлась цена
    // (напр. supplier_price попал в группу A/D, но цену показать всё равно нужно).
    if (!isSearched && options.length === 0) continue;

    items.push({
      spec_item_id: p.id,
      member_ids: p.memberIds,
      name,
      mark: p.mark,
      qty: specRow?.quantity ?? null,
      searched: isSearched,
      reason_not_searched: isSearched ? null : (REASON_BY_GROUP[p.group] ?? 'не искали'),
      selected_option_id: selectedOptionId,
      auto_option_id: !anySelectedByMember.has(p.id) ? autoOptionId : null,
      auto_note: autoNote,
      invoice_price: invoiceByMember.get(p.id)?.price ?? null,
      invoice_supplier: invoiceByMember.get(p.id)?.supplier ?? null,
      other_selected_label: otherSelectedByMember.get(p.id) ?? null,
      invoice_restorable: selectedOptionId != null && findInvoiceRestoreCandidate(db, p.id) != null,
      skipped: skipByMember.has(p.id),
      options,
    });
  }

  const { last_search_at } = db.prepare(
    `SELECT MAX(finished_at) AS last_search_at FROM price_search_jobs WHERE project_id = ? AND status = 'done'`
  ).get(projectId) as { last_search_at: string | null };

  return {
    summary: {
      total: positions.length,
      searched,
      with_price: withPrice,
      own_price: ownPrice,
      selected: selectedCount,
      last_search_at,
    },
    items,
    not_searched_items: notSearched,
  };
}

// П.2: «вернуть цену из счёта» при сбросе варианта — invoice-матч, который стоял ДО выбора
// варианта, нигде не хранится отдельной таблицей, поэтому правило восстанавливает его по факту:
// подтверждённый (is_confirmed=1) матч побеждает; иначе, если у члена РОВНО один invoice-матч —
// это и есть прежний выбор (спутать не с чем); при ≥2 неподтверждённых — не гадаем, null (как
// сегодня — позиция остаётся без цены). Проверено SQL на копии прода (проекты 14/15,
// 19.09.2026): из 30/43 инвойс-выбранных позиций правило точно восстанавливает тот же match.id
// у 18/14, для остальных возвращает null (неоднозначно) — НИ РАЗУ не восстановило другую строку.
function findInvoiceRestoreCandidate(db: ReturnType<typeof getDatabase>, memberId: number): number | null {
  const rows = db.prepare(`
    SELECT id, is_confirmed FROM matched_items
    WHERE specification_item_id = ? AND source = 'invoice' AND invoice_item_id IS NOT NULL
  `).all(memberId) as Array<{ id: number; is_confirmed: number }>;
  if (rows.length === 0) return null;
  const confirmed = rows.find(r => r.is_confirmed === 1);
  if (confirmed) return confirmed.id;
  return rows.length === 1 ? rows[0].id : null;
}

// Член позиции без своей находки под выбранное предложение (тот же source/url/поставщик/цена,
// что у представителя или другого дубля) — оператор выбирает ценой ПОЗИЦИЮ целиком, а
// matched_items/price_list_items ключуются на сыром specification_item.id, поэтому каждому
// такому члену нужна СВОЯ строка external_prices. business_key = f21_carry_<источник>_to_<член>
// — детерминирован по паре (выбранная строка, член): повтор того же выбора обновит её же
// (ON CONFLICT в UPSERT_EXTERNAL_PRICE), а не расплодит копии; разные выборы — разные строки,
// поэтому getOrCreatePriceListMatchId/syncOneSourceVariants (row_index = external_prices.id)
// не путают строки разных members между собой.
function ensureMemberEquivalent(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  memberId: number,
  chosen: { id: number; source: string; source_url: string; supplier_name: string | null; price: number; snapshot_date: string },
): number {
  const existing = db.prepare(`
    SELECT id FROM external_prices
    WHERE project_id = ? AND spec_item_id = ? AND source = ? AND source_url = ?
      AND COALESCE(supplier_name, '') = COALESCE(?, '') AND price = ? AND status = 'found'
    ORDER BY snapshot_date DESC, id DESC LIMIT 1
  `).get(projectId, memberId, chosen.source, chosen.source_url, chosen.supplier_name, chosen.price) as { id: number } | undefined;
  if (existing) return existing.id;

  const memberRow = db.prepare('SELECT name FROM specification_items WHERE id = ?').get(memberId) as { name: string | null } | undefined;
  const now = nowIso();
  const businessKey = `f21_carry_${chosen.id}_to_${memberId}`;
  const row: Record<string, unknown> = {
    business_key: businessKey, project_id: projectId, spec_item_id: memberId,
    query_name: memberRow?.name ?? null, source: chosen.source, source_url: chosen.source_url,
    snapshot_date: chosen.snapshot_date, supplier_name: chosen.supplier_name,
    name: memberRow?.name ?? 'позиция', price: chosen.price, currency: 'RUB', status: 'found',
  };
  const params: Record<string, string | number | null> = {};
  for (const field of PRICE_FIELDS) params[field] = toBindable(row[field], now, field);
  db.prepare(UPSERT_EXTERNAL_PRICE).run(params);
  return (db.prepare('SELECT id FROM external_prices WHERE business_key = ?').get(businessKey) as { id: number }).id;
}

// GET /api/projects/:id/price-options
router.get('/api/projects/:id/price-options', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    res.json(buildPriceOptions(db, projectId));
  } catch (error) {
    console.error('GET /api/projects/:id/price-options error:', error);
    res.status(500).json({ error: 'Ошибка при получении вариантов цены' });
  }
});

// PUT /api/projects/:id/price-options/:specItemId — {option_id:number} | {option_id:null} | {skip:true}.
// :specItemId — id представителя позиции ИЛИ любого её дубля (member); выбор применяется ко
// ВСЕМ members позиции разом.
router.put('/api/projects/:id/price-options/:specItemId', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const clickedId = parseInt(String(req.params.specItemId), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!ensureMatchingNotRunning(projectId, res)) return;

    const positions = classifySpecPositions({ projectId }, db);
    const position = positions.find(p => p.memberIds.includes(clickedId));
    if (!position) return res.status(404).json({ error: 'Позиция спецификации не найдена в проекте' });
    const members = position.memberIds;

    const { option_id, skip } = req.body ?? {};

    // П.4: снимаем is_selected только у price_list-вариантов ЭТОГО экрана (file_path — один из
    // OPTION_SOURCES) — обычный, вручную выбранный прайс-лист поставщика этот UPDATE не трогает.
    const unselectOptionSourceMatch = db.prepare(`
      UPDATE matched_items SET is_selected = 0
      WHERE specification_item_id = ? AND source = 'price_list' AND id IN (
        SELECT m2.id FROM matched_items m2
        JOIN price_list_items pli2 ON pli2.id = m2.price_list_item_id
        JOIN price_lists pl2 ON pl2.id = pli2.price_list_id
        WHERE m2.specification_item_id = ? AND m2.is_selected = 1
          AND pl2.file_path IN (${OPTION_SOURCES.map(() => '?').join(',')})
      )
    `);

    if (skip === true) {
      db.transaction(() => {
        for (const memberId of members) {
          unselectOptionSourceMatch.run(memberId, memberId, ...OPTION_SOURCES);
          db.prepare('INSERT OR IGNORE INTO price_option_skip (specification_item_id) VALUES (?)').run(memberId);
        }
      })();
    } else if (option_id === null) {
      db.transaction(() => {
        for (const memberId of members) {
          unselectOptionSourceMatch.run(memberId, memberId, ...OPTION_SOURCES);
          db.prepare('DELETE FROM price_option_skip WHERE specification_item_id = ?').run(memberId);
          // П.2: сброс варианта возвращает цену счёта, если её можно восстановить однозначно
          // (findInvoiceRestoreCandidate) — иначе позиция остаётся без цены, как раньше.
          const restoreId = findInvoiceRestoreCandidate(db, memberId);
          if (restoreId != null) setSelectedMatch(db, memberId, restoreId);
        }
      })();
    } else if (typeof option_id === 'number') {
      const chosen = db.prepare(`
        SELECT id, spec_item_id, source, source_url, supplier_name, price, snapshot_date
        FROM external_prices WHERE id = ? AND project_id = ? AND status = 'found' AND price IS NOT NULL
      `).get(option_id, projectId) as {
        id: number; spec_item_id: number; source: string; source_url: string;
        supplier_name: string | null; price: number; snapshot_date: string;
      } | undefined;
      if (!chosen || !members.includes(chosen.spec_item_id)) {
        return res.status(400).json({ error: 'Вариант не найден среди найденных цен этой позиции' });
      }

      db.transaction(() => {
        for (const memberId of members) {
          const extId = memberId === chosen.spec_item_id
            ? chosen.id
            : ensureMemberEquivalent(db, projectId, memberId, chosen);
          const matchId = getOrCreatePriceListMatchId(db, projectId, extId);
          setSelectedMatch(db, memberId, matchId);
          db.prepare('DELETE FROM price_option_skip WHERE specification_item_id = ?').run(memberId);
        }
      })();
    } else {
      return res.status(400).json({ error: 'Тело запроса должно быть {option_id:number}, {option_id:null} или {skip:true}' });
    }

    const result = buildPriceOptions(db, projectId);
    const item = result.items.find(i => i.spec_item_id === position.id);
    res.json({ item, summary: result.summary });
  } catch (error) {
    console.error('PUT /api/projects/:id/price-options/:specItemId error:', error);
    res.status(500).json({ error: 'Ошибка при выборе варианта цены' });
  }
});

export default router;
