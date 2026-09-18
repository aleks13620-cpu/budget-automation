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
 */
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const SRC_DB = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f14_original_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const CFB = require('cfb');
const { getDatabase, closeDatabase } = require('./src/database/connection');
const exportRouter = require('./src/routes/export').default;
const exportOriginalModule = require('./src/routes/exportOriginal');
const exportOriginalRouter = exportOriginalModule.default;
const normalizeCellNewlines = exportOriginalModule.normalizeCellNewlines as <T>(v: T) => T;

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

async function call(router: any, routePath: string, method: string, params: any, body: any = {}, query: any = {}): Promise<any> {
  const res: any = { statusCode: 200, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.send = (b: any) => { res.buffer = b; return res; };
  await findHandler(router, routePath, method)({ params, query, body } as any, res);
  if (res.statusCode !== 200) throw new Error(`${method} ${routePath} → ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res;
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

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  closeDatabase();
  fs.rmSync(tmpDb, { force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
