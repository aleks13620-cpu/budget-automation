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

Benchmark document identity is `source_invoice`. Gemini document identity is the top-level key and `filename`. A document is comparable when `source_invoice` equals the Gemini key after exact Unicode string comparison.

## Benchmark Coverage

| Split | Supplier | Source invoice | Reference items | Reference total |
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
| Money | Remove spaces and currency signs, replace comma with dot, parse as decimal. Round comparison operands to 2 decimal places using half-up rounding. |
| Quantity number | From benchmark `quantity`, read the leading signed decimal token, accepting comma and dot as decimal separators. From Gemini `quantity`, parse decimal directly. Do not infer missing decimal separators. |
| Unit | From benchmark `quantity`, read the suffix after the leading quantity number. From Gemini `unit`, read the field directly. Canonical units: `м`/`m` -> `м`; `шт`/`штука`/`pcs`/`pc` -> `шт`; `уп`/`упак`/`упаковка` -> `уп`; `компл`/`комплект`/`к-т` -> `компл`. Empty string is absent. |

## Row Matching Contract

| Step | Rule |
|---|---|
| Document pairing | Match benchmark document to Gemini document by exact `source_invoice` = `filename`. Missing document on the result side gives `MISSING_RESULT` for all result-dependent fields. |
| Row count | Compare `position_count` and `items.length` from benchmark to `items.length` from Gemini. Equal count is `OK`. Different count is `FAIL`. |
| Primary row key | Use normalized `article` only when the article is non-empty and unique on both sides within the same document. |
| Positional row key | Use benchmark `item_index` and zero-based Gemini item order when the primary row key is absent, empty, duplicated, or not unique. |
| Extra result row | A Gemini row with no benchmark row is `MISSING_REF` for row-level fields. |
| Missing result row | A benchmark row with no Gemini row is `MISSING_RESULT` for row-level fields. |
| Low-confidence row match | If the row was paired positionally and normalized name similarity is below 0.75, every field conclusion for that row is marked low-confidence in the report. The field status remains visible, but it cannot be used as a standalone parser verdict. |

Name similarity is normalized Levenshtein similarity:

`1 - (levenshtein_distance(normalized_ref_name, normalized_result_name) / max(length(ref), length(result)))`

## Field Comparison Contract

| Field | Reference source | Result source | Availability now | Comparison rule |
|---|---|---|---|---|
| Row count | `position_count`, `items.length` | `items.length` | Comparable | `OK` when counts are equal. `FAIL` when counts differ. |
| Row presence | `items[item_index]` | paired Gemini item | Comparable | `OK` when paired row exists. `MISSING_RESULT` when reference row has no paired result row. `MISSING_REF` when result row has no paired reference row. |
| Name | `items[].name` | `items[].name` | Comparable | `OK` when normalized Levenshtein similarity is at least 0.80. `FAIL` when it is below 0.80. |
| Article | `items[].article` | `items[].article` | Comparable when reference article is non-empty | `OK` when normalized articles are equal. `FAIL` when both are present and differ. `MISSING_REF` when the reference article is empty and the result article is present. `MISSING_RESULT` when reference article is present and result article is empty. |
| Unit price with VAT | `items[].price_with_vat` | `items[].price` | Comparable as gross unit price | `OK` when absolute money delta is less than or equal to 0.01. `FAIL` when absolute money delta is greater than 0.01. |
| Quantity number | numeric part of `items[].quantity` | `items[].quantity` | Comparable when benchmark quantity starts with a decimal token | `OK` when absolute decimal delta is less than or equal to 0.001. `FAIL` when absolute decimal delta is greater than 0.001. `MISSING_REF` when benchmark quantity has no numeric token. `MISSING_RESULT` when Gemini quantity is absent. |
| Unit | suffix of `items[].quantity` | `items[].unit` | Comparable when benchmark quantity has a unit suffix | `OK` when canonical units are equal. `FAIL` when both are present and canonical units differ. `MISSING_REF` when benchmark has no unit suffix and result unit exists. `MISSING_RESULT` when benchmark unit exists and result unit is absent. |
| VAT rate | no explicit field | no explicit field | Not comparable now | `NOT_APPLICABLE` for current JSON because neither side exposes explicit VAT rate. Future explicit reference VAT with absent result VAT is `MISSING_RESULT`. Future explicit result VAT with absent reference VAT is `MISSING_REF`. |
| VAT amount | no explicit field | no explicit field | Not comparable now | `NOT_APPLICABLE` for current JSON because neither side exposes explicit VAT amount. Future explicit reference VAT amount with absent result VAT amount is `MISSING_RESULT`. Future explicit result VAT amount with absent reference VAT amount is `MISSING_REF`. |
| Line amount | no explicit benchmark field | `items[].amount` | Reference missing now | `MISSING_REF` for current JSON. Do not score line amount from computed `price_with_vat * quantity`; the benchmark does not store explicit line sums. |
| Document total | `total_sum` | no explicit document total field | Result missing now | `MISSING_RESULT` for current Gemini JSON. Sum of Gemini `items[].amount` may be printed as a diagnostic, but it does not replace an explicit document total field. |

Legacy aggregate metrics can still show the old name score and old price score for continuity. Field-level financial decisions use this contract, not the legacy aggregate threshold.

## Financial Priority

Financial fields have higher business priority than name score. A document with high name score and failed price, quantity, unit, VAT, line amount, or document total remains a financial-risk document.

Risk ordering for report output:

1. Document total
2. Line amount
3. Unit price with VAT
4. Quantity number
5. Unit
6. VAT
7. Row count and row matching
8. Name

Name score explains matching quality. Name score does not override a financial `FAIL`, `MISSING_RESULT`, or `MISSING_REF`.

## Known Problem Documents

| Group | Dataset status | Required report treatment |
|---|---|---|
| `Электротехмонтаж` | In train benchmark. Legacy baseline shows `34/41` items, `94%` name, `0%` price. Worst name examples include split package text around `1000 шт/уп`. | Always show in a separate known-problem block. Highlight row-count mismatch, price failure, low-confidence row matching risk, and package text split risk. |
| `САНТЕХПРОМ` | In holdout benchmark. Legacy baseline shows `23/23` items, `100%` name, `83%` price. | Always show in a separate known-problem block. Highlight financial risk despite perfect name score. |
| Category C / scanned PDFs | Legacy baseline lists scanned/problem files with empty Gemini items: `Арктика Предложение 873786 от 01.11.2025 (1).`, `ПК Курс doc02851820251216123708 (1).pdf`, `ПК Курс doc02851820251216123708 (1)1.pdf`. | Always show as a separate scan/category group. Do not mix these files into a single average with ordinary PDF/XLS/XLSX benchmark documents. |

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
