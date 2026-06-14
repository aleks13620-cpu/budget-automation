# Pre-deploy 5-move report — feat/discount-formd → origin/main
Diff: 2 files, +424/−10, 2 commits (e8cf452 + 74ccf16). backend/src/routes/invoices.ts + test.
Change: Form D = hidden document-level discount. Parse-time = DETECT+INFORM only (no price mutation). Apply via `POST /api/invoices/:id/apply-document-discount` (factor=total/sum, snapshot, reversible via original_price).

## Move 1 — Bugs
- [FIX→M3] Consistency check is a NO-OP — `invoices.ts:111-115` — реально. Checks cent-rounding of `amount*factor`, NOT per-line factor uniformity → claims false safety; does not filter mixed/per-line discounts.
- [CARRY] Image path Form D lacks `discountDetected` guard — `invoices.ts:418` — реально/low (image path always discountDetected=null; detect-only).
- [CARRY/паранойя] saveSnapshot outside apply transaction (TOCTOU) — `invoices.ts:1949` — паранойя today (better-sqlite3 synchronous, no interleave); реально only on async refactor.
- [OK] div-by-zero (guarded :99/:90), factor≥1 impossible (:102/:105), NULL prices safe (ROUND(null)=null), original_price COALESCE+idempotent, no hardcode, NaN id → 404.

## Move 2 — Missed scenarios
- [FIX→M3] VAT conflation — `invoices.ts:86-121` — detection compares raw item.amount vs documentTotal(with VAT); does NOT scale by VAT like sibling `computeNeedsAmountReview` (:56-58). Could misread a VAT gap as a discount on VAT-convention-mismatched invoices.
- [FIX→M3] Apply endpoint lacks `discount_detected` guard — `invoices.ts:1934,1938` — operator could trigger apply on a Form-C invoice → double discount.
- [FIX→M3] Delivery lines included in factor + UPDATE — `invoices.ts:1942`, parse `:771` — no `is_delivery=0` filter → wrong factor + discounts delivery.
- [CARRY] Reparse after apply: `discount_applied` stuck=1 + fresh undiscounted items — `invoices.ts:1411,1548` (no flag reset).
- [CARRY] Rollback doesn't reset `discount_applied` — `invoices.ts:2001`.
- [CARRY] Confirmed matched items not re-flagged after price change (display IS correct — query-time join).
- [CARRY] Frontend rendering of Form D banner / original-vs-discounted price unverified (API fields present).

## Move 3 — Reality filter (KPI = correct prices/trust; no_corrupt_through sacred)
- **VAT conflation → FIX** — could suggest a wrong discount (trust self-harm). Cheap: mirror sibling VAT scaling in detection.
- **Apply-endpoint Form-C guard → FIX** — double-discount corruption path. Cheap: add `discount_detected` check.
- **Delivery exclusion → FIX** — wrong factor when delivery present. Cheap: `is_delivery=0` filter in detect + UPDATE.
- Consistency no-op → CARRY-TASK — no corruption (operator-confirm + reversible is the real gate); redesign/remove later (don't claim false safety).
- Reparse/rollback flag reset → CARRY-TASK — stuck-state, recoverable, edge sequence (fold trivial fix opportunistically).
- Confirmed-match re-flag / frontend verify / image guard / TOCTOU / NaN → CARRY-TASK (minor / edge / theoretical).

## Move 4 — Regressions
- New: `detectDocumentLevelDiscount`, endpoint `apply-document-discount`, 2 parse-time detect+inform blocks (PDF/Excel + image), 2 DB columns (`discount_applied`, `original_price`).
- Risk: Form C safe (guarded), normal invoices safe (Test 2), scope clean (only 2 files).
- Build: **PASS** (tsc, 0 errors). Test: **PASS** (integration checks green).

## Move 5 — Security
- Dangerous trio / SSRF: N/A (purely local). SQL injection: OK (all parameterized :1934/1943/1951/1960). XSS: OK (reason server-computed, React text node). Token leaks: OK (only numeric logs). .env: N/A.
- **Auth on new mutating endpoint → ESCALATE (SEC-1):** prod `/api` open without token; new price-mutating `apply-document-discount` adds to the unauthenticated mutation surface (anyone can change prices by enumerating invoice IDs). SEPARATE pre-existing systemic issue — not a unique blocker for this fix (baseline already exposes apply-discount/delete/etc.), but HIGH priority on its own.
- Rate limiting: N/A (operator-frequency). Input validation (NaN id): CARRY (safe in practice via 404).

## VERDICT: FIX
3 blocking findings before deploy (all cheap): (1) VAT-awareness in detection, (2) Form-C guard on apply endpoint, (3) exclude delivery lines. Then targeted closure re-check (not full re-run) → PASS → owner deploy-ok.
CARRY-TASKS: 7 (image guard, TOCTOU, consistency redesign, reparse/rollback flag reset, confirmed-match re-flag, frontend verify, NaN guard).
ESCALATE separately: SEC-1 (open prod API).

Moves completed: [x] M1 (1a/1b/1c) [x] M2 (2a/2b) [x] M3 reality filter [x] M4 + build gate [x] M5 security.
