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

5. ПОСТАВЩИК И ПОКУПАТЕЛЬ:
   - Копируй ТОЛЬКО название организации (ООО, АО, ИП + имя)
   - Максимум 150 символов
   - НЕ включай: адрес, телефон, ИНН, реквизиты, текст документа

6. НЕ ПУТАЙ СТАВКУ НДС С ЦЕНОЙ:
   - Ставка НДС — это процент: 0, 5, 7, 10, 18, 20, 22 или "20/120"
   - Ставка НДС НЕ является ценой товара
   - Цена товара — это стоимость единицы в рублях, обычно трёх- и более значное число
   - Если в таблице есть колонка "Ставка НДС" или "%" — ИГНОРИРУЙ её при заполнении поля price
   - ПРИЗНАК ОШИБКИ: если все цены одинаковые (например, все = 20 или все = 22) — значит ты взял ставку НДС вместо цены, исправь

═══════════════════════════════════════
ПРИМЕР ПРАВИЛЬНОГО РЕЗУЛЬТАТА:
═══════════════════════════════════════

Входной текст:
"""
Счёт на оплату № 154 от 15.02.2025
Поставщик: ООО "ПСТМ Престиж", ИНН 7701234567
Покупатель: АО "СтройГрупп", ИНН 7709876543

№  Наименование                           Кол-во  Ед  Цена       Сумма
1  Кабель ВВГнг 3х2,5 (ГОСТ 31996-2012)  200     м   45,50      9 100,00
2  Розетка наружная РА16-022              50      шт  189,00     9 450,00
3  Выключатель ВС10-1-0-Б                 30      шт  215,00     6 450,00

Итого без НДС: 25 000,00
НДС 20%: 5 000,00
Итого с НДС: 30 000,00
"""

Правильный JSON-ответ:
{
  "document_type": "счёт",
  "number": "154",
  "date": "15.02.2025",
  "supplier": { "name": "ООО ПСТМ Престиж", "inn": "7701234567" },
  "buyer": { "name": "АО СтройГрупп", "inn": "7709876543" },
  "items_count_check": "3 позиции в документе, 3 в массиве — ОК",
  "items": [
    { "position": 1, "article": null, "name": "Кабель ВВГнг 3х2,5 (ГОСТ 31996-2012)", "quantity": 200.0, "unit": "м", "price": 45.50, "discount_percent": null, "total": 9100.00 },
    { "position": 2, "article": null, "name": "Розетка наружная РА16-022", "quantity": 50.0, "unit": "шт", "price": 189.00, "discount_percent": null, "total": 9450.00 },
    { "position": 3, "article": null, "name": "Выключатель ВС10-1-0-Б", "quantity": 30.0, "unit": "шт", "price": 215.00, "discount_percent": null, "total": 6450.00 }
  ],
  "subtotal": 25000.00,
  "vat_rate": 20,
  "vat_amount": 5000.00,
  "total_with_vat": 30000.00
}

Обрати внимание:
- supplier.name и buyer.name — ТОЛЬКО название, без кавычек, ИНН и адресов
- price = цена единицы (45.50), НЕ ставка НДС
- total_with_vat = скопировано из "Итого с НДС" документа (30000.00)
- vat_amount взято из "НДС 20%" строки документа, НЕ вычислено

═══════════════════════════════════════
ОТВЕТ — ТОЛЬКО JSON:
═══════════════════════════════════════

{
  "document_type": "счёт | коммерческое_предложение | спецификация",
  "number": "номер",
  "date": "ДД.ММ.ГГГГ",
  "supplier": { "name": "только название компании (макс 150 символов)", "inn": "ИНН или null" },
  "buyer": { "name": "только название компании (макс 150 символов)", "inn": "ИНН или null" },
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
  /** Тип документа из ответа GigaChat — "счёт", "коммерческое_предложение", "спецификация" и т.д. */
  documentType: string | null;
}

interface GigaChatParsedJSON {
  document_type?: string | null;
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

/**
 * Надёжный ремонт JSON от GigaChat — посимвольный парсер.
 *
 * В отличие от regex-подхода, правильно отслеживает находимся ли мы
 * внутри строки — поэтому корректно обрабатывает сломанные строки.
 *
 * Исправляет:
 * - невалидные escape-последовательности (\П, \Ц, \р → П, Ц, р)
 * - реальные символы переноса строки/CR внутри строк → пробел
 * - управляющие символы (0x00–0x1F кроме допустимых) → убираем
 * - trailing commas перед } и ]
 */
function sanitizeJSON(json: string): string {
  let result = '';
  let inString = false;
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (inString) {
      if (ch === '\\') {
        const next = json[i + 1];
        if (next !== undefined && VALID_ESCAPES.has(next)) {
          // Валидная escape-последовательность — оставляем как есть
          result += ch + next;
          i++;
        } else if (next !== undefined) {
          // Невалидная escape (\П, \Ц, etc.) — убираем backslash, берём символ
          result += next;
          i++;
        }
        // next === undefined (backslash в конце строки) — просто пропускаем
      } else if (ch === '"') {
        inString = false;
        result += ch;
      } else if (ch === '\n' || ch === '\r') {
        // Реальный перенос строки внутри JSON-строки — заменяем пробелом
        result += ' ';
      } else if (ch < ' ') {
        // Прочие управляющие символы — пропускаем
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
        result += ch;
      } else {
        result += ch;
      }
    }
  }

  // Trailing commas: ,} и ,] — убираем
  result = result.replace(/,(\s*[}\]])/g, '$1');

  return result;
}

// Типичные ставки НДС — если цены совпадают с этими значениями, скорее всего ошибка парсинга
const VAT_RATES = new Set([0, 5, 7, 10, 18, 20, 22]);

/** Конвертирует распарсенный JSON в InvoiceRow[] */
function mapItems(items: GigaChatParsedJSON['items'] = []): InvoiceRow[] {
  const mapped = items
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

  // Детектор: если >50% цен — типичная ставка НДС (0/5/7/10/18/20/22),
  // значит GigaChat перепутал колонку "Ставка НДС" с "Ценой" → сбрасываем
  const pricesWithValues = mapped.filter(i => i.price !== null);
  if (pricesWithValues.length > 0) {
    const vatLikePrices = pricesWithValues.filter(i => VAT_RATES.has(i.price!));
    if (vatLikePrices.length / pricesWithValues.length > 0.5) {
      console.warn(`[GigaChatParser] VAT-rate price detector triggered: ${vatLikePrices.length}/${pricesWithValues.length} prices look like VAT rates — clearing prices`);
      mapped.forEach(i => { i.price = null; i.amount = null; });
    }
  }

  return mapped;
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
export async function parsePdfWithGigaChat(filePath: string, supplierContext?: string): Promise<GigaChatInvoiceResult> {
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
    return parsePdfViaFileApi(filePath, mimeType, supplierContext);
  }

  throw new Error(`Неподдерживаемый формат для GigaChat: .${ext}`);
}

/**
 * Загружает файл в GigaChat Files API и получает результат через attachments.
 * Файл удаляется после получения ответа.
 */
async function parsePdfViaFileApi(filePath: string, mimeType: string, supplierContext?: string): Promise<GigaChatInvoiceResult> {
  let fileId: string | null = null;
  let rawResponse = '';
  let lastError: Error | null = null;

  const contextPrefix = supplierContext ? `${supplierContext}\n\n` : '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Загружаем файл (только при первой попытке)
      if (!fileId) {
        fileId = await uploadFile(filePath, mimeType);
      }

      rawResponse = await chatCompletion(
        [
          { role: 'system', content: INVOICE_PROMPT },
          { role: 'user',   content: `${contextPrefix}Выполни инструкцию. Распознай документ.`, attachments: [fileId] },
        ],
        { model: 'GigaChat-2', temperature: 0.1, maxTokens: 32768 }
      );

      console.log(`[GigaChatParser] File API raw response (first 500): ${rawResponse.slice(0, 500)}`);

      const jsonStr = sanitizeJSON(extractJSON(rawResponse));
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
              { role: 'user',   content: `${contextPrefix}Выполни инструкцию. Распознай текст:\n\n${docText.slice(0, 20000)}` },
            ],
            { model: 'GigaChat-2', temperature: 0.1, maxTokens: 32768 }
          );
          console.log(`[GigaChatParser] Text fallback raw (first 500): ${textResponse.slice(0, 500)}`);
          const textParsed: GigaChatParsedJSON = JSON.parse(sanitizeJSON(extractJSON(textResponse)));
          const textItems = mapItems(textParsed.items);
          // Берём текстовый результат если он содержит хоть одну позицию
          if (textItems.length > 0) {
            return { metadata: mapMetadata(textParsed), items: textItems, rawResponse: textResponse, documentType: textParsed.document_type || null };
          }
        }
      }

      return {
        metadata: mapMetadata(parsed),
        items,
        rawResponse,
        documentType: parsed.document_type || null,
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
export async function parseExcelWithGigaChat(filePath: string, supplierContext?: string): Promise<GigaChatInvoiceResult> {
  const docText = excelToText(filePath);

  if (!docText.trim()) {
    throw new Error(`Не удалось извлечь текст из Excel-файла: ${filePath}`);
  }

  const contextPrefix = supplierContext ? `${supplierContext}\n\n` : '';
  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      rawResponse = await chatCompletion(
        [
          { role: 'system',    content: INVOICE_PROMPT },
          { role: 'user',      content: `${contextPrefix}Выполни инструкцию. Распознай текст:\n\n${docText.slice(0, 20000)}` },
        ],
        { model: 'GigaChat-2', temperature: 0.1, maxTokens: 32768 }
      );

      const jsonStr = sanitizeJSON(extractJSON(rawResponse));
      const parsed: GigaChatParsedJSON = JSON.parse(jsonStr);

      return {
        metadata: mapMetadata(parsed),
        items: mapItems(parsed.items),
        rawResponse,
        documentType: parsed.document_type || null,
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
