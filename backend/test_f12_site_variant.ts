/**
 * Ф12 — цена с сайта как вариант в сопоставлении. Критерии 1, 2, 4, 5 на копии базы.
 * Запуск:  cd backend && npx ts-node --transpile-only test_f12_site_variant.ts [путь к базе]
 * База по умолчанию — ../database/budget_automation.db; тест работает на своей временной копии.
 *
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_bulk_spec_hardblock_integration.ts):
 *   1. у каждой позиции, где есть и сопоставление со счётом, и цена сайта, API таблицы отдаёт оба;
 *   2. выбор варианта-сайта → в xlsx цена и продавец сайта; выбор обратно счёта → цена счёта;
 *   4. подпись слоя 1 = число позиций с вариантом-сайтом = число позиций с найденной ценой в срезе;
 *   5. повторный приём того же результата и пересопоставление не плодят и не стирают варианты.
 * Заменяет test_layer1_counter_vs_export.ts: Ф12 меняет смысл подписи (критерий 4 плана).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const SRC_DB = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f12_site_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = ''; // без платных вызовов LLM в пересопоставлении

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const { getDatabase, closeDatabase } = require('./src/database/connection');
require('./src/database/init').initializeDatabase(); // как сервер при старте: миграции (Ф21 — price_option_skip)
const priceSearchRouter = require('./src/routes/priceSearch').default;
const matchingRouter = require('./src/routes/matching').default;
const exportRouter = require('./src/routes/export').default;
const { isMatchingRunActive } = require('./src/services/matchingRunLock');

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
const PROJECT: number | undefined = (db.prepare(
  `SELECT ep.project_id AS pid FROM external_prices ep
     JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
    WHERE ep.source = 'web_search' AND ep.status = 'found'
    GROUP BY ep.project_id ORDER BY COUNT(*) DESC LIMIT 1`,
).get() as any)?.pid;
const P = { id: String(PROJECT) };

const label = async () => (await call(priceSearchRouter, '/api/projects/:id/spec-groups', 'get', P)).payload.layer1.withPrice;
const table = async () => (await call(matchingRouter, '/api/projects/:id/matching', 'get', P)).payload.items as any[];
const siteCount = () => (db.prepare(
  `SELECT COUNT(*) c FROM matched_items m JOIN specification_items si ON si.id = m.specification_item_id
    WHERE si.project_id = ? AND m.match_type = 'web_search'`).get(PROJECT) as any).c;
// Независимо от кода фазы: позиции с найденной ценой в последнем срезе.
const foundInLastSnapshot = () => (db.prepare(
  `SELECT COUNT(DISTINCT ep.spec_item_id) c FROM external_prices ep
     JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
    WHERE ep.project_id = ? AND ep.source = 'web_search' AND ep.status = 'found' AND ep.price IS NOT NULL
      AND ep.snapshot_date = (SELECT MAX(e2.snapshot_date) FROM external_prices e2
                               WHERE e2.spec_item_id = ep.spec_item_id AND e2.source = 'web_search')`,
).get(PROJECT) as any).c;

async function rematch(mode = 'full'): Promise<void> {
  await call(matchingRouter, '/api/projects/:id/matching/run', 'post', P, {}, { mode });
  for (let i = 0; i < 600 && isMatchingRunActive(PROJECT); i++) await new Promise(r => setTimeout(r, 50));
  if (isMatchingRunActive(PROJECT)) throw new Error('сопоставление не завершилось за 30 с');
}

async function exportRow(specItemId: number): Promise<{ price: any; supplier: any }> {
  const res = await call(exportRouter, '/api/projects/:id/export', 'get', P);
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const head = rows.findIndex(r => Array.isArray(r) && r[0] === '№');
  // порядок строк выгрузки: section, id; номер строки = порядковый номер позиции
  const ordered = db.prepare(
    `SELECT id FROM specification_items WHERE project_id = ? ORDER BY section, id`).all(PROJECT) as any[];
  const bySection = new Map<string, number[]>();
  for (const r of db.prepare(`SELECT id, section FROM specification_items WHERE project_id = ? ORDER BY section, id`).all(PROJECT) as any[]) {
    const k = r.section || 'Без раздела';
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k)!.push(r.id);
  }
  const seq = [...bySection.values()].flat();
  if (seq.length !== ordered.length) throw new Error('порядок позиций не сошёлся');
  const n = seq.indexOf(specItemId) + 1;
  const row = rows.slice(head + 1).find(r => Array.isArray(r) && r[0] === n)!;
  return { price: row[rows[head].indexOf('Цена')], supplier: row[rows[head].indexOf('Поставщик')] };
}

async function main(): Promise<void> {
  if (!PROJECT) { console.log('в базе нет проекта с прогоном поиска цен — проверять нечего'); return; }
  console.log(`проект ${PROJECT}, база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}`);

  console.log('\n=== 4. подпись слоя 1 = позиции с вариантом-сайтом ===');
  const expected = foundInLastSnapshot();
  const l0 = await label();
  const t0 = (await table()).filter(r => r.siteVariants.length > 0).length;
  check(`подпись ${l0} = таблица ${t0} = найдено в срезе ${expected}`, l0 === t0 && t0 === expected && expected > 0, { l0, t0, expected });
  const all = (await table()).flatMap(r => r.siteVariants);
  check(`у всех ${all.length} вариантов есть продавец, цена, ссылка, дата`,
    all.every((v: any) => v.supplierName && v.price != null && /^https?:\/\//.test(v.url) && /^\d{4}-\d{2}-\d{2}/.test(v.date)));
  check('варианты-сайты не попали в список прайсов проекта',
    (await call(require('./src/routes/priceLists').default, '/api/projects/:id/price-lists', 'get', P)).payload
      .every((pl: any) => pl.file_path !== 'web_search'));

  console.log('\n=== 5. повторный приём того же результата не плодит вариантов ===');
  const ids0 = (db.prepare(`SELECT id FROM matched_items WHERE match_type='web_search' ORDER BY id`).all() as any[]).map(r => r.id).join(',');
  const rows = db.prepare(`SELECT * FROM external_prices WHERE project_id = ? AND source = 'web_search'`).all(PROJECT);
  const job = db.prepare(`INSERT INTO price_search_jobs (project_id, status, requested_at, started_at)
                          VALUES (?, 'running', datetime('now'), datetime('now'))`).run(PROJECT).lastInsertRowid;
  await call(priceSearchRouter, '/api/price-search/jobs/:id/result', 'post', { id: String(job) }, { rows });
  await label(); await table();
  const ids1 = (db.prepare(`SELECT id FROM matched_items WHERE match_type='web_search' ORDER BY id`).all() as any[]).map(r => r.id).join(',');
  check(`второй приём: вариантов ${siteCount()} = ${expected}, те же id`, siteCount() === expected && ids1 === ids0);

  console.log('\n=== 5. пересопоставление не стирает варианты и не клеит сайт к чужим позициям ===');
  // Случай проекта 15: счёт «Тёплый дом» по ~316 ₽ на 16 позиций, у которых есть цена сайта.
  // В копии 27.08 такого проекта нет — собираем его на позициях с ценой сайта; сопоставит матчер.
  db.prepare(`INSERT OR IGNORE INTO suppliers (name) VALUES ('Тёплый дом (тест Ф12)')`).run();
  const sup = (db.prepare(`SELECT id FROM suppliers WHERE name = 'Тёплый дом (тест Ф12)'`).get() as any).id;
  const invId = db.prepare(`INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, total_amount)
                            VALUES (?, ?, 'Ф12-тест', date('now'), 0)`).run(PROJECT, sup).lastInsertRowid;
  const specs = db.prepare(`SELECT id, name, product_code FROM specification_items WHERE project_id = ? AND product_code IS NOT NULL
      AND id IN (SELECT specification_item_id FROM matched_items WHERE match_type = 'web_search') ORDER BY id LIMIT 16`).all(PROJECT) as any[];
  for (const s of specs) {
    db.prepare(`INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, price, amount) VALUES (?, ?, ?, 'шт', 1, 316, 316)`)
      .run(invId, s.product_code, `${s.name} ${s.product_code}`);
  }
  await rematch();
  const ids2 = (db.prepare(`SELECT id FROM matched_items WHERE match_type='web_search' ORDER BY id`).all() as any[]).map(r => r.id).join(',');
  check(`после пересопоставления вариантов ${siteCount()}, те же id`, ids2 === ids0);
  const glued = (db.prepare(`SELECT COUNT(*) c FROM matched_items m JOIN price_list_items pli ON pli.id = m.price_list_item_id
      JOIN price_lists pl ON pl.id = pli.price_list_id WHERE pl.file_path = 'web_search' AND COALESCE(m.match_type,'') <> 'web_search'`).get() as any).c;
  check(`матчер не приклеил позиции сайта к чужим позициям (${glued})`, glued === 0);
  const wrongSpec = (db.prepare(`SELECT COUNT(*) c FROM matched_items m JOIN price_list_items pli ON pli.id = m.price_list_item_id
      JOIN external_prices ep ON ep.id = pli.row_index WHERE m.match_type = 'web_search' AND ep.spec_item_id <> m.specification_item_id`).get() as any).c;
  check(`каждый вариант стоит на позиции своей находки (чужих ${wrongSpec})`, wrongSpec === 0);

  console.log('\n=== 1. позиции со счётом и ценой сайта — в таблице оба варианта ===');
  const both = (db.prepare(`SELECT DISTINCT m.specification_item_id id FROM matched_items m
      JOIN specification_items si ON si.id = m.specification_item_id
     WHERE si.project_id = ? AND m.source = 'invoice'
       AND m.specification_item_id IN (SELECT specification_item_id FROM matched_items WHERE match_type = 'web_search')`,
  ).all(PROJECT) as any[]).map(r => r.id);
  const items = await table();
  const shown = items.filter(r => both.includes(r.specItem.id) && r.matches.length > 0 && r.siteVariants.length > 0).length;
  check(`видны оба у ${shown} из ${both.length}`, both.length > 0 && shown === both.length, { shown, both: both.length });

  console.log('\n=== 2. выбор сайта → цена сайта в выгрузке; обратно счёт → цена счёта (2 позиции) ===');
  for (const specId of both.slice(0, 2)) {
    const row = items.find(r => r.specItem.id === specId);
    const site = row.siteVariants[0];
    const inv = row.matches[0];
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(site.id) });
    const e1 = await exportRow(specId);
    check(`позиция ${specId}: выбрали сайт → ${e1.price} ${e1.supplier} = ${site.price} ${site.supplierName}`,
      e1.price === site.price && e1.supplier === site.supplierName);
    await rematch();
    const sel = (db.prepare('SELECT COUNT(*) c FROM matched_items WHERE specification_item_id = ? AND is_selected = 1').get(specId) as any).c;
    const e2 = await exportRow(specId);
    check(`позиция ${specId}: после пересопоставления выбор сайта держится, выбранных ${sel}`, sel === 1 && e2.price === site.price);
    // пересопоставление пересоздаёт неподтверждённые матчи счёта — id берём заново
    const invAfter = (await table()).find(r => r.specItem.id === specId).matches[0] ?? inv;
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(invAfter.id) });
    const invNow = (await table()).find(r => r.specItem.id === specId).matches.find((m: any) => m.isSelected);
    const e3 = await exportRow(specId);
    check(`позиция ${specId}: обратно счёт → ${e3.price} = ${invNow?.price} (${e3.supplier})`,
      invNow != null && e3.price === invNow.price && e3.price !== site.price);
  }

  console.log('\n=== счётчики сопоставления не считают цену сайта сопоставлением ===');
  await rematch('incremental');
  check(`инкрементальное пересопоставление: вариантов ${siteCount()} = ${expected}`, siteCount() === expected);
  const stats = (await call(matchingRouter, '/api/projects/:id/matching/stats', 'get', P)).payload;
  const invoiceMatched = (db.prepare(`SELECT COUNT(DISTINCT m.specification_item_id) c FROM matched_items m
      JOIN specification_items si ON si.id = m.specification_item_id WHERE si.project_id = ? AND m.source = 'invoice'`).get(PROJECT) as any).c;
  check(`/matching/stats: сопоставлено ${stats.matched} = со счётом ${invoiceMatched}`, stats.matched === invoiceMatched && invoiceMatched > 0);

  console.log('\n=== отклонённая цена сайта не воскрешается ===');
  const victim = (await table()).find(r => r.siteVariants.length > 0 && !r.siteVariants[0].isSelected);
  await call(matchingRouter, '/api/matching/:id', 'delete', { id: String(victim.siteVariants[0].id) });
  const l1 = await label();
  const t1 = (await table()).filter(r => r.siteVariants.length > 0).length;
  check(`после отклонения подпись ${l1} = таблица ${t1} = ${expected - 1}`, l1 === expected - 1 && t1 === l1);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
