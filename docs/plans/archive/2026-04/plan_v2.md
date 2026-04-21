# Budget-Automation v2.0 — План реализации

> **Перед стартом:** зафиксировать текущее состояние проекта (см. Шаг 0).
> Статус каждого этапа обновляется по ходу: `[ ]` → `[x]`

---

## Шаг 0. Фиксация текущего состояния (откатная точка)

```bash
git add -A
git commit -m "chore: snapshot before v2.0 implementation"
git tag v1-before-v2 HEAD
```

Для отката к этой версии: `git checkout v1-before-v2`

---

## ЭТАП 1A — DB: Миграции и типы (~3-4ч)
> Фундамент. Всё остальное зависит от этого.

### Задачи
- [ ] `backend/src/database/schema.ts` — добавить 3 новые таблицы:
  - `invoice_items_history (id, invoice_id FK, version INT, items_snapshot TEXT, action TEXT, created_at)`
  - `specification_parser_configs (id, specification_id FK UNIQUE, header_row INT, column_mapping TEXT, merge_multiline INT, created_at, updated_at)`
  - `size_synonyms (id, canonical TEXT, synonym TEXT UNIQUE)`
  - Добавить индексы для всех трёх
- [ ] `backend/src/database/init.ts` — добавить в конец массива `migrations`:
  ```ts
  'ALTER TABLE specification_items ADD COLUMN article TEXT',
  'ALTER TABLE specification_items ADD COLUMN product_code TEXT',
  'ALTER TABLE specification_items ADD COLUMN marking TEXT',
  'ALTER TABLE specification_items ADD COLUMN type_size TEXT',
  'ALTER TABLE invoices ADD COLUMN vat_rate INTEGER DEFAULT 22',
  'ALTER TABLE specifications ADD COLUMN raw_data TEXT',
  ```
  + seeding синонимов (DN15↔Ду15, DN20↔Ду20, ..., DN100↔Ду100) после migrations loop
- [ ] `backend/src/types/specification.ts` — добавить в `SpecificationRow`:
  `article`, `product_code`, `marking`, `type_size` (все `string | null`)
- [ ] `backend/src/types/invoice.ts` — добавить в `InvoiceMetadata`:
  `vat_rate: number | null`

### Тест
```bash
npx ts-node backend/src/database/init.ts
# Ожидаем: Created tables: ..., invoice_items_history, specification_parser_configs, size_synonyms
# Ожидаем: новые колонки в specification_items, invoices, specifications
sqlite3 database/budget_automation.db ".schema specification_items"
sqlite3 database/budget_automation.db "SELECT count(*) FROM size_synonyms"
# Ожидаем: >0 (засеяны синонимы)
```

### Коммит
```bash
git add -A
git commit -m "feat(db): add migrations for v2.0 — spec columns, vat_rate, new tables"
```

---

## ЭТАП 1B — Парсер спецификаций: новые колонки + многострочность (~3-4ч)

### Задачи
- [ ] `backend/src/services/excelParser.ts`:
  - Добавить в `ColumnMapping`: `article`, `product_code`, `marking`, `type_size` (все `number | null`)
  - Добавить в `HEADER_KEYWORDS`:
    ```ts
    article:      ['артикул', 'арт.', 'арт ', 'sku'],
    product_code: ['код продукции', 'код товара', 'код позиции'],
    marking:      ['маркировка', 'обозначение', 'марк'],
    type_size:    ['типоразмер', 'типо-размер', 'размер'],
    ```
    ⚠️ Убрать `'артикул'` из `equipment_code` (конфликт)
  - В `detectHeaderRow` добавить новые поля в инициализацию `mapping`
  - В `parseExcelFile` → `items.push({...})` добавить чтение 4 новых колонок
  - Добавить функцию `mergeMultilineItems` (ПЕРЕД `linkDnChildren`):
    ```ts
    // Признак продолжения строки: нет номера, нет кол-ва, нет ед.изм., не DN-строка
    // Если продолжение — дописать к previous.name, НЕ добавлять как отдельную запись
    ```
  - Исправить порядок вызовов в конце `parseExcelFile`:
    ```ts
    const merged = mergeMultilineItems(items);
    linkDnChildren(merged);
    return { items: merged, errors, totalRows, skippedRows };
    ```
- [ ] `backend/src/routes/specifications.ts`:
  - В INSERT `specification_items` добавить колонки `article, product_code, marking, type_size`
  - Передавать значения из `item.article`, `item.product_code`, `item.marking`, `item.type_size`

### Тест
```bash
# 1. Загрузить спецификацию с колонкой "Артикул"
# Проверить: SELECT article FROM specification_items WHERE article IS NOT NULL LIMIT 5
# 2. Подготовить тестовый Excel: строка с полным наименованием + следующая без №/кол-ва/ед.изм.
# Проверить: наименования объединены в одну строку
# 3. Убедиться, что DN-ряд (DN15/DN20/DN25) по-прежнему создаёт отдельные позиции
```

### Коммит
```bash
git add -A
git commit -m "feat(spec-parser): multi-line merge, new columns (article, product_code, marking, type_size)"
```

---

## ЭТАП 1C — Улучшения парсинга счетов: НДС + артикулы (~3-4ч)

### Задачи
- [ ] `backend/src/services/gigachatParser.ts`:
  - В `INVOICE_PROMPT` добавить правило 7 (цены С НДС):
    ```
    7. ЦЕНЫ С НДС ИЛИ БЕЗ НДС:
       - Если есть две ценовые колонки "без НДС" и "с НДС" — ВСЕГДА бери "с НДС" для price
       - Аналогично для суммы: "без НДС" и "с НДС" — бери "с НДС" для total
       - Добавь "vat_included": true в ответ если взяты цены с НДС
    ```
  - Добавить `vat_included?: boolean` в `GigaChatParsedJSON`
  - В `mapMetadata` добавить:
    ```ts
    vat_rate: (typeof data.vat_rate === 'number' && data.vat_rate > 0) ? data.vat_rate : 22,
    ```
  - Добавить функции `isValidArticle` + `validateArticleNameSwap`:
    ```ts
    // Артикул валиден: длина ≤30, нет длинных рус. слов (>10 букв подряд)
    // Если article не валиден, а name валиден как артикул → поменять местами
    ```
  - Вызвать `validateArticleNameSwap` в конце `mapItems()` перед `return mapped`
- [ ] `backend/src/routes/invoices.ts`:
  - В INSERT счёта добавить `vat_rate` → значение из `result.metadata?.vat_rate ?? 22`

### Тест
```bash
# 1. Распарсить счёт без колонки НДС
#    SELECT vat_rate FROM invoices ORDER BY id DESC LIMIT 1
#    Ожидаем: 22
# 2. Распарсить счёт где GigaChat перепутал артикул/наименование
#    Проверить: короткий код → article, длинное слово → name
```

### Коммит
```bash
git add -A
git commit -m "feat(invoice-parser): vat_rate default 22%, prices with VAT priority, article/name swap fix"
```

---

## ЭТАП 1D — Сопоставление: приоритет сущности + артикул (~3-4ч)

### Задачи
- [ ] `backend/src/services/matcher.ts`:
  - Добавить в `SpecItemRow`: `article: string | null`, `product_code: string | null`
  - В `SPEC_ITEMS_SQL` добавить `article, product_code` в SELECT
  - Добавить новые тиры ДО текущего "1. Exact article match":
    ```ts
    // Tier 0: spec.article == inv.article → confidence 0.98
    // Tier 0b: spec.product_code == inv.article → confidence 0.95
    ```
  - Добавить функцию `extractEntityWords(text: string): string`:
    ```ts
    // Возвращает слова ДО первого DN/Ду/числового параметра
    // "Клапан вентиляционный DN25" → "клапан вентиляционный"
    ```
  - В tier "Name similarity" после вычисления `nameSim` добавить штраф:
    ```ts
    // Если entity_sim < 0.4 → confidence *= 0.5
    // Клапан вентиляционный ≠ Клапан балансировочный → штраф
    ```

### Тест
```bash
# Запустить сопоставление на тестовом проекте
# Проверить:
# 1. Spec article "KV-25" vs invoice article "KV-25" → confidence = 0.98
# 2. "Клапан вентиляционный DN25" vs "Клапан балансировочный DN25" → confidence < 0.4
# 3. "Кран шаровый DN15" vs "Кран шаровый Ду15" → хорошее совпадение (через синонимы — уже в БД)
# GET /api/projects/1/match → проверить результаты
```

### Коммит
```bash
git add -A
git commit -m "feat(matcher): entity-priority penalty, spec article matching at 0.98"
```

---

## ЭТАП 2A — Редактор спецификации: backend (~3-4ч)

### Задачи
- [ ] `backend/src/services/excelParser.ts` — добавить экспортируемую функцию:
  ```ts
  export function parseFromRawData(
    rawRows: string[][],
    headerRow: number,
    mapping: ColumnMapping,
    mergeMultiline: boolean
  ): ParseResult
  // Использует переданный mapping вместо detectHeaderRow
  // Запускает mergeMultilineItems если mergeMultiline=true
  // Запускает linkDnChildren
  ```
- [ ] `backend/src/routes/specifications.ts` — в upload-обработчике:
  - После `parseExcelFile` — сохранять сырые данные в `specifications.raw_data`:
    ```ts
    const rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // добавить JSON.stringify(rawData) в INSERT INTO specifications
    ```
  - Добавить 3 новых эндпоинта:

  **`GET /api/specifications/:id/raw-data`**
  ```
  SELECT raw_data, file_name FROM specifications WHERE id = ?
  SELECT * FROM specification_parser_configs WHERE specification_id = ?
  return { rows: JSON.parse(raw_data), fileName, config: parserConfig | null }
  ```

  **`POST /api/specifications/:id/reparse`**
  ```
  body: { headerRow, columnMapping, mergeMultiline }
  → parseFromRawData(rawRows, headerRow, mapping, mergeMultiline)
  → DELETE FROM specification_items WHERE specification_id = id
  → INSERT новые позиции (транзакция)
  → UPSERT specification_parser_configs
  ```

  **`POST /api/specifications/:id/parser-config`**
  ```
  UPSERT INTO specification_parser_configs
  ```

### Тест
```bash
# 1. Загрузить спецификацию
# 2. GET /api/specifications/1/raw-data → проверить что rows возвращаются
# 3. POST /api/specifications/1/reparse с новым headerRow → позиции обновились
# 4. POST /api/specifications/1/reparse с mergeMultiline=false → позиции НЕ объединяются
```

### Коммит
```bash
git add -A
git commit -m "feat(spec-editor): backend endpoints — raw-data, reparse, parser-config"
```

---

## ЭТАП 2B — Редактор спецификации: frontend (~3-4ч)

### Задачи
- [ ] Создать `frontend/src/components/SpecColumnMapper.tsx`:
  - По образу `ColumnMapper.tsx`
  - Поля: `position_number, name, article, product_code, marking, type_size, characteristics, manufacturer, unit, quantity`
  - Чекбокс "Объединять продолжения строк" (`mergeMultiline`)
- [ ] Создать `frontend/src/pages/SpecificationEditor.tsx`:
  - По образу `InvoicePreview.tsx`
  - Загрузка: `GET /api/specifications/:id/raw-data`
  - Таблица сырых данных (первые 30 строк, строка заголовка подсвечена)
  - `SpecColumnMapper` для маппинга колонок
  - Кнопки: "Пересобрать позиции" → `POST /api/specifications/:id/reparse`
  - Кнопки: "Сохранить конфиг" → `POST /api/specifications/:id/parser-config`
  - Предпросмотр: таблица результата (первые 20 позиций)
- [ ] `frontend/src/App.tsx`:
  - Добавить `'spec-editor'` в тип `Page`
  - Добавить `specId: number | null` в state
  - Добавить `goToSpecEditor(id: number)` и роутинг на `<SpecificationEditor>`
  - Добавить breadcrumb для spec editor
- [ ] `frontend/src/pages/ProjectDetail.tsx`:
  - Добавить кнопку "Редактировать" у каждой спецификации

### Тест
```bash
# Запустить фронтенд: npm run dev
# 1. Открыть проект → нажать "Редактировать" у спецификации
# 2. Проверить: отображается таблица сырых данных
# 3. Изменить headerRow → нажать "Пересобрать" → позиции изменились
# 4. Сохранить конфиг → перезагрузить страницу → конфиг сохранился
```

### Коммит
```bash
git add -A
git commit -m "feat(spec-editor): frontend — SpecificationEditor, SpecColumnMapper, routing"
```

---

## ЭТАП 2C — История версий счёта + расчёт цен (~3-4ч)

### Задачи
- [ ] `backend/src/routes/invoices.ts`:
  - Добавить helper `saveSnapshot(invoiceId, action, db)`:
    ```ts
    // Получить max version → INSERT invoice_items_history
    // Вызывать перед любым изменением позиций
    ```
  - Вызвать `saveSnapshot` перед: reparse, manual item edit, calculate-prices
  - Добавить `GET /api/invoices/:id/history`:
    ```
    SELECT id, version, action, created_at,
           json_array_length(items_snapshot) as item_count
    FROM invoice_items_history WHERE invoice_id = ? ORDER BY version DESC
    ```
  - Добавить `POST /api/invoices/:id/rollback`:
    ```
    body: { version }
    → saveSnapshot(id, 'before_rollback', db)
    → SELECT items_snapshot FROM invoice_items_history WHERE invoice_id=? AND version=?
    → DELETE FROM invoice_items WHERE invoice_id = ?
    → INSERT новые позиции из snapshot
    ```
  - Добавить `POST /api/invoices/:id/calculate-prices`:
    ```
    → saveSnapshot(id, 'calculate_prices', db)
    → UPDATE invoice_items SET price = ROUND(amount/quantity, 2)
       WHERE invoice_id=? AND price IS NULL AND amount IS NOT NULL
       AND quantity IS NOT NULL AND quantity > 0
    ```
- [ ] `frontend/src/pages/InvoicePreview.tsx`:
  - Кнопка "История" (в CategoryA панели) → открывает модальное окно
  - Модальное окно: список версий (version, action, дата, кол-во позиций) + кнопка "Откатить"
  - Кнопка "Рассчитать цены (сумма ÷ кол-во)" → `POST /api/invoices/:id/calculate-prices`

### Тест
```bash
# 1. Распарсить счёт
# 2. Изменить позицию вручную
# 3. GET /api/invoices/1/history → проверить наличие версий
# 4. POST /api/invoices/1/rollback { version: 1 } → позиции восстановлены
# 5. "Рассчитать цены" → для позиций с amount но без price — price посчитана
```

### Коммит
```bash
git add -A
git commit -m "feat(invoices): version history, rollback, calculate-prices button"
```

---

## ЭТАП 2D — Синонимы размеров в сопоставлении (~2-3ч)

### Задачи
- [ ] `backend/src/services/matcher.ts`:
  - Добавить `normalizeSizeTerms(text)` — заменяет синонимы на canonical через кэш из БД
  - Добавить `getSynonymMap()` — один раз загружает из `size_synonyms`, кэширует в `Map`
  - В `normalizeForMatching` добавить в начале: `s = normalizeSizeTerms(s);`

### Тест
```bash
# Создать спецификацию с "Кран шаровый Ду15"
# Создать счёт с "Кран шаровый DN15"
# Запустить сопоставление → они должны матчиться
# GET /api/projects/1/match → проверить confidence > 0.6
```

### Коммит
```bash
git add -A
git commit -m "feat(matcher): size synonyms normalization (Ду15 ↔ DN15)"
```

---

## ЭТАП 3 — Улучшения III (~3-4ч) [Этап 3 по ТЗ]

### Задачи
- [ ] **C4:** `matcher.ts` — `slice(0,3)→slice(0,5)`, порог `>= 0.4` → `>= 0.3`
- [ ] **B5:** `invoiceRouter.ts` — если после GigaChat `items.length === 0`: явно ставить `category: 'C'`
- [ ] **B7:** `InvoicePreview.tsx` + `invoices.ts` — переключатель "Цена без скидки, сумма со скидкой" + endpoint
- [ ] **B4:** `InvoicePreview.tsx` CategoryB — не разрушать табличную структуру при ручном редактировании
- [ ] **A5:** Таблица `specification_parse_rules` + сохранение исправлений из редактора спецификации

### Тест
```bash
# C4: запустить матчинг — кандидатов стало 5 вместо 3
# B5: загрузить счёт где парсер вернул 0 позиций + GigaChat тоже 0 → parsing_category = 'C'
```

### Коммит
```bash
git add -A
git commit -m "feat: stage 3 — more match candidates, category-C fallback, discount mode"
```

---

## Итоговая сводка

| Этап | Содержание | ~Часов | Статус |
|------|-----------|--------|--------|
| 0 | Git snapshot (откатная точка) | 0.1 | [ ] |
| 1A | DB миграции + типы | 3-4 | [ ] |
| 1B | Парсер спецификаций | 3-4 | [ ] |
| 1C | Парсинг счетов (НДС, артикул) | 3-4 | [ ] |
| 1D | Сопоставление (сущность + артикул) | 3-4 | [ ] |
| 2A | Редактор спецификации backend | 3-4 | [ ] |
| 2B | Редактор спецификации frontend | 3-4 | [ ] |
| 2C | История версий + расчёт цен | 3-4 | [ ] |
| 2D | Синонимы размеров | 2-3 | [ ] |
| 3 | Улучшения III | 3-4 | [ ] |
| **Итого** | | **~30-37ч** | |

---

## Связь с исходным ТЗ

| Пункт ТЗ | Этап плана |
|----------|-----------|
| A1 Многострочные позиции | 1B |
| A2 Размерный ряд | 1B (уже работает, правильный порядок) |
| A3 Доп. колонки спецификации | 1A + 1B |
| A4 Редактор спецификации | 2A + 2B |
| A5 Обучение на исправлениях | 3 |
| B1 Цена с НДС | 1C |
| B2 НДС 22% по умолчанию | 1C |
| B3 Валидация артикул/наименование | 1C |
| B4 Сохранение структуры | 3 |
| B5 Fallback → category C | 3 |
| B6 Кнопка расчёта цены | 2C |
| B7 Режим цена/сумма со скидкой | 3 |
| C1 Приоритет сущности | 1D |
| C2 Синонимы размеров | 1A (seeding) + 2D (matcher) |
| C3 Все атрибуты для матчинга | 1D |
| C4 Больше кандидатов | 3 |
| D1 История версий | 2C |
| E1-E3 Изменения БД | 1A |
