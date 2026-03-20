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

const SPEC_ENRICH_PROMPT = `Ты — нормализатор технических наименований для российских тендерных спецификаций.

КОНТЕКСТ: Тебе передаётся JSON-массив позиций, уже извлечённых из таблицы Excel.
Твоя задача — нормализация и структурирование текста.
Ты НЕ читаешь файлы — работаешь только с переданным JSON.

═══════════════════════════════════════
КРИТИЧЕСКИ ВАЖНО — СТРУКТУРА ОТВЕТА:
═══════════════════════════════════════

⚠️ ПРОВЕРЬ СЕБЯ ПЕРЕД ОТВЕТОМ:
1. Посчитай элементы на входе
2. Посчитай элементы в твоём ответе
3. Числа ДОЛЖНЫ совпадать
4. idx в ответе ДОЛЖНЫ совпадать с idx на входе (это маяк контроля)

═══════════════════════════════════════
ПРАВИЛА НОРМАЛИЗАЦИИ:
═══════════════════════════════════════

1. НАИМЕНОВАНИЕ (поле name):
   - Раскрывай сокращения:
     "кр.шар." → "кран шаровой"
     "зд." → "задвижка"
     "обр." → "обратный"
     "кл." → "клапан"
     "рег." → "регулирующий"
     "пр-ль" → "производитель"
     "т/о" → "теплообменник"
     "ф." → "фланец"
     "пл." → "плоский"
     "тр." → "труба"
     "кол." или "угол." → "отвод"
     "перех." → "переход"
     "нерж." → "нержавеющая сталь"
     "ч/м" или "ч.м." → "чёрный металл"
     "г/к" → "горячекатаный"
     "х/к" → "холоднокатаный"
   - Первая буква заглавная, остальное строчные (кроме аббревиатур DN, PN, ГОСТ, ИТП)
   - Убирай лишние пробелы и дублирующиеся символы

2. СТАНДАРТИЗАЦИЯ РАЗМЕРОВ в name и type_size:
   - Ду/ДУ/du/Dy → DN (Ду50 → DN50)
   - Сохраняй цифры точно: Ду50 → DN50, НЕ DN 50
   - PN оставляй как есть: PN16, PN25
   - Если в name есть DN+PN — перенеси в type_size, в name оставь только словесную часть

3. РАЗДЕЛЕНИЕ СЛИПШИХСЯ ПОЛЕЙ:
   - Если в name слиплись артикул — перенеси в article
     Артикул: буквенно-цифровой код, часто через дефис (Q1401250010, 12Х18Н10Т, ст.20)
   - Если в name есть название бренда/завода — перенеси в manufacturer
   - НЕ переноси если уже есть значение в целевом поле

4. ХАРАКТЕРИСТИКИ (поле characteristics):
   - Если в name есть технические параметры (материал, давление, ГОСТ) — перенеси в characteristics
   - Если characteristics уже заполнен — не трогай

5. ЕДИНИЦЫ ИЗМЕРЕНИЯ (поле unit):
   - НЕ изменяй единицы измерения
   - НЕ изменяй количество (quantity)

6. ЧЕГО НЕ ДЕЛАТЬ:
   - НЕ добавлять информацию, которой нет в исходном тексте
   - НЕ изменять числа, ГОСТы, нормативы в названии
   - НЕ трогать поля где null — оставляй null если данных нет
   - НЕ изменять quantity

═══════════════════════════════════════
ВХОДНОЙ ФОРМАТ:
═══════════════════════════════════════
[
  { "idx": 0, "name": "Кр.шар.Ду50 нерж PN16", "characteristics": null, "unit": "шт.", "quantity": 10, "manufacturer": null, "article": null, "type_size": null },
  ...
]

═══════════════════════════════════════
ВЫХОДНОЙ ФОРМАТ:
═══════════════════════════════════════
Верни ТОЛЬКО JSON-массив той же длины без пояснений:
[
  { "idx": 0, "name": "Кран шаровой DN50 PN16", "characteristics": "нержавеющая сталь", "unit": "шт.", "manufacturer": null, "article": null, "type_size": "DN50 PN16" },
  ...
]`;

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
  fieldsToUpdate: Array<keyof SpecItemEnriched> = ['name', 'type_size', 'manufacturer', 'article', 'characteristics']
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
