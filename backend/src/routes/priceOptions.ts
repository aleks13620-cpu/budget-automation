import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import { classifySpecItem, buildFullName } from '../services/specClassifier';
import type { SpecItemRow } from '../services/specClassifier';
import { getOrCreatePriceListMatchId, setSelectedMatch, WEB_MATCH_TYPE } from './priceSearch';

/**
 * Ф21.1 — «API вариантов цены». Снабженец Иван на одном экране видит у каждой позиции
 * спецификации все варианты цены (поставщик, тип, дата, цена → скидка Арты → предварительно)
 * и выбирает одним нажатием.
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
}

export interface PriceOptionItem {
  spec_item_id: number;
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
  // Позиция здесь = строка specification_items как есть, БЕЗ дедупликации classifySpecPositions:
  // matched_items/price_list_items/external_prices всюду ключуются на сыром specification_item.id,
  // а classifySpecPositions схлопывает повторяющиеся строки в одну «позицию» (нужно только
  // для счётчика /spec-groups) — на проекте 16 такой пары 4, и цена Ф13 у них СВОЯ на каждую
  // строку. Дедуп здесь потерял бы у Ивана выбор для «схлопнутой» строки молча.
  const specRows = db.prepare(
    'SELECT * FROM specification_items WHERE project_id = ?'
  ).all(projectId) as SpecItemRow[];
  const specById = new Map(specRows.map(r => [r.id, r]));
  const positions = specRows.map(r => {
    const fullName = buildFullName(r, specById);
    return { id: r.id, ...classifySpecItem(r, fullName) };
  });

  const sites = db.prepare(
    'SELECT id, name, domain, price_source, source_key, discount_pct FROM supplier_sites'
  ).all() as SiteRow[];

  // Все found-строки последнего среза КАЖДОГО source по проекту (не только rn=1 — этим и
  // отличается от syncOneSourceVariants/exportPricing, которым хватало одного варианта).
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

  const optionsBySpecItem = new Map<number, OptionRow[]>();
  const autoBySpecItem = new Map<number, number>();
  for (const row of optionRows) {
    if (!optionsBySpecItem.has(row.spec_item_id)) optionsBySpecItem.set(row.spec_item_id, []);
    optionsBySpecItem.get(row.spec_item_id)!.push(row);
    // Строки уже упорядочены price ASC, id ASC внутри позиции — первая web_search-строка и
    // есть минимум, ровно то, что сама подставит выгрузка (exportPricing.ts:130-167,213).
    if (row.source === WEB_MATCH_TYPE && !autoBySpecItem.has(row.spec_item_id)) {
      autoBySpecItem.set(row.spec_item_id, row.id);
    }
  }

  // Выбранный вариант (любой источник) — гасит автоподстановку, как и в exportPricing.
  const anySelected = new Set<number>();
  // Выбранный ИМЕННО price_list-вариант — его external_prices.id и есть selected_option_id.
  const selectedBySpecItem = new Map<number, number>();
  const selectedRows = db.prepare(`
    SELECT si.id AS spec_item_id, m.source AS m_source, pli.row_index AS row_index
    FROM matched_items m
    JOIN specification_items si ON si.id = m.specification_item_id
    LEFT JOIN price_list_items pli ON pli.id = m.price_list_item_id
    WHERE si.project_id = ? AND m.is_selected = 1
  `).all(projectId) as Array<{ spec_item_id: number; m_source: string; row_index: number | null }>;
  for (const r of selectedRows) {
    anySelected.add(r.spec_item_id);
    if (r.m_source === 'price_list' && r.row_index != null) selectedBySpecItem.set(r.spec_item_id, r.row_index);
  }

  const skipSet = new Set<number>(
    (db.prepare(`
      SELECT pos.specification_item_id AS id FROM price_option_skip pos
      JOIN specification_items si ON si.id = pos.specification_item_id
      WHERE si.project_id = ?
    `).all(projectId) as Array<{ id: number }>).map(r => r.id)
  );

  let searched = 0, withPrice = 0, ownPrice = 0, selectedCount = 0;
  const notSearched: Array<{ spec_item_id: number; name: string }> = [];

  const items: PriceOptionItem[] = positions.map(p => {
    const specRow = specById.get(p.id);
    const name = specRow?.name ?? '';
    const isSearched = p.group.startsWith('C');
    if (isSearched) searched++; else notSearched.push({ spec_item_id: p.id, name });

    const rawOptions = optionsBySpecItem.get(p.id) ?? [];
    if (rawOptions.length > 0) withPrice++;

    let hasOwn = false;
    const options: PriceOption[] = rawOptions.map(o => {
      const site = findSite(sites, o.source, o.supplier_name, o.source_url);
      const priceType = priceTypeForSource(o.source);
      if (priceType === 'own') hasOwn = true;
      const discountPct = site && site.price_source !== 'api' ? site.discount_pct : 0;
      const prelimPrice = Math.round(o.price * (1 - discountPct / 100) * 100) / 100;
      const domain = site?.domain ?? hostOf(o.source_url);
      return {
        option_id: o.id,
        supplier_label: site?.name ?? (o.supplier_name || domain || 'без названия'),
        domain: domain ?? null,
        source: o.source,
        price_type: priceType,
        base_price: o.price,
        discount_pct: discountPct,
        prelim_price: prelimPrice,
        snapshot_date: o.snapshot_date,
        url: /^https?:\/\//i.test(o.source_url) ? o.source_url : '',
        is_own_supplier: !!site,
      };
    });
    if (hasOwn) ownPrice++;

    const selectedOptionId = selectedBySpecItem.get(p.id) ?? null;
    if (selectedOptionId != null) selectedCount++;

    return {
      spec_item_id: p.id,
      name,
      mark: p.mark,
      qty: specRow?.quantity ?? null,
      searched: isSearched,
      reason_not_searched: isSearched ? null : (REASON_BY_GROUP[p.group] ?? 'не искали'),
      selected_option_id: selectedOptionId,
      auto_option_id: !anySelected.has(p.id) ? (autoBySpecItem.get(p.id) ?? null) : null,
      skipped: skipSet.has(p.id),
      options,
    };
  });

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

// PUT /api/projects/:id/price-options/:specItemId — {option_id:number} | {option_id:null} | {skip:true}
router.put('/api/projects/:id/price-options/:specItemId', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const specItemId = parseInt(String(req.params.specItemId), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const specItem = db.prepare(
      'SELECT id FROM specification_items WHERE id = ? AND project_id = ?'
    ).get(specItemId, projectId);
    if (!specItem) return res.status(404).json({ error: 'Позиция спецификации не найдена в проекте' });

    const { option_id, skip } = req.body ?? {};

    if (skip === true) {
      db.transaction(() => {
        db.prepare(
          `UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ? AND source = 'price_list'`
        ).run(specItemId);
        db.prepare(
          'INSERT OR IGNORE INTO price_option_skip (specification_item_id) VALUES (?)'
        ).run(specItemId);
      })();
    } else if (option_id === null) {
      db.transaction(() => {
        db.prepare(
          `UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ? AND source = 'price_list'`
        ).run(specItemId);
        db.prepare('DELETE FROM price_option_skip WHERE specification_item_id = ?').run(specItemId);
      })();
    } else if (typeof option_id === 'number') {
      const ext = db.prepare(
        `SELECT id FROM external_prices
          WHERE id = ? AND project_id = ? AND spec_item_id = ? AND status = 'found' AND price IS NOT NULL`
      ).get(option_id, projectId, specItemId);
      if (!ext) {
        return res.status(400).json({ error: 'Вариант не найден среди найденных цен этой позиции' });
      }

      db.transaction(() => {
        const matchId = getOrCreatePriceListMatchId(db, projectId, option_id);
        setSelectedMatch(db, specItemId, matchId);
        db.prepare('DELETE FROM price_option_skip WHERE specification_item_id = ?').run(specItemId);
      })();
    } else {
      return res.status(400).json({ error: 'Тело запроса должно быть {option_id:number}, {option_id:null} или {skip:true}' });
    }

    const result = buildPriceOptions(db, projectId);
    const item = result.items.find(i => i.spec_item_id === specItemId);
    res.json({ item, summary: result.summary });
  } catch (error) {
    console.error('PUT /api/projects/:id/price-options/:specItemId error:', error);
    res.status(500).json({ error: 'Ошибка при выборе варианта цены' });
  }
});

export default router;
