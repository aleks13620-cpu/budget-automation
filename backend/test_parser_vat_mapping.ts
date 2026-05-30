/**
 * RED-тест маппера колонок: различение «Сумма НДС» (налог) и «Сумма» (итог).
 * Баг H3 (#10/#12): detectColumns кладёт в amount колонку «Сумма НДС», т.к. она левее «Сумма».
 * Запуск: npx ts-node test_parser_vat_mapping.ts
 *
 * Ключевая цифра — unit_price_with_vat. Downstream (matching.ts/invoices.ts)
 * считает её как amount/quantity (ветка 'derived_unit') ПОКА есть amount+quantity;
 * колонка «Цена» — только fallback. Поэтому испорченный amount портит именно эту цифру.
 */
import { detectColumns, parsePrice, ColumnMapping } from './src/services/pdfParser';

let failures = 0;
function check(name: string, cond: boolean, details?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${details ? ' — ' + details : ''}`);
    failures++;
  }
}

const fmt = (m: ColumnMapping) => JSON.stringify(m);

// ── Case A: структура счёта 30 — «Сумма НДС» И «Сумма» вместе ──
console.log('Case A: invoice #30 header (Сумма НДС + Сумма)');
{
  const header = ['№', 'Артикул', 'Товары (работы, услуги)', 'Количество', 'Ед.', 'Цена', 'Ставка НДС', 'Сумма НДС', 'Сумма'];
  const dataRow = ['1', 'SDZ134', 'УСИЛ.МУФТА', '124', 'шт', '190,99', '22%', '4 270,65', '23 682,70'];
  const r = detectColumns([header, dataRow]);
  check('A: detection succeeded', r !== null, 'detectColumns returned null');
  if (r) {
    const m = r.mapping;
    check('A: amount = col 8 (Сумма, итог)', m.amount === 8, `got ${fmt(m)}`);
    check('A: price  = col 5 (Цена)', m.price === 5, `got ${fmt(m)}`);

    // Цепочка до итоговой цифры: unit_price_with_vat = amount / quantity (derived_unit).
    // Суммы поставщика 30 — с НДС, поэтому без домножения на (1+ставка).
    if (m.amount !== null && m.quantity !== null) {
      const amount = parsePrice(dataRow[m.amount]);
      const qty = parsePrice(dataRow[m.quantity]);
      const unit = amount !== null && qty ? Math.round((amount / qty) * 100) / 100 : null;
      check('A: derived unit ≈ 190.99 (= колонка «Цена»)', unit !== null && Math.abs(unit - 190.99) < 0.5,
        `got ${unit} (buggy col «Сумма НДС» дал бы 4270.65/124 = 34.44)`);
    }
  }
}

// ── Case B: только «Сумма» (guard — не сломать) ──
console.log('Case B: only Сумма');
{
  const r = detectColumns([
    ['№', 'Наименование', 'Количество', 'Цена', 'Сумма'],
    ['1', 'Товар', '10', '100', '1000'],
  ]);
  check('B: detection succeeded', r !== null);
  if (r) check('B: amount = col 4 (Сумма)', r.mapping.amount === 4, `got ${fmt(r.mapping)}`);
}

// ── Case C: «Сумма с НДС» должна остаться amount (guard) ──
console.log('Case C: Сумма с НДС (must stay amount)');
{
  const r = detectColumns([
    ['№', 'Наименование', 'Количество', 'Цена без НДС', 'Сумма с НДС'],
    ['1', 'Товар', '10', '100', '1200'],
  ]);
  check('C: detection succeeded', r !== null);
  if (r) {
    check('C: amount = col 4 (Сумма с НДС)', r.mapping.amount === 4, `got ${fmt(r.mapping)}`);
    check('C: price  = col 3 (Цена без НДС)', r.mapping.price === 3, `got ${fmt(r.mapping)}`);
  }
}

// ── Case D: «Сумма без НДС» + «Сумма» → итог = «Сумма» (guard) ──
console.log('Case D: Сумма без НДС + Сумма');
{
  const r = detectColumns([
    ['№', 'Наименование', 'Количество', 'Цена', 'Сумма без НДС', 'Сумма'],
    ['1', 'Товар', '10', '100', '1000', '1200'],
  ]);
  check('D: detection succeeded', r !== null);
  if (r) check('D: amount = col 5 (Сумма, с НДС)', r.mapping.amount === 5, `got ${fmt(r.mapping)}`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All TS parser-mapping assertions passed');
