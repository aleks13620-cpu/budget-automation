# Диагностика: цена за единицу со скидкой — счёт 894066
_Дата: 2026-06-11. Статус: READ-ONLY диагностика, без правок._

---

## 1. Существующее правило и его статус

### Что уже есть

| Компонент | Файл:строка | Форма скидки | Статус |
|---|---|---|---|
| `scoreVatDiscount` — скорер колонок | `backend/src/services/pdfParser.ts:55` | A (колонка «Сумма без скидки» де-ранкована) | АКТИВЕН |
| `detectDiscount(text)` | `pdfParser.ts:206` | C («скидка X%» строкой в тексте) | АКТИВЕН — только detect |
| `invoices.discount_detected REAL` | `init.ts:25` | хранит % обнаруженной скидки | АКТИВЕН |
| `invoices.discount_applied INTEGER` | `init.ts:26` | флаг «скидка применена к строкам» | АКТИВЕН |
| Фича #3 detect→review | `invoices.ts:683-690` | C — при `discountDetected > 0` ставит `needsAmountReview = 1` и дописывает reason | АКТИВЕН (только detect + review) |
| `POST /api/invoices/:id/apply-discount` | `invoices.ts:1798` | C — вручную множит `price` и `amount` всех строк на `(1 - d/100)` | АКТИВЕН (только ручное) |
| `POST /api/invoices/:id/apply-net-price-mode` | `invoices.ts:1999` | per-line price пересчёт, пишет `original_price` | АКТИВЕН (только ручное) |
| **Авто-применение** (`processInvoiceFile`) | `invoices.ts` | — | **ОТЛОЖЕНО** — явный комментарий: «на проде нет данных для валидации авто-применения» (строка 683) |

### Ключевой вывод по правилу

Правило «важно цена за единицу с НДС и со скидкой» (`unit_price_with_vat`) ЕСТЬ в контракте всех фич #1-#4 и закреплено в `computeUnitPriceWithVat` (`invoices.ts:95` и `matching.ts:52`). Фича #3 (авто-скидка по строке «−X%») написана как **detect→review** и **намеренно не применяет** цифру к строкам, ожидая реального случая на проде. Форма D — document-level discount (итог << сумма строк без явного «скидка X%») — **не описана ни в одной фиче и не реализована**.

---

## 2. Детектор «сумма под сомнением» (>15%)

**Файл:** `backend/src/routes/invoices.ts:45-64`

```
function computeNeedsAmountReview(items, totalWithVat, vatRate, pricesIncludeVat):
  sumItems = Σ(lineAmountWithVat per item)  // с учётом НДС если pricesIncludeVat=0
  deviation = |sumItems - totalWithVat| / totalWithVat
  return deviation > 0.15 ? 1 : 0
```

Порог: **15%**. Флаг `needs_amount_review = 1` пишется в таблицу `invoices`. Кроме этого функция вызывается в трёх местах:
- Загрузка PDF-пути (`invoices.ts:679`)
- Загрузка image-пути (`invoices.ts:355`)
- GigaChat reparse (`invoices.ts:1455`)

Для инвойса 894066 детектор сработал: `needs_amount_review = 1`. Reason в `parsing_category_reason`: _«GigaChat: сумма позиций (~1081643) сильно расходится с итогом (648985.8)»_.

---

## 3. Диагностика счёта 894066 в проде (read-only)

**Инвойс id=66**, project_id=12, invoice_number=894066, invoice_date=26.05.2026.
- `total_amount = 648 985.8` (печатный Итого — POST-скидочный)
- `discount_detected = null` (строки «скидка X%» в тексте не найдено)
- `discount_applied = 0` (скидка к строкам не применялась)
- `needs_amount_review = 1` (детектор 15% сработал)
- `parsing_category = C` (нечитаемый текст, GigaChat)
- `supplier_id = null`, `prices_include_vat = null`, `vat_rate = 20`

### Хранимые цены строк (PRE-дискаунтные)

Сумма строк = **1 081 643** при Итого = **648 985.8** → ratio = 0.6000 → скидка = **ровно 40%**.

| Позиция | qty | price (хранится) | amount (хранится) | unit_price_with_vat* | effective (×0.6) |
|---|---|---|---|---|---|
| Воздушный клапан АВК 600*400 | 2 | 16 009 | 32 018 | 16 009 | **9 605.40** |
| Воздушный клапан АВК 800*500 | 5 | 22 621 | 113 105 | 22 621 | **13 572.60** |
| Решетка АЛН 1000*500 | 5 | 9 997 | 49 985 | 9 997 | **5 998.20** |
| Решетка АЛН 1000*600 | 24 | 11 865 | 284 760 | 11 865 | **7 119.00** |
| Решетка АМР 200*500 | 48 | 3 919 | 188 112 | 3 919 | **2 351.40** |
| Решетка АМР 400*400 | 30 | 5 389 | 161 670 | 5 389 | **3 233.40** |
| Решетка АРН 1750*1800 | 1 | 59 396 | 59 396 | 59 396 | **35 637.60** |
| Решетка АРН 1800*1800 | 1 | 60 761 | 60 761 | 60 761 | **36 456.60** |

_*`unit_price_with_vat` вычисляется на лету (не хранится) через `computeUnitPriceWithVat(price, amount, quantity, vatRate, pricesIncludeVat)`. Так как `supplier_id = null`, `pricesIncludeVat = null`, `vatRate = 20` (из invoice.vat_rate), при `amount != null && quantity != null` выдаёт `amount / quantity` без домножения НДС (ветка `pricesIncludeVat === 0` не срабатывает при `null`). То есть хранимое `price` ≈ `amount/quantity` — PRE-дискаунтное._

**Механизм бага:** `amount` и `price` хранятся как печатаются в счёте — до скидки. `computeUnitPriceWithVat` не знает о document-level скидке и возвращает `amount/quantity` = PRE-дискаунтную цену. Для оператора и матчера цена завышена в **1/0.6 ≈ 1.667** раза.

---

## 4. Шов: где цена попадает в матчинг

### matcher.ts (matching-time price reading)

`backend/src/services/matcher.ts:744-749` — `INVOICE_ITEMS_SQL` читает `ii.price, ii.amount` напрямую из `invoice_items`. Скидка не применяется.

`backend/src/routes/matching.ts:52-72` — локальная копия `computeUnitPriceWithVat` (идентичная `invoices.ts:95`). Вызывается при:
1. Ответ на GET-список совпадений (`matching.ts:715`) → `effectivePrice` показывается оператору.
2. Пересчёт бюджета для экспорта/export (`matching.ts:1562-1567`) → `effPrice * qty = amount`.

Оба вызова читают `ii.amount` и `ii.quantity` и делят — получая PRE-дискаунтную цену.

### Где должен применяться discount factor

Единственный корректный момент — **при загрузке инвойса** (в `processInvoiceFile`, `invoices.ts:293`). Если применять к хранимым `price`/`amount`, это будет forward-only, non-destructive (с сохранением `original_price`). Matcher читает из БД, ничего менять в matcher не нужно.

### Кеш/версия парсера инвойсов

Для инвойсов (PDF/Excel) **нет аналога `SPEC_PDF_PARSER_VERSION`**. Инвойсы не кешируются в `gigachat_file_cache` под версионированным ключом. Следствие: авто-исправление discount-factor нельзя применить к уже загруженным счетам без явного reparse или ручного эндпоинта (как `apply-net-price-mode`). **Для уже загруженных счетов нужен отдельный `apply-document-discount` endpoint или migratory script с guard `discount_applied`.**

---

## 5. Алгоритм эффективной цены (sketched, без реализации)

### Обнаружение document-level скидки

```
detectDocumentDiscount(items, documentTotal) -> { factor: float, form: 'C' | 'D' | null }

1. Форма C: если detectDiscount(fullText) вернул d > 0:
   - candidate_factor = 1 - d/100
   - Проверить: SUM(amount) * candidate_factor ≈ documentTotal (±1%)
   - Если сходится → form='C', factor=candidate_factor, ПРИМЕНИТЬ
   - Если НЕ сходится → неоднозначно → needs_amount_review, НЕ применять

2. Форма D (ЭТА ЗАДАЧА): если detectDiscount = null, но:
   - documentTotal > 0
   - SUM(amount) > 0
   - |SUM(amount) - documentTotal| / documentTotal > 0.15  (уже детектируется как needs_amount_review)
   - documentTotal < SUM(amount)  (итог МЕНЬШЕ суммы строк — скидка, не доплата)
   - factor = documentTotal / SUM(amount)  // например 648985.8 / 1081643 = 0.6000
   - Применить: effective_unit_price = price * factor (или amount * factor / qty)
   - form='D'

3. В противном случае: factor = 1.0 (скидки нет)
```

### Применение (forward-only, ровно один раз)

```
if discount_applied == 0 AND factor != 1.0:
  saveSnapshot(invoiceId, 'before_discount_factor')
  UPDATE invoice_items
    SET original_price = COALESCE(original_price, price),
        price = ROUND(price * factor, 2),
        amount = ROUND(amount * factor, 2)
    WHERE invoice_id = ?
  UPDATE invoices SET discount_applied = 1 WHERE id = ?
```

### Обработка НДС (без хардкода)

`computeUnitPriceWithVat` уже обрабатывает НДС через `pricesIncludeVat` и `vatRate` из supplier. **Discount factor применяется ДО вызова `computeUnitPriceWithVat`** — т.е. к хранимым `price`/`amount`. Порядок: discount → НДС. Если supplier.prices_include_vat=1 (цены уже с НДС), НДС не домножается, discount применяется к gross-цене.

### Граничные случаи

| Ситуация | Поведение |
|---|---|
| Per-line скидка (форма B) | `SUM(amount)` не даст единого factor → deviation случайная → если >15% → needs_amount_review, не применять document factor |
| Округление: итог не 0.6x ровно | допуск ±2% для integer-ratio → применить; ±2-15% → needs_amount_review |
| VAT exclusive supplier + discount | discount применяется к net-price, НДС домножается позже в computeUnitPriceWithVat |
| `discount_applied = 1` | guard: не применять повторно |
| documentTotal > SUM(amount) | это наценка, не скидка → не применять discount |
| Нет documentTotal | computeNeedsAmountReview уже вернёт 0, не применять |

---

## Резюме

**(a) Правило существует?** Да. Контракт `unit_price_with_vat = цена × НДС × discount` зафиксирован в фичах #1-#4. Фича #3 (форма C) развёрнута как **detect→review, auto-apply DEFERRED**. Форма D (total vs sum mismatch без явного «скидка X%») **не реализована ни в одной фиче**.

**(b) Где баг?** В `invoice_items` хранятся PRE-дискаунтные `price` и `amount` (вентиляционный счёт 894066: 40% скидка не применена). `discount_detected = null` (нет строки «скидка X%»), `discount_applied = 0`. `computeUnitPriceWithVat` в matcher и в /api/invoices/:id читает `amount/quantity` — PRE-дискаунтную величину. Оператор видит price 16 009 вместо реального 9 605 (на примере АВК 600*400).

**(c) Parser-fix vs matching-time fix?** Правильный шов — **parser-fix (при загрузке)**: применить factor к `price`/`amount` в `invoice_items` с guard `discount_applied`. Matcher и `computeUnitPriceWithVat` менять не нужно — они уже правильно читают из БД. Для счёта 894066 (уже загружен) — нужен отдельный endpoint (`apply-document-discount`) или ручной вызов `apply-net-price-mode` с factor=0.6.

**(d) Алгоритм:** `factor = documentTotal / SUM(lineAmounts)` если `SUM > documentTotal && deviation > 0.15`. Применять к `price`×factor + `amount`×factor в транзакции с `original_price` backup и guard `discount_applied`. НДС применяется поверх уже после через существующий `computeUnitPriceWithVat`.
