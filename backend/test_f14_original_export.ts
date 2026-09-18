/**
 * Ф14 — «Выгрузка в исходную спецификацию Арты». Критерии 1–3 плана (уточнение 18.09) на
 * копии базы, плюс проверка «старая выгрузка не изменилась» после выноса цены/поставщика/
 * источника/ссылки из export.ts в services/exportPricing.ts.
 * Запуск: cd backend && npx ts-node --transpile-only test_f14_original_export.ts [путь к базе]
 * База по умолчанию — ../database/budget_automation.db; тест работает на своей временной копии.
 *
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f12_site_variant.ts):
 *   1. лист «Форма» новой выгрузки содержит столько же строк, сколько raw_data спецификации;
 *      исходные ячейки (первые N колонок) не изменены ни в одной позиции; 4 наших колонки
 *      добавлены строго справа от исходных.
 *   2. число заполненных нами цен на листе «Форма» + число строк на листе «Не нашли строку»
 *      = число позиций с ценой в /api/projects/:id/export (той же спецификации).
 *   3. позиции без найденной строки не теряются — они и есть содержимое листа «Не нашли строку».
 *   0 (не в плане, но заявлено оркестратором отдельно): /api/projects/:id/export до и после
 *      выноса логики в exportPricing.ts даёт ОДИНАКОВЫЕ значения ячеек — чистый рефакторинг,
 *      не смена поведения. Старый export.ts берётся из git (b369075, прод-ветка до Ф14).
 *   4 (приёмка 18.09 — дефект \r\n → «_x000d_»): сравнение ячеек «Форма» ведём с raw_data,
 *      нормализованным \r\n/\r → \n (то же самое делает routes/exportOriginal.ts перед записью)
 *      — сравнение «сырое значение к сырому значению» (как было в первой версии теста) НЕ ловит
 *      дефект: xlsx.read() сам разворачивает `_x000D_` обратно в \r при чтении СВОИМ же ридером,
 *      так что счёт различий по значениям остаётся 0 даже при испорченном файле (LibreOffice
 *      этот токен не разворачивает и показывает его буквально — см. отчёт оркестратора).
 *      Отдельно, независимо от XLSX.read, проверяем СЫРОЙ XML внутри xlsx (через `cfb`, тот же
 *      пакет, что использует сам `xlsx` для распаковки) на отсутствие подстроки `_x000d_` —
 *      это и есть прямое доказательство дефекта/его отсутствия на уровне файла, а не значения.
 *   А (пять ходов 18.09, ход 3 — «цена в чужой строке»): если ≥2 позиции с ценой (осколки
 *      splitMonsterRow, excelParser.ts) метят ОДНУ строку raw_data (rowMatcher.ts делит её
 *      между ними намеренно), писать любую из цен в общую строку значит одну сохранить,
 *      другую молча стереть. Воспроизведено: спец. 31 (проект 15), строка 88, позиции
 *      7005/7006/7007 — двум из них даём синтетическую цену (вставкой счёта через
 *      invoices/invoice_items/matched_items), проверяем: строка формы без цены, ОБЕ позиции
 *      на листе «Не нашли строку».
 *   Б (тот же ход — «Источник» рядом со счётом/прайсом): пусто или «искали, не нашли» рядом
 *      с реальной ценой счёта — не годится. Проверяем по факту: позиция 6929 (проект 15,
 *      реальный счёт РОВЕН-Самара, без правок в БД) → «счёт»; позиция 7553 (проект 16) с
 *      выбранным вариантом прайса Русклимата (Ф13, тот же CSV и приём, что test_f13) → «прайс
 *      поставщика».
 */
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const SRC_DB = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const CSV_PATH = path.resolve(process.argv[3] || 'C:/Users/home/Downloads/rusklimat_prais_arta_2026-09-17.csv');
const tmpDb = path.join(os.tmpdir(), `f14_original_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const CFB = require('cfb');
const { getDatabase, closeDatabase } = require('./src/database/connection');
const exportRouter = require('./src/routes/export').default;
const matchingRouter = require('./src/routes/matching').default;
const priceListsRouter = require('./src/routes/priceLists').default;
const exportOriginalModule = require('./src/routes/exportOriginal');
const exportOriginalRouter = exportOriginalModule.default;
const normalizeCellNewlines = exportOriginalModule.normalizeCellNewlines as <T>(v: T) => T;
const { matchItemsToRawRows } = require('./src/services/rowMatcher');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`); }
}

function findHandler(router: any, routePath: string, method: string): any {
  for (const layer of router.stack) {
    const route = layer.route;
    if (route && route.path === routePath && route.methods?.[method]) return route.stack[route.stack.length - 1].handle;
  }
  throw new Error(`обработчик ${method} ${routePath} не найден`);
}

async function call(router: any, routePath: string, method: string, params: any, body: any = {}, query: any = {}, file: any = undefined): Promise<any> {
  const res: any = { statusCode: 200, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.send = (b: any) => { res.buffer = b; return res; };
  const req: any = { params, query, body };
  if (file) req.file = file;
  await findHandler(router, routePath, method)(req, res);
  if (res.statusCode !== 200) throw new Error(`${method} ${routePath} → ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res;
}

async function uploadSupplierPrice(projectId: number, supplier: string, csvPath: string): Promise<any> {
  const buffer = fs.readFileSync(csvPath);
  const res = await call(
    priceListsRouter, '/api/projects/:id/supplier-price', 'post',
    { id: String(projectId) }, { supplier }, {},
    { originalname: path.basename(csvPath), buffer },
  );
  return res.payload;
}

const db = getDatabase();

// project_id -> specification_id, по прод-копии 18.09 (Арта ОВ / Ласточка ВК / вентиляция)
const PROJECTS = [15, 16, 17];

function sheetAoa(buf: Buffer, sheetName: string): any[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`лист «${sheetName}» не найден (есть: ${wb.SheetNames.join(', ')})`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

/**
 * Ф14.1 — `!cols` читаем из ГОТОВОГО файла (res.buffer через XLSX.read), не из объекта
 * листа до записи: критерий требует ширину именно в выгруженном xlsx. `cellStyles: true`
 * обязателен — без него сам SheetJS не разбирает `<cols>` обратно в `ws['!cols']` при
 * чтении (проверено отдельно: XML внутри файла содержит ширины в любом случае, это
 * особенность парсера конкретно этой библиотеки на чтение, не дефект записи).
 */
function sheetCols(buf: Buffer, sheetName: string): Array<{ wch?: number }> {
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`лист «${sheetName}» не найден (есть: ${wb.SheetNames.join(', ')})`);
  return ws['!cols'] || [];
}

/**
 * Ищет подстроку `_x000d_` (без учёта регистра) в СЫРОМ XML внутри xlsx-архива — на уровне
 * файла, а не разобранного XLSX.read()-значения (тот разворачивает `_x000D_` обратно в \r,
 * маскируя дефект — см. заголовок файла). `cfb` — тот же пакет, которым `xlsx` сам
 * распаковывает zip/CFB-контейнер, отдельной зависимости не заводим.
 */
function findX000dInRawXml(buf: Buffer): string[] {
  const cfb = CFB.read(buf, { type: 'buffer' });
  const hits: string[] = [];
  cfb.FileIndex.forEach((entry: any, i: number) => {
    const name: string = cfb.FullPaths[i];
    if (!name.endsWith('.xml') || !entry.content) return;
    const text: string = Buffer.isBuffer(entry.content) ? entry.content.toString('utf8') : String(entry.content);
    if (text.toLowerCase().includes('_x000d_')) hits.push(name);
  });
  return hits;
}

/**
 * Старый export.ts (b369075, прод-ветка до Ф14) — временная копия только для сравнения
 * «значения ячеек не изменились» после рефакторинга. Кладётся В routes/, потому что там же
 * лежит оригинал (относительный импорт '../database' должен резолвиться туда же), и удаляется
 * в finally — в коммит не идёт.
 */
function loadBaselineExportRouter(): any {
  const baselinePath = path.join(__dirname, 'src', 'routes', '_f14_baseline_export.ts');
  const content = execFileSync('git', ['show', 'b369075:backend/src/routes/export.ts'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  fs.writeFileSync(baselinePath, content, 'utf8');
  delete require.cache[require.resolve('./src/routes/_f14_baseline_export')];
  return { router: require('./src/routes/_f14_baseline_export').default, filePath: baselinePath };
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}`);

  // === 0. старая выгрузка (/export) не изменилась после выноса логики в exportPricing.ts ===
  console.log('\n=== 0. /export до и после рефакторинга — те же значения ячеек ===');
  const baseline = loadBaselineExportRouter();
  try {
    for (const pid of PROJECTS) {
      const before = sheetAoa((await call(baseline.router, '/api/projects/:id/export', 'get', { id: String(pid) })).buffer, 'Спецификация');
      const after = sheetAoa((await call(exportRouter, '/api/projects/:id/export', 'get', { id: String(pid) })).buffer, 'Спецификация');
      // строка 1 — «Дата: …» дню съёмки, у обоих вызовов один и тот же процесс/день — сравнима как есть.
      check(`проект ${pid}: /export не изменился (${after.length} строк)`, JSON.stringify(before) === JSON.stringify(after));
    }
  } finally {
    fs.rmSync(baseline.filePath, { force: true });
  }

  // === 1–3. новая выгрузка «форма Арты с ценами» ===
  for (const pid of PROJECTS) {
    console.log(`\n=== проект ${pid} ===`);
    const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE project_id = ?').get(pid) as { id: number; raw_data: string };
    const rawRows: unknown[][] = JSON.parse(spec.raw_data);
    const width = rawRows.reduce((w, r) => Math.max(w, r.length), 0);

    const res = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', { id: String(pid) });
    const formRows = sheetAoa(res.buffer, 'Форма');
    const notFoundRows = sheetAoa(res.buffer, 'Не нашли строку');

    // критерий 1: строк столько же, исходные колонки не тронуты, 4 наших колонки справа
    check(`строк в «Форма» = raw_data (${formRows.length} = ${rawRows.length})`, formRows.length === rawRows.length,
      { formRows: formRows.length, rawRows: rawRows.length });

    // Эталон — raw_data с \r\n/\r → \n (то же самое делает exportOriginal.ts перед записью).
    // Сравниваем с ГОТОВЫМ ФАЙЛОМ (formRows читаны из res.buffer), не с значением до записи.
    let diffCount = 0;
    let firstDiff: unknown = null;
    for (let r = 0; r < rawRows.length; r++) {
      for (let c = 0; c < rawRows[r].length; c++) {
        const orig = normalizeCellNewlines(rawRows[r][c] ?? null);
        const got = formRows[r]?.[c] ?? null;
        // числа могут прийти из XLSX/JSON немного по-разному типизированными (число vs строка) —
        // сравниваем как строки, лишь бы ЗНАЧЕНИЕ (после нормализации переноса строки) не поменялось.
        if (String(orig) !== String(got)) {
          diffCount++;
          if (firstDiff === null) firstDiff = { r, c, orig, got };
        }
      }
    }
    check(`исходные ячейки не изменены ни в одной позиции (различий: ${diffCount})`, diffCount === 0, firstDiff);

    const x000dHits = findX000dInRawXml(res.buffer);
    check(`в сыром XML файла нет «_x000d_» (найдено файлов: ${x000dHits.length})`, x000dHits.length === 0, x000dHits);

    const headerRow = formRows[0] || [];
    check('4 наших колонки справа: заголовки',
      headerRow[width] === 'Цена, руб' && headerRow[width + 1] === 'Поставщик'
        && headerRow[width + 2] === 'Источник' && headerRow[width + 3] === 'Ссылка',
      headerRow.slice(width, width + 4));

    // Ф14.1 — ширина колонок: у обоих листов !cols на КАЖДУЮ колонку, ширины в [6, 60].
    const formCols = sheetCols(res.buffer, 'Форма');
    check(`«Форма»: !cols на все ${width + 4} колонки (есть: ${formCols.length})`, formCols.length === width + 4, formCols);
    check('«Форма»: все ширины в [6, 60]',
      formCols.every((c) => typeof c.wch === 'number' && c.wch >= 6 && c.wch <= 60), formCols);

    const notFoundCols = sheetCols(res.buffer, 'Не нашли строку');
    check(`«Не нашли строку»: !cols на все 4 колонки (есть: ${notFoundCols.length})`, notFoundCols.length === 4, notFoundCols);
    check('«Не нашли строку»: все ширины в [6, 60]',
      notFoundCols.every((c) => typeof c.wch === 'number' && c.wch >= 6 && c.wch <= 60), notFoundCols);

    if (pid === 16) {
      check('«Арта ОВ» (проект 16): колонка «"Наименование в спецификации"» (индекс 1) ≥ 40',
        (formCols[1]?.wch ?? 0) >= 40, formCols[1]);
    }

    // критерий 2/3: заполненные цены на «Форма» + строки на «Не нашли строку» = позиций с ценой в /export
    const exportBuf = (await call(exportRouter, '/api/projects/:id/export', 'get', { id: String(pid) })).buffer;
    const exportRows = sheetAoa(exportBuf, 'Спецификация');
    const exportHead = exportRows.findIndex((r) => Array.isArray(r) && r[0] === '№');
    const priceCol = exportRows[exportHead].indexOf('Цена');
    const pricedInExport = exportRows.slice(exportHead + 1)
      .filter((r) => Array.isArray(r) && typeof r[0] === 'number' && r[priceCol] != null).length;

    const filledInForm = formRows.slice(1).filter((r) => r[width] != null).length;
    const notFoundCount = Math.max(0, notFoundRows.length - 1); // минус собственная шапка листа

    check(`заполненных цен «Форма» (${filledInForm}) + «Не нашли строку» (${notFoundCount}) = позиций с ценой в /export (${pricedInExport})`,
      filledInForm + notFoundCount === pricedInExport,
      { filledInForm, notFoundCount, pricedInExport });

    console.log(`   найдено ${filledInForm}, не нашли ${notFoundCount}, позиций с ценой в /export ${pricedInExport}`);
  }

  // === А. цена в чужой строке — splitMonsterRow-осколки не делят одну строку молча ===
  console.log('\n=== А. цена в чужой строке (пять ходов 18.09, ход 3) ===');
  {
    const pid = 15;
    const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE project_id = ?').get(pid) as { id: number; raw_data: string };
    const rawRows: unknown[][] = JSON.parse(spec.raw_data);
    const width = rawRows.reduce((w, r) => Math.max(w, r.length), 0);
    const itemsAll = db.prepare('SELECT id, name FROM specification_items WHERE specification_id = ? ORDER BY id').all(spec.id) as Array<{ id: number; name: string }>;
    const { matched: matchedAll } = matchItemsToRawRows(rawRows, itemsAll);

    const byRow = new Map<number, number[]>();
    for (const it of itemsAll) {
      const r = matchedAll.get(it.id);
      if (r !== undefined) {
        if (!byRow.has(r)) byRow.set(r, []);
        byRow.get(r)!.push(it.id);
      }
    }
    const sharedEntry = [...byRow.entries()].find(([, ids]) => ids.length >= 2);
    if (!sharedEntry) {
      check('нашли общую строку (splitMonsterRow) для теста А — данные не изменились?', false);
    } else {
      const [sharedRow, sharedIds] = sharedEntry;
      const [idA, idB] = sharedIds;
      const nameA = itemsAll.find((i) => i.id === idA)!.name;
      const nameB = itemsAll.find((i) => i.id === idB)!.name;
      console.log(`   общая строка ${sharedRow} (спец. ${spec.id}, проект ${pid}), позиции ${idA} «${nameA}» / ${idB} «${nameB}»`);

      // Даём обеим позициям цену — вставкой синтетического счёта через существующие таблицы,
      // как удобнее (без API-раунд-трипа загрузки Excel).
      const invId = Number(db.prepare(
        'INSERT INTO invoices (project_id, invoice_number, file_name) VALUES (?, ?, ?)',
      ).run(pid, 'TEST-F14-A', 'test_f14_synthetic.xlsx').lastInsertRowid);
      const ii1 = Number(db.prepare(
        'INSERT INTO invoice_items (invoice_id, name, price, quantity) VALUES (?, ?, ?, ?)',
      ).run(invId, 'synthetic A', 1200, 1).lastInsertRowid);
      const ii2 = Number(db.prepare(
        'INSERT INTO invoice_items (invoice_id, name, price, quantity) VALUES (?, ?, ?, ?)',
      ).run(invId, 'synthetic B', 3400, 1).lastInsertRowid);
      db.prepare(
        `INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected, source)
         VALUES (?, ?, 1.0, 'test_synthetic', 1, 1, 'invoice')`,
      ).run(idA, ii1);
      db.prepare(
        `INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected, source)
         VALUES (?, ?, 1.0, 'test_synthetic', 1, 1, 'invoice')`,
      ).run(idB, ii2);

      const res = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', { id: String(pid) });
      const formRows = sheetAoa(res.buffer, 'Форма');
      const notFound = sheetAoa(res.buffer, 'Не нашли строку');

      check(`строка ${sharedRow} формы без цены (общая на ${sharedIds.length} позиции)`,
        formRows[sharedRow][width] == null, formRows[sharedRow]);

      const hasA = notFound.slice(1).some((r) => r[1] === nameA && Math.abs(Number(r[2]) - 1200) < 0.01);
      const hasB = notFound.slice(1).some((r) => r[1] === nameB && Math.abs(Number(r[2]) - 3400) < 0.01);
      check(`обе позиции (${idA} — 1200, ${idB} — 3400) на «Не нашли строку»`, hasA && hasB,
        { hasA, hasB, notFound: notFound.slice(1) });
    }
  }

  // === Б. «Источник» по факту для цены не из интернета: счёт / прайс поставщика / сайт ===
  console.log('\n=== Б. Источник рядом со счётом/прайсом (пять ходов 18.09, ход 3) ===');
  {
    // Б1: реальные данные, без изменений в БД — позиция 6929, счёт РОВЕН-Самара
    const pid = 15;
    const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE project_id = ?').get(pid) as { id: number; raw_data: string };
    const rawRows: unknown[][] = JSON.parse(spec.raw_data);
    const width = rawRows.reduce((w, r) => Math.max(w, r.length), 0);
    const items = db.prepare('SELECT id, name FROM specification_items WHERE specification_id = ? ORDER BY id').all(spec.id) as Array<{ id: number; name: string }>;
    const { matched } = matchItemsToRawRows(rawRows, items);

    const res15 = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', { id: String(pid) });
    const formRows15 = sheetAoa(res15.buffer, 'Форма');
    const row6929 = matched.get(6929);
    check('позиция 6929 (реальный счёт РОВЕН-Самара) → Источник = «счёт»',
      row6929 !== undefined && formRows15[row6929][width + 2] === 'счёт',
      row6929 !== undefined ? formRows15[row6929] : 'строка не найдена');

    // Б2: Ф13 — прайс поставщика файлом, выбранный вариант (проект 16, позиция 7553, тот же
    // CSV/приём, что test_f13_supplier_price.ts).
    await uploadSupplierPrice(16, 'Русклимат', CSV_PATH);
    const table16 = (await call(matchingRouter, '/api/projects/:id/matching', 'get', { id: '16' })).payload.items as any[];
    const row7553 = table16.find((r) => r.specItem.id === 7553);
    const rusklimat = (row7553?.siteVariants ?? []).find((v: any) => Math.abs((v.price ?? 0) - 128880.07) < 0.01);
    if (!rusklimat) {
      check('нашли вариант Русклимата для позиции 7553 — данные не изменились?', false, row7553);
    } else {
      await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(rusklimat.id) });

      const spec16 = db.prepare('SELECT id, raw_data FROM specifications WHERE project_id = 16').get() as { id: number; raw_data: string };
      const rawRows16: unknown[][] = JSON.parse(spec16.raw_data);
      const width16 = rawRows16.reduce((w, r) => Math.max(w, r.length), 0);
      const items16 = db.prepare('SELECT id, name FROM specification_items WHERE specification_id = ? ORDER BY id').all(spec16.id) as Array<{ id: number; name: string }>;
      const { matched: matched16 } = matchItemsToRawRows(rawRows16, items16);
      const row7553idx = matched16.get(7553);

      const res16 = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', { id: '16' });
      const formRows16 = sheetAoa(res16.buffer, 'Форма');
      check('позиция 7553 (выбран прайс Русклимата, Ф13) → Источник = «прайс поставщика»',
        row7553idx !== undefined && formRows16[row7553idx][width16 + 2] === 'прайс поставщика',
        row7553idx !== undefined ? formRows16[row7553idx] : 'строка не найдена');
    }
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
