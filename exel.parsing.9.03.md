# План: Улучшение Excel-парсера счетов

## Context

Текущий Excel-парсер (`excelInvoiceParser.ts`) использует `detectColumns` из `pdfParser.ts`, который ищет заголовки только по жёстко заданным ключевым словам без оценки уверенности. Метаданные (ИНН, покупатель) не извлекаются из Excel. Нет валидации числовых данных. ТЗ требует: расширенный словарь маркеров, confidence score, валидатор, сохранение обратной совместимости с `supplier_parser_configs`.

**Общая оценка: 12 человеко-часов (3 этапа по 4 ч)**

---

## Затронутые файлы

| Файл | Изменение |
|---|---|
| `backend/docs/architecture_project_09_03_2026.md` | Создать (новый) |
| `backend/src/services/excelInvoiceParser.ts` | Расширить (COLUMN_MARKERS, findColumnByMarkers, возвращаемый тип) |
| `backend/src/services/invoiceValidator.ts` | Создать (новый) |
| `backend/src/types/invoice.ts` | Добавить новые интерфейсы |
| `backend/src/routes/invoices.ts` | Обновить обработку нового типа ответа parseExcelInvoice |

**Не трогать:** `pdfParser.ts` (не ломаем PDF-флоу), `COLUMN_KEYWORDS` (PDF-парсер остаётся без изменений).

---

## Этап 1 (4 ч): Архитектурный снимок + Расширенный словарь маркеров

### 1.1 — Часть 0: Создать архитектурный документ
Файл: `backend/docs/architecture_project_09_03_2026.md`
- Дерево папок проекта
- Список всех файлов `backend/src/` с кратким описанием
- Содержимое `package.json`
- Схема БД из `schema.ts`
- Текущий flow обработки счетов
- Первые 100 строк `excelInvoiceParser.ts` и `pdfParser.ts`

### 1.2 — Часть 1: COLUMN_MARKERS + findColumnByMarkers
Файл: `backend/src/services/excelInvoiceParser.ts`

Добавить в начало файла (не удалять импорты и существующий код):

```typescript
// Расширенный словарь маркеров колонок (только для Excel)
const COLUMN_MARKERS = {
  position:   { patterns: ['№', '№ п/п', 'n', 'no', 'п/п', 'поз', 'позиция', '#'],       valueType: 'integer', priority: 1 },
  article:    { patterns: ['артикул', 'арт', 'арт.', 'код', 'code', 'sku', 'каталожный', 'номенклатура'], valueType: 'string',  priority: 2 },
  name:       { patterns: ['наименование', 'название', 'товар', 'описание', 'товары', 'работы', 'услуги', 'продукция'], valueType: 'string', priority: 3, required: true },
  quantity:   { patterns: ['кол-во', 'количество', 'кол.', 'шт', 'qty', 'count', 'ед'],   valueType: 'number',  priority: 4, required: true },
  unit:       { patterns: ['ед.', 'ед', 'единица', 'ед. изм.', 'ед.изм', 'unit', 'изм'],  valueType: 'string',  priority: 5 },
  price:      { patterns: ['цена', 'стоимость', 'руб/ед', 'за ед', 'price', 'цена за ед'], valueType: 'number',  priority: 6, required: true },
  total:      { patterns: ['сумма', 'итого', 'всего', 'amount', 'total'],                  valueType: 'number',  priority: 7, required: true },
  vatRate:    { patterns: ['ставка ндс', 'ндс %', 'ндс', 'vat', 'налог'],                 valueType: 'percent', priority: 8 },
  vatAmount:  { patterns: ['сумма ндс', 'ндс руб', 'ндс сумма'],                          valueType: 'number',  priority: 9 },
};

function findColumnByMarkers(
  headerRow: string[],
  marker: { patterns: string[]; valueType: string; priority: number }
): { index: number; confidence: number } | null {
  let best: { index: number; confidence: number } | null = null;
  for (let i = 0; i < headerRow.length; i++) {
    const cell = headerRow[i].toLowerCase().trim();
    if (!cell) continue;
    for (const pattern of marker.patterns) {
      const p = pattern.toLowerCase();
      if (cell === p) {
        if (!best || 100 > best.confidence) best = { index: i, confidence: 100 };
        break;
      } else if (cell.includes(p)) {
        const conf = Math.round(70 + (p.length / cell.length) * 20);
        if (!best || conf > best.confidence) best = { index: i, confidence: conf };
      }
    }
  }
  return best;
}
```

Добавить функцию `mapColumnsWithConfidence(headerRow)` которая вызывает `findColumnByMarkers` для каждого маркера и возвращает `{ mapping, confidenceByColumn }`.

**Обратная совместимость:** оригинальная `detectColumns` из `pdfParser.ts` остаётся в импортах и используется как fallback если `savedMapping` не задан.

---

## Этап 2 (4 ч): InvoiceMetadata + Confidence Score

### 2.1 — Часть 2: Расширенные метаданные
Файл: `backend/src/types/invoice.ts` — добавить интерфейс:

```typescript
export interface InvoiceMetadata {
  documentNumber: string | null;
  documentDate: string | null;
  supplierName: string | null;
  supplierINN: string | null;      // Новое: ИНН поставщика
  buyerName: string | null;        // Новое: покупатель
  buyerINN: string | null;         // Новое: ИНН покупателя
  totalWithVat: number | null;
  vatAmount: number | null;        // Новое: сумма НДС
}
```

Файл: `backend/src/services/excelInvoiceParser.ts` — добавить `METADATA_PATTERNS` и `extractExcelMetadata(rows)`:
- ИНН: `/ИНН[:\s]*(\d{10}|\d{12})/i`
- Покупатель: `/(?:покупатель|заказчик|плательщик)[:\s]*([^\n,]+)/i`
- Сумма НДС: `/(?:в т\.?ч\.? ндс|ндс)[:\s]*([\d\s]+[,.]?\d*)/i`
- Сканировать первые 30 строк (аналогично существующей `extractMetadataFromRows` из pdfParser)
- Вызывать существующую `extractMetadataFromRows` для базовых полей, дополнять новыми

### 2.2 — Часть 3: Confidence Score
Файл: `backend/src/types/invoice.ts` — добавить:

```typescript
export interface ParsingConfidence {
  headerDetection: number;
  columnMapping: Record<string, number>;
  metadataExtraction: number;
  dataExtraction: number;
  overall: number;
}
```

Файл: `backend/src/services/excelInvoiceParser.ts` — добавить:
- `calculateConfidence(headerRow, columnMapping, metadata, items): ParsingConfidence`
  - `headerDetection`: 100 если найдены все required колонки (name, quantity, price, total), иначе 25 за каждую
  - `columnMapping`: среднее confidence из `findColumnByMarkers` по найденным колонкам
  - `metadataExtraction`: (найденных полей / 8) * 100
  - `dataExtraction`: (строк с price && quantity / всего строк) * 100
  - `overall`: взвешенное среднее (header 30%, columns 30%, data 40%)
- `categorizeByConfidence(confidence): 'A' | 'B' | 'C'`
  - A: overall >= 80
  - B: overall >= 50
  - C: < 50

---

## Этап 3 (4 ч): Валидатор + Интеграция

### 3.1 — Часть 4: invoiceValidator.ts
Файл: `backend/src/services/invoiceValidator.ts` — создать:

Интерфейсы: `ValidationResult`, `ValidationError` (SUM_MISMATCH, MISSING_REQUIRED, INVALID_DATA), `ValidationWarning` (INVALID_INN, MISSING_PRICE, ZERO_QUANTITY, SUSPICIOUS_TOTAL)

Функции:
- `isValidINN(inn: string): boolean` — контрольная сумма для 10-значного и 12-значного ИНН
- `validateInvoice(items, metadata): ValidationResult`
  - Проверка 1: `Σ(item.total) ≈ metadata.totalWithVat` (допуск 1 руб)
  - Проверка 2: ИНН поставщика корректен
  - Проверка 3: price > 0 для каждой позиции
  - Проверка 4: quantity > 0 для каждой позиции
  - Проверка 5: `price × quantity ≈ total` (допуск 1 руб)

### 3.2 — Часть 5: Обновить parseExcelInvoice
Файл: `backend/src/types/invoice.ts` — добавить:

```typescript
export interface ExcelParseResult {
  category: 'A' | 'B' | 'C';
  metadata: InvoiceMetadata;
  items: InvoiceRow[];
  confidence: ParsingConfidence;
  validation: ValidationResult;
  rawData?: string[][];
}
```

Файл: `backend/src/services/excelInvoiceParser.ts` — обновить `parseExcelInvoice`:
- Возвращает `ExcelParseResult` вместо `InvoiceParseResult`
- Порядок: extractExcelRawRows → extractExcelMetadata → detectColumns/mapColumnsWithConfidence → parseTableData → calculateConfidence → validateInvoice → categorizeByConfidence
- `savedMapping` по-прежнему поддерживается (обратная совместимость)
- Для категории B/C добавить `rawData` в результат

Файл: `backend/src/routes/invoices.ts` — обновить места вызова `parseExcelInvoice`:
- Маппинг `ExcelParseResult` → поля таблицы `invoices` (category, parsing_category)
- Маппинг `ExcelParseResult.metadata` → `invoice_number`, `invoice_date`, `supplier_name`, `total_amount`
- Логировать confidence.overall при сохранении

---

## Ключевые решения

| Решение | Причина |
|---|---|
| `COLUMN_MARKERS` только в `excelInvoiceParser.ts` | Не трогаем PDF-флоу, `COLUMN_KEYWORDS` в pdfParser остаётся |
| `ExcelParseResult` — новый тип, не заменяет `InvoiceParseResult` | PDF-парсер продолжает возвращать `InvoiceParseResult` |
| `extractMetadataFromRows` остаётся, расширяем поверх неё | Не дублируем regex-логику, переиспользуем |
| `savedMapping` — полная обратная совместимость | Все сохранённые конфиги поставщиков продолжают работать |

---

## Проверка после реализации

1. Загрузить тестовые Excel-счета из `backend/experimental/test-invoices/` через UI
2. Убедиться что `parsing_category` в БД = A/B/C соответствует confidence
3. Загрузить счёт с известным поставщиком (сохранённый `supplier_parser_config`) → должен применяться savedMapping
4. Проверить `GET /api/invoices/:id` → ответ содержит валидность и confidence
5. Убедиться что PDF-счета парсятся без изменений (регрессия)
