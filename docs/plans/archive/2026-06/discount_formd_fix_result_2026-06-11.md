# Form D Alignment Fix — Result (2026-06-11)

Branch: `feat/discount-formd`  
Commit: `74ccf16`

## What Changed

**Before:** `processInvoiceFile` silently multiplied every price/amount by the detected discount factor at parse time (`discount_applied=1`, prices mutated, `needs_amount_review` cleared to 0).

**After:** Parse-time is DETECT+INFORM only:
- Prices and amounts are **not touched** at parse time.
- `discount_applied` stays **0**.
- `needs_amount_review` is set to **1**.
- `parsing_category_reason` gets an operator-visible hint, e.g.:  
  `| Form D: вероятная документная скидка ~40% (итог < суммы строк); цена за ед. будет пересчитана при подтверждении (factor=0.6000)`
- `original_price` stays **NULL** (nothing to snapshot since prices not mutated).

Same change applied to both the PDF/Excel path and the image parser path.

**Confirm action unchanged:** `POST /api/invoices/:id/apply-document-discount` computes factor from live data, applies it, snapshots `original_price`, sets `discount_applied=1`. Idempotent.

## Offline Proof (all 21 checks PASS)

| Test | Result |
|------|--------|
| Parse-time: discount_applied=0 | PASS |
| Parse-time: needs_amount_review=1 | PASS |
| Parse-time: reason contains Form D + discount % | PASS |
| Parse-time: prices UNCHANGED (16009, 11865, 60761) | PASS (×3) |
| Parse-time: original_price NULL (not mutated) | PASS (×2) |
| Parse-time: SUM(raw amounts)=949807 unchanged | PASS |
| Non-discount invoice: no Form D, prices unchanged | PASS (×3) |
| Form C path: Form D does not override explicit % discount | PASS (×2) |
| Apply endpoint: 16009→9605.4 | PASS |
| Apply endpoint: 11865→7119 | PASS |
| Apply endpoint: 60761→36456.6 | PASS |
| Apply endpoint: original_price=16009 preserved | PASS |
| Apply endpoint: SUM(adjusted)≈569884.2 | PASS |
| Apply endpoint: discount_applied=1 after confirm | PASS |

## Build

`npm run build` green (tsc, no errors).

---

# Pre-Deploy Gate Fixes — Round 2 (2026-06-11)

Applied 3 blocking fixes + FIX 4 (opportunistic) + 4 closure tests.  All 37 checks PASS.

## FIX 1 — VAT-awareness in detection (`invoices.ts:86–155`)

`detectDocumentLevelDiscount` signature extended:
```ts
function detectDocumentLevelDiscount(
  items: Array<{ amount: number | null; is_delivery?: number | null }>,
  documentTotal: number | null,
  vatRate: number | null = null,
  pricesIncludeVat: number | null = null,
): number | null
```
Line amounts are now scaled by `(1 + vatRate/100)` when `pricesIncludeVat===0`,
mirroring `computeNeedsAmountReview` exactly.  A pure VAT gap no longer reads as a discount.
When both documentTotal and lines share the same VAT convention the scaling cancels in the
ratio → factor stays 0.60 (894066 proof intact).

**Parse-time call site (~:804):** projects `is_delivery` flag from `isDeliveryItem(it.name)` and
passes `parsedVatRate` / `supplierPricesIncludeVatForReview`.

**Apply endpoint call site (~:2017):** loads supplier VAT settings and passes
`effectiveVatRate` / `effectivePricesIncludeVat`.

## FIX 2 — Form-C guard on apply endpoint (`invoices.ts:~1976`)

`apply-document-discount` SELECT now also fetches `discount_detected`.
If `discount_detected != null && > 0`, endpoint returns HTTP 422 with a clear message:
> "Счёт уже содержит явную скидку X% (Form C); применение документной скидки Form D приведёт к двойному дисконту — отменено"

## FIX 3 — Delivery line exclusion (`invoices.ts:~120–155, ~2032`)

`detectDocumentLevelDiscount` filters out items with `is_delivery===1` before computing
the goods-only sum and factor.  The apply endpoint UPDATE now targets only:
```sql
WHERE invoice_id = ? AND (is_delivery = 0 OR is_delivery IS NULL)
```
Delivery item prices are untouched after apply.

## FIX 4 — Reset `discount_applied = 0` on reparse/rollback (opportunistic)

Three locations reset `discount_applied` to 0 so re-apply is not permanently blocked:
- `POST /api/invoices/:id/reparse` UPDATE (~:1438): `discount_applied = 0` added to SET clause.
- `POST /api/invoices/:id/reparse-gigachat` UPDATE (~:1578): `discount_applied=0` added.
- `POST /api/invoices/:id/rollback` transaction (~:2070): explicit `UPDATE invoices SET discount_applied = 0`.

## Closure Tests (backend/test_formd_discount_integration.ts)

Four targeted checks added at the end of `run()` — original 21 checks preserved:

| Closure | What it checks | Result |
|---------|---------------|--------|
| A — VAT-awareness | Pure-VAT gap scenarios (normalised-sum direction + surcharge direction) | PASS ×3 |
| B — Form-C guard | discount_detected > 0 → guard fires, prices unchanged | PASS ×2 |
| C — Delivery exclusion | goods factor=0.6, goods discounted, delivery price/amount UNCHANGED | PASS ×6 |
| D — REGRESSION 894066 | factor=0.60 intact, 16009→9605.4, 11865→7119, 60761→36456.6 | PASS ×6 |

Total: **37/37 PASS**.

## Build

`npm run build` green (tsc, no errors) after all fixes applied.
