import dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { parseSpecFromPdf } from './src/services/gigachatSpecFromPdf';
import { parseExcelInvoice, excelToLegacy } from './src/services/excelInvoiceParser';
import { parsePdfFileWithExtraction } from './src/services/pdfParser';
import { runMatching } from './src/services/matcher';

const dbPath = path.resolve(__dirname, '../database/budget_automation.db');

const INVOICES_DIR = 'C:/Users/home/Downloads/Таблицы/Вентиляция +отопление';

interface InvoiceFile {
  name: string;
  path: string;
  type: 'xlsx' | 'pdf';
}

function findFileInDir(dir: string, keyword: string): string | null {
  const files = fs.readdirSync(dir);
  const match = files.find(f => f.toLowerCase().includes(keyword.toLowerCase()));
  return match ? path.join(dir, match) : null;
}

function discoverInvoices(): InvoiceFile[] {
  const result: InvoiceFile[] = [];

  // NED from Downloads root
  const nedPath = findFileInDir('C:/Users/home/Downloads', 'NED КП');
  if (nedPath) result.push({ name: 'NED', path: nedPath, type: 'xlsx' });

  // All files from invoices dir
  const files = fs.readdirSync(INVOICES_DIR);
  for (const f of files) {
    // Skip НЕД Копия (duplicate of NED)
    if (f.includes('Копия')) continue;
    const ext = path.extname(f).toLowerCase();
    if (ext === '.xlsx' || ext === '.pdf') {
      const label = f.replace(/\.[^.]+$/, '').substring(0, 30);
      result.push({ name: label, path: path.join(INVOICES_DIR, f), type: ext === '.xlsx' ? 'xlsx' : 'pdf' });
    }
  }
  return result;
}

async function parseInvoice(f: InvoiceFile): Promise<{ name: string; items: any[] }> {
  if (f.type === 'xlsx') {
    const result = parseExcelInvoice(f.path);
    return { name: f.name, items: result.items };
  } else {
    const result = await parsePdfFileWithExtraction(f.path);
    return { name: f.name, items: result.parseResult.items };
  }
}

async function main() {
  // 1. Parse spec PDF
  console.log('=== Parsing spec PDF ===');
  const specResult = await parseSpecFromPdf('C:/Users/home/Downloads/Документы/PDF/5-ПР_21 – ОВ (1)-45-75.pdf');
  console.log(`Spec: ${specResult.items.length} items, errors: ${specResult.errors.length}`);

  // 2. Parse all invoices
  console.log('\n=== Parsing invoices ===');
  const INVOICE_FILES = discoverInvoices();
  console.log(`Found ${INVOICE_FILES.length} invoice files`);
  const invoices: { name: string; items: any[] }[] = [];
  for (const f of INVOICE_FILES) {
    try {
      const result = await parseInvoice(f);
      console.log(`${f.name}: ${result.items.length} items`);
      invoices.push(result);
    } catch (err: any) {
      console.log(`${f.name}: FAILED - ${err.message}`);
    }
  }

  const totalInvItems = invoices.reduce((s, inv) => s + inv.items.length, 0);
  console.log(`Total invoice items: ${totalInvItems}`);

  // 3. Insert into DB
  console.log('\n=== Inserting into DB ===');
  const db = new Database(dbPath);

  const projectId = db.transaction(() => {
    const proj = db.prepare("INSERT INTO projects (name) VALUES ('E2E Matching Test OV v3')").run();
    const pid = Number(proj.lastInsertRowid);

    // Insert spec
    const specInsert = db.prepare("INSERT INTO specifications (project_id, section, file_name, raw_data, parse_source) VALUES (?, 'Вентиляция', 'spec.pdf', '[]', 'pdf_gigachat')").run(pid);
    const specId = Number(specInsert.lastInsertRowid);

    const insertSpec = db.prepare(`
      INSERT INTO specification_items (project_id, specification_id, position_number, name, characteristics, equipment_code, article, product_code, marking, type_size, manufacturer, unit, quantity, section, full_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Вентиляция', ?)
    `);
    for (const item of specResult.items) {
      insertSpec.run(pid, specId, item.position_number, item.name, item.characteristics, item.equipment_code, item.article, item.product_code, item.marking, item.type_size, item.manufacturer, item.unit, item.quantity, item.full_name);
    }

    // Insert each invoice
    const insertInv = db.prepare(`INSERT INTO invoice_items (invoice_id, article, name, unit, quantity, price, amount, row_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const inv of invoices) {
      const invRow = db.prepare(`INSERT INTO invoices (project_id, file_name, file_path, status) VALUES (?, ?, ?, 'parsed')`).run(pid, `${inv.name}.file`, `/tmp/${inv.name}`);
      const invId = Number(invRow.lastInsertRowid);
      for (const item of inv.items) {
        insertInv.run(invId, item.article, item.name, item.unit, item.quantity, item.price, item.amount, item.row_index);
      }
    }

    return pid;
  })();

  const specCount = (db.prepare('SELECT COUNT(*) as cnt FROM specification_items WHERE project_id = ?').get(projectId) as any).cnt;
  const invCount = (db.prepare('SELECT COUNT(*) as cnt FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.project_id = ?').get(projectId) as any).cnt;
  console.log(`Project ${projectId}: ${specCount} spec items, ${invCount} invoice items`);

  db.close();

  // 4. Run matching
  console.log('\n=== Running matching ===');
  const t0 = Date.now();
  const candidates = await runMatching(projectId);
  const elapsed = Math.round((Date.now() - t0) / 1000);

  const matchedSpecIds = new Set(candidates.map(c => c.specItemId));
  const matchedInvIds = new Set(candidates.map(c => c.invoiceItemId));
  const byType: Record<string, number> = {};
  for (const c of candidates) { byType[c.matchType] = (byType[c.matchType] || 0) + 1; }

  let highConf = 0, medConf = 0, lowConf = 0;
  for (const c of candidates) {
    if (c.confidence >= 0.7) highConf++;
    else if (c.confidence >= 0.4) medConf++;
    else lowConf++;
  }

  // Best match per spec (highest confidence)
  const bestPerSpec = new Map<number, typeof candidates[0]>();
  for (const c of candidates) {
    const existing = bestPerSpec.get(c.specItemId);
    if (!existing || c.confidence > existing.confidence) bestPerSpec.set(c.specItemId, c);
  }
  const highConfSpecs = [...bestPerSpec.values()].filter(c => c.confidence >= 0.6).length;

  console.log(`Done in ${elapsed}s`);
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Unique specs with any match: ${matchedSpecIds.size}/${specCount} = ${Math.round(matchedSpecIds.size/specCount*100)}%`);
  console.log(`Unique specs with best≥0.6: ${highConfSpecs}/${specCount} = ${Math.round(highConfSpecs/specCount*100)}%`);
  console.log(`Unique invoice items matched: ${matchedInvIds.size}/${invCount} = ${Math.round(matchedInvIds.size/invCount*100)}%`);
  console.log('\nBy type:');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);
  console.log(`\nConfidence: high(≥0.7)=${highConf}, med(0.4-0.7)=${medConf}, low(<0.4)=${lowConf}`);

  const pct = specCount > 0 ? Math.round(matchedSpecIds.size / specCount * 100) : 0;
  console.log(`\n=== RESULT: ${matchedSpecIds.size}/${specCount} = ${pct}% ===`);

  // Show sample matches
  console.log('\nSample matches (high confidence):');
  const db2 = new Database(dbPath, { readonly: true });
  const highCandidates = candidates.filter(c => c.confidence >= 0.7).slice(0, 15);
  for (const c of highCandidates) {
    const spec = db2.prepare('SELECT name FROM specification_items WHERE id = ?').get(c.specItemId) as any;
    const inv = db2.prepare('SELECT name FROM invoice_items WHERE id = ?').get(c.invoiceItemId) as any;
    console.log(`  [${c.confidence.toFixed(2)}][${c.matchType}] SPEC: "${(spec?.name || '').substring(0, 50)}" → INV: "${(inv?.name || '').substring(0, 50)}"`);
  }

  // Show unmatched spec items sample
  console.log('\nSample UNMATCHED specs:');
  const allSpecIds = db2.prepare('SELECT id, name, full_name FROM specification_items WHERE project_id = ?').all(projectId) as any[];
  const unmatched = allSpecIds.filter(s => !matchedSpecIds.has(s.id));
  for (const s of unmatched.slice(0, 15)) {
    console.log(`  SPEC: "${(s.full_name || s.name || '').substring(0, 70)}"`);
  }
  db2.close();
}

main().catch(console.error);
