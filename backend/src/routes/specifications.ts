import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { parseExcelFile } from '../services/excelParser';
import { detectSection } from '../services/sectionDetector';

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

// POST /api/projects/:id/specification — upload and import Excel
router.post('/api/projects/:id/specification', upload.single('file'), (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    // Check project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Parse Excel
    const parseResult = parseExcelFile(req.file.path);

    if (parseResult.items.length === 0) {
      return res.status(400).json({
        error: 'Не удалось извлечь данные из файла',
        details: parseResult.errors,
      });
    }

    // Insert items in a transaction
    const insertStmt = db.prepare(`
      INSERT INTO specification_items
        (project_id, position_number, name, characteristics, equipment_code, manufacturer, unit, quantity, section)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
      const inserted: any[] = [];
      for (const item of parseResult.items) {
        const section = detectSection(item.name, item.characteristics);
        const result = insertStmt.run(
          projectId,
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
          id: result.lastInsertRowid,
          project_id: projectId,
          ...item,
          section,
        });
      }
      return inserted;
    });

    const items = insertAll();

    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});

    res.status(201).json({
      imported: items.length,
      errors: parseResult.errors,
      totalRows: parseResult.totalRows,
      skippedRows: parseResult.skippedRows,
      items,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при импорте спецификации',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/specification — list all items
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
    res.status(500).json({ error: 'Ошибка при получении спецификации' });
  }
});

// DELETE /api/projects/:id/specification — delete all items for project
router.delete('/api/projects/:id/specification', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const result = db.prepare('DELETE FROM specification_items WHERE project_id = ?').run(projectId);

    res.json({ deleted: result.changes });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении спецификации' });
  }
});

export default router;
