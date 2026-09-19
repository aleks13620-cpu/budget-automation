/**
 * Ф10 — справочник поставщиков Арты (supplier_sites), контракт оркестратора.
 * Запуск: cd backend && npx ts-node --transpile-only test_f10_supplier_sites.ts
 * Своя изолированная временная база (как test_metrics_dashboard.ts) — таблица глобальная,
 * реальные проекты не нужны. initializeDatabase() дёргается НАСТОЯЩИЙ (init.ts), чтобы
 * проверить саму миграцию/сид, а не пересказ схемы в тесте.
 *
 * Критерии:
 *   1. сид 8 строк по имени; повторный initializeDatabase() не дублирует и не затирает
 *      правку (search_enabled/discount_pct), сделанную между вызовами.
 *   2. PUT discount_pct 38→40 и обратно.
 *   3. 400: скидка 95; скидка у price_source='api'; пустое имя при создании; дубль имени.
 *   4. POST новой строки — sort_order = max+1, source_key = NULL.
 *   5. POST /api/price-search/jobs/next отдаёт sites (все, включая выключенные) с новой
 *      строкой и search_enabled=0 у выключенной.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `f10_supplier_sites_${process.pid}_${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDatabase, closeDatabase } = require('./src/database/connection');
const { initializeDatabase } = require('./src/database/init');
const supplierSitesRouter = require('./src/routes/supplierSites').default;
const priceSearchRouter = require('./src/routes/priceSearch').default;

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
  const res: any = {};
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; if (res.statusCode === undefined) res.statusCode = 200; return res; };
  const req: any = { params, query: {}, body };
  await findHandler(router, routePath, method)(req, res);
  return res;
}

async function main(): Promise<void> {
  console.log(`временная база ${tmpDb}`);

  // initializeDatabase() закрывает соединение (closeDatabase в finally) — ок, следующий
  // getDatabase() откроет заново на тот же файл (DATABASE_PATH не менялся).
  initializeDatabase();

  console.log('\n=== 1. сид 8 строк по имени ===');
  let db = getDatabase();
  const seeded = db.prepare('SELECT name, sort_order, price_source, discount_pct FROM supplier_sites ORDER BY sort_order').all() as any[];
  check(`8 строк (факт ${seeded.length})`, seeded.length === 8, seeded);
  check('Русклимат первым, price_source=api', seeded[0]?.name === 'Русклимат' && seeded[0]?.price_source === 'api');
  check('Неватом sort=4, discount_pct=38', seeded[3]?.name === 'Неватом' && seeded[3]?.discount_pct === 38, seeded[3]);
  const nevatomId = (db.prepare('SELECT id FROM supplier_sites WHERE name = ?').get('Неватом') as any).id;

  console.log('\n=== правка Ивана переживает повторный init ===');
  db.prepare('UPDATE supplier_sites SET search_enabled = 0, discount_pct = 45 WHERE id = ?').run(nevatomId);
  closeDatabase();
  initializeDatabase();
  db = getDatabase();
  const afterReinit = db.prepare('SELECT COUNT(*) c FROM supplier_sites').get() as any;
  check(`повторный init не дублирует (факт ${afterReinit.c})`, afterReinit.c === 8);
  const nevatomAfter = db.prepare('SELECT search_enabled, discount_pct FROM supplier_sites WHERE id = ?').get(nevatomId) as any;
  check('повторный init не затирает правку Ивана (search_enabled=0, discount_pct=45)',
    nevatomAfter.search_enabled === 0 && nevatomAfter.discount_pct === 45, nevatomAfter);

  console.log('\n=== 2. PUT скидка 0→40 и обратно (Сантехкомплект — подключён, open_price) ===');
  const santehId0 = (db.prepare('SELECT id FROM supplier_sites WHERE name = ?').get('Сантехкомплект') as any).id;
  const put40 = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(santehId0) }, { discount_pct: 40 });
  check(`200, discount_pct=40 (факт ${put40.statusCode} ${put40.payload?.discount_pct})`,
    put40.statusCode === 200 && put40.payload.discount_pct === 40, put40.payload);
  const putBack = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(santehId0) }, { discount_pct: 0 });
  check(`обратно 0 (факт ${putBack.payload?.discount_pct})`, putBack.payload.discount_pct === 0);

  console.log('\n=== 3. 400-е ===');
  const bad95 = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(nevatomId) }, { discount_pct: 95 });
  check(`скидка 95 -> 400 (факт ${bad95.statusCode})`, bad95.statusCode === 400, bad95.payload);

  const rusklimatId = (db.prepare('SELECT id FROM supplier_sites WHERE name = ?').get('Русклимат') as any).id;
  const badApiDiscount = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(rusklimatId) }, { discount_pct: 10 });
  check(`скидка у api -> 400 (факт ${badApiDiscount.statusCode})`, badApiDiscount.statusCode === 400, badApiDiscount.payload);

  const badEmptyName = await call(supplierSitesRouter, '/api/supplier-sites', 'post', {}, { name: '  ', price_source: 'search' });
  check(`пустое имя -> 400 (факт ${badEmptyName.statusCode})`, badEmptyName.statusCode === 400, badEmptyName.payload);

  const badDupName = await call(supplierSitesRouter, '/api/supplier-sites', 'post', {}, { name: 'Русклимат', price_source: 'search' });
  check(`дубль имени -> 400 (факт ${badDupName.statusCode})`, badDupName.statusCode === 400, badDupName.payload);

  const badUnknownId = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: '999999' }, { discount_pct: 10 });
  check(`чужой id -> 404 (факт ${badUnknownId.statusCode})`, badUnknownId.statusCode === 404, badUnknownId.payload);

  console.log('\n=== 3б. правила «источник подключён / не подключён» (приёмка оркестратора) ===');
  const badPostOpenPrice = await call(supplierSitesRouter, '/api/supplier-sites', 'post', {}, { name: 'Пробный', price_source: 'open_price' });
  check(`POST price_source=open_price -> 400 (факт ${badPostOpenPrice.statusCode})`, badPostOpenPrice.statusCode === 400, badPostOpenPrice.payload);

  const santehId = (db.prepare('SELECT id FROM supplier_sites WHERE name = ?').get('Сантехкомплект') as any).id;
  const badPutConnected = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(santehId) }, { price_source: 'search' });
  check(`PUT price_source у Сантехкомплекта (source_key задан) -> 400 (факт ${badPutConnected.statusCode})`,
    badPutConnected.statusCode === 400, badPutConnected.payload);

  const etmId = (db.prepare('SELECT id FROM supplier_sites WHERE name = ?').get('ЭТМ') as any).id;

  // Ф21.2: скидка Арты разрешена у любого price_source кроме api — ЭТМ (price_source=search,
  // source_key=NULL) не исключение, source_key на правило больше не влияет. Проверяем ДО
  // смены price_source ниже, пока ЭТМ ещё реально 'search'.
  const discountEtm = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(etmId) }, { discount_pct: 15 });
  check(`скидка 15% у ЭТМ (search, не подключён) -> 200 и сохранилась (факт ${discountEtm.statusCode} ${discountEtm.payload?.discount_pct})`,
    discountEtm.statusCode === 200 && discountEtm.payload.discount_pct === 15, discountEtm.payload);
  const etmReloaded = db.prepare('SELECT discount_pct FROM supplier_sites WHERE id = ?').get(etmId) as any;
  check(`скидка ЭТМ сохранилась в базе (факт ${etmReloaded.discount_pct})`, etmReloaded.discount_pct === 15, etmReloaded);

  const okPutUnconnected = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(etmId) }, { price_source: 'price_file' });
  check(`PUT price_source у ЭТМ (source_key=NULL) -> price_file, 200 (факт ${okPutUnconnected.statusCode} ${okPutUnconnected.payload?.price_source})`,
    okPutUnconnected.statusCode === 200 && okPutUnconnected.payload.price_source === 'price_file', okPutUnconnected.payload);

  // Неватом запаркован (решение CEO 18.09): source_key=NULL, но price_source=site_discount —
  // не api, поэтому скидка по новому правилу разрешена (в поиск сайт всё равно не включён).
  const discountNevatom = await call(supplierSitesRouter, '/api/supplier-sites/:id', 'put', { id: String(nevatomId) }, { discount_pct: 40 });
  check(`скидка у Неватома (не подключён, не api) -> 200 (факт ${discountNevatom.statusCode})`,
    discountNevatom.statusCode === 200, discountNevatom.payload);

  console.log('\n=== 4. POST новой строки ===');
  const created = await call(supplierSitesRouter, '/api/supplier-sites', 'post', {}, { name: 'Новый поставщик', domain: 'new.ru', price_source: 'search' });
  check(`201, sort_order=9, source_key=null (факт ${created.statusCode} ${created.payload?.sort_order} ${created.payload?.source_key})`,
    created.statusCode === 201 && created.payload.sort_order === 9 && created.payload.source_key === null, created.payload);

  console.log('\n=== 5. /api/price-search/jobs/next отдаёт sites ===');
  // выключим "Новый поставщик" перед проверкой search_enabled=0
  db.prepare('UPDATE supplier_sites SET search_enabled = 0 WHERE id = ?').run(created.payload.id);
  db.prepare(`INSERT INTO price_search_jobs (project_id, status, requested_at) VALUES (1, 'queued', datetime('now'))`).run();
  const next = await call(priceSearchRouter, '/api/price-search/jobs/next', 'post', {});
  const sites = next.payload?.sites as any[] | undefined;
  check(`sites присутствует и содержит 9 строк (факт ${sites?.length})`, Array.isArray(sites) && sites.length === 9, sites);
  const newSite = sites?.find(s => s.id === created.payload.id);
  check('выключенная строка видна с search_enabled=0 (воркер сам решает, не сервер)',
    !!newSite && newSite.search_enabled === 0, newSite);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
