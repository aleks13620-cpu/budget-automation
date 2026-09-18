import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import * as XLSX from 'xlsx';
import { computeExportRows } from '../services/exportPricing';
import { matchItemsToRawRows } from '../services/rowMatcher';

const router = Router();

/**
 * Ячейки исходного листа Арты иногда несут перенос строки Windows (\r\n) внутри одной
 * ячейки (напр. «Клапан\r\nKPNZ-90-1100*500-...»). Библиотека `xlsx` при записи такой
 * строки экранирует \r как текстовый токен `_x000D_` (конвенция Excel для управляющих
 * символов в XML) — сам SheetJS разворачивает его обратно при чтении СВОИМ же ридером,
 * но LibreOffice (и, потенциально, не любой Excel) этого не делает и показывает токен
 * буквально (найдено оркестратором на PDF, стр. 10–12 проекта 16). \n внутри ячейки XML
 * не экранируется и переносится нормально — поэтому просто убираем \r, ничего другого
 * в значении не трогаем.
 */
export function normalizeCellNewlines<T>(v: T): T {
  if (typeof v !== 'string') return v;
  return v.replace(/\r\n/g, '\n').replace(/\r/g, '\n') as unknown as T;
}

/**
 * Ф14 — «Скачать форму Арты с ценами»: та же исходная спецификация (raw_data), которую
 * прислала Арта, БЕЗ изменений в исходных ячейках, плюс 4 наших колонки справа
 * (Цена/Поставщик/Источник/Ссылка) в строке КАЖДОЙ найденной позиции. Позиции, чью строку
 * не нашли по содержимому, уходят на отдельный лист «Не нашли строку» — ни одна цена
 * не пропадает молча (см. rowMatcher.ts).
 *
 * По проекту, не по specification_id: у ProjectDetail.tsx уже есть projectId, отдельный
 * запрос за id спецификации не нужен (ladder — самое простое, что работает). У всех трёх
 * известных проектов Арты (15/16/17) на спецификацию — ровно один файл с raw_data;
 * если у проекта их 0 или больше 1, отвечаем понятной 400-кой, а не гадаем.
 */
router.get('/api/projects/:id/export-original', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: number; name: string } | undefined;
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const specs = db.prepare(
      'SELECT id, raw_data FROM specifications WHERE project_id = ? AND raw_data IS NOT NULL',
    ).all(projectId) as Array<{ id: number; raw_data: string }>;

    if (specs.length === 0) {
      return res.status(400).json({ error: 'Для проекта нет сохранённых сырых данных исходного файла' });
    }
    if (specs.length > 1) {
      return res.status(400).json({
        error: `У проекта ${specs.length} спецификации с сырыми данными — выгрузка формы поддерживает ровно одну на проект`,
      });
    }
    const spec = specs[0];

    let rawRows: unknown[][];
    try {
      rawRows = JSON.parse(spec.raw_data);
    } catch {
      return res.status(500).json({ error: 'Не удалось разобрать сырые данные спецификации' });
    }
    if (!Array.isArray(rawRows)) {
      return res.status(500).json({ error: 'Сырые данные спецификации повреждены' });
    }

    const items = db.prepare(
      'SELECT id, name FROM specification_items WHERE specification_id = ? ORDER BY id',
    ).all(spec.id) as Array<{ id: number; name: string }>;

    // Цена/поставщик/источник/ссылка — та же функция, что и обычная выгрузка (export.ts),
    // без дублирования логики выбора варианта (счёт/прайс/сайт/автоподстановка).
    const priced = computeExportRows(db, projectId, 'best');
    const priceById = new Map(priced.map((r) => [r.id, r]));

    const { matched } = matchItemsToRawRows(rawRows, items);

    // Наши 4 колонки — строго справа от самой широкой строки исходного листа.
    const width = rawRows.reduce((w, row) => Math.max(w, row.length), 0);
    const PRICE_COL = width;
    const SUPPLIER_COL = width + 1;
    const SOURCE_COL = width + 2;
    const LINK_COL = width + 3;

    // Копия исходных строк как есть — не мутируем raw_data, только дописываем справа.
    // \r\n/\r → \n (см. normalizeCellNewlines) — единственное, что меняем в исходном значении.
    const sheetRows: (string | number | null)[][] = rawRows.map((row) => {
      const copy = (row as (string | number | null)[]).map(normalizeCellNewlines);
      while (copy.length < width + 4) copy.push(null);
      return copy;
    });

    if (sheetRows.length > 0) {
      sheetRows[0][PRICE_COL] = 'Цена, руб';
      sheetRows[0][SUPPLIER_COL] = 'Поставщик';
      sheetRows[0][SOURCE_COL] = 'Источник';
      sheetRows[0][LINK_COL] = 'Ссылка';
    }

    const notFoundRows: Array<[string | null, string, number | null, string]> = [];

    for (const item of items) {
      const priceRow = priceById.get(item.id);
      if (!priceRow || priceRow.price == null) continue; // без цены — писать нечего

      const rowIdx = matched.get(item.id);
      if (rowIdx === undefined) {
        notFoundRows.push([
          normalizeCellNewlines(priceRow.position_number),
          normalizeCellNewlines(priceRow.name),
          priceRow.price,
          normalizeCellNewlines(priceRow.supplier),
        ]);
        continue;
      }
      sheetRows[rowIdx][PRICE_COL] = priceRow.price;
      sheetRows[rowIdx][SUPPLIER_COL] = normalizeCellNewlines(priceRow.supplier);
      sheetRows[rowIdx][SOURCE_COL] = normalizeCellNewlines(priceRow.foundBy);
      sheetRows[rowIdx][LINK_COL] = normalizeCellNewlines(priceRow.url);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Форма');

    const notFoundData: (string | number | null)[][] = [
      ['№', 'Наименование', 'Цена, руб', 'Поставщик'],
      ...notFoundRows,
    ];
    const wsNotFound = XLSX.utils.aoa_to_sheet(notFoundData);
    XLSX.utils.book_append_sheet(wb, wsNotFound, 'Не нашли строку');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = encodeURIComponent(`${project.name}_форма_с_ценами.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (error) {
    res.status(500).json({
      error: 'Ошибка при выгрузке формы с ценами',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
