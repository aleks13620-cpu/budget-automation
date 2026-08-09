# Semantic Recovery Proof — proj.13 "ЖК БКК ВК" (ВК / water-plumbing)

**Date:** 2026-06-15 · **Mode:** OFFLINE, READ-ONLY prod `GET` (no writes) · **Engine:** Mistral `mistral-embed` (1024-dim, multilingual) · **Endpoint:** `GET http://5.42.103.63:3001/api/projects/13/matching` + `GET /api/projects/13/invoices` → `GET /api/invoices/:id`

## Question
Does adding a SEMANTIC (embedding) top-1 layer to proj.13 recover its **175 empty** rows **correctly**? Show a real BEFORE→AFTER coverage gain with **measured** correctness — code-backed, not asserted.

## VERDICT: **NO-GO** (but for a DIFFERENT, recoverable reason than proj.12)

A semantic layer **cannot** lift proj.13 coverage in any meaningful, certifiable way **with the invoices currently uploaded to the project** — because **the catalogable products the empty rows need are not present in proj.13's invoice pool**. The bottleneck is **missing invoice/data coverage**, not the embedding model.

This is the decisive distinction from the composition diagnostic (which said "GO — catalogable target"): the products are catalogable *in principle*, but **47 of the 76 catalogable empty rows have NO same-family product anywhere in the 144-item proj.13 invoice pool**. There is nothing correct for the embedding layer to match them to.

## BEFORE → AFTER coverage

| | Matched | Total | Coverage |
|---|---:|---:|---:|
| **BEFORE** (current prod) | 106 | 281 | **37.7%** |
| **AFTER** (projected, every confident `cos ≥ 0.82` top-1 accepted) | 112 | 281 | **39.9%** |
| **Net projected gain** | **+6 rows** | | **+2.2 pp** |

> AFTER is an **upper bound** — it counts confident top-1 hits but does **not** certify they are the *correct* product. On inspection, several of those 6 are still wrong-family (see examples), so the *certified* gain is **near zero**.

## Twin accuracy (the "TRUST" number) — and why it is unreliable here

The brief's plan used the matcher's own picks on "twin" rows as built-in ground truth. **That premise does not hold on proj.13**, and the proof exposes why.

| Metric | Value |
|---|---:|
| Twins (catalogable empty rows with a matched twin, Dice ≥ 0.70) | **33** (only **14 distinct** spec products — heavily duplicated size-variants) |
| Twin-reproduction accuracy — **strict** (top-1 == twin's invoice item) | **2 / 33 = 6.1%** |
| Twin-reproduction accuracy — **family** (size-blind, same product family) | **5 / 33 = 15.2%** |
| Twin GT provenance | **0** learned_rule · **1** high-conf (≥0.85) · **32** low-conf (<0.85) LLM · **0 confirmed project-wide** |

**The twin ground truth is contaminated.** proj.13 has **zero operator-confirmed matches**; 32/33 twin GTs are 0.6–0.7-confidence LLM suggestions, and manual inspection shows several are flatly **wrong**:
- `Фланец плоский 1-50-16` (a steel flange) → matcher picked **"DEK multilayer Gr-Н 50-16-50 hose"** (a flexible hose).
- `Задвижка чугунная фланцевая` (cast-iron gate valve) → matcher picked **"Компенсатор DN50"** (an expansion compensator).
- `Кран спускной d15` (drain tap) → matcher picked **"Поршневой редукционный клапан PRV-L"** (a pressure-reducing valve).
- `Клапан запорный муфтовый` (shut-off valve) → matcher picked **"Шаровый кран ВР 1″ бабочка"** (a different valve type).

So "twin-reproduction accuracy" measures *agreement with a partly-wrong matcher*, not verified correctness. **A real эталон is required to certify correctness** — the self-contained ground truth the brief hoped for is not trustworthy on this project.

## Root cause (verified): the pool is missing the products

Does the proj.13 invoice pool actually **contain** each catalogable family the empty rows need?

| Catalogable family (empty rows need it) | In proj.13 invoice pool? |
|---|---|
| Фланец плоский (flange) — 7 empty rows | **NO** |
| Кран спускной (drain tap) — 8 empty rows | **NO** |
| Клапан запорный (shut-off valve) — 12 empty rows | **NO** |
| Фильтр магнитный (magnetic filter) | **NO** (pool has only 1 generic "косой фильтр") |
| Манометр · Сальник · Водомерный узел · Труба ВГП оцинк · Унитаз · Поддон · Огнетушитель | **NO** |
| Задвижка (gate valve) | yes — 1 item |

The 144-item pool is dominated by **pipe insulation** (Цилиндр базальтовый 12 + ROCKWOOL 11 + THERMAFLEX 10 = 33 items, ~23%), water meters (счётчик 8), compensators (6), and a thin scatter of valves — **not** the flanges, drain taps, shut-off valves, manometers, packing glands, water-meter assemblies, galvanized pipe, sanitaryware, or extinguishers the empty rows call for.

**Quantified:** of the 76 catalogable empty rows, **47 have NO same-family item in the pool**; only 29 have even a coincidental same-leading-word candidate (and several of those are spurious, e.g. "труба" *insulation* vs "труба" *pipe*). Cosines on the twin set cluster at **0.74–0.82**, *below* the genuine-product band (0.84–0.92 from the sanity check) — itself a signal the correct product is absent from the pool.

## 15 concrete examples (the gate)
`empty_spec_row | twin ground-truth (matcher's pick, conf) | semantic_top1 | cosine | correct?`

| # | empty_spec_row | twin GT (matcher pick, conf) | semantic_top1 | cos | correct? |
|--:|---|---|---|--:|:--:|
| 1 | Трубы чугунные канализационные безраструбные | Труба чуг SML Ду100 L=3м HBCX (0.9) | Труба чуг SML Ду100 L=3м HBCX | 0.833 | **YES (strict)** |
| 2 | Кран пожарный, комплект | КПК Пульс-01/2 (300х300) квартирный (0.7) | КПК Пульс-01/2 (300х300) квартирный | 0.831 | **YES (strict)** |
| 3 | Клапан пожарный угловой с датчиком положения | Клапан пожарный КПЧ-50-1 125гр (0.8) | Клапан пожарный КПК-50-1 чугун угол | 0.878 | family only (wrong sub-type) |
| 4 | Труба полипропиленовая ППР d110 | Труба PRADEX PE-Xa 20х2,8 (0.7) | Труба ПЭ100 SDR17 d-160х9,5 (12м) | 0.822 | family only (wrong pipe) |
| 5 | Клапан запорный муфтовый Ру=16кгс/см d15 | Шаровый кран ВР 1″ бабочка (0.6) | Клапан обр. двустворчатый 150 Ci | 0.817 | NO |
| 6 | Фильтр магнитный фланцевый Тдо150 ФМФ-80 | Фильтр механической очистки Косой ВР (0.7) | Клапан обр. двустворчатый 150 Ci | 0.793 | NO |
| 7 | Кран спускной d25 Ру=16кгс/см | Шаровый кран ВР 3/4″ бабочка (0.7) | Дюбель крюк двойной для труб D16-32 | 0.792 | NO |
| 8 | Трубы из «сшитого» полиэтилена | THERMAFLEX FRZ E-76 (0.8) | Труба ПЭ100 SDR17 d-160х9,5 (12м) | 0.792 | NO |
| 9 | Задвижка чугунная фланцевая с обрезиненным клином | Компенсатор DN50 Энергия-Аква (0.6) | Клапан пожарный КПК-50-1 чугун | 0.782 | NO |
| 10 | Фланец плоский 1-80-16 ст.20 | DEK multilayer Gr-Н 50-16-50 hose (0.6) | ROCKWOOL 80 к/ф1 20мм х 28мм | 0.781 | NO |
| 11 | Фильтр магнитный муфтовый Тдо150 Р=16 | Фильтр механической очистки Косой ВР (0.7) | Электропривод А.150/24 | 0.777 | NO |
| 12 | Кранспускной d15 | Поршневой редукционный клапан PRV-L (0.7) | Клапан обр. двустворчатый 150 Ci | 0.763 | NO |
| 13 | Фланец плоский 1-150-16 ст.20 | DEK multilayer Gr-Н 50-16-50 hose (0.6) | ROCKWOOL 80 к/ф1 20мм х 28мм | 0.758 | NO |
| 14 | Фланец плоский 1-50-16 ст.20 | DEK multilayer Gr-Н 50-16-50 hose (0.6) | Головка рукавная ГР-50 | 0.740 | NO |
| 15 | *(only 14 distinct twin spec products exist — the 33 twins are size-variant duplicates of these 14)* | | | | |

Note examples 6, 10, 11, 13, 14: the semantic top-1 lands on insulation / a check valve / an electric actuator / a fire hose head — because **no flange and no magnetic filter exist in the pool**. The model behaves correctly; the pool is empty of the answer.

## Contrast with proj.12 (1/301)

| | proj.12 "ЖК у БКК ОВ" | proj.13 "ЖК БКК ВК" |
|---|---|---|
| Empty population | ~74% custom-fab sheet-metal **ductwork** | catalogable **plumbing** (flanges, valves, taps, filters…) |
| Why semantic fails | product **does not exist anywhere** (fabricated to order) | product exists in the world but is **NOT in this project's invoices** |
| Ground truth available | owner **эталон XLSX** (57 analog rows) | only the matcher's own picks (**0 confirmed, partly wrong**) |
| Strict recovery measured | **1 / 301** | **2 / 33 twins** (and twin GT is unreliable) |
| Bottleneck | structural (no catalog product) | **data (missing invoice coverage)** + no эталon |

**proj.13 is genuinely the more *recoverable* target** (its empty rows are real off-the-shelf products, unlike proj.12's ductwork) — **but it is NOT recoverable today**, because (a) the matching invoices have not been uploaded for ~62% of the catalogable families, and (b) there is no эталon to certify correctness. proj.12's wall is permanent; proj.13's wall is "upload the right supplier invoices (and/or build a cross-project catalog) + get an эталon," then re-test.

## What WOULD move proj.13 coverage (next levers, in order)
1. **Upload the supplier invoices that actually contain the flanges / shut-off valves / drain taps / manometers / water-meter assemblies** (47 catalogable families currently have no pool candidate). Coverage is data-gated here.
2. **Cross-project catalog/memory**: pull these standard plumbing products from OTHER projects' history into a shared pool, then a semantic/catalog layer has real targets. (This is the proven Эталон→Память cross-project transfer lever.)
3. **Get an эталon for proj.13** so any future recovery can be *certified*, not just "confident."
4. Only **after** 1–3 does a semantic layer become worth deploying on this project.

## Caveats
- Engine = Mistral `mistral-embed` — directional, not necessarily the deploy model. Cosine sanity on real plumbing pairs = 0.84–0.92, neg control 0.71; the model itself separates products fine.
- Candidate pool = all **144** proj.13 invoice items (read-only GET). All 70 matcher-chosen items are inside this pool, so the pool is complete for this project.
- Confident-recovery count (`cos ≥ 0.82`) is a projected coverage **upper bound**, not certified correctness.
- Twin ground truth = the matcher's own pick; **contaminated** (0 confirmed, several wrong). Twin-accuracy is a *low, unreliable* bar — reported transparently, not as proof of correctness.
- Many catalogable empty rows are size-variants (Фланец 1-50/1-80/1-150); embeddings are largely size-blind, so even with the right product in pool, strict size-correct top-1 from spec text alone is hard (size lives on child/parent rows).

## Output files
- `backend/scripts/semantic_recovery_proof_proj13_2026-06-15.json` (full data + all 33 scored twins)
- `backend/scripts/semantic_recovery_proof_proj13_2026-06-15.md` (this file)
- Run script: `backend/scripts/semantic_recovery_proof_proj13_run.cjs` · Snapshots: `_proj13_matching_raw.json`, `_proj13_all_invoice_items.json`, `_proj13_invoices_list.json`
