import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { parsePdfFile, parsePdfFromExtracted, extractRawRows, detectColumns, SavedMapping, categorizeParsingResult } from '../services/pdfParser';
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

// Fix garbled Cyrillic filenames (multer on Windows may encode as latin1)
function fixFilename(originalname: string): string {
  try {
    const fixed = Buffer.from(originalname, 'latin1').toString('utf8');
    // If result contains replacement chars, keep original
    if (fixed.includes('\ufffd')) return originalname;
    return fixed;
  } catch {
    return originalname;
  }
}

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

    // For PDF: extract raw data once, reuse for parsing and categorization
    let pdfRawRows: string[][] | null = null;
    let pdfFullText: string | null = null;

    // First pass: parse without saved config to get supplier name
    let initialResult;
    if (ext === '.pdf') {
      const rawExtraction = await extractRawRows(req.file.path);
      pdfRawRows = rawExtraction.rows;
      pdfFullText = rawExtraction.fullText;
      initialResult = parsePdfFromExtracted(pdfRawRows, pdfFullText);
    } else {
      initialResult = parseExcelInvoice(req.file.path);
    }

    // Find or create supplier
    let supplierName = initialResult.supplierName;

    // Fallback: try to match supplier from filename (e.g. "НЗВЗ Заказ..." → search for "НЗВЗ")
    if (!supplierName) {
      const fileName = fixFilename(req.file!.originalname);
      const baseName = path.basename(fileName, path.extname(fileName));
      // Extract first word (at least 3 chars, Cyrillic or Latin)
      const firstWordMatch = baseName.match(/^[+\s]*([A-Za-zА-Яа-яёЁ]{3,})/);
      if (firstWordMatch) {
        const keyword = firstWordMatch[1];
        const found = db.prepare(
          'SELECT id, name FROM suppliers WHERE name LIKE ? LIMIT 1'
        ).get(`%${keyword}%`) as { id: number; name: string } | undefined;
        if (found) {
          supplierName = found.name;
        }
      }
    }

    let supplierId: number | null = null;
    if (supplierName) {
      const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(supplierName) as { id: number } | undefined;
      if (existing) {
        supplierId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(supplierName);
        supplierId = Number(result.lastInsertRowid);
      }
    }

    // Check for saved parser config and re-parse if available
    let parseResult = initialResult;
    if (supplierId) {
      const savedMapping = loadSavedMapping(supplierId);
      if (savedMapping) {
        if (ext === '.pdf' && pdfRawRows && pdfFullText !== null) {
          parseResult = parsePdfFromExtracted(pdfRawRows, pdfFullText, savedMapping);
        } else {
          parseResult = parseExcelInvoice(req.file.path, savedMapping);
        }
      }
    }

    // Categorize parsing result
    let parsingCategory: string;
    let parsingCategoryReason: string;

    if (ext === '.pdf' && pdfRawRows && pdfFullText !== null) {
      const cat = categorizeParsingResult(parseResult, pdfRawRows, pdfFullText);
      parsingCategory = cat.category;
      parsingCategoryReason = cat.reason;
    } else {
      // Excel: always readable, A if items found, B if not
      if (parseResult.items.length > 0) {
        parsingCategory = 'A';
        parsingCategoryReason = `Успешно: ${parseResult.items.length} позиций`;
      } else {
        parsingCategory = 'B';
        parsingCategoryReason = 'Колонки не распознаны';
      }
    }

    const status = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';

    const fileName = fixFilename(req.file!.originalname);
    console.log(`Invoice parse: file=${fileName}, items=${parseResult.items.length}, status=${status}, errors=${parseResult.errors.length}`);

    // Insert invoice and items in a transaction (even if 0 items)
    const insertInvoice = db.prepare(`
      INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, file_name, file_path, total_amount, status, parsing_category, parsing_category_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        fileName,
        req.file!.path,
        parseResult.totalAmount,
        status,
        parsingCategory,
        parsingCategoryReason,
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
      needsMapping: status === 'needs_mapping',
      parsingCategory,
      parsingCategoryReason,
    });
  } catch (error) {
    console.error('POST /api/projects/:id/invoices error:', error);
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
      'SELECT id, file_name, file_path, supplier_id, parsing_category, parsing_category_reason FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; file_name: string; file_path: string; supplier_id: number | null; parsing_category: string | null; parsing_category_reason: string | null } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: 'Файл счёта не найден на диске' });
    }

    const ext = path.extname(invoice.file_name).toLowerCase();
    let rows: string[][];
    let fullText: string | null = null;

    if (ext === '.pdf') {
      const result = await extractRawRows(invoice.file_path);
      rows = result.rows;
      fullText = result.fullText;
    } else {
      rows = extractExcelRawRows(invoice.file_path);
    }

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

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');

    const response: Record<string, any> = {
      rows,
      totalRows: rows.length,
      detectedMapping,
      supplierConfig,
      parsingCategory: invoice.parsing_category,
      parsingCategoryReason: invoice.parsing_category_reason,
    };

    // For Category B: include fullText for raw text display
    if (invoice.parsing_category === 'B' && fullText !== null) {
      response.fullText = fullText;
    }

    res.json(response);
  } catch (error) {
    console.error('GET /api/invoices/:id/preview error:', error);
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
      SELECT i.id, i.project_id, i.supplier_id, i.invoice_number, i.invoice_date,
             i.file_name, i.total_amount, i.status, i.created_at,
             i.parsing_category, i.parsing_category_reason,
             s.name as supplier_name, s.vat_rate, s.prices_include_vat,
             (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
      FROM invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.project_id = ?
      ORDER BY i.created_at DESC
    `).all(projectId);

    res.json({ invoices, total: invoices.length });
  } catch (error) {
    console.error('GET /api/projects/:id/invoices error:', error);
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
    console.error('GET /api/invoices/:id error:', error);
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
    console.error('DELETE /api/invoices/:id error:', error);
    res.status(500).json({ error: 'Ошибка при удалении счёта' });
  }
});

// POST /api/invoices/:id/ensure-supplier — auto-create supplier if missing
router.post('/api/invoices/:id/ensure-supplier', (req: Request, res: Response) => {
  try {
    const invoiceId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const invoice = db.prepare(
      'SELECT id, supplier_id, file_name FROM invoices WHERE id = ?'
    ).get(invoiceId) as { id: number; supplier_id: number | null; file_name: string } | undefined;

    if (!invoice) {
      return res.status(404).json({ error: 'Счёт не найден' });
    }

    // Already has supplier
    if (invoice.supplier_id) {
      const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(invoice.supplier_id) as { id: number; name: string };
      return res.json({ supplier_id: supplier.id, supplier_name: supplier.name });
    }

    // Extract name from filename
    const baseName = path.basename(invoice.file_name, path.extname(invoice.file_name));
    const firstWordMatch = baseName.match(/^[+\s]*([A-Za-zА-Яа-яёЁ]{3,})/);
    const supplierName = firstWordMatch ? firstWordMatch[1] : 'Неизвестный поставщик';

    // Find or create supplier
    const existing = db.prepare('SELECT id, name FROM suppliers WHERE name = ?').get(supplierName) as { id: number; name: string } | undefined;
    let supplierId: number;
    let finalName: string;

    if (existing) {
      supplierId = existing.id;
      finalName = existing.name;
    } else {
      const result = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(supplierName);
      supplierId = Number(result.lastInsertRowid);
      finalName = supplierName;
    }

    // Link supplier to invoice
    db.prepare('UPDATE invoices SET supplier_id = ? WHERE id = ?').run(supplierId, invoiceId);

    res.json({ supplier_id: supplierId, supplier_name: finalName });
  } catch (error) {
    console.error('POST /api/invoices/:id/ensure-supplier error:', error);
    res.status(500).json({ error: 'Ошибка при создании поставщика' });
  }
});

// POST /api/invoices/:id/reparse — re-parse invoice with mapping (from body or saved config)
router.post('/api/invoices/:id/reparse', async (req: Request, res: Response) => {
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

    // Priority: mapping from request body > saved supplier config
    let savedMapping: SavedMapping | undefined;
    if (req.body && req.body.mapping && typeof req.body.mapping.headerRow === 'number') {
      savedMapping = req.body.mapping as SavedMapping;
    } else if (invoice.supplier_id) {
      savedMapping = loadSavedMapping(invoice.supplier_id);
    }

    if (!savedMapping) {
      return res.status(400).json({ error: 'Нет настроек колонок — сохраните mapping или укажите в запросе' });
    }

    const ext = path.extname(invoice.file_name).toLowerCase();
    const parseResult = ext === '.pdf'
      ? await parsePdfFile(invoice.file_path, savedMapping)
      : parseExcelInvoice(invoice.file_path, savedMapping);

    // Replace items in transaction
    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, price, amount, row_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );

    db.transaction(() => {
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      for (const item of parseResult.items) {
        insertItem.run(invoiceId, item.article, item.name, item.unit, item.quantity, item.price, item.amount, item.row_index);
      }
      const newStatus = parseResult.items.length > 0 ? 'parsed' : 'needs_mapping';
      const newCategory = parseResult.items.length > 0 ? 'A' : 'B';
      const newCategoryReason = parseResult.items.length > 0
        ? `Пересобрано: ${parseResult.items.length} позиций`
        : 'Колонки не распознаны после пересборки';
      db.prepare('UPDATE invoices SET status = ?, total_amount = ?, parsing_category = ?, parsing_category_reason = ? WHERE id = ?')
        .run(newStatus, parseResult.totalAmount, newCategory, newCategoryReason, invoiceId);
    })();

    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY row_index').all(invoiceId);

    res.json({
      imported: parseResult.items.length,
      errors: parseResult.errors,
      items,
      status: parseResult.items.length > 0 ? 'parsed' : 'needs_mapping',
    });
  } catch (error) {
    console.error('POST /api/invoices/:id/reparse error:', error);
    res.status(500).json({ error: 'Ошибка при повторном парсинге', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
