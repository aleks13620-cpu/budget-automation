import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import {
  parsePdfFile, parsePdfFromExtracted, extractRawRows,
  detectColumns, SavedMapping, categorizeParsingResult,
} from '../services/pdfParser';
import { parseExcelInvoice, extractExcelRawRows, extractExcelPreviewData } from '../services/excelInvoiceParser';

const UPLOAD_PATH = path.resolve(__dirname, '../../..', process.env.UPLOAD_PATH || '../data/uploads');
if (!fs.existsSync(UPLOAD_PATH)) fs.mkdirSync(UPLOAD_PATH, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_PATH),
  filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Допустимы только .pdf, .xlsx, .xls'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

function fixFilename(originalname: string): string {
  try {
    const fixed = Buffer.from(originalname, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? originalname : fixed;
  } catch { return originalname; }
}

const router = Router();

// POST /api/projects/:id/price-lists — upload and parse price list
router.post('/api/projects/:id/price-lists', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const fileName = fixFilename(req.file.originalname);
    const ext = path.extname(fileName).toLowerCase();

    const parseResult = ext === '.pdf'
      ? await parsePdfFile(req.file.path)
      : parseExcelInvoice(req.file.path);

    const status = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';

    const priceListId = Number(db.prepare(`
      INSERT INTO price_lists (project_id, file_name, file_path, status)
      VALUES (?, ?, ?, ?)
    `).run(projectId, fileName, req.file.path, status).lastInsertRowid);

    if (parseResult.items.length > 0) {
      const insertItem = db.prepare(`
        INSERT INTO price_list_items (price_list_id, article, name, unit, price, row_index)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertAll = db.transaction(() => {
        for (const item of parseResult.items) {
          insertItem.run(priceListId, item.article, item.name, item.unit, item.price, item.row_index);
        }
      });
      insertAll();
    }

    res.status(201).json({
      priceListId,
      fileName,
      imported: parseResult.items.length,
      status,
      errors: parseResult.errors,
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при загрузке прайса', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/projects/:id/price-lists
router.get('/api/projects/:id/price-lists', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT pl.*, s.name as supplier_name,
             (SELECT COUNT(*) FROM price_list_items WHERE price_list_id = pl.id) as item_count
      FROM price_lists pl
      LEFT JOIN suppliers s ON pl.supplier_id = s.id
      WHERE pl.project_id = ?
      ORDER BY pl.created_at DESC
    `).all(projectId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении прайсов', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/price-lists/:id
router.get('/api/price-lists/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const row = db.prepare(`
      SELECT pl.*, s.name as supplier_name
      FROM price_lists pl LEFT JOIN suppliers s ON pl.supplier_id = s.id
      WHERE pl.id = ?
    `).get(id);
    if (!row) return res.status(404).json({ error: 'Прайс не найден' });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /api/price-lists/:id
router.delete('/api/price-lists/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const row = db.prepare('SELECT id, file_path FROM price_lists WHERE id = ?').get(id) as { id: number; file_path: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Прайс не найден' });
    db.prepare('DELETE FROM price_lists WHERE id = ?').run(id);
    if (row.file_path) fs.unlink(row.file_path, () => {});
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/price-lists/:id/items
router.get('/api/price-lists/:id/items', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const pl = db.prepare('SELECT id FROM price_lists WHERE id = ?').get(id);
    if (!pl) return res.status(404).json({ error: 'Прайс не найден' });
    const items = db.prepare('SELECT * FROM price_list_items WHERE price_list_id = ? ORDER BY row_index').all(id);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/price-lists/:id/preview — raw rows preview (like invoice preview)
router.get('/api/price-lists/:id/preview', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const pl = db.prepare('SELECT * FROM price_lists WHERE id = ?').get(id) as any;
    if (!pl) return res.status(404).json({ error: 'Прайс не найден' });

    const ext = path.extname(pl.file_name).toLowerCase();
    const isExcel = ['.xlsx', '.xls'].includes(ext);

    if (isExcel) {
      const sheetIndex = parseInt(String(req.query.sheet || '0'), 10);
      const previewData = extractExcelPreviewData(pl.file_path, sheetIndex, 200);
      const config = pl.parser_config ? JSON.parse(pl.parser_config) : null;
      res.set('Cache-Control', 'no-store');
      return res.json({ ...previewData, supplierConfig: config, parsingCategory: pl.status === 'needs_mapping' ? 'B' : 'A' });
    } else {
      const { rows, fullText } = await extractRawRows(pl.file_path);
      const detected = detectColumns(rows);
      const config = pl.parser_config ? JSON.parse(pl.parser_config) : null;
      res.set('Cache-Control', 'no-store');
      return res.json({
        rows, fullText,
        totalRows: rows.length,
        detectedMapping: detected ? { ...detected.mapping, headerRow: detected.headerRowIndex } : null,
        supplierConfig: config,
        parsingCategory: pl.status === 'needs_mapping' ? 'B' : 'A',
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при предпросмотре', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/price-lists/:id/parser-config — save column mapping
router.put('/api/price-lists/:id/parser-config', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const { config } = req.body as { config: SavedMapping };
    const db = getDatabase();
    const pl = db.prepare('SELECT id FROM price_lists WHERE id = ?').get(id);
    if (!pl) return res.status(404).json({ error: 'Прайс не найден' });
    db.prepare('UPDATE price_lists SET parser_config = ? WHERE id = ?').run(JSON.stringify(config), id);
    res.json({ saved: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при сохранении конфига', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/price-lists/:id/reparse — reparse with saved/provided mapping
router.put('/api/price-lists/:id/reparse', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const pl = db.prepare('SELECT * FROM price_lists WHERE id = ?').get(id) as any;
    if (!pl) return res.status(404).json({ error: 'Прайс не найден' });

    const savedMapping: SavedMapping | undefined = req.body.mapping || (pl.parser_config ? JSON.parse(pl.parser_config) : undefined);
    const ext = path.extname(pl.file_name).toLowerCase();

    const parseResult = ext === '.pdf'
      ? await parsePdfFile(pl.file_path, savedMapping)
      : parseExcelInvoice(pl.file_path, savedMapping);

    const newStatus = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';

    db.transaction(() => {
      db.prepare('DELETE FROM price_list_items WHERE price_list_id = ?').run(id);
      db.prepare('UPDATE price_lists SET status = ?, parser_config = ? WHERE id = ?')
        .run(newStatus, savedMapping ? JSON.stringify(savedMapping) : pl.parser_config, id);

      const insertItem = db.prepare(`
        INSERT INTO price_list_items (price_list_id, article, name, unit, price, row_index)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of parseResult.items) {
        insertItem.run(id, item.article, item.name, item.unit, item.price, item.row_index);
      }
    })();

    res.json({ imported: parseResult.items.length, status: newStatus, errors: parseResult.errors });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при пересборке прайса', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
