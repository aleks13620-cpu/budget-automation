import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import { classifySpecPositions } from '../services/specClassifier';
import {
  getOrCreatePriceListMatchId, setSelectedMatch, WEB_MATCH_TYPE,
  UPSERT_EXTERNAL_PRICE, PRICE_FIELDS, toBindable, nowIso,
} from './priceSearch';

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

function priceTypeForSource(source: string): PriceType {
  if (source === 'rusklimat_api' || source === 'supplier_price') return 'own';
  if (source === 'santech_price') return 'base';
  return 'public'; // web_search и прочий будущий поиск по рынку
}

type SiteRow = {
  id: number; name: string; domain: string | null; price_source: string;
  source_key: string | null; discount_pct: number;
};

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

function buildOption(sites: SiteRow[], row: OptionRow, stale: boolean): PriceOption {
  const site = findSite(sites, row.source, row.supplier_name, row.source_url);
  const priceType = priceTypeForSource(row.source);
  const discountPct = site && site.price_source !== 'api' ? site.discount_pct : 0;
  const prelimPrice = Math.round(row.price * (1 - discountPct / 100) * 100) / 100;
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

  const sites = db.prepare(
    'SELECT id, name, domain, price_source, source_key, discount_pct FROM supplier_sites'
  ).all() as SiteRow[];

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
  const selectedRows = db.prepare(`
    SELECT si.id AS spec_item_id, m.source AS m_source, pli.row_index AS row_index
    FROM matched_items m
    JOIN specification_items si ON si.id = m.specification_item_id
    LEFT JOIN price_list_items pli ON pli.id = m.price_list_item_id
    WHERE si.project_id = ? AND m.is_selected = 1
  `).all(projectId) as Array<{ spec_item_id: number; m_source: string; row_index: number | null }>;
  for (const r of selectedRows) {
    anySelectedByMember.add(r.spec_item_id);
    if (r.m_source === 'price_list' && r.row_index != null) selectedByMember.set(r.spec_item_id, r.row_index);
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
    let autoOptionId: number | null = null;
    let autoPrice = Infinity;
    const options: PriceOption[] = [];
    for (const rows of groups.values()) {
      // Отображаемая строка группы — своя строка представителя, если у него есть это
      // предложение, иначе любая (детерминированно — с наименьшим id).
      const display = rows.find(r => r.spec_item_id === p.id) ?? rows.slice().sort((a, b) => a.id - b.id)[0];
      const opt = buildOption(sites, display, false);
      if (opt.price_type === 'own') hasOwn = true;
      options.push(opt);
      // Автоподстановка выгрузки (exportPricing.ts:130-167,213) — минимальная web_search-цена
      // последнего среза; теперь минимум берём по всем members, а не только по представителю.
      if (display.source === WEB_MATCH_TYPE && display.price < autoPrice) {
        autoPrice = display.price;
        autoOptionId = display.id;
      }
    }
    if (hasOwn) ownPrice++;

    const selectedOptionId = selectedByMember.get(p.id) ?? null;
    // Устаревший выбор: строка выбрана, но в последний срез уже не входит (свежий поиск её не
    // вернул) — не прячем результат прошлого выбора Ивана, добавляем отдельно со stale:true.
    if (selectedOptionId != null && !options.some(o => o.option_id === selectedOptionId)) {
      const staleRow = db.prepare(
        'SELECT id, spec_item_id, source, source_url, supplier_name, price, snapshot_date FROM external_prices WHERE id = ?'
      ).get(selectedOptionId) as OptionRow | undefined;
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

    const positions = classifySpecPositions({ projectId }, db);
    const position = positions.find(p => p.memberIds.includes(clickedId));
    if (!position) return res.status(404).json({ error: 'Позиция спецификации не найдена в проекте' });
    const members = position.memberIds;

    const { option_id, skip } = req.body ?? {};

    if (skip === true) {
      db.transaction(() => {
        for (const memberId of members) {
          db.prepare(
            `UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ? AND source = 'price_list'`
          ).run(memberId);
          db.prepare('INSERT OR IGNORE INTO price_option_skip (specification_item_id) VALUES (?)').run(memberId);
        }
      })();
    } else if (option_id === null) {
      db.transaction(() => {
        for (const memberId of members) {
          db.prepare(
            `UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ? AND source = 'price_list'`
          ).run(memberId);
          db.prepare('DELETE FROM price_option_skip WHERE specification_item_id = ?').run(memberId);
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
