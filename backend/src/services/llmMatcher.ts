import { OpenAI } from 'openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_MATCHING_MODEL = 'google/gemini-2.5-flash';
const SPEC_BATCH_SIZE = 35;
const SPEC_BATCH_THRESHOLD = 50;
const MAX_INVOICE_ITEMS_PER_BATCH = 120;
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface LlmSpecItemInput {
  id: number;
  position_number?: string | null;
  name?: string | null;
  full_name?: string | null;
  characteristics?: string | null;
  equipment_code?: string | null;
  article?: string | null;
  product_code?: string | null;
  unit?: string | null;
  quantity?: number | null;
}

export interface LlmInvoiceItemInput {
  id: number;
  article?: string | null;
  name?: string | null;
  unit?: string | null;
  quantity?: number | null;
  price?: number | null;
  amount?: number | null;
  source?: string | null;
}

export interface LlmMatchResult {
  specItemId: number;
  invoiceItemId: number;
  confidence: number;
  reason: string;
}

interface GeminiMatchRow {
  specItemId?: unknown;
  invoiceItemId?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

interface GeminiMatchObject {
  matches?: unknown;
}

function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

function getItemName(item: { name?: string | null }): string {
  return typeof item.name === 'string' ? item.name.trim() : '';
}

function filterInvoiceItems(invoiceItems: LlmInvoiceItemInput[]): LlmInvoiceItemInput[] {
  return invoiceItems.filter(item => {
    const name = getItemName(item);
    return name.length >= 6 && hasLetters(name);
  });
}

export function isGeminiMatchingEnabled(): boolean {
  const value = process.env.ENABLE_OPENROUTER_LLM_MATCHING ?? '';
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return new Set(normalized.split(' ').filter(token => token.length >= 3));
}

function createSpecBatches(specItems: LlmSpecItemInput[]): LlmSpecItemInput[][] {
  if (specItems.length <= SPEC_BATCH_THRESHOLD) return [specItems];

  const batches: LlmSpecItemInput[][] = [];
  for (let i = 0; i < specItems.length; i += SPEC_BATCH_SIZE) {
    batches.push(specItems.slice(i, i + SPEC_BATCH_SIZE));
  }
  return batches;
}

function toPromptSpecItem(item: LlmSpecItemInput): Record<string, unknown> {
  return {
    id: item.id,
    position_number: item.position_number ?? null,
    name: item.name ?? null,
    full_name: item.full_name ?? null,
    characteristics: item.characteristics ?? null,
    equipment_code: item.equipment_code ?? null,
    article: item.article ?? null,
    product_code: item.product_code ?? null,
    unit: item.unit ?? null,
    quantity: item.quantity ?? null,
  };
}

function toPromptInvoiceItem(item: LlmInvoiceItemInput): Record<string, unknown> {
  return {
    id: item.id,
    article: item.article ?? null,
    name: item.name ?? null,
    unit: item.unit ?? null,
    quantity: item.quantity ?? null,
    source: item.source ?? null,
  };
}

function getSpecSearchText(item: LlmSpecItemInput): string {
  return [
    item.full_name,
    item.name,
    item.characteristics,
    item.equipment_code,
    item.article,
    item.product_code,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
}

function getInvoiceSearchText(item: LlmInvoiceItemInput): string {
  return [item.name, item.article]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
}

function scoreInvoiceForBatch(invoiceItem: LlmInvoiceItemInput, specTokens: Set<string>[]): number {
  const invoiceTokens = tokenize(getInvoiceSearchText(invoiceItem));
  if (invoiceTokens.size === 0) return 0;

  let bestScore = 0;
  for (const tokens of specTokens) {
    if (tokens.size === 0) continue;

    let overlap = 0;
    for (const token of tokens) {
      if (invoiceTokens.has(token)) overlap++;
    }
    if (overlap === 0) continue;

    const score = overlap / Math.sqrt(tokens.size * invoiceTokens.size);
    if (score > bestScore) bestScore = score;
  }

  return bestScore;
}

function selectInvoiceItemsForBatch(
  specBatch: LlmSpecItemInput[],
  invoiceItems: LlmInvoiceItemInput[],
): LlmInvoiceItemInput[] {
  if (invoiceItems.length <= MAX_INVOICE_ITEMS_PER_BATCH) return invoiceItems;

  const specTokens = specBatch.map(item => tokenize(getSpecSearchText(item)));
  const scored = invoiceItems
    .map((item, index) => ({ item, index, score: scoreInvoiceForBatch(item, specTokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.slice(0, MAX_INVOICE_ITEMS_PER_BATCH).map(row => row.item);
}

function buildPrompt(
  specBatch: LlmSpecItemInput[],
  invoiceItems: LlmInvoiceItemInput[],
): string {
  const specList = specBatch.map(toPromptSpecItem);
  const invoiceList = invoiceItems.map(toPromptInvoiceItem);

  return `You match construction budget specification items to supplier invoice or price-list rows.

Return ONLY strict JSON. Do not use Markdown. Do not add explanations outside JSON.
The JSON must be an array with objects in this exact shape:
[
  {
    "specItemId": 123,
    "invoiceItemId": 456,
    "confidence": 0.0,
    "reason": "short reason for this match"
  }
]

Rules:
- Return at most one best invoice item for each spec item.
- Omit a spec item if there is no plausible match.
- Use only ids that appear in the input lists.
- confidence must be a number from 0 to 1.
- reason must be concise and based on matching names, articles, dimensions, units, quantities, or model codes.

Specification items:
${JSON.stringify(specList)}

Invoice and price-list items:
${JSON.stringify(invoiceList)}`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    }

    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(text.slice(objectStart, objectEnd + 1));
    }
  }

  throw new Error('No JSON in Gemini matching response');
}

function asMatchRows(parsed: unknown): GeminiMatchRow[] {
  if (Array.isArray(parsed)) return parsed as GeminiMatchRow[];

  const object = parsed as GeminiMatchObject;
  if (object && Array.isArray(object.matches)) return object.matches as GeminiMatchRow[];

  return [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeMatches(
  rows: GeminiMatchRow[],
  specBatch: LlmSpecItemInput[],
  invoiceItems: LlmInvoiceItemInput[],
): LlmMatchResult[] {
  const specIds = new Set(specBatch.map(item => item.id));
  const invoiceIds = new Set(invoiceItems.map(item => item.id));
  const results: LlmMatchResult[] = [];

  for (const row of rows) {
    const specItemId = toNumber(row.specItemId);
    const invoiceItemId = toNumber(row.invoiceItemId);
    const confidence = toNumber(row.confidence);

    if (specItemId === null || invoiceItemId === null || confidence === null) continue;
    if (!specIds.has(specItemId) || !invoiceIds.has(invoiceItemId)) continue;

    const reason = typeof row.reason === 'string' && row.reason.trim().length > 0
      ? row.reason.trim()
      : 'Gemini semantic match';

    results.push({
      specItemId,
      invoiceItemId,
      confidence: Math.max(0, Math.min(confidence, 1)),
      reason,
    });
  }

  return results;
}

async function matchBatch(
  client: OpenAI,
  specBatch: LlmSpecItemInput[],
  invoiceItems: LlmInvoiceItemInput[],
): Promise<LlmMatchResult[]> {
  try {
    const invoiceItemsForBatch = selectInvoiceItemsForBatch(specBatch, invoiceItems);
    if (invoiceItemsForBatch.length === 0) return [];

    const response = await client.chat.completions.create({
      model: GEMINI_MATCHING_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: buildPrompt(specBatch, invoiceItemsForBatch),
        },
      ],
      max_tokens: 4096,
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = extractJson(raw);
    return normalizeMatches(asMatchRows(parsed), specBatch, invoiceItemsForBatch);
  } catch (err) {
    console.warn(`[GeminiMatcher] batch failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export async function matchWithGemini(
  specItems: LlmSpecItemInput[],
  invoiceItems: LlmInvoiceItemInput[],
): Promise<LlmMatchResult[]> {
  try {
    if (specItems.length === 0 || invoiceItems.length === 0) return [];
    if (!isGeminiMatchingEnabled() || !process.env.OPENROUTER_API_KEY) return [];

    const filteredInvoiceItems = filterInvoiceItems(invoiceItems);
    console.log(`[GeminiMatcher] invoice items: ${invoiceItems.length} total, ${filteredInvoiceItems.length} after filter (${invoiceItems.length - filteredInvoiceItems.length} excluded)`);
    if (filteredInvoiceItems.length === 0) return [];

    const client = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
      timeout: 60_000,
    });

    const batches = createSpecBatches(specItems);
    const results: LlmMatchResult[] = [];

    for (const batch of batches) {
      results.push(...await matchBatch(client, batch, filteredInvoiceItems));
    }

    return results;
  } catch (err) {
    console.warn(`[GeminiMatcher] matchWithGemini failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
