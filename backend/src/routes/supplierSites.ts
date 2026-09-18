import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';

const router = Router();

// Ф10 — снабженец Арты Иван правит здесь: откуда цена, «искать» и скидка договора.
// Таблица глобальная (supplier_sites), не по проекту — контракт зафиксирован оркестратором.
const PRICE_SOURCES = ['api', 'open_price', 'site_discount', 'price_file', 'search'] as const;
type PriceSource = typeof PRICE_SOURCES[number];

function isPriceSource(value: unknown): value is PriceSource {
  return typeof value === 'string' && (PRICE_SOURCES as readonly string[]).includes(value);
}

type SupplierSiteRow = {
  id: number;
  name: string;
  domain: string | null;
  price_source: PriceSource;
  source_key: string | null;
  search_enabled: number;
  discount_pct: number;
  note: string | null;
  sort_order: number | null;
};

// GET /api/supplier-sites — список поставщиков Арты для экрана Ивана
router.get('/api/supplier-sites', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const sites = db.prepare('SELECT * FROM supplier_sites ORDER BY sort_order, id').all();
    res.json(sites);
  } catch (error) {
    console.error('GET /api/supplier-sites error:', error);
    res.status(500).json({ error: 'Ошибка при получении списка поставщиков' });
  }
});

// PUT /api/supplier-sites/:id — Иван меняет «искать» / скидку / источник
router.put('/api/supplier-sites/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const existing = db.prepare('SELECT * FROM supplier_sites WHERE id = ?').get(id) as SupplierSiteRow | undefined;
    if (!existing) {
      return res.status(404).json({ error: 'Поставщик не найден' });
    }

    const { search_enabled, discount_pct, price_source } = req.body ?? {};

    if (price_source !== undefined && !isPriceSource(price_source)) {
      return res.status(400).json({ error: `Неизвестный источник цены: ${price_source}` });
    }
    const effectiveSource: PriceSource = price_source !== undefined ? price_source : existing.price_source;

    if (discount_pct !== undefined) {
      if (effectiveSource === 'api') {
        return res.status(400).json({ error: 'У API цена уже персональная' });
      }
      if (typeof discount_pct !== 'number' || !Number.isFinite(discount_pct) || discount_pct < 0 || discount_pct > 90) {
        return res.status(400).json({ error: 'Скидка должна быть числом от 0 до 90' });
      }
    }

    if (search_enabled !== undefined && typeof search_enabled !== 'boolean'
      && search_enabled !== 0 && search_enabled !== 1) {
      return res.status(400).json({ error: 'Поле search_enabled должно быть true/false или 0/1' });
    }

    db.prepare(`
      UPDATE supplier_sites SET
        search_enabled = COALESCE(?, search_enabled),
        discount_pct = COALESCE(?, discount_pct),
        price_source = COALESCE(?, price_source),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      search_enabled === undefined ? null : (search_enabled ? 1 : 0),
      discount_pct === undefined ? null : discount_pct,
      price_source === undefined ? null : price_source,
      id,
    );

    const updated = db.prepare('SELECT * FROM supplier_sites WHERE id = ?').get(id);
    res.json(updated);
  } catch (error) {
    console.error('PUT /api/supplier-sites/:id error:', error);
    res.status(500).json({ error: 'Ошибка при обновлении поставщика' });
  }
});

// POST /api/supplier-sites — добавить нового поставщика в список Ивана
router.post('/api/supplier-sites', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const { name, domain, price_source } = req.body ?? {};

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      return res.status(400).json({ error: 'Название поставщика обязательно' });
    }
    if (!isPriceSource(price_source)) {
      return res.status(400).json({ error: `Неизвестный источник цены: ${price_source}` });
    }

    const dup = db.prepare('SELECT id FROM supplier_sites WHERE name = ?').get(trimmedName);
    if (dup) {
      return res.status(400).json({ error: `Поставщик «${trimmedName}» уже есть в списке` });
    }

    const { maxSort } = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM supplier_sites'
    ).get() as { maxSort: number };

    const result = db.prepare(`
      INSERT INTO supplier_sites (name, domain, price_source, source_key, sort_order)
      VALUES (?, ?, ?, NULL, ?)
    `).run(trimmedName, typeof domain === 'string' && domain.trim() ? domain.trim() : null, price_source, maxSort + 1);

    const created = db.prepare('SELECT * FROM supplier_sites WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (error) {
    console.error('POST /api/supplier-sites error:', error);
    res.status(500).json({ error: 'Ошибка при добавлении поставщика' });
  }
});

export default router;
