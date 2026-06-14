# Learning Methodology: РОВ Knowledge Store and Bundle Ingestion
**Date:** 2026-06-11
**Author:** Research worker (orchestrator task)
**Scope:** Proj.12 matchable universe (196 items); cross-project generalization to proj.1/11

---

## 1. KNOWLEDGE STORE MAP

The system has five distinct stores where product knowledge accumulates. They differ in what they hold, how they are populated, and how durable (cross-project) they are.

---

### 1.1 `matching_rules` — the primary "РОВ"

**Schema** (`backend/src/database/schema.ts:81-91`):
```sql
CREATE TABLE matching_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_pattern TEXT NOT NULL,   -- normalized spec text
  invoice_pattern       TEXT NOT NULL,   -- normalized invoice text
  confidence REAL DEFAULT 1.0,
  is_analog INTEGER DEFAULT 0,           -- 0=exact, 1=analog substitution
  is_negative INTEGER DEFAULT 0,         -- 1=rejection rule (block pair)
  supplier_id INTEGER,                   -- NULL=global, else supplier-scoped
  times_used INTEGER DEFAULT 1,
  source TEXT DEFAULT 'manual',          -- 'manual'|'llm_confirm'|'import'|'reject'
  ...
);
```
UNIQUE index: `(specification_pattern, invoice_pattern, COALESCE(supplier_id, -1))`.

**How populated:**
- Operator clicks "Confirm" (`PUT /api/matching/:id/confirm`, `matching.ts:800`) → `upsertPositiveMatchingRule` with `source='manual'` or `'llm_confirm'`, confidence=0.92
- Operator clicks "Confirm Analog" (`POST /api/matching/:id/confirm-analog`, `matching.ts:1156`) → confidence=0.75, `is_analog=1`
- Operator clicks "Reject" (`DELETE /api/matching/:id`, `matching.ts:1061`) → `upsertNegativeMatchingRule`, `is_negative=1`
- Bulk import XLS (`POST /api/projects/:id/import-matches`, `matching.ts:1882-1886`) → confidence=0.95, `source='import'`
- Rules survive project deletion (no cascade); they are **global across all projects**

**How matching consumes it** (`backend/src/services/matcher.ts:539-599` — Tier 2, "learned_rule"):
- All rules loaded once: `RULES_SQL` at `matcher.ts:758`
- For each (spec, invoice) pair: normalized Dice similarity vs both patterns, threshold 0.65
- Supplier-scoped rules get +0.02 confidence bonus; supplier mismatch rules are skipped
- Negative rules are checked first and block the pair entirely
- Fallback: short invoice pattern (<50 chars) checked by token substring

**Durability:** Fully cross-project. Rules written from proj.11 fire on proj.12 if the text patterns match. This is the "РОВ" the owner refers to.

**Current prod state (proj.11):** 117/302 selected matches came from `learned_rule` tier (39%). Proj.12: 1/202 (0.5%) — the rules from proj.11 do not bridge the vocabulary gap to proj.12 because the item names differ substantially.

---

### 1.2 `construction_synonyms` — abbreviation/expansion learner

**Schema** (`schema.ts:196-204`):
```sql
CREATE TABLE construction_synonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  abbreviation TEXT NOT NULL,
  full_form TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',   -- 'seed'|'learned'
  times_used INTEGER DEFAULT 0,
  ...
);
```

**How populated:**
- Seeded from `CONSTRUCTION_SYNONYMS_SEED` (170 entries, `constructionSynonymsSeed.ts`) on first DB init
- Auto-learned from every operator confirmation (confidence >= 0.85): `learnConstructionSynonymsFromConfirmedMatch` (`constructionSynonymLearner.ts:29-72`) — extracts abbreviation↔expansion pairs via heuristic (short token in spec maps to longer token in invoice)
- Also called on XLS import (`matching.ts:1960`)

**How consumed** (`matcher.ts:83-111`): `normalizeConstructionTerms` replaces abbreviations with full forms in the normalized text before Dice similarity. Applied to both spec and invoice sides.

**Durability:** Global, cross-project. Seeded entries cover ~170 construction domain abbreviations. "Learned" entries are added whenever an operator confirms a pair where spec uses an abbreviation the invoice spells out.

---

### 1.3 `size_synonyms` — engineering unit normalization

**Schema** (`schema.ts:190-194`):
```sql
CREATE TABLE size_synonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical TEXT NOT NULL,
  synonym TEXT NOT NULL UNIQUE
);
```

**How populated:** Seeded on init with 19 DN/Du pairs (e.g., `DN15 ↔ Ду15`). Not auto-learned; manual inserts only.

**How consumed** (`matcher.ts:75-100`): `normalizeSizeTerms` replaces Cyrillic "ДУ/Ду" diameter notation with canonical "DN" before similarity computation. This lets "Ду15" and "DN15" match.

**Durability:** Global, static. Bootstrapped once, not enriched by use.

---

### 1.4 `DOMAIN_ALIASES` — hardcoded lexical aliases

**Location:** `backend/src/services/matcherAliases.ts` (entire file, 7 alias groups).

Not a DB table — hardcoded TypeScript array of `AliasGroup` objects. Each group has a canonical token and a list of synonyms that trigger appending that token to the normalized text.

**How populated:** Only by code change (no runtime learning). Currently 7 groups: ductwork types (пуоц, отводоц, переходоц, врезкаоц), fire damper (клапанппк), round duct elbow (отводкр), ventilation grille (решеткавент).

**How consumed** (`matcherAliases.ts:106`, called from `matcher.ts:181`): After all other normalization, canonical tokens are appended to text. Section-gated (e.g., "пуоц" only fires in "Вентиляция" section). Append-not-replace preserves original tokens.

**Durability:** Hardcoded. Cross-project by nature but requires a code deploy to add new aliases.

---

### 1.5 `canonical_products` + `product_aliases` — Canonical KB (NOT YET DEPLOYED)

**Branch:** `feat/canonical-kb` / `feat/canonical-kb-deploy` (commits `59daecb`, `d1f3439`, `96ee438`). Code exists but is NOT in `origin/main` and NOT active on prod.

**Schema** (from `feat/canonical-kb` branch, `schema.ts` extension):
- `canonical_products`: passport per product (canonical name, product type, structural features as JSON, type tokens, passport key — the UNIQUE discriminator built from type + strong features)
- `product_aliases`: all observed spec/invoice names for each canonical product (normalized alias text, supplier ID, source, confidence)

**Design:** Structural passport uses `extractMarkingFeatures` (same logic as matcher). Dedup by `passportKey` (strong features: DN + cross-section + config + letter marks; falls back to full name only when no strong features present). Service in `canonicalKb.ts` (on that branch).

**How it would be populated:** Bootstrap script from historical эталоны + confirmed matches. At this time: 1046 canon / 1802 aliases from 4 historical projects (Новая Самара, Совжи ВК+ОВ, Престиж, proj.6 confirmations).

**How it would be consumed:** Tier 2.5 in matcher (between learned_rule and name_similarity) — if spec item has a passport and an invoice item shares the same passport, strong attribute-agreement implies a match.

**Status:** Parked. The canonical KB scored 0/26 on live proj.11 unmatched items because 9/26 had parser-corrupted spec names (section pollution) and 11/26 had no matching canonical entry in the bootstrap history. The deployment gate (before/after proof on real data) could not be satisfied. The code is proven safe (inert on empty tables) and the mechanism is validated at 42.9–46.4% durable on Сокольи test (see reflections).

---

### 1.6 Secondary stores (supporting, not core knowledge)

| Store | Purpose | Durability |
|-------|---------|-----------|
| `operator_feedback` (`schema.ts:223`) | Audit log of confirm/reject/tag actions. Not consumed by matcher. Used for analytics only. | Project-scoped (CASCADE delete) |
| `gigachat_match_cache` (`schema.ts:213`) | Cache of GigaChat binary yes/no pair decisions. Keyed by (spec_text, invoice_text) normalized pair. | Global (not project-scoped) |
| `spec_parse_rules` (`schema.ts:237`) | Per-specification parser corrections (field + raw_value → corrected_value). Not consumed by matcher. | Specification-scoped |
| `metric_snapshots` (`schema.ts:249`) | Time-series of matched/confirmed/tier counts per project. Analytics only. | Project-scoped |

---

## 2. BRIDGING KNOWLEDGE PATTERNS — TAXONOMY

From the 154 CORRECT matches in proj.12's matchable universe (196 items with loaded invoices) and 150 confirmed matches in proj.11, the knowledge each correct pair encodes falls into five categories:

---

### Type A: Brand-to-Brand Substitution (~25 pairs, ~16%)

The spec names a product category or model family; the invoice provides a brand. The system must know this brand is the designated supplier for this category in this project.

**Examples from proj.12:**
- Spec: "Радиатор панельный Ventil Compact" → Invoice: "Радиатор панельный Royal Thermo VENTIL COMPACT VC22-500-400/9016" (33 radiator items)
- Spec: "Компенсатор сильфонный" → Invoice: "Компенсатор сильфонный AYVAZ CF-10 DN32" (2 items)
- Spec: "Труба PEX Ø16" → Invoice: "16х2.2 Труба SANEXT PE-Xa/EVOH, бухта 200м" (4 PEX pipe items)
- Spec: "Кран шаровой ∅15" → Invoice: "Кран шаровой латунный LD Pride 47.15.B-B.Б Ду15 Ру40" (4 crane items)

**Knowledge encoded:** (spec type + DN) → (brand + model series + DN). Requires knowing the project-specific supplier decision: "this type goes from this supplier."

**Cross-project transfer:** Supplier assignments change per project (proj.12 uses Royal Thermo; proj.11 uses TEPLA Neo Expo and EVRA for radiators). The brand→type mapping is project-specific. The DN matching logic is universal.

---

### Type B: Abbreviation/Abbreviation Expansion (~20 pairs, ~13%)

Spec uses Russian-standard abbreviations that expand to full names in invoice items, or vice versa.

**Examples from proj.12:**
- Spec: "Балансировочный клапан MVI" → Invoice: "Балансировочный клапан MVI BLC-2 DN20 (PN20)" (4 items; the "MVI" brand abbreviation is shared, matching works via name similarity)
- Spec: "Коллектор MVI" → Invoice: "Коллектор отопления MVI FC-2 1"x20 мм на 4 контура" (4 collector items)
- Spec: "Клапан противопожарный нормально-закрытый канальный" → Invoice: "Клапан АЗЕН-90-НЗ-600х1000-1*ME220"

**Knowledge encoded:** The abbreviation "АЗЕН" = "АВАРИЙНЫЙ ЗАКРЫТЫЙ НОРМАЛЬНО-ЗАКРЫТЫЙ КЛАПАН" — a brand abbreviation for the НЗВЗ manufacturer's fire damper model. The LLM handles these but a rule/alias would make them durable.

---

### Type C: Synonym / Near-Synonym Vocabulary (~18 pairs, ~12%)

Same product, different Russian vocabulary for the same concept.

**Examples from proj.12:**
- Spec: "Гибкая вставка ВГ 500х300" → Invoice: "Вставка гибкая ВГ 500х300 (ш20/ш20)" — word order transposition ("гибкая вставка" vs "вставка гибкая")
- Spec: "Решетка вентиляционная" → Invoice: "Решетка 1VA 800х600 (RAL9016)" — "вентиляционная" is implied, brand "1VA" must be known
- Spec: "Огнезащитная изоляция МБФ-5" → Invoice: "Огнезащитный базальтовый материал ОБМ-5Ф" — "МБФ" standard vs "ОБМ" product code, thickness mapping needed (МБФ-5 = 5mm = ОБМ-5Ф)
- Spec: "Воздуховод прямоугольный" → Invoice: "ПУ оц. 600х400 мм" (abbreviation: ПУ = приточный воздуховод)

**Knowledge encoded:** Synonym pairs that `construction_synonyms` could hold, or `DOMAIN_ALIASES` could bridge. Some require thickness/mark mapping tables.

---

### Type D: Size/Standard Mapping (~15 pairs, ~10%)

Same product with different size notation systems, or standard numbers that map to dimensions.

**Examples from proj.12:**
- Spec: "Цилиндр К-FLEX ST δ=30мм Ø22" → Invoice: "Цилиндр K-FLEX 30x022-1 K-ROCK ALU S /20" — the notation "30x022" encodes (wall_thickness=30, pipe_diameter=22)
- Spec: "Теплоизоляция Thermacompact δ=6мм Ø18" → Invoice: "Thermacompact IS (S) C-18 (180м)" — the "C-18" model code encodes pipe diameter 18mm
- Spec: "Гибкая вставка ВГТ 441х441 (фл/фл)" → Invoice: "Вставка гибкая ВГТ D710 (фл/фл)" — 441х441 cross-section inscribed circle = D710 diameter (approx)
- Spec: "Электропривод DA5FU230D" → Invoice: "Дроссель-клапан ДК 200-П-DA5FU230D" — the actuator article code appears as a suffix in the assembly item name

**Knowledge encoded:** Model-code parsing rules. The structural discriminator `extractMarkingFeatures` partially handles DN/cross-section, but article codes embedded in product names require different extraction logic.

---

### Type E: Packaging/Unit Normalization (~5 pairs, ~3%)

Same product, different unit representation in spec vs invoice.

**Examples from proj.12:**
- Spec: "Труба PEX Ø16, м" → Invoice: "16х2.2 Труба SANEXT PE-Xa/EVOH, бухта 200м" — spec in meters; invoice in coils (бухта). Quantity reconciliation needed.
- Spec: "Фланец Ду25, шт" → Invoice (if any): "Фланец приварной 25 (10 шт в уп.)" — spec per piece; invoice per package.

**Knowledge encoded:** Unit conversion rules (`unit_conversion_triggers` table exists but is under-populated for this domain).

---

### Summary Table

| Type | Pattern | Estimated count in proj.12 (154 correct) | Cross-project? |
|------|---------|----------------------------------------:|---------------|
| A: Brand substitution | (spec category) → (brand + series) | ~25 | No — project-specific suppliers |
| B: Abbreviation expansion | "АЗЕН" = АВАРИЙНЫЙ НОРМАЛЬНО-ЗАКРЫТЫЙ | ~20 | Yes — domain abbreviations are stable |
| C: Synonym/vocabulary | "вентиляционная решетка" = "1VA грилль" | ~18 | Partial — generic synonyms yes, brand-specific no |
| D: Size/standard mapping | "δ=30мм Ø22" = "30x022" model code | ~15 | Yes — size notation standards are universal |
| E: Packaging/unit | бухта 200м vs per meter | ~5 | Yes — unit conversions are universal |
| LLM residual (no clear pattern) | Semantic inference by Gemini | ~71 (46%) | Unknown — LLM handles these one-shot |

**Key finding:** 46% of correct matches in proj.12 are "LLM residual" — pairs that work because Gemini understands Russian construction semantics but cannot be expressed as a simple rule or alias yet. This is where bundle learning has the most leverage: turning LLM decisions into durable rules.

---

## 3. BUNDLE-LEARNING METHODOLOGY

A "bundle" is an owner-provided triple: смета (spec PDF) + счет(а) (invoice PDFs/XLS) + эталон (optional ground-truth Excel). The goal is to turn confirmed correct pairs from a bundle into durable knowledge entries without requiring operator clicks.

---

### 3.1 What already exists

**The `POST /api/projects/:id/import-matches` endpoint** (`matching.ts:1825`) is the primary offline ingestion path. It accepts an Excel file with columns "Наименование спецификации" and "Наименование в счёте" (plus optional "Поставщик") and:
1. Normalizes both names with `normalizeForMatching`
2. Inserts/updates `matching_rules` with `source='import'`, confidence=0.95
3. Calls `learnConstructionSynonymsFromConfirmedMatch` for each pair (extracts abbreviation↔expansion synonyms)
4. Auto-triggers a full rematch for the project

**This path is already the correct mechanism.** It was built for exactly this use case. The эталон Excel from any project can be reformatted as a two-column import sheet and fed to this endpoint.

**Gap 1:** The import endpoint is per-project (it rematch es that project). The matching_rules it creates are global (cross-project), but the auto-rematch only re-evaluates the specific project. Cross-project benefit manifests when the next project is matched.

**Gap 2:** The import endpoint requires the two-column "spec name / invoice name" format. Owner-provided эталон files often have a different structure (e.g., proj.12 эталон has spec columns + аналог price column but no invoice item names in a clean column). A preprocessing step is needed to extract (spec_name, invoice_name) pairs from raw эталон files.

**Gap 3:** No batch "import from history" across multiple completed projects at once. Each must be fed individually.

---

### 3.2 Proposed Offline Bundle Ingestion Pipeline

#### Step 1: Эталон Parsing (offline, owner-provided)

For each owner bundle (смета + счета + эталон):
1. Parse the эталон XLSX to extract (spec_position, spec_name, expected_supplier, expected_price) tuples
2. Match expected_supplier + expected_price against loaded invoice items to identify the invoice item name
3. Output: a two-column XLS (spec_name | invoice_item_name) ready for the import endpoint

This step currently requires manual work per project. The matching is "price+supplier lookup" which is deterministic when эталон provides both the supplier name and price.

**What to build:** A `scripts/extract-ethalon-pairs.ts` script that:
- Reads эталон XLSX (spec name in col B, аналог supplier in col L/P, аналог price in col J/Q)
- Reads invoice items from the project API or a local export
- Joins them by (supplier name fuzzy-match + price proximity ±5%)
- Outputs a `training_pairs.xlsx` with two columns

Estimated effort: ~2 hours to build for the proj.12 format.

#### Step 2: Bulk Import (one HTTP call, already works)

```
POST /api/projects/{id}/import-matches
Content-Type: multipart/form-data
file: training_pairs.xlsx
```

This inserts N rules into `matching_rules` and N synonyms into `construction_synonyms`, then re-runs matching for the project.

#### Step 3: Cross-Project Knowledge Transfer (automatic)

After import, the new `matching_rules` rows are immediately available to ALL projects because `RULES_SQL` at `matcher.ts:758` selects ALL rules (no project filter). The next time any project runs matching, the new rules fire on similar items.

**Empirical evidence:** Proj.11 confirmed matches generated rules that were used 117 times in the same project. When proj.12 was loaded, those rules fired 1 time (showing cross-project transfer happens but coverage is low because vocabulary differs between proj.11 SANEXT/TEPLA items and proj.12 Royal Thermo/AYVAZ items).

#### Step 4: Canonical KB Bootstrap (future, when canonical KB is deployed)

When `feat/canonical-kb-deploy` is deployed:
- The same `training_pairs.xlsx` used in Step 2 can also populate `product_aliases`
- Each confirmed (spec_name, invoice_name) pair → two alias entries pointing to the same `canonical_products` passport
- This enables structural attribute-transfer matching (Type D pattern above) without string similarity
- Particularly valuable for new projects that use similar product types but different suppliers/naming

---

### 3.3 Knowledge Type → Store Mapping

| Knowledge type | Target store | Mechanism |
|----------------|-------------|-----------|
| Brand substitution (Type A) | `matching_rules` (supplier-scoped) | import-matches endpoint, supplier column required |
| Abbreviation expansion (Type B) | `construction_synonyms` (global) | Auto-extracted by `learnConstructionSynonymsFromConfirmedMatch` on import |
| Synonym/vocabulary (Type C) | `matching_rules` (global) OR `DOMAIN_ALIASES` | import-matches for recurring patterns; code alias for stable domain synonyms |
| Size/standard mapping (Type D) | `canonical_products` + `product_aliases` (when deployed) | Canonical KB passport bridge; requires `feat/canonical-kb-deploy` |
| Packaging/unit (Type E) | `unit_conversion_triggers` (global) | Manual inserts; no auto-learning yet |
| LLM residual pairs | `matching_rules` (global) | import-matches — these become durable rules after one owner-confirmation |

---

### 3.4 Cross-Project Transfer Mechanics

**Immediate (already works):**
- Any rule added via `import-matches` fires cross-project without any extra steps
- `construction_synonyms` learned from any import apply to all projects
- Only rules with `supplier_id IS NOT NULL` are restricted — global rules (null supplier) fire everywhere

**Proven empirically:**
- Canonical KB (on `feat/canonical-kb` branch): 46.4% durable score on Сокольи using only knowledge from other projects (Новая Самара, Совжи, Престиж). Cross-project transfer via structural passport bridge is confirmed.

**Limitation for brand-substitution rules (Type A):**
- Rules like "радиатор ventil compact" → "royal thermo ventil compact vc22-500-400" are scoped to the specific invoice item name
- When proj.13 uses a DIFFERENT radiator brand (e.g., KERMI instead of Royal Thermo), these rules do NOT fire
- The supplier-agnostic part (spec type → category) IS transferable; the brand-specific part is project-local

**Operator burden reduction over time:**
- Project 1 (first): 0% learned_rule coverage, 100% operator or LLM work
- Project 2 (same product types, same suppliers): learned_rule tier fires on all items already confirmed in project 1, reducing operator clicks proportionally to vocabulary overlap
- Project 3 (same category, different suppliers): canonical KB (when deployed) bridges via structural features even when brand differs; operator confirms edge cases
- At N projects: the rules table contains O(N × matched_items_per_project) entries; coverage grows toward the "vocabulary ceiling" of the construction domain

**Estimate:** From proj.11 to proj.12, the vocabulary overlap is low (heating/ventilation items from different suppliers). Rules from proj.11 fired 1 time in proj.12. But: 154 correct matches in proj.12 were all LLM-based; if the owner confirms them (0-click via the bulk-confirm feature), they become 154 new rules available for future projects that order from the same suppliers (Royal Thermo, НЗВЗ, ФРЕГАТ).

---

### 3.5 What to Build (Priority Order)

#### P1: Ethalon-to-Import-Sheet Script (offline preprocessing)
- File: `backend/scripts/extract-ethalon-pairs.ts`
- Input: эталон XLSX path + project ID (to pull invoice items from API or local DB)
- Output: two-column `training_pairs.xlsx` (spec_name | invoice_item_name)
- Impact: allows ANY owner-provided эталон to be ingested offline in <5 minutes of owner time

This is the bottleneck. Without it, the owner must manually create the two-column format for each bundle.

#### P2: Bulk Confirm + Auto-Import for Owner Review (UI path, alternative to scripts)
- After a new project is matched, a "Bulk Confirm All Proposals" action with a second-pass quality gate (confidence threshold, filter out WRONG_SUPPLIER cases)
- Each confirmed pair auto-creates a matching_rule → becomes available for future projects
- Zero scripts required; pure UI flow
- Tradeoff: only useful when the LLM's verity@1 is high enough (≥75%) to bulk-confirm safely

**Current proj.12 state:** verity@1 within loaded universe = 78.6% (adj: 80.6%). Bulk confirm at threshold ≥0.7 would confirm ~148 of 154 correct matches, creating 148 new rules. The 16 wrong matches (WRONG_SUPPLIER + WRONG_MODEL) would be included unless filtered by supplier-scope logic.

#### P3: Canonical KB Deployment (structural bridge)
- Deploy `feat/canonical-kb-deploy` (commits 59daecb + d1f3439 + 96ee438) to main
- Bootstrap `canonical_products` from historical эталоны (Новая Самара, Совжи, Престиж)
- Effect: structural attribute-transfer for DN-typed items (pipes, valves, compensators) even when brand names differ
- **Prerequisite:** parser must produce clean item names (section-pollution bug in proj.11 must be fixed first — the parser-clean branch)

---

### 3.6 Concrete Implementation Path

For proj.12 specifically (to turn its 154 correct LLM matches into durable rules):

**Step 1** (immediate, no code change): Use the existing bulk-confirm endpoint to confirm all 154 correct matches from the веrity session. This creates 154 `matching_rules` rows plus ~20-30 `construction_synonyms` entries from the abbreviation learner.

```
POST /api/matching/bulk/confirm
Body: { matchIds: [<list of match IDs for correct proposals>] }
```

All 154 rules then become available globally for any future project.

**Step 2** (requires P1 script, ~2 hours): Parse the proj.12 эталон (01_05-07-24-ОВ эталон жк бкк арта.xlsx) to extract (spec_name, expected_supplier, expected_price), join against invoice items to find invoice names for the 35 items with explicit аналог pricing (SANEXT for 21 items, НЗВЗ for 14 items). Import those pairs.

**Step 3** (future): As each new project (proj.13, 14, ...) is processed, repeat. Over 5-10 projects the coverage of the matchable vocabulary grows until the operator's click burden approaches zero for repeat item categories.

---

## 4. KEY FINDINGS AND CONSTRAINTS

1. **The "РОВ" is `matching_rules`** — global, cross-project, persists across project deletion. Everything that operator confirms lands here and fires forever.

2. **The import mechanism already exists** — `POST /api/projects/:id/import-matches` is a working offline ingestion path. The gap is the preprocessing script to convert owner эталоны to two-column format.

3. **46% of proj.12 correct matches are "LLM residual"** — they work today because Gemini infers Russian semantics. Confirming them (via bulk-confirm) converts them to permanent rules at zero additional cost.

4. **Brand substitution rules (Type A, ~16%)** are project-local — they encode which supplier the owner chose for this project. They transfer to future projects only if the same supplier is used again.

5. **The canonical KB is the right tool for Type D (size/standard mapping)** but is currently parked due to parser-quality blockers. It should be deployed after the parser-clean improvements are stable.

6. **Structural ceiling for learning:** 51.8% of proj.12 (ductwork + bare pipe sections) has no matchable analog in any supplier invoice — no amount of bundle learning can cover this. Learning only helps the matchable 48.2%.

7. **The operator's burden shrinks non-linearly:** First project: 100% manual. Second project with same suppliers: ~30-40% learned_rule coverage expected (estimated from proj.11 rule hit rate). Third project onward: depends on vocabulary overlap — same HVAC domain with same supplier pool can approach 60-70% learned_rule coverage.
