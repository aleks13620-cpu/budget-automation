import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import * as XLSX from 'xlsx';

const router = Router();

function computeUnitPriceWithVat(
  price: number | null,
  vatRate: number | null,
  inclVat: number | null,
  invoiceQuantity: number | null,
  invoiceAmount: number | null,
): { unitPriceWithVat: number | null; source: 'raw' | 'derived_unit' } {
  if (invoiceAmount != null && invoiceQuantity != null && invoiceQuantity > 0) {
    const lineTotalWithVat = inclVat === 0 && vatRate != null && vatRate > 0
      ? invoiceAmount * (1 + vatRate / 100)
      : invoiceAmount;
    return {
      unitPriceWithVat: Math.round((lineTotalWithVat / invoiceQuantity) * 100) / 100,
      source: 'derived_unit',
    };
  }
  if (price == null) return { unitPriceWithVat: null, source: 'raw' };
  if (inclVat === 0 && vatRate != null && vatRate > 0) {
    return {
      unitPriceWithVat: Math.round(price * (1 + vatRate / 100) * 100) / 100,
      source: 'raw',
    };
  }
  return { unitPriceWithVat: price, source: 'raw' };
}

// GET /api/projects/:id/export — export final specification as .xlsx
router.get('/api/projects/:id/export', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: number; name: string } | undefined;
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    // mode: 'best' (default) = all selected, 'original' = non-analog only, 'analog' = analog only
    const mode = String(req.query.mode || 'best');
    let analogFilter = '';
    if (mode === 'original') {
      analogFilter = 'AND (COALESCE(m.is_analog, 0) = 0)';
    } else if (mode === 'analog') {
      analogFilter = 'AND m.is_analog = 1';
    }

    // Get all spec items with their selected match (including price list items),
    // plus the best external web-search price (latest snapshot, cheapest offer)
    // as a fallback for items with no invoice/price-list match.
    const rows = db.prepare(`
      -- source='web_search' обязателен во всех трёх CTE: в external_prices лежат ещё
      -- старые прогоны прежних источников, включая тестовые с несуществующим доменом
      -- example-supplier. Без этого фильтра они уехали бы в спецификацию клиента как цены.
      WITH ext_ranked AS (
        SELECT ep.spec_item_id, ep.price, ep.supplier_name,
               json_extract(ep.raw_data, '$.found_by') as found_by,
               json_extract(ep.raw_data, '$.mark') as mark,
               ROW_NUMBER() OVER (
                 PARTITION BY ep.spec_item_id
                 ORDER BY ep.snapshot_date DESC, ep.price ASC
               ) as rn
        FROM external_prices ep
        WHERE ep.status = 'found' AND ep.source = 'web_search'
      ),
      ext_group AS (
        SELECT spec_item_id, MIN(json_extract(raw_data, '$.group')) as grp
        FROM external_prices WHERE source = 'web_search' GROUP BY spec_item_id
      ),
      ext_notfound AS (
        SELECT DISTINCT spec_item_id FROM external_prices
        WHERE status = 'not_found' AND source = 'web_search'
      )
      SELECT si.id, si.position_number, si.name, si.unit, si.quantity, si.section,
             COALESCE(ii.price, pli.price) as price,
             ii.quantity as invoice_quantity,
             ii.amount as invoice_amount,
             COALESCE(ii.name, pli.name) as invoice_name,
             COALESCE(ii.article, pli.article) as article,
             s.name as supplier_name, COALESCE(s.vat_rate, i.vat_rate) as vat_rate, s.prices_include_vat,
             COALESCE(m.is_analog, 0) as is_analog,
             er.price as ext_price, er.supplier_name as ext_supplier,
             er.found_by as ext_found_by, er.mark as ext_mark,
             eg.grp as ext_group,
             CASE WHEN enf.spec_item_id IS NOT NULL THEN 1 ELSE 0 END as ext_not_found
      FROM specification_items si
      LEFT JOIN matched_items m ON m.specification_item_id = si.id AND m.is_selected = 1 ${analogFilter}
      LEFT JOIN invoice_items ii ON (COALESCE(m.source,'invoice') = 'invoice') AND m.invoice_item_id = ii.id
      LEFT JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN price_list_items pli ON (m.source = 'price_list') AND m.price_list_item_id = pli.id
      LEFT JOIN price_lists pl ON pli.price_list_id = pl.id
      LEFT JOIN suppliers s ON COALESCE(i.supplier_id, pl.supplier_id) = s.id
      LEFT JOIN ext_ranked er ON er.spec_item_id = si.id AND er.rn = 1
      LEFT JOIN ext_group eg ON eg.spec_item_id = si.id
      LEFT JOIN ext_notfound enf ON enf.spec_item_id = si.id
      WHERE si.project_id = ?
      ORDER BY si.section, si.id
    `).all(projectId) as Array<{
      id: number; position_number: string | null; name: string;
      unit: string | null; quantity: number | null; section: string | null;
      price: number | null; invoice_quantity: number | null; invoice_amount: number | null; invoice_name: string | null;
      article: string | null; supplier_name: string | null;
      vat_rate: number | null; prices_include_vat: number | null;
      is_analog: number;
      ext_price: number | null; ext_supplier: string | null;
      ext_found_by: string | null; ext_mark: string | null;
      ext_group: string | null; ext_not_found: number;
    }>;

    const GROUP_LABELS: Record<string, string> = {
      'A. изготавливается': 'изготавливается по чертежу',
      'B. проектное': 'проектное, цена по запросу',
      'C. марка изделия': 'есть заводская марка',
      'D. без марки': 'описано словами',
    };

    function foundByLabel(usedExternal: boolean, foundBy: string | null, mark: string | null, notFound: number): string {
      if (!usedExternal) return notFound ? 'искали, не нашли' : '';
      const suffix = mark ? ` ${mark}` : '';
      if (foundBy === 'артикул') return `артикул${suffix}`;
      if (foundBy === 'типоразмер') return `типоразмер${suffix}`;
      return 'без артикула — проверьте';
    }

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
    const modeLabel = mode === 'original' ? ' [Оригинал]' : mode === 'analog' ? ' [Аналог]' : '';
    wsData.push([`Итоговая спецификация: ${project.name}${modeLabel}`]);
    wsData.push([`Дата: ${new Date().toLocaleDateString('ru-RU')}`]);
    wsData.push([]); // empty row

    // Column headers
    const headerRow = ['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Цена с НДС', 'Сумма', 'Поставщик', 'Тип', 'Группа', 'Найдено по'];
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
        // Только в обычной выгрузке. В режимах «оригинал»/«аналог» пустая цена — это
        // ответ «такого варианта нет», и подставлять туда интернет-цену нельзя:
        // она не является ни оригиналом, ни аналогом.
        const usedExternal = mode === 'best' && item.price == null && item.ext_price != null;
        const price = usedExternal ? item.ext_price : item.price;
        const supplier = usedExternal ? (item.ext_supplier || '') : (item.supplier_name || '');
        const pricing = computeUnitPriceWithVat(
          price,
          item.vat_rate,
          item.prices_include_vat,
          item.invoice_quantity,
          item.invoice_amount,
        );
        // У интернет-цены ставка НДС неизвестна: у продавца её взять неоткуда.
        // Пустая клетка честнее подстановки той же цифры — иначе читается как «цена без НДС».
        // Сумма для таких строк считается по цене продавца как есть.
        const priceWithVat = usedExternal ? null : pricing.unitPriceWithVat;
        const amountBase = usedExternal ? price : priceWithVat;
        const amount = amountBase != null ? Math.round(amountBase * qty * 100) / 100 : null;
        if (amount != null) sectionTotal += amount;

        wsData.push([
          rowNum++,
          item.name,
          item.unit || '',
          item.quantity,
          price,
          priceWithVat,
          amount,
          supplier,
          usedExternal ? 'Интернет' : (item.is_analog ? 'Аналог' : 'Ориг.'),
          item.ext_group ? (GROUP_LABELS[item.ext_group] || item.ext_group) : '',
          foundByLabel(usedExternal, item.ext_found_by, item.ext_mark, item.ext_not_found),
        ]);
      }

      grandTotal += sectionTotal;

      // Section subtotal
      subtotalRows.push(wsData.length);
      wsData.push([null, `Итого ${sectionName}:`, null, null, null, null, Math.round(sectionTotal * 100) / 100, null, null]);
      wsData.push([]); // empty row
    }

    // Grand total
    const grandTotalRowIdx = wsData.length;
    wsData.push([null, 'ОБЩИЙ ИТОГ:', null, null, null, null, Math.round(grandTotal * 100) / 100, null, null]);

    // Итог складывает цены из счетов (приведённые к НДС) и цены из интернета (как есть,
    // ставку НДС у продавца взять неоткуда). Пока все поставщики в базе с НДС в цене,
    // разницы не видно — но читатель итога должен знать, из чего он сложен.
    const externalCount = rows.filter((r) => r.price == null && r.ext_price != null).length;
    if (externalCount > 0 && mode === 'best') {
      wsData.push([]);
      wsData.push([null, `В итог вошли ${externalCount} позиций с ценой из интернета (колонка «Тип» = Интернет). ` +
        'По ним ставка НДС неизвестна — цена взята как у продавца.']);
    }

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
      { wch: 14 },  // Цена с НДС
      { wch: 14 },  // Сумма
      { wch: 20 },  // Поставщик
      { wch: 9 },   // Тип
      { wch: 22 },  // Группа
      { wch: 22 },  // Найдено по
    ];

    // Merge title row
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, // title
      { s: { r: 1, c: 0 }, e: { r: 1, c: 10 } }, // date
    ];

    // Merge section header rows
    for (const r of sectionHeaderRows) {
      ws['!merges']!.push({ s: { r, c: 0 }, e: { r, c: 10 } });
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Спецификация');

    // Write to buffer
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const modeSuffix = mode === 'original' ? '_оригинал' : mode === 'analog' ? '_аналог' : '';
    const fileName = encodeURIComponent(`${project.name}_спецификация${modeSuffix}.xlsx`);
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
