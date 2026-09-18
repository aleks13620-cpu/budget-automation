import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import * as XLSX from 'xlsx';
import { computeExportRows } from '../services/exportPricing';

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

    // mode: 'best' (default) = all selected, 'original' = non-analog only, 'analog' = analog only
    const mode = String(req.query.mode || 'best') as 'best' | 'original' | 'analog';

    // Цена/поставщик/источник/ссылка по позиции — общая функция с routes/exportOriginal.ts
    // (Ф14, вынесено из этого файла, поведение не изменилось).
    const rows = computeExportRows(db, projectId, mode);

    // Group by section
    const sectionMap = new Map<string, typeof rows>();
    for (const row of rows) {
      const sec = row.section || 'Без раздела';
      if (!sectionMap.has(sec)) sectionMap.set(sec, []);
      sectionMap.get(sec)!.push(row);
    }

    // Build worksheet data
    const wsData: (string | number | null)[][] = [];
    const linkCells: Array<{ row: number; url: string }> = [];

    // Header
    const modeLabel = mode === 'original' ? ' [Оригинал]' : mode === 'analog' ? ' [Аналог]' : '';
    wsData.push([`Итоговая спецификация: ${project.name}${modeLabel}`]);
    wsData.push([`Дата: ${new Date().toLocaleDateString('ru-RU')}`]);
    wsData.push([]); // empty row

    // Column headers
    const headerRow = ['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Цена с НДС', 'Сумма', 'Поставщик', 'Тип', 'Группа', 'Найдено по', 'Ссылка на товар'];
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
        if (item.amount != null) sectionTotal += item.amount;

        wsData.push([
          rowNum++,
          item.name,
          item.unit || '',
          item.quantity,
          item.price,
          item.priceWithVat,
          item.amount,
          item.supplier,
          item.typeLabel,
          item.groupLabel,
          item.foundBy,
          // Адрес отдельной колонкой, а не только гиперссылкой на домене: библиотека пишет
          // xlsx без стилей, и кликабельная ячейка выглядит обычным чёрным текстом — человек
          // не видит, что по ней можно перейти. Видимый адрес читается как ссылка сам по себе.
          item.url,
        ]);
        if (item.url) linkCells.push({ row: wsData.length - 1, url: item.url });
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
    const externalCount = rows.filter((r) => r.usedExternal).length;
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
      { wch: 26 },  // Группа
      { wch: 46 },  // Найдено по
      { wch: 52 },  // Ссылка на товар — последняя, адрес переливается вправо
    ];

    // Ссылка кликабельная: Иван проверяет товар одним нажатием, не выходя из файла.
    // Только http/https: адрес приходит с чужого сайта, а file:// или \\сервер\share
    // в документе Windows — рабочий способ утечки учётных данных по клику.
    for (const { row, url } of linkCells) {
      const addr = XLSX.utils.encode_cell({ r: row, c: 7 });   // «Поставщик» — там уже домен
      if (ws[addr]) ws[addr].l = { Target: url, Tooltip: 'Открыть карточку товара у продавца' };
      const urlAddr = XLSX.utils.encode_cell({ r: row, c: 11 }); // «Ссылка на товар» — виден адрес
      if (ws[urlAddr]) ws[urlAddr].l = { Target: url, Tooltip: 'Открыть карточку товара у продавца' };
    }

    // Merge title row
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }, // title
      { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } }, // date
    ];

    // Merge section header rows
    for (const r of sectionHeaderRows) {
      ws['!merges']!.push({ s: { r, c: 0 }, e: { r, c: 11 } });
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
