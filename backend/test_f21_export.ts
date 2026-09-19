/**
 * Ф21.4 — «Выгрузки = выбранное со скидкой». Экран Ивана («Цены по позициям», Ф21.1) уже
 * показывает цену со скидкой поставщика Арты (prelim_price); выгрузка (/export и
 * /export-original — обе строят строки через services/exportPricing.ts::computeExportRows,
 * Ф14) до этой правки отдавала сырую цену продавца — расхождение экрана и выгрузки.
 *
 * Запуск: cd backend && npx ts-node --transpile-only test_f21_export.ts [путь к БД]
 * База по умолчанию — .../scratchpad/prodcopy/f21.db (копия прод-БД снята для этой фазы);
 * тест работает на своей временной копии, исходный файл не трогает.
 *
 * Критерии (задание оркестратора):
 *   1. Без действий — /export и /export-original проектов 16 и 17 на копии f21.db побайтно
 *      равны эталону прода (baseline/export_{16,17}.xlsx, export_original_{16,17}.xlsx —
 *      сняты кодом прода caf51a8 на этой же БД).
 *   2. Скидка 15% у ЭТМ + явный выбор ЭТМ-варианта (через PUT price-options) у всех позиций
 *      проекта 16, где такой вариант есть (до 10) → цена в обеих выгрузках =
 *      round(base*0.85,2). Плюс: позиции, где автоподстановка САМА берёт ЭТМ-строку
 *      (минимальная web_search-цена — ЭТМ), тоже ×0.85 без явного выбора.
 *   3. Выбор варианта supplier_price «Русклимат» (price_source='api' в supplier_sites;
 *      скидка 15% выставлена в БД напрямую) → discount игнорируется, цена в обеих выгрузках
 *      без скидки.
 *   4. Позиция с автоподстановкой, помеченная price_option_skip («Не брать цену») → цены нет
 *      ни в /export, ни в /export-original.
 *   5. Красный прогон (ход разработки): временно убрать `discountPct > 0 ?
 *      computePrelimPrice(...) : row.price` в routes/priceOptions.ts::computeExportPrice на
 *      безусловный `row.price` — критерий 2 падает (цена ЭТМ-позиций остаётся сырой, не
 *      ×0.85). Не воспроизводится в этом файле автоматически (иначе тест не был бы зелёным
 *      сам по себе) — вывод прогона см. в отчёте.
 *
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f14_original_export.ts / test_f21_price_options.ts).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const SCRATCHPAD = 'C:/Users/home/AppData/Local/Temp/claude/C--Users-home-vscode101/'
  + '0c537832-7d65-4ef8-861f-8682e08cf2eb/scratchpad';
const SRC_DB = path.resolve(process.argv[2] || `${SCRATCHPAD}/prodcopy/f21.db`);
const BASELINE_DIR = path.resolve(process.argv[3] || `${SCRATCHPAD}/baseline`);
const tmpDb = path.join(os.tmpdir(), `f21_export_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const { getDatabase, closeDatabase } = require('./src/database/connection');
const { initializeDatabase } = require('./src/database/init'); // создаёt price_option_skip — на копии её ещё нет
initializeDatabase();
const exportRouter = require('./src/routes/export').default;
const exportOriginalRouter = require('./src/routes/exportOriginal').default;
const priceOptionsRouter = require('./src/routes/priceOptions').default;
const { UPSERT_EXTERNAL_PRICE, PRICE_FIELDS, toBindable, nowIso } = require('./src/routes/priceSearch');
const { matchItemsToRawRows } = require('./src/services/rowMatcher');
const { computeExportRows } = require('./src/services/exportPricing');

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

async function call(router: any, routePath: string, method: string, params: any, body: any = {}): Promise<any> {
  const res: any = { statusCode: 200, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.send = (b: any) => { res.buffer = b; return res; };
  const req: any = { params, query: {}, body };
  await findHandler(router, routePath, method)(req, res);
  if (res.statusCode !== 200) throw new Error(`${method} ${routePath} → ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res;
}

const db = getDatabase();

function insertExternalPrice(row: Record<string, unknown>): number {
  const now = nowIso();
  const params: Record<string, string | number | null> = {};
  for (const field of PRICE_FIELDS) params[field] = toBindable(row[field], now, field);
  db.prepare(UPSERT_EXTERNAL_PRICE).run(params);
  return (db.prepare('SELECT id FROM external_prices WHERE business_key = ?').get(row.business_key) as { id: number }).id;
}

// Позиция экрана может объединять несколько specification_items.id (дубли по содержимому,
// Ф21.1) — тогда PUT заводит представителю СВОЙ эквивалент строки (ensureMemberEquivalent) и
// selected_option_id в ответе — id ЭТОГО эквивалента, не переданного option_id. Правильность
// проверяем не по нему, а по факту (computeExportRows[specItemId] дальше в сценариях) — здесь
// только что PUT принят.
async function selectOption(projectId: number, specItemId: number, optionId: number): Promise<void> {
  const res = await call(
    priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
    { id: String(projectId), specItemId: String(specItemId) }, { option_id: optionId },
  );
  if (res.payload?.item?.selected_option_id == null) {
    throw new Error(`выбор варианта ${optionId} у позиции ${specItemId} не применился: ${JSON.stringify(res.payload)}`);
  }
}

async function skipPosition(projectId: number, specItemId: number): Promise<void> {
  const res = await call(
    priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
    { id: String(projectId), specItemId: String(specItemId) }, { skip: true },
  );
  if (res.payload?.item?.skipped !== true) {
    throw new Error(`skip позиции ${specItemId} не применился: ${JSON.stringify(res.payload)}`);
  }
}

function sheetAoa(buf: Buffer, sheetName: string): any[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`лист «${sheetName}» не найден (есть: ${wb.SheetNames.join(', ')})`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

// /export не хранит id позиции — сам лист строится ТЕМ ЖЕ порядком, что computeExportRows()
// (группировка по секциям, одна строка на позицию + строка секции + строка «Итого» + пустая —
// см. routes/export.ts), поэтому индекс строки для id считаем той же группировкой, а не
// поиском по имени (имена позиций повторяются, напр. «Радиатор панельный Compact»×N).
function buildExportRowOffsets(rows: Array<{ id: number; section: string | null }>): Map<number, number> {
  const sectionMap = new Map<string, typeof rows>();
  for (const row of rows) {
    const sec = row.section || 'Без раздела';
    if (!sectionMap.has(sec)) sectionMap.set(sec, []);
    sectionMap.get(sec)!.push(row);
  }
  const offsets = new Map<number, number>();
  let offset = 0;
  for (const [, items] of sectionMap) {
    offset += 1; // строка секции
    for (const item of items) { offsets.set(item.id, offset); offset += 1; }
    offset += 2; // «Итого …» + пустая строка
  }
  return offsets;
}

async function exportOriginalPriceByItemId(
  projectId: number, itemId: number,
): Promise<{ price: number | null; width: number; rowIdx: number | undefined }> {
  const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE project_id = ? AND raw_data IS NOT NULL').get(projectId) as { id: number; raw_data: string };
  const rawRows: unknown[][] = JSON.parse(spec.raw_data);
  const width = rawRows.reduce((w, r) => Math.max(w, (r as unknown[]).length), 0);
  const items = db.prepare('SELECT id, name FROM specification_items WHERE specification_id = ? ORDER BY id').all(spec.id) as Array<{ id: number; name: string }>;
  const { matched } = matchItemsToRawRows(rawRows, items);
  const rowIdx = matched.get(itemId);
  const res = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', { id: String(projectId) });
  const formRows = sheetAoa(res.buffer, 'Форма');
  const price = rowIdx !== undefined ? formRows[rowIdx][width] : null;
  return { price, width, rowIdx };
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}`);

  // === 1. без действий: /export и /export-original побайтно равны эталону прода ===
  console.log('\n=== 1. байт-в-байт с эталоном прода (caf51a8, та же БД) ===');
  for (const pid of [16, 17]) {
    const exp = await call(exportRouter, '/api/projects/:id/export', 'get', { id: String(pid) });
    const baseExp = fs.readFileSync(path.join(BASELINE_DIR, `export_${pid}.xlsx`));
    check(`export_${pid}.xlsx побайтно равен эталону (${exp.buffer.length} байт)`,
      Buffer.compare(exp.buffer, baseExp) === 0, { mine: exp.buffer.length, base: baseExp.length });

    const eo = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', { id: String(pid) });
    const baseEo = fs.readFileSync(path.join(BASELINE_DIR, `export_original_${pid}.xlsx`));
    check(`export_original_${pid}.xlsx побайтно равен эталону (${eo.buffer.length} байт)`,
      Buffer.compare(eo.buffer, baseEo) === 0, { mine: eo.buffer.length, base: baseEo.length });
  }

  // === 2. скидка 15% у ЭТМ: явный выбор (до 10 позиций) + автоподстановка своей ЭТМ-строкой ===
  console.log('\n=== 2. скидка 15% у ЭТМ — выбор и автоподстановка ===');
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE name = 'ЭТМ'`).run();

  // Позиции, где минимальная (автоподставляемая) web_search-цена последнего среза — уже ЭТМ:
  // на них НЕ жмём выбор — проверяем именно ветку автоподстановки.
  const autoEtm = db.prepare(`
    WITH ext_last AS (
      SELECT spec_item_id, project_id, MAX(snapshot_date) as last_date
      FROM external_prices WHERE source = 'web_search' GROUP BY spec_item_id, project_id
    ),
    ranked AS (
      SELECT ep.id, ep.spec_item_id, ep.price,
             ROW_NUMBER() OVER (PARTITION BY ep.spec_item_id ORDER BY ep.price ASC) as rn
      FROM external_prices ep
      JOIN ext_last el ON el.spec_item_id = ep.spec_item_id AND el.project_id IS ep.project_id AND ep.snapshot_date = el.last_date
      WHERE ep.status = 'found' AND ep.source = 'web_search' AND ep.project_id = 16
    )
    SELECT id, spec_item_id, price FROM ranked WHERE rn = 1 AND id IN (
      SELECT id FROM external_prices WHERE project_id = 16 AND source = 'web_search' AND source_url LIKE '%etm.ru%'
    )
  `).all() as Array<{ id: number; spec_item_id: number; price: number }>;
  check(`нашли позиции с автоподстановкой ЭТМ (${autoEtm.length})`, autoEtm.length > 0, autoEtm);
  const autoEtmIds = new Set(autoEtm.map((r) => r.spec_item_id));

  // Явный выбор ЭТМ-варианта — до 10 позиций проекта 16 с ЭТМ-предложением, КРОМЕ уже
  // автоподставляемых (их проверяем отдельно, без PUT — иначе ветки смешаются).
  const etmRows = db.prepare(`
    WITH ext_last AS (
      SELECT spec_item_id, project_id, MAX(snapshot_date) as last_date
      FROM external_prices WHERE source = 'web_search' GROUP BY spec_item_id, project_id
    )
    SELECT ep.id, ep.spec_item_id, ep.price FROM external_prices ep
    JOIN ext_last el ON el.spec_item_id = ep.spec_item_id AND el.project_id IS ep.project_id AND ep.snapshot_date = el.last_date
    WHERE ep.project_id = 16 AND ep.source = 'web_search' AND ep.status = 'found' AND ep.price IS NOT NULL
      AND ep.source_url LIKE '%etm.ru%'
  `).all() as Array<{ id: number; spec_item_id: number; price: number }>;
  const explicitEtm = etmRows.filter((r) => !autoEtmIds.has(r.spec_item_id)).slice(0, 10);
  check(`нашли позиции для явного выбора ЭТМ (${explicitEtm.length}, до 10)`, explicitEtm.length > 0, explicitEtm.length);

  for (const r of explicitEtm) await selectOption(16, r.spec_item_id, r.id);

  const etmCases = [
    ...explicitEtm.map((r) => ({ spec_item_id: r.spec_item_id, base: r.price, how: 'выбор' })),
    ...autoEtm.map((r) => ({ spec_item_id: r.spec_item_id, base: r.price, how: 'автоподстановка' })),
  ];
  console.log(`   проверяю ${etmCases.length} позиций (${explicitEtm.length} выбор + ${autoEtm.length} автоподстановка)`);

  // Порядок/группировка листа «Спецификация» зависят только от si.section/si.id (не от цены —
  // см. buildExportRowOffsets) — считаем офсеты один раз, переиспользуем во всех сценариях.
  const rows16 = computeExportRows(db, 16, 'best') as Array<{ id: number; price: number | null; name: string; quantity: number | null; section: string | null }>;
  const rowOffsets16 = buildExportRowOffsets(rows16);

  async function sheetPriceOf(specItemId: number): Promise<number | null> {
    const exp = await call(exportRouter, '/api/projects/:id/export', 'get', { id: '16' });
    const aoa = sheetAoa(exp.buffer, 'Спецификация');
    const head = aoa.findIndex((r) => Array.isArray(r) && r[0] === '№');
    const priceCol = aoa[head].indexOf('Цена');
    const rowIdx = head + 1 + rowOffsets16.get(specItemId)!;
    return aoa[rowIdx][priceCol];
  }

  for (const c of etmCases) {
    const expected = Math.round(c.base * 0.85 * 100) / 100;
    const row = computeExportRows(db, 16, 'best').find((r: { id: number }) => r.id === c.spec_item_id);
    check(`computeExportRows[${c.spec_item_id}] (${c.how}) цена = round(${c.base}*0.85,2) = ${expected} (факт ${row?.price})`,
      row?.price === expected, row);

    const sheetPrice = await sheetPriceOf(c.spec_item_id);
    check(`/export[${c.spec_item_id}] (${c.how}) на листе «Спецификация» = ${expected} (факт ${sheetPrice})`,
      sheetPrice === expected, sheetPrice);

    const orig = await exportOriginalPriceByItemId(16, c.spec_item_id);
    check(`/export-original[${c.spec_item_id}] (${c.how}) на листе «Форма» = ${expected} (факт ${orig.price})`,
      orig.price === expected, orig);
  }

  // === 3. supplier_price «Русклимат» (price_source='api') — скидка в БД игнорируется ===
  console.log('\n=== 3. Русклимат (price_source=api) — скидка игнорируется ===');
  const rusklimatSpecItemId = (db.prepare(`
    SELECT si.id FROM specification_items si
    WHERE si.project_id = 16 AND si.quantity IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM matched_items m WHERE m.specification_item_id = si.id AND m.is_selected = 1)
      AND NOT EXISTS (SELECT 1 FROM external_prices ep WHERE ep.spec_item_id = si.id)
    LIMIT 1
  `).get() as { id: number } | undefined)?.id;
  check('нашли свободную позицию проекта 16 под синтетику Русклимата', rusklimatSpecItemId != null, rusklimatSpecItemId);

  if (rusklimatSpecItemId != null) {
    const specRow = db.prepare('SELECT name FROM specification_items WHERE id = ?').get(rusklimatSpecItemId) as { name: string };
    const rusklimatPrice = 54321.5;
    const extId = insertExternalPrice({
      business_key: `f21_test_ruskl_${rusklimatSpecItemId}`, project_id: 16, spec_item_id: rusklimatSpecItemId,
      query_name: specRow.name, source: 'supplier_price', source_url: '',
      snapshot_date: new Date().toISOString().slice(0, 10), supplier_name: 'Русклимат',
      name: specRow.name, unit: 'шт', price: rusklimatPrice, currency: 'RUB', status: 'found',
    });
    // discount_pct=15 в БД напрямую поверх price_source='api' — должен быть проигнорирован
    // (findSite/computePrelimPrice: скидка = 0 всегда при price_source='api').
    db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE name = 'Русклимат'`).run();
    await selectOption(16, rusklimatSpecItemId, extId);

    const rows16b = computeExportRows(db, 16, 'best') as Array<{ id: number; price: number | null }>;
    const row = rows16b.find((r) => r.id === rusklimatSpecItemId);
    check(`computeExportRows[${rusklimatSpecItemId}] Русклимат без скидки = ${rusklimatPrice} (факт ${row?.price})`,
      row?.price === rusklimatPrice, row);

    const sheetPrice = await sheetPriceOf(rusklimatSpecItemId);
    check(`/export[${rusklimatSpecItemId}] Русклимат без скидки = ${rusklimatPrice} (факт ${sheetPrice})`,
      sheetPrice === rusklimatPrice, sheetPrice);

    const orig = await exportOriginalPriceByItemId(16, rusklimatSpecItemId);
    check(`/export-original[${rusklimatSpecItemId}] Русклимат без скидки = ${rusklimatPrice} (факт ${orig.price})`,
      orig.price === rusklimatPrice, orig);
  }

  // === 4. skip у позиции с автоподстановкой — цены нет ни в /export, ни в /export-original ===
  console.log('\n=== 4. skip у автоподстановки — цены нет ===');
  const rowsBeforeSkip = computeExportRows(db, 16, 'best') as Array<{ id: number; price: number | null; usedExternal: boolean }>;
  const skipCandidate = rowsBeforeSkip.find((r) => r.usedExternal && r.price != null && !autoEtmIds.has(r.id));
  check('нашли позицию с автоподстановкой для skip-теста', !!skipCandidate, skipCandidate);

  if (skipCandidate) {
    await skipPosition(16, skipCandidate.id);

    const rowsAfterSkip = computeExportRows(db, 16, 'best') as Array<{ id: number; price: number | null }>;
    const rowAfter = rowsAfterSkip.find((r) => r.id === skipCandidate.id);
    check(`computeExportRows[${skipCandidate.id}] после skip: цены нет (факт ${rowAfter?.price})`, rowAfter?.price == null, rowAfter);

    const sheetPrice = await sheetPriceOf(skipCandidate.id);
    check(`/export[${skipCandidate.id}] после skip: цены нет на листе «Спецификация» (факт ${sheetPrice})`,
      sheetPrice == null, sheetPrice);

    const orig = await exportOriginalPriceByItemId(16, skipCandidate.id);
    check(`/export-original[${skipCandidate.id}] после skip: цены нет (факт ${orig.price})`, orig.price == null, orig);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
