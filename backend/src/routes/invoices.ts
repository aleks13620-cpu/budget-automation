import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { parsePdfFile, extractRawRows, detectColumns, SavedMapping } from '../services/pdfParser';
import { parseExcelInvoice, extractExcelRawRows } from '../services/excelInvoiceParser';

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
    if (ext === '.pdf' || ext === '.xlsx' || ext === '.xls') {
      cb(null, true);
    } else {
      cb(new Error('Допустимы только файлы .pdf, .xlsx, .xls'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const router = Router();

// Helper: load saved parser config for a supplier
function loadSavedMapping(supplierId: number): SavedMapping | undefined {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT config FROM supplier_parser_configs WHERE supplier_id = ?'
  ).get(supplierId) as { config: string } | undefined;

  if (!row) return undefined;

  try {
    const config = JSON.parse(row.config);
    if (typeof config.headerRow === 'number' && config.name !== undefined) {
      return config as SavedMapping;
    }
  } catch {
    // invalid JSON, ignore
  }
  return undefined;
}

// POST /api/projects/:id/invoices — upload and parse invoice (PDF/Excel)
router.post('/api/projects/:id/invoices', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    // First pass: parse without saved config to get supplier name
    const initialResult = ext === '.pdf'
      ? await parsePdfFile(req.file.path)
      : parseExcelInvoice(req.file.path);

    // Find or create supplier
    let supplierId: number | null = null;
    if (initialResult.supplierName) {
      const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(initialResult.supplierName) as { id: number } | undefined;
      if (existing) {
        supplierId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(initialResult.supplierName);
        supplierId = Number(result.lastInsertRowid);
      }
    }

    // Check for saved parser config and re-parse if available
    let parseResult = initialResult;
    if (supplierId) {
      const savedMapping = loadSavedMapping(supplierId);
      if (savedMapping) {
        parseResult = ext === '.pdf'
          ? await parsePdfFile(req.file.path, savedMapping)
          : parseExcelInvoice(req.file.path, savedMapping);
      }
    }

    if (parseResult.items.length === 0) {
      return res.status(400).json({
        error: 'Не удалось извлечь данные из файла',
        details: parseResult.errors,
      });
    }

    // Insert invoice and items in a transaction
    const insertInvoice = db.prepare(`
      INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, file_name, file_path, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'parsed')
    `);

    const insertItem = db.prepare(`
      INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, price, amount, row_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = db.transaction(() => {
      const invoiceResult = insertInvoice.run(
        projectId,
        supplierId,
        parseResult.invoiceNumber,
        parseResult.invoiceDate,
        req.file!.originalname,
        req.file!.path,
        parseResult.totalAmount,
      );
      const invoiceId = Number(invoiceResult.lastInsertRowid);

      const insertedItems: any[] = [];
      for (const item of parseResult.items) {
        const itemResult = insertItem.run(
          invoiceId,
          item.article,
          item.name,
          item.unit,
          item.quantity,
          item.price,
          item.amount,
          item.row_index,
        );
        insertedItems.push({
          id: Number(itemResult.lastInsertRowid),
          invoice_id: invoiceId,
          ...item,
        });
      }

      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      return { invoice, items: insertedItems };
    })();

    res.status(201).json({
      invoice: result.invoice,
      imported: result.items.length,
      errors: parseResult.errors,
      items: result.items,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при импорте счёта',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/invoices/:id/preview — preview raw rows + detected/saved mapping
router.get('/api/invoices/:id/preview', async (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, file_name, file_path, supplier_id FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }

    const ext = path.extname(invoice.file_name).toLowerCase();
    let rows: string[][];

    if (ext === '.pdf') {
      const result = await extractRawRows(invoice.file_path);
      rows = result.rows;
    } else {
      rows = extractExcelRawRows(invoice.file_path);
    }

    // Limit to first 20 rows for preview
    const previewRows = rows.slice(0, 20);

    // Auto-detect column mapping
    const detected = detectColumns(rows);
    const detectedMapping = detected ? {
      ...detected.mapping,
      headerRow: detected.headerRowIndex,
    } : null;

    // Check for saved supplier config
    let supplierConfig: SavedMapping | null = null;
    if (invoice.supplier_id) {
      const saved = loadSavedMapping(invoice.supplier_id);
      if (saved) supplierConfig = saved;
    }

    res.json({
      rows: previewRows,
      totalRows: rows.length,
      detectedMapping,
      supplierConfig,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при предпросмотре счёта',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/invoices — list invoices for project
router.get('/api/projects/:id/invoices', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const invoices = db.prepare(`
      SELECT i.*, s.name as supplier_name,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
      FROM invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.project_id = ?
      ORDER BY i.created_at DESC
    `).all(projectId);

    res.json({ invoices, total: invoices.length });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении счетов' });
  }
});

// GET /api/invoices/:id — single invoice with items
router.get('/api/invoices/:id', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(`
      SELECT i.*, s.name as supplier_name
      FROM invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.id = ?
    `).get(invoiceId);

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    const items = db.prepare(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index'
    ).all(invoiceId);

    res.json({ invoice, items });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении счёта' });
  }
});

// DELETE /api/invoices/:id — delete invoice + items + file
router.delete('/api/invoices/:id', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare('SELECT id, file_path FROM invoices WHERE id = ?').get(invoiceId) as { id: number; file_path: string | null } | undefined;
    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    // Delete from DB (cascade deletes invoice_items)
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);

    // Delete file from disk
    if (invoice.file_path) {
      fs.unlink(invoice.file_path, () => {});
    }

    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении счёта' });
  }
});

export default router;
