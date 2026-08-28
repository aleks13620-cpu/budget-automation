/**
 * Ф1.1 — подпись слоя 1 на экране и число строк «Интернет» в выгрузке должны совпадать.
 * Запуск:  cd backend && npx ts-node --transpile-only test_layer1_counter_vs_export.ts
 *
 * Зачем тест существует. Правило «показываем интернет-цену только там, где нет цены из счёта»
 * записано ДВАЖДЫ: в routes/export.ts оно наполовину в SQL, наполовину в JS
 * (`item.price == null && item.ext_price != null`), в routes/priceSearch.ts — целиком в SQL
 * (NOT EXISTS). Свести их в одно место дешевле не выходит, поэтому дубль сделан обнаруживаемым:
 * тест считает ОБА числа настоящими обработчиками на одной базе и падает, когда они разойдутся.
 *
 * Считаются числа, которые видит Иван: подпись «нашли цену у N» из GET /spec-groups и строки
 * с «Тип = Интернет» в скачанном xlsx.
 *
 * RED без правки: случай 2 даёт экран 44, файл 43 — подпись обещает позицию, которой в файле нет.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

// DATABASE_PATH должен быть выставлен ДО загрузки connection.ts — он резолвит путь при импорте.
const SRC_DB = path.resolve(__dirname, '..', 'database', 'budget_automation.db');
const tmpDb = path.join(os.tmpdir(), `layer1_cmp_${process.pid}_${Date.now()}.db`);
fs.copyFileSync(SRC_DB, tmpDb);
process.env.DATABASE_PATH = tmpDb;

/* eslint-disable @typescript-eslint/no-var-requires */
const XLSX = require('xlsx');
const { getDatabase, closeDatabase } = require('./src/database/connection');
const priceSearchRouter = require('./src/routes/priceSearch').default;
const exportRouter = require('./src/routes/export').default;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`); }
}

/** Обработчик настоящего роута по пути и методу — как в test_bulk_spec_hardblock_integration.ts. */
function findHandler(router: any, routePath: string, method: 'get' | 'post'): any {
  for (const layer of router.stack) {
    const route = layer.route;
    if (route && route.path === routePath && route.methods && route.methods[method]) {
      const sub = route.stack;
      return sub[sub.length - 1].handle;
    }
  }
  throw new Error(`обработчик ${method.toUpperCase()} ${routePath} не найден`);
}

function makeRes() {
  const res: any = { statusCode: 200, payload: undefined, buffer: undefined, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.send = (b: any) => { res.buffer = b; return res; };
  res.end = (b: any) => { res.buffer = b ?? res.buffer; return res; };
  return res;
}

const groupsHandler = findHandler(priceSearchRouter, '/api/projects/:id/spec-groups', 'get');
const exportHandler = findHandler(exportRouter, '/api/projects/:id/export', 'get');

/** Подпись слоя 1 на экране проекта. */
async function screenWithPrice(projectId: number): Promise<number> {
  const res = makeRes();
  await groupsHandler({ params: { id: String(projectId) }, query: {} } as any, res);
  if (res.statusCode !== 200) throw new Error(`spec-groups вернул ${res.statusCode}`);
  return res.payload.layer1.withPrice;
}

/** Строки «Тип = Интернет» в скачанном файле. */
async function fileInternetRows(projectId: number): Promise<number> {
  const res = makeRes();
  await exportHandler({ params: { id: String(projectId) }, query: {} } as any, res);
  if (res.statusCode !== 200) throw new Error(`export вернул ${res.statusCode}`);
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const head = rows.findIndex((r) => Array.isArray(r) && r[0] === '№' && r[1] === 'Наименование');
  if (head < 0) throw new Error('шапка таблицы в выгрузке не найдена');
  const typeCol = rows[head].indexOf('Тип');
  if (typeCol < 0) throw new Error('колонка «Тип» в выгрузке не найдена');
  return rows.slice(head + 1).filter((r) => Array.isArray(r) && r[typeCol] === 'Интернет').length;
}

const db = getDatabase();

// Проект, по которому реально гонялся поиск цен.
const PROJECT = (db.prepare(
  `SELECT si.project_id AS pid FROM external_prices ep
     JOIN specification_items si ON si.id = ep.spec_item_id
    WHERE ep.source = 'web_search' AND ep.status = 'found'
    GROUP BY si.project_id ORDER BY COUNT(*) DESC LIMIT 1`,
).get() as any)?.pid;

/** Позиция проекта, у которой ЕСТЬ интернет-цена в последнем срезе и НЕТ сопоставления. */
function itemWithInternetPrice(): number {
  return (db.prepare(
    `SELECT ep.spec_item_id AS id FROM external_prices ep
       JOIN specification_items si ON si.id = ep.spec_item_id
      WHERE ep.source = 'web_search' AND ep.status = 'found' AND si.project_id = ?
        AND NOT EXISTS (SELECT 1 FROM matched_items m
                         WHERE m.specification_item_id = ep.spec_item_id AND m.is_selected = 1)
      ORDER BY ep.spec_item_id LIMIT 1`,
  ).get(PROJECT) as any).id;
}

/** Выбранное сопоставление со счётом на позицию; price=null — счёт без цены. */
function addSelectedMatch(specItemId: number, price: number | null): void {
  const inv = db.prepare(
    `INSERT INTO invoices (project_id, supplier_id, invoice_number, invoice_date, total_amount)
     VALUES (?, NULL, ?, date('now'), 0)`,
  ).run(PROJECT, `Ф1.1-тест-${specItemId}`);
  const item = db.prepare(
    `INSERT INTO invoice_items (invoice_id, name, quantity, price, amount)
     VALUES (?, 'позиция из счёта', 1, ?, 0)`,
  ).run(inv.lastInsertRowid, price);
  db.prepare(
    `INSERT INTO matched_items (specification_item_id, invoice_item_id, source, is_selected, confidence)
     VALUES (?, ?, 'invoice', 1, 1.0)`,
  ).run(specItemId, item.lastInsertRowid);
}

async function main(): Promise<void> {
  // Тест опирается на живую базу разработчика: нужен проект, по которому реально гонялся
  // поиск цен. На чистом клоне репозитория его нет — тогда честнее сказать «нечего проверять»,
  // чем упасть стеком на undefined и выглядеть поломкой кода.
  if (!PROJECT) {
    console.log('в базе нет проекта с прогоном поиска цен — проверять нечего, пропуск');
    return;
  }
  console.log(`проект ${PROJECT}, база ${path.basename(tmpDb)}`);

  console.log('\n=== 1. как есть: экран и файл говорят одно ===');
  const a0 = await screenWithPrice(PROJECT);
  const b0 = await fileInternetRows(PROJECT);
  check(`экран ${a0} = файл ${b0}`, a0 === b0, { экран: a0, файл: b0 });
  check('числа не нулевые, иначе проверка ничего не значит', a0 > 0, a0);

  console.log('\n=== 2. позицию подтвердили счётом С ЦЕНОЙ — она уходит из обоих ===');
  const priced = itemWithInternetPrice();
  addSelectedMatch(priced, 12345);
  const a1 = await screenWithPrice(PROJECT);
  const b1 = await fileInternetRows(PROJECT);
  check(`экран ${a1} = файл ${b1}`, a1 === b1, { экран: a1, файл: b1 });
  check(`счёт уменьшился на 1 (${a0} → ${a1})`, a1 === a0 - 1, { было: a0, стало: a1 });

  console.log('\n=== 3. отрицательный контроль: счёт БЕЗ цены не исключает позицию ===');
  const unpriced = itemWithInternetPrice();
  addSelectedMatch(unpriced, null);
  const a2 = await screenWithPrice(PROJECT);
  const b2 = await fileInternetRows(PROJECT);
  check(`экран ${a2} = файл ${b2}`, a2 === b2, { экран: a2, файл: b2 });
  check(`счёт НЕ изменился (${a1} → ${a2})`, a2 === a1, { было: a1, стало: a2 });

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ }
    }
    process.exit(fail === 0 ? 0 : 1);
  });
