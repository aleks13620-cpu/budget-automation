import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import { runMatching, normalizeForMatching } from '../services/matcher';

const router = Router();

// POST /api/projects/:id/matching/run — run matching algorithm
router.post('/api/projects/:id/matching/run', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    // Clear previous unconfirmed matches for this project's spec items
    db.prepare(`
      DELETE FROM matched_items
      WHERE is_confirmed = 0
        AND specification_item_id IN (
          SELECT id FROM specification_items WHERE project_id = ?
        )
    `).run(projectId);

    // Run matching
    const candidates = runMatching(projectId);

    // Insert results into matched_items
    const insert = db.prepare(`
      INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected)
      VALUES (?, ?, ?, ?, 0, 0)
    `);

    const insertAll = db.transaction(() => {
      for (const c of candidates) {
        insert.run(c.specItemId, c.invoiceItemId, c.confidence, c.matchType);
      }
    });
    insertAll();

    // Auto-select best candidate per spec item (highest confidence)
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

    const matched = specIds.length;
    const unmatched = totalSpec - matched;

    res.json({ total: totalSpec, matched, unmatched });
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
      SELECT id, name, characteristics, equipment_code, unit, quantity, section
      FROM specification_items
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId) as Array<{
      id: number; name: string; characteristics: string | null;
      equipment_code: string | null; unit: string | null;
      quantity: number | null; section: string | null;
    }>;

    const getMatches = db.prepare(`
      SELECT m.id, m.invoice_item_id, m.confidence, m.match_type, m.is_confirmed, m.is_selected,
             ii.name as invoice_name, ii.article, ii.unit as invoice_unit,
             ii.quantity as invoice_quantity, ii.price, ii.amount,
             s.name as supplier_name
      FROM matched_items m
      JOIN invoice_items ii ON m.invoice_item_id = ii.id
      JOIN invoices i ON ii.invoice_id = i.id
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
        invoice_name: string; article: string | null;
        invoice_unit: string | null; invoice_quantity: number | null;
        price: number | null; amount: number | null;
        supplier_name: string | null;
      }>;

      if (matches.length > 0) matchedCount++;
      if (matches.some(m => m.is_confirmed)) confirmedCount++;

      return {
        specItem: spec,
        matches: matches.map(m => ({
          id: m.id,
          invoiceItemId: m.invoice_item_id,
          invoiceName: m.invoice_name,
          article: m.article,
          supplierName: m.supplier_name,
          unit: m.invoice_unit,
          quantity: m.invoice_quantity,
          price: m.price,
          amount: m.amount,
          confidence: m.confidence,
          matchType: m.match_type,
          isConfirmed: m.is_confirmed === 1,
          isSelected: m.is_selected === 1,
        })),
      };
    });

    res.json({
      items,
      summary: {
        total: specItems.length,
        matched: matchedCount,
        confirmed: confirmedCount,
        unmatched: specItems.length - matchedCount,
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
             si.name as spec_name, ii.name as invoice_name
      FROM matched_items m
      JOIN specification_items si ON m.specification_item_id = si.id
      JOIN invoice_items ii ON m.invoice_item_id = ii.id
      WHERE m.id = ?
    `).get(matchId) as {
      id: number; specification_item_id: number; invoice_item_id: number;
      spec_name: string; invoice_name: string;
    } | undefined;

    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.transaction(() => {
      // Deselect all matches for this spec item
      db.prepare(
        'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
      ).run(match.specification_item_id);

      // Confirm and select this match
      db.prepare(
        'UPDATE matched_items SET is_confirmed = 1, is_selected = 1 WHERE id = ?'
      ).run(matchId);

      // Create or update matching rule
      const specPattern = normalizeForMatching(match.spec_name);
      const invoicePattern = normalizeForMatching(match.invoice_name);

      const existingRule = db.prepare(
        'SELECT id, times_used FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ?'
      ).get(specPattern, invoicePattern) as { id: number; times_used: number } | undefined;

      if (existingRule) {
        db.prepare(
          'UPDATE matching_rules SET times_used = times_used + 1, confidence = MIN(1.0, confidence + 0.02), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(existingRule.id);
      } else {
        db.prepare(
          'INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used) VALUES (?, ?, 0.9, 1)'
        ).run(specPattern, invoicePattern);
      }
    })();

    res.json({ confirmed: true });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при подтверждении матча',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// DELETE /api/matching/:id — reject/delete a match
router.delete('/api/matching/:id', (req: Request, res: Response) => {
  try {
    const matchId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const match = db.prepare('SELECT id FROM matched_items WHERE id = ?').get(matchId);
    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.prepare('DELETE FROM matched_items WHERE id = ?').run(matchId);
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
             si.name as spec_name, ii.name as invoice_name
      FROM matched_items m
      JOIN specification_items si ON m.specification_item_id = si.id
      JOIN invoice_items ii ON m.invoice_item_id = ii.id
      WHERE m.id = ?
    `).get(matchId) as {
      id: number; specification_item_id: number; invoice_item_id: number;
      spec_name: string; invoice_name: string;
    } | undefined;

    if (!match) {
      return res.status(404).json({ error: 'Матч не найден' });
    }

    db.transaction(() => {
      // Deselect all matches for this spec item
      db.prepare(
        'UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?'
      ).run(match.specification_item_id);

      // Confirm and select this match (but mark as analog-like)
      db.prepare(
        'UPDATE matched_items SET is_confirmed = 1, is_selected = 1 WHERE id = ?'
      ).run(matchId);

      // Create or update matching rule with lower confidence (analog = 0.75)
      const specPattern = normalizeForMatching(match.spec_name);
      const invoicePattern = normalizeForMatching(match.invoice_name);

      const existingRule = db.prepare(
        'SELECT id, times_used FROM matching_rules WHERE specification_pattern = ? AND invoice_pattern = ?'
      ).get(specPattern, invoicePattern) as { id: number; times_used: number } | undefined;

      if (existingRule) {
        // If already exists, keep confidence but increment times_used
        db.prepare(
          'UPDATE matching_rules SET times_used = times_used + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(existingRule.id);
      } else {
        // Create new rule with lower confidence for analog
        db.prepare(
          'INSERT INTO matching_rules (specification_pattern, invoice_pattern, confidence, times_used) VALUES (?, ?, 0.75, 1)'
        ).run(specPattern, invoicePattern);
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

export default router;
