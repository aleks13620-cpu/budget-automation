import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { parseExcelFile, parseFromRawData, detectMappingFromRawData } from '../services/excelParser';
import type { ColumnMapping } from '../services/excelParser';
import { detectSectionFromFilename, detectSectionFromItems } from '../services/sectionDetector';
import { enrichSpecItems } from '../services/gigachatSpecParser';
import type { SpecItemInput } from '../services/gigachatSpecParser';

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

    // Read raw data for storage
    const XLSX2 = require('xlsx');
    const wb2 = XLSX2.readFile(req.file.path);
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const rawData2 = XLSX2.utils.sheet_to_json(ws2, { header: 1, defval: '' }) as string[][];
    const rawDataStr = JSON.stringify(rawData2);

    // Insert specification + items in a transaction
    const result = db.transaction(() => {
      const specResult = db.prepare(
        'INSERT INTO specifications (project_id, section, file_name, raw_data) VALUES (?, ?, ?, ?)'
      ).run(projectId, section, fileName, rawDataStr);
      const specificationId = Number(specResult.lastInsertRowid);

      const insertStmt = db.prepare(`
        INSERT INTO specification_items
          (project_id, specification_id, position_number, name, characteristics, equipment_code, article, product_code, marking, type_size, manufacturer, unit, quantity, section, parent_item_id, full_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const inserted: any[] = [];
      const insertedIds: number[] = [];  // track DB ids for parent resolution
      for (const item of parseResult.items) {
        const parentDbId = item._parentIndex !== null ? (insertedIds[item._parentIndex] ?? null) : null;
        const itemResult = insertStmt.run(
          projectId,
          specificationId,
          item.position_number,
          item.name,
          item.characteristics,
          item.equipment_code,
          item.article,
          item.product_code,
          item.marking,
          item.type_size,
          item.manufacturer,
          item.unit,
          item.quantity,
          section,
          parentDbId,
          item.full_name ?? null,
        );
        const newId = Number(itemResult.lastInsertRowid);
        insertedIds.push(newId);
        inserted.push({
          id: newId,
          project_id: projectId,
          specification_id: specificationId,
          ...item,
          section,
          parent_item_id: parentDbId,
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
// GET /api/specifications/:id/items — get all items for a specification
router.get('/api/specifications/:id/items', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const spec = db.prepare('SELECT id, section, file_name FROM specifications WHERE id = ?').get(specId) as { id: number; section: string; file_name: string | null } | undefined;
    if (!spec) {
      return res.status(404).json({ error: 'Спецификация не найдена' });
    }

    const items = db.prepare(
      'SELECT id, position_number, name, characteristics, equipment_code, manufacturer, unit, quantity FROM specification_items WHERE specification_id = ? ORDER BY id'
    ).all(specId);

    res.json({ specification: spec, items, total: items.length });
  } catch (error) {
    console.error('GET /api/specifications/:id/items error:', error);
    res.status(500).json({ error: 'Ошибка при загрузке позиций спецификации' });
  }
});

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

// POST /api/projects/:id/specifications/bulk — upload multiple spec files with auto-detect section
router.post('/api/projects/:id/specifications/bulk', upload.array('files', 50), (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Файлы не загружены' });
    }

    const results: {
      fileName: string;
      section: string | null;
      imported: number;
      status: 'ok' | 'conflict' | 'no_section' | 'parse_error';
      error?: string;
    }[] = [];

    for (const file of files) {
      const fileName = fixFilename(file.originalname);

      try {
        // Parse file
        const parseResult = parseExcelFile(file.path);
        if (parseResult.items.length === 0) {
          fs.unlink(file.path, () => {});
          results.push({ fileName, section: null, imported: 0, status: 'parse_error', error: 'Не удалось извлечь данные' });
          continue;
        }

        // Detect section: filename first, then items
        let section = detectSectionFromFilename(fileName);
        if (!section) {
          section = detectSectionFromItems(parseResult.items.map(it => ({
            name: it.name,
            characteristics: it.characteristics,
          })));
        }

        if (!section || !SECTIONS.includes(section)) {
          fs.unlink(file.path, () => {});
          results.push({ fileName, section, imported: 0, status: 'no_section', error: `Не удалось определить раздел${section ? ` (определён: ${section})` : ''}` });
          continue;
        }

        // Check if section already exists
        const existing = db.prepare(
          'SELECT id FROM specifications WHERE project_id = ? AND section = ?'
        ).get(projectId, section) as { id: number } | undefined;

        if (existing) {
          fs.unlink(file.path, () => {});
          results.push({ fileName, section, imported: 0, status: 'conflict', error: `Раздел «${section}» уже загружен` });
          continue;
        }

        // Read raw data for storage
        const XLSXb = require('xlsx');
        const wbb = XLSXb.readFile(file.path);
        const wsb = wbb.Sheets[wbb.SheetNames[0]];
        const rawDataB = JSON.stringify(XLSXb.utils.sheet_to_json(wsb, { header: 1, defval: '' }));

        // Insert specification + items
        const result = db.transaction(() => {
          const specResult = db.prepare(
            'INSERT INTO specifications (project_id, section, file_name, raw_data) VALUES (?, ?, ?, ?)'
          ).run(projectId, section, fileName, rawDataB);
          const specificationId = Number(specResult.lastInsertRowid);

          const insertStmt = db.prepare(`
            INSERT INTO specification_items
              (project_id, specification_id, position_number, name, characteristics, equipment_code, article, product_code, marking, type_size, manufacturer, unit, quantity, section, parent_item_id, full_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const insertedIds: number[] = [];
          let count = 0;
          for (const item of parseResult.items) {
            const parentDbId = item._parentIndex !== null ? (insertedIds[item._parentIndex] ?? null) : null;
            const r = insertStmt.run(
              projectId, specificationId, item.position_number, item.name,
              item.characteristics, item.equipment_code,
              item.article, item.product_code, item.marking, item.type_size,
              item.manufacturer, item.unit, item.quantity, section,
              parentDbId, item.full_name ?? null,
            );
            insertedIds.push(Number(r.lastInsertRowid));
            count++;
          }
          return count;
        })();

        fs.unlink(file.path, () => {});
        results.push({ fileName, section, imported: result, status: 'ok' });
      } catch (err) {
        fs.unlink(file.path, () => {});
        results.push({
          fileName,
          section: null,
          imported: 0,
          status: 'parse_error',
          error: err instanceof Error ? err.message : 'Неизвестная ошибка',
        });
      }
    }

    const totalImported = results.filter(r => r.status === 'ok').reduce((s, r) => s + r.imported, 0);
    const okCount = results.filter(r => r.status === 'ok').length;

    res.json({
      results,
      summary: { total: files.length, ok: okCount, totalImported },
    });
  } catch (error) {
    console.error('POST /api/projects/:id/specifications/bulk error:', error);
    res.status(500).json({
      error: 'Ошибка при массовом импорте спецификаций',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/specifications/:id/raw-data
router.get('/api/specifications/:id/raw-data', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE id = ?').get(specId) as { id: number; raw_data: string | null } | undefined;
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });
    if (!spec.raw_data) return res.status(404).json({ error: 'Сырые данные не сохранены для этой спецификации' });

    const rows = JSON.parse(spec.raw_data) as string[][];
    const config = db.prepare('SELECT * FROM specification_parser_configs WHERE specification_id = ?').get(specId) as any | null;

    // Если сохранённого конфига нет — авто-определяем заголовок и маппинг
    const detectedMapping = !config ? detectMappingFromRawData(rows) : null;

    res.json({ rows, config: config || null, detectedMapping });
  } catch (error) {
    console.error('GET /api/specifications/:id/raw-data error:', error);
    res.status(500).json({ error: 'Ошибка при получении сырых данных' });
  }
});

// POST /api/specifications/:id/reparse
router.post('/api/specifications/:id/reparse', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const spec = db.prepare('SELECT id, project_id, section, raw_data FROM specifications WHERE id = ?').get(specId) as { id: number; project_id: number; section: string; raw_data: string | null } | undefined;
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });
    if (!spec.raw_data) return res.status(400).json({ error: 'Сырые данные не сохранены' });

    const { headerRow, columnMapping, mergeMultiline } = req.body as { headerRow: number; columnMapping: ColumnMapping; mergeMultiline: boolean };

    // Защита: нельзя пересобирать без колонки "Наименование"
    if (columnMapping.name === null || columnMapping.name === undefined) {
      return res.status(400).json({ error: 'Не выбрана колонка "Наименование". Настройте маппинг перед пересборкой.' });
    }

    const rawRows = JSON.parse(spec.raw_data) as string[][];
    const parseResult = parseFromRawData(rawRows, headerRow, columnMapping, mergeMultiline !== false);

    const insertStmt = db.prepare(`
      INSERT INTO specification_items
        (project_id, specification_id, position_number, name, characteristics, equipment_code, article, product_code, marking, type_size, manufacturer, unit, quantity, section, parent_item_id, full_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = db.transaction(() => {
      db.prepare('DELETE FROM specification_items WHERE specification_id = ?').run(specId);
      const insertedIds: number[] = [];
      for (const item of parseResult.items) {
        const parentDbId = item._parentIndex !== null ? (insertedIds[item._parentIndex] ?? null) : null;
        const r = insertStmt.run(
          spec.project_id, specId, item.position_number, item.name, item.characteristics, item.equipment_code,
          item.article, item.product_code, item.marking, item.type_size,
          item.manufacturer, item.unit, item.quantity, spec.section, parentDbId, item.full_name ?? null
        );
        insertedIds.push(Number(r.lastInsertRowid));
      }
      // UPSERT parser config
      db.prepare(`
        INSERT INTO specification_parser_configs (specification_id, header_row, column_mapping, merge_multiline, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(specification_id) DO UPDATE SET
          header_row = excluded.header_row,
          column_mapping = excluded.column_mapping,
          merge_multiline = excluded.merge_multiline,
          updated_at = CURRENT_TIMESTAMP
      `).run(specId, headerRow, JSON.stringify(columnMapping), mergeMultiline ? 1 : 0);
      return parseResult.items.length;
    })();

    res.json({ imported: result, errors: parseResult.errors, totalRows: parseResult.totalRows, skippedRows: parseResult.skippedRows });
  } catch (error) {
    console.error('POST /api/specifications/:id/reparse error:', error);
    res.status(500).json({ error: 'Ошибка при перепарсинге', details: error instanceof Error ? error.message : 'Unknown' });
  }
});

// POST /api/specifications/:id/parser-config
router.post('/api/specifications/:id/parser-config', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const spec = db.prepare('SELECT id FROM specifications WHERE id = ?').get(specId);
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });
    const { headerRow, columnMapping, mergeMultiline } = req.body;
    db.prepare(`
      INSERT INTO specification_parser_configs (specification_id, header_row, column_mapping, merge_multiline, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(specification_id) DO UPDATE SET
        header_row = excluded.header_row,
        column_mapping = excluded.column_mapping,
        merge_multiline = excluded.merge_multiline,
        updated_at = CURRENT_TIMESTAMP
    `).run(specId, headerRow, JSON.stringify(columnMapping), mergeMultiline ? 1 : 0);
    res.json({ saved: true });
  } catch (error) {
    console.error('POST /api/specifications/:id/parser-config error:', error);
    res.status(500).json({ error: 'Ошибка при сохранении конфига' });
  }
});

// ---------------------------------------------------------------------------
// Helper: save snapshot of specification_items before modification
// ---------------------------------------------------------------------------

function saveSpecSnapshot(specId: number, action: string, db: ReturnType<typeof getDatabase>): void {
  const items = db.prepare('SELECT * FROM specification_items WHERE specification_id = ?').all(specId);
  const maxVerRow = db.prepare(
    'SELECT MAX(version) as v FROM specification_items_history WHERE specification_id = ?'
  ).get(specId) as { v: number | null } | undefined;
  const nextVersion = (maxVerRow?.v ?? 0) + 1;
  db.prepare(
    'INSERT INTO specification_items_history (specification_id, version, items_snapshot, action) VALUES (?, ?, ?, ?)'
  ).run(specId, nextVersion, JSON.stringify(items), action);
}

// POST /api/specifications/:id/gigachat-enrich
router.post('/api/specifications/:id/gigachat-enrich', async (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const spec = db.prepare('SELECT id, project_id, section FROM specifications WHERE id = ?').get(specId) as { id: number; project_id: number; section: string } | undefined;
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });

    const { dryRun = false, fieldsToUpdate, saveRules = false } = req.body as { dryRun?: boolean; fieldsToUpdate?: string[]; saveRules?: boolean };

    const dbItems = db.prepare(
      'SELECT id, position_number, name, characteristics, unit, quantity, manufacturer, article, type_size FROM specification_items WHERE specification_id = ? ORDER BY id'
    ).all(specId) as Array<{
      id: number; position_number: string | null; name: string;
      characteristics: string | null; unit: string | null; quantity: number | null;
      manufacturer: string | null; article: string | null; type_size: string | null;
    }>;

    if (dbItems.length === 0) return res.status(400).json({ error: 'Нет позиций для обогащения' });

    const inputs: Array<SpecItemInput & { id: number; position_number: string | null }> = dbItems.map((it, i) => ({
      idx: i,
      id: it.id,
      position_number: it.position_number,
      name: it.name,
      characteristics: it.characteristics,
      unit: it.unit,
      quantity: it.quantity,
      manufacturer: it.manufacturer,
      article: it.article,
      type_size: it.type_size,
    }));

    const result = await enrichSpecItems(inputs, fieldsToUpdate as any);

    if (dryRun) {
      return res.json({
        dryRun: true,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
        diffs: result.diffs,
      });
    }

    // Apply changes to DB
    saveSpecSnapshot(specId, 'gigachat_enrich', db);

    const updateStmt = db.prepare(`
      UPDATE specification_items
      SET characteristics = COALESCE(?, characteristics),
          manufacturer = COALESCE(?, manufacturer),
          article = COALESCE(?, article),
          type_size = COALESCE(?, type_size)
      WHERE id = ?
    `);

    const ruleStmt = saveRules ? db.prepare(`
      INSERT INTO spec_parse_rules (specification_id, field, raw_value, corrected_value, times_used)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(specification_id, field, raw_value) DO UPDATE SET
        corrected_value = excluded.corrected_value,
        times_used = times_used + 1
    `) : null;

    db.transaction(() => {
      for (const diff of result.diffs) {
        if (!diff.changed) continue;
        const item = inputs[diff.idx];
        updateStmt.run(
          diff.after.characteristics ?? null,
          diff.after.manufacturer ?? null,
          diff.after.article ?? null,
          diff.after.type_size ?? null,
          item.id,
        );
        // Сохранить правила для обучения — только если пользователь подтвердил
        if (ruleStmt) {
          for (const field of Object.keys(diff.after)) {
            const rawVal = (diff.before as any)[field];
            const corrVal = (diff.after as any)[field];
            if (rawVal !== undefined && corrVal !== undefined && rawVal !== corrVal) {
              try {
                ruleStmt.run(specId, field, String(rawVal ?? ''), String(corrVal ?? ''));
              } catch { /* conflict handled by ON CONFLICT */ }
            }
          }
        }
      }
    })();

    res.json({
      dryRun: false,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors,
      diffs: result.diffs,
    });
  } catch (error) {
    console.error('POST /api/specifications/:id/gigachat-enrich error:', error);
    res.status(500).json({ error: 'Ошибка обогащения через GigaChat', details: error instanceof Error ? error.message : 'Unknown' });
  }
});

// GET /api/specifications/:id/history
router.get('/api/specifications/:id/history', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const spec = db.prepare('SELECT id FROM specifications WHERE id = ?').get(specId);
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });

    const history = db.prepare(
      `SELECT id, version, action, created_at,
        (SELECT COUNT(*) FROM json_each(items_snapshot)) as items_count
       FROM specification_items_history
       WHERE specification_id = ?
       ORDER BY version DESC`
    ).all(specId) as Array<{ id: number; version: number; action: string; created_at: string; items_count: number }>;

    res.json({ history });
  } catch (error) {
    console.error('GET /api/specifications/:id/history error:', error);
    res.status(500).json({ error: 'Ошибка при получении истории' });
  }
});

// POST /api/specifications/:id/rollback
router.post('/api/specifications/:id/rollback', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    const spec = db.prepare('SELECT id, project_id, section FROM specifications WHERE id = ?').get(specId) as { id: number; project_id: number; section: string } | undefined;
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });

    const { version } = req.body as { version: number };
    const historyEntry = db.prepare(
      'SELECT items_snapshot FROM specification_items_history WHERE specification_id = ? AND version = ?'
    ).get(specId, version) as { items_snapshot: string } | undefined;
    if (!historyEntry) return res.status(404).json({ error: `Версия ${version} не найдена` });

    const snapshot = JSON.parse(historyEntry.items_snapshot) as any[];

    // Save current state before rollback
    saveSpecSnapshot(specId, `rollback_to_v${version}`, db);

    db.transaction(() => {
      db.prepare('DELETE FROM specification_items WHERE specification_id = ?').run(specId);
      const insertStmt = db.prepare(`
        INSERT INTO specification_items
          (id, project_id, specification_id, position_number, name, characteristics, equipment_code,
           article, product_code, marking, type_size, manufacturer, unit, quantity, section,
           parent_item_id, full_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of snapshot) {
        insertStmt.run(
          item.id, item.project_id, item.specification_id, item.position_number, item.name,
          item.characteristics, item.equipment_code, item.article, item.product_code,
          item.marking, item.type_size, item.manufacturer, item.unit, item.quantity,
          item.section, item.parent_item_id, item.full_name,
        );
      }
    })();

    res.json({ restored: snapshot.length, version });
  } catch (error) {
    console.error('POST /api/specifications/:id/rollback error:', error);
    res.status(500).json({ error: 'Ошибка при откате', details: error instanceof Error ? error.message : 'Unknown' });
  }
});

export default router;
