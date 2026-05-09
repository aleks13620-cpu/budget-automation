# Field-level baseline — 2026-05-07

Scope: field-level quality baseline over existing benchmark/OCR JSON only.

- Input benchmark: `scripts/benchmark-ready/train/`, `scripts/benchmark-ready/holdout/`
- Input OCR results: `scripts/ocr-benchmark/results/gemini_results.json`
- Source contract: `docs/benchmark-reports/field-quality-contract-2026-05-07.md`
- Legacy aggregated baseline (kept as-is): `docs/benchmark-reports/baseline-2026-05-04.md`
- Script: `scripts/ocr-benchmark/04_field_quality_report.py`

This baseline does not change parser code, production API, routes, UI, frontend, database schema, or external OCR/LLM calls.

## How baseline was generated

Commands:

- `python scripts/ocr-benchmark/04_field_quality_report.py --set train --output scripts/ocr-benchmark/results/field_quality_report_train.md`
- `python scripts/ocr-benchmark/04_field_quality_report.py --set holdout --output scripts/ocr-benchmark/results/field_quality_report_holdout.md`

Detailed raw report artifacts are stored in:

- `scripts/ocr-benchmark/results/field_quality_report_train.md`
- `scripts/ocr-benchmark/results/field_quality_report_holdout.md`

## Train baseline

Run summary:

- Documents: `8`
- Exact Gemini document matches: `8/8`
- Top financial risks: `16`
- Likely row-matching issues: `3`

Field status snapshot:

| Field | OK | FAIL | MISSING_REF | MISSING_RESULT | NOT_APPLICABLE |
|---|---:|---:|---:|---:|---:|
| row_count | 8 | 0 | 0 | 0 | 0 |
| row_presence | 105 | 0 | 0 | 0 | 0 |
| quantity_number | 99 | 1 | 1 | 0 | 4 |
| unit | 99 | 1 | 1 | 0 | 4 |
| result_line_amount_invariant | 92 | 13 | 0 | 0 | 0 |
| line_amount | 0 | 0 | 105 | 0 | 0 |
| document_total | 0 | 0 | 0 | 0 | 8 |
| vat_rate | 0 | 0 | 0 | 0 | 8 |
| vat_amount | 0 | 0 | 0 | 0 | 8 |

Main risk concentration:

- `Электротехмонтаж`: row-matching issues (`3`) + split/merge candidate rows + low-confidence positional match.
- `ООО "Дюкс"`: explicit `FAIL` on quantity/unit and result amount invariant for one row.
- `ООО "ИТЕСА"`: multiple result amount invariant `FAIL` rows (result arithmetic consistency risk signal).

## Holdout baseline

Run summary:

- Documents: `4`
- Exact Gemini document matches: `4/4`
- Top financial risks: `0`
- Likely row-matching issues: `0`

Field status snapshot:

| Field | OK | FAIL | MISSING_REF | MISSING_RESULT | NOT_APPLICABLE |
|---|---:|---:|---:|---:|---:|
| row_count | 4 | 0 | 0 | 0 | 0 |
| row_presence | 32 | 0 | 0 | 0 | 0 |
| quantity_number | 32 | 0 | 0 | 0 | 0 |
| unit | 32 | 0 | 0 | 0 | 0 |
| result_line_amount_invariant | 32 | 0 | 0 | 0 | 0 |
| line_amount | 0 | 0 | 32 | 0 | 0 |
| document_total | 0 | 0 | 0 | 0 | 4 |
| vat_rate | 0 | 0 | 0 | 0 | 4 |
| vat_amount | 0 | 0 | 0 | 0 | 4 |

Holdout conclusion:

- Under current comparable fields, holdout has no field-level financial `FAIL`/`MISSING_RESULT` risk flags.
- Remaining limitations are benchmark contract limitations (`line_amount`, `document_total`, `vat_*`).

## Known problem documents

### Электротехмонтаж (train)

- Status: **OCR risk + row-matching reliability risk**
- Evidence:
  - Low-confidence positional match and split/merge candidates in row matching block.
  - Benchmark integrity warning: `position_count=33` vs `items.length=34`.
  - `line_amount` remains `MISSING_REF` (benchmark gap, not OCR failure).
- Next action:
  - First fix/confirm row matching for problematic rows.
  - Then reassess quantity/unit/amount conclusions for affected rows.

### САНТЕХПРОМ (holdout)

- Status: **observation risk, no current OCR fail in comparable fields**
- Evidence:
  - No row-matching issues in holdout run.
  - `line_amount` is `MISSING_REF` for all rows because explicit reference line sums are absent in benchmark.
- Next action:
  - Extend benchmark with explicit row line amounts to convert this from reference-gap status into a comparable field.

### Category C / scanned PDFs (legacy-only group)

- Status: **reference boundary risk**
- Evidence:
  - Category C files are listed in legacy baseline but are outside current train/holdout JSON boundary for this run.
- Next action:
  - Keep a separate scoped category-C run and do not mix it with regular train/holdout averages.

## Benchmark gaps

Fields that are currently not valid hard gates due to reference/contract incompleteness:

| Metric | Current status | Why |
|---|---|---|
| line_amount | MISSING_REF | Benchmark items do not store explicit line totals. |
| document_total | NOT_APPLICABLE | `total_sum` is audit metadata, not verified document-total reference. |
| vat_rate | NOT_APPLICABLE | No explicit VAT rate in benchmark/result JSON. |
| vat_amount | NOT_APPLICABLE | No explicit VAT amount in benchmark/result JSON. |
| unit_price_with_vat | NOT_APPLICABLE when both values exist | Result price has no explicit VAT-included semantics. |

Documents with probable benchmark/reference-side issues:

- `Электротехмонтаж` (`position_count` metadata mismatch against `items.length`)
- All train/holdout documents for `line_amount` (missing explicit reference line totals by schema)
- All train/holdout documents for `document_total`/`vat_rate`/`vat_amount` (missing explicit comparable reference fields)

## Relation to legacy baseline

- `docs/benchmark-reports/baseline-2026-05-04.md` remains the **legacy aggregated baseline** (overall/name/price aggregate signals).
- This file is the **new field-level baseline** with train/holdout split and explicit status classes (`OK`, `FAIL`, `MISSING_REF`, `MISSING_RESULT`, `NOT_APPLICABLE`).
- Legacy signals remain useful for continuity, but field-level financial triage should use this baseline first.

## Soft rule for next OCR/PDF changes

Until benchmark gaps are closed, use this sequence for any OCR/PDF/parsing adjustment:

1. Validate targeted field first (the one being fixed).
2. Re-run field-level report on both `train` and `holdout`.
3. Confirm other financial fields did not regress (especially quantity/unit/result amount invariant and row matching stability).
4. Treat `MISSING_REF`/`NOT_APPLICABLE` as benchmark debt, not as OCR success.
