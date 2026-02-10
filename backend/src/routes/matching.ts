import { Router, Request, Response } from 'express';
import stringSimilarity from 'string-similarity';
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
        'UPDATE matched_items SET is_confirmed = 1, is_selected = 1 WHERE id = ?'
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
router.get('/api/projects/:id/invoice-items/search', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const q = String(req.query.q || '').trim();
    const db = getDatabase();

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Минимум 2 символа для поиска' });
    }

    const invoiceItems = db.prepare(`
      SELECT ii.id, ii.name, ii.article, ii.unit, ii.quantity, ii.price, ii.amount,
             s.name as supplier_name, i.supplier_id
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.project_id = ?
      ORDER BY ii.id
    `).all(projectId) as Array<{
      id: number; name: string; article: string | null;
      unit: string | null; quantity: number | null;
      price: number | null; amount: number | null;
      supplier_name: string | null; supplier_id: number | null;
    }>;

    const normalizedQ = normalizeForMatching(q);

    const scored = invoiceItems.map(item => {
      const normalizedName = normalizeForMatching(item.name);
      const score = stringSimilarity.compareTwoStrings(normalizedQ, normalizedName);
      return { ...item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 15).filter(s => s.score > 0.15);

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

    // Get all spec items with their selected match
    const rows = db.prepare(`
      SELECT si.id, si.name, si.unit, si.quantity, si.section,
             ii.price, ii.name as invoice_name, ii.article,
             s.name as supplier_name,
             m.id as match_id, m.is_confirmed
      FROM specification_items si
      LEFT JOIN matched_items m ON m.specification_item_id = si.id AND m.is_selected = 1
      LEFT JOIN invoice_items ii ON m.invoice_item_id = ii.id
      LEFT JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE si.project_id = ?
      ORDER BY si.section, si.id
    `).all(projectId) as Array<{
      id: number; name: string; unit: string | null; quantity: number | null;
      section: string | null; price: number | null; invoice_name: string | null;
      article: string | null; supplier_name: string | null;
      match_id: number | null; is_confirmed: number | null;
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
    }>();

    let grandTotal = 0;

    for (const row of rows) {
      const sectionName = row.section || 'Без раздела';
      if (!sectionMap.has(sectionName)) {
        sectionMap.set(sectionName, { items: [], subtotal: 0 });
      }
      const section = sectionMap.get(sectionName)!;

      const price = row.price;
      const qty = row.quantity || 0;
      const amount = price != null ? price * qty : null;

      if (amount != null) {
        section.subtotal += amount;
        grandTotal += amount;
      }

      section.items.push({
        specId: row.id,
        name: row.name,
        unit: row.unit,
        quantity: row.quantity,
        price,
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
      items: data.items,
    }));

    res.json({
      projectName: project.name,
      sections,
      grandTotal: Math.round(grandTotal * 100) / 100,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при расчёте итогов',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
