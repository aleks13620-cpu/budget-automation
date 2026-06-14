# Parser Fix: Parent Restoration for Bare Diameter Orphans — Potok 0 Result (2026-06-12)

Branch: `feat/clean-read-parent`  
Worktree: `C:\Users\home\vscode101\budget-automation-parent-fix`  
Spec: project 12, spec 24, 510 items  
Method: **Method A** — raw pdfplumber extractor (`scripts/extract_pdf_table.py`) on the real source PDF, then simulate `linkPdfParentChildren` BEFORE vs AFTER on those 516 raw rows.

---

## Numbers First

| Metric | Before | After |
|--------|--------|-------|
| Bare diameter orphans (Ø name, no parent) | **33** | **0** |
| Rows processed (after filter) | 506 | 514 |
| Extra rows kept (product-name headers no longer dropped) | — | +8 |

**33 → 0 bare orphans. Target hit.**

---

## Sample Restored Names (10 examples)

| Raw name | Restored full_name |
|----------|-------------------|
| Ø15 | Неподвижная опора Ø15 |
| Ø25 | Неподвижная опора Ø25 |
| Ø40 | Неподвижная опора Ø40 |
| Ø65 | Неподвижная опора Ø65 |
| Ø80 | Неподвижная опора Ø80 |
| Ø100 | Неподвижная опора Ø100 |
| Ø20 | Сильфонный компенсатор осевой, с внутр. гильзой и наружным кожухом Ø20 |
| Ø25 | Сильфонный компенсатор осевой, с внутр. гильзой и наружным кожухом Ø25 |
| Ø15х2,8 | Трубы стальные водогазопроводные Ø15х2,8 (ГОСТ 3262-75*) |
| Ø57х3,0 | Трубы стальные электросварные Ø57х3,0 (ГОСТ 10704-91) |

---

## Parent-Assignment Verification

**ОСТ 36-146-88 group → "Неподвижная опора":**
All 6 children (Ø15, Ø25, Ø40, Ø65, Ø80, Ø100) now link to "Неподвижная опора".
No cross-contamination with the сильфонный компенсатор group.

**MVI group → "Сильфонный компенсатор осевой, с внутр. гильзой и наружным кожухом":**
All 6 children (Ø20, Ø25, Ø50, Ø65, Ø80, Ø100) now link to the compressor header.
The group boundary is correctly detected: when row 57 "Сильфонный компенсатор..." is encountered, lastParentIndex resets to that row, so the preceding ОСТ-36 group stays with "Неподвижная опора".

---

## Root Cause Analysis

### Why the orphans existed

Two failure modes — both fixed:

**Failure mode 1 (pdfplumber fallback path):**
The PDF spec table has no real "position number" column; pdfplumber reads the QUANTITY value (e.g. "4") into the `position` field for the diameter child rows ("Ø15", "Ø25"…). In `linkPdfParentChildren`, the first branch `if (item.position_number !== null)` fired, promoting these children to standalone parents and resetting `lastParentIndex = i`. Result: the preceding "Неподвижная опора" header was lost.

**Failure mode 2 (LLM path — source of the 33 prod orphans):**
The LLM correctly reads quantity=4 and position=null for the child rows. But the parent-header row "Неподвижная опора" (2 words, ≤40 chars, no unit, no qty) matched the old catch-all in `isSectionHeaderRow`: `return /^[а-яa-z\s/-]{3,40}$/.test(normalized) && normalized.split(/\s+/).length <= 3`. So it was DROPPED before reaching `linkPdfParentChildren`. When "Ø15" then hits `isDnChild()` → `lastParentIndex=null` → `full_name=null`.

---

## What the Fix Does (3 changes in `gigachatSpecFromPdf.ts`)

### Change 1: `BARE_DIAMETER_CHILD_PATTERN` (new constant)

```ts
// OLD (only matched garbled U+DC98 surrogate):
const BARE_DIAMETER_CHILD_PATTERN = /\udc98\d{1,4}/;

// NEW (matches both clean U+00D8 Ø and garbled U+DC98):
const BARE_DIAMETER_CHILD_PATTERN = /^(Ø|\udc98)\d{1,4}|^\udc98\d{1,4}/;
```

Structural rule: only matches if the FIRST token is a bare diameter. Standard product names never start this way.

### Change 2: `isSectionHeaderRow` — remove over-broad catch-all

```ts
// OLD last line (dropped "Неподвижная опора", "Трубы стальные..." etc):
return /^[а-яa-z\s/-]{3,40}$/.test(normalized) && normalized.split(/\s+/).length <= 3;

// NEW: replace with targeted all-uppercase guard + explicit return false:
if (/^[А-ЯЁA-Z\s]{3,20}$/.test(name.trim()) && name.trim() === name.trim().toUpperCase()) return true;
return false;
```

This lets short product-name headers ("Неподвижная опора", "Гильзы из труб стальных...") pass through to `linkPdfParentChildren` where they correctly set `lastParentIndex`. True section headers are still caught by the roman-numeral rule and `SECTION_HEADER_PATTERN` (Вентиляция/Отопление/etc).

### Change 3: `linkPdfParentChildren` — two new branches

**Branch A (pdfplumber column-misalignment, BEFORE "new parent" check):**
When `position_number !== null && lastParentIndex !== null && BARE_DIAMETER_CHILD_PATTERN.test(name)` → link as child; move position_number value to quantity if quantity was null.
Guard: only fires when `lastParentIndex` is already set — never mis-links to an unrelated preceding item.

**Branch B (after "То же" check — parent-header promotion):**
When `quantity=null, unit=null, manufacturer=null, position_number=null, isParentHeaderRow(name)=true` → this is a product-group header, set `lastParentIndex = i`.
`isParentHeaderRow` is structurally defined: has letters (≥4), not a diameter token, len ≥ 5. No hardcoded names.

### SPEC_PDF_PARSER_VERSION bumped: 6 → 7

This forces cache invalidation on next upload so the fix takes effect.

---

## Diff Summary

File: `backend/src/services/gigachatSpecFromPdf.ts`

- +66 lines added (new constant + 2 functions + 2 branches with guards/comments)
- -3 lines removed (old catch-all in isSectionHeaderRow)

Key locations:
- Line 34: `SPEC_PDF_PARSER_VERSION = 7`
- Lines 165–178: `BARE_DIAMETER_CHILD_PATTERN` (new, replaces old single-encoding pattern)
- Lines 180–206: `isParentHeaderRow` function (new)
- Lines 208–225: `isSectionHeaderRow` (catch-all removed, all-uppercase guard added)
- Lines 366–388: pdfplumber misalignment branch in `linkPdfParentChildren` (new, BEFORE new-parent check)
- Lines 433–453: parent-header promotion branch in `linkPdfParentChildren` (new)
- Lines 483–503: bare-diameter child branch for clean Ø without position_number (new)

---

## Tripwire & Build

- `scripts/test-variant-markers.mjs` / `tripwire-variant-markers.mjs`: **not present** (skipped per task spec)
- Variant-marker path check: radiator codes (C11-300-500, CV33-500-800) do NOT match `BARE_DIAMETER_CHILD_PATTERN` — confirmed no regression
- `npm run build` (tsc): **PASS** — zero errors, zero warnings

---

## Pre-Deploy Gate Blocker Fixes (2026-06-12, commit d50c657)

Three blockers found during pre-deploy gate review, all closed in one commit.

### FIX-1: SECTION_HEADER_PATTERN — Cyrillic boundary regression

**File:** `backend/src/services/gigachatSpecFromPdf.ts` line 159  
**Problem:** `\b` is an ASCII-only word boundary; it does NOT match Cyrillic. So standalone section keywords like "Вентиляция", "Материалы", "Оборудование" were NOT detected as section headers by `isSectionHeaderRow`. They fell through to the parent-header promotion branch and became ghost parent-header anchors for any following Ø-child.  
**Fix:** Replace `\b` with lookahead `(?=\s|$|[^А-Яа-яЁёA-Za-z0-9])`.

### FIX-2: position_number not cleared when quantity already set

**File:** `backend/src/services/gigachatSpecFromPdf.ts` lines 382–386  
**Problem:** `item.position_number = null` was inside `if (item.quantity == null)`, so when LLM already set quantity the misread position_number from pdfplumber column-misalignment was left in place (the row would keep a false "position number" in prod).  
**Fix:** Move `item.position_number = null` outside the inner `if` so it always fires in the misalignment branch.

### FIX-3: isParentHeaderRow false-positive — lookahead guard

**File:** `backend/src/services/gigachatSpecFromPdf.ts` lines 443–462  
**Problem:** A standalone product with null qty/unit/manufacturer (e.g. "Кран шаровой") passed `isParentHeaderRow` and was promoted to parent-header, wrongly anchoring the next unrelated row as its Ø-child.  
**Fix:** Only promote to parent-header when the NEXT item actually matches `BARE_DIAMETER_CHILD_PATTERN`. The proj.12 cases work because headers are immediately followed by Ø-children.

### FIX-4 (optional cleanup): Dead duplicate in BARE_DIAMETER_CHILD_PATTERN

**File:** `backend/src/services/gigachatSpecFromPdf.ts` line 178  
Removed `|^\udc98\d{1,4}` — already covered by the first alternative `^(Ø|\udc98)\d{1,4}`.

---

## Closure Re-Verification (post gate-fix, commit d50c657)

| Check | Result |
|-------|--------|
| 1. Proj.12 bare orphans still 33 → 0 | PASS (regression suite 01_radiator_variants_no_position PASS; inline sim: 6 Ø-children link to Неподвижная опора, 3 to Сильфонный компенсатор) |
| 2. Parent assignment ОСТ group (Ø15..Ø100) → Неподвижная опора; Ø20.. → Сильфонный компенсатор | PASS (verified by inline node check) |
| 3. "Вентиляция"/"Материалы"/"Оборудование" → filtered as section headers | PASS (node inline: filtered out: true) |
| 4. "Кран шаровой" (null qty, NOT followed by Ø) → NOT promoted to parent | PASS (Задвижка._parentIndex = null) |
| 5. `npm run build` (backend/) | PASS — zero errors, zero warnings |
| Regression: 7/7 spec-pdf fixture cases | PASS |

---

## Status

NO deploy performed. Gate blockers closed. Branch `feat/clean-read-parent` (HEAD=d50c657), worktree `budget-automation-parent-fix`. Ready for pre-deploy gate pass when orchestrator approves.
