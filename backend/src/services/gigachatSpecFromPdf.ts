/**
 * Извлечение таблицы спецификации из PDF-чертежа через GigaChat Files API.
 */

import { chatCompletion, uploadFile, deleteFile } from './gigachatService';
import { extractJSON, sanitizeJSON } from './gigachatParser';
import type { ParseResult, SpecificationRow } from '../types/specification';

// ---------------------------------------------------------------------------
// Промпт (формат как INVOICE_PROMPT: JSON, self-check)
// ---------------------------------------------------------------------------

const SPECIFICATION_PROMPT = `
Ты — эксперт по извлечению таблиц из российских проектных чертежей и спецификаций.

ЗАДАЧА: Найти на документе таблицу спецификации оборудования / материалов и извлечь строки в JSON.
Работай как сканер — копируй текст из документа, не выдумывай позиции.

═══════════════════════════════════════
ГДЕ ИСКАТЬ ТАБЛИЦУ:
═══════════════════════════════════════
Ищи заголовки вроде:
- «Спецификация оборудования»
- «Ведомость материалов и изделий»
- «Ведомость материалов»
- «Экспликация»
- «Спецификация»

Если несколько таблиц — объедини релевантные строки в один массив items (оборудование и материалы по разделу).

═══════════════════════════════════════
ПРОВЕРЬ СЕБЯ ПЕРЕД ОТВЕТОМ:
═══════════════════════════════════════
1. Посчитай строки с номерами позиций в таблице документа
2. Посчитай элементы в массиве items
3. Числа должны совпадать (если в документе явные пропуски номеров — сохрани номера как в документе)
4. У каждой позиции должно быть непустое name

═══════════════════════════════════════
ПРАВИЛА:
═══════════════════════════════════════
- position — номер позиции из первой колонки таблицы (целое число)
- name — наименование / обозначение
- characteristics — технические данные, марка, ГОСТ, если в отдельной колонке; иначе null
- unit — единица измерения (м, шт, компл, кг и т.д.) или null
- quantity — число; если не указано, null
- Числа в JSON: 10.5 без кавычек
- Дробная запятая в документе → точка в JSON

═══════════════════════════════════════
ОТВЕТ — ТОЛЬКО JSON:
═══════════════════════════════════════

{
  "section": "краткое название раздела или null",
  "items_count_check": "N позиций в таблице, N в массиве — ОК",
  "items": [
    {
      "position": 1,
      "name": "наименование",
      "characteristics": null,
      "unit": "шт",
      "quantity": 2.0
    }
  ]
}
`;

interface GigaChatSpecPdfJSON {
  section?: string | null;
  items_count_check?: string | null;
  items?: Array<{
    position?: number | string | null;
    name?: string | null;
    characteristics?: string | null;
    unit?: string | null;
    quantity?: number | null;
  }>;
}

function mapPdfItemsToRows(data: GigaChatSpecPdfJSON): SpecificationRow[] {
  const items = data.items ?? [];
  const rows: SpecificationRow[] = [];
  for (const it of items) {
    const name = (it.name ?? '').trim();
    if (!name) continue;
    const pos = it.position;
    const position_number =
      pos === null || pos === undefined ? null : String(pos).trim() || null;
    rows.push({
      position_number,
      name,
      characteristics: it.characteristics?.trim() || null,
      equipment_code: null,
      article: null,
      product_code: null,
      marking: null,
      type_size: null,
      manufacturer: null,
      unit: it.unit?.trim() || null,
      quantity: typeof it.quantity === 'number' ? it.quantity : null,
      full_name: null,
      _parentIndex: null,
    });
  }
  return rows;
}

/** Сырые строки для specification.raw_data (совместимость с редактором). */
export function buildRawDataFromPdfItems(rows: SpecificationRow[]): string[][] {
  const header = ['№', 'Наименование', 'Характеристики', 'Ед.', 'Кол-во'];
  const body = rows.map(r => [
    r.position_number ?? '',
    r.name,
    r.characteristics ?? '',
    r.unit ?? '',
    r.quantity != null ? String(r.quantity) : '',
  ]);
  return [header, ...body];
}

/**
 * Парсит PDF-чертёж: загрузка в Files API + GigaChat (как parsePdfViaFileApi для счетов).
 */
export async function parseSpecFromPdf(filePath: string): Promise<ParseResult> {
  const mimeType = 'application/pdf';
  let fileId: string | null = null;
  let rawResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (!fileId) {
        fileId = await uploadFile(filePath, mimeType);
      }

      rawResponse = await chatCompletion(
        [
          { role: 'system', content: SPECIFICATION_PROMPT },
          {
            role: 'user',
            content: 'Выполни инструкцию. Извлеки спецификацию из приложенного PDF-чертежа.',
            attachments: [fileId],
          },
        ],
        { model: 'GigaChat-2', temperature: 0.1, maxTokens: 32768 }
      );

      const jsonStr = sanitizeJSON(extractJSON(rawResponse));
      const parsed: GigaChatSpecPdfJSON = JSON.parse(jsonStr);
      const items = mapPdfItemsToRows(parsed);

      return {
        items,
        errors: [],
        totalRows: items.length,
        skippedRows: 0,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[parseSpecFromPdf] attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    } finally {
      if (attempt === 2 && fileId) {
        await deleteFile(fileId).catch(e => console.warn(`[parseSpecFromPdf] deleteFile: ${e.message}`));
      }
    }
  }

  if (fileId) {
    await deleteFile(fileId).catch(() => {});
  }

  return {
    items: [],
    errors: [
      `GigaChat (спецификация PDF): не удалось распознать после 2 попыток. ${lastError?.message ?? ''}`.trim(),
    ],
    totalRows: 0,
    skippedRows: 0,
  };
}
