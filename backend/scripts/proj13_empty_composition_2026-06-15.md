# Empty-Row Composition — proj.13 "ЖК БКК ВК" (ВК / water-plumbing)

**Date:** 2026-06-15 · **Mode:** READ-ONLY prod `GET` + offline classification (Mistral used only for a cosine sanity check) · **Endpoint:** `GET http://5.42.103.63:3001/api/projects/13/matching`

## Question
Of the **175 empty** spec rows on proj.13 (`matches.length === 0`), how many are **CATALOGABLE** off-the-shelf products (a semantic/embedding layer could recover them) vs **CUSTOM-FAB / FRAGMENT** with no catalog analog (like proj.12's ductwork)?

## VERDICT: **GO — proj.13 IS a viable semantic-layer target**
**43.4% (76/175) of empty rows are CATALOGABLE** plumbing products — at/above the ≥40% viability threshold. This is the **opposite** population from proj.12 (which was ~74% custom-fab sheet-metal ductwork, ~3% catalogable, where a semantic layer recovered only 1/301).

Decisive corroboration: **34 of those 76 catalogable empty rows have a product TWIN that the matcher DID match elsewhere in this same run** — direct proof they are catalogable and merely missed by the LLM pass, not structurally unmatchable.

## Prod summary (as returned)
`total: 281 · matched: 106 · unmatched: 175 · tiers: learned_rule 5, llm_suggestion 101`. All 175 empty rows are in section **ВК**.

## Family composition (175 empty rows)
| Family | Count | % | Note |
|---|---:|---:|---|
| **CATALOGABLE** | **76** | **43.4%** | real off-the-shelf products; 34 have a matched twin this run |
| BY_WEIGHT_MOUNT | 32 | 18.3% | real items spec'd by weight (kg): крепление/хомуты, гильзы, теплоизоляция — catalog-adjacent |
| CUSTOM_FAB / STRUCTURAL | 2 | 1.1% | обвязка насосной; ревизия сварная «изготавливается по месту» |
| FRAGMENT / NON-PRODUCT | 65 | 37.1% | bare-dimension sub-rows, attribute continuations, coating/labour lines, headers |

- **Catalogable share (strict):** **43.4%**
- **Catalogable share (incl. by-weight mount/sleeves/insulation):** **61.7%** (108/175)

### CATALOGABLE subfamilies (76)
трубы 15 · клапан запорный 12 · кран спускной 8 · фланец 7 · водомерный узел 4 · манометр 4 · сальник набивной 4 · фильтр магнитный 3 · задвижка 2 · муфта переходная 2 · смеситель 2 · кассета пож. 2 · фильтр 2 · насос/станция 1 · кран поливочный 1 · поддон душевой 1 · унитаз 1 · комп.патрубок 1 · противопожарная муфта 1 · кран пожарный 1 · клапан пожарный 1 · огнетушитель 1

### FRAGMENT subfamilies (65)
dim (bare размер, e.g. `dy150`, `d80(88.5х3.5)`) 41 · attr_for_pipe (`для стальных труб dyXX`) 14 · coating/labour (`Антикоррозионное покрытие … БТ-577`) 4 · headers 2 · attr_misc 2 · attr_class 1 · attr_with 1

## 5 examples per family
**CATALOGABLE**
- `Фильтр магнитный фланцевый Тдо150 С, Р=16 кгс/см2 ФМФ-80`
- `Манометр показывающий обыкновенного исполнения с трехходовым краном со шкалой до 10кгс/см2`
- `Унитаз керамический со смывным бачком`
- `Трубы напорные НПВХ Ф110`
- `Огнетушитель ручной`

**BY_WEIGHT_MOUNT**
- `Крепление для труб` (u=кг)
- `Гильзы для прокладки труб в перекрытиях длиной 400мм`
- `Крепление для стальных труб` (u=кг)
- `Тепловая изоляция трубками из полиэтиленовой пены класс горючести Г1, толщ.9 мм`
- `Гильзы для прокладки труб в перекрытиях длиной 300мм d48x2,0`

**CUSTOM_FAB / STRUCTURAL**
- `Обвязка насосной станции, компл.`
- `Ревизия стальная сварная (изготавливается по месту) dy100`

**FRAGMENT / NON-PRODUCT**
- `dy150` (u=шт)
- `d80(88.5х3.5)` (u=м)
- `для стальных труб dy25`
- `класс горючести НГ, толщиной 25 мм`
- `Антикоррозионное покрытие масляно-битумной краской БТ-577 за 2 раза по грунтовке ГФ-021 ОСТ 6-10-426-79`

## Mistral embedding sanity (light, as permitted)
Catalogable empty rows vs plausible catalog product names (cosine):
| pair | cos |
|---|--:|
| Фильтр магнитный ФМФ-80 ~ Фильтр магнитный Ду80 | 0.922 |
| Поддон душевой ~ Поддон 90x90 эмаль | 0.896 |
| Огнетушитель ручной ~ ОП-4 | 0.862 |
| Трубы ВГП оцинк ~ Труба ВГП Ду25 | 0.859 |
| Унитаз ~ Унитаз-компакт | 0.844 |
| Манометр показывающий ~ Манометр МП3-У | 0.840 |
| **NEG control:** Манометр ~ Унитаз | **0.712** |

Embeddings cleanly separate the real products (0.84–0.92 vs 0.71 control). Unlike proj.12, the products **exist to be matched**.

## Honest read — what the empty rows actually are
- The matcher already solved 106 rows of exactly this kind (счётчики, задвижки, обратные клапаны, насосные станции, трубы, фланцы, регуляторы давления, балансировочные клапаны). proj.13 is a fundamentally **catalogable plumbing BOM.**
- **The real ceiling here is NOT "no product exists" (proj.12's wall). It is two RECOVERABLE issues:**
  1. **Bare-dimension sub-rows (41):** the product name is on the parent row, the size (`dy150`, `d80(88.5х3.5)`) on a child — split structure, not a missing product.
  2. **Parser concatenation artifacts:** two products merged into one cell (e.g. `Кранспускной d15 Ру=16кгс/см Трубы стальные водогазопроводные оцинкованные`), defeating both the matcher and clean classification.
- A semantic/catalog layer (plus parent-context size resolution) has **real, recoverable targets** on this project — the coverage lever is **not** portfolio-wide exhausted; proj.12's exhaustion was specific to ductwork.

## Caveats
- No эталон used (not needed for composition). This is a **composition/viability** diagnostic, not an accuracy@1 measurement.
- BY_WEIGHT_MOUNT items are real but spec'd by weight (kg); whether a unit-priced catalog analog exists is supplier-dependent — reported separately so it does not inflate the strict catalogable number.
- Mistral `mistral-embed` is a directional sanity engine, not necessarily the final deploy model.

## Output files
- `backend/scripts/proj13_empty_composition_2026-06-15.json`
- `backend/scripts/proj13_empty_composition_2026-06-15.md` (this file)
