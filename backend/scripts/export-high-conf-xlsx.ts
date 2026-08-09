/**
 * EXPORT HIGH-CONF XLSX — Поток Б1.1
 *
 * Reuses extract-ethalon-pairs.ts extraction logic to emit the 27 high-confidence
 * (spec, invoice) pairs as an XLSX file ready for POST /api/projects/12/import-matches.
 *
 * - No prod writes. Only XLSX + JSON to backend/scripts/.
 * - HARD STOP if pair count is not exactly 27 (per worker brief: do NOT massage data).
 *
 * Run:
 *   cd backend
 *   npx tsx scripts/export-high-conf-xlsx.ts
 */

import path from 'path';
import fs from 'fs';
import http from 'http';
import XLSX from 'xlsx';
import stringSimilarity from 'string-similarity';

// ──────────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────────
// File moved into Downloads\Таблицы\ since 06-11 proof run; try both for robustness.
const ETHALON_XLSX_CANDIDATES = [
  'C:\\Users\\home\\Downloads\\Таблицы\\01_05-07-24-ОВ эталон жк бкк арта.xlsx',
  'C:\\Users\\home\\Downloads\\01_05-07-24-ОВ эталон жк бкк арта.xlsx',
];
function pickEthalonPath(): string {
  for (const p of ETHALON_XLSX_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Эталон XLSX not found. Tried: ' + ETHALON_XLSX_CANDIDATES.join(' | '));
}
const PROD_API = 'http://5.42.103.63:3001/api';
const OUT_XLSX = path.resolve(__dirname, 'b1_high_conf_27_2026-06-13.xlsx');
const OUT_JSON = path.resolve(__dirname, 'b1_high_conf_27_2026-06-13.json');
const EXPECTED_PAIR_COUNT = 27;

// ──────────────────────────────────────────────────────────────────
//  HTTP helper (GET only)
// ──────────────────────────────────────────────────────────────────
function getOnce<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 30_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(new Error(`JSON parse failed for ${url}: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timeout 30s for ${url}`));
    });
    req.on('error', reject);
  });
}

async function get<T>(url: string, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await getOnce<T>(url);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────────
//  Normalization (DB-free, mirrors matcher.ts) — copy of extract-ethalon-pairs.ts
// ──────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'мм', 'см', 'м', 'шт', 'кг', 'г', 'л', 'мл', 'компл', 'комплект',
  'набор', 'ед', 'пог', 'кв', 'куб', 'п', 'к', 'и', 'в', 'с', 'на',
  'для', 'из', 'по', 'от', 'до', 'счет', 'счете',
]);

function normalizeForMatching(text: string): string {
  let s = text;
  s = s.replace(/\([^)]*(?:ГОСТ|ТУ)\s*[\d\s\-./]*[^)]*\)/gi, ' ');
  s = s.replace(/\bм\.п\.\b/gi, 'м').replace(/\bпог\.м\.\b/gi, 'м').replace(/\bпм\b/gi, 'м');
  s = s.replace(/(\d),(\d)/g, '$1.$2');
  s = s.replace(/[ø⌀]/g, ' dn ');
  s = s.replace(/(^|\s)ду\.?\s*(\d{1,4})(?:\.\d+)?(?=\s|$)/gi, ' dn $2 ');
  s = s.replace(/(^|[^a-zа-яё0-9])д[нп]\.?\s*=?\s*(\d{1,4})(?:\.\d+)?/gi, '$1 dn $2 ');
  s = s.replace(/\bdn\.?\s*(\d{1,4})(?:\.\d+)?\b/gi, ' dn $1 ');
  s = s.replace(/(\d)\s*[xх×*]\s*(\d)/gi, '$1x$2');
  s = s.toLowerCase().trim();
  s = s.replace(/ё/g, 'е');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  return words.join(' ');
}

// ──────────────────────────────────────────────────────────────────
//  Эталон parsing (mirrors extract-ethalon-pairs.ts)
// ──────────────────────────────────────────────────────────────────
interface EthalonRow {
  rowNum: number;
  specName: string;
  specChars: string;
  specPrice: number | null;
  analogPrice: number | null;
  analogSupplier: string;
  altSupplier: string;
  altPrice: number | null;
}

interface ExtractedPair {
  specName: string;
  invoiceName: string;
  supplierHint: string;
  priceSpec: number | null;
  priceInvoice: number | null;
  confidence: 'high' | 'derived';
  matchMethod: string;
}

function parseEthalonXlsx(filePath: string): EthalonRow[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as (string | number)[][];

  const result: EthalonRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const specName = String(r[1] ?? '').trim();
    if (!specName) continue;

    const colJ = r[9];
    const colL = r[11];
    const colP = r[15];
    const colQ = r[16];
    const colH = r[7];

    const hasAnalog =
      (colJ !== '' && colJ !== null && colJ !== undefined) ||
      (colL !== '' && colL !== null && colL !== undefined) ||
      (colP !== '' && colP !== null && colP !== undefined) ||
      (colQ !== '' && colQ !== null && colQ !== undefined);
    if (!hasAnalog) continue;

    result.push({
      rowNum: i + 1,
      specName,
      specChars: String(r[2] ?? '').trim(),
      specPrice: typeof colH === 'number' ? colH : null,
      analogPrice: typeof colJ === 'number' ? colJ : null,
      analogSupplier: String(colL ?? '').trim(),
      altSupplier: String(colP ?? '').trim(),
      altPrice: typeof colQ === 'number' ? colQ : null,
    });
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────
//  Resolve invoice items from prod (read-only)
// ──────────────────────────────────────────────────────────────────
interface InvoiceItem {
  id: number;
  name: string;
  price: number | null;
  supplierName: string | null;
  unit: string | null;
}

async function fetchAllInvoiceItems(): Promise<InvoiceItem[]> {
  type MatchingResponse = {
    items: Array<{
      matches: Array<{
        invoiceItemId: number;
        invoiceName: string;
        price: number;
        effectivePrice: number;
        supplierName: string | null;
        unit: string | null;
      }>;
    }>;
  };

  const data = await get<MatchingResponse>(`${PROD_API}/projects/12/matching`);
  const map = new Map<number, InvoiceItem>();
  for (const item of data.items) {
    for (const m of item.matches || []) {
      if (!map.has(m.invoiceItemId)) {
        map.set(m.invoiceItemId, {
          id: m.invoiceItemId,
          name: m.invoiceName,
          price: m.price ?? m.effectivePrice,
          supplierName: m.supplierName,
          unit: m.unit,
        });
      }
    }
  }

  type InvoicesResponse = { invoices: Array<{ id: number; supplier_name: string }> };
  const invList = await get<InvoicesResponse>(`${PROD_API}/projects/12/invoices`);
  for (const inv of invList.invoices || []) {
    try {
      type InvWithItems = { items?: Array<{ id: number; name: string; price: number | null; unit: string | null }> };
      const fullInv = await get<InvWithItems>(`${PROD_API}/invoices/${inv.id}`);
      if (Array.isArray(fullInv.items)) {
        for (const item of fullInv.items) {
          if (!map.has(item.id)) {
            map.set(item.id, {
              id: item.id,
              name: item.name,
              price: item.price,
              supplierName: inv.supplier_name,
              unit: item.unit,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(map.values());
}

function resolveInvoiceName(
  row: EthalonRow,
  invoiceItems: InvoiceItem[],
): ExtractedPair | null {
  const specName = row.specName + (row.specChars ? ' ' + row.specChars : '');

  if (row.analogSupplier && row.analogPrice !== null && row.analogPrice > 0) {
    if (
      row.altSupplier &&
      !['нзвз', 'спг-п', 'спг6-п', 'сп6-п', '310р/шт', 'обм'].some((x) =>
        row.altSupplier.toLowerCase().includes(x),
      )
    ) {
      const candidateName = row.altSupplier;
      if (candidateName.length > 5 && /[а-яёА-ЯЁa-zA-Z]{3}/.test(candidateName)) {
        return {
          specName,
          invoiceName: candidateName,
          supplierHint: row.analogSupplier,
          priceSpec: row.specPrice,
          priceInvoice: row.analogPrice,
          confidence: 'high',
          matchMethod: 'explicit_colP_name',
        };
      }
    }

    if (row.analogSupplier.toLowerCase().includes('sanext')) {
      const teplyd = invoiceItems.filter((i) =>
        (i.supplierName || '').toLowerCase().includes('теплый'),
      );
      const byPrice = teplyd.filter((i) => {
        if (i.price == null) return false;
        const ratio = Math.abs(i.price - row.analogPrice!) / row.analogPrice!;
        return ratio <= 0.15;
      });
      if (byPrice.length === 1) {
        return {
          specName,
          invoiceName: byPrice[0].name,
          supplierHint: byPrice[0].supplierName || '',
          priceSpec: row.specPrice,
          priceInvoice: byPrice[0].price,
          confidence: 'derived',
          matchMethod: 'price_proximity_sanext',
        };
      }
      const allByPrice = invoiceItems.filter((i) => {
        if (i.price == null) return false;
        const ratio = Math.abs(i.price - row.analogPrice!) / row.analogPrice!;
        return ratio <= 0.1;
      });
      if (allByPrice.length === 1) {
        return {
          specName,
          invoiceName: allByPrice[0].name,
          supplierHint: allByPrice[0].supplierName || '',
          priceSpec: row.specPrice,
          priceInvoice: allByPrice[0].price,
          confidence: 'derived',
          matchMethod: 'price_proximity_all',
        };
      }
      return null;
    }
  }

  if (row.altSupplier.toUpperCase().includes('НЗВЗ') && row.altPrice !== null && row.altPrice > 0) {
    const nzvz = invoiceItems.filter((i) =>
      (i.supplierName || '').toLowerCase().includes('нзвз') ||
      (i.supplierName || '').toLowerCase().includes('волгопром'),
    );
    const byPrice = nzvz.filter((i) => {
      if (i.price == null) return false;
      const ratio = Math.abs(i.price - row.altPrice!) / row.altPrice!;
      return ratio <= 0.15;
    });
    if (byPrice.length === 1) {
      return {
        specName,
        invoiceName: byPrice[0].name,
        supplierHint: 'НЗВЗ',
        priceSpec: row.specPrice,
        priceInvoice: byPrice[0].price,
        confidence: 'high',
        matchMethod: 'price_proximity_nzvz',
      };
    }
    if (byPrice.length > 1) {
      const normSpec = normalizeForMatching(specName);
      const scored = byPrice.map((i) => ({
        item: i,
        sim: stringSimilarity.compareTwoStrings(normSpec, normalizeForMatching(i.name)),
      }));
      scored.sort((a, b) => b.sim - a.sim);
      if (scored[0].sim > 0.25) {
        return {
          specName,
          invoiceName: scored[0].item.name,
          supplierHint: 'НЗВЗ',
          priceSpec: row.specPrice,
          priceInvoice: scored[0].item.price,
          confidence: scored[0].sim > 0.5 ? 'high' : 'derived',
          matchMethod: `price_similarity_nzvz(sim=${scored[0].sim.toFixed(2)})`,
        };
      }
    }
  }

  if (row.altSupplier && row.altSupplier.match(/^ОБМ-/i)) {
    const obmName = row.altSupplier;
    return {
      specName,
      invoiceName: obmName,
      supplierHint: 'ООО "ФРЕГАТ ЛТД"',
      priceSpec: row.specPrice,
      priceInvoice: null,
      confidence: 'high',
      matchMethod: 'explicit_obm_code',
    };
  }

  return null;
}

function categorizeForReport(p: ExtractedPair): 'AYVAZ' | 'НЗВЗ' | 'OBM' | 'OTHER' {
  if (p.matchMethod === 'explicit_obm_code') return 'OBM';
  if (p.matchMethod === 'explicit_colP_name') return 'AYVAZ';
  if (p.matchMethod.startsWith('price_proximity_nzvz') || p.matchMethod.startsWith('price_similarity_nzvz')) return 'НЗВЗ';
  return 'OTHER';
}

// ──────────────────────────────────────────────────────────────────
//  MAIN
// ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('[export-high-conf-xlsx] Start');

  const ETHALON_XLSX = pickEthalonPath();
  console.log(`Using эталон XLSX: ${ETHALON_XLSX}`);
  const ethalonRows = parseEthalonXlsx(ETHALON_XLSX);
  console.log(`Эталон rows with analog data: ${ethalonRows.length}`);

  console.log('Fetching prod invoice items (read-only GETs)...');
  const invoiceItems = await fetchAllInvoiceItems();
  console.log(`Loaded ${invoiceItems.length} unique invoice items from proj.12`);

  const pairs: ExtractedPair[] = [];
  for (const row of ethalonRows) {
    const pair = resolveInvoiceName(row, invoiceItems);
    if (pair) pairs.push(pair);
  }

  const highConf = pairs.filter((p) => p.confidence === 'high');
  const derivedConf = pairs.filter((p) => p.confidence === 'derived');
  console.log(`Total pairs: ${pairs.length} | high: ${highConf.length} | derived: ${derivedConf.length}`);

  // STRICT check per worker brief — do NOT massage data
  if (highConf.length !== EXPECTED_PAIR_COUNT) {
    console.error(`HARD STOP: expected ${EXPECTED_PAIR_COUNT} high-confidence pairs, got ${highConf.length}.`);
    console.error('Состав эталона/прода мог сместиться. Доложить владельцу до продолжения.');
    process.exit(2);
  }

  // Print categorized list
  const byCat: Record<string, ExtractedPair[]> = { AYVAZ: [], 'НЗВЗ': [], OBM: [], OTHER: [] };
  for (const p of highConf) byCat[categorizeForReport(p)].push(p);

  console.log(`\nКатегории high-conf пар:`);
  console.log(`  AYVAZ (explicit colP name): ${byCat.AYVAZ.length}`);
  console.log(`  НЗВЗ  (price+name tiebreak): ${byCat['НЗВЗ'].length}`);
  console.log(`  OBM   (explicit model code): ${byCat.OBM.length}`);
  console.log(`  OTHER: ${byCat.OTHER.length}`);

  for (const cat of ['AYVAZ', 'НЗВЗ', 'OBM', 'OTHER'] as const) {
    if (byCat[cat].length === 0) continue;
    console.log(`\n=== ${cat} ===`);
    for (const p of byCat[cat]) {
      const sp = p.specName.length > 70 ? p.specName.slice(0, 70) + '…' : p.specName;
      const iv = p.invoiceName.length > 70 ? p.invoiceName.slice(0, 70) + '…' : p.invoiceName;
      console.log(`  spec: ${sp}`);
      console.log(`    → invoice: ${iv}   [${p.matchMethod}]`);
    }
  }

  // Build XLSX:
  //   Headers chosen so backend import-matches detector recognizes them
  //   (см. detectColumns в matching.ts:1825 — case/space-tolerant keyword scan).
  //   Не нормализуем — backend нормализует сам (требование брифа Step 2).
  const sheetRows = [
    ['Наименование спецификации', 'Наименование в счёте'],
    ...highConf.map((p) => [p.specName, p.invoiceName]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(sheetRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'pairs');
  XLSX.writeFile(wb, OUT_XLSX);
  console.log(`\nXLSX written: ${OUT_XLSX} (${highConf.length + 1} rows incl. header)`);

  // Audit JSON
  const audit = highConf.map((p) => ({
    specName: p.specName,
    invoiceName: p.invoiceName,
    matchMethod: p.matchMethod,
    category: categorizeForReport(p),
  }));
  fs.writeFileSync(OUT_JSON, JSON.stringify(audit, null, 2), 'utf8');
  console.log(`JSON written: ${OUT_JSON}`);

  console.log(`\n[DONE] ${highConf.length} high-confidence pairs exported.`);
}

main().catch((err) => {
  console.error('[export-high-conf-xlsx] fatal:', err);
  process.exit(1);
});
