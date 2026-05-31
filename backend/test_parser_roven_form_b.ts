/**
 * RED→GREEN тест фикса C+B+A (РОВЕН form-B: скидка колонками, групп-подзаголовки,
 * многостраничность). Прогоняет БОЕВОЙ путь parsePdfFileWithExtraction (pdfplumber
 * через extract_invoice_table.py) на двух реальных счетах и сверяет с оракулом.
 *
 * Запуск: cd backend && npx ts-node --transpile-only test_parser_roven_form_b.ts
 *
 * До фикса (на проде): счёт 47 извлекал 54/81 строк (потеряна вся стр.1, qty/price/amount
 * съехали на «Сумма без скидки/Скидка/Сумма», 7 групп-подзаголовков как позиции, unit<1₽),
 * total_amount = gross. После фикса: 81 позиция, qty=Кол-во, price=ЦенаСоСкидкой(net),
 * amount=Сумма(net), unit=amount/qty=net, total_amount=net, group-leaks=0.
 * Счёт 5244 (якорь регрессии): 9 позиций, net unit 6579/2226.75/1707, total=net.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parsePdfFileWithExtraction } from './src/services/pdfParser';

const FIX_DIR = path.resolve(__dirname, 'tests/fixtures/roven-form-b');
const INV47 = path.join(FIX_DIR, 'roven_invoice_47.pdf');
const INV5244 = path.join(FIX_DIR, 'roven_invoice_5244.pdf');
const ORACLE = path.join(FIX_DIR, 'invoice_47_oracle.csv');
const TOL = 0.05; // ₽ — печатная Сумма авторитетна; строки 23/37 округлены ≤0.03

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`);
  }
}
const approx = (a: number | null | undefined, b: number, tol = TOL): boolean =>
  a != null && Math.abs(a - b) <= tol;

interface OracleRow {
  num: string; qty: number; priceNet: number; amountNet: number;
}
function loadOracle(): OracleRow[] {
  const lines = fs.readFileSync(ORACLE, 'utf-8').split(/\r?\n/);
  const out: OracleRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 8 || !cols[0].trim()) continue;
    out.push({
      num: cols[0].trim(),
      qty: parseFloat(cols[2]),
      priceNet: parseFloat(cols[4]),   // ЦенаСоСкидкой_net
      amountNet: parseFloat(cols[7]),  // Сумма_net
    });
  }
  return out;
}

async function main(): Promise<void> {
  // Гард на окружение: фикстуры + pdfplumber должны быть доступны.
  for (const f of [INV47, INV5244, ORACLE]) {
    if (!fs.existsSync(f)) {
      console.error(`FIXTURE MISSING: ${f}`);
      process.exit(2);
    }
  }

  // ===== Счёт 47 — целевой фикс =====
  console.log('Счёт 47 (target fix) — pdfplumber prod path');
  const r47 = await parsePdfFileWithExtraction(INV47);
  const items47 = r47.parseResult.items;
  const oracle = loadOracle();

  check('47.count: 81 позиция', items47.length === 81,
    `got ${items47.length}`);
  check('47.oracle: оракул загружен (81 строка)', oracle.length === 81,
    `got ${oracle.length}`);

  const leaks = items47.filter(it => it.price == null);
  check('47.group-leaks = 0 (каждая позиция имеет unit-price)', leaks.length === 0,
    `leaks: ${leaks.slice(0, 5).map(l => l.name.slice(0, 25)).join(', ')}`);

  const sum47 = Math.round(items47.reduce((s, it) => s + (it.amount ?? 0), 0) * 100) / 100;
  check('47.Σ(amount) = 856579.67 (net)', approx(sum47, 856579.67),
    `got ${sum47}`);

  check('47.total_amount = 856579.67 (net, не gross 1243453.02)',
    approx(r47.parseResult.totalAmount, 856579.67),
    `got ${r47.parseResult.totalAmount}`);

  // Построчно: qty, amount(net), price(net), unit=amount/qty
  if (items47.length === oracle.length) {
    let mism = 0;
    for (let i = 0; i < oracle.length; i++) {
      const it = items47[i], o = oracle[i];
      const bad: string[] = [];
      if (!approx(it.quantity, o.qty, 0.001)) bad.push(`qty ${it.quantity}≠${o.qty}`);
      if (!approx(it.amount, o.amountNet)) bad.push(`amount ${it.amount}≠${o.amountNet}`);
      if (!approx(it.price, o.priceNet)) bad.push(`price ${it.price}≠${o.priceNet}`);
      if (it.amount != null && it.quantity) {
        const unit = Math.round((it.amount / it.quantity) * 100) / 100;
        if (!approx(unit, o.priceNet)) bad.push(`unit ${unit}≠${o.priceNet}`);
      }
      if (bad.length) {
        mism++;
        if (mism <= 6) console.log(`    row ${o.num}: ${bad.join('; ')}`);
      }
    }
    check('47.построчное совпадение с оракулом (qty/amount/price/unit)', mism === 0,
      `${mism} mismatched rows`);
  }

  // Якорь-позиции из оракула
  const byNum = (n: string) => items47.find(it => it.name && oracle.find(o => o.num === n));
  const big = items47[1]; // №2 qty=360
  check('47.якорь №2: qty=360, unit=508.13',
    approx(big?.quantity ?? null, 360, 0.001) &&
    approx(big && big.amount && big.quantity ? big.amount / big.quantity : null, 508.13),
    `q=${big?.quantity} a=${big?.amount}`);

  // ===== Счёт 5244 — регресс-якорь =====
  console.log('\nСчёт 5244 (regression anchor)');
  const r5244 = await parsePdfFileWithExtraction(INV5244);
  const items5244 = r5244.parseResult.items;

  check('5244.count: 9 позиций', items5244.length === 9, `got ${items5244.length}`);

  const sum5244 = Math.round(items5244.reduce((s, it) => s + (it.amount ?? 0), 0) * 100) / 100;
  check('5244.Σ(amount) = 94394.05 (net)', approx(sum5244, 94394.05), `got ${sum5244}`);

  check('5244.total_amount = 94394.05 (net)', approx(r5244.parseResult.totalAmount, 94394.05),
    `got ${r5244.parseResult.totalAmount}`);

  const units: Record<number, number> = { 0: 6579, 2: 2226.75, 7: 1707 };
  for (const [idx, exp] of Object.entries(units)) {
    const it = items5244[Number(idx)];
    const unit = it && it.amount && it.quantity ? Math.round((it.amount / it.quantity) * 100) / 100 : null;
    check(`5244.unit r${idx} = ${exp}`, approx(unit, exp, 0.01), `got ${unit}`);
  }

  console.log('');
  if (failures === 0) {
    console.log('All РОВЕН form-B parser assertions passed');
    process.exit(0);
  } else {
    console.log(`${failures} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
