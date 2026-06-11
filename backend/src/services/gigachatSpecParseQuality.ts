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

/** Порог доли строк без № позиции, выше которого pdfplumber-результат считаем низкокачественным (→ зовём LLM). */
export const LOW_QUALITY_NOPOS_FRACTION = 0.5;
/** Доля «голых» сирот, выше которой иерархия считается катастрофически развалённой → блок загрузки. */
export const HARD_BLOCK_BARE_ORPHAN_FRACTION = 0.5;
/** Меньше строк — не блокируем (мелкая/нестандартная спека). */
export const HARD_BLOCK_MIN_ROWS = 5;

/**
 * Сигнатура «потери колонки количества» (no_corrupt_through, проект 12 ОВ).
 * Когда у спеки «Поз.» пустая, парсер (LLM-путь GigaChat ИЛИ детерминированный
 * до фикса заголовков) сдвигает колонки: число из «Количество» попадает в
 * `position_number`, а `quantity` обнуляется почти у всех строк. Без количеств
 * смету нельзя посчитать/сматчить — это битые данные, которые НЕ должны течь в
 * матчер/обучение. Блокируем, когда ОБА признака выполнены:
 *  1) доля строк с quantity=null ≥ NULL_QTY_FRACTION (почти всё пусто), И
 *  2) доля строк, где position_number — это целое количество-образное число
 *     (1..N), ≥ POS_AS_QTY_FRACTION (значения сдвинулись в номер позиции).
 * Второй признак отличает коррупцию от валидной спеки, где у части родителей
 * количество законно пустое (оно на дочерних строках), но position_number там
 * либо настоящий номер позиции, либо пуст — НЕ количество-образный.
 */
export const HARD_BLOCK_NULL_QTY_FRACTION = 0.9;
export const HARD_BLOCK_POS_AS_QTY_FRACTION = 0.5;
/** Целое 1..4 знаков без дробной части — «количество-образно» в поле позиции. */
const QTY_SHAPED_POSITION_RE = /^\d{1,4}$/;

const BARE_PREFIX_RE = /^(dn|ду|дн|d|ø|⌀|pn|ру|f|ф)\s*=?\s*[ø⌀]?\s*\d/i;
/** Строка из почти одних цифр/размеров/кода: «C11-300-500», «300x200», «1а-2». */
const BARE_CODE_RE = /^[a-zа-яё]{0,4}\d[\d\s.,xх×*/_+-]*$/i;
const TO_ZHE_RE = /^то\s+же/i;

/**
 * «Голый» фрагмент — имя бессмысленно без родителя (типоразмер/код/«То же»).
 * Консервативно: длинные самодостаточные наименования (плоский список изделий)
 * сюда НЕ попадают, чтобы гейт не блокировал валидные не-иерархические спеки.
 */
function looksBareFragment(name: string | null | undefined): boolean {
  const n = (name || '').replace(/\s+/g, ' ').trim();
  if (!n) return true;
  if (TO_ZHE_RE.test(n)) return true;
  if (n.length <= 12) return true;
  if (n.length <= 28 && (BARE_PREFIX_RE.test(n) || BARE_CODE_RE.test(n))) return true;
  return false;
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

  // Доли по итоговым строкам: без № позиции, сироты, и «голые» сироты.
  let noPosFraction = 0;
  let orphanFraction = 0;
  let bareOrphanFraction = 0;
  if (mappedItems.length > 0) {
    const noPosRows = mappedItems.filter(r => !r.position_number || !r.position_number.trim());
    const noPos = noPosRows.length;
    const orphanRows = noPosRows.filter(r => r._parentIndex == null);
    const bareOrphans = orphanRows.filter(r => looksBareFragment(r.name)).length;
    noPosFraction = noPos / mappedItems.length;
    orphanFraction = orphanRows.length / mappedItems.length;
    bareOrphanFraction = bareOrphans / mappedItems.length;
    if (noPosFraction > 0.3) {
      warnings.push('У многих позиций не указан № в первой колонке — сверьте с чертежом');
      suggestElevatedReview = true;
    }
  }

  // Сигнатура потери колонки количества (проект 12 ОВ): почти все quantity=null
  // И значения уехали в position_number как количество-образные целые.
  let nullQtyFraction = 0;
  let posAsQtyFraction = 0;
  if (mappedItems.length > 0) {
    const nullQty = mappedItems.filter(r => r.quantity == null).length;
    const posAsQty = mappedItems.filter(
      r => r.position_number != null && QTY_SHAPED_POSITION_RE.test(r.position_number.trim()),
    ).length;
    nullQtyFraction = nullQty / mappedItems.length;
    posAsQtyFraction = posAsQty / mappedItems.length;
  }
  const quantityColumnLost =
    mappedItems.length >= HARD_BLOCK_MIN_ROWS &&
    nullQtyFraction >= HARD_BLOCK_NULL_QTY_FRACTION &&
    posAsQtyFraction >= HARD_BLOCK_POS_AS_QTY_FRACTION;

  // Жёсткий блок: иерархия катастрофически развалена — больше половины строк это
  // «голые» сироты (бессмысленные без родителя коды/типоразмеры). Плоский список
  // изделий с самодостаточными именами (orphanFraction высок, bareOrphanFraction низок)
  // НЕ блокируется — это валидная не-иерархическая спека. ЛИБО потеряна колонка
  // количества (сдвиг колонок при пустой «Поз.») — без количеств данные бесполезны.
  const hardBlock =
    (mappedItems.length >= HARD_BLOCK_MIN_ROWS &&
      bareOrphanFraction > HARD_BLOCK_BARE_ORPHAN_FRACTION) ||
    quantityColumnLost;
  if (quantityColumnLost) {
    warnings.push(
      `Потеряна колонка «Количество»: ${Math.round(nullQtyFraction * 100)}% строк без количества, ` +
        `${Math.round(posAsQtyFraction * 100)}% — число количества попало в № позиции (сдвиг колонок). Пришлите Excel или проверьте PDF.`,
    );
    suggestElevatedReview = true;
  } else if (
    mappedItems.length >= HARD_BLOCK_MIN_ROWS &&
    bareOrphanFraction > HARD_BLOCK_BARE_ORPHAN_FRACTION
  ) {
    warnings.push(
      `Иерархия не восстановлена: ${Math.round(bareOrphanFraction * 100)}% строк — оторванные от родителя типоразмеры/коды`,
    );
    suggestElevatedReview = true;
  }

  return {
    warnings,
    suggestElevatedReview,
    noPosFraction,
    orphanFraction,
    bareOrphanFraction,
    nullQtyFraction,
    posAsQtyFraction,
    quantityColumnLost,
    hardBlock,
  };
}
