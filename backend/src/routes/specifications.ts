import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { parseExcelFile } from '../services/excelParser';

const UPLOAD_PATH = path.resolve(__dirname, '../../..', process.env.UPLOAD_PATH || '../data/uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_PATH)) {
  fs.mkdirSync(UPLOAD_PATH, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_PATH);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      cb(null, true);
    } else {
      cb(new Error('Допустимы только файлы .xlsx и .xls'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const router = Router();

// Fixed sections
const SECTIONS = [
  'Отопление',
  'Вентиляция',
  'ВК',
  'Тепломеханика/ИТП',
  'Автоматизация',
  'Кондиционирование',
  'Электрика',
  'Слаботочка',
];

// Fix garbled Cyrillic filenames (multer on Windows may encode as latin1)
function fixFilename(originalname: string): string {
  try {
    const fixed = Buffer.from(originalname, 'latin1').toString('utf8');
    if (fixed.includes('\ufffd')) return originalname;
    return fixed;
  } catch {
    return originalname;
  }
}

// GET /api/sections — list available sections
router.get('/api/sections', (_req: Request, res: Response) => {
  res.json({ sections: SECTIONS });
});

// POST /api/projects/:id/specifications — upload spec for a section
router.post('/api/projects/:id/specifications', upload.single('file'), (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const section = req.body.section;
    const db = getDatabase();

    if (!section || !SECTIONS.includes(section)) {
      return res.status(400).json({ error: 'Укажите корректный раздел', sections: SECTIONS });
    }

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Check if section already has a specification
    const existing = db.prepare(
      'SELECT id FROM specifications WHERE project_id = ? AND section = ?'
    ).get(projectId, section) as { id: number } | undefined;

    if (existing) {
      return res.status(409).json({ error: `Раздел «${section}» уже загружен. Удалите старый перед загрузкой нового.` });
    }

    // Parse Excel
    const parseResult = parseExcelFile(req.file.path);

    if (parseResult.items.length === 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: 'Не удалось извлечь данные из файла',
        details: parseResult.errors,
      });
    }

    const fileName = fixFilename(req.file.originalname);

    // Insert specification + items in a transaction
    const result = db.transaction(() => {
      const specResult = db.prepare(
        'INSERT INTO specifications (project_id, section, file_name) VALUES (?, ?, ?)'
      ).run(projectId, section, fileName);
      const specificationId = Number(specResult.lastInsertRowid);

      const insertStmt = db.prepare(`
        INSERT INTO specification_items
          (project_id, specification_id, position_number, name, characteristics, equipment_code, manufacturer, unit, quantity, section)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const inserted: any[] = [];
      for (const item of parseResult.items) {
        const itemResult = insertStmt.run(
          projectId,
          specificationId,
          item.position_number,
          item.name,
          item.characteristics,
          item.equipment_code,
          item.manufacturer,
          item.unit,
          item.quantity,
          section,
        );
        inserted.push({
          id: Number(itemResult.lastInsertRowid),
          project_id: projectId,
          specification_id: specificationId,
          ...item,
          section,
        });
      }

      return { specificationId, items: inserted };
    })();

    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});

    res.status(201).json({
      specificationId: result.specificationId,
      section,
      imported: result.items.length,
      errors: parseResult.errors,
      totalRows: parseResult.totalRows,
      skippedRows: parseResult.skippedRows,
    });
  } catch (error) {
    console.error('POST /api/projects/:id/specifications error:', error);
    res.status(500).json({
      error: 'Ошибка при импорте спецификации',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/specifications — list specifications by section
router.get('/api/projects/:id/specifications', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const specs = db.prepare(`
      SELECT s.id, s.section, s.file_name, s.created_at,
             (SELECT COUNT(*) FROM specification_items WHERE specification_id = s.id) as item_count
      FROM specifications s
      WHERE s.project_id = ?
      ORDER BY s.id
    `).all(projectId);

    res.json({ specifications: specs, sections: SECTIONS });
  } catch (error) {
    console.error('GET /api/projects/:id/specifications error:', error);
    res.status(500).json({ error: 'Ошибка при получении спецификаций' });
  }
});

// GET /api/projects/:id/specification — list ALL items (backward compat for matching)
router.get('/api/projects/:id/specification', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const items = db.prepare(
      'SELECT * FROM specification_items WHERE project_id = ? ORDER BY id'
    ).all(projectId);

    res.json({ items, total: items.length });
  } catch (error) {
    console.error('GET /api/projects/:id/specification error:', error);
    res.status(500).json({ error: 'Ошибка при получении спецификации' });
  }
});

// DELETE /api/specifications/:id — delete one specification + its items
router.delete('/api/specifications/:id', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const spec = db.prepare('SELECT id FROM specifications WHERE id = ?').get(specId);
    if (!spec) {
      return res.status(404).json({ error: 'Спецификация не найдена' });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM specification_items WHERE specification_id = ?').run(specId);
      db.prepare('DELETE FROM specifications WHERE id = ?').run(specId);
    })();

    res.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /api/specifications/:id error:', error);
    res.status(500).json({ error: 'Ошибка при удалении спецификации' });
  }
});

export default router;
