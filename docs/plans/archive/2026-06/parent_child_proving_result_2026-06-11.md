# Parent-Child Lever Proving: Proj.12 "ЖК у БКК ОВ" — Result 2026-06-11

## Verdict: NO-GO (for proj.12 specifically)

Parent-name restoration gives **ZERO lift** on the 12 bare orphans in proj.12.
The dominant gap is **COVERAGE** (invoices simply do not contain those products),
not a parse defect. The parse defect IS real but does not explain the match failure.

---

## Method Used

**Lightweight offline simulation** (not a full replay-matching run):

1. Fetched data via prod read-only GETs:
   - `GET /api/specifications/24/items` → 510 spec items
   - `GET /api/projects/12/matching` → 510 items with match proposals
   - `GET /api/invoices/{id}` × 8 → 224 invoice items total

2. Identified bare orphans: items where `name` is a bare diameter/size (`Ø15`, `Ø25х3,2`, etc.), `full_name = null`, `matches = 0`.

3. Simulated name_similarity scoring using `string-similarity` (the actual library from `backend/node_modules/string-similarity`) with the same normalization logic as `normalizeForMatching` (simplified but equivalent for the Dice coefficient comparison).

4. Applied BEFORE (bare name) and AFTER (restored composite name) and recorded best match score vs the 224 invoice items.

5. Checked whether matching product types exist anywhere in the 224 invoice items.

Commands run:
```
GET http://5.42.103.63:3001/api/specifications/24/items
GET http://5.42.103.63:3001/api/projects/12/matching
GET http://5.42.103.63:3001/api/projects/12/invoices
GET http://5.42.103.63:3001/api/invoices/71    (Теплый дом, 74 items)
GET http://5.42.103.63:3001/api/invoices/68    (НЗВЗ Волгопромвентиляция, 104 items)
GET http://5.42.103.63:3001/api/invoices/70,69,67,66,64,65  (46 items total)
node /tmp/sim_nobom.cjs   (similarity simulation)
```

---

## Orphan Set (exact 12 true bare orphans)

All have `position_number = null`, `full_name = null`, `matches = 0`.

**Cluster 1 — ОСТ 36-146-88 (Сильфонный компенсатор осевой)**

| id   | name  | chars          | parent inferred from       |
|------|-------|----------------|----------------------------|
| 5126 | Ø15   | ОСТ 36-146-88  | sibling 5131 full_name     |
| 5127 | Ø25   | ОСТ 36-146-88  | sibling 5131 full_name     |
| 5128 | Ø40   | ОСТ 36-146-88  | sibling 5131 full_name     |
| 5129 | Ø65   | ОСТ 36-146-88  | sibling 5131 full_name     |
| 5130 | Ø80   | ОСТ 36-146-88  | sibling 5131 full_name     |
| 5131 | Ø100  | ОСТ 36-146-88  | HAS full_name via LLM hint |

Sibling 5131.full_name = "Ø100 Сильфонный компенсатор осевой, с внутр. гильзой и наружным кожухом"
→ Restored parent = "Сильфонный компенсатор осевой"

**Cluster 2 — ГОСТ 3262-75* + ГОСТ 10704-91 (Гильзы из труб стальных)**

| id   | name      | chars           | parent inferred from       |
|------|-----------|-----------------|----------------------------|
| 5159 | Ø25х3,2   | ГОСТ 3262-75*   | sibling 5158 full_name     |
| 5160 | Ø32x3,2   | ГОСТ 3262-75*   | sibling 5158 full_name     |
| 5162 | Ø57х3,0   | ГОСТ 10704-91   | sibling 5161 full_name     |
| 5163 | Ø76х3,0   | ГОСТ 10704-91   | sibling 5161 full_name     |
| 5164 | Ø89х3,5   | ГОСТ 10704-91   | sibling 5161 full_name     |
| 5165 | Ø108х4,0  | ГОСТ 10704-91   | sibling 5161 full_name     |
| 5166 | Ø133х4,0  | ГОСТ 10704-91   | sibling 5161 full_name     |

Sibling 5161.full_name = "Ø40x3,5 Гильзы из труб стальных электросварных"
Sibling 5158.full_name = "- краска ПФ-115 Гильзы из труб стальных водогазопроводных" (mangled concat)

Note: item 5161 is itself unmatched (0 proposals), making it part of the same coverage gap.

---

## BEFORE → AFTER (AI-OFF, name_similarity tier)

**Method**: Dice coefficient (string-similarity library) with normalized names (Ø→dn, strip punctuation, stop words). Threshold = 0.6 (matcher default for items without equipment_code).

| id   | Before bare name | Before score | After restored name                                          | After score | Verdict |
|------|-----------------|--------------|--------------------------------------------------------------|-------------|---------|
| 5126 | Ø15             | 0.080 FAIL   | Сильфонный компенсатор осевой dn15 ОСТ 36-146-88            | 0.359 FAIL  | NO-GO   |
| 5127 | Ø25             | 0.083 FAIL   | Сильфонный компенсатор осевой dn25 ОСТ 36-146-88            | 0.359 FAIL  | NO-GO   |
| 5128 | Ø40             | 0.105 FAIL   | Сильфонный компенсатор осевой dn40 ОСТ 36-146-88            | 0.333 FAIL  | NO-GO   |
| 5129 | Ø65             | 0.050 FAIL   | Сильфонный компенсатор осевой dn65 ОСТ 36-146-88            | 0.333 FAIL  | NO-GO   |
| 5130 | Ø80             | 0.111 FAIL   | Сильфонный компенсатор осевой dn80 ОСТ 36-146-88            | 0.333 FAIL  | NO-GO   |
| 5159 | Ø25х3,2         | 0.074 FAIL   | Гильзы из труб стальных водогазопроводных dn25х3 2 ГОСТ     | 0.178 FAIL  | NO-GO   |
| 5160 | Ø32x3,2         | 0.073 FAIL   | Гильзы из труб стальных водогазопроводных dn32x3 2 ГОСТ     | 0.163 FAIL  | NO-GO   |
| 5162 | Ø57х3,0         | 0.143 FAIL   | Гильзы из труб стальных электросварных dn57х3 0 ГОСТ 10704  | 0.177 FAIL  | NO-GO   |
| 5163 | Ø76х3,0         | 0.143 FAIL   | Гильзы из труб стальных электросварных dn76х3 0 ГОСТ 10704  | 0.177 FAIL  | NO-GO   |
| 5164 | Ø89х3,5         | 0.089 FAIL   | Гильзы из труб стальных электросварных dn89х3 5 ГОСТ 10704  | 0.177 FAIL  | NO-GO   |
| 5165 | Ø108х4,0        | 0.129 FAIL   | Гильзы из труб стальных электросварных dn108х4 0 ГОСТ 10704 | 0.175 FAIL  | NO-GO   |
| 5166 | Ø133х4,0        | 0.129 FAIL   | Гильзы из труб стальных электросварных dn133х4 0 ГОСТ 10704 | 0.175 FAIL  | NO-GO   |

**BEFORE AI-OFF: 0/12 pass. AFTER AI-OFF: 0/12 pass. Lift = 0.**

AI-ON not tested (no OpenRouter key in env), but see classification below for why LLM wouldn't help either.

---

## Coverage Numbers (full proj.12)

- Total spec items: 510
- Matched (has at least 1 proposal): 200 (39.2%)
- Unmatched (0 proposals): 310 (60.8%)

Match type distribution on matched items:
- llm_suggestion: 189 (94.5%)
- name_similarity: 5 (2.5%)
- name_characteristics: 5 (2.5%)
- learned_rule: 1 (0.5%)

**The 310 unmatched breakdown by root cause:**

| Category | Count | Root cause |
|----------|-------|-----------|
| Air ducts & fittings (воздуховод, отвод, тройник, заглушка, переход, врезка) | 211 | COVERAGE GAP: no duct supplier invoice in project |
| Fire insulation specs (EI/S=mm/Огнезащитная изоляция) | 27 | COVERAGE GAP: no insulation supplier invoice |
| Metal for mounting (Металл для крепления) | 18 | COVERAGE GAP: no materials invoice |
| Bare orphans (ОСТ compensators + ГОСТ pipe sleeves) | 13 | COVERAGE GAP: products absent from invoices |
| Compound items (Вентиляционная установка) | 3 | Complex multi-line items |
| Other (сетка, кожух, fireproof valves, paint, etc.) | 38 | Mixed: some coverage gap, some semantic |
| **Total** | **310** | |

**The dominant problem (211/310 = 68%) is air duct items with ZERO matching invoice items.** Invoice 68 (Волгопромвентиляция, 104 items) contains fans, valves, grilles — NOT duct sheets/fittings. The spec lists ~210 individual duct segments by size that were supplied custom-fabricated (or by a separate supplier whose invoice is not yet uploaded).

---

## Residual Classification: Bare Orphans (all 12 = SEMANTIC-GAP / COVERAGE)

**Cluster 1 (5126-5130, ОСТ 36-146-88, Сильфонный компенсатор осевой):**
- Invoice 71 (Теплый дом) has AYVAZ compensators DN20/25/50/65/80/100 (matched to sibling group 5132-5137)
- AYVAZ vs ОСТ 36-146-88 are DIFFERENT product standards: AYVAZ = imported brand (corrugated metal bellows), ОСТ 36-146-88 = Russian standard for axial pipe compensators with inner sleeve
- LLM correctly matched siblings 5132-5137 to AYVAZ but withheld match for 5126-5131 because the ОСТ standard signals a different product class
- Classification: **SEMANTIC-GAP** — restoring the parent name would correctly name the product, but the product is not in any invoice. This is a procurement gap (different brand/standard not yet quoted).

**Cluster 2 (5159-5166, ГОСТ pipe sleeves):**
- Invoice search for "гильз" (sleeves): **0 results** in all 224 invoice items
- These are steel pipe sleeves (watergas/electrowelded) used as pass-through sleeves in floor/wall penetrations — NOT in any invoice
- Classification: **COVERAGE GAP** — product type completely absent from invoices. Not a parse defect. The supplier for sleeves has not submitted an invoice.

---

## Why the Parse Defect Still Exists (but doesn't matter here)

The parser DOES have a real defect for cluster 1: items 5126-5130 (`Ø15`..`Ø80`) fall to the "Standalone item" branch in `linkPdfParentChildren` because:
- `isDnChild` requires `DN/Ду/Дн` prefix (not `Ø`): `DN_CHILD_PATTERN = /^(DN|Ду|Дн|d=|D=|du)\s*\d{2,}/`
- `PARAMETER_CHILD_PATTERN` matches `Ø` but only fires inside the `Parameterized child` block which requires `position_number !== null`
- So `Ø15` (no position_number) hits NONE of the child branches → becomes a new parent, resetting `lastParentIndex`

Item 5131 got `full_name` only because the LLM-anchor hint mechanism fired for that one item specifically.

This is a fixable parse defect, but the fix provides zero matching benefit on proj.12 because the product is absent from invoices.

---

## Minimal Parser Fix Sketch (NOT committed)

**File**: `backend/src/services/gigachatSpecFromPdf.ts`

The fix adds a new child-detection branch for `Ø`-prefixed items (Ø15, Ø25, Ø40…) when they lack a position_number. Currently `DN_CHILD_PATTERN` misses the `Ø` prefix:

```diff
 // DN child
 if (isDnChild(item.name, item.position_number)) {
   if (lastParentIndex !== null) {
     item._parentIndex = lastParentIndex;
     item.full_name = `${accumulatedName} ${item.name}`.trim();
   } else {
     item._parentIndex = null;
     item.full_name = null;
   }
   continue;
 }
+
+// Parameterized child without position_number (catches Ø-prefixed size-only rows)
+// isParameterizedChild already matches Ø via PARAMETER_CHILD_PATTERN
+if (
+  lastParentIndex !== null &&
+  item.position_number === null &&
+  isParameterizedChild(item.name)
+) {
+  item._parentIndex = lastParentIndex;
+  item.full_name = `${accumulatedName} ${item.name}`.trim();
+  continue;
+}
```

**Location**: `gigachatSpecFromPdf.ts` lines ~388-411 (between the `isDnChild` block and the `Parameterized child with matching position` block).

**Safety**: `isParameterizedChild` has a length check (`> 25 chars → false`) and pattern guard. The change only fires when `lastParentIndex !== null`, so standalone short-code items without a preceding parent are unaffected. Existing proj.11 radiators are NOT affected (they use the `Parameterized child with matching position` branch via position_number matching).

**NOTE**: This fix is valid for future specs but does NOT recover proj.12 items 5126-5130 (those need re-parsing, and the products are absent from invoices anyway).

---

## Proj.12 PDF Location

**Server-side only**: file stored at `../data/uploads/` relative to backend container (configured via `UPLOAD_PATH` env var). The spec file_name in DB = "Ïðîåêò 01_05-07-24-ÎÂ-37-59.pdf" (garbled encoding, actual name likely "Проект 01_05-07-24-ОВ-37-59.pdf"). No read-only download endpoint exists for spec PDFs. **Not accessible offline.**

---

## Tripwire Check: Proj.11 Radiator Lever

Not replayed (no temp DB spun up). The parse fix sketch is additive — it adds a NEW branch before the "Standalone item" fallback. The proj.11 radiator lever used a different mechanism (`Parameterized child with matching position` branch, which requires `position_number !== null` and position match). The proposed change does NOT touch that branch. Safe.

The parser-fix worktree (`budget-automation-parser-fix`, commit `41a097c`) is at `SPEC_PDF_PARSER_VERSION = 6`. The proposed fix would require a version bump to 7 if deployed.

---

## GO / NO-GO Recommendation

**NO-GO for proj.12 parser cycle** based on this lever test.

Rationale:
1. **Zero lift on the 12 bare orphans**: BEFORE=0/12, AFTER=0/12 AI-OFF. The products are absent from invoices.
2. **Root cause of 310 unmatched is COVERAGE (68%)**: 211 air duct items need a missing duct fabricator invoice. Fix is to upload the missing invoice, not fix the parser.
3. **The parse defect is real but inconsequential for matching**: 5126-5130 have no invoice to match against. Even with perfect names, 0 matches.
4. **12 bare orphans = 2.4% of 510 items**: Even if 100% matched (impossible), the impact is marginal vs the 211-item duct gap.

**When would a parser cycle be justified for proj.12?**
After the missing duct fabrication invoice is uploaded (eliminating the 211-item gap), then test whether the remaining gaps have a name-quality component. At that point, the lever may actually pay off.

**General parser fix**: The `Ø`-child detection fix IS worth doing as a general correctness improvement (it will correctly propagate parent names in future specs), just not as a targeted proj.12 matcher improvement.

---

## Comparison with Proj.11 Radiator Lever

Proj.11 lever proved: durable 1% → 74% (radiators). That worked because:
- The invoice DID contain the matching products (Royal Thermo radiators)
- The parent name ("Радиатор панельный Ventil Compact") was missing from child items
- Restoring it made the Dice similarity cross the 0.6 threshold

Proj.12 parallel is NOT analogous because invoices are missing the products entirely. The diagnostic from commit `16ac5b1` ("semantic gap dominant, not parsing") is confirmed by this experiment: for the 13 bare-orphan items specifically, the gap is coverage/semantic, not parser quality.
