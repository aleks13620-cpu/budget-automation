/**
 * RED→GREEN тест Фичи #1 «НДС ровно один раз».
 * Запуск: cd backend && npx ts-node --transpile-only test_vat_exactly_once.ts
 *
 * Инвариант: для ЛЮБОЙ комбинации (колонка с/без/нейтрально НДС) × (prices_include_vat 0/1)
 * × (vat_rate 20/22/null) итоговая unit_price_with_vat содержит НДС РОВНО ОДИН РАЗ.
 *
 * Механика бага: скорер колонок (scoreVatDiscount / _score_amount_column) предпочитает
 * колонку «с НДС», поэтому распарсенный amount/price МОЖЕТ быть уже брутто. А
 * computeUnitPriceWithVat домножает на (1+ставка) ещё раз, если prices_include_vat===0
 * → двойной НДС. Фикс: normalizeParsedRowsForSupplierVat сверяет vatness выбранной колонки
 * с флагом поставщика (через convertVatSemantics) ДО computeUnitPriceWithVat, приводя
 * значение к состоянию, которого ждёт флаг. Три копии computeUnitPriceWithVat не трогаем.
 */
import { classifyColumnVat } from './src/services/pdfParser';
import { normalizeParsedRowsForSupplierVat } from './src/services/invoiceRouter';
import { InvoiceRow } from './src/types/invoice';

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`);
    failures++;
  }
}

/**
 * Точная копия computeUnitPriceWithVat (invoices.ts:94 ≡ export.ts:7 ≡ matching.ts:46).
 * Фича #1 СОЗНАТЕЛЬНО оставляет эти 3 копии без изменений — инвариант обеспечивается выше
 * по потоку (normalizeParsedRowsForSupplierVat), а эта ссылка доказывает сквозную композицию.
 */
function refUnitPriceWithVat(
  price: number | null, amount: number | null, quantity: number | null,
  vatRate: number | null, pricesIncludeVat: number | null,
): number | null {
  if (amount != null && quantity != null && quantity > 0) {
    const lineTotalWithVat = pricesIncludeVat === 0 && vatRate != null && vatRate > 0
      ? amount * (1 + vatRate / 100) : amount;
    return Math.round((lineTotalWithVat / quantity) * 100) / 100;
  }
  if (price == null) return null;
  if (pricesIncludeVat === 0 && vatRate != null && vatRate > 0) {
    return Math.round(price * (1 + vatRate / 100) * 100) / 100;
  }
  return price;
}

function row(price: number | null, amount: number | null, quantity: number | null): InvoiceRow {
  return { article: null, name: 'x', unit: null, quantity, quantity_packages: null, price, amount, row_index: 0 };
}

/** Прогон сквозного конвейера: normalize(column-vatness vs flag) → computeUnitPriceWithVat. */
function pipeline(
  rawPrice: number | null, rawAmount: number | null, qty: number | null,
  priceVat: boolean | null, amountVat: boolean | null,
  flag: number | null, rate: number | null,
) {
  const norm = normalizeParsedRowsForSupplierVat([row(rawPrice, rawAmount, qty)], amountVat, priceVat, flag, rate);
  const it = norm.items[0];
  return { unit: refUnitPriceWithVat(it.price, it.amount, qty, rate, flag), norm, normItem: it };
}

// ── 1. classifyColumnVat (зеркало _classify_column_vat в Python) ──
console.log('Group 1: classifyColumnVat');
check('1a: "Сумма с НДС" → gross(true)', classifyColumnVat('Сумма с НДС') === true);
check('1b: "Цена без НДС" → net(false)', classifyColumnVat('Цена без НДС') === false);
check('1c: "Сумма" → neutral(null)', classifyColumnVat('Сумма') === null);
check('1d: "Сумма НДС" (налоговая колонка) → neutral(null)', classifyColumnVat('Сумма НДС') === null);
check('1e: "Всего с учётом НДС" → gross(true)', classifyColumnVat('Всего с учётом НДС') === true);
check('1f: пусто → null', classifyColumnVat('') === null);

// ── 2. Инвариант «НДС ровно один раз»: все комбинации (col vatness × flag × rate) ──
console.log('Group 2: VAT-exactly-once matrix (col × flag × rate)');
for (const rate of [22, 20]) {
  const f = 1 + rate / 100;
  const N = 1000;                                  // нетто-эталон
  const G = Math.round(N * f * 100) / 100;         // брутто = НДС один раз
  const tag = `rate${rate}`;
  // колонка БРУТТО (с НДС): rawValue = G
  check(`2.${tag}: gross col + flag0 → ${G}`, pipeline(null, G, 1, null, true, 0, rate).unit === G,
    `got ${pipeline(null, G, 1, null, true, 0, rate).unit}`);
  check(`2.${tag}: gross col + flag1 → ${G}`, pipeline(null, G, 1, null, true, 1, rate).unit === G,
    `got ${pipeline(null, G, 1, null, true, 1, rate).unit}`);
  // колонка НЕТТО (без НДС): rawValue = N
  check(`2.${tag}: net col + flag0 → ${G}`, pipeline(null, N, 1, null, false, 0, rate).unit === G,
    `got ${pipeline(null, N, 1, null, false, 0, rate).unit}`);
  check(`2.${tag}: net col + flag1 → ${G}`, pipeline(null, N, 1, null, false, 1, rate).unit === G,
    `got ${pipeline(null, N, 1, null, false, 1, rate).unit}`);
  // колонка НЕЙТРАЛЬНО (null) → опора на флаг (значение согласовано с флагом)
  check(`2.${tag}: neutral col + flag0 (нетто значение) → ${G}`, pipeline(null, N, 1, null, null, 0, rate).unit === G,
    `got ${pipeline(null, N, 1, null, null, 0, rate).unit}`);
  check(`2.${tag}: neutral col + flag1 (брутто значение) → ${G}`, pipeline(null, G, 1, null, null, 1, rate).unit === G,
    `got ${pipeline(null, G, 1, null, null, 1, rate).unit}`);
}

// ── 3. vat_rate = null: НДС посчитать нечем → НЕ задваиваем, значение не трогаем + review ──
console.log('Group 3: vat_rate=null → no VAT math, no double, flagged');
{
  const p = pipeline(null, 1220, 1, null, true, 0, null); // gross col vs flag0, но ставки нет
  check('3a: gross col + flag0 + rate=null → значение неизменно (1220)', p.unit === 1220, `got ${p.unit}`);
  check('3b: конфликт без ставки помечен needsAmountReview', p.norm.needsAmountReview === true);
  const q = pipeline(null, 1000, 1, null, false, 1, null);
  check('3c: net col + flag1 + rate=null → значение неизменно (1000)', q.unit === 1000, `got ${q.unit}`);
  const r = pipeline(null, 1000, 1, null, null, 0, null);
  check('3d: neutral col + rate=null → значение неизменно (1000)', r.unit === 1000, `got ${r.unit}`);
}

// ── 4. Структура счёта 42 РАШВОРК: нетто price + брутто amount, flag0, vat22 ──
//    Документ печатает: Цена без НДС=1000 (нетто), Сумма с НДС (итог строки)=2440 (брутто), qty=2.
//    Корректная цена за единицу с НДС = 2440/2 = 1220 (НДС один раз) = напечатанному.
console.log('Group 4: invoice #42 РАШВОРК structure (net price + gross amount)');
{
  const netPrice = 1000, grossLineTotal = 2440, qty = 2, printedUnitGross = 1220;
  const buggy = refUnitPriceWithVat(netPrice, grossLineTotal, qty, 22, 0); // без нормализации
  const fixed = pipeline(netPrice, grossLineTotal, qty, /*priceVat*/ false, /*amountVat*/ true, /*flag*/ 0, /*rate*/ 22);
  check('4a: БАГ без фикса даёт двойной НДС (1488.4)', buggy === 1488.4, `got ${buggy}`);
  check('4b: фикс даёт НДС один раз = напечатанному (1220)', fixed.unit === printedUnitGross, `got ${fixed.unit}`);
  check('4c: фикс ≠ багу', fixed.unit !== buggy);
  check('4d: строка-итог фикса = напечатанной «Сумме с НДС» (1220×2=2440)',
    fixed.unit !== null && Math.round(fixed.unit * qty * 100) / 100 === grossLineTotal,
    `got ${fixed.unit !== null ? fixed.unit * qty : null}`);
  check('4e: конфликт amount-колонки помечен на review', fixed.norm.needsAmountReview === true);
}

// ── 5. Регрессия: структура счёта 30 ЛИДЕРГРУВ (нейтральная «Сумма», flag=1) — no-op ──
//    amount=«Сумма» (нейтрально, vatness=null), price=«Цена», поставщик prices_include_vat=1.
//    Фича #1 НЕ должна менять значения и итоговую цену.
console.log('Group 5: invoice #30 ЛИДЕРГРУВ structure — Feature #1 is a no-op');
{
  const amount = 23682.70, qty = 124, price = 190.99;
  const p = pipeline(price, amount, qty, /*priceVat*/ null, /*amountVat*/ null, /*flag*/ 1, /*rate*/ 22);
  check('5a: amount не изменён нормализацией', p.normItem.amount === amount, `got ${p.normItem.amount}`);
  check('5b: price не изменён нормализацией', p.normItem.price === price, `got ${p.normItem.price}`);
  check('5c: unit_price_with_vat ≈ 190.99 (как «Цена»)', p.unit !== null && Math.abs(p.unit - 190.99) < 0.01, `got ${p.unit}`);
  check('5d: review НЕ выставлен (нет конфликта)', p.norm.needsAmountReview === false);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All VAT-exactly-once assertions passed');
