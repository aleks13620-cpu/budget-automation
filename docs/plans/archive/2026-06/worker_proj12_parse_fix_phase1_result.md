# Worker result — Proj 12 «ЖК у БКК ОВ» spec parse quantity-loss: Phase 1 (diagnose + build + measure + gate)

**Date:** 2026-06-11 · **Worktree:** `C:/Users/home/vscode101/budget-automation-parser-fix` · **Branch:** `feat/spec-parse-quantity-fix` (base `origin/main` = 505e983) · **SAFE/local only — NOT deployed, NOT pushed.**

Cycle plan: `docs/plans/active/proj12_ov_parse_quantity_loss_diagnosis_and_fix_cycle_2026-06-11.md`.

---

## 1. ROOT CAUSE (code level)

### 1a. Why `parse_source = pdf_gigachat`
`pdf_gigachat` is **NOT a routing decision** — it is a static label stamped on ANY `.pdf` upload (`backend/src/routes/specifications.ts:114` and `:318`: `parseSource = 'pdf_gigachat'`). The real parse pipeline inside `parseSpecFromPdf` (`backend/src/services/gigachatSpecFromPdf.ts:576`) is:
1. **pdfplumber-first** (deterministic, `scripts/extract_pdf_table.py`).
2. Accept it **only if** `noPosFraction <= LOW_QUALITY_NOPOS_FRACTION` (0.5) — `gigachatSpecFromPdf.ts:673` (original).
3. Otherwise fall to **GigaChat** LLM (Files API) → **Gemini** fallback.

Proj 12's spec (`01_05-07-24-ОВ-37-59.pdf`) has the **«Поз.» column physically empty** in all data rows → the deterministic result has `noPosFraction = 100%` → it **failed the 0.5 acceptance gate** → routed to GigaChat. GigaChat, seeing integers where it expected a position number, put the **«Количество» value into `position`** and emitted `quantity = null`. That is the prod state (510/510 null, 392 pure-digit positions).

### 1b. Where the quantity column is lost (the deeper, shared bug)
The deterministic extractor `scripts/extract_pdf_table.py` **reproduces the identical defect** — so this is not GigaChat-specific. Mechanism (`detect_column_mapping`, `extract_pdf_table.py:112`):
- Column headers in this PDF are **soft-hyphen-wrapped** across lines: `"Поз."`, `"Коли-\nчество"`, `"Едини-\nца изме-\nрения"`. After `clean_cell` whitespace-collapse they read `"поз."`, `"коли- чество"`, `"едини- ца изме- рения"`.
- `HEADER_KEYWORDS['quantity'] = ['количест','кол-во','кол.']` — **none is a substring of `"коли- чество"`** (the `"- "` breaks the word). Likewise `'позици'` ∉ `"поз."`, `'единица'` ∉ `"едини- ца …"`.
- So the header yields **no position/quantity/unit column** → fallback `infer_mapping_from_data` (`:134`) kicks in. It looks for a column where >30% of values match `POS_RE = ^\d{1,3}\.?$` and **greedily labels the «Количество» column (small integers "3","132","31") as `position_number`** (`:164`). That column is then `used`, so quantity-detection finds no remaining all-numeric column → **`quantity = None`**.

**Both paths fail the same way: an empty «Поз.» + un-recognized hyphen-wrapped headers ⇒ the quantity integers are mistaken for position numbers.** The PDF is structurally clean (fitz/pdfplumber put col 4=Поз., col 5=name, col 16=unit, col 17=Количество on every page) — the parser's keyword list simply can't read wrapped headers. Proof of the keyword miss: `"коли- чество".includes("количест") === False`.

---

## 2. REPRODUCE (local, numbers)

| Source | items | quantity non-null | position pure-digit |
|---|---|---|---|
| **Prod API** `GET /specifications/20/items` | 510 | **0 (0%)** | 392 |
| **Current deterministic extractor** (`extract_pdf_table.py`, unmodified, on the PDF) | 516 | **0 (0%)** | 392 |

The current deterministic extractor mapped `position_number → col 17` (the quantity column) and produced **no quantity column at all** (header mapping had no `quantity` key). Spot values matched prod exactly: «Этажный распределительный узел» pos="3"/q=null, «Теплосчетчик поквартирный» pos="132"/q=null, «Радиатор … Compact» pos="31"/q=null. Defect reproduced on both paths.

---

## 3. BUILD (what changed) + routing-vs-fix recommendation

Four source files (109 insertions). Deterministic-first, no hardcoded supplier/column indices — columns detected by header text/coordinates.

1. **`scripts/extract_pdf_table.py`** — fix the header reader:
   - New `norm_header()` de-hyphenates wrapped headers before keyword match: `re.sub(r'-\s*','',cell)` → `"коли- чество"→"количество"`, `"едини- ца изме- рения"→"единица измерения"`, `"код обору- дования"→"код оборудования"`. Used in `detect_column_mapping` and `is_header_row`.
   - Added `'поз'` to `HEADER_KEYWORDS['position_number']` so the abbreviated «Поз.» header is recognized (maps to its real, empty column instead of letting data-inference steal the quantity column).
   - Result on proj 12: header now maps `position→col4, name→col5, unit→col16, quantity→col17` correctly.

2. **`backend/src/services/gigachatSpecParseQuality.ts`** — the corruption hard-gate (Deliverable 5, see §5).

3. **`backend/src/types/specification.ts`** — extend `SpecPdfParseQuality` with `nullQtyFraction`, `posAsQtyFraction`, `quantityColumnLost`.

4. **`backend/src/services/gigachatSpecFromPdf.ts`** — **the routing fix (this is the recommendation)**. Changed the pdfplumber acceptance gate (`:673`) from `noPosFraction <= 0.5` to:
   ```
   acceptable = bareOrphanFraction <= HARD_BLOCK_BARE_ORPHAN_FRACTION (0.5)
                && !quantityColumnLost
   ```
   Rationale: `noPosFraction` was the *wrong* signal — a flat spec with **no «Поз.» column** (proj 12) is not "broken hierarchy", it just lacks positions, yet the old gate rejected it and sent it to the corrupting LLM. The true "needs-LLM-for-hierarchy" signal is **bare-orphan fraction** (typesizes/codes orphaned from a parent). A flat list of self-sufficient names → low bareOrphan → **accept the deterministic result (with recovered quantities)**; a variant-family spec (Lastochka radiators: bare DN/code children) → high bareOrphan → still routed to LLM exactly as before.

### Recommendation: **ROUTE clean structured-table specs to the deterministic parser** (do both, but routing is primary).
- Evidence: the deterministic extractor, once it can read the headers, recovers **93% of quantities (478/516)** vs the LLM's **0%**; the remaining 7% are genuinely qty-less parent/section rows (verified — their qty lives on child rows). The LLM both costs an API call and is the source of the column-shift.
- Fixing GigaChat post-processing alone is insufficient: even with a perfect prompt, the LLM is non-deterministic and the deterministic path is strictly better for clean tables. So: **(a)** fix the Python header reader so the deterministic path succeeds, **(b)** fix the routing gate so the good deterministic result is *accepted* (not overridden by `noPosFraction`), **(c)** keep the LLM as fallback for genuinely broken-hierarchy specs, **(d)** hard-gate the corruption signature so if it ever recurs (either path) the data is blocked.

---

## 4. MEASURE (before/after — the proof)

**Quantity recovery: was 0/510, now 478/516 = 93%** (deterministic extractor on the actual PDF). `position pure-digit` went **392 → 0** (quantity no longer mis-mapped into position; col 4 «Поз.» is genuinely empty).

Spot-check (name → extracted qty / unit), incl. the orchestrator's named rows:

| Name (PDF) | extracted qty | unit |
|---|---|---|
| Теплосчетчик поквартирный | **132** ✓ | шт. |
| Этажный распределительный узел | **3** ✓ | шт. |
| Радиатор панельный Compact | **31** ✓ | шт. |
| Огнезащитная изоляция; EI 150 | 36.85 | м² |
| Воздуховод из оцинк. ст. | 1 | м |
| Переход со смещением | 3 | шт. |
| Тройник-90° | 2 | шт. |
| Отвод-90° | 6 | шт. |

**True item count vs prod 510:** the deterministic extractor yields **516 rows** pre-link. The 38 `quantity=null` rows are NOT data loss — they are section sub-headers («ОТОПЛЕНИЕ», «Система радиаторного отопления») and **parent rows whose quantity legitimately lives on child variant rows** (verified: «Трубы стальные водогазопроводные» parent qty empty; children «Ø15х2,8»=112, «Ø20х2,8»=106; «Неподвижная опора» children Ø15=4, Ø25=8). After the TS linker merges continuation/child rows, the effective unique-item count is comparable to 510; the dominant, critical change is quantities going from 0% → 93%.

> Note on DEFECT 2 (fragmentation): at the **pdfplumber level** multi-line cells are NOT fragmented — e.g. «Огнезащитная изоляция; EI 150; НГ; S=16мм» arrives as ONE cell with qty. The fragmentation the orchestrator saw («EI 150»/«S=16мм» as separate items) is a **GigaChat-path artifact**; the deterministic path does not produce it. (Minor downstream risk: the existing TS `splitMonsterRow` splits on `;` when ≥2 separators — that semicolon-joined name would be split into 4 in any path; flagged as SOFT, pre-existing, shared with working specs.)

---

## 5. GATE — corruption hard-gate (`no_corrupt_through`), BLOCKING

`backend/src/services/gigachatSpecParseQuality.ts:116-156`. New blocking signature `quantityColumnLost` folded into `hardBlock`:
```
quantityColumnLost =
   mappedItems.length >= HARD_BLOCK_MIN_ROWS (5)
   && nullQtyFraction  >= HARD_BLOCK_NULL_QTY_FRACTION (0.9)    // ~all qty null
   && posAsQtyFraction >= HARD_BLOCK_POS_AS_QTY_FRACTION (0.5)  // qty-shaped ints in position
hardBlock = (bareOrphan catastrophe) || quantityColumnLost
```
Requiring **both** signals (almost-all-null quantities **and** quantity-shaped integers dominating `position_number`) distinguishes the column-shift corruption from a legitimate spec where some parents are qty-less or positions are real integers.

**Blocking is already wired** (no new plumbing needed): both upload routes reject on `parseResult.specParseQuality?.hardBlock` BEFORE any DB insert — single-spec `specifications.ts:84` → HTTP 422; bulk `specifications.ts:334` → `status:'quality_block'`, `imported:0`. So corrupt data cannot flow into `specification_items` → matcher/training.

**Blocking proof** (`backend/test_qty_gate.ts`, 5/5 pass):
| dataset | nullQty | posAsQty | quantityColumnLost | hardBlock |
|---|---|---|---|---|
| Prod-corrupted spec 20 (510 rows) | 100% | 77% | **true** | **true (BLOCK)** |
| Fixed deterministic output (516 rows) | 7% | 0% | false | **false (PASS)** |
| Legit flat spec (real positions+qty) | 11% | 89% | false | false (PASS) |

The legit case (sequential integer positions 1-40 with real quantities) shows the gate does **not** false-positive on integer positions alone — it needs the all-null-quantity co-signal.

---

## 6. NON-REGRESSION

- **Spec-PDF hierarchy suite** `npm run test:spec-pdf` (`scripts/test-spec-parent-child.mjs`): **7/7 PASS** (radiator variants / DN children / То же / mixed / negatives) — linker untouched and unaffected.
- **HardBlock integration** `backend/test_bulk_spec_hardblock_integration.ts`: **all assertions PASS**, incl. "чистая спека → hardBlock=false" and "чистый файл imported=3" — the gate does not block clean specs; bulk batch survives a single bad file.
- **parser-ai-hierarchy** `scripts/test-parser-ai-hierarchy.mjs`: control `04_mixed` **PASS (no regression)**; hardBlock checks PASS. ("NEEDS REVIEW" only flags two Lastochka/Sokoliy PDFs missing at hardcoded `Downloads/` paths — not a code regression.)
- **Spec 228** (`228-42.3-ОВ_07.10.25.pdf`, 202 pp): OLD and NEW extractor both yield **0 items — IDENTICAL** (this drawing's table isn't pdfplumber-extractable → it would take the LLM path on prod on either version; my change is inert for it).
- **Lastochka proj 11 OV** (`5-ПР_21 – ОВ (1).pdf`, 200 pp, 137 candidate pages): full pdfplumber `extract_tables()` over this doc is prohibitively slow (>10 min — see SOFT blocker), so the full item-count diff was not obtained. Instead the **header-mapping change was verified directly to be INERT** for Lastochka: (a) on the one page that extracted (p3), OLD and NEW `detect_column_mapping` produce **identical** results `{name:5}`; (b) via fast fitz text read of the first 20 spec pages, Lastochka's header tokens are «Наименование»/«Примечание» with **no «Поз.»/«Количество» tokens that the new `'поз'` keyword or `norm_header` de-hyphenation would newly match** (0 CHANGED lines). ⇒ my header changes do not alter Lastochka's column detection; its parse (bareOrphan-heavy variant families → routed to LLM hierarchy anchor) is unchanged. **No regression.**
- **Build:** `tsc` (full `npm run build`) green, EXITCODE 0.

Local data note: the Sokoliy ВК spec referenced by the ai-hierarchy test is not present locally under that name; Lastochka spec present in `data/uploads`.

---

## 7. BLOCKERS

- **[HARD]** Restoring proj 12 on prod requires a re-parse/re-upload of spec 20 with the new code → **deploy-gated** (Phase 3, owner "ok"). This worker did NOT deploy/push. Pre-check before Phase 3: does proj 12 have confirmed matches? If none (fresh) → safe re-upload; if any → in-place only (per re-split history lesson).
- **[HARD]** Phase 2 gate (rule 2026-06-11) before deploy: run `pre-deploy-check` skill → must be PASS, plus the before/after proof (this doc).
- **[SOFT]** `splitMonsterRow` semicolon-splitting of long composite names (e.g. «Огнезащитная …; EI 150; НГ; S=16мм») is pre-existing TS behavior shared with all paths — not introduced here, but worth a follow-up review.
- **[SOFT]** Large specs (200+ pp) make pdfplumber slow (tens of seconds–minutes); the 60s `execFileAsync` timeout in `gigachatSpecFromPdf.ts:613` may trip on such files → they'd fall to LLM. Not a correctness regression, but a perf note for big drawings.

---

## 8. Deliverables

- **result.md:** `docs/plans/active/worker_proj12_parse_fix_phase1_result.md` (this file)
- **Worktree:** `C:/Users/home/vscode101/budget-automation-parser-fix` · **Branch:** `feat/spec-parse-quantity-fix`
- **Changed (4):** `scripts/extract_pdf_table.py`, `backend/src/services/gigachatSpecFromPdf.ts`, `backend/src/services/gigachatSpecParseQuality.ts`, `backend/src/types/specification.ts`
- **New test:** `backend/test_qty_gate.ts` (5/5 gate proof)
- Changes are committed on the branch; **not pushed, not deployed.**
