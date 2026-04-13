import type { SpecificationRow, SpecPdfParseQuality } from '../types/specification';

interface RawSpecItem {
  position?: number | string | null;
  name?: string | null;
}

function parsePositionNum(p: number | string | null | undefined): number | null {
  if (p === null || p === undefined) return null;
  if (typeof p === 'number' && Number.isFinite(p)) return Math.floor(p);
  const n = parseInt(String(p).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Проверка ответа GigaChat по спецификации из PDF: последовательность номеров, непустые name.
 */
export function evaluateSpecPdfParseQuality(
  rawItems: RawSpecItem[] | undefined,
  mappedItems: SpecificationRow[],
): SpecPdfParseQuality {
  const warnings: string[] = [];
  let suggestElevatedReview = false;

  const nums = (rawItems ?? [])
    .map(it => parsePositionNum(it.position))
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);

  if (nums.length >= 2) {
    for (let i = 1; i < nums.length; i++) {
      if (nums[i]! <= nums[i - 1]!) {
        warnings.push('Номера позиций в ответе не по возрастанию — проверьте таблицу');
        suggestElevatedReview = true;
        break;
      }
    }
    const min = nums[0]!;
    const max = nums[nums.length - 1]!;
    const expectedSpan = max - min + 1;
    if (nums.length < expectedSpan) {
      warnings.push(`Возможны пропуски номеров позиций: диапазон ${min}–${max}, строк ${nums.length}`);
      suggestElevatedReview = true;
    }
  }

  const emptyNames = (rawItems ?? []).filter(it => !it.name || !String(it.name).trim()).length;
  if (emptyNames > 0) {
    warnings.push(`В ответе ${emptyNames} поз. с пустым наименованием (отброшены при импорте)`);
    suggestElevatedReview = true;
  }

  if (mappedItems.length > 0) {
    const noPos = mappedItems.filter(r => !r.position_number || !r.position_number.trim()).length;
    if (noPos / mappedItems.length > 0.3) {
      warnings.push('У многих позиций не указан № в первой колонке — сверьте с чертежом');
      suggestElevatedReview = true;
    }
  }

  return { warnings, suggestElevatedReview };
}
