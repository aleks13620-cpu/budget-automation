#!/usr/bin/env node
/**
 * DIAGNOSTIC ONLY — read-only. Writes NOTHING to the DB.
 *
 * v2: (1) finds the spec PDF by CONTENT (disk names are hashed),
 *     (2) tries EVERY GigaChat model candidate and reports status per model
 *         (ok / 402 / error) — hard evidence of which tiers the account supports,
 *     (3) for the first model that returns valid JSON, reports structure recovery:
 *         items, withPosition, withQty, and orphaned variant rows after grouping.
 * OLD baseline (pdfplumber) is run on the same file for comparison.
 * The uploaded GigaChat file is deleted afterwards.
 *
 * Run INSIDE the prod container:
 *   docker compose exec -T app node /tmp/diag_spec_pdf_llm_v2.mjs ["/app/data/uploads/<file>.pdf"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const DIST = '/app/backend/dist/services';
const { uploadFile, chatCompletion, deleteFile, getGigaChatFileJsonModelCandidates } = require(`${DIST}/gigachatService.js`);
const { readPdfText, extractJSON, sanitizeJSON } = require(`${DIST}/gigachatParser.js`);
const { mapPdfItemsToRows } = require(`${DIST}/gigachatSpecFromPdf.js`);

const SPECIFICATION_PROMPT = `
Ты — эксперт по извлечению таблиц из российских проектных чертежей и спецификаций.
ЗАДАЧА: Найти таблицу спецификации оборудования / материалов и извлечь строки в JSON. Работай как сканер.
ВАЖНО: строки БЕЗ номера позиции — дочерние варианты (типоразмеры, DN, «То же», «Левое/Правое исполнение») родительской строки выше. Включай их в items с position = null, name = текст из колонки «Наименование», unit/quantity/characteristics как в документе.
ПРАВИЛА: position — номер из первой колонки или null; name — наименование; characteristics/manufacturer/marking/type_size — если в отдельной колонке, иначе null; unit — ед.изм или null; quantity — число или null. Дробная запятая → точка.
ОТВЕТ — ТОЛЬКО JSON: { "section": "...", "items": [ { "position": 1, "name": "...", "characteristics": null, "manufacturer": null, "marking": null, "type_size": null, "unit": "шт", "quantity": 2.0, "note": null } ] }
`;

const MARKERS = ['исполнение', 'конвектор', 'радиатор', 'tepla', 'отоплен', 'оа-06', '31-54', 'рку этаж', 'дн89', 'evra'];

function countCol(items, key) {
  return items.filter(i => { const v = i[key]; return v !== null && v !== undefined && String(v).trim() !== ''; }).length;
}

async function findPdf() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  const dir = '/app/data/uploads';
  let pdfs = [];
  try { pdfs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')); } catch {}
  let best = null, bestScore = -1;
  for (const f of pdfs) {
    const p = path.join(dir, f);
    let t = '';
    try { t = (await readPdfText(p)).toLowerCase(); } catch {}
    const score = MARKERS.reduce((a, m) => a + (t.includes(m) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  console.log(`Best PDF by content markers: ${best} (markerScore=${bestScore})`);
  return best;
}

async function runPdfplumber(file) {
  try {
    const { stdout } = await execFileAsync('python3', ['-X', 'utf8', '/app/scripts/extract_pdf_table.py', file], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const res = JSON.parse(stdout);
    const items = res.items || [];
    return { items: items.length, withPosition: countCol(items, 'position'), withQty: countCol(items, 'quantity') };
  } catch (e) { return { error: (e && e.message ? e.message : String(e)).slice(0, 200) }; }
}

async function runGigaChat(file) {
  let pdfText = '';
  try { pdfText = (await readPdfText(file)).trim(); } catch {}
  const userContent = 'Ниже извлечённый текст из PDF (для ориентира). Сверь с вложенным файлом и извлеки таблицу спецификации.\n\n---\n' + pdfText.slice(0, 40000) + '\n---';
  const models = getGigaChatFileJsonModelCandidates();
  console.log('Model candidates (in order):', models);
  const perModel = [];
  let fileId = null, ok = null;
  try {
    fileId = await uploadFile(file, 'application/pdf');
    for (const model of models) {
      try {
        const raw = await chatCompletion(
          [ { role: 'system', content: SPECIFICATION_PROMPT }, { role: 'user', content: userContent, attachments: [fileId] } ],
          { model, temperature: 0.1, maxTokens: 16384 },
        );
        let json;
        try { json = JSON.parse(sanitizeJSON(extractJSON(raw))); }
        catch { perModel.push({ model, status: 'ok-but-not-json', rawHead: String(raw).slice(0, 160) }); continue; }
        const items = json.items || [];
        const rows = mapPdfItemsToRows(json);
        ok = {
          model, rawItems: items.length,
          withPosition: countCol(items, 'position'), withQty: countCol(items, 'quantity'),
          afterGroupingRows: rows.length, afterGroupingQty: rows.filter(r => r.quantity != null).length,
          afterGroupingOrphanVariants: rows.filter(r => !r.full_name && /исполн|подключ/i.test(r.name || '')).length,
          sample: items.slice(0, 14).map(i => ({ p: i.position, n: (i.name || '').slice(0, 50), u: i.unit, q: i.quantity })),
        };
        perModel.push({ model, status: 'ok' });
        break;
      } catch (e) {
        perModel.push({ model, status: 'error', msg: (e && e.message ? e.message : String(e)).slice(0, 140) });
      }
    }
  } catch (e) {
    return { perModel, fatal: (e && e.message ? e.message : String(e)).slice(0, 200) };
  } finally {
    if (fileId) await deleteFile(fileId).catch(() => {});
  }
  return { perModel, ok };
}

(async () => {
  const file = await findPdf();
  if (!file) { console.log('No PDF found in /app/data/uploads'); process.exit(1); }
  console.log('FILE:', file, '\n');
  const old = await runPdfplumber(file);
  console.log('=== OLD (pdfplumber, current path) ===');
  console.log(JSON.stringify(old, null, 1), '\n');
  const neu = await runGigaChat(file);
  console.log('=== NEW (GigaChat LLM, per-model) ===');
  console.log('per-model status:', JSON.stringify(neu.perModel, null, 1));
  if (neu.fatal) console.log('fatal:', neu.fatal);
  console.log('first-ok structure:', JSON.stringify(neu.ok, null, 1));
})();
