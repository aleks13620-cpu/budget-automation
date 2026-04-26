/**
 * Сравнение pdfplumber vs GigaChat на 4 PDF-счётах
 * Запуск: node scripts/test_pdf_comparison.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Подключаем скомпилированный парсер
const ROOT = path.join(__dirname, '..');
const { parsePdfWithGigaChat, readPdfText } = require(path.join(ROOT, 'backend', 'dist', 'services', 'gigachatParser'));

// Настройка .env для GigaChat
require('dotenv').config({ path: path.join(ROOT, 'backend', '.env') });

const UPLOADS_DIR = path.join(ROOT, 'data', 'uploads');

const PDF_FILES = fs.readdirSync(UPLOADS_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

const SCAN_SIZE_MB = 5;

function sep(char = '=', n = 70) { return char.repeat(n); }

function fmtItems(items, max = 5) {
  return items.slice(0, max).map((it, i) =>
    `    #${i + 1}: ${String(it.name || '').slice(0, 60)}\n` +
    `       арт=${it.article || 'null'}  кол=${it.quantity}  цена=${it.price}  сумма=${it.amount}`
  ).join('\n');
}

async function testPdfPlumber(filePath) {
  // Используем pdfplumber через python subprocess
  const { execSync } = require('child_process');
  const script = `
import pdfplumber, re, json, sys
fp = sys.argv[1]
result = {'text_chars': 0, 'tables': 0, 'table_rows': 0, 'item_lines': 0, 'preview': '', 'error': None}
try:
    with pdfplumber.open(fp) as pdf:
        full_text = ''
        tables_count = 0
        rows_total = 0
        for page in pdf.pages:
            t = page.extract_text() or ''
            full_text += t + '\\n'
            for tbl in (page.extract_tables() or []):
                if tbl:
                    tables_count += 1
                    rows_total += len(tbl)
        result['text_chars'] = len(full_text.strip())
        result['tables'] = tables_count
        result['table_rows'] = rows_total
        item_lines = [l for l in full_text.splitlines() if re.match(r'^\\d+[\\. ]', l.strip())]
        result['item_lines'] = len(item_lines)
        result['preview'] = full_text.strip()[:400]
except Exception as e:
    result['error'] = str(e)
print(json.dumps(result, ensure_ascii=False))
`.trim();
  try {
    const out = execSync(`python -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}" "${filePath}"`, {
      timeout: 15000, encoding: 'utf8'
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { error: 'pdfplumber timeout или ошибка: ' + e.message.slice(0, 100) };
  }
}

async function main() {
  console.log(`PDF файлов: ${PDF_FILES.length}\n`);

  const results = [];

  for (const filename of PDF_FILES) {
    const filePath = path.join(UPLOADS_DIR, filename);
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const isLikelyScan = sizeMB > SCAN_SIZE_MB;

    console.log(sep());
    console.log(`ФАЙЛ: ${filename}`);
    console.log(`Размер: ${sizeMB.toFixed(1)} МБ`);
    console.log(sep());

    const row = { filename, sizeMB: sizeMB.toFixed(1), pdfplumber: null, gigachat: null };

    // ── pdfplumber ──────────────────────────────────────────
    console.log('\n[pdfplumber]');
    if (isLikelyScan) {
      console.log(`  Пропущен — вероятный скан (${sizeMB.toFixed(0)} МБ)`);
      row.pdfplumber = 'скан — пропущен';
    } else {
      const pl = await testPdfPlumber(filePath);
      if (pl.error) {
        console.log(`  Ошибка: ${pl.error}`);
        row.pdfplumber = `ошибка: ${pl.error}`;
      } else {
        console.log(`  Символов: ${pl.text_chars}  Таблиц: ${pl.tables}  Строк: ${pl.table_rows}  Позиций~: ${pl.item_lines}`);
        if (pl.text_chars === 0) {
          console.log(`  Текст не извлечён — вероятно скан`);
          row.pdfplumber = 'скан — 0 символов';
        } else {
          row.pdfplumber = `${pl.text_chars} символов, ${pl.tables} таблиц, ~${pl.item_lines} позиций`;
          if (pl.preview) {
            console.log(`\n  Текст (первые 300 символов):\n${pl.preview.slice(0, 300)}`);
          }
        }
      }
    }

    // ── GigaChat ──────────────────────────────────────────────
    console.log('\n[GigaChat]');
    try {
      // Сначала проверим есть ли текст (чтобы знать scan/text)
      const pdfText = await readPdfText(filePath).catch(() => '');
      const isScan = pdfText.trim().length < 200;
      console.log(`  PDF тип: ${isScan ? 'скан (нет текста)' : `текстовый (${pdfText.trim().length} символов)`}`);

      const gcResult = await parsePdfWithGigaChat(filePath);
      const { metadata, items, documentType, parseQuality } = gcResult;

      console.log(`  Тип документа: ${documentType || '?'}`);
      console.log(`  №${metadata.documentNumber}  от ${metadata.documentDate}`);
      console.log(`  Поставщик: ${metadata.supplierName}  ИНН: ${metadata.supplierINN}`);
      console.log(`  Покупатель: ${metadata.buyerName}`);
      console.log(`  Позиций: ${items.length}  |  Итог с НДС: ${metadata.totalWithVat}`);
      if (parseQuality?.warnings?.length) {
        parseQuality.warnings.forEach(w => console.log(`  ⚠ ${w}`));
      }
      if (items.length > 0) {
        console.log(`\n  Первые 5 позиций:\n${fmtItems(items)}`);
      }

      row.gigachat = `${items.length} позиций, итог=${metadata.totalWithVat}`;
      if (parseQuality?.suggestElevatedReview) {
        row.gigachat += ' ⚠️ требует проверки';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Ошибка GigaChat: ${msg.slice(0, 200)}`);
      row.gigachat = `ошибка: ${msg.slice(0, 80)}`;
    }

    results.push(row);
    console.log();
  }

  // ── Итоговая таблица ──────────────────────────────────────
  console.log('\n' + sep('─'));
  console.log('ИТОГ СРАВНЕНИЯ:');
  console.log(sep('─'));
  console.log(`${'Файл'.padEnd(42)} ${'pdfplumber'.padEnd(30)} GigaChat`);
  console.log(sep('─'));
  for (const r of results) {
    const fname = r.filename.slice(0, 40).padEnd(42);
    const pl = String(r.pdfplumber || '?').slice(0, 28).padEnd(30);
    const gc = String(r.gigachat || '?').slice(0, 50);
    console.log(`${fname} ${pl} ${gc}`);
  }
  console.log(sep('─'));
}

main().catch(err => {
  console.error('Критическая ошибка:', err.message);
  process.exit(1);
});
