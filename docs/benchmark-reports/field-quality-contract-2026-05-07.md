# Field Quality Contract — 2026-05-07

Scope: Phase 1 only, data contract and metric contract. This document uses existing JSON files only:

- `scripts/benchmark-ready/train/`
- `scripts/benchmark-ready/holdout/`
- `scripts/ocr-benchmark/results/gemini_results.json`

No parser code, API, UI, database schema, routes, frontend, scripts, production data, and external OCR/LLM calls are part of this phase.

## Source Files Checked

| Dataset | Files / docs | Root fields | Item fields |
|---|---:|---|---|
| Benchmark train | 8 files | `audit_file`, `source_invoice`, `supplier`, `position_count`, `total_sum`, `name_status`, `price_status`, `qty_status`, `comment`, `warnings`, `items` | `item_index`, `name`, `article`, `price_with_vat`, `quantity` |
| Benchmark holdout | 4 files | `audit_file`, `source_invoice`, `supplier`, `position_count`, `total_sum`, `name_status`, `price_status`, `qty_status`, `comment`, `warnings`, `items` | `item_index`, `name`, `article`, `price_with_vat`, `quantity` |
| Gemini results | 12 docs | `filename`, `source_path`, `items`, `pages_processed`, `sheets_processed`, `tokens_used`, `error` | `name`, `article`, `unit`, `quantity`, `price`, `amount` |

Benchmark document identity is `source_invoice`. Gemini document identity is the top-level key and `filename`. A document is comparable when `source_invoice` equals the Gemini key after exact Unicode string comparison. Benchmark `position_count` and `total_sum` are audit metadata; benchmark `items.length` is the row-count source of truth for field-quality metrics. Current `total_sum` values are not a verified document-total reference.

## Benchmark Coverage

| Split | Supplier | Source invoice | Reference items | Total metadata |
|---|---|---|---:|---:|
| train | Итеса | `Итеса К флекс Счет на оплату № 4195 от 27.06.2025.pdf` | 18 | 6738,75 |
| train | Общество с ограниченной ответственностью "Евроопт" | `Руфлекс.xls` | 9 | 1045,5 |
| train | ООО "Дюкс" | `Счетчики Эконом Счет на оплату (фирм.бланк) № 2500004860 от 27.08.2025 (2).pdf` | 3 | 27096,0 |
| train | ООО "ИТЕСА" | `Сшитый итеса Счет на оплату № 4305 от 02.07.2025.pdf` | 11 | 1426,39 |
| train | ООО ПК "СТМ" | `ПЭ СТМ Счет на оплату № 154 от 30 мая 2025 г.pdf` | 14 | 15766,36 |
| train | ООО "ПОЖАРКА 63" | `Пожар Счет № 214 от 17.12.25.pdf` | 7 | 11385,0 |
| train | РОВЕН-Самара | `Ровен Счёт_5244.pdf` | 9 | 18091,3 |
| train | Электротехмонтаж | `403_2026315_202511271152_5492386_PRINTER2.TXT (1).pdf` | 34 | 867590,77 |
| holdout | Веза-Самара | `КП 1201038 АТК (3) (1).xls` | 5 | 207748,83 |
| holdout | ООО "ВОДОМЕР" | `+Водомер.xlsx` | 2 | 76720,0 |
| holdout | ООО "ЭЛИТА-Центр" | `Элита КНС дренажник КП 3 360_28_01_2025 (1).pdf` | 2 | 963030,61 |
| holdout | САНТЕХПРОМ | `Коммерческое предложение № 91 от 03 февраля 2026 г.pdf` | 23 | 201306,69 |

The `Total metadata` column is recorded for traceability only. It is not used as a document-total metric until a separate benchmark verification confirms the value semantics.

## Status Contract

| Status | Rule |
|---|---|
| `OK` | Reference value exists, result value exists, normalized values satisfy the field rule. |
| `FAIL` | Reference value exists, result value exists, normalized values violate the field rule. |
| `MISSING_REF` | Result value exists, reference value required for the metric is absent from benchmark JSON. |
| `MISSING_RESULT` | Reference value exists, result value required for the metric is absent from Gemini JSON. |
| `NOT_APPLICABLE` | The metric has no honest basis for the current row/document because the business case is outside the comparable shape defined below. |

Statuses are assigned per field before aggregate scoring. `MISSING_REF`, `MISSING_RESULT`, and `NOT_APPLICABLE` are not converted to `OK`.

## Normalization Contract

| Value type | Rule |
|---|---|
| Text | Apply Unicode NFKC, trim leading/trailing whitespace, collapse internal whitespace to one ASCII space, lower-case. Keep digits, punctuation, Cyrillic letters, Latin letters. |
| Article | Apply text normalization, remove spaces, keep hyphen, slash, dot, digits, Cyrillic letters, Latin letters. Empty string is absent. |
| Money | Null, empty string, and whitespace-only string are absent. For present values, remove spaces and currency signs, replace comma with dot, parse as decimal. Round comparison operands to 2 decimal places using half-up rounding. |
| Quantity number | Benchmark schema v1: from string `quantity`, read the leading signed decimal token, accepting comma and dot as decimal separators. Benchmark schema v2: when item field `unit` exists, parse numeric `quantity` directly. Gemini: parse decimal `quantity` directly. Do not infer missing decimal separators. |
| Unit | Benchmark schema v1: from string `quantity`, read the suffix after the leading quantity number. Benchmark schema v2: when item field `unit` exists, read `unit` directly. Gemini: read `unit` directly. Canonical units: `м`/`m`/`sm` -> `м`; `шт`/`шт.`/`штука`/`pcs`/`pc`/`st` -> `шт`; result-side `t` -> `шт` only when the paired benchmark unit is `шт`; `уп`/`упак`/`упаковка` -> `уп`; `кор`/`коробка` -> `кор`; `компл`/`комплект`/`к-т` -> `компл`. Empty string is absent. |

## Row Matching Contract

| Step | Rule |
|---|---|
| Document pairing | Match benchmark document to Gemini document by exact `source_invoice` = `filename`. Missing document on the result side gives `MISSING_RESULT` for all result-dependent fields. |
| Row count | Compare benchmark `items.length` to Gemini `items.length`. Equal count is `OK`. Different count is `FAIL`. If benchmark `position_count` differs from benchmark `items.length`, print a benchmark integrity warning and do not use `position_count` for OCR status. |
| Primary row key | Use normalized `article` only when the article is non-empty and unique on both sides within the same document. |
| Positional row key | Use benchmark array order and zero-based Gemini item order when the primary row key is absent, empty, duplicated, or not unique. If benchmark `item_index` differs from array index, print a benchmark integrity warning and use array order for OCR status. |
| Reverse split/merge row key | Build candidate clusters from 2 adjacent benchmark rows only. A cluster maps to one Gemini row when `article` from at least one benchmark row equals Gemini `article` after normalization and normalized name similarity between concatenated benchmark names and Gemini name is at least 0.80. For the cluster, mark row-level financial fields as `NOT_APPLICABLE`, count the document in row-matching risk, and print the clustered row indexes. |
| Extra result row | A Gemini row with no benchmark row is `MISSING_REF` for row-level fields. |
| Missing result row | A benchmark row with no Gemini row is `MISSING_RESULT` for row-level fields. |
| Low-confidence row match | If the row was paired positionally and normalized name similarity is below 0.75, every field conclusion for that row is marked low-confidence in the report. The field status remains visible, but it cannot be used as a standalone parser verdict. |

Name similarity is normalized Levenshtein similarity:

`1 - (levenshtein_distance(normalized_ref_name, normalized_result_name) / max(length(ref), length(result)))`

## Field Comparison Contract

| Field | Reference source | Result source | Availability now | Comparison rule |
|---|---|---|---|---|
| Row count | `items.length` | `items.length` | Comparable | `OK` when counts are equal. `FAIL` when counts differ. `position_count` mismatch against benchmark `items.length` is a benchmark integrity warning, not an OCR row-count failure. |
| Row presence | benchmark array row | paired Gemini item | Comparable | `OK` when paired row exists. `MISSING_RESULT` when reference row has no paired result row. `MISSING_REF` when result row has no paired reference row. |
| Name | `items[].name` | `items[].name` | Comparable | `OK` when normalized Levenshtein similarity is at least 0.80. `FAIL` when it is below 0.80. |
| Article | `items[].article` | `items[].article` | Comparable when reference article is non-empty | `OK` when normalized articles are equal. `FAIL` when both are present and differ. `MISSING_REF` when the reference article is empty and the result article is present. `MISSING_RESULT` when reference article is present and result article is empty. |
| Unit price with VAT | `items[].price_with_vat` | `items[].price` plus explicit VAT semantics | Not financially comparable in current JSON | `MISSING_REF` when reference price is absent. `MISSING_RESULT` when result price is absent. `NOT_APPLICABLE` for current JSON because Gemini does not expose whether `price` includes VAT. Future results compare directly only when result metadata states VAT is included. Future net-price results compare after gross conversion only when result metadata exposes VAT rate. |
| Quantity number | parsed benchmark quantity: v1 numeric prefix from `items[].quantity`, v2 numeric `items[].quantity` | `items[].quantity` | Comparable when parsed benchmark quantity exists | `OK` when absolute decimal delta is less than or equal to 0.001. `FAIL` when absolute decimal delta is greater than 0.001. `MISSING_REF` when parsed benchmark quantity is absent. `MISSING_RESULT` when Gemini quantity is absent. |
| Unit | parsed benchmark unit: v1 suffix from `items[].quantity`, v2 `items[].unit` | `items[].unit` | Comparable when parsed benchmark unit exists | `OK` when canonical units are equal. `FAIL` when both are present and canonical units differ. `MISSING_REF` when parsed benchmark unit is absent and result unit exists. `MISSING_RESULT` when parsed benchmark unit exists and result unit is absent. |
| VAT rate | no explicit field | no explicit field | Not comparable now | `NOT_APPLICABLE` for current JSON because neither side exposes explicit VAT rate. Future explicit reference VAT with absent result VAT is `MISSING_RESULT`. Future explicit result VAT with absent reference VAT is `MISSING_REF`. |
| VAT amount | no explicit field | no explicit field | Not comparable now | `NOT_APPLICABLE` for current JSON because neither side exposes explicit VAT amount. Future explicit reference VAT amount with absent result VAT amount is `MISSING_RESULT`. Future explicit result VAT amount with absent reference VAT amount is `MISSING_REF`. |
| Line amount | no explicit benchmark field | `items[].amount` | Reference missing now | `MISSING_REF` for current JSON. Do not score line amount from computed `price_with_vat * quantity`; the benchmark does not store explicit line sums. Gemini `amount` is printable only with the result amount invariant status defined below. |
| Document total | no verified document-total field | no explicit document total field | Not comparable now | `NOT_APPLICABLE` for current JSON. Benchmark `total_sum` is audit metadata with unverified semantics and must not be scored as document total. Future explicit result total with current benchmark data is `MISSING_REF`. Sum of Gemini `items[].amount` may be printed only as an unscored diagnostic and only from rows whose result amount invariant is `OK`. If any row invariant is `FAIL`, label the diagnostic sum as incomplete/untrusted. |

Legacy aggregate metrics can still show the old name score and old price score for continuity. Field-level financial decisions use this contract, not the legacy aggregate threshold.

## Benchmark Schema Contract

Two benchmark item shapes are accepted:

| Schema | Quantity source | Unit source | Status |
|---|---|---|---|
| v1 current checked files | `quantity` string such as `66 шт.` | suffix parsed from `quantity` string | Active for `train` and `holdout` checked on 2026-05-07. |
| v2 proposed exports/tasks | numeric `quantity` | separate `unit` field | Accepted by the contract when such files are introduced. |

The report must detect the schema per item. Mixed v1/v2 files are allowed only as a transition state and must print a benchmark integrity warning.

## Result Integrity Invariants

These invariants validate the result JSON before it is used for diagnostics. They are not benchmark-vs-result metrics.

| Invariant | Source | Rule |
|---|---|---|
| Result line amount | Gemini `items[].quantity`, `items[].price`, `items[].amount` | `OK` when all three values are present and `abs(round(quantity * price, 2) - round(amount, 2)) <= 0.01`. `FAIL` when all three values are present and the delta is greater than 0.01. `MISSING_RESULT` when any of the three values is absent. |

## Legacy Compatibility Signals

The existing legacy scorer remains a compatibility signal with its current semantics: fuzzy document match, `SequenceMatcher` name score, 5% price tolerance, and aggregate overall score. A field-level report must not replace those semantics inside `scripts/ocr-benchmark/03_score_results.py` because `scripts/quality-monitor.py` imports that scorer directly.

Legacy price score is printed in a separate `legacy signal` column/block. It is not a field-level financial gate. Known problem documents still use legacy price score to preserve current symptoms: `Электротехмонтаж` legacy price `0%` and `САНТЕХПРОМ` legacy price `83%`.

## Financial Priority

Financial fields have higher business priority than name score. A document with high name score and failed price, quantity, unit, VAT, line amount, or document total remains a financial-risk document.

Comparable financial risk ordering for report output:

1. Unit price with VAT
2. Quantity number
3. Unit
4. Row count and row matching
5. Name

Benchmark gap ordering for report output:

1. Document total
2. Line amount
3. VAT rate
4. VAT amount

Name score explains matching quality. Name score does not override a financial `FAIL`, `MISSING_RESULT`, or `MISSING_REF`.

## Known Problem Documents

| Group | Dataset status | Required report treatment |
|---|---|---|
| `Электротехмонтаж` | In train benchmark. Legacy baseline shows `34/41` items, `94%` name, `0%` price. Worst name examples include split package text around `1000 шт/уп`. | Always show in a separate known-problem block. Highlight row-count mismatch, price failure, low-confidence row matching risk, and package text split risk. |
| `САНТЕХПРОМ` | In holdout benchmark. Legacy baseline shows `23/23` items, `100%` name, `83%` price. | Always show in a separate known-problem block. Highlight financial risk despite perfect name score. |
| Category C / scanned PDFs | Required by the plan as a known-problem group. Known files from legacy baseline: `Арктика Предложение 873786 от 01.11.2025 (1).`, `ПК Курс doc02851820251216123708 (1).pdf`, `ПК Курс doc02851820251216123708 (1)1.pdf`. The current Phase 1 input boundary does not include `category_c_list.json`; only `train`, `holdout`, and `gemini_results.json` are allowed. | Always show these files in a separate scan/category group with source marked `legacy baseline list, not recalculated under current JSON boundary`. Do not read `category_c_list.json` unless the task boundary explicitly adds it. Do not mix scanned/problem files into a single average with ordinary PDF/XLS/XLSX benchmark documents. |

## Row-Matching Risk

Wrong row matching corrupts all row-level conclusions for name, article, price, quantity, unit, VAT, and line amount. The report must flag a row as low-confidence when positional matching is used and name similarity is below 0.75.

For low-confidence matched rows:

- show the field statuses;
- mark the row as low-confidence;
- exclude the row from automatic parser-fix conclusions;
- count the document in a row-matching risk block.

## Domain Exceptions

| Case | Contract rule |
|---|---|
| Package text in name | Text such as `1000 шт/уп` inside `name` is a package qualifier. It is not parsed as row quantity and not parsed as row unit. |
| Packages as units | A row quantity unit of `уп` is comparable only to result unit `уп` after unit normalization. No conversion from package to pieces is performed. |
| Kits and комплект rows | Unit `компл` is comparable as a unit. Component-level decomposition is not inferred. |
| Aggregated rows | When one benchmark row maps to multiple result rows, row-level financial fields are `NOT_APPLICABLE` until an explicit row mapping exists. Document total remains reportable only through the document-total rule. |
| Split reference rows | When 2 adjacent benchmark rows satisfy the reverse split/merge row-key rule against one result row, row-level financial fields are `NOT_APPLICABLE` for that cluster until the benchmark is corrected or an explicit cluster mapping exists. The row cluster is reported as a benchmark/row-matching risk, not as a standalone OCR price failure. |
| Rows with amount and no unit price | Unit price comparison is `NOT_APPLICABLE` when the business row has a sum but no unit price. Line amount remains comparable only when an explicit benchmark line amount exists. |
| Result amount without reference amount | Current Gemini `items[].amount` against current benchmark items is `MISSING_REF`, not `OK` and not `FAIL`. |

## Phase 1 Closure

Phase 1 is closed by this contract because it records:

- benchmark train/holdout fields;
- Gemini result fields;
- deterministic comparison rules for rows, names, prices, quantities, units, VAT, line amount, and document total;
- `MISSING_REF`, `MISSING_RESULT`, `NOT_APPLICABLE`, `FAIL`, and `OK` status meanings;
- financial priority over name score;
- required known-problem blocks;
- row-matching risk handling;
- domain exceptions.

This file is not a baseline report and does not close Step 7. It is the contract for later report implementation.
