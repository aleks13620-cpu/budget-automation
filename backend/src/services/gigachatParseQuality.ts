import type { InvoiceRow } from '../types/invoice';

export interface GigaChatParseQuality {
  /** Короткие предупреждения для parsing_category_reason / API */
  warnings: string[];
  /** Рекомендуется поднять needs_amount_review или внимание оператора */
  suggestElevatedReview: boolean;
}

function extractExpectedCountFromCheck(check: string | null | undefined): number | null {
  if (!check || typeof check !== 'string') return null;
  const s = check.toLowerCase();
  const candidates: number[] = [];
  const rePos = /(\d+)\s+позиц/i.exec(s);
  if (rePos) candidates.push(parseInt(rePos[1], 10));
  const reArr = /(\d+)\s+в\s+массиве/i.exec(s);
  if (reArr) candidates.push(parseInt(reArr[1], 10));
  const reNam = /наименований[:\s]+(\d+)/i.exec(s);
  if (reNam) candidates.push(parseInt(reNam[1], 10));
  const reVsego = /всего\s+наименований[:\s]*(\d+)/i.exec(s);
  if (reVsego) candidates.push(parseInt(reVsego[1], 10));
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function maxDeclaredPosition(
  rawItems: Array<{ position?: number }> | undefined,
): number | null {
  if (!rawItems?.length) return null;
  const nums = rawItems
    .map(it => (typeof it.position === 'number' && it.position > 0 ? it.position : null))
    .filter((n): n is number => n != null);
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

function sumLineItemsApprox(items: InvoiceRow[]): number {
  return items.reduce((acc, it) => {
    const p = it.price ?? 0;
    const q = it.quantity ?? 0;
    if (it.amount != null && it.amount > 0) return acc + it.amount;
    return acc + p * q;
  }, 0);
}

/**
 * Эвристики полноты/согласованности ответа GigaChat по счёту (без смены основного парсера).
 */
export function evaluateGigaChatParseQuality(
  parsed: {
    items?: Array<{ position?: number; name?: string | null }>;
    items_count_check?: string | null;
  },
  mappedItems: InvoiceRow[],
  totalWithVat: number | null,
): GigaChatParseQuality {
  const warnings: string[] = [];
  let suggestElevatedReview = false;

  const mappedCount = mappedItems.length;
  const rawNamedCount =
    parsed.items?.filter(it => it.name && String(it.name).trim()).length ?? mappedCount;

  const expected = extractExpectedCountFromCheck(parsed.items_count_check ?? undefined);
  if (expected !== null && mappedCount < expected) {
    warnings.push(`GigaChat: в ответе ${mappedCount} поз., в self-check указано ${expected} — проверьте полноту`);
    suggestElevatedReview = true;
  }

  const maxPos = maxDeclaredPosition(parsed.items);
  if (maxPos !== null && maxPos > mappedCount) {
    warnings.push(`GigaChat: в таблице до поз. №${maxPos}, извлечено строк ${mappedCount} — возможны пропуски`);
    suggestElevatedReview = true;
  }

  if (rawNamedCount > mappedCount + 2) {
    warnings.push(`GigaChat: в JSON ${rawNamedCount} имён позиций, в импорт попало ${mappedCount}`);
    suggestElevatedReview = true;
  }

  if (totalWithVat != null && totalWithVat > 0 && mappedCount > 0) {
    const sum = sumLineItemsApprox(mappedItems);
    if (sum > 0) {
      const dev = Math.abs(sum - totalWithVat) / totalWithVat;
      if (dev > 0.15) {
        warnings.push(`GigaChat: сумма позиций (~${Math.round(sum)}) сильно расходится с итогом (${totalWithVat})`);
        suggestElevatedReview = true;
      }
    }
  }

  return { warnings, suggestElevatedReview };
}
