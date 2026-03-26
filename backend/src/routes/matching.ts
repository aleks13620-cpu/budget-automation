import { Router, Request, Response } from 'express';
import stringSimilarity from 'string-similarity';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDatabase } from '../database';
import { runMatching, runMatchingIncremental, normalizeForMatching } from '../services/matcher';
import { isGigaChatConfigured, chatCompletion } from '../services/gigachatService';

const upload = multer({ storage: multer.memoryStorage() });

function saveFeedback(
  db: ReturnType<typeof getDatabase>,
  type: string,
  projectId: number | null,
  specItemId: number | null,
  invoiceItemId: number | null,
) {
  try {
    db.prepare(
      'INSERT INTO operator_feedback (type, project_id, spec_item_id, invoice_item_id) VALUES (?, ?, ?, ?)'
    ).run(type, projectId, specItemId, invoiceItemId);
  } catch { /* table may not exist yet — ignore */ }
}

const router = Router();

function effectivePrice(price: number | null, vatRate: number | null, pricesIncludeVat: number | null): number | null {
  if (price == null) return null;
  if (pricesIncludeVat === 0 && vatRate != null && vatRate > 0) {
    return Math.round(price * (1 + vatRate / 100) * 100) / 100;
  }
  return price;
}

// POST /api/projects/:id/matching/run — run matching algorithm
// Query param: ?mode=full (default) | incremental (preserves confirmed matches)
router.post('/api/projects/:id/matching/run', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const mode = String(req.query.mode || 'full');
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    let candidates;

    if (mode === 'incremental') {
      // Keep confirmed matches; delete unconfirmed only for spec items that have no confirmed match
      db.prepare(`
        DELETE FROM matched_items
        WHERE is_confirmed = 0
          AND specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
          AND specification_item_id NOT IN (
            SELECT DISTINCT specification_item_id FROM matched_items
            WHERE is_confirmed = 1
              AND specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
          )
      `).run(projectId, projectId);

      // Get spec IDs that are already confirmed — skip them
      const confirmedRows = db.prepare(`
        SELECT DISTINCT specification_item_id
        FROM matched_items
        WHERE is_confirmed = 1
          AND specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
      `).all(projectId) as { specification_item_id: number }[];
      const skipSpecIds = confirmedRows.map(r => r.specification_item_id);

      candidates = runMatchingIncremental(projectId, skipSpecIds);
    } else {
      // Full mode: clear all unconfirmed matches and re-run
      db.prepare(`
        DELETE FROM matched_items
        WHERE is_confirmed = 0
          AND specification_item_id IN (
            SELECT id FROM specification_items WHERE project_id = ?
          )
      `).run(projectId);

      candidates = runMatching(projectId);
    }

    // Insert new candidates
    const insert = db.prepare(`
      INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected, source)
      VALUES (?, ?, ?, ?, 0, 0, ?)
    `);

    const insertAll = db.transaction(() => {
      for (const c of candidates) {
        insert.run(c.specItemId, c.invoiceItemId, c.confidence, c.matchType, c.source ?? 'invoice');
      }
    });
    insertAll();

    // Auto-select best candidate per spec item (highest confidence, skip already confirmed)
    const specIds = [...new Set(candidates.map(c => c.specItemId))];
    const selectBest = db.prepare(`
      UPDATE matched_items SET is_selected = 1
      WHERE id = (
        SELECT id FROM matched_items
        WHERE specification_item_id = ? AND is_confirmed = 0
        ORDER BY confidence DESC
        LIMIT 1
      )
    `);
    for (const specId of specIds) {
      selectBest.run(specId);
    }

    // Count stats
    const totalSpec = (db.prepare(
      'SELECT COUNT(*) as cnt FROM specification_items WHERE project_id = ?'
    ).get(projectId) as { cnt: number }).cnt;

    // Total matched = new candidates + previously confirmed (if incremental)
    const totalMatchedRows = db.prepare(`
      SELECT COUNT(DISTINCT specification_item_id) as cnt
      FROM matched_items
      WHERE specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
    `).get(projectId) as { cnt: number };
    const matched = totalMatchedRows.cnt;
    const unmatched = totalSpec - matched;

    res.json({ total: totalSpec, matched, unmatched, mode });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при запуске сопоставления',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/matching — get matching results
router.get('/api/projects/:id/matching', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    // Get all spec items with their matches
    const specItems = db.prepare(`
      SELECT id, name, characteristics, equipment_code, unit, quantity, section,
             parent_item_id, full_name
      FROM specification_items
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId) as Array<{
      id: number; name: string; characteristics: string | null;
      equipment_code: string | null; unit: string | null;
      quantity: number | null; section: string | null;
      parent_item_id: number | null; full_name: string | null;
    }>;

    const getMatches = db.prepare(`
      SELECT m.id, m.invoice_item_id, m.confidence, m.match_type, m.is_confirmed, m.is_selected,
             COALESCE(m.source, 'invoice') as source, COALESCE(m.is_analog, 0) as is_analog,
             COALESCE(ii.name, pli.name) as invoice_name,
             COALESCE(ii.article, pli.article) as article,
             COALESCE(ii.unit, pli.unit) as invoice_unit,
             ii.quantity as invoice_quantity,
             COALESCE(ii.price, pli.price) as price,
             ii.amount,
             s.name as supplier_name, s.vat_rate, s.prices_include_vat
      FROM matched_items m
      LEFT JOIN invoice_items ii ON (COALESCE(m.source,'invoice') = 'invoice') AND m.invoice_item_id = ii.id
      LEFT JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN price_list_items pli ON (m.source = 'price_list') AND m.invoice_item_id = pli.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE m.specification_item_id = ?
      ORDER BY m.confidence DESC
    `);

    let matchedCount = 0;
    let confirmedCount = 0;

    const items = specItems.map(spec => {
      const matches = getMatches.all(spec.id) as Array<{
        id: number; invoice_item_id: number; confidence: number;
        match_type: string; is_confirmed: number; is_selected: number;
        source: string; is_analog: number;
        invoice_name: string; article: string | null;
        invoice_unit: string | null; invoice_quantity: number | null;
        price: number | null; amount: number | null;
        supplier_name: string | null;
        vat_rate: number | null; prices_include_vat: number | null;
      }>;

      if (matches.length > 0) matchedCount++;
      if (matches.some(m => m.is_confirmed)) confirmedCount++;

      return {
        specItem: {
          ...spec,
          parentItemId: spec.parent_item_id,
          fullName: spec.full_name,
        },
        matches: matches.map(m => ({
          id: m.id,
          invoiceItemId: m.invoice_item_id,
          invoiceName: m.invoice_name,
          article: m.article,
          supplierName: m.source === 'price_list' ? '[Прайс]' : m.supplier_name,
          unit: m.invoice_unit,
          quantity: m.invoice_quantity,
          price: m.price,
          effectivePrice: effectivePrice(m.price, m.vat_rate, m.prices_include_vat),
          amount: m.amount,
          confidence: m.confidence,
          matchType: m.match_type,
          isConfirmed: m.is_confirmed === 1,
          isSelected: m.is_selected === 1,
          isAnalog: m.is_analog === 1,
          source: m.source ?? 'invoice',
        })),
      };
    });

    // Tier breakdown: count by match_type for selected matches
    const tierRows = db.prepare(`
      SELECT match_type, COUNT(DISTINCT specification_item_id) as cnt
      FROM matched_items
      WHERE specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
        AND is_selected = 1
      GROUP BY match_type
    `).all(projectId) as { match_type: string; cnt: number }[];
    const tierBreakdown: Record<string, number> = {};
    for (const row of tierRows) tierBreakdown[row.match_type] = row.cnt;

    res.json({
      items,
      summary: {
        total: specItems.length,
        matched: matchedCount,
        confirmed: confirmedCount,
        unmatched: specItems.length - matchedCount,
        tierBreakdown,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при получении результатов сопоставления',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// PUT /api/matching/:id/confirm — confirm a match
router.put('/api/matching/:id/confirm', (req: Request, res: Response) => {
  try {
    const matchId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const match = db.prepare(`
      SELECT m.id, m.specification_item_id, m.invoice_item_id,
             si.name as spec_name, ii.name as invoice_name,
             i.supplier_id, si.project_id
      FROM matched_items m
      JOIN specification_items si ON m.specification_item_id = si.id
      JOIN invoice_items ii ON m.invoice_item_id = ii.id
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE m.id = ?
    `).get(matchId) as {
      id: number; specification_item_id: number; invoice_item_id: number;
      spec_name: string; invoice_name: string; supplier_id: number | null; project_id: number;
    } | undefined;

    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.transaction(() => {
      db.prepare(
        'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
      ).run(match.specification_item_id);

      db.prepare(
        'UPDATE matched_items SET is_confirmed = 1, is_selected = 1 WHERE id = ?'
      ).run(matchId);

      // Create or update matching rule (with supplier_id)
      const specPattern = normalizeForMatching(match.spec_name);
      const invoicePattern = normalizeForMatching(match.invoice_name);

      const existingRule = db.prepare(
        'SELECT id, times_used FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ? AND (supplier_id = ? OR (supplier_id IS NULL AND ? IS NULL))'
      ).get(specPattern, invoicePattern, match.supplier_id, match.supplier_id) as { id: number; times_used: number } | undefined;

      if (existingRule) {
        db.prepare(
          'UPDATE matching_rules SET times_used = times_used + 1, confidence = MIN(1.0, confidence + 0.02), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(existingRule.id);
      } else {
        db.prepare(
          'INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used, supplier_id) VALUES (?, ?, 0.9, 1, ?)'
        ).run(specPattern, invoicePattern, match.supplier_id);
      }
    })();

    saveFeedback(db, 'confirm', match.project_id, match.specification_item_id, match.invoice_item_id);
    res.json({ confirmed: true });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при подтверждении матча',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// PUT /api/matching/:id/unconfirm — roll back a confirmed match (keep record, just unconfirm)
router.put('/api/matching/:id/unconfirm', (req: Request, res: Response) => {
  try {
    const matchId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const match = db.prepare('SELECT id FROM matched_items WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: 'Матч не найден' });

    db.prepare('UPDATE matched_items SET is_confirmed = 0, is_selected = 0 WHERE id = ?').run(matchId);
    res.json({ unconfirmed: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при сбросе матча', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /api/matching/:id — reject/delete a match
router.delete('/api/matching/:id', (req: Request, res: Response) => {
  try {
    const matchId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    // Load match details before deleting (for negative rule creation)
    const match = db.prepare(`
      SELECT m.id, m.is_confirmed, m.specification_item_id, m.invoice_item_id,
             si.name as spec_name, ii.name as invoice_name, i.supplier_id, si.project_id
      FROM matched_items m
      JOIN specification_items si ON m.specification_item_id = si.id
      LEFT JOIN invoice_items ii ON m.invoice_item_id = ii.id
      LEFT JOIN invoices i ON ii.invoice_id = i.id
      WHERE m.id = ?
    `).get(matchId) as {
      id: number; is_confirmed: number;
      specification_item_id: number; invoice_item_id: number;
      spec_name: string; invoice_name: string | null; supplier_id: number | null; project_id: number;
    } | undefined;

    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM matched_items WHERE id = ?').run(matchId);

      // Create negative rule only for unconfirmed rejections (user rejects system suggestion)
      if (!match.is_confirmed && match.invoice_name) {
        const specPattern = normalizeForMatching(match.spec_name);
        const invoicePattern = normalizeForMatching(match.invoice_name);
        const existing = db.prepare(
          'SELECT id FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ? AND (supplier_id IS ? OR supplier_id = ?)'
        ).get(specPattern, invoicePattern, match.supplier_id, match.supplier_id) as { id: number } | undefined;

        if (existing) {
          db.prepare(
            "UPDATE matching_rules SET is_negative = 1, source = 'reject', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).run(existing.id);
        } else {
          db.prepare(
            "INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used, supplier_id, is_negative, source) VALUES (?, ?, 0, 1, ?, 1, 'reject')"
          ).run(specPattern, invoicePattern, match.supplier_id);
        }
      }
    })();

    saveFeedback(db, 'reject', match.project_id, match.specification_item_id, match.invoice_item_id);
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при удалении матча',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/matching/:id/confirm-analog — confirm as analog/similar item
router.post('/api/matching/:id/confirm-analog', (req: Request, res: Response) => {
  try {
    const matchId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const match = db.prepare(`
      SELECT m.id, m.specification_item_id, m.invoice_item_id,
             si.name as spec_name, ii.name as invoice_name,
             i.supplier_id
      FROM matched_items m
      JOIN specification_items si ON m.specification_item_id = si.id
      JOIN invoice_items ii ON m.invoice_item_id = ii.id
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE m.id = ?
    `).get(matchId) as {
      id: number; specification_item_id: number; invoice_item_id: number;
      spec_name: string; invoice_name: string; supplier_id: number | null;
    } | undefined;

    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.transaction(() => {
      db.prepare(
        'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
      ).run(match.specification_item_id);

      db.prepare(
        'UPDATE matched_items SET is_confirmed = 1, is_selected = 1, is_analog = 1 WHERE id = ?'
      ).run(matchId);

      // Create or update matching rule with lower confidence (analog = 0.75, with supplier_id)
      const specPattern = normalizeForMatching(match.spec_name);
      const invoicePattern = normalizeForMatching(match.invoice_name);

      const existingRule = db.prepare(
        'SELECT id, times_used FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ? AND (supplier_id = ? OR (supplier_id IS NULL AND ? IS NULL))'
      ).get(specPattern, invoicePattern, match.supplier_id, match.supplier_id) as { id: number; times_used: number } | undefined;

      if (existingRule) {
        db.prepare(
          'UPDATE matching_rules SET times_used = times_used + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(existingRule.id);
      } else {
        db.prepare(
          'INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used, supplier_id) VALUES (?, ?, 0.75, 1, ?)'
        ).run(specPattern, invoicePattern, match.supplier_id);
      }
    })();

    res.json({ confirmed: true, type: 'analog' });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при подтверждении аналога',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// PUT /api/matching/select/:id — manually select a match (best price override)
router.put('/api/matching/select/:id', (req: Request, res: Response) => {
  try {
    const matchId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const match = db.prepare(
      'SELECT id, specification_item_id FROM matched_items WHERE id = ?'
    ).get(matchId) as { id: number; specification_item_id: number } | undefined;

    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.transaction(() => {
      db.prepare(
        'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
      ).run(match.specification_item_id);

      db.prepare(
        'UPDATE matched_items SET is_selected = 1 WHERE id = ?'
      ).run(matchId);
    })();

    res.json({ selected: true });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при выборе матча',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/projects/:id/manual-match — manually match invoice item to spec item
router.post('/api/projects/:id/manual-match', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const specItemId = parseInt(String(req.body.specItemId), 10);
    const invoiceItemId = parseInt(String(req.body.invoiceItemId), 10);
    if (!specItemId || !invoiceItemId || isNaN(specItemId) || isNaN(invoiceItemId)) {
      return res.status(400).json({ error: 'specItemId и invoiceItemId обязательны' });
    }

    // Validate spec item belongs to project
    const specItem = db.prepare(
      'SELECT id, name FROM specification_items WHERE id = ? AND project_id = ?'
    ).get(specItemId, projectId) as { id: number; name: string } | undefined;

    if (!specItem) {
      return res.status(404).json({ error: 'Позиция спецификации не найдена' });
    }

    // Validate invoice item belongs to project
    const invoiceItem = db.prepare(`
      SELECT ii.id, ii.name, i.supplier_id
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE ii.id = ? AND i.project_id = ?
    `).get(invoiceItemId, projectId) as { id: number; name: string; supplier_id: number | null } | undefined;

    if (!invoiceItem) {
      return res.status(404).json({ error: 'Позиция счёта не найдена' });
    }

    // Check for existing match with this exact pair
    const existingMatch = db.prepare(
      'SELECT id FROM matched_items WHERE specification_item_id = ? AND invoice_item_id = ?'
    ).get(specItemId, invoiceItemId) as { id: number } | undefined;

    if (existingMatch) {
      // Activate existing match instead of creating duplicate
      db.transaction(() => {
        db.prepare(
          'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
        ).run(specItemId);
        db.prepare(
          'UPDATE matched_items SET is_confirmed = 1, is_selected = 1 WHERE id = ?'
        ).run(existingMatch.id);
      })();
      return res.json({ matchId: existingMatch.id, confirmed: true, reused: true });
    }

    // Check if invoice item is already confirmed with another spec item
    const otherMatch = db.prepare(
      'SELECT m.id, si.name as spec_name FROM matched_items m JOIN specification_items si ON m.specification_item_id = si.id WHERE m.invoice_item_id = ? AND m.is_confirmed = 1'
    ).get(invoiceItemId) as { id: number; spec_name: string } | undefined;

    const result = db.transaction(() => {
      // Deselect existing matches for this spec item
      db.prepare(
        'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
      ).run(specItemId);

      // Insert new confirmed match
      const insertResult = db.prepare(
        'INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected) VALUES (?, ?, 1.0, ?, 1, 1)'
      ).run(specItemId, invoiceItemId, 'manual');

      // Create matching rule with supplier_id (avoid duplicate rules)
      const specPattern = normalizeForMatching(specItem.name);
      const invoicePattern = normalizeForMatching(invoiceItem.name);

      const existingRule = db.prepare(
        'SELECT id FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ? AND (supplier_id = ? OR (supplier_id IS NULL AND ? IS NULL))'
      ).get(specPattern, invoicePattern, invoiceItem.supplier_id, invoiceItem.supplier_id) as { id: number } | undefined;

      if (existingRule) {
        db.prepare(
          'UPDATE matching_rules SET times_used = times_used + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(existingRule.id);
      } else {
        db.prepare(
          'INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used, supplier_id) VALUES (?, ?, 0.95, 1, ?)'
        ).run(specPattern, invoicePattern, invoiceItem.supplier_id);
      }

      return Number(insertResult.lastInsertRowid);
    })();

    saveFeedback(db, 'manual_select', projectId, specItemId, invoiceItemId);
    res.json({
      matchId: result,
      confirmed: true,
      warning: otherMatch ? `Эта позиция счёта уже привязана к: ${otherMatch.spec_name}` : undefined,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при ручном сопоставлении',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/spec-items/search?q=... — fuzzy search spec items
router.get('/api/projects/:id/spec-items/search', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const q = String(req.query.q || '').trim();
    const db = getDatabase();

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Минимум 2 символа для поиска' });
    }

    const specItems = db.prepare(
      'SELECT id, name, characteristics, unit, quantity, section FROM specification_items WHERE project_id = ? ORDER BY id'
    ).all(projectId) as Array<{
      id: number; name: string; characteristics: string | null;
      unit: string | null; quantity: number | null; section: string | null;
    }>;

    const normalizedQ = normalizeForMatching(q);

    const scored = specItems.map(item => {
      const normalizedName = normalizeForMatching(item.name);
      const score = stringSimilarity.compareTwoStrings(normalizedQ, normalizedName);
      return { ...item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 10).filter(s => s.score > 0.15);

    res.json({ results: top });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при поиске',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/unmatched-invoice-items — invoice items without matches
router.get('/api/projects/:id/unmatched-invoice-items', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const items = db.prepare(`
      SELECT ii.id, ii.name, ii.article, ii.unit, ii.quantity, ii.price, ii.amount,
             s.name as supplier_name
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      LEFT JOIN matched_items m ON m.invoice_item_id = ii.id
      WHERE i.project_id = ? AND m.id IS NULL
      ORDER BY ii.name
    `).all(projectId);

    res.json({ items, total: items.length });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при получении несопоставленных позиций',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/invoice-items/search?q=... — fuzzy search invoice items
// Note: intentionally returns ALL invoice items (including already matched ones),
// so users can assign the same supplier item to multiple spec positions.
router.get('/api/projects/:id/invoice-items/search', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const q = String(req.query.q || '').trim();
    const db = getDatabase();

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Минимум 2 символа для поиска' });
    }

    const mode = String(req.query.mode || 'similarity');
    const supplierId = req.query.supplier_id ? parseInt(String(req.query.supplier_id), 10) : null;

    let sql = `
      SELECT ii.id, ii.name, ii.article, ii.unit, ii.quantity, ii.price, ii.amount,
             s.name as supplier_name, i.supplier_id,
             i.id as invoice_id, i.file_name as invoice_file_name
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.project_id = ?
    `;
    const params: any[] = [projectId];

    if (supplierId) {
      sql += ' AND i.supplier_id = ?';
      params.push(supplierId);
    }

    sql += ' ORDER BY ii.id';

    const invoiceItems = db.prepare(sql).all(...params) as Array<{
      id: number; name: string; article: string | null;
      unit: string | null; quantity: number | null;
      price: number | null; amount: number | null;
      supplier_name: string | null; supplier_id: number | null;
      invoice_id: number; invoice_file_name: string | null;
    }>;

    let top: Array<any>;

    if (mode === 'like') {
      const lowerQ = q.toLowerCase();
      const filtered = invoiceItems.filter(item => {
        const lowerName = (item.name || '').toLowerCase();
        const lowerArticle = (item.article || '').toLowerCase();
        return lowerName.includes(lowerQ) || lowerArticle.includes(lowerQ);
      });
      top = filtered.slice(0, 30).map(item => ({ ...item, score: null }));
    } else {
      const normalizedQ = normalizeForMatching(q);
      const scored = invoiceItems.map(item => {
        const normalizedName = normalizeForMatching(item.name);
        const score = stringSimilarity.compareTwoStrings(normalizedQ, normalizedName);
        return { ...item, score };
      });
      scored.sort((a, b) => b.score - a.score);
      top = scored.slice(0, 30).filter(s => s.score > 0.1);
    }

    res.json({ results: top });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при поиске',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/summary — section totals and grand total
router.get('/api/projects/:id/summary', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: number; name: string } | undefined;
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    // Get all spec items with their selected match (including price list items)
    const rows = db.prepare(`
      SELECT si.id, si.name, si.unit, si.quantity, si.section,
             COALESCE(ii.price, pli.price) as price,
             COALESCE(ii.name, pli.name) as invoice_name,
             COALESCE(ii.article, pli.article) as article,
             s.name as supplier_name, s.vat_rate, s.prices_include_vat,
             m.id as match_id, m.is_confirmed, COALESCE(m.is_analog, 0) as is_analog
      FROM specification_items si
      LEFT JOIN matched_items m ON m.specification_item_id = si.id AND m.is_selected = 1
      LEFT JOIN invoice_items ii ON (COALESCE(m.source,'invoice') = 'invoice') AND m.invoice_item_id = ii.id
      LEFT JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN price_list_items pli ON (m.source = 'price_list') AND m.invoice_item_id = pli.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE si.project_id = ?
      ORDER BY si.section, si.id
    `).all(projectId) as Array<{
      id: number; name: string; unit: string | null; quantity: number | null;
      section: string | null; price: number | null; invoice_name: string | null;
      article: string | null; supplier_name: string | null;
      vat_rate: number | null; prices_include_vat: number | null;
      match_id: number | null; is_confirmed: number | null; is_analog: number;
    }>;

    // Group by section
    const sectionMap = new Map<string, {
      items: Array<{
        specId: number; name: string; unit: string | null; quantity: number | null;
        price: number | null; amount: number | null;
        invoiceName: string | null; article: string | null; supplierName: string | null;
        isConfirmed: boolean; hasMatch: boolean;
      }>;
      subtotal: number;
      originalSubtotal: number;
      analogSubtotal: number;
    }>();

    let grandTotal = 0;
    let originalGrandTotal = 0;
    let analogGrandTotal = 0;

    for (const row of rows) {
      const sectionName = row.section || 'Без раздела';
      if (!sectionMap.has(sectionName)) {
        sectionMap.set(sectionName, { items: [], subtotal: 0, originalSubtotal: 0, analogSubtotal: 0 });
      }
      const section = sectionMap.get(sectionName)!;

      const price = row.price;
      const effPrice = effectivePrice(price, row.vat_rate, row.prices_include_vat);
      const qty = row.quantity || 0;
      const amount = effPrice != null ? effPrice * qty : null;

      if (amount != null) {
        section.subtotal += amount;
        grandTotal += amount;
        if (row.is_analog === 1) {
          section.analogSubtotal += amount;
          analogGrandTotal += amount;
        } else {
          section.originalSubtotal += amount;
          originalGrandTotal += amount;
        }
      }

      section.items.push({
        specId: row.id,
        name: row.name,
        unit: row.unit,
        quantity: row.quantity,
        price: effPrice,
        amount,
        invoiceName: row.invoice_name,
        article: row.article,
        supplierName: row.supplier_name,
        isConfirmed: row.is_confirmed === 1,
        hasMatch: row.match_id != null,
      });
    }

    const sections = Array.from(sectionMap.entries()).map(([name, data]) => ({
      name,
      itemCount: data.items.length,
      matchedCount: data.items.filter(i => i.hasMatch).length,
      subtotal: Math.round(data.subtotal * 100) / 100,
      originalSubtotal: Math.round(data.originalSubtotal * 100) / 100,
      analogSubtotal: Math.round(data.analogSubtotal * 100) / 100,
      items: data.items,
    }));

    res.json({
      projectName: project.name,
      sections,
      grandTotal: Math.round(grandTotal * 100) / 100,
      originalGrandTotal: Math.round(originalGrandTotal * 100) / 100,
      analogGrandTotal: Math.round(analogGrandTotal * 100) / 100,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при расчёте итогов',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/projects/:id/matching/validate-gigachat — Tier5: validate low-confidence pairs via GigaChat
router.post('/api/projects/:id/matching/validate-gigachat', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    if (!isGigaChatConfigured()) {
      return res.status(503).json({ error: 'GigaChat не настроен (нет GIGACHAT_AUTH_KEY)' });
    }

    // Get unconfirmed low-confidence candidates (0.25–0.4) not yet in cache
    const candidates = db.prepare(`
      SELECT m.id, m.specification_item_id, m.invoice_item_id, m.confidence,
             si.name as spec_name, COALESCE(ii.name, pli.name) as invoice_name
      FROM matched_items m
      JOIN specification_items si ON m.specification_item_id = si.id
      LEFT JOIN invoice_items ii ON (COALESCE(m.source,'invoice') = 'invoice') AND m.invoice_item_id = ii.id
      LEFT JOIN price_list_items pli ON (m.source = 'price_list') AND m.invoice_item_id = pli.id
      WHERE si.project_id = ?
        AND m.is_confirmed = 0
        AND m.confidence >= 0.25
        AND m.confidence < 0.4
      ORDER BY m.confidence DESC
      LIMIT 10
    `).all(projectId) as Array<{
      id: number; specification_item_id: number; invoice_item_id: number;
      confidence: number; spec_name: string; invoice_name: string | null;
    }>;

    if (candidates.length === 0) {
      return res.json({ validated: 0, boosted: 0, removed: 0, message: 'Нет кандидатов для проверки' });
    }

    const checkCache = db.prepare('SELECT is_match FROM gigachat_match_cache WHERE spec_text = ? AND invoice_text = ?');
    const insertCache = db.prepare('INSERT OR IGNORE INTO gigachat_match_cache (spec_text, invoice_text, is_match) VALUES (?, ?, ?)');

    let boosted = 0;
    let removed = 0;
    let validated = 0;
    const BATCH = 5;

    for (let i = 0; i < Math.min(candidates.length, BATCH); i++) {
      const c = candidates[i];
      if (!c.invoice_name) { continue; }

      const specText = normalizeForMatching(c.spec_name);
      const invText = normalizeForMatching(c.invoice_name);

      // Check cache first
      const cached = checkCache.get(specText, invText) as { is_match: number } | undefined;
      let isMatch: boolean;

      if (cached !== undefined) {
        isMatch = cached.is_match === 1;
      } else {
        // Ask GigaChat
        try {
          const prompt = `Это одна и та же позиция? Ответь только "да" или "нет".\nСпецификация: "${c.spec_name}"\nСчёт: "${c.invoice_name}"`;
          const result = await chatCompletion([{ role: 'user', content: prompt }], { maxTokens: 10, temperature: 0 });
          const answer = result.toLowerCase().trim();
          isMatch = answer.startsWith('да') || answer.includes('yes');
          insertCache.run(specText, invText, isMatch ? 1 : 0);
        } catch {
          continue; // skip on error
        }
      }

      validated++;
      if (isMatch) {
        db.prepare('UPDATE matched_items SET confidence = 0.7 WHERE id = ?').run(c.id);
        boosted++;
      } else {
        db.prepare('DELETE FROM matched_items WHERE id = ?').run(c.id);
        removed++;
      }
    }

    res.json({ validated, boosted, removed, total: candidates.length });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при GigaChat валидации',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/projects/:id/feedback — operator feedback signals
router.get('/api/projects/:id/feedback', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const items = db.prepare(`
      SELECT f.id, f.type, f.created_at, f.comment,
             si.name as spec_name, f.invoice_item_id,
             COALESCE(ii.name, '') as invoice_name
      FROM operator_feedback f
      LEFT JOIN specification_items si ON f.spec_item_id = si.id
      LEFT JOIN invoice_items ii ON f.invoice_item_id = ii.id
      WHERE f.project_id = ?
      ORDER BY f.created_at DESC
      LIMIT 200
    `).all(projectId);

    const counts = db.prepare(`
      SELECT type, COUNT(*) as cnt FROM operator_feedback WHERE project_id = ? GROUP BY type
    `).all(projectId) as { type: string; cnt: number }[];

    res.json({ items, counts: Object.fromEntries(counts.map(r => [r.type, r.cnt])) });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении feedback', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/projects/:id/matching/stats — lightweight coverage stats (no items)
router.get('/api/projects/:id/matching/stats', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const total = (db.prepare('SELECT COUNT(*) as cnt FROM specification_items WHERE project_id = ?').get(projectId) as { cnt: number }).cnt;
    const matched = (db.prepare(`
      SELECT COUNT(DISTINCT specification_item_id) as cnt FROM matched_items
      WHERE specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
    `).get(projectId) as { cnt: number }).cnt;
    const confirmed = (db.prepare(`
      SELECT COUNT(DISTINCT specification_item_id) as cnt FROM matched_items
      WHERE is_confirmed = 1
        AND specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
    `).get(projectId) as { cnt: number }).cnt;

    res.json({ total, matched, confirmed, unmatched: total - matched });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении статистики', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/projects/:id/import-matches — bulk import matching rules from Excel
// Excel columns (detected by keywords): spec_name, invoice_name, supplier (optional)
router.post('/api/projects/:id/import-matches', upload.single('file'), (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as string[][];

    if (rows.length < 2) return res.status(400).json({ error: 'Файл пустой или содержит только заголовок' });

    // Detect columns by keywords
    const header = rows[0].map(h => String(h).toLowerCase().trim());
    const specCol = header.findIndex(h => h.includes('спецификац') || h.includes('spec') || h === 'наименование спец');
    const invCol = header.findIndex(h => h.includes('счёт') || h.includes('счет') || h.includes('invoice') || h.includes('наименование счет'));
    const supplierCol = header.findIndex(h => h.includes('поставщик') || h.includes('supplier'));

    if (specCol === -1 || invCol === -1) {
      return res.status(400).json({
        error: 'Не найдены колонки. Нужны: «Наименование спецификации» и «Наименование в счёте»',
        detectedHeaders: rows[0],
      });
    }

    // Load suppliers for fuzzy matching
    const allSuppliers = db.prepare('SELECT id, name FROM suppliers').all() as { id: number; name: string }[];

    const upsert = db.prepare(`
      INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used, supplier_id, is_negative, source)
      VALUES (?, ?, 0.95, 1, ?, 0, 'import')
      ON CONFLICT DO NOTHING
    `);
    const updateExisting = db.prepare(
      "UPDATE matching_rules SET confidence = 0.95, is_negative = 0, source = 'import', updated_at = CURRENT_TIMESTAMP WHERE specification_pattern = ? AND invoice_pattern = ? AND (supplier_id IS ? OR supplier_id = ?)"
    );
    const findExisting = db.prepare(
      'SELECT id FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ? AND (supplier_id IS ? OR supplier_id = ?)'
    );

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    const importAll = db.transaction(() => {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const specName = String(row[specCol] ?? '').trim();
        const invName = String(row[invCol] ?? '').trim();
        if (!specName || !invName) { skipped++; continue; }

        const specPattern = normalizeForMatching(specName);
        const invPattern = normalizeForMatching(invName);
        if (!specPattern || !invPattern) { skipped++; continue; }

        let supplierId: number | null = null;
        if (supplierCol !== -1) {
          const supplierName = String(row[supplierCol] ?? '').trim();
          if (supplierName && allSuppliers.length > 0) {
            const match = stringSimilarity.findBestMatch(supplierName, allSuppliers.map(s => s.name));
            if (match.bestMatch.rating >= 0.75) {
              supplierId = allSuppliers[match.bestMatchIndex].id;
            }
          }
        }

        const existing = findExisting.get(specPattern, invPattern, supplierId, supplierId);
        if (existing) {
          updateExisting.run(specPattern, invPattern, supplierId, supplierId);
        } else {
          upsert.run(specPattern, invPattern, supplierId);
        }
        imported++;
      }
    });
    importAll();

    res.json({ imported, skipped, errors, total: rows.length - 1 });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при импорте эталонных матчей',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/projects/:id/feedback — submit error report with comment
router.post('/api/projects/:id/feedback', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const { spec_item_id, invoice_item_id, comment } = req.body;
    if (!comment || !comment.trim()) {
      res.status(400).json({ error: 'Комментарий обязателен' });
      return;
    }
    const db = getDatabase();
    db.prepare(`
      INSERT INTO operator_feedback (type, project_id, spec_item_id, invoice_item_id, comment)
      VALUES ('error_report', ?, ?, ?, ?)
    `).run(projectId, spec_item_id || null, invoice_item_id || null, comment.trim());
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при сохранении отзыва', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /api/feedback/:id/resolve — mark error_report as resolved
router.patch('/api/feedback/:id/resolve', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const db = getDatabase();
    db.prepare(`UPDATE operator_feedback SET status = 'resolved' WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/feedback/all — all error_reports across all projects
router.get('/api/feedback/all', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const status = req.query.status as string | undefined;
    const whereParts = [`f.type = 'error_report'`];
    if (status === 'new') whereParts.push(`COALESCE(f.status, 'new') = 'new'`);
    if (status === 'resolved') whereParts.push(`f.status = 'resolved'`);
    const items = db.prepare(`
      SELECT f.id, f.type, f.comment, f.created_at, COALESCE(f.status, 'new') as status,
             p.id as project_id, p.name as project_name,
             si.name as spec_name
      FROM operator_feedback f
      LEFT JOIN projects p ON f.project_id = p.id
      LEFT JOIN specification_items si ON f.spec_item_id = si.id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY f.created_at DESC
      LIMIT 500
    `).all();
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM operator_feedback WHERE type = 'error_report'`).get() as any).cnt;
    const newCount = (db.prepare(`SELECT COUNT(*) as cnt FROM operator_feedback WHERE type = 'error_report' AND COALESCE(status,'new') = 'new'`).get() as any).cnt;
    res.json({ items, total, newCount });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/feedback/export — download all error_reports as xlsx
router.get('/api/feedback/export', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT p.name as project, f.created_at as date, f.comment,
             COALESCE(f.status,'new') as status, si.name as spec_name
      FROM operator_feedback f
      LEFT JOIN projects p ON f.project_id = p.id
      LEFT JOIN specification_items si ON f.spec_item_id = si.id
      WHERE f.type = 'error_report'
      ORDER BY f.created_at DESC
    `).all() as any[];

    const wsData = [
      ['Проект', 'Дата', 'Замечание', 'Позиция спецификации', 'Статус'],
      ...rows.map(r => [
        r.project || '',
        r.date ? new Date(r.date).toLocaleString('ru-RU') : '',
        r.comment || '',
        r.spec_name || '',
        r.status === 'resolved' ? 'Разобрано' : 'Новое',
      ]),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 25 }, { wch: 18 }, { wch: 60 }, { wch: 40 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Замечания');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="feedback_errors.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка экспорта', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
