import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../database';
import { safeUnlink } from '../utils/safeUnlink';
import { createUploadMiddleware, fixFilename } from '../utils/fileUtils';
import { parseExcelFile, parseFromRawData, detectMappingFromRawData, headerSignature } from '../services/excelParser';
import type { ColumnMapping } from '../services/excelParser';
import { detectSectionFromFilename, detectSectionFromItems } from '../services/sectionDetector';
import { enrichSpecItems } from '../services/gigachatSpecParser';
import type { SpecItemInput } from '../services/gigachatSpecParser';
import { parseSpecFromPdf, buildRawDataFromPdfItems, PDF_SPEC_EMPTY_RAW_DATA } from '../services/gigachatSpecFromPdf';
import { applyVariantMarkersToItems } from '../services/variantMarkers';
import type { SpecPdfParseQuality } from '../types/specification';

/**
 * Текст оператору при hardBlock-гейте качества PDF-спеки. Причина у блока две, и
 * сообщение должно соответствовать фактической: потеря колонки «Количество»
 * (сдвиг колонок при пустой «Поз.» — bareOrphanFraction ≈ 0, поэтому старый текст
 * про «оторванные типоразмеры» был бы бессмыслицей «0% строк…»), либо развал
 * иерархии (голые сироты). При потере количества берём уже готовое предупреждение
 * из specParseQuality.warnings (см. gigachatSpecParseQuality), с понятным фолбэком.
 */
function hardBlockReason(q: SpecPdfParseQuality): string {
  if (q.quantityColumnLost) {
    const qtyWarning = q.warnings.find(w => w.includes('Количество'));
    return (
      qtyWarning ||
      'Потеряна колонка «Количество»: значения количеств уехали в № позиции (сдвиг колонок). Пришлите Excel или проверьте PDF.'
    );
  }
  const pct = Math.round((q.bareOrphanFraction ?? 0) * 100);
  return `Спека не распарсилась корректно: ${pct}% строк — оторванные типоразмеры/коды без родителя. Пришлите Excel или проверьте PDF.`;
}

/** Колонки, потеря которых обесценивает загрузку: без артикула нет поиска цен, без количества
 *  позиция вылетает фильтром `if (!r.quantity) continue` в classifySpecPositions и не доходит
 *  ни до классификации, ни до поиска (проект 14 «Жк Фаворит ОВ»: раздел ВК — 387 позиций,
 *  количество распозналось у нуля, 64% спецификации потеряно молча). */
const KEY_COLUMNS: Array<keyof ColumnMapping> = ['product_code', 'quantity'];

/** Откуда взялась разметка колонок — чтобы человек не думал, что система «сама поняла» файл. */
type MappingTemplateInfo = { specificationId: number; fileName: string; filledColumns: string[] };

type SavedParserConfig = {
  specificationId: number;
  fileName: string;
  columnMapping: ColumnMapping;
  mergeMultiline: boolean;
};

/** Разметка, которой файл фактически разобран, — её и запоминаем для новой спецификации. */
type AppliedParserConfig = {
  headerRow: number;
  columnMapping: ColumnMapping;
  mergeMultiline: boolean;
  headerSignature: string | null;
};

/**
 * UPSERT разметки колонок — одно место на все четыре точки записи (/reparse, /parser-config
 * и обе загрузки). Без записи при загрузке память не размножается: редактор открывает файл,
 * видит автодетект (артикул не выбран) и «Пересобрать» тем, что показал экран, возвращает 179→0.
 */
function saveParserConfig(
  db: ReturnType<typeof getDatabase>,
  specificationId: number,
  cfg: AppliedParserConfig,
): void {
  db.prepare(`
    INSERT INTO specification_parser_configs (specification_id, header_row, column_mapping, merge_multiline, header_signature, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(specification_id) DO UPDATE SET
      header_row = excluded.header_row,
      column_mapping = excluded.column_mapping,
      merge_multiline = excluded.merge_multiline,
      header_signature = excluded.header_signature,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    specificationId,
    cfg.headerRow,
    JSON.stringify(cfg.columnMapping),
    cfg.mergeMultiline ? 1 : 0,
    cfg.headerSignature,
  );
}

/** Подпись шапки для уже сохранённого конфига: считаем из raw_data его же спецификации. */
function signatureOfSavedConfig(rawData: string | null, headerRow: number): string | null {
  if (!rawData) return null;
  try {
    const rows = JSON.parse(rawData) as unknown[][];
    if (!Array.isArray(rows) || !Array.isArray(rows[headerRow])) return null;
    return headerSignature(rows[headerRow]);
  } catch {
    return null;
  }
}

/**
 * Ищем ранее сохранённую РУЧНУЮ разметку по ПОЛНОМУ совпадению подписи шапки.
 * Частичное совпадение не годится: у двух разных бланков Арты совпадают 5 заголовков из 7,
 * а колонка 2 в одном — марка изделия, в другом — обозначение документа. Молча подставленная
 * чужая разметка хуже, чем её отсутствие.
 *
 * Колонку header_signature завели позже самих конфигов, поэтому у старых записей она NULL —
 * досчитываем её здесь из raw_data и тут же дописываем. Так проще и надёжнее, чем бэкофил
 * в миграции: миграции в проекте — голый DDL (database/init.ts), парсинг JSON туда не лезет,
 * а ленивый досчёт срабатывает и на прод-базе, и на любой копии, без отдельного прогона.
 *
 * Порядок задан явно: свежая разметка выигрывает у старой. Конфигов теперь по одному на каждую
 * загрузку, и без ORDER BY выигрывал бы старейший — то есть исправленная человеком разметка
 * не применилась бы никогда.
 *
 * ponytail: перебираем все конфиги (на проде их единицы). Станут тысячи — индекс по
 * header_signature и поиск запросом.
 */
function findParserConfigByHeader(signature: string): SavedParserConfig | null {
  if (!signature) return null;
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT c.specification_id, c.header_row, c.column_mapping, c.merge_multiline, c.header_signature,
           s.file_name, s.raw_data
    FROM specification_parser_configs c
    JOIN specifications s ON s.id = c.specification_id
    ORDER BY c.updated_at DESC, c.id DESC
  `).all() as Array<{
    specification_id: number;
    header_row: number;
    column_mapping: string;
    merge_multiline: number;
    header_signature: string | null;
    file_name: string;
    raw_data: string | null;
  }>;

  for (const row of rows) {
    let sig = row.header_signature;
    if (sig === null || sig === undefined) {
      sig = signatureOfSavedConfig(row.raw_data, row.header_row);
      if (sig !== null) {
        db.prepare('UPDATE specification_parser_configs SET header_signature = ? WHERE specification_id = ?')
          .run(sig, row.specification_id);
      }
    }
    if (!sig || sig !== signature) continue;

    let mapping: ColumnMapping;
    try {
      mapping = JSON.parse(row.column_mapping) as ColumnMapping;
    } catch {
      continue;
    }
    if (!mapping || typeof mapping !== 'object') continue;
    return {
      specificationId: row.specification_id,
      fileName: row.file_name,
      columnMapping: mapping,
      mergeMultiline: row.merge_multiline !== 0,
    };
  }
  return null;
}

/**
 * Достраиваем автоопределённый маппинг сохранённой разметкой: берём ТОЛЬКО те поля, которые
 * автодетект оставил пустыми. Успешно определённую колонку не подменяем — автодетект видит
 * конкретный файл, шаблон видит только шапку. Колонку, уже занятую автодетектом под другое
 * поле, тоже не трогаем: два поля на одной колонке — это молчаливая порча данных.
 */
function mergeMappingWithTemplate(
  detected: ColumnMapping,
  template: ColumnMapping,
): { mapping: ColumnMapping; filledColumns: string[] } {
  const mapping: ColumnMapping = { ...detected };
  const usedCols = new Set<number>(
    Object.values(detected).filter((v): v is number => typeof v === 'number'),
  );
  const filledColumns: string[] = [];

  for (const field of Object.keys(mapping) as Array<keyof ColumnMapping>) {
    const fromTemplate = template[field];
    if (mapping[field] !== null || typeof fromTemplate !== 'number') continue;
    if (usedCols.has(fromTemplate)) continue;
    mapping[field] = fromTemplate;
    usedCols.add(fromTemplate);
    filledColumns.push(field);
  }
  return { mapping, filledColumns };
}

/**
 * Единственное место разбора загруженного xlsx — общее для одиночной и массовой загрузки,
 * чтобы поведение двух эндпоинтов не разъезжалось.
 *
 * Если автоопределение не нашло ключевую колонку (артикул или количество), а шапка файла
 * полностью совпадает с шапкой файла, который человек однажды разметил руками, — достраиваем
 * маппинг его разметкой. Признака артикула в заголовке «Наименование в счете» нет и быть не
 * может, расширять словарь заголовков нечем — разметку остаётся только запоминать.
 */
function parseUploadedExcel(filePath: string): {
  parseResult: ReturnType<typeof parseExcelFile>;
  rawDataStr: string;
  mappingFromTemplate: MappingTemplateInfo | null;
  parserConfig: AppliedParserConfig | null;
} {
  const XLSXu = require('xlsx');
  const wb = XLSXu.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSXu.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][];
  const rawDataStr = JSON.stringify(rawRows);

  const detected = detectMappingFromRawData(rawRows);
  const missesKeyColumn = !!detected && KEY_COLUMNS.some(c => detected.columnMapping[c] === null);
  const signature = detected ? headerSignature(rawRows[detected.headerRow]) : null;

  if (detected && missesKeyColumn) {
    const template = findParserConfigByHeader(signature!);
    if (template) {
      const { mapping, filledColumns } = mergeMappingWithTemplate(detected.columnMapping, template.columnMapping);
      // Применяем, только если шаблон реально закрыл ключевую дыру. Иначе это молчаливая
      // подмена разметки без выигрыша.
      const closedKeyGap = KEY_COLUMNS.some(c => detected.columnMapping[c] === null && mapping[c] !== null);
      if (closedKeyGap && mapping.name !== null) {
        // Строка заголовка берётся у НОВОГО файла: именно её подпись совпала с шаблоном,
        // значит именно к ней привязаны номера колонок.
        const templated = parseFromRawData(rawRows, detected.headerRow, mapping, template.mergeMultiline);
        if (templated.items.length > 0) {
          return {
            parseResult: templated,
            rawDataStr,
            mappingFromTemplate: {
              specificationId: template.specificationId,
              fileName: template.fileName,
              filledColumns,
            },
            parserConfig: { headerRow: detected.headerRow, columnMapping: mapping, mergeMultiline: template.mergeMultiline, headerSignature: signature },
          };
        }
      }
    }
  }

  // Автоопределение справилось само (или заголовок не найден вовсе). Разметку всё равно
  // запоминаем: иначе следующий такой же файл снова не с чем будет сверить.
  // mergeMultiline = true — parseExcelFile склеивает многострочные позиции всегда.
  return {
    parseResult: parseExcelFile(filePath),
    rawDataStr,
    mappingFromTemplate: null,
    parserConfig: detected
      ? { headerRow: detected.headerRow, columnMapping: detected.columnMapping, mergeMultiline: true, headerSignature: signature }
      : null,
  };
}

const upload = createUploadMiddleware({
  allowedExtensions: ['.xlsx', '.xls', '.pdf'],
  errorMessage: 'Допустимы только файлы .xlsx, .xls и .pdf',
  maxFileSizeBytes: 50 * 1024 * 1024,
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

// GET /api/sections — list available sections
router.get('/api/sections', (_req: Request, res: Response) => {
  res.json({ sections: SECTIONS });
});

// POST /api/projects/:id/specifications — upload spec for a section
router.post('/api/projects/:id/specifications', upload.single('file'), async (req: Request, res: Response) => {
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

    const ext = path.extname(req.file.originalname).toLowerCase();
    let parseResult: ReturnType<typeof parseExcelFile>;
    let rawDataStr: string;
    let mappingFromTemplate: MappingTemplateInfo | null = null;
    let parserConfig: AppliedParserConfig | null = null;

    if (ext === '.pdf') {
      parseResult = await parseSpecFromPdf(req.file.path);
      if (parseResult.errors.length > 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error: 'Не удалось извлечь данные из PDF',
          details: parseResult.errors,
        });
      }
      // Блокирующий гейт качества: иерархия катастрофически развалена и LLM не помог.
      // Битые данные НЕ должны течь в матчер/обучение (feedback_no_corrupt_through).
      if (parseResult.specParseQuality?.hardBlock) {
        fs.unlink(req.file.path, () => {});
        return res.status(422).json({
          error: hardBlockReason(parseResult.specParseQuality),
          specParseQuality: parseResult.specParseQuality,
        });
      }
      rawDataStr = JSON.stringify(
        parseResult.category === 'C'
          ? PDF_SPEC_EMPTY_RAW_DATA
          : buildRawDataFromPdfItems(parseResult.items)
      );
    } else {
      const parsed = parseUploadedExcel(req.file.path);
      parseResult = parsed.parseResult;
      rawDataStr = parsed.rawDataStr;
      mappingFromTemplate = parsed.mappingFromTemplate;
      parserConfig = parsed.parserConfig;
      if (parseResult.items.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error: 'Не удалось извлечь данные из файла',
          details: parseResult.errors,
        });
      }
    }

    const fileName = fixFilename(req.file.originalname);
    const parseSource = ext === '.pdf' ? 'pdf_gigachat' : 'excel';

    // Insert specification + items in a transaction
    const result = db.transaction(() => {
      const specResult = db.prepare(
        'INSERT INTO specifications (project_id, section, file_name, raw_data, parse_source) VALUES (?, ?, ?, ?, ?)'
      ).run(projectId, section, fileName, rawDataStr, parseSource);
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

      // Разметка, которой файл разобран, остаётся с новой спецификацией: редактор откроет
      // именно её, а не автодетект, и «Пересобрать» не обнулит артикулы.
      if (parserConfig) saveParserConfig(db, specificationId, parserConfig);

      return { specificationId, items: inserted };
    })();

    // Clean up uploaded file
    safeUnlink(req.file.path);

    res.status(201).json({
      specificationId: result.specificationId,
      section,
      imported: result.items.length,
      errors: parseResult.errors,
      totalRows: parseResult.totalRows,
      skippedRows: parseResult.skippedRows,
      category: parseResult.category ?? null,
      categoryReason: parseResult.categoryReason ?? null,
      specParseQuality: parseResult.specParseQuality ?? null,
      // null = колонки распознаны автоматически; объект = разметка взята из ранее
      // размеченного руками файла с такой же шапкой. Человек должен видеть разницу.
      mappingFromTemplate,
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
             COALESCE(s.parse_source, 'excel') as parse_source,
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
router.post('/api/projects/:id/specifications/bulk', upload.array('files', 50), async (req: Request, res: Response) => {
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
      status: 'ok' | 'conflict' | 'no_section' | 'parse_error' | 'quality_block';
      error?: string;
      mappingFromTemplate?: MappingTemplateInfo | null;
    }[] = [];

    for (const file of files) {
      const fileName = fixFilename(file.originalname);
      const ext = path.extname(fileName).toLowerCase();

      try {
        let parseResult: ReturnType<typeof parseExcelFile>;
        let rawDataB: string;
        let parseSource: 'excel' | 'pdf_gigachat' = 'excel';
        let mappingFromTemplate: MappingTemplateInfo | null = null;
        let parserConfig: AppliedParserConfig | null = null;

        if (ext === '.pdf') {
          parseResult = await parseSpecFromPdf(file.path);
          parseSource = 'pdf_gigachat';
          if (parseResult.errors.length > 0) {
            fs.unlink(file.path, () => {});
            results.push({
              fileName,
              section: null,
              imported: 0,
              status: 'parse_error',
              error: parseResult.errors[0] || 'Не удалось извлечь данные из PDF',
            });
            continue;
          }
          // Блокирующий гейт качества (зеркало одиночного пути ~:83): иерархия катастрофически
          // развалена и LLM не помог. Битые данные НЕ пишем в specification_items — они НЕ должны
          // течь в матчер/обучение (feedback_no_corrupt_through). Прочие файлы bulk идут как обычно
          // (один битый PDF не валит весь батч).
          if (parseResult.specParseQuality?.hardBlock) {
            fs.unlink(file.path, () => {});
            results.push({
              fileName,
              section: null,
              imported: 0,
              status: 'quality_block',
              error: hardBlockReason(parseResult.specParseQuality),
            });
            continue;
          }
          rawDataB = JSON.stringify(
            parseResult.category === 'C'
              ? PDF_SPEC_EMPTY_RAW_DATA
              : buildRawDataFromPdfItems(parseResult.items)
          );
        } else {
          // Тот же путь, что и у одиночной загрузки: сохранённая ручная разметка колонок
          // применяется в общем месте, чтобы два эндпоинта не разъезжались.
          const parsed = parseUploadedExcel(file.path);
          parseResult = parsed.parseResult;
          rawDataB = parsed.rawDataStr;
          mappingFromTemplate = parsed.mappingFromTemplate;
          parserConfig = parsed.parserConfig;
          if (parseResult.items.length === 0) {
            fs.unlink(file.path, () => {});
            results.push({ fileName, section: null, imported: 0, status: 'parse_error', error: 'Не удалось извлечь данные' });
            continue;
          }
        }

        // Detect section: filename first, then items (для пустого PDF — только имя файла)
        let section = detectSectionFromFilename(fileName);
        if (!section && parseResult.items.length > 0) {
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

        // Insert specification + items
        const result = db.transaction(() => {
          const specResult = db.prepare(
            'INSERT INTO specifications (project_id, section, file_name, raw_data, parse_source) VALUES (?, ?, ?, ?, ?)'
          ).run(projectId, section, fileName, rawDataB, parseSource);
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
          // Зеркало одиночной загрузки: разметка запоминается за новой спецификацией.
          if (parserConfig) saveParserConfig(db, specificationId, parserConfig);
          return count;
        })();

        fs.unlink(file.path, () => {});
        results.push({
          fileName,
          section,
          imported: result,
          status: 'ok',
          error: parseResult.category === 'C' ? parseResult.categoryReason ?? undefined : undefined,
          mappingFromTemplate,
        });
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
      // Подпись шапки пишем здесь же: только с ней разметку, заданную сейчас руками,
      // можно будет переиспользовать на следующем таком же файле.
      saveParserConfig(db, specId, {
        headerRow,
        columnMapping,
        mergeMultiline: mergeMultiline !== false,
        headerSignature: Array.isArray(rawRows[headerRow]) ? headerSignature(rawRows[headerRow]) : null,
      });
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
    const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE id = ?').get(specId) as { id: number; raw_data: string | null } | undefined;
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });
    const { headerRow, columnMapping, mergeMultiline } = req.body;
    // Подпись шапки — как в /reparse: без неё разметка останется одноразовой.
    saveParserConfig(db, specId, {
      headerRow,
      columnMapping,
      mergeMultiline: !!mergeMultiline,
      headerSignature: signatureOfSavedConfig(spec.raw_data, headerRow),
    });
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

// ---------------------------------------------------------------------------
// Helper: in-place clean-representation re-split (CASCADE-safe, idempotent)
//
// Applies the SAME production variant-marker subtraction the parser chokepoints
// apply on NEW uploads (variantMarkers.applyVariantMarkersToItems) to rows that
// were ALREADY stored before that subtraction existed — via UPDATE ... WHERE id=?
// only. There is NO DELETE/re-insert, so specification_items.id is stable and every
// dependent link survives: matched_items (FK ON DELETE CASCADE, schema.ts:107) and
// operator_feedback.spec_item_id (FK ON DELETE SET NULL, schema.ts:228). A re-upload
// or /reparse would instead delete+reinsert rows → new autoincrement ids → those
// links (including the operator complaints themselves) would cascade away.
// Idempotent: a second call finds the rows already clean, changes nothing, and
// writes no snapshot. General by spec id (no project hardcoded). Matcher untouched.
// ---------------------------------------------------------------------------

export interface ResplitCleanReport {
  specId: number;
  rowsScanned: number;
  itemsTouched: number;    // rows actually UPDATEd (clean key differed from stored)
  bareOrphanKept: number;  // rows with marker syntax but no clean head → original kept
  links: {
    matchedBefore: number; matchedAfter: number;
    confirmedBefore: number; confirmedAfter: number;
    feedbackBefore: number; feedbackAfter: number;
    orphansAfter: number;  // matched_items whose spec row vanished — must stay 0
  };
}

/** Count the FK links a re-upload/reparse would destroy, scoped to one spec. */
function specLinkCounts(
  specId: number,
  db: ReturnType<typeof getDatabase>,
): { matched: number; confirmed: number; feedback: number } {
  const one = (sql: string): number => (db.prepare(sql).get(specId) as { c: number }).c;
  return {
    matched: one(
      'SELECT COUNT(*) c FROM matched_items m JOIN specification_items s ON s.id = m.specification_item_id WHERE s.specification_id = ?',
    ),
    confirmed: one(
      'SELECT COUNT(*) c FROM matched_items m JOIN specification_items s ON s.id = m.specification_item_id WHERE s.specification_id = ? AND m.is_confirmed = 1',
    ),
    feedback: one(
      'SELECT COUNT(*) c FROM operator_feedback f JOIN specification_items s ON s.id = f.spec_item_id WHERE s.specification_id = ?',
    ),
  };
}

/**
 * Clean the stored {name, full_name, characteristics} of every row of a spec by
 * running the production variant-marker subtraction and writing back ONLY the rows
 * it changed, BY id, inside one transaction (snapshot first, for rollback).
 *
 * no_corrupt_through backstop: a pure UPDATE-by-id can never change a link count; if
 * one drifts (a row got deleted/cascaded), the transaction aborts (rolls back) and
 * the call throws, so corrupt state never commits.
 */
export function resplitCleanSpec(
  specId: number,
  db: ReturnType<typeof getDatabase>,
): ResplitCleanReport {
  const before = specLinkCounts(specId, db);

  const rows = db.prepare(
    'SELECT id, name, full_name, characteristics FROM specification_items WHERE specification_id = ?',
  ).all(specId) as Array<{ id: number; name: string; full_name: string | null; characteristics: string | null }>;

  // Remember the original text so we UPDATE only genuinely-changed rows.
  const original = rows.map(r => ({ name: r.name, full_name: r.full_name, characteristics: r.characteristics }));

  // The exact call the Excel/PDF parser chokepoints make (mutates rows in place).
  const summary = applyVariantMarkersToItems(rows);

  const changed = rows.filter((r, i) =>
    r.name !== original[i].name ||
    r.full_name !== original[i].full_name ||
    r.characteristics !== original[i].characteristics,
  );

  let after = before;
  if (changed.length > 0) {
    const upd = db.prepare(
      'UPDATE specification_items SET name = ?, full_name = ?, characteristics = ? WHERE id = ?',
    );
    db.transaction(() => {
      saveSpecSnapshot(specId, 'resplit_clean_repr', db);
      for (const r of changed) upd.run(r.name, r.full_name ?? null, r.characteristics ?? null, r.id);
      after = specLinkCounts(specId, db);
      if (
        after.matched !== before.matched ||
        after.confirmed !== before.confirmed ||
        after.feedback !== before.feedback
      ) {
        throw new Error(
          `resplit-clean link drift (aborting): before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
        );
      }
    })();
  }

  const orphansAfter = (db.prepare(
    'SELECT COUNT(*) c FROM matched_items m LEFT JOIN specification_items s ON s.id = m.specification_item_id WHERE s.id IS NULL',
  ).get() as { c: number }).c;

  return {
    specId,
    rowsScanned: rows.length,
    itemsTouched: changed.length,
    bareOrphanKept: summary.bareOrphanKept,
    links: {
      matchedBefore: before.matched, matchedAfter: after.matched,
      confirmedBefore: before.confirmed, confirmedAfter: after.confirmed,
      feedbackBefore: before.feedback, feedbackAfter: after.feedback,
      orphansAfter,
    },
  };
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

    const result = await enrichSpecItems(inputs, fieldsToUpdate as any, { specificationId: specId });

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

// POST /api/specifications/:id/resplit-clean
// Re-apply the production variant-marker subtraction to a spec's ALREADY-STORED
// rows IN PLACE (UPDATE by id; CASCADE-safe; idempotent). Activates the clean
// representation on specs uploaded before the forward-fix WITHOUT re-upload/reparse,
// so confirmed matches, manual links and operator-feedback links are all preserved.
// General by spec id — no project hardcoded. A snapshot is saved first (rollback via
// GET /history + POST /rollback). The matcher is not invoked here.
router.post('/api/specifications/:id/resplit-clean', (req: Request, res: Response) => {
  try {
    const specId = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(specId)) return res.status(400).json({ error: 'Некорректный id спецификации' });
    const db = getDatabase();
    const spec = db.prepare('SELECT id FROM specifications WHERE id = ?').get(specId);
    if (!spec) return res.status(404).json({ error: 'Спецификация не найдена' });

    const report = resplitCleanSpec(specId, db);
    res.json(report);
  } catch (error) {
    console.error('POST /api/specifications/:id/resplit-clean error:', error);
    res.status(500).json({ error: 'Ошибка при чистке представления спецификации', details: error instanceof Error ? error.message : 'Unknown' });
  }
});

export default router;
