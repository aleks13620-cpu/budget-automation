/**
 * Ф12.1 — подтверждение счёта той же позиции не сбрасывает выбранный Иваном вариант цены
 * (сайт / прайс поставщика). Критерии плана PLAN_Арта_цены-для-Ивана_2026-08-27.md, «Ф12.1».
 * Запуск: cd backend && npx ts-node --transpile-only test_f12_1_confirm_keeps_variant.ts <csv Русклимата> [путь к базе]
 * Дёргает НАСТОЯЩИЕ обработчики роутов (как test_f13_supplier_price.ts) на своей временной копии базы.
 *
 *   1. позиция 7553 (VFG-2R, проект 16) с выбранным вариантом Русклимата (128880.07 — тот же
 *      CSV/сценарий, что test_f13_supplier_price.ts): на СВОЁМ свежем неподтверждённом
 *      синтетическом кандидате счёта (как в test_f12_fixes.ts) для каждого из 4 действий —
 *      «✓» (/confirm), «Аналог» (/confirm-analog), bulk/confirm, подтверждение группы дублей
 *      (group-confirm) — счёт подтверждается (is_confirmed=1, is_analog где нужно), а выбор
 *      варианта (is_selected Русклимата) НЕ трогается. После всех четырёх /export и
 *      /export-original по-прежнему отдают цену и поставщика Русклимата.
 *   2. позиция БЕЗ выбранного варианта: /confirm ведёт себя прежним образом байт в байт —
 *      подтверждённый матч сам становится is_selected=1.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const CSV_PATH = path.resolve(process.argv[2]);
const SRC_DB = path.resolve(process.argv[3] || path.resolve(__dirname, '..', 'database', 'budget_automation.db'));
const tmpDb = path.join(os.tmpdir(), `f12_1_confirm_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const { getDatabase, closeDatabase } = require('./src/database/connection');
const priceListsRouter = require('./src/routes/priceLists').default;
const matchingRouter = require('./src/routes/matching').default;
const exportRouter = require('./src/routes/export').default;
const exportOriginalRouter = require('./src/routes/exportOriginal').default;
const { matchItemsToRawRows } = require('./src/services/rowMatcher');

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
const SPEC_ID = 7553;
const P = { id: String(PID) };

const table = async () => (await call(matchingRouter, '/api/projects/:id/matching', 'get', P)).payload.items as any[];

function matchRow(id: number): { is_confirmed: number; is_selected: number; is_analog: number } {
  return db.prepare('SELECT is_confirmed, is_selected, is_analog FROM matched_items WHERE id = ?').get(id) as any;
}

let seq = 0;
function insertUnconfirmedCandidate(label: string, specItemId: number = SPEC_ID): { invoiceItemId: number; matchId: number } {
  seq++;
  const sup = db.prepare(`INSERT INTO suppliers (name) VALUES (?) RETURNING id`).get(`Тест Ф12.1 (${label})`) as any;
  const inv = db.prepare(`INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, total_amount)
                          VALUES (?, ?, ?, date('now'), 0) RETURNING id`).get(PID, sup.id, `Ф121-${seq}`) as any;
  const ii = db.prepare(`INSERT INTO invoice_items (invoice_id, name, unit, quantity, price, amount)
                         VALUES (?, ?, 'шт', 1, 100, 100) RETURNING id`).get(inv.id, `тестовая строка счёта ${label}`) as any;
  const mi = db.prepare(`INSERT INTO matched_items (specification_item_id, invoice_item_id, confidence, match_type, is_confirmed, is_selected, source)
                         VALUES (?, ?, 0.9, 'name_similarity', 0, 0, 'invoice') RETURNING id`).get(specItemId, ii.id) as any;
  return { invoiceItemId: ii.id, matchId: mi.id };
}

async function exportRow(specItemId: number): Promise<{ price: any; supplier: any }> {
  const res = await call(exportRouter, '/api/projects/:id/export', 'get', P);
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const head = rows.findIndex(r => Array.isArray(r) && r[0] === '№');
  const bySection = new Map<string, number[]>();
  for (const r of db.prepare(`SELECT id, section FROM specification_items WHERE project_id = ? ORDER BY section, id`).all(PID) as any[]) {
    const k = r.section || 'Без раздела';
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k)!.push(r.id);
  }
  const flatSeq = [...bySection.values()].flat();
  const n = flatSeq.indexOf(specItemId) + 1;
  const row = rows.slice(head + 1).find(r => Array.isArray(r) && r[0] === n)!;
  return { price: row[rows[head].indexOf('Цена')], supplier: row[rows[head].indexOf('Поставщик')] };
}

async function exportOriginalRow(specItemId: number): Promise<{ price: any; supplier: any }> {
  const spec = db.prepare('SELECT id, raw_data FROM specifications WHERE project_id = ?').get(PID) as { id: number; raw_data: string };
  const rawRows: unknown[][] = JSON.parse(spec.raw_data);
  const width = rawRows.reduce((w, r) => Math.max(w, (r as unknown[]).length), 0);
  const items = db.prepare('SELECT id, name FROM specification_items WHERE specification_id = ? ORDER BY id').all(spec.id) as Array<{ id: number; name: string }>;
  const { matched } = matchItemsToRawRows(rawRows, items);
  const rowIdx = matched.get(specItemId);
  const res = await call(exportOriginalRouter, '/api/projects/:id/export-original', 'get', P);
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const formRows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets['Форма'], { header: 1, raw: true, defval: null });
  if (rowIdx === undefined) return { price: undefined, supplier: undefined };
  const row = formRows[rowIdx];
  return { price: row[width], supplier: row[width + 1] };
}

async function main(): Promise<void> {
  console.log(`база ${path.basename(SRC_DB)} → ${path.basename(tmpDb)}, прайс ${path.basename(CSV_PATH)}`);

  await call(priceListsRouter, '/api/projects/:id/supplier-price', 'post', P, { supplier: 'Русклимат' }, {}, {
    originalname: path.basename(CSV_PATH), buffer: fs.readFileSync(CSV_PATH),
  });

  console.log('\n=== подготовка: позиция 7553 (VFG-2R) — выбираем вариант Русклимата ===');
  const items0 = await table();
  const row0 = items0.find(r => r.specItem.id === SPEC_ID);
  const rusklimat = (row0?.siteVariants ?? []).find((v: any) => Math.abs((v.price ?? 0) - 128880.07) < 0.01);
  if (!rusklimat) {
    check('нашли вариант Русклимата 128880.07 для позиции 7553 — данные не изменились?', false, row0);
  } else {
    await call(matchingRouter, '/api/matching/select/:id', 'put', { id: String(rusklimat.id) });
    check('вариант Русклимата выбран (is_selected=1)', matchRow(rusklimat.id).is_selected === 1);

    console.log('\n=== 1а. «✓» /confirm на неподтверждённом кандидате счёта той же позиции ===');
    const c1 = insertUnconfirmedCandidate('confirm');
    await call(matchingRouter, '/api/matching/:id/confirm', 'put', { id: String(c1.matchId) });
    const m1 = matchRow(c1.matchId);
    check(`счёт подтверждён (is_confirmed=${m1.is_confirmed}), не стал выбранным (is_selected=${m1.is_selected})`,
      m1.is_confirmed === 1 && m1.is_selected === 0);
    check('вариант Русклимата остался выбранным после /confirm', matchRow(rusklimat.id).is_selected === 1);

    console.log('\n=== 1б. «Аналог» /confirm-analog на неподтверждённом кандидате той же позиции ===');
    const c2 = insertUnconfirmedCandidate('confirm-analog');
    await call(matchingRouter, '/api/matching/:id/confirm-analog', 'post', { id: String(c2.matchId) });
    const m2 = matchRow(c2.matchId);
    check(`счёт подтверждён как аналог (is_confirmed=${m2.is_confirmed}, is_analog=${m2.is_analog}), не стал выбранным (is_selected=${m2.is_selected})`,
      m2.is_confirmed === 1 && m2.is_analog === 1 && m2.is_selected === 0);
    check('вариант Русклимата остался выбранным после /confirm-analog', matchRow(rusklimat.id).is_selected === 1);

    console.log('\n=== 1в. bulk/confirm на неподтверждённом кандидате той же позиции ===');
    const c3 = insertUnconfirmedCandidate('bulk-confirm');
    await call(matchingRouter, '/api/matching/bulk/confirm', 'post', {}, { matchIds: [c3.matchId] });
    const m3 = matchRow(c3.matchId);
    check(`счёт подтверждён (is_confirmed=${m3.is_confirmed}), не стал выбранным (is_selected=${m3.is_selected})`,
      m3.is_confirmed === 1 && m3.is_selected === 0);
    check('вариант Русклимата остался выбранным после bulk/confirm', matchRow(rusklimat.id).is_selected === 1);

    console.log('\n=== 1г. подтверждение группы дублей (group-confirm), 7553 — лидер ===');
    // Синтетический follower: копия строки 7553 (то же имя+DN → тот же ключ дубль-группы),
    // без матчей — сразу попадёт в «skipped», это ок: нас интересует только поведение лидера.
    const specRow = db.prepare('SELECT project_id, specification_id, name, full_name, position_number, unit, quantity, section FROM specification_items WHERE id = ?').get(SPEC_ID) as any;
    const follower = db.prepare(`
      INSERT INTO specification_items (project_id, specification_id, name, full_name, position_number, unit, quantity, section)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).get(specRow.project_id, specRow.specification_id, specRow.name, specRow.full_name, specRow.position_number, specRow.unit, specRow.quantity, specRow.section) as any;
    const c4 = insertUnconfirmedCandidate('group-confirm');
    const groupRes = await call(matchingRouter, '/api/projects/:id/matching/group-confirm', 'post', { id: String(PID) }, { leaderMatchId: c4.matchId });
    check(`group-confirm нашёл дубль-группу размера 2, лидер 7553 (groupSize=${groupRes.payload.groupSize}, leaderSpecItemId=${groupRes.payload.leaderSpecItemId})`,
      groupRes.payload.groupSize === 2 && groupRes.payload.leaderSpecItemId === SPEC_ID, groupRes.payload);
    const m4 = matchRow(c4.matchId);
    check(`счёт-лидер подтверждён (is_confirmed=${m4.is_confirmed}), не стал выбранным (is_selected=${m4.is_selected})`,
      m4.is_confirmed === 1 && m4.is_selected === 0);
    check('вариант Русклимата остался выбранным после group-confirm', matchRow(rusklimat.id).is_selected === 1);
    // Уборка: синтетический follower выполнил свою роль (сформировал дубль-группу) — убираем
    // его, чтобы не путать позиционную нумерацию /export и сопоставление строк /export-original.
    db.prepare('DELETE FROM specification_items WHERE id = ?').run(follower.id);

    console.log('\n=== 1д. /export и /export-original по-прежнему отдают цену и поставщика Русклимата ===');
    const exp = await exportRow(SPEC_ID);
    check(`/export: цена ${exp.price} = 128880.07, поставщик «${exp.supplier}» = «Русклимат»`,
      Math.abs(Number(exp.price) - 128880.07) < 0.01 && exp.supplier === 'Русклимат', exp);
    const expOrig = await exportOriginalRow(SPEC_ID);
    check(`/export-original: цена ${expOrig.price} = 128880.07, поставщик «${expOrig.supplier}» = «Русклимат»`,
      Math.abs(Number(expOrig.price) - 128880.07) < 0.01 && expOrig.supplier === 'Русклимат', expOrig);
  }

  console.log('\n=== 2. позиция БЕЗ выбранного варианта: /confirm — прежнее поведение ===');
  const items2 = await table();
  const plainRow = items2.find(r => r.specItem.id !== SPEC_ID && (r.siteVariants?.length ?? 0) === 0);
  if (!plainRow) {
    check('нашлась позиция без варианта цены для сценария 2', false);
  } else {
    // свой синтетический неподтверждённый кандидат — как в сценарии 1, но на позиции без варианта
    const plain = insertUnconfirmedCandidate('plain-confirm', plainRow.specItem.id);
    await call(matchingRouter, '/api/matching/:id/confirm', 'put', { id: String(plain.matchId) });
    const mPlain = matchRow(plain.matchId);
    check(`без варианта: /confirm подтвердил (is_confirmed=${mPlain.is_confirmed}) И сам стал выбранным (is_selected=${mPlain.is_selected}) — прежнее поведение`,
      mPlain.is_confirmed === 1 && mPlain.is_selected === 1);
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
