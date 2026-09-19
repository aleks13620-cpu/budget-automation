/**
 * Ф13 — прайс поставщика файлом. Критерии 2, 4, 5 плана, на копии базы.
 * Запуск: cd backend && npx ts-node --transpile-only test_f13_supplier_price.ts <csv> [путь к базе]
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f12_site_variant.ts) на своей временной копии базы.
 *
 *   2. проект 16 «Арта ОВ»: вариант «Русклимат» у 23 позиций (Ф13.1: 4 неоднозначных
 *      исполнения — BVR/MVT/ЗДМ с несколькими кодами кандидатов — не ставятся) — spec_id и цена
 *      совпадают с python-прототипом scripts/f13_seriya_dn.py (сверено отдельно, см. отчёт);
 *   3. проект 17 «Ласточка ВК»: 0 вариантов, без ошибки;
 *   4. позиция с ценой сайта и ценой Русклимата показывает ОБА варианта; выбор Русклимата →
 *      выгрузка ставит его цену и поставщика; выбор обратно сайта — цену сайта;
 *   6. подпись слоя 1 (web_search) на проектах 15/16/17 не меняется от загрузки прайса;
 *   5. повторная загрузка того же файла не плодит дублей в external_prices.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const CSV_PATH = path.resolve(process.argv[2]);
const SRC_DB = path.resolve(process.argv[3] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f13_supplier_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const { getDatabase, closeDatabase } = require('./src/database/connection');
require('./src/database/init').initializeDatabase(); // как сервер при старте: миграции (Ф21 — price_option_skip)
const priceSearchRouter = require('./src/routes/priceSearch').default;
const matchingRouter = require('./src/routes/matching').default;
const priceListsRouter = require('./src/routes/priceLists').default;
const exportRouter = require('./src/routes/export').default;

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
const label = async (pid: number) => (await call(priceSearchRouter, '/api/projects/:id/spec-groups', 'get', { id: String(pid) })).payload.layer1.withPrice;
const table = async (pid: number) => (await call(matchingRouter, '/api/projects/:id/matching', 'get', { id: String(pid) })).payload.items as any[];
const supplierCount = (pid: number) => (db.prepare(
  `SELECT COUNT(*) c FROM external_prices WHERE project_id = ? AND source = 'supplier_price'`).get(pid) as any).c;

async function exportRow(projectId: number, specItemId: number): Promise<{ price: any; supplier: any }> {
  const res = await call(exportRouter, '/api/projects/:id/export', 'get', { id: String(projectId) });
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const head = rows.findIndex(r => Array.isArray(r) && r[0] === '№');
  const bySection = new Map<string, number[]>();
  for (const r of db.prepare(`SELECT id, section FROM specification_items WHERE project_id = ? ORDER BY section, id`).all(projectId) as any[]) {
    const k = r.section || 'Без раздела';
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k)!.push(r.id);
  }
  const seq = [...bySection.values()].flat();
  const n = seq.indexOf(specItemId) + 1;
  const row = rows.slice(head + 1).find(r => Array.isArray(r) && r[0] === n)!;
  return { price: row[rows[head].indexOf('Цена')], supplier: row[rows[head].indexOf('Поставщик')] };
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}, прайс ${path.basename(CSV_PATH)}`);

  console.log('\n=== 6. подпись слоя 1 (web_search) ДО загрузки прайса ===');
  const before15 = await label(15);
  const before16 = await label(16);
  const before17 = await label(17);
  console.log(`  15=${before15} 16=${before16} 17=${before17}`);

  console.log('\n=== 2. проект 16 «Арта ОВ»: прайс Русклимата → 23 варианта (Ф13.1: 4 неоднозначных пропущены) ===');
  const up16 = await uploadSupplierPrice(16, 'Русклимат', CSV_PATH);
  check(`ответ: found=${up16.found}, withBrand=${up16.withBrand}`, up16.found === 23, up16);
  check('сообщение сформировано по образцу «Поставщик: цена найдена у N позиций из M»',
    up16.message === `Русклимат: цена найдена у ${up16.found} позиций из ${up16.withBrand} с маркой поставщика`);
  const variants16 = supplierCount(16);
  check(`в external_prices вариантов supplier_price = 23 (факт ${variants16})`, variants16 === 23);
  const rows16 = db.prepare(
    `SELECT COUNT(*) c FROM matched_items m JOIN specification_items si ON si.id = m.specification_item_id
      WHERE si.project_id = 16 AND m.match_type = 'supplier_price'`).get() as any;
  check(`в сопоставлении варианты supplier_price = 23 (факт ${rows16.c})`, rows16.c === 23);

  console.log('\n=== 3. проект 17 «Ласточка ВК»: 0 вариантов, без ошибки ===');
  const up17 = await uploadSupplierPrice(17, 'Русклимат', CSV_PATH);
  check(`0 найдено, без ошибки (found=${up17.found})`, up17.found === 0);
  check(`0 вариантов в external_prices (факт ${supplierCount(17)})`, supplierCount(17) === 0);

  console.log('\n=== 6. подпись слоя 1 (web_search) не изменилась ===');
  const after15 = await label(15);
  const after16 = await label(16);
  const after17 = await label(17);
  check(`15: ${before15} → ${after15}`, after15 === before15);
  check(`16: ${before16} → ${after16}`, after16 === before16);
  check(`17: ${before17} → ${after17}`, after17 === before17);

  console.log('\n=== 4. позиция 7553 VFG-2R — оба варианта, выбор туда-обратно ===');
  const items16 = await table(16);
  const row7553 = items16.find(r => r.specItem.id === 7553);
  const variants = row7553?.siteVariants ?? [];
  const site = variants.find((v: any) => Math.abs((v.price ?? 0) - 93616.51) < 0.01);
  const rusklimat = variants.find((v: any) => Math.abs((v.price ?? 0) - 128880.07) < 0.01);
  check(`видны оба варианта (сайт 93616.51, Русклимат 128880.07), всего ${variants.length}`,
    !!site && !!rusklimat, variants);

  if (rusklimat) {
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(rusklimat.id) });
    const e1 = await exportRow(16, 7553);
    check(`выбрали Русклимат → выгрузка ${e1.price} ${e1.supplier}`,
      Math.abs(e1.price - 128880.07) < 0.01 && e1.supplier === 'Русклимат', e1);

    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(site.id) });
    const e2 = await exportRow(16, 7553);
    check(`обратно сайт → выгрузка ${e2.price} ${e2.supplier}`,
      Math.abs(e2.price - 93616.51) < 0.01 && e2.supplier !== 'Русклимат', e2);
  }

  console.log('\n=== 5. повторная загрузка того же файла не плодит дублей ===');
  const up16b = await uploadSupplierPrice(16, 'Русклимат', CSV_PATH);
  check(`второй приём: found=${up16b.found} (было 23)`, up16b.found === 23);
  check(`в external_prices всё ещё 23 строки supplier_price (факт ${supplierCount(16)})`, supplierCount(16) === 23);
  const rows16b = db.prepare(
    `SELECT COUNT(*) c FROM matched_items m JOIN specification_items si ON si.id = m.specification_item_id
      WHERE si.project_id = 16 AND m.match_type = 'supplier_price'`).get() as any;
  check(`в сопоставлении по-прежнему 23 варианта supplier_price (факт ${rows16b.c})`, rows16b.c === 23);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
