# Field-Level OCR Benchmark Report

Generated from existing JSON only. No external OCR/LLM/API calls are made by this report script.

## Source Boundary

- Benchmark train: `scripts/benchmark-ready/train/`
- Benchmark holdout: `scripts/benchmark-ready/holdout/`
- OCR results: `scripts/ocr-benchmark/results/gemini_results.json`
- Output: `scripts/ocr-benchmark/results/field_quality_report.md`
- Parser, production API, routes, UI, frontend, and database files are not read for metrics and not changed.
- Category C legacy files are not recalculated in Phase 2 because they are outside the current JSON boundary.

## Run Summary

- Selected set: `all`
- Benchmark documents: 12
- Exact Gemini document matches: 12/12
- Legacy metrics are shown as compatibility signals only; their scoring semantics are unchanged.
- `document_total`, `vat_rate`, and `vat_amount` are `NOT_APPLICABLE` under the current contract.
- Benchmark-vs-result `line_amount` is `MISSING_REF`; Gemini amount is shown only as a result invariant.

## Legacy Compatibility Signals

| Split | Supplier | Overall | Name | Price | Items ref/result | Field row count | Notes |
|---|---|---:|---:|---:|---:|---|---|
| train | Итеса | 100.0% | 100.0% | 100.0% | 18/18 | OK |  |
| train | Общество с ограниченной отв... | 100.0% | 100.0% | 100.0% | 9/9 | OK |  |
| train | ООО "Дюкс" | 100.0% | 100.0% | 100.0% | 3/3 | OK |  |
| train | ООО "ИТЕСА" | 100.0% | 100.0% | 100.0% | 11/11 | OK |  |
| train | ООО ПК "СТМ" | 100.0% | 100.0% | 100.0% | 14/14 | OK |  |
| train | ООО "ПОЖАРКА 63" | 100.0% | 100.0% | 100.0% | 7/7 | OK |  |
| train | РОВЕН-Самара | 100.0% | 100.0% | 100.0% | 9/9 | OK |  |
| train | Электротехмонтаж | 94.4% | 94.1% | 91.2% | 34/34 | OK | benchmark position_count=33 differs from items.length=34; using items.length |
| holdout | Веза-Самара | 100.0% | 100.0% | 100.0% | 5/5 | OK |  |
| holdout | ООО "ВОДОМЕР" | 100.0% | 100.0% | 100.0% | 2/2 | OK |  |
| holdout | ООО "ЭЛИТА-Центр" | 100.0% | 100.0% | 100.0% | 2/2 | OK |  |
| holdout | САНТЕХПРОМ | 100.0% | 100.0% | 100.0% | 23/23 | OK |  |

## Field Status Summary By Split

### train

| Field | OK | FAIL | MISSING_REF | MISSING_RESULT | NOT_APPLICABLE |
|---|---:|---:|---:|---:|---:|
| row_count | 8 | 0 | 0 | 0 | 0 |
| document_total | 0 | 0 | 0 | 0 | 8 |
| vat_rate | 0 | 0 | 0 | 0 | 8 |
| vat_amount | 0 | 0 | 0 | 0 | 8 |
| row_presence | 105 | 0 | 0 | 0 | 0 |
| name | 102 | 3 | 0 | 0 | 0 |
| article | 48 | 17 | 40 | 0 | 0 |
| unit_price_with_vat | 0 | 0 | 1 | 0 | 104 |
| quantity_number | 99 | 1 | 1 | 0 | 4 |
| unit | 99 | 1 | 1 | 0 | 4 |
| line_amount | 0 | 0 | 105 | 0 | 0 |
| result_line_amount_invariant | 92 | 13 | 0 | 0 | 0 |

### holdout

| Field | OK | FAIL | MISSING_REF | MISSING_RESULT | NOT_APPLICABLE |
|---|---:|---:|---:|---:|---:|
| row_count | 4 | 0 | 0 | 0 | 0 |
| document_total | 0 | 0 | 0 | 0 | 4 |
| vat_rate | 0 | 0 | 0 | 0 | 4 |
| vat_amount | 0 | 0 | 0 | 0 | 4 |
| row_presence | 32 | 0 | 0 | 0 | 0 |
| name | 32 | 0 | 0 | 0 | 0 |
| article | 25 | 0 | 7 | 0 | 0 |
| unit_price_with_vat | 0 | 0 | 0 | 0 | 32 |
| quantity_number | 32 | 0 | 0 | 0 | 0 |
| unit | 32 | 0 | 0 | 0 | 0 |
| line_amount | 0 | 0 | 32 | 0 | 0 |
| result_line_amount_invariant | 32 | 0 | 0 | 0 | 0 |

## Top Financial Risks

| Split | Supplier | Row | Field | Status | Ref | Result | Why |
|---|---|---:|---|---|---:|---:|---|
| train | Электротехмонтаж | doc | row_matching | FAIL | 3 |  | likely row-matching issue present |
| train | ООО "Дюкс" | 2 | quantity_number | FAIL | 1 | 0.33 | field can change budget math or result arithmetic |
| train | ООО "Дюкс" | 2 | unit | FAIL | шт | кор | field can change budget math or result arithmetic |
| train | ООО "Дюкс" | 2 | result_line_amount_invariant | FAIL | 1945.02 | 5894.00 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 0 | result_line_amount_invariant | FAIL | 797281.92 | 797280.58 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 1 | result_line_amount_invariant | FAIL | 235750.00 | 235764.48 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 10 | result_line_amount_invariant | FAIL | 73093.92 | 73092.78 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 2 | result_line_amount_invariant | FAIL | 795834.00 | 795803.91 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 3 | result_line_amount_invariant | FAIL | 312303.00 | 312315.49 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 4 | result_line_amount_invariant | FAIL | 266873.05 | 266870.01 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 5 | result_line_amount_invariant | FAIL | 35340.25 | 35342.19 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 6 | result_line_amount_invariant | FAIL | 15404.83 | 15404.19 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 7 | result_line_amount_invariant | FAIL | 194734.75 | 194734.87 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 8 | result_line_amount_invariant | FAIL | 20290.35 | 20289.99 | field can change budget math or result arithmetic |
| train | ООО "ИТЕСА" | 9 | result_line_amount_invariant | FAIL | 115962.88 | 115960.58 | field can change budget math or result arithmetic |
| train | Общество с ограниченной о... | 8 | result_line_amount_invariant | FAIL | 73990.80 | 73986.89 | field can change budget math or result arithmetic |

## Likely Row-Matching Issue

| Split | Supplier | Ref row | Result row | Method | Similarity | Reason |
|---|---|---:|---:|---|---:|---|
| train | Электротехмонтаж | 33 | 33 | position | 0.183 | positional match name similarity below 0.75 |
| train | Электротехмонтаж | 6,7 | 6 | reverse split/merge | 0.836 | 2 adjacent benchmark rows can map to one result row |
| train | Электротехмонтаж | 31,32 | 31 | reverse split/merge | 0.951 | 2 adjacent benchmark rows can map to one result row |

## Known problem documents

### Электротехмонтаж

- Scope: `train`
- Source: `403_2026315_202511271152_5492386_PRINTER2.TXT (1).pdf`
- Type: **OCR РИСК**
- Evidence: Сопоставление строк: 3 issue(s), выводы по финансовым полям частично низкой надёжности.
- Evidence: Legacy price signal: 91.2% (compatibility signal, не field-level gate).
- Evidence: line_amount: MISSING_REF=34 => РИСК ЭТАЛОНА, это пробел reference данных, не ошибка OCR.
- **Next action:** Сначала исправить/подтвердить row matching для проблемных строк, потом переоценить quantity/unit/amount.

### Category C / scanned PDFs

- Scope: `legacy`
- Source: `legacy baseline list`
- Type: **РИСК ЭТАЛОНА**
- Evidence: Эта группа выводится отдельно и не смешивается со средними по обычным train/holdout PDF/XLS/XLSX.
- Evidence: Текущий JSON boundary не включает category_c_list.json, поэтому пересчёт не выполняется в этом отчёте.
- Evidence: Legacy list: Арктика Предложение 873786 от 01.11.2025 (1)., ПК Курс doc02851820251216123708 (1).pdf, ПК Курс doc02851820251216123708 (1)1...
- **Next action:** Добавить отдельный scoped прогон для category C и сравнивать его метрики отдельно от обычных документов.

### САНТЕХПРОМ

- Scope: `holdout`
- Source: `Коммерческое предложение № 91 от 03 февраля 2026 г.pdf`
- Type: **РИСК ЭТАЛОНА**
- Evidence: Legacy price signal: 100.0% (compatibility signal, не field-level gate).
- Evidence: line_amount: MISSING_REF=23 => РИСК ЭТАЛОНА, это пробел reference данных, не ошибка OCR.
- **Next action:** Дополнить benchmark явным line_amount для строк документа, затем пересчитать field-level риск.

## Benchmark Gaps And Not Applicable Metrics

| Metric | Contract status now | Reason |
|---|---|---|
| line_amount | MISSING_REF | Current benchmark items do not store explicit line amounts; Gemini amount is only a result invariant. |
| document_total | NOT_APPLICABLE | Current `total_sum` is audit metadata, not a verified document-total reference. |
| vat_rate | NOT_APPLICABLE | Current benchmark and Gemini JSON do not expose explicit VAT rate. |
| vat_amount | NOT_APPLICABLE | Current benchmark and Gemini JSON do not expose explicit VAT amount. |
| unit_price_with_vat | NOT_APPLICABLE when both values exist | Gemini `price` does not expose whether VAT is included. Missing operands still show `MISSING_REF` or `MISSING_RESULT`. |

## Per-Document Field Summary

| Split | Supplier | Row count | Quantity | Unit | Line amount | Result amount invariant | Row issues |
|---|---|---|---|---|---|---|---:|
| train | Итеса | OK (18/18) | OK=18 | OK=18 | MISSING_REF=18 | OK=18 | 0 |
| train | Общество с ограниченной отв... | OK (9/9) | OK=9 | OK=9 | MISSING_REF=9 | OK=8, FAIL=1 | 0 |
| train | ООО "Дюкс" | OK (3/3) | OK=2, FAIL=1 | OK=2, FAIL=1 | MISSING_REF=3 | OK=2, FAIL=1 | 0 |
| train | ООО "ИТЕСА" | OK (11/11) | OK=11 | OK=11 | MISSING_REF=11 | FAIL=11 | 0 |
| train | ООО ПК "СТМ" | OK (14/14) | OK=14 | OK=14 | MISSING_REF=14 | OK=14 | 0 |
| train | ООО "ПОЖАРКА 63" | OK (7/7) | OK=7 | OK=7 | MISSING_REF=7 | OK=7 | 0 |
| train | РОВЕН-Самара | OK (9/9) | OK=9 | OK=9 | MISSING_REF=9 | OK=9 | 0 |
| train | Электротехмонтаж | OK (34/34) | OK=29, MISSING_REF=1, NOT_APPLICABLE=4 | OK=29, MISSING_REF=1, NOT_APPLICABLE=4 | MISSING_REF=34 | OK=34 | 3 |
| holdout | Веза-Самара | OK (5/5) | OK=5 | OK=5 | MISSING_REF=5 | OK=5 | 0 |
| holdout | ООО "ВОДОМЕР" | OK (2/2) | OK=2 | OK=2 | MISSING_REF=2 | OK=2 | 0 |
| holdout | ООО "ЭЛИТА-Центр" | OK (2/2) | OK=2 | OK=2 | MISSING_REF=2 | OK=2 | 0 |
| holdout | САНТЕХПРОМ | OK (23/23) | OK=23 | OK=23 | MISSING_REF=23 | OK=23 | 0 |

## Field-Level Row Details

### train: Итеса

- Source invoice: `Итеса К флекс Счет на оплату № 4195 от 27.06.2025.pdf`
- Benchmark file: `scripts/benchmark-ready/train/Итеса_6738_75.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (1.000) | OK | NOT_APPLICABLE (24.75/24.75) | OK (2550/2550) | OK (м/м) | MISSING_REF (/63112.50) | OK (63112.50/63112.50) |  |
| 1 | 1 | position | no | OK (1.000) | OK | NOT_APPLICABLE (27.75/27.75) | OK (5760/5760) | OK (м/м) | MISSING_REF (/159840.00) | OK (159840.00/159840.00) |  |
| 2 | 2 | position | no | OK (1.000) | OK | NOT_APPLICABLE (31.50/31.50) | OK (1440/1440) | OK (м/м) | MISSING_REF (/45360.00) | OK (45360.00/45360.00) |  |
| 3 | 3 | position | no | OK (0.977) | FAIL | NOT_APPLICABLE (24.75/24.75) | OK (2550/2550) | OK (м/м) | MISSING_REF (/63112.50) | OK (63112.50/63112.50) |  |
| 4 | 4 | position | no | OK (1.000) | OK | NOT_APPLICABLE (27.75/27.75) | OK (5760/5760) | OK (м/м) | MISSING_REF (/159840.00) | OK (159840.00/159840.00) |  |
| 5 | 5 | position | no | OK (0.976) | FAIL | NOT_APPLICABLE (31.50/31.50) | OK (1440/1440) | OK (м/м) | MISSING_REF (/45360.00) | OK (45360.00/45360.00) |  |
| 6 | 6 | article | no | OK (0.968) | OK | NOT_APPLICABLE (78.75/78.75) | OK (216/216) | OK (м/м) | MISSING_REF (/17010.00) | OK (17010.00/17010.00) |  |
| 7 | 7 | article | no | OK (0.968) | OK | NOT_APPLICABLE (84.00/84.00) | OK (500/500) | OK (м/м) | MISSING_REF (/42000.00) | OK (42000.00/42000.00) |  |
| 8 | 8 | position | no | OK (1.000) | FAIL | NOT_APPLICABLE (88.50/88.50) | OK (528/528) | OK (м/м) | MISSING_REF (/46728.00) | OK (46728.00/46728.00) |  |
| 9 | 9 | article | no | OK (0.967) | OK | NOT_APPLICABLE (102.00/102.00) | OK (490/490) | OK (м/м) | MISSING_REF (/49980.00) | OK (49980.00/49980.00) |  |
| 10 | 10 | position | no | OK (1.000) | FAIL | NOT_APPLICABLE (109.50/109.50) | OK (180/180) | OK (м/м) | MISSING_REF (/19710.00) | OK (19710.00/19710.00) |  |
| 11 | 11 | position | no | OK (0.981) | OK | NOT_APPLICABLE (621.75/621.75) | OK (3600/3600) | OK (шт/шт) | MISSING_REF (/2238300.00) | OK (2238300.00/2238300.00) |  |
| 12 | 12 | article | no | OK (0.966) | OK | NOT_APPLICABLE (3975.00/3975.00) | OK (4/4) | OK (шт/шт) | MISSING_REF (/15900.00) | OK (15900.00/15900.00) |  |
| 13 | 13 | article | no | OK (0.967) | OK | NOT_APPLICABLE (138.75/138.75) | OK (96/96) | OK (м/м) | MISSING_REF (/13320.00) | OK (13320.00/13320.00) |  |
| 14 | 14 | article | no | OK (0.967) | OK | NOT_APPLICABLE (176.25/176.25) | OK (208/208) | OK (м/м) | MISSING_REF (/36660.00) | OK (36660.00/36660.00) |  |
| 15 | 15 | article | no | OK (0.967) | OK | NOT_APPLICABLE (261.75/261.75) | OK (192/192) | OK (м/м) | MISSING_REF (/50256.00) | OK (50256.00/50256.00) |  |
| 16 | 16 | article | no | OK (0.967) | OK | NOT_APPLICABLE (312.75/312.75) | OK (154/154) | OK (м/м) | MISSING_REF (/48163.50) | OK (48163.50/48163.50) |  |
| 17 | 17 | position | no | OK (0.978) | OK | NOT_APPLICABLE (621.75/621.75) | OK (1200/1200) | OK (шт/шт) | MISSING_REF (/746100.00) | OK (746100.00/746100.00) |  |

### train: Общество с ограниченной ответственностью "Евроопт"

- Source invoice: `Руфлекс.xls`
- Benchmark file: `scripts/benchmark-ready/train/Общество с ограниченной ответственностью Евроопт_1045_50.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (117.80/117.80) | OK (462/462) | OK (м/м) | MISSING_REF (/54423.60) | OK (54423.60/54423.60) |  |
| 1 | 1 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (69.58/69.58) | OK (274/274) | OK (м/м) | MISSING_REF (/19064.92) | OK (19064.92/19064.92) |  |
| 2 | 2 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (109.72/109.72) | OK (208/208) | OK (м/м) | MISSING_REF (/22821.76) | OK (22821.76/22821.76) |  |
| 3 | 3 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (59.42/59.42) | OK (30/30) | OK (м/м) | MISSING_REF (/1782.60) | OK (1782.60/1782.60) |  |
| 4 | 4 | position | no | OK (0.971) | MISSING_REF | NOT_APPLICABLE (72.67/72.67) | OK (12/12) | OK (м/м) | MISSING_REF (/872.04) | OK (872.04/872.04) |  |
| 5 | 5 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (50.32/50.32) | OK (1380/1380) | OK (м/м) | MISSING_REF (/69441.60) | OK (69441.60/69441.60) |  |
| 6 | 6 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (213.09/213.09) | OK (36/36) | OK (м/м) | MISSING_REF (/7671.24) | OK (7671.24/7671.24) |  |
| 7 | 7 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (326.38/326.38) | OK (24/24) | OK (м/м) | MISSING_REF (/7833.12) | OK (7833.12/7833.12) |  |
| 8 | 8 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (26.52/26.52) | OK (2790/2790) | OK (м/м) | MISSING_REF (/73986.89) | FAIL (73990.80/73986.89) |  |

### train: ООО "Дюкс"

- Source invoice: `Счетчики Эконом Счет на оплату (фирм.бланк) № 2500004860 от 27.08.2025 (2).pdf`
- Benchmark file: `scripts/benchmark-ready/train/ООО Дюкс_27096_00.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (0.985) | FAIL | NOT_APPLICABLE (10446.00/10446.00) | OK (1/1) | OK (шт/шт) | MISSING_REF (/10446.00) | OK (10446.00/10446.00) |  |
| 1 | 1 | article | no | OK (1.000) | OK | NOT_APPLICABLE (10756.00/10756.00) | OK (1/1) | OK (шт/шт) | MISSING_REF (/10756.00) | OK (10756.00/10756.00) |  |
| 2 | 2 | article | no | OK (1.000) | OK | NOT_APPLICABLE (5894.00/5894.00) | FAIL (1/0.33) | FAIL (шт/кор) | MISSING_REF (/5894.00) | FAIL (1945.02/5894.00) |  |

### train: ООО "ИТЕСА"

- Source invoice: `Сшитый итеса Счет на оплату № 4305 от 02.07.2025.pdf`
- Benchmark file: `scripts/benchmark-ready/train/ООО ИТЕСА_1426_39.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | article | no | OK (0.979) | OK | NOT_APPLICABLE (429.57/429.57) | OK (1856/1856) | OK (шт/шт) | MISSING_REF (/797280.58) | FAIL (797281.92/797280.58) |  |
| 1 | 1 | article | no | OK (0.931) | OK | NOT_APPLICABLE (47.15/47.15) | OK (5000/5000) | OK (м/м) | MISSING_REF (/235764.48) | FAIL (235750.00/235764.48) |  |
| 2 | 2 | article | no | OK (0.931) | OK | NOT_APPLICABLE (69.81/69.81) | OK (11400/11400) | OK (м/м) | MISSING_REF (/795803.91) | FAIL (795834.00/795803.91) |  |
| 3 | 3 | article | no | OK (0.930) | OK | NOT_APPLICABLE (109.58/109.58) | OK (2850/2850) | OK (м/м) | MISSING_REF (/312315.49) | FAIL (312303.00/312315.49) |  |
| 4 | 4 | article | no | OK (1.000) | OK | NOT_APPLICABLE (40.85/40.85) | OK (6533/6533) | OK (шт/шт) | MISSING_REF (/266870.01) | FAIL (266873.05/266870.01) |  |
| 5 | 5 | article | no | OK (1.000) | OK | NOT_APPLICABLE (45.25/45.25) | OK (781/781) | OK (шт/шт) | MISSING_REF (/35342.19) | FAIL (35340.25/35342.19) |  |
| 6 | 6 | article | no | OK (1.000) | OK | NOT_APPLICABLE (67.27/67.27) | OK (229/229) | OK (шт/шт) | MISSING_REF (/15404.19) | FAIL (15404.83/15404.19) |  |
| 7 | 7 | article | no | OK (1.000) | OK | NOT_APPLICABLE (124.75/124.75) | OK (1561/1561) | OK (шт/шт) | MISSING_REF (/194734.87) | FAIL (194734.75/194734.87) |  |
| 8 | 8 | article | no | OK (1.000) | OK | NOT_APPLICABLE (186.15/186.15) | OK (109/109) | OK (шт/шт) | MISSING_REF (/20289.99) | FAIL (20290.35/20289.99) |  |
| 9 | 9 | article | no | OK (1.000) | OK | NOT_APPLICABLE (148.48/148.48) | OK (781/781) | OK (шт/шт) | MISSING_REF (/115960.58) | FAIL (115962.88/115960.58) |  |
| 10 | 10 | article | no | OK (1.000) | OK | NOT_APPLICABLE (157.53/157.53) | OK (464/464) | OK (шт/шт) | MISSING_REF (/73092.78) | FAIL (73093.92/73092.78) |  |

### train: ООО ПК "СТМ"

- Source invoice: `ПЭ СТМ Счет на оплату № 154 от 30 мая 2025 г.pdf`
- Benchmark file: `scripts/benchmark-ready/train/ООО ПК СТМ_15766_36.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (0.981) | MISSING_REF | NOT_APPLICABLE (390.00/390.00) | OK (5/5) | OK (шт/шт) | MISSING_REF (/1950.00) | OK (1950.00/1950.00) |  |
| 1 | 1 | position | no | OK (0.982) | MISSING_REF | NOT_APPLICABLE (2336.76/2336.76) | OK (7/7) | OK (шт/шт) | MISSING_REF (/16357.32) | OK (16357.32/16357.32) |  |
| 2 | 2 | position | no | OK (0.966) | MISSING_REF | NOT_APPLICABLE (1900.00/1900.00) | OK (2/2) | OK (шт/шт) | MISSING_REF (/3800.00) | OK (3800.00/3800.00) |  |
| 3 | 3 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (918.00/918.00) | OK (21/21) | OK (шт/шт) | MISSING_REF (/19278.00) | OK (19278.00/19278.00) |  |
| 4 | 4 | position | no | OK (0.981) | MISSING_REF | NOT_APPLICABLE (586.60/586.60) | OK (32/32) | OK (шт/шт) | MISSING_REF (/18771.20) | OK (18771.20/18771.20) |  |
| 5 | 5 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (356.40/356.40) | OK (208/208) | OK (м/м) | MISSING_REF (/74131.20) | OK (74131.20/74131.20) |  |
| 6 | 6 | position | no | OK (0.915) | MISSING_REF | NOT_APPLICABLE (898.00/898.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/59268.00) | OK (59268.00/59268.00) |  |
| 7 | 7 | position | no | OK (0.976) | MISSING_REF | NOT_APPLICABLE (909.00/909.00) | OK (6/6) | OK (шт/шт) | MISSING_REF (/5454.00) | OK (5454.00/5454.00) |  |
| 8 | 8 | position | no | OK (0.982) | MISSING_REF | NOT_APPLICABLE (2133.10/2133.10) | OK (16/16) | OK (шт/шт) | MISSING_REF (/34129.60) | OK (34129.60/34129.60) |  |
| 9 | 9 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (1440.00/1440.00) | OK (3/3) | OK (шт/шт) | MISSING_REF (/4320.00) | OK (4320.00/4320.00) |  |
| 10 | 10 | position | no | OK (0.950) | MISSING_REF | NOT_APPLICABLE (2276.10/2276.10) | OK (10/10) | OK (шт/шт) | MISSING_REF (/22761.00) | OK (22761.00/22761.00) |  |
| 11 | 11 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (842.40/842.40) | OK (2/2) | OK (шт/шт) | MISSING_REF (/1684.80) | OK (1684.80/1684.80) |  |
| 12 | 12 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (580.00/580.00) | OK (1/1) | OK (шт/шт) | MISSING_REF (/580.00) | OK (580.00/580.00) |  |
| 13 | 13 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (200.00/200.00) | OK (20/20) | OK (м/м) | MISSING_REF (/4000.00) | OK (4000.00/4000.00) |  |

### train: ООО "ПОЖАРКА 63"

- Source invoice: `Пожар Счет № 214 от 17.12.25.pdf`
- Benchmark file: `scripts/benchmark-ready/train/ООО ПОЖАРКА 63_11385_00.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (870.00/870.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/57420.00) | OK (57420.00/57420.00) |  |
| 1 | 1 | position | no | OK (0.973) | MISSING_REF | NOT_APPLICABLE (6670.00/6670.00) | OK (33/33) | OK (шт/шт) | MISSING_REF (/220110.00) | OK (220110.00/220110.00) |  |
| 2 | 2 | position | no | OK (0.971) | MISSING_REF | NOT_APPLICABLE (650.00/650.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/42900.00) | OK (42900.00/42900.00) |  |
| 3 | 3 | position | no | OK (0.960) | MISSING_REF | NOT_APPLICABLE (2750.00/2750.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/181500.00) | OK (181500.00/181500.00) |  |
| 4 | 4 | position | no | OK (0.952) | MISSING_REF | NOT_APPLICABLE (220.00/220.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/14520.00) | OK (14520.00/14520.00) |  |
| 5 | 5 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (115.00/115.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/7590.00) | OK (7590.00/7590.00) |  |
| 6 | 6 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (110.00/110.00) | OK (66/66) | OK (шт/шт) | MISSING_REF (/7260.00) | OK (7260.00/7260.00) |  |

### train: РОВЕН-Самара

- Source invoice: `Ровен Счёт_5244.pdf`
- Benchmark file: `scripts/benchmark-ready/train/РОВЕН-Самара_18091_30.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (6579.00/6579.00) | OK (12/12) | OK (шт/шт) | MISSING_REF (/78948.00) | OK (78948.00/78948.00) |  |
| 1 | 1 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (3803.80/3803.80) | OK (1/1) | OK (шт/шт) | MISSING_REF (/3803.80) | OK (3803.80/3803.80) |  |
| 2 | 2 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (2226.75/2226.75) | OK (2/2) | OK (уп/уп) | MISSING_REF (/4453.50) | OK (4453.50/4453.50) |  |
| 3 | 3 | position | no | OK (0.980) | MISSING_REF | NOT_APPLICABLE (1212.00/1212.00) | OK (1/1) | OK (уп/уп) | MISSING_REF (/1212.00) | OK (1212.00/1212.00) |  |
| 4 | 4 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (324.75/324.75) | OK (1/1) | OK (уп/уп) | MISSING_REF (/324.75) | OK (324.75/324.75) |  |
| 5 | 5 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (1381.50/1381.50) | OK (1/1) | OK (уп/уп) | MISSING_REF (/1381.50) | OK (1381.50/1381.50) |  |
| 6 | 6 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (420.75/420.75) | OK (1/1) | OK (уп/уп) | MISSING_REF (/420.75) | OK (420.75/420.75) |  |
| 7 | 7 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (1707.00/1707.00) | OK (2/2) | OK (уп/уп) | MISSING_REF (/3414.00) | OK (3414.00/3414.00) |  |
| 8 | 8 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (435.75/435.75) | OK (1/1) | OK (уп/уп) | MISSING_REF (/435.75) | OK (435.75/435.75) |  |

### train: Электротехмонтаж

- Source invoice: `403_2026315_202511271152_5492386_PRINTER2.TXT (1).pdf`
- Benchmark file: `scripts/benchmark-ready/train/Электротехмонтаж_867590_77.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.
- Benchmark integrity warning: benchmark position_count=33 differs from items.length=34; using items.length

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | article | no | OK (1.000) | OK | NOT_APPLICABLE (476629.16/476629.16) | OK (1/1) | OK (шт/шт) | MISSING_REF (/476629.16) | OK (476629.16/476629.16) |  |
| 1 | 1 | article | no | OK (1.000) | OK | NOT_APPLICABLE (36963.66/36963.66) | OK (2/2) | OK (шт/шт) | MISSING_REF (/73927.32) | OK (73927.32/73927.32) |  |
| 2 | 2 | article | no | OK (0.985) | OK | NOT_APPLICABLE (18173.52/18173.52) | OK (2/2) | OK (шт/шт) | MISSING_REF (/36347.04) | OK (36347.04/36347.04) |  |
| 3 | 3 | position | no | OK (0.992) | FAIL | NOT_APPLICABLE (1334.72/1334.72) | OK (457/457) | OK (шт/шт) | MISSING_REF (/609968.87) | OK (609968.87/609968.87) |  |
| 4 | 4 | article | no | OK (1.000) | OK | NOT_APPLICABLE (473.30/473.30) | OK (395/395) | OK (шт/шт) | MISSING_REF (/186955.08) | OK (186955.08/186955.08) |  |
| 5 | 5 | position | no | OK (0.979) | FAIL | NOT_APPLICABLE (1068.98/1068.98) | OK (27/27) | OK (шт/шт) | MISSING_REF (/28862.57) | OK (28862.57/28862.57) |  |
| 6 | 6 | article | no | OK (1.000) | OK | NOT_APPLICABLE (1315.80/1315.80) | NOT_APPLICABLE (24/24) | NOT_APPLICABLE (шт/шт) | MISSING_REF (/31579.20) | OK (31579.20/31579.20) | split/merge cluster candidate; row financial fields are not standal... |
| 7 | 7 | position | no | OK (1.000) | FAIL | NOT_APPLICABLE (1292.58/1292.58) | NOT_APPLICABLE (2/2) | NOT_APPLICABLE (шт/шт) | MISSING_REF (/2585.16) | OK (2585.16/2585.16) | split/merge cluster candidate; row financial fields are not standal... |
| 8 | 8 | article | no | OK (1.000) | OK | NOT_APPLICABLE (1387.17/1387.18) | OK (27/27) | OK (шт/шт) | MISSING_REF (/37453.75) | OK (37453.75/37453.75) |  |
| 9 | 9 | position | no | OK (0.973) | FAIL | NOT_APPLICABLE (3569.00/3569.00) | OK (32/32) | OK (шт/шт) | MISSING_REF (/114208.13) | OK (114208.13/114208.13) |  |
| 10 | 10 | article | no | OK (1.000) | OK | NOT_APPLICABLE (585.66/585.66) | OK (69/69) | OK (шт/шт) | MISSING_REF (/40410.54) | OK (40410.54/40410.54) |  |
| 11 | 11 | article | no | OK (0.988) | OK | NOT_APPLICABLE (1311.55/1311.55) | OK (137/137) | OK (шт/шт) | MISSING_REF (/179682.62) | OK (179682.62/179682.62) |  |
| 12 | 12 | article | no | OK (1.000) | OK | NOT_APPLICABLE (200557.50/200557.50) | OK (1/1) | OK (шт/шт) | MISSING_REF (/200557.50) | OK (200557.50/200557.50) |  |
| 13 | 13 | article | no | OK (1.000) | OK | NOT_APPLICABLE (33426.25/33426.25) | OK (1/1) | OK (шт/шт) | MISSING_REF (/33426.25) | OK (33426.25/33426.25) |  |
| 14 | 14 | article | no | OK (1.000) | OK | NOT_APPLICABLE (5348.20/5348.20) | OK (1/1) | OK (шт/шт) | MISSING_REF (/5348.20) | OK (5348.20/5348.20) |  |
| 15 | 15 | article | no | OK (1.000) | OK | NOT_APPLICABLE (4216.59/4216.60) | OK (8/8) | OK (шт/шт) | MISSING_REF (/33732.77) | OK (33732.77/33732.77) |  |
| 16 | 16 | article | no | OK (1.000) | OK | NOT_APPLICABLE (11201.50/11201.50) | OK (1/1) | OK (шт/шт) | MISSING_REF (/11201.50) | OK (11201.50/11201.50) |  |
| 17 | 17 | position | no | OK (0.957) | FAIL | NOT_APPLICABLE (6982.40/6982.40) | OK (1/1) | OK (шт/шт) | MISSING_REF (/6982.40) | OK (6982.40/6982.40) |  |
| 18 | 18 | article | no | OK (0.967) | OK | NOT_APPLICABLE (6687.36/6687.36) | OK (1/1) | OK (шт/шт) | MISSING_REF (/6687.36) | OK (6687.36/6687.36) |  |
| 19 | 19 | position | no | OK (0.941) | OK | NOT_APPLICABLE (9414.97/9414.97) | OK (4/4) | OK (шт/шт) | MISSING_REF (/37659.89) | OK (37659.89/37659.89) |  |
| 20 | 20 | position | no | OK (0.941) | OK | NOT_APPLICABLE (9414.97/9414.97) | OK (4/4) | OK (шт/шт) | MISSING_REF (/37659.89) | OK (37659.89/37659.89) |  |
| 21 | 21 | position | no | OK (0.973) | FAIL | NOT_APPLICABLE (19.98/19.98) | OK (2700/2700) | OK (м/м) | MISSING_REF (/53946.00) | OK (53946.00/53946.00) |  |
| 22 | 22 | position | no | OK (0.972) | FAIL | NOT_APPLICABLE (48.73/48.73) | OK (1200/1200) | OK (м/м) | MISSING_REF (/58478.40) | OK (58478.40/58478.40) |  |
| 23 | 23 | article | no | OK (0.894) | OK | NOT_APPLICABLE (80.23/80.23) | OK (150/150) | OK (м/м) | MISSING_REF (/12034.80) | OK (12034.80/12034.80) |  |
| 24 | 24 | position | no | OK (0.992) | FAIL | NOT_APPLICABLE (18.44/18.44) | OK (150/150) | OK (м/м) | MISSING_REF (/2766.60) | OK (2766.60/2766.60) |  |
| 25 | 25 | article | no | OK (0.986) | OK | NOT_APPLICABLE (1773.62/1773.62) | OK (187/187) | OK (шт/шт) | MISSING_REF (/331667.69) | OK (331667.69/331667.69) |  |
| 26 | 26 | position | no | OK (1.000) | FAIL | NOT_APPLICABLE (121.38/121.38) | OK (66/66) | OK (м/м) | MISSING_REF (/8011.08) | OK (8011.08/8011.08) |  |
| 27 | 27 | position | no | OK (0.977) | FAIL | NOT_APPLICABLE (10.96/10.96) | OK (130/130) | OK (шт/шт) | MISSING_REF (/1424.28) | OK (1424.28/1424.28) |  |
| 28 | 28 | position | no | OK (1.000) | FAIL | NOT_APPLICABLE (15.22/15.22) | OK (3600/3600) | OK (м/м) | MISSING_REF (/54777.60) | OK (54777.60/54777.60) |  |
| 29 | 29 | position | no | OK (0.977) | FAIL | NOT_APPLICABLE (4.34/4.34) | OK (7200/7200) | OK (шт/шт) | MISSING_REF (/31276.80) | OK (31276.80/31276.80) |  |
| 30 | 30 | article | no | OK (0.966) | OK | NOT_APPLICABLE (2.53/2.53) | OK (20000/20000) | OK (шт/шт) | MISSING_REF (/50640.00) | OK (50640.00/50640.00) |  |
| 31 | 31 | article | no | FAIL (0.417) | OK | NOT_APPLICABLE (0.66/0.66) | NOT_APPLICABLE (20000/20000) | NOT_APPLICABLE (шт/шт) | MISSING_REF (/13200.00) | OK (13200.00/13200.00) | split/merge cluster candidate; row financial fields are not standal... |
| 32 | 32 | article | no | FAIL (0.111) | OK | NOT_APPLICABLE (34139.82/34139.82) | NOT_APPLICABLE (1/1) | NOT_APPLICABLE (шт/шт) | MISSING_REF (/34139.82) | OK (34139.82/34139.82) | split/merge cluster candidate; row financial fields are not standal... |
| 33 | 33 | position | yes | FAIL (0.183) | MISSING_REF | MISSING_REF (/1578.96) | MISSING_REF (/24) | MISSING_REF (/шт) | MISSING_REF (/37895.04) | OK (37895.04/37895.04) | low-confidence positional row match |

### holdout: Веза-Самара

- Source invoice: `КП 1201038 АТК (3) (1).xls`
- Benchmark file: `scripts/benchmark-ready/holdout/Веза-Самара_207748_83.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (42907.21/42907.21) | OK (1/1) | OK (шт/шт) | MISSING_REF (/42907.21) | OK (42907.21/42907.21) |  |
| 1 | 1 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (42907.21/42907.21) | OK (1/1) | OK (шт/шт) | MISSING_REF (/42907.21) | OK (42907.21/42907.21) |  |
| 2 | 2 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (36741.60/36741.60) | OK (1/1) | OK (шт/шт) | MISSING_REF (/36741.60) | OK (36741.60/36741.60) |  |
| 3 | 3 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (36741.60/36741.60) | OK (1/1) | OK (шт/шт) | MISSING_REF (/36741.60) | OK (36741.60/36741.60) |  |
| 4 | 4 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (48451.21/48451.21) | OK (1/1) | OK (шт/шт) | MISSING_REF (/48451.21) | OK (48451.21/48451.21) |  |

### holdout: ООО "ВОДОМЕР"

- Source invoice: `+Водомер.xlsx`
- Benchmark file: `scripts/benchmark-ready/holdout/ООО ВОДОМЕР_76720_00.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | article | no | OK (1.000) | OK | NOT_APPLICABLE (38360.00/38360.00) | OK (1/1) | OK (шт/шт) | MISSING_REF (/38360.00) | OK (38360.00/38360.00) |  |
| 1 | 1 | article | no | OK (1.000) | OK | NOT_APPLICABLE (38360.00/38360.00) | OK (1/1) | OK (шт/шт) | MISSING_REF (/38360.00) | OK (38360.00/38360.00) |  |

### holdout: ООО "ЭЛИТА-Центр"

- Source invoice: `Элита КНС дренажник КП 3 360_28_01_2025 (1).pdf`
- Benchmark file: `scripts/benchmark-ready/holdout/ООО ЭЛИТА-Центр_963030_61.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (936728.36/936728.36) | OK (1/1) | OK (шт/шт) | MISSING_REF (/936728.36) | OK (936728.36/936728.36) |  |
| 1 | 1 | position | no | OK (1.000) | MISSING_REF | NOT_APPLICABLE (26302.25/26302.25) | OK (1/1) | OK (шт/шт) | MISSING_REF (/26302.25) | OK (26302.25/26302.25) |  |

### holdout: САНТЕХПРОМ

- Source invoice: `Коммерческое предложение № 91 от 03 февраля 2026 г.pdf`
- Benchmark file: `scripts/benchmark-ready/holdout/САНТЕХПРОМ_201306_69.json`
- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.
- VAT rate/amount metrics: `NOT_APPLICABLE`.

| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |
|---:|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | article | no | OK (1.000) | OK | NOT_APPLICABLE (7949.19/7949.19) | OK (47/47) | OK (шт/шт) | MISSING_REF (/373611.93) | OK (373611.93/373611.93) |  |
| 1 | 1 | article | no | OK (1.000) | OK | NOT_APPLICABLE (8813.10/8813.10) | OK (15/15) | OK (шт/шт) | MISSING_REF (/132196.50) | OK (132196.50/132196.50) |  |
| 2 | 2 | article | no | OK (1.000) | OK | NOT_APPLICABLE (9677.01/9677.01) | OK (18/18) | OK (шт/шт) | MISSING_REF (/174186.18) | OK (174186.18/174186.18) |  |
| 3 | 3 | article | no | OK (1.000) | OK | NOT_APPLICABLE (10540.92/10540.92) | OK (17/17) | OK (шт/шт) | MISSING_REF (/179195.64) | OK (179195.64/179195.64) |  |
| 4 | 4 | article | no | OK (1.000) | OK | NOT_APPLICABLE (11404.83/11404.83) | OK (30/30) | OK (шт/шт) | MISSING_REF (/342144.90) | OK (342144.90/342144.90) |  |
| 5 | 5 | article | no | OK (1.000) | OK | NOT_APPLICABLE (12268.74/12268.74) | OK (46/46) | OK (шт/шт) | MISSING_REF (/564362.04) | OK (564362.04/564362.04) |  |
| 6 | 6 | article | no | OK (1.000) | OK | NOT_APPLICABLE (14860.47/14860.47) | OK (2/2) | OK (шт/шт) | MISSING_REF (/29720.94) | OK (29720.94/29720.94) |  |
| 7 | 7 | article | no | OK (1.000) | OK | NOT_APPLICABLE (7949.19/7949.19) | OK (44/44) | OK (шт/шт) | MISSING_REF (/349764.36) | OK (349764.36/349764.36) |  |
| 8 | 8 | article | no | OK (1.000) | OK | NOT_APPLICABLE (8813.10/8813.10) | OK (16/16) | OK (шт/шт) | MISSING_REF (/141009.60) | OK (141009.60/141009.60) |  |
| 9 | 9 | article | no | OK (1.000) | OK | NOT_APPLICABLE (9677.01/9677.01) | OK (2/2) | OK (шт/шт) | MISSING_REF (/19354.02) | OK (19354.02/19354.02) |  |
| 10 | 10 | article | no | OK (1.000) | OK | NOT_APPLICABLE (10540.92/10540.92) | OK (30/30) | OK (шт/шт) | MISSING_REF (/316227.60) | OK (316227.60/316227.60) |  |
| 11 | 11 | article | no | OK (1.000) | OK | NOT_APPLICABLE (11404.83/11404.83) | OK (38/38) | OK (шт/шт) | MISSING_REF (/433383.54) | OK (433383.54/433383.54) |  |
| 12 | 12 | article | no | OK (1.000) | OK | NOT_APPLICABLE (12268.74/12268.74) | OK (26/26) | OK (шт/шт) | MISSING_REF (/318987.24) | OK (318987.24/318987.24) |  |
| 13 | 13 | article | no | OK (1.000) | OK | NOT_APPLICABLE (14860.47/14860.47) | OK (18/18) | OK (шт/шт) | MISSING_REF (/267488.46) | OK (267488.46/267488.46) |  |
| 14 | 14 | article | no | OK (1.000) | OK | NOT_APPLICABLE (5183.46/5183.46) | OK (2/2) | OK (шт/шт) | MISSING_REF (/10366.92) | OK (10366.92/10366.92) |  |
| 15 | 15 | article | no | OK (1.000) | OK | NOT_APPLICABLE (6047.37/6047.37) | OK (2/2) | OK (шт/шт) | MISSING_REF (/12094.74) | OK (12094.74/12094.74) |  |
| 16 | 16 | article | no | OK (1.000) | OK | NOT_APPLICABLE (6911.28/6911.28) | OK (6/6) | OK (шт/шт) | MISSING_REF (/41467.68) | OK (41467.68/41467.68) |  |
| 17 | 17 | article | no | OK (1.000) | OK | NOT_APPLICABLE (7775.19/7775.19) | OK (1/1) | OK (шт/шт) | MISSING_REF (/7775.19) | OK (7775.19/7775.19) |  |
| 18 | 18 | article | no | OK (1.000) | OK | NOT_APPLICABLE (10366.92/10366.92) | OK (1/1) | OK (шт/шт) | MISSING_REF (/10366.92) | OK (10366.92/10366.92) |  |
| 19 | 19 | article | no | OK (1.000) | OK | NOT_APPLICABLE (12958.65/12958.65) | OK (33/33) | OK (шт/шт) | MISSING_REF (/427635.45) | OK (427635.45/427635.45) |  |
| 20 | 20 | article | no | OK (0.987) | OK | NOT_APPLICABLE (293.19/293.19) | OK (45/45) | OK (шт/шт) | MISSING_REF (/13193.55) | OK (13193.55/13193.55) |  |
| 21 | 21 | article | no | OK (1.000) | OK | NOT_APPLICABLE (697.74/697.74) | OK (349/349) | OK (шт/шт) | MISSING_REF (/243511.26) | OK (243511.26/243511.26) |  |
| 22 | 22 | article | no | OK (0.963) | OK | NOT_APPLICABLE (44.37/44.37) | OK (1570/1570) | OK (шт/шт) | MISSING_REF (/69660.90) | OK (69660.90/69660.90) |  |

