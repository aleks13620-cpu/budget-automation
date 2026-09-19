/**
 * Ф21.1 — «API вариантов цены». Критерии плана + правка после приёмки оркестратора
 * (позиции = classifySpecPositions, как на /spec-groups; выбор на все дубли; устаревший выбор
 * виден), на копии базы.
 * Запуск: cd backend && npx ts-node --transpile-only test_f21_price_options.ts <путь к базе>
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f13_supplier_price.ts) на своей временной копии.
 *
 *   а. каждая found-строка последнего среза проектов 16/17 представлена в options своей позиции
 *      (сама или эквивалент по source/url/поставщику/цене) — 100%;
 *      summary.total/summary.searched = /spec-groups .total/.layer1.searchable;
 *      not_searched_items = только группа D (по classifySpecPositions, независимо);
 *   б. price_type верен для всех 4 source; is_own_supplier у rusklimat_api/santech_price/
 *      supplier_price('Русклимат') = true;
 *   в. скидка: discount_pct=15 у ЭТМ и Сантехкомплекта → prelim_price = round(base*0.85,2);
 *      Русклимат (price_source='api') игнорирует discount_pct в базе → 0;
 *   г. PUT option_id → selected_option_id, ровно один is_selected=1 у позиции, указывает на
 *      этот external_prices.id; PUT null → selected null, auto_option_id вернулся; PUT skip →
 *      skipped=true; PUT на позицию с ≥2 members → у КАЖДОГО member ровно один is_selected=1;
 *   д. устаревший выбор (строка выпала из последнего среза) — виден в options со stale:true,
 *      selected_option_id по-прежнему на него;
 *   е. тест краснеет на подменённом правиле (см. отчёт).
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
const priceSearchRouter = require('./src/routes/priceSearch').default;
const matchingRouter = require('./src/routes/matching').default;
const { UPSERT_EXTERNAL_PRICE, PRICE_FIELDS, toBindable, nowIso } = require('./src/routes/priceSearch');
const { classifySpecPositions } = require('./src/services/specClassifier');
const { acquireMatchingRun, releaseMatchingRun } = require('./src/services/matchingRunLock');
const { rememberPrevInvoiceMatch, restorePrevInvoiceMatch } = require('./src/routes/priceOptions');
const { getOrCreatePriceListMatchId: getOrCreatePriceListMatchIdForSim } = require('./src/routes/priceSearch');

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

initializeDatabase(); // создаёт price_option_skip — на копии её ещё нет; закрывает и переоткрывает соединение
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

async function getSpecGroups(projectId: number): Promise<any> {
  const res = await call(priceSearchRouter, '/api/projects/:id/spec-groups', 'get', { id: String(projectId) });
  if (res.statusCode !== 200) throw new Error(`GET spec-groups ${projectId} → ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res.payload;
}

// Found-строки последнего среза каждого source по проекту, по-прежнему на сыром spec_item_id —
// то, что должно быть представлено (само или эквивалентом) в options позиции.
function lastSnapshotFoundRows(projectId: number): Array<{ id: number; spec_item_id: number; source: string; source_url: string; supplier_name: string | null; price: number }> {
  return db.prepare(`
    WITH ext_last AS (
      SELECT ep.spec_item_id, ep.source, MAX(ep.snapshot_date) AS last_date
      FROM external_prices ep
      JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
      WHERE ep.project_id = ?
      GROUP BY ep.spec_item_id, ep.source
    )
    SELECT ep.id, ep.spec_item_id, ep.source, ep.source_url, ep.supplier_name, ep.price
    FROM external_prices ep
    JOIN ext_last el ON el.spec_item_id = ep.spec_item_id AND el.source = ep.source AND ep.snapshot_date = el.last_date
    WHERE ep.project_id = ? AND ep.status = 'found' AND ep.price IS NOT NULL
  `).all(projectId, projectId) as any[];
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

  console.log('\n=== ревью п.1: позиция 7428/7446 — представитель 7428 дороже, у члена 7446 синтетика дешевле ===');
  insertExternalPrice({
    business_key: 'f21_review_p1_rep_7428', project_id: 16, spec_item_id: 7428,
    query_name: 'ревью п.1 представитель', source: 'web_search', source_url: 'https://rep-price.example/item',
    snapshot_date: today, supplier_name: 'Представитель', name: 'ревью п.1', unit: 'шт',
    price: 50000, currency: 'RUB', status: 'found',
  });
  insertExternalPrice({
    business_key: 'f21_review_p1_cheap_7446', project_id: 16, spec_item_id: 7446,
    query_name: 'ревью п.1 не представитель, дешевле', source: 'web_search', source_url: 'https://not-representative-cheap.example/item',
    snapshot_date: today, supplier_name: 'Не представитель, но дешевле', name: 'ревью п.1', unit: 'шт',
    price: 100, currency: 'RUB', status: 'found',
  });
  const repRow7428 = db.prepare(
    `SELECT id FROM external_prices WHERE business_key = 'f21_review_p1_rep_7428'`
  ).get() as { id: number };

  console.log('\n=== ревью п.2: синтетика — цена счёта у позиции 7382, ДВА неподтверждённых invoice-матча (паттерн проекта 15) ===');
  db.prepare(`INSERT OR IGNORE INTO suppliers (name) VALUES ('Синтетика Счёт ООО')`).run();
  const invSupplierId = (db.prepare(`SELECT id FROM suppliers WHERE name = 'Синтетика Счёт ООО'`).get() as { id: number }).id;
  const invoiceId = Number(db.prepare(
    `INSERT INTO invoices (project_id, supplier_id, invoice_number, status) VALUES (16, ?, 'F21-REVIEW', 'processed')`
  ).run(invSupplierId).lastInsertRowid);
  const invoiceItemId = Number(db.prepare(
    `INSERT INTO invoice_items (invoice_id, name, price, quantity) VALUES (?, 'ревью п.2', 12345.67, 1)`
  ).run(invoiceId).lastInsertRowid);
  const invoiceMatchId = Number(db.prepare(`
    INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type,
                               match_reason, is_confirmed, is_selected, source)
    VALUES (7382, ?, 1.0, 'invoice', 'ревью теста, выбранный', 0, 1, 'invoice')
  `).run(invoiceItemId).lastInsertRowid);
  // Второй invoice-матч той же позиции — неподтверждённый, НЕ выбранный (is_selected=0). Старое
  // правило-угадывание (findInvoiceRestoreCandidate) при ≥2 неподтверждённых кандидатах сдавалось
  // (null — как в 12/30 и 29/43 на проектах 14/15); новый механизм просто помнит invoiceMatchId,
  // количество кандидатов ему не мешает.
  const invoiceItemId2 = Number(db.prepare(
    `INSERT INTO invoice_items (invoice_id, name, price, quantity) VALUES (?, 'ревью п.2, другая строка счёта', 9999, 1)`
  ).run(invoiceId).lastInsertRowid);
  const invoiceMatchId2 = Number(db.prepare(`
    INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type,
                               match_reason, is_confirmed, is_selected, source)
    VALUES (7382, ?, 0.5, 'invoice', 'ревью теста, второй кандидат', 0, 0, 'invoice')
  `).run(invoiceItemId2).lastInsertRowid);

  console.log('\n=== ревью п.3: синтетика — на позиции 7383 выбран ОБЫЧНЫЙ прайс-лист (не вариант экрана) ===');
  const someExternalId = (db.prepare(`SELECT id FROM external_prices WHERE project_id = 16 LIMIT 1`).get() as { id: number }).id;
  db.prepare(`INSERT OR IGNORE INTO suppliers (name) VALUES ('Обычный Поставщик ООО')`).run();
  const plSupplierId = (db.prepare(`SELECT id FROM suppliers WHERE name = 'Обычный Поставщик ООО'`).get() as { id: number }).id;
  const plId = Number(db.prepare(
    `INSERT INTO price_lists (project_id, supplier_id, file_name, file_path, status) VALUES (16, ?, 'обычный_прайс.xlsx', '/uploads/обычный_прайс.xlsx', 'processed')`
  ).run(plSupplierId).lastInsertRowid);
  // row_index намеренно совпадает с ЧУЖИМ external_prices.id (someExternalId) — п.3 проверяет,
  // что даже такое совпадение числа не спутает обычный прайс с вариантом экрана: решает
  // file_path (не входит в OPTION_SOURCES), а не совпадение row_index.
  const pliId = Number(db.prepare(
    `INSERT INTO price_list_items (price_list_id, article, name, unit, price, row_index) VALUES (?, NULL, 'ревью п.3', 'шт', 999.99, ?)`
  ).run(plId, someExternalId).lastInsertRowid);
  const plMatchId = Number(db.prepare(`
    INSERT INTO matched_items (specification_item_id, price_list_item_id, confidence, match_type,
                               match_reason, is_confirmed, is_selected, source)
    VALUES (7383, ?, 1.0, 'price_list_manual', 'ревью теста', 0, 1, 'price_list')
  `).run(pliId).lastInsertRowid);

  console.log('\n=== стейл-выбор: выбираем старую строку (08-26) у позиции 7385, свежий срез — 09-11 ===');
  const stalePut = await call(
    priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
    { id: '16', specItemId: '7385' }, { option_id: 357 },
  );
  check('PUT старой строки 357 (позиция 7385) → 200', stalePut.statusCode === 200, stalePut.payload);

  console.log('\n=== в. скидка: ЭТМ и Сантехкомплект 15%, Русклимат 15% в базе, но price_source=api ===');
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE domain = 'etm.ru'`).run();
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE source_key = 'santech_price'`).run();
  db.prepare(`UPDATE supplier_sites SET discount_pct = 15 WHERE source_key = 'rusklimat_api'`).run();

  const result16 = await getOptions(16);
  const result17 = await getOptions(17);

  console.log('\n=== а. total/searched = /spec-groups, not_searched_items = только D ===');
  const groups16 = await getSpecGroups(16);
  const groups17 = await getSpecGroups(17);
  check(`проект 16: summary.total=${result16.summary.total} = spec-groups.total=${groups16.total}`, result16.summary.total === groups16.total);
  check(`проект 16: summary.searched=${result16.summary.searched} = spec-groups.layer1.searchable=${groups16.layer1.searchable}`,
    result16.summary.searched === groups16.layer1.searchable);
  check(`проект 17: summary.total=${result17.summary.total} = spec-groups.total=${groups17.total}`, result17.summary.total === groups17.total);
  check(`проект 17: summary.searched=${result17.summary.searched} = spec-groups.layer1.searchable=${groups17.layer1.searchable}`,
    result17.summary.searched === groups17.layer1.searchable);

  const positions16 = classifySpecPositions({ projectId: 16 }, db) as any[];
  const positions17 = classifySpecPositions({ projectId: 17 }, db) as any[];
  const dCount16 = positions16.filter(p => p.group === 'D. без марки').length;
  const dCount17 = positions17.filter(p => p.group === 'D. без марки').length;
  check(`проект 16: not_searched_items.length=${result16.not_searched_items.length} = группа D=${dCount16}`,
    result16.not_searched_items.length === dCount16);
  check(`проект 17: not_searched_items.length=${result17.not_searched_items.length} = группа D=${dCount17}`,
    result17.not_searched_items.length === dCount17);

  console.log('\n=== а. 100% покрытие: каждая found-строка последнего среза — в options своей позиции ===');
  function coverage(projectId: number, result: any, positions: any[]): { total: number; covered: number; misses: unknown[] } {
    const memberToPosition = new Map<number, any>();
    for (const p of positions) for (const mid of p.memberIds) memberToPosition.set(mid, p);
    const itemById = new Map<number, any>(result.items.map((it: any) => [it.spec_item_id, it]));
    const rows = lastSnapshotFoundRows(projectId);
    let covered = 0;
    const misses: unknown[] = [];
    for (const row of rows) {
      const pos = memberToPosition.get(row.spec_item_id);
      const item = pos && itemById.get(pos.id);
      const expectedUrl = /^https?:\/\//i.test(row.source_url) ? row.source_url : '';
      const found = item && item.options.some((o: any) =>
        o.source === row.source && Math.abs(o.base_price - row.price) < 1e-9 && o.url === expectedUrl);
      if (found) covered++; else misses.push({ row, positionId: pos?.id });
    }
    return { total: rows.length, covered, misses };
  }
  const cov16 = coverage(16, result16, positions16);
  const cov17 = coverage(17, result17, positions17);
  check(`проект 16: покрытие ${cov16.covered}/${cov16.total} = 100%`, cov16.covered === cov16.total, cov16.misses.slice(0, 5));
  check(`проект 17: покрытие ${cov17.covered}/${cov17.total} = 100%`, cov17.covered === cov17.total, cov17.misses.slice(0, 5));

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
  const etm = bySource('web_search').find((o: any) => o.domain === 'etm.ru' && !o.stale);
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

  console.log('\n=== д. устаревший выбор виден со stale:true ===');
  const pos7385 = positions16.find(p => p.memberIds.includes(7385));
  const item7385 = result16.items.find((it: any) => it.spec_item_id === pos7385?.id);
  check('позиция 7385 присутствует', !!item7385, item7385);
  check('selected_option_id = 357 (стейл-выбор)', item7385?.selected_option_id === 357, item7385);
  const staleOpt = item7385?.options.find((o: any) => o.option_id === 357);
  check('строка 357 есть в options со stale:true', staleOpt?.stale === true, staleOpt);
  check('остальные (свежие) варианты позиции 7385 stale:false',
    item7385?.options.filter((o: any) => o.option_id !== 357).every((o: any) => o.stale === false));

  console.log('\n=== ревью п.1: auto_option_id = своя строка представителя, а не минимум по всем members ===');
  const item7428 = result16.items.find((it: any) => it.spec_item_id === 7428);
  check('позиция 7428/7446 присутствует', !!item7428, item7428);
  check(`auto_option_id = строка ПРЕДСТАВИТЕЛЯ 7428 (id=${repRow7428.id}), НЕ синтетический дешёвый вариант члена 7446 (факт ${item7428?.auto_option_id})`,
    item7428?.auto_option_id === repRow7428.id, item7428);
  // auto_note проверяем на позиции 7560/7589 (не 7428/7446): у 7446 своя web_search-строка ЕСТЬ
  // (синтетика выше) — выгрузка возьмёт ЕЁ через ext_ranked по её собственному spec_item_id,
  // член покрыт (пусть и другой ценой, не той, что на экране у представителя) — auto_note не
  // должен пугать оператора там, где у экспорта и так будет цена. А вот у 7589 (см. «г. PUT на
  // позицию с ≥2 members» ниже) своих web_search-строк нет вовсе и до выбора там варианта нет —
  // ровно тот случай, когда auto_note обязан предупредить.
  const item7560ForNote = result16.items.find((it: any) => it.spec_item_id === 7560);
  check('auto_note у позиции 7560/7589 предупреждает о неполном покрытии (у 7589 нет своей web_search-строки, нет выбора)',
    typeof item7560ForNote?.auto_note === 'string' && item7560ForNote.auto_note.includes('1 из 2'), item7560ForNote?.auto_note);

  console.log('\n=== ревью п.2: invoice_price/invoice_supplier видны, пока Иван не выбрал вариант ===');
  const item7382 = result16.items.find((it: any) => it.spec_item_id === 7382);
  check('позиция 7382 присутствует', !!item7382, item7382);
  check(`invoice_price = 12345.67 (факт ${item7382?.invoice_price})`, item7382?.invoice_price === 12345.67, item7382);
  check(`invoice_supplier = 'Синтетика Счёт ООО' (факт ${item7382?.invoice_supplier})`, item7382?.invoice_supplier === 'Синтетика Счёт ООО', item7382);
  check('selected_option_id = null (счёт — не выбор Ивана, экран его не подменяет)', item7382?.selected_option_id === null, item7382);

  console.log('\n=== п.4 дозадания: ≥2 неподтверждённых invoice-матча — выбор варианта, ПОВТОРНАЯ смена варианта, сброс возвращает ИСХОДНЫЙ счёт ===');
  const webOptions7382 = item7382?.options.filter((o: any) => o.source === 'web_search') ?? [];
  check('у позиции 7382 есть ≥2 web_search-вариантов (для проверки повторной смены)', webOptions7382.length >= 2, webOptions7382);
  if (webOptions7382.length >= 2) {
    const putVar = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7382' }, { option_id: webOptions7382[0].option_id });
    check('PUT первым вариантом на 7382 → 200', putVar.statusCode === 200, putVar.payload);
    check('после выбора варианта invoice_price = null (счёт больше не активен)', putVar.payload?.item?.invoice_price === null, putVar.payload);
    check('invoice_restorable = true (запомнили счёт при ≥2 неподтверждённых кандидатах — новому правилу их число не мешает)',
      putVar.payload?.item?.invoice_restorable === true, putVar.payload);

    // Повторная смена варианта ДО сброса — исходный запомненный счёт не должен затереться
    // (INSERT OR IGNORE в rememberPrevInvoiceMatch).
    const putVar2 = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7382' }, { option_id: webOptions7382[1].option_id });
    check('PUT вторым (другим) вариантом на 7382 → 200', putVar2.statusCode === 200, putVar2.payload);
    check('invoice_restorable по-прежнему true после повторной смены', putVar2.payload?.item?.invoice_restorable === true, putVar2.payload);
    const prevRowAfter2ndSwitch = db.prepare('SELECT match_id FROM price_option_prev_match WHERE specification_item_id = 7382').get() as { match_id: number } | undefined;
    check(`запомненный match_id НЕ перезаписан повторной сменой (ожидание ${invoiceMatchId}, факт ${prevRowAfter2ndSwitch?.match_id})`,
      prevRowAfter2ndSwitch?.match_id === invoiceMatchId, prevRowAfter2ndSwitch);

    const putReset = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7382' }, { option_id: null });
    check('PUT сброс (option_id:null) → selected_option_id = null', putReset.payload?.item?.selected_option_id === null, putReset.payload);
    check(`ревью п.2/п.4: сброс вернул цену счёта — invoice_price = 12345.67 (факт ${putReset.payload?.item?.invoice_price})`,
      putReset.payload?.item?.invoice_price === 12345.67, putReset.payload);
    const restoredSel = db.prepare(`SELECT id FROM matched_items WHERE specification_item_id = 7382 AND is_selected = 1`).get() as { id: number } | undefined;
    check(`восстановлен ТОТ ЖЕ match_id счёта, что был ДО первого выбора варианта (ожидание ${invoiceMatchId}, факт ${restoredSel?.id})`,
      restoredSel?.id === invoiceMatchId, restoredSel);
    const prevRowGone = db.prepare('SELECT 1 FROM price_option_prev_match WHERE specification_item_id = 7382').get();
    check('запись price_option_prev_match удалена после восстановления', !prevRowGone);
  }

  console.log('\n=== п.4 дозадания: SQL-проверка на копии проектов 14/15 — «выбор варианта → сброс» восстанавливает ТОТ ЖЕ match_id у ВСЕХ invoice-выбранных позиций ===');
  for (const projectId of [14, 15]) {
    const invoiceSelected = db.prepare(`
      SELECT m.id AS match_id, m.specification_item_id AS spec_item_id
      FROM matched_items m
      JOIN specification_items si ON si.id = m.specification_item_id
      WHERE si.project_id = ? AND m.is_selected = 1 AND m.source = 'invoice'
    `).all(projectId) as Array<{ match_id: number; spec_item_id: number }>;
    // matched_items(source='price_list') требует ЖИВОЙ price_list_item_id (CHECK constraint) —
    // одна синтетическая строка-«вариант» на проект, переиспользуется под все позиции проекта
    // (уникальность matched_items.price_list_item_id ничем не ограничена).
    db.prepare(`INSERT OR IGNORE INTO suppliers (name) VALUES ('Симуляция варианта дозадания 2')`).run();
    const simSupplierId = (db.prepare(`SELECT id FROM suppliers WHERE name = 'Симуляция варианта дозадания 2'`).get() as { id: number }).id;
    const simPlId = Number(db.prepare(
      `INSERT INTO price_lists (project_id, supplier_id, file_name, file_path, status) VALUES (?, ?, 'sim.xlsx', '/sim.xlsx', 'processed')`
    ).run(projectId, simSupplierId).lastInsertRowid);
    const simPliId = Number(db.prepare(
      `INSERT INTO price_list_items (price_list_id, article, name, unit, price, row_index) VALUES (?, NULL, 'симуляция', 'шт', 1, 1)`
    ).run(simPlId).lastInsertRowid);

    let restoredSame = 0;
    for (const row of invoiceSelected) {
      // Симулируем «выбор варианта → сброс» на реальном коде (не переизобретаем правило), тем же
      // порядком шагов, что и PUT в priceOptions.ts: remember (пока счёт ещё is_selected=1) →
      // экран выбирает вариант (новая matched_items-строка становится is_selected=1,
      // chosen_match_id обновляется на неё — как делает PUT после setSelectedMatch) → читаем
      // is_selected ДО сброса → restore.
      rememberPrevInvoiceMatch(db, row.spec_item_id);
      db.prepare('UPDATE matched_items SET is_selected = 0 WHERE specification_item_id = ?').run(row.spec_item_id);
      const variantMatchId = Number(db.prepare(`
        INSERT INTO matched_items (specification_item_id, price_list_item_id, confidence, match_type, match_reason, is_confirmed, is_selected, source)
        VALUES (?, ?, 1.0, 'price_list', 'симуляция выбора варианта на экране', 0, 1, 'price_list')
      `).run(row.spec_item_id, simPliId).lastInsertRowid);
      db.prepare('UPDATE price_option_prev_match SET chosen_match_id = ? WHERE specification_item_id = ?').run(variantMatchId, row.spec_item_id);
      restorePrevInvoiceMatch(db, row.spec_item_id, variantMatchId);
      const after = db.prepare('SELECT id FROM matched_items WHERE specification_item_id = ? AND is_selected = 1').get(row.spec_item_id) as { id: number } | undefined;
      if (after?.id === row.match_id) restoredSame++;
    }
    check(`проект ${projectId}: восстановлен ТОТ ЖЕ match_id у ВСЕХ invoice-выбранных позиций — ${restoredSame}/${invoiceSelected.length}`,
      restoredSame === invoiceSelected.length, { total: invoiceSelected.length, restoredSame });
  }

  console.log('\n=== дозадание 2: выбор варианта Б на СТАРОМ экране сопоставления (/api/matching/select) не откатывается «вернуть цену из счёта» ===');
  {
    // Стартовое состояние 7382 после предыдущих блоков — счёт восстановлен (см. проверки выше).
    const before = await getOptions(16);
    const item7382Before = before.items.find((it: any) => it.spec_item_id === 7382);
    check('перед сценарием дозадания 2 у 7382 снова активен счёт (invoice_price не null)', item7382Before?.invoice_price != null, item7382Before);
    const webOptsD2 = item7382Before?.options.filter((o: any) => o.source === 'web_search') ?? [];
    check('у 7382 есть варианты А и Б (≥2 web_search)', webOptsD2.length >= 2, webOptsD2);

    if (webOptsD2.length >= 2 && item7382Before?.invoice_price != null) {
      // Шаг 1 — Иван выбирает вариант А на экране Ф21.
      const putA = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7382' }, { option_id: webOptsD2[0].option_id });
      check('шаг 1: PUT вариантом А на 7382 → 200', putA.statusCode === 200, putA.payload);
      check('шаг 1: invoice_restorable=true сразу после выбора варианта А', putA.payload?.item?.invoice_restorable === true, putA.payload);

      // Шаг 2 — Иван на СТАРОМ экране сопоставления выбирает вариант Б через РЕАЛЬНЫЙ
      // /api/matching/select/:id (matching.ts) — в обход priceOptions.ts, ровно как в отчёте
      // ревью. matchIdB получаем тем же способом, что использует сам экран Ф21 для превращения
      // варианта в matched_items-строку (getOrCreatePriceListMatchId), но здесь — НЕ через PUT
      // priceOptions, а напрямую, как обычный кандидат старого экрана.
      const matchIdB = getOrCreatePriceListMatchIdForSim(db, 16, webOptsD2[1].option_id);
      const putSelectB = await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(matchIdB) }, {});
      check('шаг 2: PUT /api/matching/select/:id (старый экран, вариант Б) → 200', putSelectB.statusCode === 200, putSelectB.payload);

      // Шаг 3 — GET экрана Ф21: invoice_restorable ОБЯЗАН стать false (выбор сделан не этим
      // экраном — chosen_match_id указывает на матч варианта А, is_selected уже на варианте Б).
      const afterSelect = await getOptions(16);
      const item7382AfterSelect = afterSelect.items.find((it: any) => it.spec_item_id === 7382);
      check('шаг 3: invoice_restorable=false — выбор сделан НЕ экраном Ф21 (это и был баг ревью)',
        item7382AfterSelect?.invoice_restorable === false, item7382AfterSelect);
      check(`шаг 3: selected_option_id = вариант Б (${webOptsD2[1].option_id}), не вариант А`,
        item7382AfterSelect?.selected_option_id === webOptsD2[1].option_id, item7382AfterSelect);

      // Шаг 4 — «сбросить выбор» (PUT option_id:null) при протухшей prev: обычный сброс —
      // вариант Б снят (явное действие Ивана), старый счёт НЕ возвращается молча.
      const putNullD2 = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7382' }, { option_id: null });
      check('шаг 4: PUT option_id:null → 200', putNullD2.statusCode === 200, putNullD2.payload);
      const afterNullD2 = db.prepare('SELECT id FROM matched_items WHERE specification_item_id = 7382 AND is_selected = 1').get() as { id: number } | undefined;
      check(`шаг 4: после сброса не выбран ни вариант Б (matchIdB=${matchIdB}), ни старый счёт (match_id=${invoiceMatchId})`,
        afterNullD2?.id !== matchIdB && afterNullD2?.id !== invoiceMatchId, afterNullD2);
      const prevLeft = db.prepare('SELECT 1 FROM price_option_prev_match WHERE specification_item_id = 7382').get();
      check('шаг 4: протухшая prev удалена', !prevLeft, prevLeft);
    }
  }

  console.log('\n=== ревью п.3: обычный прайс-лист не путается с вариантом экрана ===');
  const item7383 = result16.items.find((it: any) => it.spec_item_id === 7383);
  check('позиция 7383 присутствует', !!item7383, item7383);
  check(`other_selected_label = 'выбрана цена из прайса Обычный Поставщик ООО: 999,99 ₽' (факт ${JSON.stringify(item7383?.other_selected_label)})`,
    item7383?.other_selected_label === 'выбрана цена из прайса Обычный Поставщик ООО: 999,99 ₽', item7383);
  check('selected_option_id = null (обычный прайс — не вариант этого экрана)', item7383?.selected_option_id === null, item7383);
  check('auto_option_id = null (есть явный выбор — пусть и обычным прайсом)', item7383?.auto_option_id === null, item7383);

  console.log('\n=== ревью п.4: skip НЕ трогает обычный прайс-лист (снимает только варианты OPTION_SOURCES) ===');
  const putSkip7383 = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7383' }, { skip: true });
  check('PUT skip на 7383 → 200', putSkip7383.statusCode === 200, putSkip7383.payload);
  const stillSelected = db.prepare(`SELECT is_selected FROM matched_items WHERE id = ?`).get(plMatchId) as { is_selected: number };
  check(`обычный прайс остался выбранным после skip (is_selected=1, факт ${stillSelected.is_selected})`, stillSelected.is_selected === 1, stillSelected);
  db.prepare(`DELETE FROM price_option_skip WHERE specification_item_id = 7383`).run();

  console.log('\n=== ревью п.5: PUT блокируется во время matching (ensureMatchingNotRunning, тот же импорт, что matching.ts) ===');
  acquireMatchingRun(16);
  const putDuringRun = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7383' }, { skip: true });
  check(`PUT во время активного matching → 409 (факт ${putDuringRun.statusCode})`, putDuringRun.statusCode === 409, putDuringRun.payload);
  releaseMatchingRun(16);
  const putAfterRun = await call(priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put', { id: '16', specItemId: '7383' }, { skip: true });
  check(`PUT после освобождения matching → 200 (факт ${putAfterRun.statusCode})`, putAfterRun.statusCode === 200, putAfterRun.payload);
  db.prepare(`DELETE FROM price_option_skip WHERE specification_item_id = 7383`).run();

  console.log('\n=== г. PUT: выбор варианта / сброс / skip (одна позиция) ===');
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

  console.log('\n=== г. PUT на позицию с ≥2 members (7560+7589): выбор применяется ко всем ===');
  const posMulti = positions16.find(p => p.memberIds.includes(7560) && p.memberIds.length >= 2);
  check('позиция 7560/7589 найдена, members ≥2', !!posMulti, posMulti);
  if (posMulti) {
    // Вариант ЭТМ у представителя 7560 (66608.45) — у члена 7589 своей такой строки нет
    // (проверено разведкой) → должен сработать ensureMemberEquivalent для 7589.
    const chosenMulti = db.prepare(`
      SELECT id, spec_item_id, source, source_url, price FROM external_prices
      WHERE project_id = 16 AND spec_item_id = 7560 AND source = 'web_search' AND price = 66608.45
        AND status = 'found' LIMIT 1
    `).get() as { id: number; spec_item_id: number; source: string; source_url: string; price: number } | undefined;
    check('нашли строку ЭТМ (66608.45) у представителя 7560', !!chosenMulti, chosenMulti);
    const has7589Own = db.prepare(`
      SELECT COUNT(*) c FROM external_prices WHERE project_id = 16 AND spec_item_id = 7589
        AND source = 'web_search' AND source_url = ? AND price = 66608.45
    `).get(chosenMulti?.source_url) as { c: number };
    check(`у члена 7589 своей строки под это предложение нет (факт строк=${has7589Own.c}) — сценарий проверяет создание`, has7589Own.c === 0);

    if (chosenMulti) {
      const putMulti = await call(
        priceOptionsRouter, '/api/projects/:id/price-options/:specItemId', 'put',
        { id: '16', specItemId: '7560' }, { option_id: chosenMulti.id },
      );
      check('PUT по позиции 7560/7589 → 200', putMulti.statusCode === 200, putMulti.payload);
      check(`selected_option_id представителя = ${chosenMulti.id}`, putMulti.payload?.item?.selected_option_id === chosenMulti.id, putMulti.payload);

      for (const memberId of [7560, 7589]) {
        const sel = db.prepare(`
          SELECT m.id, pli.row_index FROM matched_items m
          JOIN price_list_items pli ON pli.id = m.price_list_item_id
          WHERE m.specification_item_id = ? AND m.is_selected = 1
        `).all(memberId) as Array<{ id: number; row_index: number }>;
        check(`член ${memberId}: ровно один is_selected=1 (факт ${sel.length})`, sel.length === 1, sel);
        if (sel.length === 1) {
          const row = db.prepare('SELECT source, source_url, price FROM external_prices WHERE id = ?').get(sel[0].row_index) as any;
          check(`член ${memberId}: строка ${sel[0].row_index} — тот же source/url/цена (${JSON.stringify(row)})`,
            row?.source === chosenMulti.source && row?.source_url === chosenMulti.source_url && row?.price === chosenMulti.price);
        }
      }
      const carried = db.prepare(`SELECT id FROM external_prices WHERE business_key = ?`).get(`f21_carry_${chosenMulti.id}_to_7589`) as { id: number } | undefined;
      check(`для члена 7589 создана своя строка (business_key f21_carry_${chosenMulti.id}_to_7589)`, !!carried, carried);
    }
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
