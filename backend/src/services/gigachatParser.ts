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
import { ValidationResult } from '../types/validation';

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

const INVOICE_PROMPT = `
Ты — эксперт по извлечению данных из российских коммерческих документов.

ЗАДАЧА: Извлечь ТОЛЬКО коммерческую суть документа.

ИЗВЛЕКАЙ:
- Тип документа (счёт, КП, спецификация)
- Номер и дата документа
- Поставщик: название, ИНН
- Покупатель: название, ИНН
- Таблица товаров: позиция, артикул, наименование, количество, единица, цена, скидка (если есть), сумма
- Итого, НДС, Итого с НДС

ИГНОРИРУЙ (не включай в ответ):
- Банковские реквизиты (БИК, р/с, к/с)
- Адреса и телефоны
- Условия поставки и оплаты
- Рекламу, ссылки, промокоды
- Подписи, печати, QR-коды
- Юридические оговорки
- Информацию о гарантии
- Контакты менеджеров

ПРАВИЛА:
- Дату бери ТОЧНО как написано в документе, не изменяй цифры
- Числа в российском формате: пробел — разделитель тысяч, запятая — десятичный разделитель. Пример: "1 044 777,53" = 1044777.53; "384 243,75" = 384243.75. В JSON пиши как число: 384243.75
- Если данных нет — ставь null (не строку "null", а именно null)
- Если ИНН не указан — ставь null
- total_with_vat — бери из строки "Итого с НДС" или "Итого" в документе. НЕ суммируй позиции сам
- vat_amount бери из документа как есть. Если сумма НДС не указана явно — ставь null. НЕ вычисляй сам
- Артикул бери точно как написано, сохраняй дефисы и специальные символы
- НДС обычно УЖЕ ВКЛЮЧЁН в итоговую сумму ("в т.ч. НДС", "Итого с НДС")
- НЕ вычисляй и НЕ пересчитывай суммы — бери только то что написано в документе
- Извлеки ВСЕ строки таблицы товаров — не пропускай ни одной позиции, даже если они похожи или повторяются

ОТВЕТ — ТОЛЬКО JSON, без пояснений и комментариев:

{
  "document_type": "счёт | коммерческое_предложение | спецификация",
  "number": "номер документа",
  "date": "ДД.ММ.ГГГГ",
  "supplier": {
    "name": "ООО Название",
    "inn": "1234567890"
  },
  "buyer": {
    "name": "ООО Название",
    "inn": "1234567890"
  },
  "items": [
    {
      "position": 1,
      "article": "артикул или null",
      "name": "наименование товара",
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
  "total_with_vat": 1000.00
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
        { model: 'GigaChat-2', temperature: 0.1, maxTokens: 4096, functionCall: 'auto' }
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
              { role: 'user',   content: `Выполни инструкцию. Распознай текст:\n\n${docText.slice(0, 8000)}` },
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
 * Конвертирует Excel-файл в читаемый текст (CSV) для отправки в GigaChat.
 * Берёт первый лист, пропускает пустые строки.
 */
function excelToText(filePath: string): string {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  return rows
    .filter((row: string[]) => row.some((cell: string) => String(cell).trim() !== ''))
    .map((row: string[]) =>
      row
        .map((cell: string) => String(cell).replace(/\n/g, ' ').trim())
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
          { role: 'user',      content: `Выполни инструкцию. Распознай текст:\n\n${docText.slice(0, 8000)}` },
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
