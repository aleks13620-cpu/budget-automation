/**
 * Ф13.1 — неоднозначное исполнение кандидата (BVR-R/-AR/-CR/-DR и т.п.) не должно превращаться
 * в вариант; повторная загрузка заменяет свой прошлый срез (кроме выбранного Иваном).
 * Запуск: cd backend && npx ts-node --transpile-only test_f13_1_ambiguous_exec.ts <csv> [путь к базе]
 *
 * Без правки Ф13.1 (findSupplierPrice отдаёт 'найдено' для любого числа кандидатов, самый
 * дешёвый ставится не глядя на исполнение) этот файл красный: BVR-AR/-FR/MVT-R/ЗДМ 04.16.100
 * получают статус 'найдено' вместо 'неоднозначное исполнение', и повторная загрузка не чистит
 * прошлый срез (нет функции замены среза).
 *
 *   1. project 16: 7401/7402/7404/7595 — статус 'неоднозначное исполнение' (>1 разного кода
 *      изделия среди кандидатов), 7406 — 'найдено' (обе строки MNF-R2 — одно исполнение);
 *   2. эти же 4 позиции не попадают в external_prices/сопоставление после загрузки;
 *   3. повторная загрузка поверх среза, оставленного «старым» поведением (одна из 4 позиций
 *      выбрана Иваном) — старые невыбранные удаляются, выбранная остаётся;
 *   4. проект 17 «Ласточка ВК» — 0 вариантов, без ошибки (регресс).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const CSV_PATH = path.resolve(process.argv[2]);
const SRC_DB = path.resolve(process.argv[3] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f13_1_ambiguous_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDatabase, closeDatabase } = require('./src/database/connection');
require('./src/database/init').initializeDatabase(); // как сервер при старте: миграции (Ф21 — price_option_skip)
const { parseCsvPriceFile, findSupplierPrice, matchSupplierPriceToProject } = require('./src/services/supplierPriceMatch');
const { syncSiteVariants } = require('./src/routes/priceSearch');
const priceListsRouter = require('./src/routes/priceLists').default;

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
const supplierCount = (pid: number) => (db.prepare(
  `SELECT COUNT(*) c FROM external_prices WHERE project_id = ? AND source = 'supplier_price'`).get(pid) as any).c;
const hasExternalPrice = (pid: number, specId: number) => !!db.prepare(
  `SELECT 1 FROM external_prices WHERE project_id = ? AND source = 'supplier_price' AND spec_item_id = ?`,
).get(pid, specId);

// Вставляет строку external_prices «как будто написал старый код» (без учёта исполнения) под
// вчерашней датой, затем прогоняет её через настоящий syncSiteVariants (Ф12) — так же, как
// делает боевой путь после matchSupplierPriceToProject.
function seedOldRow(projectId: number, specId: number, article: string, name: string, price: number): void {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO external_prices
      (business_key, project_id, spec_item_id, query_name, source, source_url, snapshot_date,
       supplier_name, article, name, price, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, '', 'supplier_price', '', ?, 'Русклимат', ?, ?, ?, 'RUB', 'found', datetime('now'), datetime('now'))
  `).run(`supplier_price|${specId}|${yesterday}`, projectId, specId, yesterday, article, name, price);
  syncSiteVariants(db, projectId);
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}, прайс ${path.basename(CSV_PATH)}`);
  const priceIndex = parseCsvPriceFile(fs.readFileSync(CSV_PATH));
  const specs = db.prepare(
    'SELECT id, name, manufacturer, product_code FROM specification_items WHERE project_id = 16',
  ).all() as any[];
  const specById = new Map(specs.map(s => [s.id, s]));

  console.log('\n=== 1. статус find() на спорных и неспорных позициях ===');
  for (const specId of [7401, 7402, 7404, 7595]) {
    const { status, candidates } = findSupplierPrice(specById.get(specId), priceIndex);
    check(`spec ${specId}: статус 'неоднозначное исполнение' (факт «${status}», кандидатов ${candidates.length})`,
      status === 'неоднозначное исполнение');
  }
  {
    const { status, candidates } = findSupplierPrice(specById.get(7406), priceIndex);
    check(`spec 7406 (MNF-R2 в двух строках — одно исполнение): статус 'найдено' (факт «${status}», кандидатов ${candidates.length})`,
      status === 'найдено' && candidates.length === 2);
  }

  console.log('\n=== 2. загрузка: 4 спорные позиции не попадают в сопоставление ===');
  const up = await uploadSupplierPrice(16, 'Русклимат', CSV_PATH);
  check(`found=23 (факт ${up.found})`, up.found === 23, up);
  check(`external_prices supplier_price = 23 (факт ${supplierCount(16)})`, supplierCount(16) === 23);
  for (const specId of [7401, 7402, 7404, 7595]) {
    check(`spec ${specId}: варианта нет`, !hasExternalPrice(16, specId));
  }

  console.log('\n=== 3. повторная загрузка поверх «старого» среза: невыбранные чистятся, выбранная остаётся ===');
  seedOldRow(16, 7402, '065B8305RG', 'Кран шаровой латунный РИДАН BVR-FR DN25 PN40 с накидной гайкой', 3095.58);
  seedOldRow(16, 7404, '003Z4041R', 'Клапан балансировочный РИДАН MVT-R DN15 ручной, с дренажем', 9355.21);
  check('7402 и 7404 временно есть в срезе (симуляция старого кода)',
    hasExternalPrice(16, 7402) && hasExternalPrice(16, 7404));
  const pli7402 = db.prepare(`
    SELECT m.id AS mid FROM external_prices ep
    JOIN price_list_items pli ON pli.row_index = ep.id
    JOIN matched_items m ON m.price_list_item_id = pli.id
    WHERE ep.project_id = 16 AND ep.spec_item_id = 7404
  `).get() as any;
  db.prepare('UPDATE matched_items SET is_selected = 1 WHERE id = ?').run(pli7402.mid);

  const up2 = await uploadSupplierPrice(16, 'Русклимат', CSV_PATH);
  check(`found=23 (факт ${up2.found})`, up2.found === 23, up2);
  check('7402 (не выбран) удалён из среза', !hasExternalPrice(16, 7402));
  check('7404 (выбран Иваном) остался в срезе', hasExternalPrice(16, 7404));
  check(`external_prices supplier_price = 24: 23 новых + 1 выбранный старый (факт ${supplierCount(16)})`,
    supplierCount(16) === 24);

  console.log('\n=== 4. проект 17 «Ласточка ВК»: 0 вариантов, без ошибки ===');
  const up17 = await uploadSupplierPrice(17, 'Русклимат', CSV_PATH);
  check(`0 найдено, без ошибки (found=${up17.found})`, up17.found === 0);
  check(`0 вариантов в external_prices (факт ${supplierCount(17)})`, supplierCount(17) === 0);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
