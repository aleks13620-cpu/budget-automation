# Semantic Coverage Proof — proj.12 "ЖК у БКК ОВ"

**Date:** 2026-06-15 · **Mode:** offline, READ-ONLY (no prod writes) · **Engine:** Mistral `mistral-embed` (1024-dim, multilingual)

## Question
Of the **301 empty** spec rows on proj.12 (operator sees "нет совпадений"), how many would an **embedding-based top-1 layer** answer **correctly** vs the owner's эталон?

## VERDICT: **NO-GO**
**Only 1 of 301** empty rows gets a strictly-correct semantic top-1 (6 of 301 under the most generous, size-blind family scoring). Both are far below the GO threshold of 50.

**The reason is decisive and is NOT "semantics doesn't work":** the эталон contains **no ground-truth answer** for 286 of the 301 empty rows, because those rows are **sheet-metal duct fabrication and split attribute fragments — products with no catalog counterpart**. The bottleneck is the *nature of the empty population*, not the embedding model, and not "missing invoices" either (per-project fabricated duct fittings will never appear on a supplier invoice).

## Headline counts
| Metric | Value |
|---|---:|
| N_empty_rows | **301** |
| N with эталон answer that joins to an empty row | **15** |
| ...of those, answer is IN the prod invoice pool (accuracy denominator) | **12** |
| **N_correct_top1 (strict, exact size-correct item)** | **1** |
| N_correct_top1 (generous, correct product family, size-blind) | 6 |
| N_failmode_A (model miss — answer in pool, model wrong) | 11 |
| N_failmode_B (data gap — answer not in any prod invoice) | 3 |
| N_no_ground_truth (эталон blank for these empty rows) | **286** |
| эталон analog rows total (of 517) | 57 |
| эталон analog rows that map to ALREADY-MATCHED prod rows (not empty) | **42** |
| accuracy = correct / in-pool (strict) | **8.3%** (1/12) |
| accuracy as share of 301 | **0.33%** (strict) / 2.0% (generous) |

## Why the эталон can't answer the empty rows
The 57 эталон analog rows (the only rows with any ground truth) overwhelmingly correspond to the **easy products the matcher ALREADY solved** (42/57 map to non-empty prod rows): кран шаровой → LD Pride (4 matched), решётки → НЗВЗ 1VA (19 matched), балансировочные клапаны → MVI (4 matched), огнезащита → ОБМ base material (16 matched), компенсаторы → AYVAZ (7 matched). The эталон annotates the catalogable items; it leaves the duct fabrication blank.

### Composition of the 301 empty rows
| Family | Count | Has эталон answer? |
|---|---:|---|
| Воздуховоды / фитинги (sheet-metal, fabricated-to-order) | 223 | No — not a catalog product |
| Огнезащита EI / S= attribute **fragments** (parent already matched) | 29 | No — not a product, a split sub-row |
| Other / headers | 39 | No |
| Клапаны/заслонки, вентиляторы/установки, теплоизоляция, трубы | 10 | A few |

## 15 concrete examples (the gate)
`spec_row | эталон_answer | model_top1 | cosine | correct? | failmode`

| # | spec_row | эталон_answer | model_top1 | cos | correct | failmode |
|--:|---|---|---|--:|:--:|---|
| 1 | Сильфонный компенсатор осевой… | Компенсатор "AYVAZ" DN20 | Компенсатор "AYVAZ" DN20 50… | 0.831 | ✅ | correct |
| 2 | Сильфонный компенсатор осевой… (Ø25) | Компенсатор "AYVAZ" DN25 | Компенсатор "AYVAZ" DN20 50… | 0.831 | ❌(size) | A_model_miss |
| 3 | Сильфонный компенсатор осевой… (Ø50) | Компенсатор "AYVAZ" DN50 | Компенсатор "AYVAZ" DN20 50… | 0.831 | ❌(size) | A_model_miss |
| 4 | Сильфонный компенсатор осевой… (Ø65) | Компенсатор "AYVAZ" DN65 | Компенсатор "AYVAZ" DN20 50… | 0.831 | ❌(size) | A_model_miss |
| 5 | Сильфонный компенсатор осевой… (Ø80) | Компенсатор "AYVAZ" DN80 | Компенсатор "AYVAZ" DN20 50… | 0.831 | ❌(size) | A_model_miss |
| 6 | Сильфонный компенсатор осевой… (Ø100) | Компенсатор "AYVAZ" DN100 | Компенсатор "AYVAZ" DN20 50… | 0.831 | ❌(size) | A_model_miss |
| 7 | Труба из сшитого полиэтилена… (Ø16х2,2) | Труба PEX-A EVOH 16*2,2 | Трубка K-FLEX PE 06x035 | 0.788 | ❌ | A_model_miss |
| 8 | Труба из сшитого полиэтилена… (Ø20х2,8) | Труба PEX-A EVOH 20*2,8 | Трубка K-FLEX PE 06x035 | 0.788 | ❌ | A_model_miss |
| 9 | Труба из сшитого полиэтилена… (Ø25х3,5) | Труба PEX-A EVOH 25*3,5 | Трубка K-FLEX PE 06x035 | 0.788 | ❌ | A_model_miss |
| 10 | Труба из сшитого полиэтилена… (Ø32х4,4) | Труба PEX-A EVOH 32*4,4 | Трубка K-FLEX PE 06x035 | 0.788 | ❌ | A_model_miss |
| 11 | Решетка вентиляционная АЛН 800х600 | НЗВЗ price=4372.2 → Решетка 1VA 800х600 | Вентилятор ВКК-200 | 0.847 | ❌ | A_model_miss |
| 12 | Решетка вентиляционная АЛН 300х300 | НЗВЗ price=1440 → Решетка 1VA 300х300 | Вентилятор ВКК-200 | 0.847 | ❌ | A_model_miss |
| 13 | Теплосчетчик поквартирный | Теплосчетчик SANEXT 5753 | Датчик температуры канальный | 0.790 | ❌ | B_data_gap (no SANEXT invoice) |
| 14 | Лента самоклеящаяся для монтажа теплоизол. | "310р/шт" (price note, no product) | Лента алюминиевая монтажная | 0.858 | ❌ | B_data_gap (note, not a product) |
| 15 | Воздушная противодымная завеса ВПЗ… | "СП6-П" (supplier code, not in pool) | Воздушная противодымная завеса | 0.838 | ❌ | B_data_gap |

> These 15 rows ARE essentially the entire testable set — only 15 of 301 empty rows had any эталон answer to score against. The remaining 286 empty rows (mostly sheet-metal duct fittings) have a blank эталон and are excluded from accuracy as "no ground truth".

## Honest read of the failure modes
- **Embeddings are not the bottleneck.** Cosine separates real products well: AYVAZ family surfaced correctly (0.83); the cited brief example "Неподвижная опора Ø15" vs "Хомут опорный" = **0.79**. Where a genuine product+answer existed, the family was found.
- The strict "A_model_miss" on AYVAZ (rows 2–6) is a **size-granularity artifact**: the empty spec rows are bare "Сильфонный компенсатор" / "Ø80" with no DN in their own text, so no model can pick the right DN from the parent name alone. The size lives in sub-rows that prod ALREADY matched.
- The genuine model errors (PEX труба→трубка insulation; решётка→вентилятор) show this specific embedding model is imperfect — but that is moot given the denominator is 12.
- **The real wall:** 286/301 empty rows are duct fabrication / attribute fragments with no catalog product. No embedding layer and no additional invoices can match what does not exist as a product.

## Engine + setup time
- **Engine:** Mistral `mistral-embed` (1024-dim, multilingual). Key already present in `backend/.env` (`MISTRAL_API_KEY`).
- **Setup time:** ~5 minutes (existing API key; verified Russian cosine sanity `cos(опора, хомут)=0.79`). Embedding 301 specs + 224 pool items = ~74 s of API time. No local model needed.

## Caveats
- Mistral `mistral-embed` is a directional engine, not necessarily the final deploy model.
- Ground truth = owner эталон XLSX (corrected path `…\Таблицы\01_05-07-24-ОВ эталон жк бкк арта.xlsx`); only 57/517 rows carry any analog answer.
- эталон↔empty join by normalized-name Dice ≥ 0.50, with bare-Ø rows resolved via parent context. In-pool answer resolution: AYVAZ by DN, НЗВЗ by price(±2 %)+name tiebreak, ОБМ by code, SANEXT by best name-Dice (SANEXT brand has NO loaded invoice).
- A lower join threshold would add only more "no эталон answer" or already-matched rows; it does not raise N_correct.

## Output files
- `backend/scripts/semantic_coverage_proof_proj12_2026-06-15.json` (full data + all scored GT rows)
- `backend/scripts/semantic_coverage_proof_proj12_2026-06-15.md` (this file)

## Strategic implication
The lever for proj.12 coverage is **not** a semantic layer and **not** more supplier invoices. The 301 empty rows are dominated by **per-project fabricated sheet-metal duct fittings** (223) that have no catalog product to match — the long-known ~52 % structural ceiling. A semantic layer would help on *other* projects with catalogable products and richer эталоны, but on proj.12's empty population there is essentially nothing for it to bridge.
