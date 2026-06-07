/**
 * ФИКС-РАУНД 1 — детерминированный red->green тест двух фиксов (feedback_no_corrupt_through).
 * Запуск:  cd backend && npx ts-node --transpile-only test_bulk_spec_hardblock_integration.ts
 *
 * FIX-1 (bulk-эндпоинт применяет hardBlock): прогоняем НАСТОЯЩИЙ обработчик
 *   POST /api/projects/:id/specifications/bulk на двух PDF в одном батче — один парсится в
 *   hardBlock (всё голые DN), другой чистый. Проверяем: битый НЕ записан в specification_items
 *   + понятная ошибка по файлу; чистый — записан; батч не падает целиком.
 *   Извлечение PDF инжектируется (parseSpecFromPdf застаблен), НО hardBlock считается РЕАЛЬНОЙ
 *   evaluateSpecPdfParseQuality на РЕАЛЬНЫХ mapPdfItemsToRows-строках, а запись/скип в БД —
 *   настоящий код роута. Транспорт (multer/HTTP) намеренно в обход — как в test_vat_upload_integration.ts
 *   (там тоже dependency инжектируется, а боевая логика пайплайна — настоящая). Меняли мы тело
 *   обработчика, а не multer.
 *
 * FIX-2 (hardBlock не кешируется навсегда): cacheSpecParseResult(hardBlock) НЕ пишет кеш под
 *   sha256(файла) → повторная загрузка того же PDF снова пойдёт по LLM-пути (cache miss);
 *   cacheSpecParseResult(ok) пишет кеш как раньше.
 *
 * RED без фиксов:
 *   FIX-1 откатан -> битый PDF вставляется -> 2 specifications, 13 specification_items -> ассерты падают.
 *   FIX-2 откатан -> cacheSpecParseResult пишет hardBlock -> count(hash)=1 -> ассерт падает.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

// DATABASE_PATH / UPLOAD_PATH должны быть выставлены ДО загрузки connection.ts/fileUtils.ts
// (оба резолвят путь на этапе импорта). dotenv НЕ перетирает уже выставленные переменные.
const tmpDb = path.join(os.tmpdir(), `bulk_hardblock_${process.pid}_${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.UPLOAD_PATH = path.join(os.tmpdir(), `bulk_hardblock_uploads_${process.pid}`);

/* eslint-disable @typescript-eslint/no-var-requires */
// 1) Сначала берём сервис парсера и СТАБим parseSpecFromPdf (роут читает свойство модуля
//    в момент вызова, поэтому патч свойства срабатывает). mapPdfItemsToRows / cacheSpecParseResult
//    остаются настоящими.
const specSvc = require('./src/services/gigachatSpecFromPdf');
const { mapPdfItemsToRows, cacheSpecParseResult } = specSvc;
const { evaluateSpecPdfParseQuality } = require('./src/services/gigachatSpecParseQuality');
const { sha256File } = require('./src/services/gigachatFileCache');

// Сырые items в стиле ответа LLM (с полем position) — реальный mapPdfItemsToRows их перемелет.
const CLEAN_ITEMS = [
  { position: 1, name: 'Радиатор стальной панельный тип 22 500x1000', unit: 'шт', quantity: 4 },
  { position: 2, name: 'Конвектор отопительный напольный КН-20', unit: 'шт', quantity: 2 },
  { position: 3, name: 'Коллектор распределительный на 6 контуров', unit: 'шт', quantity: 1 },
];
// Голые фрагменты «Кран DN15» (<=12 симв. -> bare orphan -> hardBlock=true), но при этом
// детектируемые как раздел ВК (ключ 'кран'). Это критично: без них битый файл случайно
// отсёкся бы гейтом раздела (no_section) и не дошёл бы до вставки — тогда ассерты «не записан»
// были бы не нагруженными. С разделом ВК битый файл БЕЗ FIX-1 реально вставился бы (leak).
const BARE_DN_ITEMS = Array.from({ length: 10 }, (_, i) => ({
  position: null,
  name: `Кран DN${15 + i * 5}`,
  unit: 'шт',
  quantity: 1,
}));

function buildResult(rawItems: any[]) {
  const items = mapPdfItemsToRows({ items: rawItems });
  const specParseQuality = evaluateSpecPdfParseQuality(rawItems, items);
  return { items, errors: [], totalRows: items.length, skippedRows: 0, specParseQuality };
}

// Стаб: решает по содержимому файла (порядконезависимо), результат строит РЕАЛЬНЫЙ гейт.
specSvc.parseSpecFromPdf = async (filePath: string) => {
  const content = fs.readFileSync(filePath, 'utf-8');
  return buildResult(content.includes('BROKEN') ? BARE_DN_ITEMS : CLEAN_ITEMS);
};

// 2) Теперь поднимаем БД и роут (роут увидит уже застабленный parseSpecFromPdf).
const { initializeDatabase, getDatabase, closeDatabase } = require('./src/database');
const specRouter = require('./src/routes/specifications').default;

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`); failures++; }
}

/** Достаём боевой обработчик bulk-роута из стека express-роутера (multer-слой в обход). */
function findBulkHandler(router: any): (req: any, res: any) => Promise<void> {
  for (const layer of router.stack) {
    const route = layer.route;
    if (route && route.path === '/api/projects/:id/specifications/bulk' && route.methods && route.methods.post) {
      const sub = route.stack;
      return sub[sub.length - 1].handle; // последний под-слой = обработчик (после multer)
    }
  }
  throw new Error('bulk handler не найден в router.stack');
}

function makeRes() {
  const res: any = { statusCode: 200, payload: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.payload = b; return res; };
  return res;
}

const tmpFiles: string[] = [];
function writeTmp(name: string, content: string): string {
  const p = path.join(os.tmpdir(), `bulk_hb_${process.pid}_${name}`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

function cleanup(): void {
  try { closeDatabase(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ }
  }
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(process.env.UPLOAD_PATH as string, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  initializeDatabase();
  const db = getDatabase();

  // Преконтроль: гейт действительно классифицирует наши синтетические items как ожидаем
  // (иначе тест бессмысленен — доказываем РЕАЛЬНУЮ работу evaluateSpecPdfParseQuality).
  const bareQ = buildResult(BARE_DN_ITEMS).specParseQuality;
  const cleanQ = buildResult(CLEAN_ITEMS).specParseQuality;
  check('0a: голые DN -> hardBlock=true (реальный гейт)', bareQ.hardBlock === true, `bareOrphan=${bareQ.bareOrphanFraction}`);
  check('0b: чистая спека -> hardBlock=false (реальный гейт)', cleanQ.hardBlock === false, `bareOrphan=${cleanQ.bareOrphanFraction}`);

  // ── FIX-1: bulk применяет hardBlock ───────────────────────────────────────────────────
  const projectId = Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run('bulk hardblock integ').lastInsertRowid);

  const brokenPath = writeTmp('broken.pdf', 'BROKEN-PDF-CONTENT');
  const cleanPath = writeTmp('sample.pdf', 'CLEAN-PDF-CONTENT');

  const handler = findBulkHandler(specRouter);
  const req: any = {
    params: { id: String(projectId) },
    files: [
      { path: brokenPath, originalname: 'broken.pdf' },
      { path: cleanPath, originalname: 'sample.pdf' },
    ],
    body: {},
  };
  const res = makeRes();
  await handler(req, res);

  check('1a: bulk вернул 200 (батч не упал из-за битого файла)', res.statusCode === 200, `status=${res.statusCode}`);
  const out = res.payload || {};
  const results = out.results || [];
  check('1b: в ответе 2 файла', results.length === 2, `got ${results.length}`);

  const broken = results.find((r: any) => r.fileName === 'broken.pdf') || {};
  const clean = results.find((r: any) => r.fileName === 'sample.pdf') || {};

  check('2a: битый файл помечен quality_block', broken.status === 'quality_block', `status=${broken.status}`);
  check('2b: битый файл imported=0', broken.imported === 0, `imported=${broken.imported}`);
  check('2c: по битому файлу понятная ошибка оператору',
    typeof broken.error === 'string' && /Спека не распарсилась корректно/.test(broken.error), `error=${broken.error}`);

  check('3a: чистый файл status=ok', clean.status === 'ok', `status=${clean.status}, error=${clean.error}`);
  check('3b: чистый файл imported=3', clean.imported === 3, `imported=${clean.imported}`);
  check('3c: чистый файл раздел Отопление', clean.section === 'Отопление', `section=${clean.section}`);

  // Сквозная проверка БД: записан ТОЛЬКО чистый — битый НЕ протёк в матчер/обучение.
  const specCount = (db.prepare('SELECT COUNT(*) c FROM specifications').get() as any).c;
  const itemCount = (db.prepare('SELECT COUNT(*) c FROM specification_items').get() as any).c;
  const dnLeak = (db.prepare("SELECT COUNT(*) c FROM specification_items WHERE name LIKE '%DN%'").get() as any).c;
  const vkSpecs = (db.prepare("SELECT COUNT(*) c FROM specifications WHERE section = 'ВК'").get() as any).c;
  check('4a: в БД ровно 1 спецификация (только чистая)', specCount === 1, `got ${specCount} (если 2 — битый PDF протёк = FIX-1 не сработал)`);
  check('4b: в БД ровно 3 позиции (только чистые)', itemCount === 3, `got ${itemCount}`);
  check('4c: ни одной голой DN-строки в specification_items', dnLeak === 0, `got ${dnLeak} DN-строк (битые позиции в обучении)`);
  check('4e: нет спецификации раздела ВК (битый файл детектировался как ВК, но не записан)', vkSpecs === 0, `got ${vkSpecs}`);

  const summary = out.summary || {};
  check('4d: summary ok=1 / totalImported=3', summary.ok === 1 && summary.totalImported === 3, `summary=${JSON.stringify(summary)}`);

  // ── FIX-2: hardBlock не кешируется, ok кешируется ──────────────────────────────────────
  const hardFile = writeTmp('cache_hard.bin', 'HARDBLOCK-CACHE-PROBE');
  const okFile = writeTmp('cache_ok.bin', 'OK-CACHE-PROBE');
  const hardRes = buildResult(BARE_DN_ITEMS);   // hardBlock=true
  const okRes = buildResult(CLEAN_ITEMS);       // hardBlock=false

  cacheSpecParseResult(hardFile, hardRes);
  cacheSpecParseResult(okFile, okRes);

  const hardHash = sha256File(hardFile);
  const okHash = sha256File(okFile);
  const cnt = (h: string) => (db.prepare('SELECT COUNT(*) c FROM gigachat_file_cache WHERE file_hash = ?').get(h) as any).c;

  check('5a: hardBlock-результат НЕ записан в кеш (ретрай снова пойдёт в LLM)', cnt(hardHash) === 0, `rows=${cnt(hardHash)} (если 1 — кеш ловит 422 навсегда = FIX-2 не сработал)`);
  check('5b: ok-результат записан в кеш (успешные парсы кешируются как раньше)', cnt(okHash) === 1, `rows=${cnt(okHash)}`);

  // То, что битого нет в кеше под его sha256 = верхний cache-read parseSpecFromPdf промахнётся
  // -> повторный аплоад ТОГО ЖЕ файла снова пройдёт pdfplumber->LLM (не отдаст мгновенный 422).
  const okRow = db.prepare('SELECT response_json FROM gigachat_file_cache WHERE file_hash = ?').get(okHash) as any;
  const okParsed = okRow ? JSON.parse(okRow.response_json) : null;
  check('5c: закешированный ok-результат валиден (есть items)', !!okParsed && Array.isArray(okParsed.items) && okParsed.items.length === 3, `items=${okParsed?.items?.length}`);

  console.log('');
  if (failures > 0) { console.error(`${failures} assertion(s) FAILED`); process.exitCode = 1; }
  else console.log('All FIX-ROUND 1 (bulk hardBlock + no-cache hardBlock) assertions passed');
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; }).finally(cleanup);
