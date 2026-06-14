# Verity@1 Measurement — Proj.12 "ЖК у БКК ОВ"
**Date:** 2026-06-11  
**Spec:** id=24, 510 positions (ОВ — Отопление + Вентиляция)

---

## 1. HEADLINE NUMBERS

| Metric | Count | % of 510 |
|--------|------:|-----------|
| Items with TOP-1 proposal (current prod) | 202 | 39.6% |
| **CORRECT** (top-1 = right analog) | **154** | **30.2%** |
| WRONG (wrong supplier or model) | 16 | 3.1% |
| MISSED (analog loaded, no proposal) | 26 | 5.1% |
| NOT LOADED (analog exists, not in prod) | 1 | 0.2% |
| TRUE GAP (no analog anywhere) | 264 | 51.8% |
| AMBIGUOUS (custom fab sub-items, etc.) | 49 | 9.6% |

**VERITY@1 overall (correct / 510): 30.2%**  
**VERITY@1 vs analog-in-loaded (196 items): 78.6%**  
**Recoverable by loading more invoices: 0.2% (1 item — теплосчетчик)**  
**Structural ceiling (true gap, custom fab): 51.8% (264 items)**

---

## 2. METHOD

### 2.1 Data sources

| File | Role |
|------|------|
| `Проект 01_05-07-24-ОВ-37-59.pdf` | Source spec (смета), spec_id=24, 510 items |
| `ЖК у БКК-20260611T051613Z-3-001.zip` | 8 invoice/offer documents (ZIP) |
| `01_05-07-24-ОВ эталон жк бкк арта.xlsx` | Ground truth reference |
| `GET /api/specifications/24/items` | Spec items from prod |
| `GET /api/projects/12/matching` | System proposals from prod (READ-ONLY) |

### 2.2 Reference XLSX interpretation

The "эталон" file (`01_05-07-24-ОВ эталон жк бкк арта.xlsx`, 518 rows, 1 sheet) is **the spec itself** (bill of materials), NOT a pre-made list of match decisions. Structure:

- **Col A**: Поз. (position)
- **Col B**: Наименование (spec item name)
- **Col C**: Тип/марка (type/article)
- **Col E**: Изготовитель (manufacturer)
- **Col F/G/H/I**: Unit / Qty / Price / Sum
- **Col J**: "аналог" (analog price) — filled for **21 items only** (SANEXT alternative pricing)
- **Col L**: "аналог" supplier — values: `'SANEXT'` or `'Теплосчетчик SANEXT 5753'`
- **Col P/Q**: Alternative supplier/price — `'НЗВЗ'` for 14 grille/damper items with prices

**Interpretation of analogs:**
- 21 items have explicit SANEXT pricing (шаровые краны, балансировочные клапаны, компенсаторы Ø20-Ø100, трубы PEX Ø16–Ø32, теплосчетчик) — SANEXT is the intended supplier
- 14 items have НЗВЗ pricing (решетки, регулирующие клапаны) — НЗВЗ is correct for these
- Remaining 444 items: correct supplier inferred from invoice domain (see §2.3)

### 2.3 Invoice inventory (ZIP)

| Document | Supplier | Items |
|----------|----------|-------|
| Заказ клиента № 6492 от 26.05.2026 | НЗВЗ "Волгопромвентиляция" | 104 items: fans, fire dampers, grilles, AHU Нововент |
| Счет № УТ-8068 от 01.06.2026 | ООО «Теплый дом» | ~57 items: Royal Thermo radiators, MVI collectors, LD cranes, AYVAZ compensators, MVI balancing valves, PEX pipes |
| Счет № 5109 от 26.05.2026 | ФРЕГАТ ЛТД | 21 items: K-FLEX insulation cylinders (Ø22–108), OBM fire protection |
| Счет № 5166 от 27.05.2026 | ФРЕГАТ ЛТД | 3 items: K-FLEX glue, cleaner, aluminum tape |
| Счет № 784 от 03.06.2026 | Вентура Поволжье | 7 items: Thermacompact IS (Ø18–35), adhesive, tape |
| КП № 82807/02 от 26.05.2026 | Инновент | 1 item: Воздушная противодымная завеса ВПЗ-ИННОВЕНТ-4-5,2-ПР |
| КП Сигма-Вент № СВ-9383 от 27.05.2026 | Сигма-Вент | 2 items: Клапан КИД 600×600, Решетка Рск 600×600 |
| Предложение 894066 от 26.05.2026 | Unknown | UNREADABLE (cid font encoding — text all `(cid:xx)`) |

**Loaded in prod (inferred from supplier names in proposals):**  
ООО «Теплый дом», НЗВЗ, ФРЕГАТ ЛТД, Инновент (garbled name), Сигма-Вент, Вентура Поволжье (счет 784, supplier=null in API but matched items confirmed)

### 2.4 Verity scoring logic

For each of 510 spec items:
1. Assign category (radiator, collector, ductwork, etc.)
2. Look up expected supplier per category
3. Compare system's top-1 proposal supplier and model to expected
4. Classify as CORRECT / WRONG / MISSED / NOT_LOADED / TRUE_GAP / AMBIGUOUS

**CORRECT criterion:** top-1 supplier matches expected AND model/characteristics match (numeric dimensions present in invoice item name).

**Commands used:**
```
GET http://5.42.103.63:3001/api/specifications/24/items
GET http://5.42.103.63:3001/api/projects/12/matching
python C:\Temp\parse_ref4.py     # XLSX structure analysis
python C:\Temp\parse_pdfs.py     # Invoice parsing (pdfplumber)
python C:\Temp\final_score3.py   # Verity scoring
```

---

## 3. INVOICE COVERAGE VS SPEC

### Which spec categories are covered by loaded invoices

| Category | Spec items | Loaded supplier | Coverage |
|----------|----------:|-----------------|---------|
| Radiators (Royal Thermo) | 33 | Теплый дом (УТ-8068) | Full |
| Collectors MVI | 4 | Теплый дом (УТ-8068) | Full |
| Cranes LD | 4 | Теплый дом (УТ-8068) | Full |
| Balance valves MVI | 4 | Теплый дом (УТ-8068) | Full |
| AYVAZ compensators | 2 | Теплый дом (УТ-8068) | Full |
| PEX pipes | ~4 | Теплый дом (УТ-8068) | Full |
| K-FLEX insulation cylinders | 9 | ФРЕГАТ (5109) | Full |
| Thermacompact insulation | 4 | Вентура (784, null supplier) | Full |
| OBM fire protection | 16 | ФРЕГАТ (5109) | Partial (13 missed) |
| Ventilation (fans, dampers) | ~50 | НЗВЗ (6492) | Partial |
| Grilles/diffusers | 19 | НЗВЗ (6492) | Partial |
| Fire curtain ВПЗ | 2 | Инновент (82807) | Partial |
| **Ductwork** (rectangular) | **105** | **NONE** | **0%** |
| **Duct fittings** (elbows, transitions) | **122** | **NONE** | **0%** |
| Steel pipes (Ø, ГОСТ) | 33 | NONE | 0% |
| Теплосчетчик (SANEXT) | 1 | SANEXT not loaded | 0% |
| Electric convector | 1 | NONE | 0% |

**Key finding:** Ductwork + duct fittings = 227 items (44.5% of spec) are **custom fabricated items** priced by м² — not available from any supplier invoice. These represent the dominant TRUE_GAP.

---

## 4. VERITY@1 DETAILED RESULTS

### 4.1 Summary table

| Status | N | % | Description |
|--------|--:|---|-------------|
| CORRECT | 154 | 30.2% | Top-1 is the right item from right supplier |
| WRONG_SUPPLIER | 11 | 2.2% | Right category but wrong supplier chosen |
| WRONG_MODEL | 5 | 1.0% | Right supplier but wrong model/size |
| MISSED | 26 | 5.1% | Analog in loaded docs, but no proposal generated |
| NOT_LOADED | 1 | 0.2% | Теплосчетчик SANEXT — not in any invoice |
| TRUE_GAP | 264 | 51.8% | No analog in any provided invoice |
| AMBIGUOUS | 49 | 9.6% | Custom fab child items + unclassified |
| **TOTAL** | **510** | **100%** | |

### 4.2 Correct matches by tier

| Tier | Count |
|------|------:|
| llm_suggestion | 148 |
| name_similarity | 6 |
| Total | **154** |

Note: 0 confirmed matches (все proposals = unconfirmed). All proposals are system-generated.

### 4.3 Per-category breakdown

| Category | Total | Correct | Wrong | Missed | Gap |
|----------|------:|-------:|------:|-------:|----:|
| radiator | 33 | 33 | 0 | 0 | 0 |
| fire_damper | 33 | 29 | 0 | 4 | 0 |
| ahu | 19 | 14 | 0 | 5 | 0 |
| grille | 19 | 14 | 5 | 0 | 0 |
| flex_insert | 9 | 9 | 0 | 0 | 0 |
| insulation_kflex | 9 | 8 | 1 | 0 | 0 |
| ahu_part | 5 | 5 | 0 | 0 | 0 |
| fan | 5 | 5 | 0 | 0 | 0 |
| balance_valve | 4 | 4 | 0 | 0 | 0 |
| ball_valve | 4 | 4 | 0 | 0 | 0 |
| collector | 4 | 4 | 0 | 0 | 0 |
| relay | 4 | 4 | 0 | 0 | 0 |
| insulation_therma | 4 | 4* | 0 | 0 | 0 |
| actuator | 6 | 2 | 2 | 2 | 0 |
| fire_protection | 16 | 0 | 3 | 13 | 0 |
| damper_other | 4 | 4 | 0 | 0 | 0 |
| duct_fitting | 122 | 0 | 0 | 0 | 122 |
| ductwork | 105 | 0 | 0 | 0 | 105 |
| pipe_bare | 33 | 0 | 0 | 0 | 33 |
| other/ambiguous | 49+ | — | — | — | — |

*Thermacompact items matched from счет 784 (Вентура Поволжье) but supplierName=null in API.

---

## 5. ERROR TAXONOMY

### 5.1 WRONG_SUPPLIER (11 items)

System picks from wrong supplier even though both are in prod:

| # | Spec item | Spec chars | Expected | System picked | System supplier |
|---|-----------|-----------|----------|--------------|----------------|
| 1 | δ=30мм Ø22 | K-ROCK ALU S | ФРЕГАТ (K-FLEX) | Цилиндр K-FLEX 30x022-1 K-ROCK ALU S /20 | Теплый дом |
| 2 | δ=6мм Ø18 | ThermaCompact IS | Вентура | Thermacompact IS (S) C-18 (180м) | (null) |
| 3 | δ=6мм Ø22 | ThermaCompact IS | Вентура | Thermacompact IS (S) C-22 (160м) | (null) |
| 4 | δ=6мм Ø28 | ThermaCompact IS | Вентура | Thermacompact IS (S) C-28 | (null) |
| 5 | δ=6мм Ø35 | ThermaCompact IS | Вентура | Thermacompact IS (S) C-35 | (null) |
| 6 | Комплект подключения | — | Теплый дом | Узел нижнего подключения Royal Thermo | Теплый дом |
| 7 | Решетка вентиляционная (several) | — | НЗВЗ | Решетка Рск 600×600 | Сигма-Вент |

**Root cause for Thermacompact (items 2-5):** The Вентура Поволжье invoice (счет 784) is loaded but its invoice items have `supplierName=null` in the API. The match IS semantically correct (Thermacompact IS C-18 → δ=6мм Ø18), but the supplier field is missing — this is a data quality issue in the invoice ingestion, not a matching error. Reclassifying as CORRECT-WITH-NULL-SUPPLIER = **4 additional correct**.

**Root cause for item 1 (δ=30мм Ø22, K-ROCK ALU S):** The spec item is K-FLEX cylinder insulation (from ФРЕГАТ, счет 5109), but the system assigned it to Теплый дом. This is a supplier field error in the match response — the product name "Цилиндр K-FLEX 30x022-1 K-ROCK ALU S /20" is from ФРЕГАТ. Likely the invoice item record has wrong `supplierName`. Net effect: 1 truly wrong.

**Grilles (item 7):** Several грилле items get matched to Сигма-Вент (Рск 600×600) instead of НЗВЗ (1VA grilles). The Сигма-Вент grille is a different type for a different system (смокдемпер решетка), so these ARE wrong matches.

### 5.2 WRONG_MODEL (5 items)

All are "Огнезащитная изоляция" items:

| Spec | Spec chars | System pick |
|------|-----------|------------|
| Огнезащитная изоляция | МБФ-7 | ОБМ-5Ф (wrong thickness) |
| Огнезащитная изоляция | МБФ-5 | ОБМ-5Ф (may be OK actually) |
| Огнезащитная изоляция | МБФ-16 | ОБМ-5Ф (wrong thickness) |

Root cause: Spec has `МБФ-5`, `МБФ-7`, `МБФ-16` (thickness in mm). Invoice has `ОБМ-5Ф`, `ОБМ-13Ф` (by volume variant). The mapping is not 1:1 by mark/thickness.

### 5.3 MISSED (26 items)

Items where the correct invoice exists in prod but no proposal was generated:

| Category | Count | Example |
|----------|------:|---------|
| fire_protection (OBM) | 13 | Огнезащитная изоляция МБФ-5 (multiple instances across systems) |
| fire_damper | 4 | Клапан противопожарный нормально-закрытый канальный (АЗЕН) |
| ahu | 5 | Вентиляционная установка, в составе: (sub-unit items) |
| tape | 1 | Лента самоклеящаяся для монтажа теплоизоляции |
| fire_curtain | 1 | Воздушно-тепловая завеса с кронштейнами |
| actuator | 2 | Электропривод SA10MU230DS |

Root cause for OBM (13 items): There are multiple `Огнезащитная изоляция; EI45; НГ; S=5мм` rows across different subsystems (ВД1-П, ПД1-П, etc.) — the system matched the first occurrence but left duplicates unmatched.

### 5.4 NOT_LOADED (1 item)

| Spec item | Expected supplier | Reason |
|-----------|-------------------|--------|
| Теплосчетчик поквартирный | SANEXT | SANEXT is the reference price in эталон XLSX (col J: 3800 руб, col L: "Теплосчетчик SANEXT 5753"). Neither SANEXT nor its analog is in any provided invoice. |

### 5.5 TRUE_GAP (264 items)

| Category | Count | Example |
|----------|------:|---------|
| duct_fitting (elbows, transitions) | 122 | Отвод-90° из оцинк. ст. толщ. S=0,7мм 600x400 |
| ductwork (rectangular channels) | 105 | Воздуховод из оцинк. ст. толщ. S=0,7мм 600x400 |
| pipe_bare (steel pipe sections) | 33 | Ø15, Ø25, Ø40, Ø65, Ø80, Ø100 |
| paint/coating | 2 | грунт ГФ-021, краска ПФ-115 |
| electric_convector | 1 | Электрический конвектор с кронштейнами 1500Вт |
| metal_mounting | 1 | Металл для крепления трубопроводов |

**Key insight:** Ductwork + fittings (227 items, 44.5%) are **custom-fabricated items** listed in spec as raw dimensions (м²) with GOST reference. They are manufactured to order and are NOT available as off-the-shelf line items in any supplier price list. These cannot ever be matched to standard invoices — they are inherently outside the scope of the matching system.

Steel pipes (33 "Ø15", "Ø25", etc.) are bare pipe diameter sections without full specification — these are sub-items of the heating system sections and also are not in any invoice.

---

## 6. DATA-RECOVERY ANALYSIS

### Currently loaded suppliers cover:
- All heating equipment (Теплый дом): radiators, collectors, cranes, PEX pipes → **43 items, 100% proposal rate**
- НЗВЗ ventilation: fans, fire dampers, AHU → **~50 items, 70-80% proposal rate**
- K-FLEX insulation: Фрегат → **9 items, ~90% covered**
- Thermacompact insulation: Вентура → **4 items, matched but null supplier**

### What loading SANEXT would recover:
- 1 item: Теплосчетчик поквартирный (SANEXT 5753, 132 шт.)
- Recovery: +0.2% (1/510)
- **Very small gain** — SANEXT is not in any provided invoice anyway

### Sigma-Vent (already loaded, 2 items):
- Клапан КИД 600×600 — matched to wrong spec items (wrong for противодымные клапаны)
- Решетка Рск 600×600 — matched to wrong grille items (НЗВЗ 1VA grilles are the right ones)
- **Net effect: loading Sigma-Vent caused 5 wrong matches among grilles**

### Предложение 894066 (UNREADABLE):
- PDF uses custom font with CID encoding — text is garbled as `(cid:xx)` sequences
- Cannot parse without the font map — content unknown
- If it contains ductwork pricing, would reduce TRUE_GAP — but ductwork items have area-based pricing (м²), not a standard format

---

## 7. SINGLE DOMINANT LEVER

**The TRUE_GAP (ductwork + fittings) = 264 items / 51.8% of spec is structural.**

These are custom-fabricated rectangular duct items specified in м² (площадь разворотки). They will never appear in standard supplier invoices as named line items. No amount of loading more invoices will cover them.

**Within the matchable universe (196 items): verity@1 = 78.6%.**

This means the system is working well for items that CAN be matched. The bottleneck is:

1. **Structural coverage ceiling** (264/510 = 51.8%): Custom-fab ductwork has no invoice analog — this is architectural. The fix would require either:
   - A fabrication pricing model (price-per-m² for each duct type and thickness)
   - Or accepting that ductwork is not in scope for this matching system

2. **MISSED items (26/510 = 5.1%)**: OBM fire protection (13 items) — same product, multiple occurrences across subsystems. Fix: ensure deduplication/copy logic runs for recurring items.

3. **Wrong matches (16/510 = 3.1%)**: Primarily grille-type confusion (Сигма-Вент КИД решетки ≠ НЗВЗ 1VA решетки) and supplier-null metadata for Вентура items.

**To raise verity@1 from 30.2% → the theoretical maximum (assuming ductwork truly out-of-scope):**
- Maximum achievable = (196 correct + 26 missed + 16 wrong) / 510 = **47%** verity@1 by fixing MISSED + WRONG
- Beyond that, ductwork/fittings (51.8%) is a structural ceiling

---

## 8. PROD STATE SNAPSHOT (2026-06-11)

From `GET /api/projects/12/matching` summary:
```json
{
  "total": 510,
  "matched": 202,
  "confirmed": 0,
  "unmatched": 308,
  "tierBreakdown": {
    "learned_rule": 1,
    "llm_suggestion": 191,
    "name_characteristics": 4,
    "name_similarity": 6
  }
}
```

- 0 confirmed matches — all proposals are pending operator review
- 202 proposals (39.6% coverage)
- 148/154 correct matches came from `llm_suggestion` tier

---

## 9. VERITY@1 ADJUSTED (accounting for null-supplier Thermacompact)

The 4 Thermacompact items show `supplierName=null` in API but the invoice items clearly come from счет 784 (Вентура Поволжье). These are semantically correct matches — the null is a data quality issue.

**Adjusted VERITY@1 = (154 + 4) / 510 = 158/510 = 31.0%**  
**Adjusted vs in-loaded = 158/196 = 80.6%**

---

## RAW COUNTS SUMMARY (for verification)

```
total spec items:           510
proposals in prod:          202  (39.6%)
correct:                    154  (30.2%)   [+4 null-supplier = 158 / 31.0%]
wrong_supplier:              11  (2.2%)
wrong_model:                  5  (1.0%)
missed:                      26  (5.1%)
not_loaded:                   1  (0.2%)
true_gap:                   264  (51.8%)
ambiguous:                   49  (9.6%)
in_loaded_docs:             196
verity_in_loaded:          78.6% [adj: 80.6%]
correct_tier_llm:           148
correct_tier_name_sim:        6
```

### Top-1 proposals by supplier (verified from API)

| Supplier | TOP-1 proposals |
|----------|---------------:|
| НЗВЗ | 106 |
| Теплый дом | 67 |
| ФРЕГАТ ЛТД | 16 |
| (null — Вентура Поволжье) | 10 |
| Сигма-Вент | 2 |
| Инновент | 1 |
| **Total** | **202** |

### Custom-fab item counts (verified from API)

| Type | Count |
|------|------:|
| Ductwork (воздуховоды) | 105 |
| Duct fittings (отводы-90°, тройники, переходы, заглушки) | 133 |
| Steel pipe sections (Ø15–Ø133) | 33 |
| Other gaps (paint, convector, metal) | ~4 |
| **Total TRUE_GAP** | **~275** |

Note: The scoring script classified 264 as TRUE_GAP; the verified API count shows 271 custom-fab items (105+133+33). Minor discrepancy due to some borderline items (fire insulation child rows EI/S=) classified as AMBIGUOUS vs TRUE_GAP in different passes.
