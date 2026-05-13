/**
 * Deterministic PDF fixture generator for spec variant-children regression tests.
 * Uses pdfkit 0.17.x. Seeds Math.random for bit-identical PDFs across runs.
 *
 * Usage: node backend/tests/fixtures/spec-pdf/_gen.mjs
 *
 * Creates 5 PDFs with synthetic spec tables. Each PDF contains a table
 * with columns: Позиция | Наименование | Характеристики | Ед. | Кол-во
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

// ---------------------------------------------------------------------------
// Seeded PRNG — pdfkit calls Math.random() for PDFSecurity IDs.
// We replace Math.random with a deterministic LCG per PDF so output is
// bit-identical on every run.
// ---------------------------------------------------------------------------
const SEED_BASE = 42;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeededRandom(seed, fn) {
  const orig = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

// ---------------------------------------------------------------------------
// Table layout constants (deterministic, no randomness)
// ---------------------------------------------------------------------------
const MARGIN_LEFT = 50;
const MARGIN_TOP = 50;
const COL_WIDTHS = [40, 200, 120, 40, 40]; // Позиция, Наименование, Характеристики, Ед., Кол-во
const HEADERS = ['Позиция', 'Наименование', 'Характеристики', 'Ед.', 'Кол-во'];
const ROW_HEIGHT = 22;
const FONT_SIZE = 9;
const HEADER_FONT_SIZE = 9;

function drawTable(doc, rows) {
  let y = MARGIN_TOP;
  const pageWidth = MARGIN_LEFT + COL_WIDTHS.reduce((a, b) => a + b, 0) + 20;

  // Header
  doc.font('Helvetica-Bold').fontSize(HEADER_FONT_SIZE);
  let x = MARGIN_LEFT;
  for (let ci = 0; ci < HEADERS.length; ci++) {
    doc.text(HEADERS[ci], x + 2, y + 4, {
      width: COL_WIDTHS[ci] - 4,
      align: ci === 0 || ci >= 3 ? 'center' : 'left',
      lineBreak: false,
      height: ROW_HEIGHT - 4,
    });
    x += COL_WIDTHS[ci];
  }
  y += ROW_HEIGHT;

  // Header underline
  doc
    .moveTo(MARGIN_LEFT, y)
    .lineTo(MARGIN_LEFT + COL_WIDTHS.reduce((a, b) => a + b, 0), y)
    .stroke();

  // Grid helpers — clip each cell to prevent text overflow into neighbours
  function clipCell(rx, ry, rw, rh, cb) {
    doc.save();
    doc.rect(rx, ry, rw, rh).clip();
    cb();
    doc.restore();
  }

  // Data rows
  doc.font('Helvetica').fontSize(FONT_SIZE);
  for (const row of rows) {
    // Check page break
    if (y + ROW_HEIGHT > doc.page.height - 50) {
      doc.addPage();
      y = MARGIN_TOP;
      // Re-draw header on new page
      doc.font('Helvetica-Bold').fontSize(HEADER_FONT_SIZE);
      let hx = MARGIN_LEFT;
      for (let ci = 0; ci < HEADERS.length; ci++) {
        clipCell(hx, y, COL_WIDTHS[ci], ROW_HEIGHT, () => {
          doc.text(HEADERS[ci], hx + 2, y + 4, {
            width: COL_WIDTHS[ci] - 4,
            align: ci === 0 || ci >= 3 ? 'center' : 'left',
            lineBreak: false,
          });
        });
        hx += COL_WIDTHS[ci];
      }
      y += ROW_HEIGHT;
      doc
        .moveTo(MARGIN_LEFT, y)
        .lineTo(MARGIN_LEFT + COL_WIDTHS.reduce((a, b) => a + b, 0), y)
        .stroke();
      doc.font('Helvetica').fontSize(FONT_SIZE);
    }

    let rx = MARGIN_LEFT;
    for (let ci = 0; ci < row.length; ci++) {
      const cellText = row[ci] !== null && row[ci] !== undefined ? String(row[ci]) : '';
      clipCell(rx, y, COL_WIDTHS[ci], ROW_HEIGHT, () => {
        doc.text(cellText, rx + 2, y + 4, {
          width: COL_WIDTHS[ci] - 4,
          align: ci === 0 || ci >= 3 ? 'center' : 'left',
          lineBreak: false,
        });
      });
      rx += COL_WIDTHS[ci];
    }

    // Row separator
    doc
      .moveTo(MARGIN_LEFT, y + ROW_HEIGHT)
      .lineTo(MARGIN_LEFT + COL_WIDTHS.reduce((a, b) => a + b, 0), y + ROW_HEIGHT)
      .stroke();

    y += ROW_HEIGHT;
  }
}

function createPdf(fileName, tableRows, seed) {
  const filePath = path.join(OUT, fileName);
  return withSeededRandom(seed, () => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN_TOP, left: MARGIN_LEFT, right: 50, bottom: 50 },
      info: {
        Title: fileName,
        Creator: 'budget-automation test fixtures',
        CreationDate: new Date('2025-01-01T00:00:00Z'),
      },
    });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Document title
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Спецификация (тестовый документ)', MARGIN_LEFT, 20);
    doc.moveDown(0.5);

    drawTable(doc, tableRows);

    doc.end();
    return new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  });
}

// ---------------------------------------------------------------------------
// Fixture data (hardcoded, deterministic)
// ---------------------------------------------------------------------------
function buildRows(data) {
  return data.map(r => [
    r.pos,    // Позиция
    r.name,   // Наименование
    r.char || '', // Характеристики
    r.unit || '',  // Ед.
    r.qty != null ? String(r.qty) : '', // Кол-во
  ]);
}

// ---------------------------------------------------------------------------
// Case 01: Radiator variants without position_number on children
// ---------------------------------------------------------------------------
const CASE01 = [
  { pos: '1', name: 'Стальной панельный радиатор Royal Thermo Compact С 11', char: 'ГОСТ 31311-2005', unit: 'шт', qty: 13 },
  { pos: '', name: 'C11-300-500', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-300-600', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-300-700', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-300-800', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-300-900', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-400-500', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-400-600', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-400-700', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-400-800', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-400-900', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-500-500', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-500-600', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C11-500-1200', char: '', unit: 'шт', qty: 1 },
  { pos: '2', name: 'Стальной панельный радиатор Royal Thermo Compact С 21', char: 'ГОСТ 31311-2005', unit: 'шт', qty: 2 },
  { pos: '', name: 'C21-500-800', char: '', unit: 'шт', qty: 1 },
  { pos: '', name: 'C21-500-1200', char: '', unit: 'шт', qty: 1 },
];

// ---------------------------------------------------------------------------
// Case 02: DN children
// ---------------------------------------------------------------------------
const CASE02 = [
  { pos: '1', name: 'Труба стальная электросварная', char: 'ГОСТ 10704-91', unit: 'м', qty: 100 },
  { pos: '', name: 'DN 50', char: '', unit: '', qty: null },
  { pos: '', name: 'DN 80', char: '', unit: '', qty: null },
  { pos: '', name: 'DN 100', char: '', unit: '', qty: null },
  { pos: '', name: 'Ду 150', char: '', unit: '', qty: null },
  { pos: '2', name: 'Отвод стальной', char: 'ГОСТ 17375-2001', unit: 'шт', qty: 10 },
  { pos: '', name: 'DN 50', char: '', unit: '', qty: null },
  { pos: '', name: 'DN 80', char: '', unit: '', qty: null },
];

// ---------------------------------------------------------------------------
// Case 03: "То же" children
// ---------------------------------------------------------------------------
const CASE03 = [
  { pos: '1', name: 'Воздуховод оцинкованный 200x200', char: 'ТУ 4862-001', unit: 'м', qty: 25 },
  { pos: '', name: 'То же, 300x200', char: '', unit: '', qty: null },
  { pos: '', name: 'То же, 400x200', char: '', unit: '', qty: null },
  { pos: '', name: 'То же', char: '', unit: '', qty: null },
  { pos: '2', name: 'Решетка вентиляционная РВ-1', char: 'ТУ 4862-002', unit: 'шт', qty: 5 },
  { pos: '', name: 'То же, РВ-2', char: '', unit: '', qty: null },
  { pos: '', name: 'То же', char: '', unit: '', qty: null },
];

// ---------------------------------------------------------------------------
// Case 04: Mixed (DN + variants + "То же" in one document)
// ---------------------------------------------------------------------------
const CASE04 = [
  { pos: '1', name: 'Радиатор биметаллический Rifar Base 500', char: 'сертификат РОСС', unit: 'шт', qty: 5 },
  { pos: '', name: '500-10', char: '', unit: '', qty: null },
  { pos: '', name: '500-12', char: '', unit: '', qty: null },
  { pos: '', name: '500-14', char: '', unit: '', qty: null },
  { pos: '2', name: 'Труба полипропиленовая', char: 'ГОСТ 32415-2013', unit: 'м', qty: 50 },
  { pos: '', name: 'DN 20', char: '', unit: '', qty: null },
  { pos: '', name: 'DN 25', char: '', unit: '', qty: null },
  { pos: '', name: 'DN 32', char: '', unit: '', qty: null },
  { pos: '3', name: 'Хомут стальной', char: '', unit: 'шт', qty: 8 },
  { pos: '', name: 'То же, оцинкованный', char: '', unit: '', qty: null },
];

// ---------------------------------------------------------------------------
// Case 05: Negative — variant without parent (should NOT link)
// ---------------------------------------------------------------------------
const CASE05 = [
  { pos: '', name: 'C22-300-500', char: '', unit: 'шт', qty: 1 },
  { pos: '1', name: 'Радиатор алюминиевый', char: 'ТУ 4935-001', unit: 'шт', qty: 3 },
  { pos: '', name: 'C22-350-500', char: '', unit: '', qty: null },
  { pos: '', name: 'C22-350-600', char: '', unit: '', qty: null },
];

// ---------------------------------------------------------------------------
// Expected JSON helpers — mirrors linkPdfParentChildren AFTER F4 fix
// ---------------------------------------------------------------------------
const DN_CHILD_PATTERN = /^(DN|Ду|d=|D=|du)?\s*\d{2,}(\s|$|[xX×\/\-])/i;
const TO_ZHE_PATTERN = /^то\s+же/i;
const PARAMETER_CHILD_PATTERN = /^(δ|d|du|dn|ø|⌀)\s*=?\s*\d{1,4}|\b\d{1,4}\s*[xх×]\s*\d{1,4}\b|^\d{2,4}[xх×]\d{2,4}$/i;

function isDnChild(name, positionNumber) {
  return !positionNumber && DN_CHILD_PATTERN.test(name.trim());
}

function isToZheChild(name) {
  return TO_ZHE_PATTERN.test(name.trim());
}

function isParameterizedChild(name) {
  const normalized = name.trim();
  if (!normalized) return false;
  if (PARAMETER_CHILD_PATTERN.test(normalized)) return true;
  if (/^[A-Za-zА-Яа-я]{0,4}\d{2,4}[-xх×]\d{2,4}([-\s]\d{2,4})?$/i.test(normalized)) return true;
  return false;
}

function makeBaseRow(pos, name, char, unit, qty) {
  return {
    position_number: pos || null,
    name,
    characteristics: char || null,
    equipment_code: null,
    article: null,
    product_code: null,
    marking: null,
    type_size: null,
    manufacturer: null,
    unit: unit || null,
    quantity: qty != null ? qty : null,
    full_name: null,
    _parentIndex: null,
  };
}

function linkPdfParentChildrenFixed(items) {
  let lastFullIndex = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (isDnChild(item.name, item.position_number)) {
      if (lastFullIndex !== null) {
        item._parentIndex = lastFullIndex;
        item.full_name = `${items[lastFullIndex].name} ${item.name}`.trim();
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
      continue;
    }

    if (isToZheChild(item.name)) {
      if (lastFullIndex !== null) {
        item._parentIndex = lastFullIndex;
        const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
        const suffix = item.name.replace(/^то\s+же[,\s]*/i, '').trim();
        const expandedName = suffix ? `${parentName} ${suffix}` : parentName;
        item.name = expandedName;
        item.full_name = expandedName;
      } else {
        item._parentIndex = null;
        item.full_name = null;
      }
      lastFullIndex = i;
      continue;
    }

    // F4 FIX: variant children without position_number should link to parent
    if (
      lastFullIndex !== null &&
      isParameterizedChild(item.name) &&
      (!item.position_number || items[lastFullIndex].position_number === item.position_number)
    ) {
      item._parentIndex = lastFullIndex;
      const parentName = items[lastFullIndex].full_name || items[lastFullIndex].name;
      item.full_name = `${parentName} ${item.name}`.trim();
      continue;
    }

    lastFullIndex = i;
    item._parentIndex = null;
    item.full_name = null;
  }
}

function buildExpectedJson(data) {
  const items = data.map(r => makeBaseRow(r.pos, r.name, r.char, r.unit, r.qty));
  linkPdfParentChildrenFixed(items);
  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const tasks = [
    { pdf: '01_radiator_variants_no_position.pdf', json: '01_radiator_variants_no_position.expected.json', data: CASE01 },
    { pdf: '02_dn_children.pdf', json: '02_dn_children.expected.json', data: CASE02 },
    { pdf: '03_to_zhe_children.pdf', json: '03_to_zhe_children.expected.json', data: CASE03 },
    { pdf: '04_mixed.pdf', json: '04_mixed.expected.json', data: CASE04 },
    { pdf: '05_negative_no_parent_variant.pdf', json: '05_negative_no_parent_variant.expected.json', data: CASE05 },
  ];

  for (let ti = 0; ti < tasks.length; ti++) {
    const task = tasks[ti];
    // Generate PDF with deterministic seed
    const tableRows = buildRows(task.data);
    await createPdf(task.pdf, tableRows, SEED_BASE + ti);

    // Generate expected JSON
    const expected = buildExpectedJson(task.data);
    fs.writeFileSync(path.join(OUT, task.json), JSON.stringify(expected, null, 2) + '\n', 'utf-8');

    const pdfSize = fs.statSync(path.join(OUT, task.pdf)).size;
    console.log(`[OK] ${task.pdf} (${pdfSize} bytes), ${task.json}`);
  }

  console.log('\nAll fixtures generated successfully.');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
