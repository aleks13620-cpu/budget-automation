# ТЗ-план: 15 инициатив — Budget Automation

> Инициатива 10 (OCR изображений PNG/JPEG) — **отложена**, в этом плане не реализуется.
> Последнее обновление: 2026-03-03

---

## Статус выполнения этапов

| Этап | Инициативы | Статус | Коммит |
|------|-----------|--------|--------|
| 1 | И-3, И-12, И-15 | ✅ Выполнен | `d6a45aa` |
| 2 | И-1/2 | ✅ Выполнен | `dfd3230` |
| 3 | И-7 | ✅ Выполнен | `05ad403` |
| 4 | И-8 | ✅ Выполнен | `34e6b56` |
| 5 | И-5, И-11 backend | ✅ Выполнен | `3127fed` |
| 6 | И-11 frontend, И-13 | ✅ Выполнен | `25cfd6b` |
| 7 | И-6 | ✅ Выполнен | `98cc79f` |
| 8 | И-4 backend | ✅ Выполнен | `c1b32a3` |
| 9 | И-4 frontend | ✅ Выполнен | `7216752` |
| 10 | И-9 backend | ✅ Выполнен | `d86e427` |
| 11 | И-9 frontend + матчинг | ✅ Выполнен | `88db8be` |
| 12 | И-14 | ✅ Выполнен | `69471bf` |
| 13 | И-16 | ✅ Выполнен | `67c5697` |

---

## Поэтапный план реализации (≤ 4 ч/этап, ~52 ч итого)

---

### ✅ Этап 1 — И-3 + И-12 + И-15 (~3.5 ч) · коммит `d6a45aa`

**Задачи:**
1. ✅ `ProjectDetail.tsx`: статус `parsed` → «Требует проверки» (оранжевый `#d97706`)
2. ✅ `invoices.ts`: добавлен `PUT /api/invoices/:id/status`
3. ✅ `InvoicePreview.tsx`: после «Пересобрать счёт» (> 0 позиций) → автоматически ставит `verified`
4. ✅ `matching.ts`: добавлен `PUT /api/matching/:id/unconfirm` (is_confirmed=0, is_selected=0)
5. ✅ `MatchTable.tsx`: кнопка «⟲» на подтверждённых строках
6. ✅ `ManualMatchFromSpec.tsx`: проверено — фильтрации использованных нет, работает верно

**Изменённые файлы:**
- `frontend/src/pages/ProjectDetail.tsx`
- `frontend/src/pages/InvoicePreview.tsx`
- `frontend/src/components/MatchTable.tsx`
- `backend/src/routes/invoices.ts`
- `backend/src/routes/matching.ts`

---

### ✅ Этап 2 — И-1/2: ColumnMapper UX (~4 ч) · коммит `dfd3230`

**Задачи:**
1. `ColumnMapper.tsx`: опции дропдаунов → `кол.{i+1} — {columns[i]}` вместо просто `кол.{i+1}`
2. `InvoicePreview.tsx` (строки 667–684): над ячейками замапленных колонок показывать бейдж с именем поля (`Наименование`, `Цена` и т.д.)
3. Словарь `FIELD_LABELS` для русских подписей — уже частично есть, вынести как константу
4. После изменения маппинга — обновлять бейджи в реальном времени

**Файлы:**
- `frontend/src/components/ColumnMapper.tsx`
- `frontend/src/pages/InvoicePreview.tsx`

**Commit:** `feat: column mapper UX — named dropdowns with column text, mapped header badges`

---

### ✅ Этап 3 — И-7: Фиксы парсера (~3.5 ч) · коммит `05ad403`

**Задачи:**
1. ✅ `pdfParser.ts`: добавлен `isRequisiteLikeRow()` — строки с 2+ ключевыми словами реквизитов (ИНН/БИК/адрес) пропускаются в `detectColumns()`
2. ✅ Категория B: улучшена причина — включает кол-во строк и подсказку для пользователя
3. ✅ Категория B (borderline): аналогично — кол-во строк + уточнённая причина
4. ⏭ Повышение порога до name+2 — не применялось (риск сломать 2-колоночные счета); реквизитный guard закрывает проблему эффективнее

**Файлы:**
- `backend/src/services/pdfParser.ts`

**Commit:** `fix: parser strictness — requisite-row guard in detectColumns, better category B reason`

---

### ⬜ Этап 4 — И-8: Доставка (~4 ч)

**DB Migration:**
```sql
ALTER TABLE invoice_items ADD COLUMN is_delivery INTEGER DEFAULT 0;
```

**Задачи:**
1. `schema.ts` + `init.ts`: добавить миграцию
2. `pdfParser.ts` + `excelInvoiceParser.ts`: строки с ключевыми словами `['доставка', 'транспортные расходы', 'транспортные услуги', 'доставка товара']` → `is_delivery = 1`, не пропускать
3. `invoices.ts`: в `GET /api/invoices/:id/invoice-items` фильтровать `is_delivery = 0` по умолчанию; добавить query param `?include_delivery=true`
4. `invoices.ts`: новый `GET /api/projects/:id/delivery-total`
5. `ProjectDetail.tsx`: показать «Доставка по проекту: X ₽» под суммой счётов

**Файлы:**
- `backend/src/services/pdfParser.ts`
- `backend/src/services/excelInvoiceParser.ts`
- `backend/src/routes/invoices.ts`
- `backend/src/database/schema.ts` + `init.ts`
- `frontend/src/pages/ProjectDetail.tsx`

**Commit:** `feat: delivery cost tracking — detect rows, flag as delivery, show project total`

---

### ⬜ Этап 5 — И-5 (НДС) + И-11 backend (~4 ч)

**И-5 (~2 ч):**
1. `ProjectDetail.tsx`: сделать поле НДС более заметным (отдельная колонка с иконкой карандаша)
2. `MatchingView.tsx`: при отображении цены применять `effectivePrice = prices_include_vat ? price : price * (1 + vat_rate/100)`
3. `export.ts`: добавить колонку «Цена с НДС» + использовать `effectivePrice` в итогах

**И-11 backend (~2 ч):**

**DB Migration:**
```sql
ALTER TABLE invoice_items ADD COLUMN quantity_packages REAL DEFAULT NULL;
```

1. `pdfParser.ts`: расширить `ColumnMapping` → добавить `quantity_packages: number | null`
2. `parseTableData()`: при маппинге заполнять `quantity_packages` из второй кол-во колонки
3. `excelInvoiceParser.ts`: аналогично
4. `schema.ts` + `init.ts`: миграция

**Файлы:**
- `frontend/src/pages/ProjectDetail.tsx`
- `frontend/src/pages/MatchingView.tsx`
- `backend/src/routes/export.ts`
- `backend/src/services/pdfParser.ts`
- `backend/src/services/excelInvoiceParser.ts`
- `backend/src/database/schema.ts` + `init.ts`

**Commit:** `feat: VAT in price calculations + packages quantity column backend`

---

### ✅ Этап 6 — И-11 frontend + И-13 (~4 ч) · коммит `25cfd6b`

**И-11 frontend (~1.5 ч):**
1. `ColumnMapper.tsx`: добавить поле «Кол-во (упак.)» → маппинг `quantity_packages`
2. `InvoicePreview.tsx`: передавать новое поле в маппинг при сохранении конфига

**И-13 (~2.5 ч):**
1. `matcher.ts`: создать `runMatchingIncremental(projectId, skipSpecIds[])` — не трогает confirmed матчи
2. `matching.ts` (run endpoint): добавить query param `?mode=incremental|full`. При `incremental` — сохранить confirmed, удалить только unconfirmed, запустить матчинг только для неподтверждённых spec_items
3. `MatchingView.tsx`: добавить кнопку «Обновить (сохранить подтверждённые)»

**Файлы:**
- `frontend/src/components/ColumnMapper.tsx`
- `frontend/src/pages/InvoicePreview.tsx`
- `backend/src/services/matcher.ts`
- `backend/src/routes/matching.ts`
- `frontend/src/pages/MatchingView.tsx`

**Commit:** `feat: packages column in column mapper; incremental matching preserving confirmed`

---

### ✅ Этап 7 — И-6: Скидки (~4 ч) · коммит `98cc79f`

**DB Migration:**
```sql
ALTER TABLE invoices ADD COLUMN discount_detected REAL DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN discount_applied INTEGER DEFAULT 0;
```

**Задачи:**
1. `schema.ts` + `init.ts`: миграция
2. `pdfParser.ts`: в `parsePdfFromExtracted()` сканировать строки на паттерн `скидк[аи]\s+(\d+[,.]?\d*)\s*%` → записать в `InvoiceParseResult.discountDetected`
3. `excelInvoiceParser.ts`: аналогично
4. `invoices.ts`: при сохранении результата → `UPDATE invoices SET discount_detected = ?`
5. `invoices.ts`: `POST /api/invoices/:id/apply-discount { discount_percent }` → пересчитать `price * (1 - d/100)`, `amount * (1 - d/100)`, установить `discount_applied = 1`
6. `InvoicePreview.tsx`: если `discount_detected != null && !discount_applied` → жёлтый баннер с кнопками «Да, применить» / «Нет»

**Файлы:**
- `backend/src/services/pdfParser.ts`
- `backend/src/services/excelInvoiceParser.ts`
- `backend/src/routes/invoices.ts`
- `backend/src/database/schema.ts` + `init.ts`
- `frontend/src/pages/InvoicePreview.tsx`

**Commit:** `feat: discount detection — auto-detect percent, user confirmation, price recalc`

---

### ✅ Этап 8 — И-4 backend: триггеры единиц (~4 ч) · коммит `c1b32a3`

**DB Migrations:**
```sql
CREATE TABLE IF NOT EXISTS unit_conversion_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  from_unit TEXT,
  to_unit TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE invoice_items ADD COLUMN needs_unit_review INTEGER DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN original_price REAL DEFAULT NULL;
ALTER TABLE invoice_items ADD COLUMN original_unit TEXT DEFAULT NULL;
```

**Задачи:**
1. `schema.ts` + `init.ts`: все миграции
2. Новый файл `backend/src/routes/unitTriggers.ts`: `GET/POST/PUT/DELETE /api/unit-conversion-triggers`
3. `index.ts`: подключить новые маршруты
4. `invoices.ts`: после записи `invoice_items` — загрузить все триггеры, для каждого item проверить совпадение keyword с `name` (case-insensitive), установить `needs_unit_review = 1`
5. `invoices.ts`: `PUT /api/invoice-items/:id/apply-unit-conversion { new_unit, factor }` → сохранить `original_price`, `original_unit`, обновить `price = price / factor`, `unit = new_unit`, `needs_unit_review = 0`

**Файлы:**
- `backend/src/routes/unitTriggers.ts` (новый)
- `backend/src/routes/invoices.ts`
- `backend/src/index.ts`
- `backend/src/database/schema.ts` + `init.ts`

**Commit:** `feat: unit conversion triggers — DB, CRUD API, auto-flag items on parse`

---

### ✅ Этап 9 — И-4 frontend: UI проверки единиц (~4 ч) · коммит `7216752`

**Задачи:**
1. `InvoicePreview.tsx`: на строках таблицы с `needs_unit_review = 1` → жёлтая иконка ⚠. Клик → модал: «Пересчитать в [to_unit]? Введите коэффициент». Кнопки «Применить» / «Пропустить».
2. Новый компонент `frontend/src/pages/UnitTriggers.tsx` — страница управления триггерами (список + форма добавления)
3. `App.tsx`: добавить роутинг на страницу UnitTriggers

**Файлы:**
- `frontend/src/pages/InvoicePreview.tsx`
- `frontend/src/pages/UnitTriggers.tsx` (новый)
- `frontend/src/App.tsx`

**Commit:** `feat: unit conversion triggers UI — review prompt in invoice, management page`

---

### ✅ Этап 10 — И-9 backend: прайсы (~4 ч) · коммит `d86e427`

**DB Migration:**
```sql
CREATE TABLE IF NOT EXISTS price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS price_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  article TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  price REAL,
  row_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Задачи:**
1. `schema.ts` + `init.ts`: миграции
2. Новый файл `backend/src/routes/priceLists.ts`: маршруты `POST/GET /api/projects/:id/price-lists`, `GET/DELETE /api/price-lists/:id`, `GET /api/price-lists/:id/preview`, `PUT /api/price-lists/:id/parser-config`, `PUT /api/price-lists/:id/reparse`
3. Парсинг: полностью переиспользовать `parsePdfFile` / `parseExcelInvoice` — только сохранять в `price_list_items` вместо `invoice_items`

**Файлы:**
- `backend/src/routes/priceLists.ts` (новый)
- `backend/src/index.ts`
- `backend/src/database/schema.ts` + `init.ts`

**Commit:** `feat: price lists backend — separate tables, full parse pipeline reused`

---

### ✅ Этап 11 — И-9 frontend + матчинг (~4 ч) · коммит `88db8be`

**Задачи:**
1. `ProjectDetail.tsx`: добавить секцию «Прайсы» под счётами. Кнопка «Загрузить прайс». Список загруженных прайсов (имя файла, поставщик, статус).
2. При upload файла → добавить выбор типа «Счёт / Прайс» перед отправкой
3. `matcher.ts`: при `runMatching(projectId)` — дополнительно искать совпадения в `price_list_items` для того же project_id (Tier 3/4 по имени). Пометить кандидата как `source: 'price_list'`.

**Файлы:**
- `frontend/src/pages/ProjectDetail.tsx`
- `backend/src/services/matcher.ts`

**Commit:** `feat: price lists UI + price list items included in matching candidates`

---

### ⬜ Этап 12 — И-14: Оригинал vs Аналог (~4 ч)

**DB Migration (если поле отсутствует):**
```sql
ALTER TABLE matched_items ADD COLUMN is_analog INTEGER DEFAULT 0;
```

**Задачи:**
1. `matching.ts`: убедиться что `confirm-analog` устанавливает `is_analog = 1, is_confirmed = 1`
2. `export.ts`: добавить query param `?mode=original|analog|best`. `original` → `is_analog = 0`. `analog` → предпочитать `is_analog = 1`, fallback на `is_analog = 0`. `best` → наименьшая эффективная цена.
3. `MatchingView.tsx`:
   - Переключатель «Оригинал / Аналог» в шапке
   - Пересчитывать итог по секциям на клиенте (используя уже загруженные matches)
   - Показать две колонки «Ориг.» и «Аналог» в итоговой таблице секций

**Файлы:**
- `backend/src/routes/matching.ts`
- `backend/src/routes/export.ts`
- `backend/src/database/schema.ts` + `init.ts`
- `frontend/src/pages/MatchingView.tsx`

**Commit:** `feat: original vs analog spec view — switchable totals, export by mode`

---

### ✅ Этап 13 — И-16: Иерархические позиции DN (~4 ч) · коммит `67c5697`

**DB Migration:**
```sql
ALTER TABLE specification_items ADD COLUMN parent_item_id INTEGER REFERENCES specification_items(id);
ALTER TABLE specification_items ADD COLUMN full_name TEXT;
```

**Задачи:**
1. `schema.ts` + `init.ts`: миграции
2. `excelParser.ts`: после парсинга строк — пост-обработка:
   - Дочерняя строка: `position_number` пустой **И** имя соответствует паттерну `^(DN|Ду|d=)?\d+(\s|$)` или аналогичному короткому коду
   - Последняя «полная» строка → родитель; дочерней устанавливается `parent_item_id`, вычисляется `full_name = parent.name + " " + child.name`
3. `matcher.ts`: при нормализации — если у item есть `parent_item_id`, использовать `full_name` вместо `name`
4. `MatchTable.tsx`: дочерние позиции рендерить с `paddingLeft: 24px`, отображать `full_name`

**Файлы:**
- `backend/src/services/excelParser.ts`
- `backend/src/services/matcher.ts`
- `backend/src/database/schema.ts` + `init.ts`
- `frontend/src/components/MatchTable.tsx`

**Commit:** `feat: hierarchical spec items — DN sub-rows linked to parent, full name in matching`

---

## Сводная таблица DB миграций

| Инициатива | Таблица | Изменение | Этап |
|-----------|---------|-----------|------|
| И-11 | `invoice_items` | `+ quantity_packages REAL` | 5 |
| И-4  | новая `unit_conversion_triggers` | создать | 8 |
| И-4  | `invoice_items` | `+ needs_unit_review INT`, `+ original_price REAL`, `+ original_unit TEXT` | 8 |
| И-6  | `invoices` | `+ discount_detected REAL`, `+ discount_applied INT` | 7 |
| И-8  | `invoice_items` | `+ is_delivery INT DEFAULT 0` | 4 |
| И-9  | новые `price_lists`, `price_list_items` | создать | 10 |
| И-14 | `matched_items` | `+ is_analog INT DEFAULT 0` (если отсутствует) | 12 |
| И-16 | `specification_items` | `+ parent_item_id INT`, `+ full_name TEXT` | 13 |

**Ключевые файлы для всех миграций:**
- `backend/src/database/schema.ts`
- `backend/src/database/init.ts` (добавить `ALTER TABLE` в секцию миграций)

---

## Описание инициатив

### И-1/2: ColumnMapper UX + синхронизация заголовков

Выпадающие списки показывают «кол.1, кол.2» без содержания. После сохранения заголовки таблицы не отражают назначения. Prop `columns: string[]` в ColumnMapper уже передаёт заголовочный текст — нужно его отображать.

### И-3: Статус «Готов» → «Требует проверки» / «Проверен»

Зелёный «Готов» создаёт ложное ощущение корректности. Разделить: «Требует проверки» (оранжевый, после парсинга) и «Проверен» (синий, после настройки пользователем).

### И-4: Триггерные наименования для пересчёта единиц

Труба/воздуховод (цена за шт, нужна за метр), изоляция (м³→м²), краска (банка→кг). Список триггеров расширяемый. Пересчёт только с подтверждением пользователя.

### И-5: Контроль НДС

Поля `vat_rate` и `prices_include_vat` есть в БД, но не используются в расчётах. Применить при отображении цен и в экспорте.

### И-6: Обнаружение скидок + подтверждение

Некоторые счета имеют скидку на итоговую сумму. Система обнаруживает слово «скидка» + процент, спрашивает пользователя, пересчитывает цены по позициям.

### И-7: Устранить ложные срабатывания парсера

Парсер иногда путает колонки или неправильно читает структуру. «доставка» в SKIP_ROW_KEYWORDS конфликтует с И-8. Порог детекции заголовков слишком низкий.

### И-8: Доставка — итог по проекту

Строки «доставка / транспортные расходы» пропускаются. Нужно фиксировать их отдельно и суммировать по проекту.

### И-9: Прайсы как отдельный тип документа

Прайсы != счета. Нужен отдельный тип загрузки, отдельное хранение, использование цен из прайсов в матчинге.

### И-11: Упаковки vs единицы

Два столбца кол-ва в счёте (штуки и упаковки). Пользователь явно выбирает «правильное» количество для расчётов.

### И-12: Откатить подтверждённый матч

Нет способа исправить ошибочное подтверждение. Кнопка ⟲ + endpoint unconfirm.

### И-13: Инкрементальное обновление спецификации

Запуск матчинга сбрасывает все результаты. Нужен режим «только для новых счётов, сохранить подтверждённое».

### И-14: Оригинал vs Аналог — две спецификации

При подборе аналогов нужно видеть разницу в стоимости между «оригинальной» и «аналоговой» спецификациями.

### И-15: Все поставщики видны в ручном матчинге

Поставщик, уже использованный на одной позиции, должен оставаться доступным для других позиций. **Проверено — уже реализовано корректно (этап 1).**

### И-16: Многострочные позиции DN15/DN20/DN25

Дочерние строки «DN15», «DN25» без родительского названия. Система должна собирать полное имя: «Клапан X DN15».

---

## Верификация (end-to-end тест)

1. **И-3:** Загрузить счёт → статус «Требует проверки». Пересобрать счёт → статус «Проверен».
2. **И-12:** Подтвердить матч → появляется ⟲. Нажать → строка переходит обратно в «ожидание».
3. **И-15:** Подтвердить матч с поставщиком А на позиции 1. Открыть ручной матч позиции 2 → поставщик А всё равно виден.
4. **И-1/2:** Открыть ColumnMapper → дропдауны показывают «кол.1 — Наименование товара». Сохранить → заголовки таблицы обновились.
5. **И-8:** Загрузить счёт с доставкой → строка доставки не в позициях. В шапке проекта — «Доставка: X ₽».
6. **И-6:** Загрузить счёт со словом «скидка» → жёлтый баннер. Нажать «Да» → цены пересчитались.
7. **И-9:** Загрузить документ как «Прайс» → в проекте секция «Прайсы», файл не попал в счета.
8. **И-4:** Добавить триггер «труба → м». Загрузить счёт с трубой → строка помечена ⚠. Подтвердить → `price` обновилась.
9. **И-14:** Подтвердить матч как аналог. В MatchingView переключить «Аналог» → итог использует аналоговые цены.
10. **И-16:** Загрузить спецификацию с DN-строками → показываются «Клапан X DN15», «Клапан X DN25» с отступом.
