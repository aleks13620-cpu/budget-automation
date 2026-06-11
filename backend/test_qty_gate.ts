/**
 * Offline proof for the quantity-loss corruption gate (proj 12 OV).
 * Feeds three datasets through evaluateSpecPdfParseQuality and checks hardBlock:
 *   1) prod-corrupted spec 20 (qty null, position=qty-shaped) -> MUST block
 *   2) fixed deterministic extractor output (qty recovered)   -> MUST NOT block
 *   3) a legitimate parent-heavy synthetic spec               -> MUST NOT block
 */
import * as fs from 'fs';
import { evaluateSpecPdfParseQuality } from './src/services/gigachatSpecParseQuality';
import type { SpecificationRow } from './src/types/specification';

function toRow(o: any): SpecificationRow {
  return {
    position_number: o.position_number ?? o.position ?? null,
    name: o.name ?? '',
    characteristics: o.characteristics ?? null,
    equipment_code: o.equipment_code ?? null,
    article: null,
    product_code: null,
    marking: o.marking ?? null,
    type_size: o.type_size ?? null,
    manufacturer: o.manufacturer ?? null,
    unit: o.unit ?? null,
    quantity: typeof o.quantity === 'number' ? o.quantity : null,
    full_name: null,
    _parentIndex: null,
  };
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

// --- 1) prod-corrupted spec 20 (real-data fixture; skip gracefully if absent) ---
// Fixtures (worktree root): prod_spec20_items.json = GET /api/specifications/20/items;
// pdfplumber_fixed.json = output of the fixed extract_pdf_table.py on the proj-12 PDF.
// They are NOT committed (large prod dumps). Regenerate via:
//   curl http://5.42.103.63:3001/api/specifications/20/items -o prod_spec20_items.json
//   python -X utf8 scripts/extract_pdf_table.py "<proj12 PDF>" > pdfplumber_fixed.json
const PROD_FIXTURE = '../prod_spec20_items.json';
const FIXED_FIXTURE = '../pdfplumber_fixed.json';

if (fs.existsSync(PROD_FIXTURE)) {
  const prod = JSON.parse(fs.readFileSync(PROD_FIXTURE, 'utf-8'));
  const prodRows: SpecificationRow[] = prod.items.map(toRow);
  const q1 = evaluateSpecPdfParseQuality(prod.items.map((i: any) => ({ position: i.position_number, name: i.name })), prodRows);
  console.log('\n[1] PROD-CORRUPTED spec 20:');
  console.log(`    rows=${prodRows.length} nullQty=${(q1.nullQtyFraction * 100).toFixed(0)}% posAsQty=${(q1.posAsQtyFraction * 100).toFixed(0)}% quantityColumnLost=${q1.quantityColumnLost} hardBlock=${q1.hardBlock}`);
  check('prod-corrupted is hardBlock=true', q1.hardBlock === true);
  check('prod-corrupted quantityColumnLost=true', q1.quantityColumnLost === true);
} else {
  console.log('\n[1] PROD-CORRUPTED spec 20: SKIP (fixture prod_spec20_items.json absent)');
}

// --- 2) fixed extractor output (real-data fixture; skip gracefully if absent) ---
if (fs.existsSync(FIXED_FIXTURE)) {
  const fixed = JSON.parse(fs.readFileSync(FIXED_FIXTURE, 'utf-8'));
  const fixedRows: SpecificationRow[] = fixed.items.map(toRow);
  const q2 = evaluateSpecPdfParseQuality(fixed.items.map((i: any) => ({ position: i.position, name: i.name })), fixedRows);
  console.log('\n[2] FIXED extractor output:');
  console.log(`    rows=${fixedRows.length} nullQty=${(q2.nullQtyFraction * 100).toFixed(0)}% posAsQty=${(q2.posAsQtyFraction * 100).toFixed(0)}% quantityColumnLost=${q2.quantityColumnLost} hardBlock=${q2.hardBlock}`);
  check('fixed output is hardBlock=false', q2.hardBlock === false);
  check('fixed output quantityColumnLost=false', q2.quantityColumnLost === false);
} else {
  console.log('\n[2] FIXED extractor output: SKIP (fixture pdfplumber_fixed.json absent)');
}

// --- 2b) synthetic corruption signature (self-contained, no fixture) ---
// Mimics the proj-12 defect deterministically: all qty null + qty-shaped ints in position.
const corrupt: SpecificationRow[] = [];
for (let i = 0; i < 50; i++) {
  corrupt.push(toRow({ name: `Радиатор стальной EVRA Compact группа ${i}`, position_number: String((i % 30) + 1), unit: 'шт.', quantity: null }));
}
const q2b = evaluateSpecPdfParseQuality(corrupt.map(r => ({ position: r.position_number, name: r.name })), corrupt);
console.log('\n[2b] SYNTHETIC corruption (all qty null + int positions):');
console.log(`    rows=${corrupt.length} nullQty=${(q2b.nullQtyFraction * 100).toFixed(0)}% posAsQty=${(q2b.posAsQtyFraction * 100).toFixed(0)}% quantityColumnLost=${q2b.quantityColumnLost} hardBlock=${q2b.hardBlock}`);
check('synthetic corruption is hardBlock=true', q2b.hardBlock === true);
check('synthetic corruption quantityColumnLost=true', q2b.quantityColumnLost === true);

// --- 3) legitimate flat spec: self-sufficient names + real quantities + sequential positions ---
// The healthy baseline the gate must never block. (Hierarchical specs are covered by
// the real-data non-regression run on Lastochka/Sokoliy, which goes through the linker.)
const legit: SpecificationRow[] = [];
for (let i = 1; i <= 40; i++) {
  legit.push(toRow({
    name: `Радиатор стальной панельный EVRA Compact C${i}`,
    position_number: String(i),
    unit: 'шт.',
    quantity: i + 2, // real quantity present
  }));
}
// a few legitimately qty-less parents (qty lives on children) — still must not block
for (let i = 0; i < 5; i++) {
  legit.push(toRow({ name: `Трубы стальные водогазопроводные ГОСТ 3262`, position_number: null, quantity: null }));
}
const q3 = evaluateSpecPdfParseQuality(legit.map(r => ({ position: r.position_number, name: r.name })), legit);
console.log('\n[3] LEGIT parent-heavy spec:');
console.log(`    rows=${legit.length} nullQty=${(q3.nullQtyFraction * 100).toFixed(0)}% posAsQty=${(q3.posAsQtyFraction * 100).toFixed(0)}% quantityColumnLost=${q3.quantityColumnLost} hardBlock=${q3.hardBlock}`);
check('legit parent-heavy is hardBlock=false', q3.hardBlock === false);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
