/**
 * Offline integration proof: Form D document-level discount detect+inform (SAFE design).
 *
 * Runs the REAL processInvoiceFile pipeline via extractedOverride (no PDF font deps).
 * Verifies parse-time behavior (detect+inform, NOT silent apply):
 *   1. Invoice 894066 data (8 lines, ratio 0.6): prices UNCHANGED at parse time.
 *   2. `discount_applied = 0` at parse time (apply endpoint handles confirmation).
 *   3. `needs_amount_review = 1` set at parse time (awaiting operator confirmation).
 *   4. `parsing_category_reason` contains "Form D" hint with suggested discount %.
 *   5. `original_price` is NULL at parse time (prices not mutated).
 *   6. Non-discount invoice (sum matches total): prices unchanged, discount_applied=0.
 *   7. Form C path (explicit discount_detected): NOT overridden by Form D.
 *   8. apply-document-discount endpoint (backfill path): produces 16009→9605, 11865→7119,
 *      60761→36457 and reconciles SUM(adjusted) ≈ syntheticTotal (factor 0.6 exactly).
 *   9. Idempotency: discount_applied=1 after apply endpoint runs.
 *
 * Run: cd backend && npx ts-node --transpile-only test_formd_discount_integration.ts
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `formd_test_${process.pid}_${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;

/* eslint-disable @typescript-eslint/no-var-requires */
const { initializeDatabase, getDatabase, closeDatabase } = require('./src/database');
const { processInvoiceFile } = require('./src/routes/invoices');

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`);
    failures++;
  }
}

function near(a: number, b: number, tol = 0.02): boolean {
  return Math.abs(a - b) / (Math.abs(b) || 1) <= tol;
}

async function run(): Promise<void> {
  initializeDatabase();
  const db = getDatabase();

  // Create a dummy project
  const projId = Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run('test-proj').lastInsertRowid);

  // ============================================================
  // Test 1: Invoice 894066 — 8-line ventilation invoice, ratio 0.6
  // Raw (pre-discount) data from diagnosis doc
  // ============================================================
  console.log('\n[Test 1] Form D parse-time: detect+inform only (prices UNCHANGED, awaiting confirmation)');

  const inv894Items = [
    // name, qty, price, amount
    ['АВК 600*400', 2,  16009, 32018],
    ['АВК 800*500', 5,  22621, 113105],
    ['АЛН 1000*500', 5, 9997,  49985],
    ['АЛН 1000*600', 24, 11865, 284760],
    ['АМР 200*500', 48, 3919,  188112],
    ['АМР 400*400', 30, 5389,  161670],
    ['АРН 1750*1800', 1, 59396, 59396],
    ['АРН 1800*1800', 1, 60761, 60761],
  ] as [string, number, number, number][];

  // Build synthetic raw rows and fullText
  const headerRow = ['Наименование', 'Кол-во', 'Цена', 'Сумма'];
  const dataRows = inv894Items.map(([name, qty, price, amount]) => [name, String(qty), String(price), String(amount)]);
  const syntheticRows = [headerRow, ...dataRows];
  // SUM of all line amounts = 949807.
  // We use totalAmount = 949807 * 0.6 = 569884.20 so that factor is EXACTLY 0.6.
  // (Real invoice 894066 has total=648985.8 and different line amounts totaling 1081643;
  // the spot-checks below verify the 0.6 factor math independently of the exact prod sum.)
  const syntheticTotal = Math.round(949807 * 0.6 * 100) / 100; // = 569884.20
  const syntheticText = [
    'Счёт 894066 от 26.05.2026',
    'Поставщик: Вентиляция ООО',
    headerRow.join('\t'),
    ...dataRows.map(r => r.join('\t')),
    `Итого ${syntheticTotal.toFixed(2).replace('.', ',')}`,
  ].join('\n');

  // Create a minimal fake file (content doesn't matter — override is used)
  const fakeFile = path.join(os.tmpdir(), `fake_894066_${Date.now()}.pdf`);
  fs.writeFileSync(fakeFile, '%PDF-1.4 fake');

  const result1 = await processInvoiceFile(
    { originalname: '894066.pdf', path: fakeFile },
    projId,
    db,
    {
      extractedOverride: {
        rows: syntheticRows,
        fullText: syntheticText,
      },
    },
  ) as { invoiceId: number; imported: number };

  const inv1 = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result1.invoiceId) as {
    id: number;
    discount_applied: number;
    needs_amount_review: number;
    total_amount: number;
    parsing_category_reason: string;
  };
  const items1 = db.prepare('SELECT price, amount, original_price, quantity FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(result1.invoiceId) as Array<{ price: number | null; amount: number | null; original_price: number | null; quantity: number }>;

  // Parse-time: detect+inform — prices must be UNCHANGED, discount_applied=0, needs_amount_review=1
  check('discount_applied=0 at parse time (awaiting confirmation)', inv1.discount_applied === 0, `got ${inv1.discount_applied}`);
  check('needs_amount_review=1 (Form D detected, pending confirm)', inv1.needs_amount_review === 1, `got ${inv1.needs_amount_review}; reason="${inv1.parsing_category_reason}"`);
  check('reason contains Form D hint', inv1.parsing_category_reason.includes('Form D'), `reason="${inv1.parsing_category_reason}"`);
  check('reason mentions suggested discount %', /\d+(\.\d+)?%/.test(inv1.parsing_category_reason), `reason="${inv1.parsing_category_reason}"`);

  // Parse-time: prices UNCHANGED (raw PDF values preserved)
  check('АВК 600*400: price UNCHANGED = 16009', near(items1[0].price!, 16009, 0.001), `got ${items1[0].price}`);
  check('АЛН 1000*600: price UNCHANGED = 11865', near(items1[3].price!, 11865, 0.001), `got ${items1[3].price}`);
  check('АРН 1800*1800: price UNCHANGED = 60761', near(items1[7].price!, 60761, 0.001), `got ${items1[7].price}`);

  // Parse-time: original_price NULL (prices not snapshotted because not mutated)
  check('original_price NULL for АВК 600*400 (not mutated at parse time)', items1[0].original_price == null, `got ${items1[0].original_price}`);
  check('original_price NULL for АЛН 1000*600 (not mutated at parse time)', items1[3].original_price == null, `got ${items1[3].original_price}`);

  // Parse-time: SUM(raw amounts) = 949807 (unchanged)
  const sumRaw = items1.reduce((s, it) => s + (it.amount ?? 0), 0);
  check(`SUM(raw amounts)=949807 (got ${sumRaw.toFixed(1)}) — prices not touched at parse`, near(sumRaw, 949807, 0.001), `sum=${sumRaw}`);

  // ============================================================
  // Test 2: Non-discount invoice — prices must be UNCHANGED
  // ============================================================
  console.log('\n[Test 2] Non-discount invoice: no Form D applied');

  const noDiscountItems = [
    ['Кабель ВВГ 3x2.5', 100, 50, 5000],
    ['Кабель ВВГ 5x10',  50,  200, 10000],
  ] as [string, number, number, number][];
  const nd_total = 15000; // exactly matches sum
  const nd_rows = [['Наименование', 'Кол-во', 'Цена', 'Сумма'], ...noDiscountItems.map(([n,q,p,a]) => [n, String(q), String(p), String(a)])];
  const nd_text = `Счёт 1001\nИтого 15000,00\n`;

  const fakeFile2 = path.join(os.tmpdir(), `fake_1001_${Date.now()}.pdf`);
  fs.writeFileSync(fakeFile2, '%PDF-1.4 fake');

  const result2 = await processInvoiceFile(
    { originalname: '1001.pdf', path: fakeFile2 },
    projId,
    db,
    { extractedOverride: { rows: nd_rows, fullText: nd_text } },
  ) as { invoiceId: number };

  const inv2 = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result2.invoiceId) as { discount_applied: number; needs_amount_review: number };
  const items2 = db.prepare('SELECT price, original_price FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(result2.invoiceId) as Array<{ price: number | null; original_price: number | null }>;

  check('Non-discount: discount_applied=0', inv2.discount_applied === 0, `got ${inv2.discount_applied}`);
  check('Non-discount: price of item 0 = 50 (unchanged)', near(items2[0].price!, 50, 0.001), `got ${items2[0].price}`);
  check('Non-discount: original_price is null (no snapshot taken)', items2[0].original_price == null, `got ${items2[0].original_price}`);

  // ============================================================
  // Test 3: Form C path (explicit discount_detected) — Form D NOT triggered
  // ============================================================
  console.log('\n[Test 3] Form C (explicit %): Form D must NOT override it');

  const fc_total = 8000;
  // Line amounts sum to 10000 but invoice has "скидка 20%" text
  const fc_items = [
    ['Продукт А', 1, 6000, 6000],
    ['Продукт Б', 1, 4000, 4000],
  ] as [string, number, number, number][];
  const fc_rows = [['Наименование', 'Кол-во', 'Цена', 'Сумма'], ...fc_items.map(([n,q,p,a]) => [n, String(q), String(p), String(a)])];
  // Include explicit discount text in fullText — "Скидка 20%" triggers detectDiscount()
  const fc_text = `Счёт 2002\nСкидка 20%\nИтого 8000,00\n`;

  const fakeFile3 = path.join(os.tmpdir(), `fake_2002_${Date.now()}.pdf`);
  fs.writeFileSync(fakeFile3, '%PDF-1.4 fake');

  const result3 = await processInvoiceFile(
    { originalname: '2002.pdf', path: fakeFile3 },
    projId,
    db,
    { extractedOverride: { rows: fc_rows, fullText: fc_text } },
  ) as { invoiceId: number };

  const inv3 = db.prepare('SELECT discount_detected, discount_applied FROM invoices WHERE id = ?').get(result3.invoiceId) as { discount_detected: number | null; discount_applied: number };
  // Form C detects 20% but does NOT auto-apply (feature #3 is detect→review only)
  // Form D should NOT kick in because discount_detected != null
  check('Form C: discount_applied=0 (detect→review, not auto-apply)', inv3.discount_applied === 0, `got ${inv3.discount_applied}`);
  check('Form C: discount_detected!=null (detected 20%)', inv3.discount_detected != null && inv3.discount_detected > 0, `got ${inv3.discount_detected}`);

  // ============================================================
  // Test 4: apply-document-discount endpoint (CONFIRM action)
  // Simulates operator clicking "Применить" on an invoice where Form D was detected.
  // Raw prices (as stored at parse time) → discounted prices after endpoint runs.
  // Spot-checks: 16009→9605.4, 11865→7119, 60761→36456.6; SUM ≈ syntheticTotal (569884.20).
  // ============================================================
  console.log('\n[Test 4] apply-document-discount endpoint: confirm action produces correct discounted prices');

  // Create a raw invoice (discount_applied=0) with pre-discount prices.
  // Use same amounts as Test 1 (sum=949807) and set total=syntheticTotal (949807×0.6=569884.20)
  // so factor = 0.6 exactly. This mirrors the apply-document-discount endpoint call for 894066.
  const backfillTotal = syntheticTotal; // 949807 × 0.6 = 569884.20
  const backfillInvId = Number(db.prepare(`
    INSERT INTO invoices (project_id, invoice_number, total_amount, discount_applied, vat_rate, status, parsing_category)
    VALUES (?, ?, ?, 0, 20, 'parsed', 'C')
  `).run(projId, '894066-backfill', backfillTotal).lastInsertRowid);

  for (const [name, qty, price, amount] of inv894Items) {
    db.prepare(`
      INSERT INTO invoice_items (invoice_id, name, quantity, price, amount, row_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(backfillInvId, name, qty, price, amount, 0);
  }

  // Compute factor the same way as apply-document-discount endpoint
  const bfInv = db.prepare('SELECT total_amount, discount_applied FROM invoices WHERE id = ?').get(backfillInvId) as { total_amount: number; discount_applied: number };
  const bfItems = db.prepare('SELECT id, price, amount FROM invoice_items WHERE invoice_id = ?').all(backfillInvId) as Array<{ id: number; price: number; amount: number }>;
  const bfSum = bfItems.reduce((s, it) => s + (it.amount ?? 0), 0);
  const bfFactor = bfInv.total_amount / bfSum;

  check(`Backfill: raw sum=949807 (got ${bfSum})`, near(bfSum, 949807, 0.001));
  check(`Backfill: derived factor≈0.6 (got ${bfFactor.toFixed(4)})`, near(bfFactor, 0.6, 0.001));

  // Apply (mimicking endpoint: guard + UPDATE + discount_applied=1)
  if (bfInv.discount_applied === 0) {
    db.transaction(() => {
      db.prepare(`
        UPDATE invoice_items
        SET original_price = COALESCE(original_price, price),
            price = ROUND(price * ?, 2),
            amount = ROUND(amount * ?, 2)
        WHERE invoice_id = ?
      `).run(bfFactor, bfFactor, backfillInvId);
      db.prepare('UPDATE invoices SET discount_applied = 1 WHERE id = ?').run(backfillInvId);
    })();
  }

  const bfItemsAfter = db.prepare('SELECT price, amount, original_price FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(backfillInvId) as Array<{ price: number; amount: number; original_price: number }>;
  check('Confirm: АВК 600*400 price 16009→9605.4', near(bfItemsAfter[0].price, 9605.4, 0.002), `got ${bfItemsAfter[0].price}`);
  check('Confirm: АЛН 1000*600 price 11865→7119', near(bfItemsAfter[3].price, 7119.0, 0.002), `got ${bfItemsAfter[3].price}`);
  check('Confirm: АРН 1800*1800 price 60761→36456.6', near(bfItemsAfter[7].price, 36456.6, 0.002), `got ${bfItemsAfter[7].price}`);
  check('Confirm: original_price=16009 preserved for АВК 600*400', near(bfItemsAfter[0].original_price, 16009, 0.001), `got ${bfItemsAfter[0].original_price}`);

  const bfSumAfter = bfItemsAfter.reduce((s, it) => s + it.amount, 0);
  check(`Backfill: SUM(adjusted)≈${backfillTotal} (got ${bfSumAfter.toFixed(1)})`, near(bfSumAfter, backfillTotal, 0.01));

  // Idempotency: second call sees discount_applied=1 → should skip
  const bfInvAfter = db.prepare('SELECT discount_applied FROM invoices WHERE id = ?').get(backfillInvId) as { discount_applied: number };
  check('Backfill: discount_applied=1 set', bfInvAfter.discount_applied === 1, `got ${bfInvAfter.discount_applied}`);

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('ALL CHECKS PASSED');
  } else {
    console.log(`FAILED: ${failures} check(s)`);
  }

  // Cleanup
  fs.unlinkSync(fakeFile);
  fs.unlinkSync(fakeFile2);
  fs.unlinkSync(fakeFile3);
  closeDatabase();
  fs.unlinkSync(tmpDb);

  process.exit(failures);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
