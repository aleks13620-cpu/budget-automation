/**
 * GigaChat Invoice Parser
 *
 * Парсит PDF-счета и изображения через GigaChat API.
 * Используется как основной парсер для PDF/изображений
 * и как fallback для Excel с низким confidence.
 */

import fs from 'fs';
import { chatCompletion, uploadFile, deleteFile } from './gigachatService';
import { InvoiceRow, InvoiceMetadata } from '../types/invoice';

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

const INVOICE_PROMPT = `
Ты — эксперт по извлечению данных из российских коммерческих документов.

ЗАДАЧА: Извлечь ТОЛЬКО коммерческую суть документа. Работай как сканер — копируй данные, не интерпретируй.

═══════════════════════════════════════
КРИТИЧЕСКИ ВАЖНО — ПОЛНОТА ДАННЫХ:
═══════════════════════════════════════

⚠️ ПРОВЕРЬ СЕБЯ ПЕРЕД ОТВЕТОМ:
1. Найди в документе строку "Всего наименований X" или последний номер позиции
2. Посчитай сколько элементов в твоём массиве items
3. Эти числа ДОЛЖНЫ совпадать
4. Если не совпадают — ты пропустил позиции, вернись и добавь

⚠️ ИТОГОВАЯ СУММА:
- Найди строку "Итого:" или "Итого с НДС:" в документе
- СКОПИРУЙ это число в total_with_vat
- НИКОГДА не суммируй позиции сам — твоя сумма будет неверной

═══════════════════════════════════════
ИЗВЛЕКАЙ:
═══════════════════════════════════════
- Тип документа (счёт, КП, спецификация)
- Номер и дата документа
- Поставщик: название, ИНН
- Покупатель: название, ИНН
- ВСЕ строки таблицы товаров — от первой до последней
- Итоговые суммы ИЗ ДОКУМЕНТА

═══════════════════════════════════════
ИГНОРИРУЙ:
═══════════════════════════════════════
- Банковские реквизиты (БИК, р/с, к/с)
- Адреса и телефоны
- Условия поставки/оплаты
- Рекламу, ссылки, промокоды
- Подписи, печати, QR-коды

═══════════════════════════════════════
ПРАВИЛА ИЗВЛЕЧЕНИЯ:
═══════════════════════════════════════

1. ПОЗИЦИИ ТОВАРОВ:
   - Извлеки КАЖДУЮ строку от № 1 до последнего номера
   - Позиции с одинаковым артикулом — это РАЗНЫЕ позиции
   - Не останавливайся на середине таблицы
   - Дойди до строки "Итого"

2. ЧИСЛА:
   - "1 044 777,53" → 1044777.53
   - Пробел = тысячи, запятая = дробная часть
   - В JSON без кавычек: 1044777.53

3. ТОЧНОСТЬ:
   - Дату копируй как есть: 21.01.2025
   - Артикул копируй как есть: Q1401250010-3
   - Нет данных → null

4. НДС:
   - vat_amount — только если явно указан, иначе null
   - НЕ вычисляй сам

═══════════════════════════════════════
ОТВЕТ — ТОЛЬКО JSON:
═══════════════════════════════════════

{
  "document_type": "счёт | коммерческое_предложение | спецификация",
  "number": "номер",
  "date": "ДД.ММ.ГГГГ",
  "supplier": { "name": "название", "inn": "ИНН или null" },
  "buyer": { "name": "название", "inn": "ИНН или null" },
  "items_count_check": "37 позиций в документе, 37 в массиве — ОК",
  "items": [
    {
      "position": 1,
      "article": "артикул",
      "name": "наименование",
      "quantity": 1.0,
      "unit": "шт",
      "price": 1000.00,
      "discount_percent": null,
      "total": 1000.00
    }
  ],
  "subtotal": null,
  "vat_rate": 20,
  "vat_amount": null,
  "total_with_vat": 1044777.53
}
`;

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface GigaChatInvoiceResult {
  metadata: InvoiceMetadata;
  items: InvoiceRow[];
  rawResponse: string;
}

interface GigaChatParsedJSON {
  // новые поля (обновлённый промпт)
  number?: string | null;
  date?: string | null;
  // старые поля (обратная совместимость)
  document_number?: string | null;
  document_date?: string | null;
  supplier?: { name?: string | null; inn?: string | null };
  buyer?: { name?: string | null; inn?: string | null };
  items?: Array<{
    position?: number;
    article?: string | null;
    name?: string;
    quantity?: number | null;
    unit?: string | null;
    price?: number | null;
    discount_percent?: number | null;
    total?: number | null;
  }>;
  subtotal?: number | null;
  vat_rate?: number | null;
  vat_amount?: number | null;
  total_with_vat?: number | null;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Читает PDF как текст через pdf-parse */
async function readPdfText(filePath: string): Promise<string> {
  const { PDFParse } = require('pdf-parse');
  const data = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText();
    return result?.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** Извлекает JSON из ответа GigaChat (может содержать ```json ... ```) */
function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace !== -1) {
    return text.slice(brace, lastBrace + 1);
  }
  return text.trim();
}

/** Конвертирует распарсенный JSON в InvoiceRow[] */
function mapItems(items: GigaChatParsedJSON['items'] = []): InvoiceRow[] {
  return items
    .filter(it => it.name && it.name.trim())
    .map((it, idx) => ({
      article: it.article || null,
      name: it.name || '',
      unit: it.unit || null,
      quantity: typeof it.quantity === 'number' ? it.quantity : null,
      quantity_packages: null,
      price: typeof it.price === 'number' ? it.price : null,
      amount: typeof it.total === 'number' ? it.total : null,
      row_index: idx,
    }));
}

/** Конвертирует распарсенный JSON в InvoiceMetadata */
function mapMetadata(data: GigaChatParsedJSON): InvoiceMetadata {
  return {
    // поддерживаем оба варианта полей (новый промпт и старый)
    documentNumber: data.number || data.document_number || null,
    documentDate: data.date || data.document_date || null,
    supplierName: data.supplier?.name || null,
    supplierINN: data.supplier?.inn || null,
    buyerName: data.buyer?.name || null,
    buyerINN: data.buyer?.inn || null,
    totalWithVat: typeof data.total_with_vat === 'number' ? data.total_with_vat : null,
    vatAmount: typeof data.vat_amount === 'number' ? data.vat_amount : null,
  };
}

// ---------------------------------------------------------------------------
// Публичное API
// ---------------------------------------------------------------------------

/**
 * Парсит PDF-счёт через GigaChat.
 * Делает до 2 попыток при невалидном JSON.
 */
export async function parsePdfWithGigaChat(filePath: string): Promise<GigaChatInvoiceResult> {
  const ext = filePath.toLowerCase().split('.').pop();

  // PDF и изображения — загружаем через Files API (нативное чтение GigaChat)
  const MIME_MAP: Record<string, string> = {
    pdf:  'application/pdf',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    png:  'image/png',
    tiff: 'image/tiff',
    bmp:  'image/bmp',
  };

  const mimeType = ext ? MIME_MAP[ext] : undefined;

  if (mimeType) {
    return parsePdfViaFileApi(filePath, mimeType);
  }

  throw new Error(`Неподдерживаемый формат для GigaChat: .${ext}`);
}

/**
 * Загружает файл в GigaChat Files API и получает результат через attachments.
 * Файл удаляется после получения ответа.
 */
async function parsePdfViaFileApi(filePath: string, mimeType: string): Promise<GigaChatInvoiceResult> {
  let fileId: string | null = null;
  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Загружаем файл (только при первой попытке)
      if (!fileId) {
        fileId = await uploadFile(filePath, mimeType);
      }

      rawResponse = await chatCompletion(
        [
          { role: 'system', content: INVOICE_PROMPT },
          { role: 'user',   content: 'Выполни инструкцию. Распознай документ.', attachments: [fileId] },
        ],
        { model: 'GigaChat-2', temperature: 0.1, maxTokens: 4096 }
      );

      console.log(`[GigaChatParser] File API raw response (first 500): ${rawResponse.slice(0, 500)}`);

      const jsonStr = extractJSON(rawResponse);
      const parsed: GigaChatParsedJSON = JSON.parse(jsonStr);
      const items = mapItems(parsed.items);

      // Если File API вернул мало позиций — пробуем через текст
      if (items.length < 3 && mimeType === 'application/pdf') {
        console.log(`[GigaChatParser] File API items=${items.length} < 3 — fallback to text extraction`);
        const docText = await readPdfText(filePath);
        if (docText.trim()) {
          const textResponse = await chatCompletion(
            [
              { role: 'system', content: INVOICE_PROMPT },
              { role: 'user',   content: `Выполни инструкцию. Распознай текст:\n\n${docText.slice(0, 20000)}` },
            ],
            { model: 'GigaChat-2', temperature: 0.1, maxTokens: 4096 }
          );
          console.log(`[GigaChatParser] Text fallback raw (first 500): ${textResponse.slice(0, 500)}`);
          const textParsed: GigaChatParsedJSON = JSON.parse(extractJSON(textResponse));
          const textItems = mapItems(textParsed.items);
          // Берём текстовый результат если он содержит хоть одну позицию
          if (textItems.length > 0) {
            return { metadata: mapMetadata(textParsed), items: textItems, rawResponse: textResponse };
          }
        }
      }

      return {
        metadata: mapMetadata(parsed),
        items,
        rawResponse,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[GigaChatParser] File API attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    } finally {
      // Удаляем файл после последней попытки
      if (attempt === 2 && fileId) {
        await deleteFile(fileId).catch(e => console.warn(`[GigaChatParser] deleteFile failed: ${e.message}`));
      }
    }
  }

  // Если fileId был создан — удаляем
  if (fileId) {
    await deleteFile(fileId).catch(() => {});
  }

  throw new Error(
    `GigaChatParser: не удалось распарсить после 2 попыток. ` +
    `Ошибка: ${lastError?.message}. Ответ: ${rawResponse.slice(0, 200)}`
  );
}

/**
 * Конвертирует Excel-файл в компактный текст для отправки в GigaChat.
 * Фильтрует пустые строки и пустые колонки чтобы сократить объём текста.
 */
function excelToText(filePath: string): string {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Убираем полностью пустые строки
  const nonEmptyRows = rawRows.filter(row => row.some(cell => String(cell).trim() !== ''));

  if (nonEmptyRows.length === 0) return '';

  const colCount = Math.max(...nonEmptyRows.map(r => r.length), 0);

  // Оставляем только колонки, непустые хотя бы в одной строке
  const nonEmptyCols = Array.from({ length: colCount }, (_, i) => i)
    .filter(ci => nonEmptyRows.some(row => String(row[ci] ?? '').trim() !== ''));

  return nonEmptyRows
    .map(row =>
      nonEmptyCols
        .map(ci => String(row[ci] ?? '').replace(/\n/g, ' ').trim())
        .join('\t')
    )
    .join('\n');
}

/**
 * Парсит Excel-счёт через GigaChat.
 * Конвертирует таблицу в текст и отправляет с тем же промптом.
 */
export async function parseExcelWithGigaChat(filePath: string): Promise<GigaChatInvoiceResult> {
  const docText = excelToText(filePath);

  if (!docText.trim()) {
    throw new Error(`Не удалось извлечь текст из Excel-файла: ${filePath}`);
  }

  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      rawResponse = await chatCompletion(
        [
          { role: 'system',    content: INVOICE_PROMPT },
          { role: 'user',      content: `Выполни инструкцию. Распознай текст:\n\n${docText.slice(0, 20000)}` },
        ],
        { model: 'GigaChat-2', temperature: 0.1, maxTokens: 4096 }
      );

      const jsonStr = extractJSON(rawResponse);
      const parsed: GigaChatParsedJSON = JSON.parse(jsonStr);

      return {
        metadata: mapMetadata(parsed),
        items: mapItems(parsed.items),
        rawResponse,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[GigaChatParser] Excel attempt ${attempt} failed: ${lastError.message}`);

      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  throw new Error(
    `GigaChatParser Excel: не удалось распарсить ответ после 2 попыток. ` +
    `Последняя ошибка: ${lastError?.message}. ` +
    `Ответ: ${rawResponse.slice(0, 200)}`
  );
}
