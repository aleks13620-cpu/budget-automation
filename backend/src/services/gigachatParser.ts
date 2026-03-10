/**
 * GigaChat Invoice Parser
 *
 * Парсит PDF-счета и изображения через GigaChat API.
 * Используется как основной парсер для PDF/изображений
 * и как fallback для Excel с низким confidence.
 */

import fs from 'fs';
import { chatCompletion } from './gigachatService';
import { InvoiceRow, InvoiceMetadata } from '../types/invoice';
import { ValidationResult } from '../types/validation';

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

const INVOICE_PROMPT = `Ты — эксперт по обработке российских коммерческих документов.

Проанализируй этот счёт/коммерческое предложение и извлеки данные.

ВАЖНО:
- Игнорируй водяные знаки, логотипы, декоративные элементы
- Цены указывай как числа без пробелов и символов (например: 936728.36)
- Если данных нет — ставь null
- "В том числе НДС" означает что НДС УЖЕ ВКЛЮЧЁН в итоговую сумму
- НЕ складывай и НЕ вычисляй суммы сам — бери только то что написано в документе
- Поле "total_with_vat" = итоговая сумма к оплате

Верни ТОЛЬКО JSON без пояснений:

{
  "document_type": "счет | коммерческое_предложение | спецификация",
  "document_number": "номер или null",
  "document_date": "ДД.ММ.ГГГГ или null",
  "supplier": {
    "name": "название поставщика или null",
    "inn": "ИНН (10 или 12 цифр) или null"
  },
  "buyer": {
    "name": "название покупателя или null",
    "inn": "ИНН или null"
  },
  "items": [
    {
      "position": 1,
      "article": "артикул или null",
      "name": "наименование товара",
      "quantity": 1.0,
      "unit": "шт",
      "price": 1000.00,
      "total": 1000.00
    }
  ],
  "vat_included": true,
  "vat_rate": 20,
  "vat_amount": 0.00,
  "total_with_vat": 0.00
}`;

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface GigaChatInvoiceResult {
  metadata: InvoiceMetadata;
  items: InvoiceRow[];
  rawResponse: string;
}

interface GigaChatParsedJSON {
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
    total?: number | null;
  }>;
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
    documentNumber: data.document_number || null,
    documentDate: data.document_date || null,
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
  // Читаем текст документа
  const ext = filePath.toLowerCase().split('.').pop();
  let docText = '';

  if (ext === 'pdf') {
    docText = await readPdfText(filePath);
  } else {
    // Для изображений передаём только имя файла — GigaChat Vision
    // пока не поддерживается в базовой интеграции, используем заглушку
    docText = `[Изображение: ${filePath}]`;
  }

  if (!docText.trim()) {
    throw new Error(`Не удалось извлечь текст из файла: ${filePath}`);
  }

  let rawResponse = '';
  let lastError: Error | null = null;

  // До 2 попыток при невалидном JSON
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
      console.warn(`[GigaChatParser] Attempt ${attempt} failed: ${lastError.message}`);

      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  throw new Error(
    `GigaChatParser: не удалось распарсить ответ после 2 попыток. ` +
    `Последняя ошибка: ${lastError?.message}. ` +
    `Ответ: ${rawResponse.slice(0, 200)}`
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
