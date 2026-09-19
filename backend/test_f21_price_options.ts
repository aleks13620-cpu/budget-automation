/**
 * Ф21.1 — «API вариантов цены». Критерии плана, на копии базы.
 * Запуск: cd backend && npx ts-node --transpile-only test_f21_price_options.ts <путь к базе>
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f13_supplier_price.ts) на своей временной копии.
 *
 *   а. для проектов 16 и 17: число options по всем позициям = COUNT found-строк (price NOT NULL)
 *      последнего среза по каждому source — 100%;
 *   б. price_type верен для всех 4 source; is_own_supplier у rusklimat_api/santech_price/
 *      supplier_price('Русклимат') = true;
 *   в. скидка: discount_pct=15 у ЭТМ и Сантехкомплекта → prelim_price = round(base*0.85,2);
 *      Русклимат (price_source='api') игнорирует discount_pct в базе → 0;
 *   г. PUT option_id → selected_option_id, ровно один is_selected=1 у позиции, указывает на
 *      этот external_prices.id; PUT null → selected null, auto_option_id вернулся; PUT skip →
 *      skipped=true.
 *
 * Синтетика: по одной found-строке rusklimat_api и santech_price добавляется в проект 16 на
 * КАЖДУЮ позицию, у которой уже есть находка web_search (сегодняшний снимок) — форма ровно как
 * в плане Ф21.1 (source_key совпадает с source, supplier_name как у настоящих находок).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const SRC_DB = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f21_price_options_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDatabase, closeDatabase } = require('./src/database/connection');
const { initializeDatabase } = require('./src/database/init');
const priceOptionsRouter = require('./src/routes/priceOptions').default;
const { UPSERT_EXTERNAL_PRICE, PRICE_FIELDS, toBindable, nowIso } = require('./src/routes/priceSearch');

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
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  const req: any = { params, query: {}, body };
  await findHandler(router, routePath, method)(req, res);
  return res;
}

initializeDatabase(); // создаёт price_option_skip — на копии её ещё нет (миграция появилась в Ф21.1); закрывает и переоткрывает соединение
const db = getDatabase();

function insertExternalPrice(row: Record<string, unknown>): void {
  const now = nowIso();
  const params: Record<string, string | number | null> = {};
  for (const field of PRICE_FIELDS) params[field] = toBindable(row[field], now, field);
  db.prepare(UPSERT_EXTERNAL_PRICE).run(params);
}

async function getOptions(projectId: number): Promise<any> {
  const res = await call(priceOptionsRouter, '/api/projects/:id/price-options', 'get', { id: String(projectId) });
  if (res.statusCode !== 200) throw new Error(`GET price-options ${projectId} → ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res.payload;
}

// COUNT found-строк (price NOT NULL) последнего среза по каждому source — независимо от кода
// приложения, но по тому же определению «последний срез», что задаёт сам критерий.
function expectedOptionsCount(projectId: number): number {
  const { c } = db.prepare(`
    WITH ext_last AS (
      SELECT ep.spec_item_id, ep.source, MAX(ep.snapshot_date) AS last_date
      FROM external_prices ep
      JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
      WHERE ep.project_id = ?
      GROUP BY ep.spec_item_id, ep.source
    )
    SELECT COUNT(*) AS c
    FROM external_prices ep
    JOIN ext_last el ON el.spec_item_id = ep.spec_item_id AND el.source = ep.source AND ep.snapshot_date = el.last_date
    WHERE ep.project_id = ? AND ep.status = 'found' AND ep.price IS NOT NULL
  `).get(projectId, projectId) as { c: number };
  return c;
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}`);
  const today = new Date().toISOString().slice(0, 10);

  console.log('\n=== синтетика: rusklimat_api + santech_price на позиции проекта 16 с находкой web_search ===');
  const targets = db.prepare(`
    SELECT DISTINCT ep.spec_item_id AS spec_item_id, si.name AS name FROM external_prices ep
    JOIN specification_items si ON si.id = ep.spec_item_id
    WHERE ep.project_id = 16 AND ep.source = 'web_search' AND ep.status = 'found' AND ep.price IS NOT NULL
  `).all() as Array<{ spec_item_id: number; name: string }>;
  check(`есть позиции с web_search-находкой на проекте 16 (${targets.length})`, targets.length > 0);
  let seq = 0;
  for (const t of targets) {
    seq++;
    insertExternalPrice({
      business_key: `f21_test_rusklimat_${t.spec_item_id}`, project_id: 16, spec_item_id: t.spec_item_id,
      query_name: t.name, source: 'rusklimat_api', source_url: 'https://b2b.rusklimat.com/api',
      snapshot_date: today, supplier_name: 'Русклимат', name: t.name, unit: 'шт',
      price: 1000 + seq, currency: 'RUB', status: 'found',
    });
    insertExternalPrice({
      business_key: `f21_test_santech_${t.spec_item_id}`, project_id: 16, spec_item_id: t.spec_item_id,
      query_name: t.name, source: 'santech_price', source_url: 'https://santech.ru',
      snapshot_date: today, supplier_name: 'Сантехкомплект (базовый прайс)', name: t.name, unit: 'шт',
      price: 2000 + seq, currency: 'RUB', status: 'found',
    });
  }

  console.log('\n=== в. скидка: ЭТМ и Сантехкомплект 15%, Русклимат 15% в базе, но price_source=api ===');
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE domain = 'etm.ru'`).run();
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE source_key = 'santech_price'`).run();
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE source_key = 'rusklimat_api'`).run();

  console.log('\n=== а. 100% покрытие options на проектах 16 и 17 ===');
  const result16 = await getOptions(16);
  const result17 = await getOptions(17);
  const actual16 = result16.items.reduce((s: number, it: any) => s + it.options.length, 0);
  const actual17 = result17.items.reduce((s: number, it: any) => s + it.options.length, 0);
  const expected16 = expectedOptionsCount(16);
  const expected17 = expectedOptionsCount(17);
  check(`проект 16: options=${actual16}, ожидание=${expected16}`, actual16 === expected16);
  check(`проект 17: options=${actual17}, ожидание=${expected17}`, actual17 === expected17);

  console.log('\n=== б. price_type / is_own_supplier для 4 source ===');
  const allOptions16 = result16.items.flatMap((it: any) => it.options);
  const bySource = (src: string) => allOptions16.filter((o: any) => o.source === src);
  const expectType: Record<string, string> = {
    rusklimat_api: 'own', supplier_price: 'own', santech_price: 'base', web_search: 'public',
  };
  for (const src of ['rusklimat_api', 'supplier_price', 'santech_price', 'web_search']) {
    const opts = bySource(src);
    check(`есть варианты source=${src} (${opts.length})`, opts.length > 0);
    check(`price_type(${src}) = ${expectType[src]} у всех ${opts.length}`,
      opts.every((o: any) => o.price_type === expectType[src]));
  }
  check('is_own_supplier=true у всех rusklimat_api', bySource('rusklimat_api').every((o: any) => o.is_own_supplier === true));
  check('is_own_supplier=true у всех santech_price', bySource('santech_price').every((o: any) => o.is_own_supplier === true));
  const ruskSupplierPrice = bySource('supplier_price').filter((o: any) => o.supplier_label === 'Русклимат');
  check(`is_own_supplier=true у supplier_price('Русклимат') (${ruskSupplierPrice.length})`,
    ruskSupplierPrice.length > 0 && ruskSupplierPrice.every((o: any) => o.is_own_supplier === true));

  console.log('\n=== в. discount_pct / prelim_price ===');
  const etm = bySource('web_search').find((o: any) => o.domain === 'etm.ru');
  check('нашли вариант ЭТМ (web_search, domain=etm.ru)', !!etm, etm);
  if (etm) {
    check(`ЭТМ: discount_pct=15, prelim=round(base*0.85,2) (base=${etm.base_price}, prelim=${etm.prelim_price})`,
      etm.discount_pct === 15 && etm.prelim_price === Math.round(etm.base_price * 0.85 * 100) / 100);
  }
  const santech = bySource('santech_price')[0];
  check('нашли вариант Сантехкомплект (santech_price)', !!santech, santech);
  if (santech) {
    check(`Сантехкомплект: discount_pct=15, prelim=round(base*0.85,2) (base=${santech.base_price}, prelim=${santech.prelim_price})`,
      santech.discount_pct === 15 && santech.prelim_price === Math.round(santech.base_price * 0.85 * 100) / 100);
  }
  const ruskl = bySource('rusklimat_api')[0];
  check('нашли вариант Русклимат (rusklimat_api)', !!ruskl, ruskl);
  if (ruskl) {
    check(`Русклимат: price_source=api → discount игнорируется, discount_pct=0, prelim=base (факт discount=${ruskl.discount_pct})`,
      ruskl.discount_pct === 0 && ruskl.prelim_price === ruskl.base_price);
  }

  console.log('\n=== г. PUT: выбор варианта / сброс / skip ===');
  const item7553 = result16.items.find((it: any) => it.spec_item_id === 7553);
  check('позиция 7553 присутствует и содержит вариант rusklimat_api', !!item7553 && item7553.options.some((o: any) => o.source === 'rusklimat_api'), item7553);
  const chosen = item7553?.options.find((o: any) => o.source === 'rusklimat_api');

  if (chosen) {
    const putRes = await call(
      priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
      { id: '16', specItemId: '7553' }, { option_id: chosen.option_id },
    );
    check(`PUT option_id=${chosen.option_id} → 200`, putRes.statusCode === 200, putRes.payload);
    check(`selected_option_id вернулся = ${chosen.option_id}`,
      putRes.payload?.item?.selected_option_id === chosen.option_id, putRes.payload);

    const selectedRows = db.prepare(`
      SELECT m.id, pli.row_index FROM matched_items m
      JOIN price_list_items pli ON pli.id = m.price_list_item_id
      WHERE m.specification_item_id = 7553 AND m.is_selected = 1
    `).all() as Array<{ id: number; row_index: number }>;
    check(`ровно один is_selected=1 у позиции 7553 (факт ${selectedRows.length})`, selectedRows.length === 1, selectedRows);
    check(`он указывает на external_prices.id=${chosen.option_id} (факт ${selectedRows[0]?.row_index})`,
      selectedRows[0]?.row_index === chosen.option_id, selectedRows);

    const putNull = await call(
      priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
      { id: '16', specItemId: '7553' }, { option_id: null },
    );
    check('PUT option_id=null → selected_option_id=null', putNull.payload?.item?.selected_option_id === null, putNull.payload);
    check('PUT option_id=null → auto_option_id вернулся (не null)', putNull.payload?.item?.auto_option_id != null, putNull.payload);
    const expectedAuto = db.prepare(`
      SELECT ep.id FROM external_prices ep
      JOIN (
        SELECT spec_item_id, MAX(snapshot_date) last_date FROM external_prices
        WHERE project_id = 16 AND spec_item_id = 7553 AND source = 'web_search' GROUP BY spec_item_id
      ) el ON el.spec_item_id = ep.spec_item_id AND ep.snapshot_date = el.last_date
      WHERE ep.project_id = 16 AND ep.source = 'web_search' AND ep.status = 'found' AND ep.price IS NOT NULL
      ORDER BY ep.price ASC, ep.id ASC LIMIT 1
    `).get() as { id: number } | undefined;
    check(`auto_option_id = минимальная web_search-цена последнего среза (ожидание ${expectedAuto?.id}, факт ${putNull.payload?.item?.auto_option_id})`,
      putNull.payload?.item?.auto_option_id === expectedAuto?.id);

    const putSkip = await call(
      priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
      { id: '16', specItemId: '7553' }, { skip: true },
    );
    check('PUT skip=true → skipped=true', putSkip.payload?.item?.skipped === true, putSkip.payload);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
