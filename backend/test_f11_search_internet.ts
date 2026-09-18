/**
 * Ф11 — галочка Ивана «Искать по всему интернету» на кнопке «Найти цены».
 * Запуск: cd backend && npx ts-node --transpile-only test_f11_search_internet.ts
 *
 * Критерии:
 *   1. POST без тела → колонка price_search_jobs.search_internet = 1, jobs/next отдаёт
 *      job.searchInternet = true.
 *   2. POST {searchInternet: false} → колонка = 0, jobs/next отдаёт job.searchInternet = false.
 *   3. Повторный initializeDatabase() не ломается (миграция идемпотентна).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `f11_search_internet_${process.pid}_${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.ENABLE_OPENROUTER_LLM_MATCHING = '';

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDatabase, closeDatabase } = require('./src/database/connection');
const { initializeDatabase } = require('./src/database/init');
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
  initializeDatabase();

  const db = getDatabase();
  const projectId = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Ф11 тест')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO specification_items (project_id, name) VALUES (?, 'Позиция 1')`).run(projectId);

  console.log('\n=== 1. POST без тела -> search_internet = 1, jobs/next.searchInternet = true ===');
  const post1 = await call(priceSearchRouter, '/api/projects/:id/price-search', 'post', { id: String(projectId) });
  check(`POST без тела -> 200 (факт ${post1.statusCode})`, post1.statusCode === 200, post1.payload);
  const row1 = db.prepare('SELECT search_internet FROM price_search_jobs WHERE id = ?').get(post1.payload.jobId) as any;
  check(`колонка search_internet = 1 (факт ${row1?.search_internet})`, row1?.search_internet === 1, row1);

  const next1 = await call(priceSearchRouter, '/api/price-search/jobs/next', 'post', {});
  check(`jobs/next job.searchInternet = true (факт ${next1.payload?.job?.searchInternet})`,
    next1.payload?.job?.searchInternet === true, next1.payload?.job);
  db.prepare(`UPDATE price_search_jobs SET status = 'done', finished_at = datetime('now') WHERE id = ?`).run(post1.payload.jobId);

  console.log('\n=== 2. POST {searchInternet:false} -> search_internet = 0, jobs/next.searchInternet = false ===');
  const post2 = await call(priceSearchRouter, '/api/projects/:id/price-search', 'post', { id: String(projectId) }, { searchInternet: false });
  check(`POST {searchInternet:false} -> 200 (факт ${post2.statusCode})`, post2.statusCode === 200, post2.payload);
  const row2 = db.prepare('SELECT search_internet FROM price_search_jobs WHERE id = ?').get(post2.payload.jobId) as any;
  check(`колонка search_internet = 0 (факт ${row2?.search_internet})`, row2?.search_internet === 0, row2);

  const next2 = await call(priceSearchRouter, '/api/price-search/jobs/next', 'post', {});
  check(`jobs/next job.searchInternet = false (факт ${next2.payload?.job?.searchInternet})`,
    next2.payload?.job?.searchInternet === false, next2.payload?.job);

  console.log('\n=== 3. повторный init не ломает ===');
  let reinitOk = true;
  try { closeDatabase(); initializeDatabase(); } catch (e) { reinitOk = false; console.error(e); }
  check('повторный initializeDatabase() не бросает', reinitOk);
  const dbAfter = getDatabase();
  const cols = dbAfter.prepare('PRAGMA table_info(price_search_jobs)').all() as Array<{ name: string }>;
  check('колонка search_internet на месте после повторного init', cols.some(c => c.name === 'search_internet'), cols);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
