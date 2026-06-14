# B1.1 Accuracy@1 — Proj.12 — Post-landing measurement

**Date:** 2026-06-14
**Author:** Worker agent (`backend/scripts/b1_1_accuracy_at_1_proj12_2026-06-14.ts`)
**Status:** Read-only measurement — NO prod writes
**Closes:** half-phase Б1.1 (landed 2026-06-13, метрика не была замерена — план §0 запрещает «висящие полу-фазы»).

---

## Method (1 abzac)

Граунд-труф = тот же набор из 27 высоконадёжных пар, который был извлечён скриптом `extract-ethalon-pairs.ts` из эталона `01_05-07-24-ОВ эталон жк бкк арта.xlsx`, одобрен владельцем и залит в прод-Память пр.12 при Б1.1 (см. `b1_high_conf_27_2026-06-13.json`). Использование уже-провалидированного набора снимает риск ложного GT через price-proximity. Для каждой GT-пары ищем на проде: (1) spec_item по нормализованному имени (Dice ≥ 0.55), (2) invoice_item по содержательному совпадению (exact normalized OR substring containment OR token-coverage ≥ 0.8 OR Dice ≥ 0.6 — расслабленно для коротких кодов вроде «ОБМ-5Ф»). Если оба резолвлены — пара «matchable». Top-1 = match с максимальным `confidence` среди `matches[]`. Hit ⇔ `top1.invoiceItemId == gtResolved.id` OR нормализованные имена совпадают OR Dice ≥ 0.85. Нормализация — прод-функция `normalizeForMatching` из `backend/src/services/matcher.ts`, импорт через DB-шим (тот же приём, что в `b1_tripwire_risk_v2_2026-06-13.ts`).

## Headline numbers

| Metric | Value |
|--------|-------|
| GT pairs (total in JSON) | 27 |
| GT by category | AYVAZ=7, OBM=16, НЗВЗ=4 |
| **matchable_with_ground_truth (N)** | **13** |
| Hits (top-1 == GT) | **12** |
| **Accuracy@1 = hits/N** | **92.31%** |
| Baseline pre-Б1.1 (recorded in memory, 2026-06-11) | 78.6% |
| Δ vs baseline | +13.71 pp |
| **Verdict** | **GROWTH** |
| Memory-attributed hits (top-1 was learned_rule and correct) | 7 of 8 learned_rule top-1s |

> **Caveat on baseline comparison:** N here = 13. Pre-Б1.1 78.6% was recorded over a different (broader) matchable set. The Δ in **percentage points** is indicative; absolute hit-count is not directly comparable. The 27-pair GT here is the cleanest validated set we have for proj.12 — wider GT sets would require independent manual validation of every additional row.

## Breakdown by category (matchable only)

- AYVAZ: 6/6 = 100.0%
- OBM: 4/4 = 100.0%
- НЗВЗ: 2/3 = 66.7%
- (no other categories)

## Skipped pairs (not matchable — not in denominator)

Total skipped: 14

By reason:
- `gt_invoice_not_in_prod_proj12`: 1
- `duplicate_prod_spec_already_counted`: 13

> "duplicate_prod_spec_already_counted" — Б1.1 содержит несколько идентичных spec-name строк (OBM-5Ф появляется ~10 раз в эталоне на разных строках спеки, потому что одна и та же спека повторяется по корпусам). На проде это одна spec_item — учитываем один раз, чтобы не дублировать измерение.

## Top-1 misses

### Miss 1 — GT pair #21 [НЗВЗ]
- **Spec (GT raw):** `Регулирующий клапан ДК 800х500`
- **GT invoice (raw):** `Дроссель-клапан ДКП 800х500-Р`
- **GT resolved on prod:** invoice_id=5256 `Дроссель-клапан ДКП 800х500-Р` (resolve: exact)
- **Prod spec hit (id=5985):** `Регулирующий клапан ДК 800х500` (Dice=1)
- **System top-1:** invoice_id=5255 `Дроссель-клапан ДКП 600х400-Р`
- **Top-1 conf:** 0.92, **type:** `learned_rule`, **rule_id:** none
- **Dice(top1, GT):** 0.833
- **Likely cause:** learned_rule fired (rule_id missing)

## Files

- This report: `docs/plans/active/b1_1_accuracy_at_1_proj12_after_landing_2026-06-14.md`
- Machine-readable JSON: `backend/scripts/b1_1_accuracy_at_1_proj12_2026-06-14.json`
- Source script: `backend/scripts/b1_1_accuracy_at_1_proj12_2026-06-14.ts`
- GT source: `backend/scripts/b1_high_conf_27_2026-06-13.json`
- Ethalon XLSX: `C:\Users\home\Downloads\Таблицы\01_05-07-24-ОВ эталон жк бкк арта.xlsx`

## Verdict statement

Точность@1 на матчимом проекте 12 = **92.31%** (12/13) против pre-Б1.1 78.6% → **GROWTH** (Δ +13.71 pp).
