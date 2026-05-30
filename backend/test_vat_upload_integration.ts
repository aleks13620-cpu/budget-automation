/**
 * ИНТЕГРАЦИОННЫЙ red→green тест Фичи #1 на UPLOAD-пути (а не только юнит).
 * Запуск: cd backend && npx ts-node --transpile-only test_vat_upload_integration.ts
 *
 * Зачем: normalizeParsedRowsForSupplierVat жил только в routeInvoiceFile, а PDF-загрузка идёт
 * через processInvoiceFile (минует routeInvoiceFile) → фикс не срабатывал на PDF. Этот тест
 * прогоняет НАСТОЯЩИЙ processInvoiceFile со структурой счёта 42 (нетто «Цена без НДС» + брутто
 * «Сумма с НДС», поставщик prices_include_vat=0) и проверяет, что на выходе в invoice_items
 * НДС учтён РОВНО ОДИН РАЗ (amount нормализован брутто→нетто; unit с НДС = напечатанному),
 * а не ×1.22 лишних. Извлечение текста инжектируется (extractedOverride) — детерминированно,
 * без зависимости от шрифтов/качества PDF; ВСЯ остальная логика upload-пайплайна — настоящая.
 *
 * RED (если убрать вызов normalizeParsedRowsForSupplierVat из processInvoiceFile): amount
 * сохранится брутто (1220) → unit = 1220×1.22 = 1488.4 (двойной НДС) → ассерты ниже падают.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

// DATABASE_PATH должен быть выставлен ДО загрузки connection.ts (он резолвит путь на этапе импорта),
// поэтому подключаем приложение через require() уже после установки env.
const tmpDb = path.join(os.tmpdir(), `vat_upload_test_${process.pid}_${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;

/* eslint-disable @typescript-eslint/no-var-requires */
const { initializeDatabase, getDatabase, closeDatabase } = require('./src/database');
const { processInvoiceFile } = require('./src/routes/invoices');

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`); failures++; }
}

// Зеркало derived_unit-ветки computeUnitPriceWithVat (invoices.ts:101) для проверки сквозной цифры.
function readUnitWithVat(amount: number | null, qty: number | null, flag: number | null, rate: number | null): number | null {
  if (amount != null && qty != null && qty > 0) {
    const line = flag === 0 && rate != null && rate > 0 ? amount * (1 + rate / 100) : amount;
    return Math.round((line / qty) * 100) / 100;
  }
  return null;
}

function cleanup(): void {
  try { closeDatabase(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  initializeDatabase();
  const db = getDatabase();

  // Проект + поставщик с prices_include_vat=0 (нетто-цены), vat_rate=22.
  // Имя ASCII — чтобы резолв по имени файла не зависел от multer/latin1-«починки» fixFilename
  // (имя поставщика на инвариант НДС не влияет, важен только флаг prices_include_vat).
  const projectId = Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run('VAT-once integ').lastInsertRowid);
  db.prepare('INSERT INTO suppliers (name, vat_rate, prices_include_vat) VALUES (?, 22, 0)').run('Rashvork');

  // Структура счёта 42: «Цена без НДС» (нетто) + «Сумма с НДС» (брутто). Имя поставщика в тексте
  // не распознаётся → processInvoiceFile резолвит поставщика по имени файла (LIKE %Рашворк%).
  const rows = [
    ['№', 'Наименование', 'Кол-во', 'Цена без НДС', 'Сумма с НДС'],
    ['1', 'Клапан КПУ-2Н', '1', '1000', '1220'],
    ['2', 'Клапан КПУ-3О', '2', '2000', '4880'],
  ];
  const fullText = rows.map(r => r.join('  ')).join('\n') + '\nИтого с НДС 6100';

  // file.path должен существовать как строка; содержимое не читается (извлечение инжектируем).
  const fakePdf = path.join(os.tmpdir(), `vat_upload_${process.pid}.pdf`);
  fs.writeFileSync(fakePdf, '%PDF-1.4\n');

  const res = await processInvoiceFile(
    { originalname: 'Rashvork_invoice42.pdf', path: fakePdf },
    projectId,
    db,
    { extractedOverride: { rows, fullText } },
  );

  // 0. Парсинг отработал и поставщик резолвнут с флагом 0 (иначе тест бессмысленен).
  check('0a: импортировано 2 позиции', res.imported === 2, `imported=${res.imported}`);
  const inv = db.prepare('SELECT id, supplier_id, needs_amount_review, vat_rate FROM invoices WHERE id = ?').get(res.invoiceId) as any;
  const sup = inv ? db.prepare('SELECT prices_include_vat, vat_rate FROM suppliers WHERE id = ?').get(inv.supplier_id) as any : null;
  check('0b: поставщик резолвнут и prices_include_vat=0', sup?.prices_include_vat === 0, `supplier=${JSON.stringify(sup)}`);

  const items = db.prepare('SELECT row_index, name, quantity, price, amount FROM invoice_items WHERE invoice_id = ? ORDER BY row_index').all(res.invoiceId) as any[];
  check('1: 2 строки в invoice_items', items.length === 2, `got ${items.length}`);

  const r1 = items[0] || {};
  const r2 = items[1] || {};

  // 2. Ядро: amount нормализован брутто(1220)→нетто(1000) на upload-пути.
  check('2a: row1 amount нормализован 1220→1000', r1.amount === 1000, `got ${r1.amount} (если 1220 — нормализация НЕ вызвана на upload-пути)`);
  check('2b: row2 amount нормализован 4880→4000', r2.amount === 4000, `got ${r2.amount}`);

  // 3. Сквозная цифра: unit_price_with_vat = НДС ровно один раз = напечатанному, не ×1.22 лишних.
  const u1 = readUnitWithVat(r1.amount, r1.quantity, 0, 22);
  const u2 = readUnitWithVat(r2.amount, r2.quantity, 0, 22);
  check('3a: row1 unit с НДС = 1220 (один раз), не 1488.4', u1 === 1220, `got ${u1}`);
  check('3b: row2 unit с НДС = 2440 (один раз), не 2976.8', u2 === 2440, `got ${u2}`);
  check('3c: строка-итог row1 = напечатанной «Сумме с НДС» 1220', u1 !== null && Math.round(u1 * r1.quantity * 100) / 100 === 1220, `got ${u1 !== null ? u1 * r1.quantity : null}`);

  // 4. Конфликт колонка↔флаг помечен на review.
  check('4: needs_amount_review выставлен', inv?.needs_amount_review === 1, `got ${inv?.needs_amount_review}`);

  console.log('');
  if (failures > 0) { console.error(`${failures} assertion(s) FAILED`); process.exitCode = 1; }
  else console.log('All VAT upload-path integration assertions passed');
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; }).finally(cleanup);
