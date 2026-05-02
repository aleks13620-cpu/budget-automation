import fs from 'fs';
import { OpenAI } from 'openai';
import type { InvoiceParseResult, InvoiceRow } from '../types/invoice';

const PROMPT = `Ты — эксперт по извлечению данных из российских счетов поставщиков.
Верни ТОЛЬКО JSON-объект без пояснений и блоков кода:
{
  "invoice_number": "номер счёта или null",
  "invoice_date": "дата ДД.ММ.ГГГГ или null",
  "supplier_name": "название организации (ООО/АО/ИП) без адреса и ИНН или null",
  "total_amount": число или null,
  "items": [{"name":"...","article":"...|null","unit":"...|null","quantity":число|null,"price":число|null,"amount":число|null}]
}
Правила: items — ВСЕ позиции, итоговые строки (Итого/НДС/Всего) не включать.
Числа — только цифры без пробелов. "1 044,50" → 1044.50. total_amount — итого с НДС.`;

const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface GeminiRow {
  name: string;
  article?: string | null;
  unit?: string | null;
  quantity?: number | null;
  price?: number | null;
  amount?: number | null;
}

interface GeminiResponse {
  invoice_number?: string | null;
  invoice_date?: string | null;
  supplier_name?: string | null;
  total_amount?: number | null;
  items?: GeminiRow[];
}

function extractJson(text: string): string {
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) return text.slice(objStart, objEnd + 1);
  throw new Error('No JSON object in Gemini response');
}

export async function ocrPdfWithGemini(filePath: string): Promise<InvoiceParseResult | null> {
  try {
    const buffer = await fs.promises.readFile(filePath);

    if (buffer.length > MAX_FILE_BYTES) {
      console.warn(`[GeminiOCR] File too large for OCR (${buffer.length} bytes), skipping`);
      return null;
    }

    const b64 = buffer.toString('base64');

    const client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      timeout: 60_000,
    });

    const response = await client.chat.completions.create({
      model: 'google/gemini-2.5-flash',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:application/pdf;base64,${b64}` },
            },
            {
              type: 'text',
              text: PROMPT,
            },
          ],
        },
      ],
      max_tokens: 4096,
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const parsed: GeminiResponse = JSON.parse(extractJson(raw));
    const rows: GeminiRow[] = Array.isArray(parsed.items) ? parsed.items : [];

    const items: InvoiceRow[] = rows
      .filter(row => typeof row.name === 'string' && row.name.trim().length > 0)
      .map((row, idx) => ({
        article: row.article || null,
        name: row.name.trim(),
        unit: row.unit || null,
        quantity: row.quantity ?? null,
        quantity_packages: null,
        price: row.price ?? null,
        amount: row.amount ?? null,
        row_index: idx,
      }));

    return {
      items,
      errors: [],
      totalRows: items.length,
      skippedRows: rows.length - items.length,
      invoiceNumber: parsed.invoice_number ?? null,
      invoiceDate: parsed.invoice_date ?? null,
      supplierName: parsed.supplier_name ?? null,
      totalAmount: typeof parsed.total_amount === 'number' ? parsed.total_amount : null,
      vatAmount: null,
      discountDetected: null,
    };
  } catch (err) {
    console.warn(`[GeminiOCR] ocrPdfWithGemini failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
