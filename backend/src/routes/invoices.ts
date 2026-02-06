import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { parsePdfFile } from '../services/pdfParser';

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
    if (ext === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('Допустимы только файлы .pdf'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const router = Router();

// POST /api/projects/:id/invoices — upload and parse PDF invoice
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

    // Parse PDF (async)
    const parseResult = await parsePdfFile(req.file.path);

    if (parseResult.items.length === 0) {
      return res.status(400).json({
        error: 'Не удалось извлечь данные из файла',
        details: parseResult.errors,
      });
    }

    // Find or create supplier
    let supplierId: number | null = null;
    if (parseResult.supplierName) {
      const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(parseResult.supplierName) as { id: number } | undefined;
      if (existing) {
        supplierId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(parseResult.supplierName);
        supplierId = Number(result.lastInsertRowid);
      }
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
      SELECT i.*, s.name as supplier_name
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
