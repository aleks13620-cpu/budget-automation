/**
 * Ф12-фиксы (пять ходов перед выкладкой) — критерии Б и В на копии базы.
 * Запуск: cd backend && npx ts-node --transpile-only test_f12_fixes.ts <csv Русклимата> <путь к базе>
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f12_site_variant.ts) на своей временной копии базы.
 * А (крестик у варианта) и Г (текст подписи) — не код, проверяются grep'ом/дословной цитатой в отчёте.
 *
 *   Б. web_search без счёта: сейчас export.ts автоподставляет цену без выбора («Интернет» +
 *      ссылка + пометка); после выбора варианта те же данные превращаются в «Ориг.» без ссылки
 *      и пометки — тот же самый факт, который правка А/Б должна не портить веткой usedExternal.
 *      supplier_price без счёта: автоподстановки в export.ts нет вовсе (там фильтр
 *      source='web_search') — без выбора цена в выгрузке пустая, выбор — единственный путь.
 *   В. позиция с выбранным вариантом и невыбранным кандидатом счёта confidence ≥ 0.8
 *      (CONFIDENCE_SELECT_THRESHOLD в MatchTable.tsx): «было» — bulk/confirm на таком matchId
 *      (что делал старый код без фильтра) сбрасывает is_selected варианта; «стало» — тот же
 *      matchId воспроизведением фронтового фильтра `.filter(r => !r.siteVariants?.some(isSelected))`
 *      в confirm-набор не попадает, is_selected варианта не трогается.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const CSV_PATH = path.resolve(process.argv[2]);
const SRC_DB = path.resolve(process.argv[3] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f12_fixes_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const { getDatabase, closeDatabase } = require('./src/database/connection');
const priceListsRouter = require('./src/routes/priceLists').default;
const matchingRouter = require('./src/routes/matching').default;
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
  if (res.statusCode !== 200) throw new Error(`${method} ${routePath} -> ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res;
}

const db = getDatabase();
const PID = 16;
const P = { id: String(PID) };
const CONFIDENCE_SELECT_THRESHOLD = 0.8; // MatchTable.tsx — сверено кодом, в задании было указано 0.9

const table = async () => (await call(matchingRouter, '/api/projects/:id/matching', 'get', P)).payload.items as any[];

async function exportRow(specItemId: number) {
  const res = await call(exportRouter, '/api/projects/:id/export', 'get', P);
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const head = rows.findIndex((r) => Array.isArray(r) && r[0] === '№');
  const bySection = new Map<string, number[]>();
  for (const r of db.prepare(`SELECT id, section FROM specification_items WHERE project_id = ? ORDER BY section, id`).all(PID) as any[]) {
    const k = r.section || 'Без раздела';
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k)!.push(r.id);
  }
  const seq = [...bySection.values()].flat();
  const n = seq.indexOf(specItemId) + 1;
  const row = rows.slice(head + 1).find((r) => Array.isArray(r) && r[0] === n)!;
  const headerRow = rows[head];
  const col = (name: string) => headerRow.indexOf(name);
  return { price: row[col('Цена')], supplier: row[col('Поставщик')], type: row[col('Тип')], foundBy: row[col('Найдено по')], link: row[col('Ссылка на товар')] };
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}, прайс ${path.basename(CSV_PATH)}`);

  await call(priceListsRouter, '/api/projects/:id/supplier-price', 'post', P, { supplier: 'Русклимат' }, {}, {
    originalname: path.basename(CSV_PATH), buffer: fs.readFileSync(CSV_PATH),
  });

  const items0 = await table();
  const webRow = items0.find(r => r.matches.length === 0 && r.siteVariants.some((v: any) => v.sourceLabel === 'Цена с сайта'));
  const supRow = items0.find(r => r.matches.length === 0 && r.siteVariants.some((v: any) => v.sourceLabel !== 'Цена с сайта'));
  const thirdRow = items0.find(r => r.siteVariants.length > 0 && r.specItem.id !== webRow?.specItem.id && r.specItem.id !== supRow?.specItem.id);

  console.log('\n=== Б. web_search без счёта: автоподстановка есть, выбор её портит ===');
  if (webRow) {
    const specId = webRow.specItem.id;
    const v = webRow.siteVariants.find((x: any) => x.sourceLabel === 'Цена с сайта');
    const before = await exportRow(specId);
    check(`до выбора: «Интернет», ссылка и пометка есть (${JSON.stringify(before)})`,
      before.type === 'Интернет' && !!before.foundBy && !!before.link && before.price === v.price);
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(v.id) });
    const after = await exportRow(specId);
    check(`после выбора: цена та же (${before.price}=${after.price}), но тип «${after.type}», ссылка «${after.link}», пометка «${after.foundBy}» — потеряны`,
      after.price === before.price && after.type !== 'Интернет' && !after.foundBy && !after.link);
  } else {
    check('нашлась позиция без счёта с вариантом web_search', false);
  }

  console.log('\n=== Б. supplier_price без счёта: автоподстановки нет, выбор — единственный путь ===');
  if (supRow) {
    const specId = supRow.specItem.id;
    const v = supRow.siteVariants.find((x: any) => x.sourceLabel !== 'Цена с сайта');
    const before = await exportRow(specId);
    check(`до выбора: цена пустая (факт ${JSON.stringify(before.price)}) — Русклимат в файл не попал`,
      before.price === '' || before.price == null);
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(v.id) });
    const after = await exportRow(specId);
    check(`после выбора: цена ${after.price} = ${v.price}, поставщик «${after.supplier}» = «${v.supplierName}»`,
      after.price === v.price && after.supplier === v.supplierName);
  } else {
    check('нашлась позиция без счёта с вариантом supplier_price', false);
  }

  console.log('\n=== В. массовое подтверждение не должно сбрасывать выбранный вариант ===');
  if (thirdRow) {
    const specId = thirdRow.specItem.id;
    const variant = thirdRow.siteVariants[0];
    // синтетический кандидат счёта confidence 0.85 (≥ порога уверенных 0.8), не подтверждён —
    // именно такую строку «Подтвердить уверенные» подхватывает без правки В
    const sup = db.prepare(`INSERT INTO suppliers (name) VALUES ('Тест В (Ф12-фикс)') RETURNING id`).get() as any;
    const inv = db.prepare(`INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, total_amount)
                            VALUES (?, ?, 'Ф12фикс-В', date('now'), 0) RETURNING id`).get(PID, sup.id) as any;
    const ii = db.prepare(`INSERT INTO invoice_items (invoice_id, name, unit, quantity, price, amount)
                           VALUES (?, 'тестовая строка счёта', 'шт', 1, 100, 100) RETURNING id`).get(inv.id) as any;
    const mi = db.prepare(`INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected, source)
                           VALUES (?, ?, 0.85, 'name_similarity', 0, 0, 'invoice') RETURNING id`).get(specId, ii.id) as any;

    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(variant.id) });
    const items1 = await table();
    const row1 = items1.find(r => r.specItem.id === specId);
    const cand = row1.matches.find((m: any) => m.id === mi.id);
    check(`синтетический кандидат счёта: confidence ${cand.confidence} ≥ ${CONFIDENCE_SELECT_THRESHOLD}, не подтверждён, вариант выбран`,
      cand.confidence >= CONFIDENCE_SELECT_THRESHOLD && !cand.isConfirmed && row1.siteVariants.some((v: any) => v.isSelected));

    // «было»: массовое подтверждение (bulk/confirm) без фильтра — как раньше отправлял фронт —
    // подтверждает этот matchId и сбрасывает выбор варианта
    const selBefore = (db.prepare('SELECT is_selected FROM matched_items WHERE id = ?').get(variant.id) as any).is_selected;
    await call(matchingRouter, '/api/matching/bulk/confirm', 'post', {}, { matchIds: [mi.id] });
    const selAfterOldBehavior = (db.prepare('SELECT is_selected FROM matched_items WHERE id = ?').get(variant.id) as any).is_selected;
    check(`было: выбор варианта ${selBefore} → после bulk/confirm без фильтра ${selAfterOldBehavior} (сброшен)`,
      selBefore === 1 && selAfterOldBehavior === 0);

    // «стало»: воспроизводим фильтр фронта (MatchTable.tsx ~279-282) — строку с выбранным
    // вариантом исключаем ДО выбора «лучшего» кандидата, поэтому matchId в confirm-набор не попадает
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(variant.id) }); // вернуть выбор варианта
    const items2 = await table();
    const getBestMatchOf = (row: any) => row.matches.find((m: any) => m.isSelected) || row.matches[0] || null;
    const selectableBestMatches = items2
      .filter(r => !r.siteVariants?.some((v: any) => v.isSelected)) // ровно правка В
      .map(getBestMatchOf)
      .filter((m: any) => m != null && !m.isConfirmed);
    const confidentIds = selectableBestMatches.filter((m: any) => m.confidence >= CONFIDENCE_SELECT_THRESHOLD).map((m: any) => m.id);
    check(`стало: matchId ${mi.id} НЕ в confirm-наборе (${confidentIds.length} шт.)`, !confidentIds.includes(mi.id));
    const selAfterFix = (db.prepare('SELECT is_selected FROM matched_items WHERE id = ?').get(variant.id) as any).is_selected;
    check(`стало: выбор варианта остался ${selAfterFix} (не звали bulk/confirm для этого matchId)`, selAfterFix === 1);
  } else {
    check('нашлась третья позиция с вариантом для сценария В', false);
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
