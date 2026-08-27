/**
 * Ф3 плана «Арта, цены для Ивана»: запоминание ручной разметки колонок и её переиспользование
 * при следующей загрузке файла с ТАКОЙ ЖЕ шапкой.
 *
 * Запуск:  cd backend && npx ts-node --transpile-only test_spec_mapping_template.ts
 *
 * Проверяется РЕАЛЬНЫМИ обработчиками роутов (multer в обход — как в
 * test_bulk_spec_hardblock_integration.ts) на ДВУХ РЕАЛЬНЫХ файлах репозитория:
 *
 *   ../19_8-24-ОВ.xlsx                                        — файл Ивана (Арта), 259 позиций.
 *     Колонка 2 озаглавлена «Наименование в счете», а лежит в ней заводская марка
 *     (TDU.5R DN50-5 R-32-MVT25-APT25-MVT15). Признака кода в заголовке нет — автодетект
 *     не найдёт его никогда, сколько словарь ни расширяй.
 *
 *   experimental/test-invoices/готовый вариант 19_8-24-ОВ (1).xlsx — отрицательный случай.
 *     Тот же заказчик, тот же размер, 5 заголовков из 7 совпадают дословно, но колонка 2 —
 *     «Тип, марка, обозначение документа…». Если бы подбор шёл по частичному совпадению шапки,
 *     файл получил бы чужую разметку и 179 «артикулов» из чужой колонки. Проверка умеет краснеть:
 *     замерено — при ошибочном применении разметки Арты этот файл даёт ровно 179 product_code.
 *
 * Критерий готовности фазы (из плана):
 *   положительный — ≥179 позиций с product_code (сегодня без разметки 0);
 *   отрицательный — файл с другой шапкой разметку Арты НЕ получает, product_code = 0.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `spec_tpl_${process.pid}_${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.UPLOAD_PATH = path.join(os.tmpdir(), `spec_tpl_uploads_${process.pid}`);

/* eslint-disable @typescript-eslint/no-var-requires */
const { initializeDatabase, getDatabase, closeDatabase } = require('./src/database');
const specRouter = require('./src/routes/specifications').default;

const ARTA_FILE = path.join(__dirname, '..', '19_8-24-ОВ.xlsx');
const OTHER_HEADER_FILE = path.join(__dirname, 'experimental', 'test-invoices', 'готовый вариант 19_8-24-ОВ (1).xlsx');

/** Разметка, которую человек задал руками на проде (проект 16), — колонка 2 = product_code. */
const HAND_MAPPING = {
  position_number: 0, name: 1, characteristics: null, equipment_code: 3,
  article: null, product_code: 2, marking: null, type_size: null,
  manufacturer: 4, unit: 5, quantity: 6, price: null, amount: null,
};

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`); failures++; }
}

function findHandler(router: any, method: string, routePath: string): (req: any, res: any) => any {
  for (const layer of router.stack) {
    const route = layer.route;
    if (route && route.path === routePath && route.methods && route.methods[method]) {
      return route.stack[route.stack.length - 1].handle; // последний под-слой = обработчик (после multer)
    }
  }
  throw new Error(`handler ${method.toUpperCase()} ${routePath} не найден`);
}

function makeRes() {
  const res: any = { statusCode: 200, payload: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  return res;
}

const tmpFiles: string[] = [];
/** Копия файла: роут в конце удаляет загруженный файл (safeUnlink) — реальные фикстуры трогать нельзя. */
function tmpCopy(src: string, tag: string): string {
  const p = path.join(os.tmpdir(), `spec_tpl_${process.pid}_${tag}_${path.basename(src)}`);
  fs.copyFileSync(src, p);
  tmpFiles.push(p);
  return p;
}

/**
 * Маленький чужой бланк: шапка другая, но колонка 2 автодетектом НЕ занята и заполнена.
 * Генерим на лету через уже установленный xlsx (как tests/fixtures/spec-pdf/_gen.mjs),
 * чтобы не заводить в репозитории бинарник ради четырёх строк.
 */
function makeForeignSpec(): string {
  const XLSX = require('xlsx');
  const rows = [
    ['№ п/п', 'Наименование', 'Шифр по проекту', 'Ед. изм.', 'Кол-во'],
    ['1', 'Вентилятор канальный круглый', 'ШФ-001', 'шт.', 2],
    ['2', 'Решётка вентиляционная настенная', 'ШФ-002', 'шт.', 8],
    ['3', 'Клапан обратный круглый', 'ШФ-003', 'шт.', 3],
    ['4', 'Шумоглушитель трубчатый', 'ШФ-004', 'шт.', 1],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Спецификация');
  const p = path.join(os.tmpdir(), `spec_tpl_${process.pid}_foreign.xlsx`);
  XLSX.writeFile(wb, p);
  tmpFiles.push(p);
  return p;
}

function cleanup(): void {
  try { closeDatabase(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ }
  }
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(process.env.UPLOAD_PATH as string, { recursive: true, force: true }); } catch { /* ignore */ }
}

const uploadHandler = findHandler(specRouter, 'post', '/api/projects/:id/specifications');
const reparseHandler = findHandler(specRouter, 'post', '/api/specifications/:id/reparse');
const bulkHandler = findHandler(specRouter, 'post', '/api/projects/:id/specifications/bulk');
const rawDataHandler = findHandler(specRouter, 'get', '/api/specifications/:id/raw-data');

async function upload(projectId: number, filePath: string, originalname: string, section: string) {
  const res = makeRes();
  await uploadHandler(
    { params: { id: String(projectId) }, body: { section }, file: { path: filePath, originalname } },
    res,
  );
  return res;
}

function newProject(name: string): number {
  return Number(getDatabase().prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid);
}

function specStats(specificationId: number) {
  const db = getDatabase();
  const r = db.prepare(`
    SELECT COUNT(*) AS items,
           SUM(CASE WHEN product_code IS NOT NULL AND TRIM(product_code) <> '' THEN 1 ELSE 0 END) AS withCode,
           SUM(CASE WHEN quantity IS NOT NULL THEN 1 ELSE 0 END) AS withQty,
           SUM(CASE WHEN manufacturer IS NOT NULL AND TRIM(manufacturer) <> '' THEN 1 ELSE 0 END) AS withMfr
    FROM specification_items WHERE specification_id = ?
  `).get(specificationId) as { items: number; withCode: number; withQty: number; withMfr: number };
  return r;
}

async function main(): Promise<void> {
  initializeDatabase();
  const db = getDatabase();

  // ── 0. Сегодняшнее поведение: разметки нет, артикулы теряются ─────────────────────────
  console.log('\n0. Базовый замер — сохранённой разметки в базе ещё нет');
  const p0 = newProject('Арта — первая загрузка');
  const r0 = await upload(p0, tmpCopy(ARTA_FILE, 'base'), '19_8-24-ОВ.xlsx', 'Отопление');
  check('0a: загрузка прошла (201)', r0.statusCode === 201, `status=${r0.statusCode}, body=${JSON.stringify(r0.payload)}`);
  const spec0 = r0.payload.specificationId;
  const s0 = specStats(spec0);
  console.log(`      позиций: ${s0.items}, с артикулом: ${s0.withCode}, с количеством: ${s0.withQty}`);
  check('0b: 259 позиций', s0.items === 259, `got ${s0.items}`);
  check('0c: артикул не распознан ни у одной позиции (корень фазы)', s0.withCode === 0, `got ${s0.withCode}`);
  check('0d: разметка не из шаблона (шаблонов ещё нет)', r0.payload.mappingFromTemplate === null,
    JSON.stringify(r0.payload.mappingFromTemplate));

  // ── 1. Человек размечает колонки руками — конфиг и подпись шапки сохраняются ───────────
  console.log('\n1. Человек размечает колонку 2 как артикул (боевой /reparse)');
  const rRe = makeRes();
  await reparseHandler(
    { params: { id: String(spec0) }, body: { headerRow: 0, columnMapping: HAND_MAPPING, mergeMultiline: true } },
    rRe,
  );
  check('1a: пересборка прошла', rRe.statusCode === 200 && rRe.payload.imported > 0, JSON.stringify(rRe.payload));
  const cfg = db.prepare('SELECT * FROM specification_parser_configs WHERE specification_id = ?').get(spec0) as any;
  check('1b: конфиг сохранён', !!cfg);
  check('1c: подпись шапки записана', typeof cfg?.header_signature === 'string' && cfg.header_signature.length > 0,
    `header_signature=${cfg?.header_signature}`);
  const s0after = specStats(spec0);
  check('1d: после ручной разметки артикул у 179 позиций', s0after.withCode === 179, `got ${s0after.withCode}`);

  // ── 2. ПОЛОЖИТЕЛЬНЫЙ: тот же файл, новый проект, никакого ручного вмешательства ────────
  console.log('\n2. ПОЛОЖИТЕЛЬНЫЙ — тот же файл заново, без ручного вмешательства');
  const p1 = newProject('Арта — следующая загрузка');
  const r1 = await upload(p1, tmpCopy(ARTA_FILE, 'again'), '19_8-24-ОВ.xlsx', 'Отопление');
  check('2a: загрузка прошла (201)', r1.statusCode === 201, `status=${r1.statusCode}`);
  const s1 = specStats(r1.payload.specificationId);
  console.log(`      позиций: ${s1.items}, с артикулом: ${s1.withCode}  (критерий фазы: >= 179)`);
  check('2b: КРИТЕРИЙ ФАЗЫ — не меньше 179 позиций с артикулом', s1.withCode >= 179, `got ${s1.withCode}`);
  check('2c: ответ честно сообщает, что разметка из шаблона', !!r1.payload.mappingFromTemplate,
    JSON.stringify(r1.payload.mappingFromTemplate));
  // Имя сверяем с тем, что лежит в базе у спецификации-источника: fixFilename чинит
  // latin1-имя из multer, а тест зовёт обработчик напрямую, поэтому литерал тут не годится.
  const sourceName = (db.prepare('SELECT file_name FROM specifications WHERE id = ?').get(spec0) as any)?.file_name;
  check('2d: в ответе назван файл-источник разметки',
    !!r1.payload.mappingFromTemplate?.fileName && r1.payload.mappingFromTemplate.fileName === sourceName,
    JSON.stringify(r1.payload.mappingFromTemplate));
  check('2e: источник — та самая спецификация, которую размечали руками',
    r1.payload.mappingFromTemplate?.specificationId === spec0,
    JSON.stringify(r1.payload.mappingFromTemplate));

  // ── 3. Из шаблона взято ТОЛЬКО то, чего не нашёл автодетект ───────────────────────────
  console.log('\n3. Частичное применение: успешно определённые колонки не затёрты');
  check('3a: из шаблона взята ровно одна колонка — артикул',
    JSON.stringify(r1.payload.mappingFromTemplate?.filledColumns) === JSON.stringify(['product_code']),
    JSON.stringify(r1.payload.mappingFromTemplate?.filledColumns));
  check('3b: количество осталось на автодетекте (столько же, сколько без шаблона)',
    s1.withQty === s0.withQty && s1.withQty > 0, `template=${s1.withQty}, auto=${s0.withQty}`);
  check('3c: завод-изготовитель остался на автодетекте',
    s1.withMfr === s0.withMfr && s1.withMfr > 0, `template=${s1.withMfr}, auto=${s0.withMfr}`);
  check('3d: число позиций не изменилось', s1.items === s0.items, `template=${s1.items}, auto=${s0.items}`);

  // ── 3bis. Разметка запомнена ЗА НОВОЙ спецификацией ─────────────────────────
  console.log('\n3bis. Разметка сохранена за новой спецификацией (память размножается)');
  const spec1 = r1.payload.specificationId;
  const cfg1 = db.prepare('SELECT * FROM specification_parser_configs WHERE specification_id = ?').get(spec1) as any;
  check('3bis-a: у новой спецификации есть свой конфиг разметки', !!cfg1);
  check('3bis-b: подпись шапки у него заполнена',
    typeof cfg1?.header_signature === 'string' && cfg1.header_signature.length > 0,
    `header_signature=${cfg1?.header_signature}`);
  check('3bis-c: в конфиге сохранён артикул (колонка 2)',
    cfg1 && JSON.parse(cfg1.column_mapping).product_code === 2,
    cfg1?.column_mapping);

  // Сценарий «человек открыл редактор и нажал Пересобрать, ничего не меняя»: берём РОВНО то,
  // что отдаёт /raw-data, и шлём это в /reparse без правок (порядок полей — как в
  // frontend/src/pages/SpecificationEditor.tsx:68-83). Без записи конфига при загрузке экран
  // показывал бы автодетект, и эта же кнопка возвращала бы 179 -> 0.
  console.log('      сценарий «открыл редактор и нажал Пересобрать, ничего не меняя»');
  const rRaw = makeRes();
  await rawDataHandler({ params: { id: String(spec1) } }, rRaw);
  check('3bis-d: /raw-data отдал сохранённую разметку, а не автодетект', !!rRaw.payload?.config,
    `config=${JSON.stringify(rRaw.payload?.config)}, detected=${JSON.stringify(rRaw.payload?.detectedMapping)}`);
  const fromScreen = rRaw.payload?.config
    ? {
        headerRow: rRaw.payload.config.header_row,
        columnMapping: JSON.parse(rRaw.payload.config.column_mapping),
        mergeMultiline: rRaw.payload.config.merge_multiline !== 0,
      }
    : {
        headerRow: rRaw.payload.detectedMapping.headerRow,
        columnMapping: rRaw.payload.detectedMapping.columnMapping,
        mergeMultiline: true, // useState(true) в редакторе
      };
  const rRe2 = makeRes();
  await reparseHandler({ params: { id: String(spec1) }, body: fromScreen }, rRe2);
  const sAfterEditor = specStats(spec1);
  console.log(`      после «Пересобрать»: позиций ${sAfterEditor.items}, с артикулом ${sAfterEditor.withCode}`);
  check('3bis-e: «Пересобрать» тем, что показал экран, НЕ обнуляет артикулы',
    sAfterEditor.withCode >= 179,
    `got ${sAfterEditor.withCode} (0 = экран показал автодетект, разметка не сохранена при загрузке)`);

  // ── 4. ОТРИЦАТЕЛЬНЫЙ: другая шапка — чужую разметку не получает ───────────────────────
  console.log('\n4. ОТРИЦАТЕЛЬНЫЙ — файл с ДРУГОЙ шапкой');
  const p2 = newProject('Другая шапка');
  const r2 = await upload(p2, tmpCopy(OTHER_HEADER_FILE, 'other'), 'готовый вариант 19_8-24-ОВ (1).xlsx', 'Отопление');
  check('4a: загрузка прошла (201)', r2.statusCode === 201, `status=${r2.statusCode}`);
  const s2 = specStats(r2.payload.specificationId);
  console.log(`      позиций: ${s2.items}, с артикулом: ${s2.withCode}  (критерий: ровно 0)`);
  check('4b: КРИТЕРИЙ ФАЗЫ — чужая разметка не применилась, артикулов 0', s2.withCode === 0,
    `got ${s2.withCode} (если 179 — подбор пошёл по частичному совпадению шапки)`);
  check('4c: ответ не утверждает, что разметка из шаблона', r2.payload.mappingFromTemplate === null,
    JSON.stringify(r2.payload.mappingFromTemplate));

  // ── 4bis. ОТРИЦАТЕЛЬНЫЙ, изолирующий именно проверку шапки ───────────────────────────
  // У файла выше колонку 2 автодетект занял под «марку», и разметку Арты туда не пустил бы
  // и без сверки шапки — то есть тот случай проверяет не только сверку. Здесь колонка 2
  // автодетектом НЕ занята и заполнена: единственное, что стоит между этим файлом и чужим
  // артикулом, — полное несовпадение подписи шапки. Замерено: при отключённой сверке
  // (`if (!sig) continue`) этот случай краснеет — артикул появляется у всех 4 позиций.
  console.log('\n4bis. ОТРИЦАТЕЛЬНЫЙ — другая шапка, колонка 2 свободна');
  const p2b = newProject('Другая шапка, свободная колонка');
  const r2b = await upload(p2b, makeForeignSpec(), 'Чужой бланк.xlsx', 'Вентиляция');
  check('4bis-a: загрузка прошла (201)', r2b.statusCode === 201, `status=${r2b.statusCode}, body=${JSON.stringify(r2b.payload)}`);
  const s2b = specStats(r2b.payload.specificationId);
  console.log(`      позиций: ${s2b.items}, с артикулом: ${s2b.withCode}  (критерий: ровно 0)`);
  check('4bis-b: чужая разметка не применилась, артикулов 0', s2b.withCode === 0,
    `got ${s2b.withCode} (если > 0 — разметка Арты уехала в чужой файл)`);
  check('4bis-c: ответ не утверждает, что разметка из шаблона', r2b.payload.mappingFromTemplate === null,
    JSON.stringify(r2b.payload.mappingFromTemplate));

  // ── 5. Массовая загрузка ведёт себя так же, как одиночная ─────────────────────────────
  console.log('\n5. Массовая загрузка — то же поведение');
  const p3 = newProject('Арта — массовая загрузка');
  const rB = makeRes();
  await bulkHandler(
    { params: { id: String(p3) }, body: {}, files: [{ path: tmpCopy(ARTA_FILE, 'bulk'), originalname: 'Отопление 19_8-24-ОВ.xlsx' }] },
    rB,
  );
  const bulkRow = (rB.payload?.results || [])[0] || {};
  const bulkSpec = db.prepare('SELECT id FROM specifications WHERE project_id = ?').get(p3) as { id: number } | undefined;
  const s3 = bulkSpec ? specStats(bulkSpec.id) : { items: 0, withCode: 0, withQty: 0, withMfr: 0 };
  console.log(`      позиций: ${s3.items}, с артикулом: ${s3.withCode}`);
  check('5a: файл загружен', bulkRow.status === 'ok', `status=${bulkRow.status}, error=${bulkRow.error}`);
  check('5b: артикулов не меньше 179 (как в одиночной загрузке)', s3.withCode >= 179, `got ${s3.withCode}`);
  check('5c: bulk тоже сообщает про шаблон', !!bulkRow.mappingFromTemplate, JSON.stringify(bulkRow.mappingFromTemplate));

  // ── 6. Старые конфиги без подписи: досчёт при первом обращении ────────────────────────
  console.log('\n6. Конфиг, сохранённый до появления колонки header_signature');
  // Обнуляем подписи у ВСЕХ конфигов: иначе проверку вытянет любой другой конфиг с той же
  // шапкой, записанный при загрузках выше, и досчёт останется недоказанным.
  db.prepare('UPDATE specification_parser_configs SET header_signature = NULL').run();
  const p4 = newProject('Арта — конфиг без подписи');
  const r4 = await upload(p4, tmpCopy(ARTA_FILE, 'backfill'), '19_8-24-ОВ.xlsx', 'Отопление');
  const s4 = specStats(r4.payload.specificationId);
  check('6a: разметка применилась и без сохранённой подписи', s4.withCode >= 179, `got ${s4.withCode}`);
  const backfilled = (db.prepare(
    "SELECT COUNT(*) AS c FROM specification_parser_configs WHERE header_signature IS NOT NULL AND TRIM(header_signature) <> ''"
  ).get() as any).c;
  check('6b: подпись досчитана и записана в базу', backfilled > 0, `конфигов с подписью: ${backfilled}`);

  console.log('');
  console.log(`ИТОГ: положительный случай — ${s1.withCode} позиций с артикулом (было ${s0.withCode}); ` +
    `отрицательный — ${s2.withCode}.`);
  if (failures > 0) { console.error(`${failures} assertion(s) FAILED`); process.exitCode = 1; }
  else console.log('Все проверки пройдены');
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; }).finally(cleanup);
