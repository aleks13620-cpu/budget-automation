import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import * as XLSX from 'xlsx';

const router = Router();

// GET /api/projects/:id/export — export final specification as .xlsx
router.get('/api/projects/:id/export', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: number; name: string } | undefined;
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    // Get all spec items with their selected match
    const rows = db.prepare(`
      SELECT si.id, si.position_number, si.name, si.unit, si.quantity, si.section,
             ii.price, ii.name as invoice_name, ii.article,
             s.name as supplier_name
      FROM specification_items si
      LEFT JOIN matched_items m ON m.specification_item_id = si.id AND m.is_selected = 1
      LEFT JOIN invoice_items ii ON m.invoice_item_id = ii.id
      LEFT JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE si.project_id = ?
      ORDER BY si.section, si.id
    `).all(projectId) as Array<{
      id: number; position_number: string | null; name: string;
      unit: string | null; quantity: number | null; section: string | null;
      price: number | null; invoice_name: string | null;
      article: string | null; supplier_name: string | null;
    }>;

    // Group by section
    const sectionMap = new Map<string, typeof rows>();
    for (const row of rows) {
      const sec = row.section || 'Без раздела';
      if (!sectionMap.has(sec)) sectionMap.set(sec, []);
      sectionMap.get(sec)!.push(row);
    }

    // Build worksheet data
    const wsData: (string | number | null)[][] = [];

    // Header
    wsData.push([`Итоговая спецификация: ${project.name}`]);
    wsData.push([`Дата: ${new Date().toLocaleDateString('ru-RU')}`]);
    wsData.push([]); // empty row

    // Column headers
    const headerRow = ['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Сумма', 'Поставщик'];
    wsData.push(headerRow);

    let grandTotal = 0;
    let rowNum = 1;

    // Track rows for styling
    const sectionHeaderRows: number[] = [];
    const subtotalRows: number[] = [];

    for (const [sectionName, sectionItems] of sectionMap) {
      // Section header row
      sectionHeaderRows.push(wsData.length);
      wsData.push([sectionName, null, null, null, null, null, null]);

      let sectionTotal = 0;

      for (const item of sectionItems) {
        const qty = item.quantity || 0;
        const price = item.price;
        const amount = price != null ? Math.round(price * qty * 100) / 100 : null;
        if (amount != null) sectionTotal += amount;

        wsData.push([
          rowNum++,
          item.name,
          item.unit || '',
          item.quantity,
          price,
          amount,
          item.supplier_name || '',
        ]);
      }

      grandTotal += sectionTotal;

      // Section subtotal
      subtotalRows.push(wsData.length);
      wsData.push([null, `Итого ${sectionName}:`, null, null, null, Math.round(sectionTotal * 100) / 100, null]);
      wsData.push([]); // empty row
    }

    // Grand total
    const grandTotalRowIdx = wsData.length;
    wsData.push([null, 'ОБЩИЙ ИТОГ:', null, null, null, Math.round(grandTotal * 100) / 100, null]);

    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Set column widths
    ws['!cols'] = [
      { wch: 5 },   // №
      { wch: 45 },  // Наименование
      { wch: 8 },   // Ед.
      { wch: 10 },  // Кол-во
      { wch: 12 },  // Цена
      { wch: 14 },  // Сумма
      { wch: 20 },  // Поставщик
    ];

    // Merge title row
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }, // title
      { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }, // date
    ];

    // Merge section header rows
    for (const r of sectionHeaderRows) {
      ws['!merges']!.push({ s: { r, c: 0 }, e: { r, c: 6 } });
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Спецификация');

    // Write to buffer
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fileName = encodeURIComponent(`${project.name}_спецификация.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при экспорте',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
