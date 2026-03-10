/**
 * Тестовый скрипт: прогон всех счетов из experimental/test-invoices/
 * через routeInvoiceFile() и вывод сводной таблицы.
 *
 * Запуск:
 *   cd backend
 *   npx ts-node --project tsconfig.scripts.json scripts/test-invoice-processing.ts
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Загружаем .env до импорта сервисов (нужен GIGACHAT_AUTH_KEY)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { routeInvoiceFile } from '../src/services/invoiceRouter';
import type { RouterParseResult } from '../src/services/invoiceRouter';

// ---------------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(__dirname, '../experimental/test-invoices');
const SUPPORTED_EXTS = new Set(['.pdf', '.xlsx', '.xls', '.jpg', '.jpeg', '.png', '.tiff', '.bmp']);

// ---------------------------------------------------------------------------
// Форматирование вывода
// ---------------------------------------------------------------------------

const COL_W = {
  file:       28,
  source:     18,
  cat:         4,
  conf:        6,
  supplier:   24,
  inn:        14,
  items:       7,
  total:      14,
  valid:       8,
};

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
}

function rpad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + '…' : s.padStart(w);
}

function printHeader(): void {
  const h = [
    pad('Файл',         COL_W.file),
    pad('Источник',     COL_W.source),
    pad('Кат',          COL_W.cat),
    rpad('Conf',        COL_W.conf),
    pad('Поставщик',    COL_W.supplier),
    pad('ИНН',          COL_W.inn),
    rpad('Поз.',        COL_W.items),
    rpad('Итого',       COL_W.total),
    pad('Валид.',       COL_W.valid),
  ].join(' | ');
  const sep = '─'.repeat(h.length);
  console.log('\n' + sep);
  console.log(h);
  console.log(sep);
}

function printRow(
  fileName: string,
  result: RouterParseResult,
): void {
  const pr = result.parseResult;
  const meta = result.metadata;

  const supplier = meta?.supplierName || pr.supplierName || '—';
  const inn      = meta?.supplierINN  || '—';
  const total    = meta?.totalWithVat ?? pr.totalAmount;
  const totalStr = total != null ? total.toLocaleString('ru-RU') : '—';
  const validStr = result.validation
    ? (result.validation.valid ? 'OK' : `ERR(${result.validation.errors.length})`)
    : '—';

  const row = [
    pad(fileName,               COL_W.file),
    pad(result.source,          COL_W.source),
    pad(result.category,        COL_W.cat),
    rpad(String(result.confidence), COL_W.conf),
    pad(supplier,               COL_W.supplier),
    pad(inn,                    COL_W.inn),
    rpad(String(pr.items.length), COL_W.items),
    rpad(totalStr,              COL_W.total),
    pad(validStr,               COL_W.valid),
  ].join(' | ');

  console.log(row);
}

function printErrorRow(fileName: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const shortMsg = msg.slice(0, COL_W.source + COL_W.cat + COL_W.conf + COL_W.supplier + 12);
  console.log(
    pad(fileName, COL_W.file) + ' | ' +
    `\x1b[31mОШИБКА: ${shortMsg}\x1b[0m`
  );
}

// ---------------------------------------------------------------------------
// Основной цикл
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Собираем файлы
  const allFiles = fs.readdirSync(TEST_DIR);
  const files = allFiles.filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()));

  if (files.length === 0) {
    console.log(`Нет файлов в ${TEST_DIR}`);
    process.exit(0);
  }

  console.log(`\nТестируем ${files.length} файлов из ${TEST_DIR}`);
  printHeader();

  let ok = 0;
  let errors = 0;

  for (const fileName of files) {
    const filePath = path.join(TEST_DIR, fileName);
    try {
      const result = await routeInvoiceFile(filePath);
      printRow(fileName, result);
      ok++;
    } catch (err) {
      printErrorRow(fileName, err);
      errors++;
    }
  }

  // Сводка
  const sepLen = Object.values(COL_W).reduce((a, b) => a + b + 3, 0);
  console.log('─'.repeat(sepLen));
  console.log(`\nСводка: обработано ${files.length} | ✓ успешно: ${ok} | ✗ ошибки: ${errors}\n`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});
