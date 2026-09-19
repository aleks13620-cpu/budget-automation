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
const { UPSERT_EXTERNAL_PRICE, PRICE_FIELDS, toBindable, nowIso } = require('./src/routes/priceSearch');
const { classifySpecPositions } = require('./src/services/specClassifier');

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
