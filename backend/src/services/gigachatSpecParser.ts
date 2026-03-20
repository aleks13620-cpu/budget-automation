/**
 * GigaChat Specification Enricher
 *
 * Нормализует и обогащает позиции спецификации через GigaChat API.
 * Принимает распарсенные из Excel позиции (не файл), возвращает
 * те же позиции с улучшенными наименованиями и атрибутами.
 */

import { chatCompletion } from './gigachatService';

export interface SpecItemInput {
  idx: number;
  name: string;
  characteristics: string | null;
  unit: string | null;
  quantity: number | null;
  manufacturer: string | null;
  article: string | null;
  type_size: string | null;
}

export interface SpecItemEnriched {
  idx: number;
  name: string;
  characteristics: string | null;
  unit: string | null;
  manufacturer: string | null;
  article: string | null;
  type_size: string | null;
}

export interface EnrichDiff {
  idx: number;
  position_number: string | null;
  before: Partial<SpecItemEnriched>;
  after: Partial<SpecItemEnriched>;
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

const SPEC_ENRICH_PROMPT = `Ты — структуризатор технических спецификаций для российских строительных проектов.

КОНТЕКСТ: Тебе передаётся JSON-массив позиций из Excel-таблицы.
Ты НЕ читаешь файлы — работаешь только с переданным JSON.

═══════════════════════════════════════
ГЛАВНОЕ ПРАВИЛО — ЗАПОМНИ:
═══════════════════════════════════════

⛔ ПОЛЕ "name" НЕЛЬЗЯ ИЗМЕНЯТЬ.
   Скопируй его в ответ ДОСЛОВНО, символ в символ.
   Твоя задача — ТОЛЬКО заполнить пустые поля type_size, characteristics, article, manufacturer,
   извлекая данные из name как из источника, но не меняя само name.

═══════════════════════════════════════
КРИТИЧЕСКИ ВАЖНО — СТРУКТУРА ОТВЕТА:
═══════════════════════════════════════

⚠️ ПРОВЕРЬ СЕБЯ ПЕРЕД ОТВЕТОМ:
1. Посчитай элементы на входе
2. Посчитай элементы в твоём ответе
3. Числа ДОЛЖНЫ совпадать
4. idx в ответе ДОЛЖНЫ совпадать с idx на входе

═══════════════════════════════════════
ЧТО ЗАПОЛНЯТЬ (только если поле null):
═══════════════════════════════════════

1. type_size — типоразмер/габариты:
   Извлекай из name: диаметр (DN/Ду/ДУ), давление (PN), толщину (δ=, b=), сечение (мм×мм), δ=50мм и т.п.
   Примеры: "DN50 PN16", "δ=50мм", "300×200мм", "b=50мм"
   Ду/ДУ/du/Dy → DN при записи в type_size

2. characteristics — технические характеристики:
   Материал, стандарт, класс, способ исполнения — если явно указаны в name.
   Примеры: "без связующего", "базальтовое волокно", "нержавеющая сталь", "ГОСТ 30732-2006"

3. article — артикул:
   Буквенно-цифровой код без пробелов (BSTV, Q1401250010, 12Х18Н10Т).
   Только если это явно артикул, а не часть названия.

4. manufacturer — производитель:
   Название бренда или завода, если явно указано в name.

═══════════════════════════════════════
ЧЕГО НЕ ДЕЛАТЬ:
═══════════════════════════════════════
- НЕ изменять поле name — ни на букву
- НЕ изменять unit и quantity
- НЕ заполнять поля домыслами — только то, что явно есть в name
- НЕ трогать поле если оно уже не null

═══════════════════════════════════════
ПРИМЕР:
═══════════════════════════════════════
Вход:
{ "idx": 0, "name": "Огнезащитные маты на основе базальтового супертонкого штапельного волокна BSTV без связующего b=50мм", "characteristics": null, "unit": "м2", "quantity": 20, "manufacturer": null, "article": null, "type_size": null }

Выход:
{ "idx": 0, "name": "Огнезащитные маты на основе базальтового супертонкого штапельного волокна BSTV без связующего b=50мм", "characteristics": "без связующего, базальтовое волокно", "unit": "м2", "manufacturer": null, "article": "BSTV", "type_size": "b=50мм" }

Вход:
{ "idx": 1, "name": "Кр.шар.Ду50 нерж PN16", "characteristics": null, "unit": "шт.", "quantity": 5, "manufacturer": null, "article": null, "type_size": null }

Выход:
{ "idx": 1, "name": "Кр.шар.Ду50 нерж PN16", "characteristics": "нержавеющая сталь", "unit": "шт.", "manufacturer": null, "article": null, "type_size": "DN50 PN16" }

═══════════════════════════════════════
ВХОДНОЙ ФОРМАТ:
═══════════════════════════════════════
JSON-массив объектов. Верни ТОЛЬКО JSON-массив той же длины без пояснений.`;

// ---------------------------------------------------------------------------
// Санитизация JSON-ответа от GigaChat
// ---------------------------------------------------------------------------

function extractJsonArray(raw: string): string {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('JSON array not found in response');
  return raw.slice(start, end + 1);
}

function sanitizeJson(raw: string): string {
  let s = raw;
  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Fix escaped quotes
  s = s.replace(/\\'/g, "'");
  return s;
}

// ---------------------------------------------------------------------------
// Утилиты: задержка и retry
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 5000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('429') || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt); // 5s, 10s, 20s
      console.warn(`GigaChat 429 — retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Обогащение одного батча
// ---------------------------------------------------------------------------

const BATCH_SIZE = 15;          // уменьшен для снижения нагрузки
const INTER_BATCH_DELAY_MS = 3000; // пауза между батчами

async function enrichBatch(items: SpecItemInput[]): Promise<SpecItemEnriched[]> {
  const inputJson = JSON.stringify(items, null, 0);

  const messages = [
    { role: 'system' as const, content: SPEC_ENRICH_PROMPT },
    { role: 'user' as const, content: inputJson },
  ];

  const raw = await withRetry(() => chatCompletion(messages, { temperature: 0.1, maxTokens: 4000 }));

  let parsed: SpecItemEnriched[];
  try {
    const jsonStr = sanitizeJson(extractJsonArray(raw));
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`GigaChat returned invalid JSON: ${e}. Raw: ${raw.slice(0, 300)}`);
  }

  // Validate length
  if (!Array.isArray(parsed) || parsed.length !== items.length) {
    throw new Error(`GigaChat response length mismatch: expected ${items.length}, got ${parsed?.length}`);
  }

  // Validate idx alignment
  for (let i = 0; i < items.length; i++) {
    if (parsed[i].idx !== items[i].idx) {
      throw new Error(`idx mismatch at position ${i}: expected ${items[i].idx}, got ${parsed[i].idx}`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Публичная функция: обогатить все позиции
// ---------------------------------------------------------------------------

export interface EnrichResult {
  diffs: EnrichDiff[];
  updated: number;
  skipped: number;
  errors: string[];
}

export async function enrichSpecItems(
  items: Array<SpecItemInput & { position_number: string | null }>,
  fieldsToUpdate: Array<keyof SpecItemEnriched> = ['type_size', 'manufacturer', 'article', 'characteristics']
): Promise<EnrichResult> {
  const diffs: EnrichDiff[] = [];
  const errors: string[] = [];
  let updated = 0;
  let skipped = 0;

  // Split into batches (with delay between to avoid rate limiting)
  for (let batchStart = 0; batchStart < items.length; batchStart += BATCH_SIZE) {
    if (batchStart > 0) await sleep(INTER_BATCH_DELAY_MS);

    const batch = items.slice(batchStart, batchStart + BATCH_SIZE);
    const batchInputs: SpecItemInput[] = batch.map(it => ({
      idx: it.idx,
      name: it.name,
      characteristics: it.characteristics,
      unit: it.unit,
      quantity: it.quantity,
      manufacturer: it.manufacturer,
      article: it.article,
      type_size: it.type_size,
    }));

    let enriched: SpecItemEnriched[];
    try {
      enriched = await enrichBatch(batchInputs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Батч ${batchStart}-${batchStart + batch.length - 1}: ${msg}`);
      // Use originals for this batch
      enriched = batchInputs.map(it => ({
        idx: it.idx,
        name: it.name,
        characteristics: it.characteristics,
        unit: it.unit,
        manufacturer: it.manufacturer,
        article: it.article,
        type_size: it.type_size,
      }));
      skipped += batch.length;
    }

    for (let i = 0; i < batch.length; i++) {
      const original = batch[i];
      const result = enriched[i];

      const before: Partial<SpecItemEnriched> = {};
      const after: Partial<SpecItemEnriched> = {};
      let changed = false;

      for (const field of fieldsToUpdate) {
        if (field === 'idx' || field === 'unit') continue; // never touch unit
        const origVal = (original as any)[field] ?? null;
        const newVal = (result as any)[field] ?? null;
        if (newVal !== null && newVal !== origVal) {
          before[field] = origVal;
          after[field] = newVal;
          changed = true;
        }
      }

      diffs.push({
        idx: original.idx,
        position_number: original.position_number,
        before,
        after,
        changed,
      });

      if (changed) updated++;
    }
  }

  return { diffs, updated, skipped, errors };
}
