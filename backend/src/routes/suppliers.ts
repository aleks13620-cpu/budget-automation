import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';

const router = Router();

// GET /api/suppliers — list all suppliers
router.get('/api/suppliers', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    res.json({ suppliers });
  } catch (error) {
    console.error('GET /api/suppliers error:', error);
    res.status(500).json({ error: 'Ошибка при получении поставщиков' });
  }
});

// GET /api/suppliers/:id/parser-config — get saved parser config
router.get('/api/suppliers/:id/parser-config', (req: Request, res: Response) => {
  try {
    const supplierId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) {
      return res.status(404).json({ error: 'Поставщик не найден' });
    }

    const row = db.prepare(
      'SELECT * FROM supplier_parser_configs WHERE supplier_id = ?'
    ).get(supplierId) as { id: number; supplier_id: number; config: string } | undefined;

    if (!row) {
      return res.json({ config: null });
    }

    res.json({ config: JSON.parse(row.config) });
  } catch (error) {
    console.error('GET /api/suppliers/:id/parser-config error:', error);
    res.status(500).json({ error: 'Ошибка при получении конфигурации парсера' });
  }
});

// PUT /api/suppliers/:id/parser-config — save/update parser config (UPSERT)
router.put('/api/suppliers/:id/parser-config', (req: Request, res: Response) => {
  try {
    const supplierId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) {
      return res.status(404).json({ error: 'Поставщик не найден' });
    }

    const { config } = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Конфигурация обязательна' });
    }

    const configJson = JSON.stringify(config);

    db.prepare(`
      INSERT INTO supplier_parser_configs (supplier_id, config)
      VALUES (?, ?)
      ON CONFLICT(supplier_id) DO UPDATE SET
        config = excluded.config,
        updated_at = CURRENT_TIMESTAMP
    `).run(supplierId, configJson);

    res.json({ saved: true, config });
  } catch (error) {
    console.error('PUT /api/suppliers/:id/parser-config error:', error);
    res.status(500).json({ error: 'Ошибка при сохранении конфигурации парсера' });
  }
});

export default router;
