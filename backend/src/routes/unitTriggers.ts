import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';

const router = Router();

interface UnitTriggerRow {
  id: number;
  keyword: string;
  from_unit: string | null;
  to_unit: string;
  description: string | null;
  created_at: string;
}

// GET /api/unit-conversion-triggers
router.get('/api/unit-conversion-triggers', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM unit_conversion_triggers ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении триггеров', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/unit-conversion-triggers
router.post('/api/unit-conversion-triggers', (req: Request, res: Response) => {
  try {
    const { keyword, from_unit, to_unit, description } = req.body as Partial<UnitTriggerRow>;
    if (!keyword || !to_unit) {
      return res.status(400).json({ error: 'keyword и to_unit обязательны' });
    }

    const db = getDatabase();
    const result = db.prepare(
      'INSERT INTO unit_conversion_triggers (keyword, from_unit, to_unit, description) VALUES (?, ?, ?, ?)'
    ).run(String(keyword).trim(), from_unit || null, String(to_unit).trim(), description || null);

    const row = db.prepare('SELECT * FROM unit_conversion_triggers WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании триггера', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/unit-conversion-triggers/:id
router.put('/api/unit-conversion-triggers/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { keyword, from_unit, to_unit, description } = req.body as Partial<UnitTriggerRow>;
    if (!keyword || !to_unit) {
      return res.status(400).json({ error: 'keyword и to_unit обязательны' });
    }

    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM unit_conversion_triggers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Триггер не найден' });

    db.prepare(
      'UPDATE unit_conversion_triggers SET keyword = ?, from_unit = ?, to_unit = ?, description = ? WHERE id = ?'
    ).run(String(keyword).trim(), from_unit || null, String(to_unit).trim(), description || null, id);

    const row = db.prepare('SELECT * FROM unit_conversion_triggers WHERE id = ?').get(id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обновлении триггера', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /api/unit-conversion-triggers/:id
router.delete('/api/unit-conversion-triggers/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM unit_conversion_triggers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Триггер не найден' });

    db.prepare('DELETE FROM unit_conversion_triggers WHERE id = ?').run(id);
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении триггера', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
