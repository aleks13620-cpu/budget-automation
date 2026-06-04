#!/usr/bin/env node
/**
 * DIAGNOSTIC ONLY — read-only. Writes NOTHING to the DB.
 *
 * OLD-vs-NEW data-gate on ONE real spec PDF:
 *   OLD = pdfplumber (current path, scripts/extract_pdf_table.py)
 *   NEW = GigaChat LLM (option C) using the production SPECIFICATION_PROMPT
 * Reports, for each: item count, how many carry a position number, how many a quantity,
 * and for NEW also how many "Левое/Правое исполнение" rows end up orphaned after the
 * current grouping (mapPdfItemsToRows). The uploaded GigaChat file is deleted afterwards.
 *
 * Run INSIDE the prod container:
 *   docker compose exec -T app node /tmp/diag_spec_pdf_llm.mjs ["/app/data/uploads/<file>.pdf"]
 * If no path is given, it auto-picks a heating/radiator-looking PDF from /app/data/uploads.
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

ЗАДАЧА: Найти на документе таблицу спецификации оборудования / материалов и извлечь строки в JSON.
Работай как сканер — копируй текст из документа, не выдумывай позиции.

ГДЕ ИСКАТЬ ТАБЛИЦУ: «Спецификация оборудования», «Ведомость материалов и изделий», «Ведомость материалов», «Экспликация», «Спецификация».
Если документ многостраничный — ищи продолжение таблицы на всех страницах.
Если внутри таблицы есть строки-заголовки разделов («I. Оборудование», «II. Материалы») — пропускай их.

ВАЖНО: СТРОКИ БЕЗ НОМЕРА ПОЗИЦИИ — это дочерние варианты (типоразмеры, DN, «То же») родительской строки выше. ОБЯЗАТЕЛЬНО включай их в items: position = null, name = текст из колонки «Наименование», unit/quantity/characteristics — как в документе.

ПРОВЕРЬ СЕБЯ: посчитай все строки таблицы с непустым наименованием (по всем страницам, включая без номера) и элементы в items — числа должны совпадать. У каждой позиции непустое name.

ПРАВИЛА:
- position — номер позиции из первой колонки (число или строка как есть); если нет — null
- name — наименование / обозначение
- characteristics — техданные/марка/ГОСТ, если в отдельной колонке; иначе null
- manufacturer — завод-изготовитель, если указан; иначе null
- marking — маркировка / артикул, если в отдельной колонке; иначе null
- type_size — типоразмер (Ду, DN, диаметр), если в отдельной колонке; иначе null
- unit — единица измерения или null
- quantity — число; если не указано, null
- note — примечание, если есть; иначе null
- Числа без кавычек; дробная запятая → точка

ОТВЕТ — ТОЛЬКО JSON:
{ "section": "...", "items_count_check": "...", "items": [ { "position": 1, "name": "...", "characteristics": null, "manufacturer": null, "marking": null, "type_size": null, "unit": "шт", "quantity": 2.0, "note": null } ] }
`;

function findPdf() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  const dir = '/app/data/uploads';
  let pdfs = [];
  try { pdfs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')); } catch {}
  if (pdfs.length === 0) return null;
  const pref = pdfs.find(f => /оа|ов1|отопл|радиат|31-54/i.test(f));
  console.log('PDF candidates in uploads:', pdfs);
  return path.join(dir, pref || pdfs[0]);
}

function countCol(items, key) {
  return items.filter(i => {
    const v = i[key];
    return v !== null && v !== undefined && String(v).trim() !== '';
  }).length;
}

async function runPdfplumber(file) {
  try {
    const { stdout } = await execFileAsync('python3', ['-X', 'utf8', '/app/scripts/extract_pdf_table.py', file], {
      timeout: 60000, maxBuffer: 10 * 1024 * 1024,
    });
    const res = JSON.parse(stdout);
    const items = res.items || [];
    return { items: items.length, withPosition: countCol(items, 'position'), withQty: countCol(items, 'quantity') };
  } catch (e) {
    return { error: e && e.message ? e.message.slice(0, 200) : String(e) };
  }
}

async function runGigaChat(file) {
  let pdfText = '';
  try { pdfText = (await readPdfText(file)).trim(); } catch {}
  const userContent =
    'Ниже извлечённый текст из PDF (для ориентира). Обязательно сверь с вложенным файлом и извлеки таблицу спецификации.\n\n---\n' +
    pdfText.slice(0, 40000) + '\n---';
  const models = getGigaChatFileJsonModelCandidates();
  let fileId = null;
  try {
    fileId = await uploadFile(file, 'application/pdf');
    const raw = await chatCompletion(
      [
        { role: 'system', content: SPECIFICATION_PROMPT },
        { role: 'user', content: userContent, attachments: [fileId] },
      ],
      { model: models[0], temperature: 0.1, maxTokens: 16384 },
    );
    let json;
    try {
      json = JSON.parse(sanitizeJSON(extractJSON(raw)));
    } catch (pe) {
      return { error: 'JSON parse failed', rawHead: String(raw).slice(0, 300) };
    }
    const items = json.items || [];
    const rows = mapPdfItemsToRows(json);
    const orphans = rows.filter(r => !r.full_name && /исполн|подключ/i.test(r.name || '')).length;
    return {
      model: models[0],
      rawItems: items.length,
      withPosition: countCol(items, 'position'),
      withQty: countCol(items, 'quantity'),
      afterGroupingRows: rows.length,
      afterGroupingQty: rows.filter(r => r.quantity != null).length,
      afterGroupingOrphanVariants: orphans,
      sample: items.slice(0, 12).map(i => ({ p: i.position, n: (i.name || '').slice(0, 48), u: i.unit, q: i.quantity })),
    };
  } catch (e) {
    return { error: e && e.message ? e.message.slice(0, 250) : String(e) };
  } finally {
    if (fileId) await deleteFile(fileId).catch(() => {});
  }
}

(async () => {
  const file = findPdf();
  if (!file) { console.log('No PDF found in /app/data/uploads'); process.exit(1); }
  console.log('FILE:', file, '\n');

  const old = await runPdfplumber(file);
  console.log('=== OLD (pdfplumber, current path) ===');
  console.log(JSON.stringify(old, null, 1), '\n');

  const neu = await runGigaChat(file);
  console.log('=== NEW (GigaChat LLM, option C) ===');
  console.log(JSON.stringify(neu, null, 1));
})();
