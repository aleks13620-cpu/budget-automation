# План: Завершение интеграции GigaChat — 09.03.2026

## Статус на начало работ
- ✅ GigaChat API подключён (токен, health, chat endpoint)
- ✅ Excel-парсер улучшен (COLUMN_MARKERS, confidence, валидатор)
- ✅ Mistral в `backend/src/` отсутствует (проверено grep-ом)
- ⚠️ `backend/experimental/` содержит `mistral-vision-parser.js` и `test-runner.js`
- ❌ `gigachatParser.ts` не создан
- ❌ `invoiceRouter.ts` не создан

**Общая оценка: 8 человеко-часов (2 этапа по 4 ч)**

---

## Затронутые файлы

| Файл | Действие |
|---|---|
| `backend/experimental/mistral-vision-parser.js` | Удалить |
| `backend/experimental/test-runner.js` | Удалить |
| `backend/experimental/results/*.json` | Удалить |
| `backend/src/services/gigachatParser.ts` | Создать |
| `backend/src/services/invoiceRouter.ts` | Создать |
| `backend/src/routes/invoices.ts` | Обновить (использовать invoiceRouter) |
| `backend/scripts/test-invoice-processing.ts` | Создать |

**Не трогать:** `pdfParser.ts`, `excelInvoiceParser.ts`, `gigachatService.ts`

---

## Этап 1 (4 ч): Очистка + GigaChat парсер PDF

### 1.1 — Удаление Mistral

Удалить файлы из `backend/experimental/`:
- `mistral-vision-parser.js`
- `test-runner.js`
- `results/*.json` (5 файлов)

Папку `experimental/` и тестовые счета в `experimental/test-invoices/` — **оставить**.

### 1.2 — Создать `gigachatParser.ts`

Файл: `backend/src/services/gigachatParser.ts`

Функция `parsePdfWithGigaChat(filePath: string): Promise<GigaChatInvoiceResult>`:
- Читает PDF как текст через `pdf-parse` (уже используется в `pdfParser.ts`)
- Отправляет текст в `chatCompletion()` из `gigachatService.ts` с промптом INVOICE_PROMPT
- Парсит JSON из ответа (с retry при невалидном JSON — до 2 попыток)
- Возвращает `{ metadata: InvoiceMetadata, items: InvoiceRow[], rawResponse: string }`

**Промпт INVOICE_PROMPT** — извлечь из документа:
- `document_number`, `document_date`
- `supplier.name`, `supplier.inn`, `buyer.name`, `buyer.inn`
- `items[]`: position, article, name, quantity, unit, price, total
- `vat_included`, `vat_rate`, `vat_amount`, `total_with_vat`

Модель по умолчанию: `GigaChat-2` (указать в options)

Обработка ошибок:
- Retry при 429 (ждать 5 сек, 1 повтор)
- Таймаут через `maxTokens: 4096`
- Если JSON не парсится — бросить ошибку с `rawResponse` для отладки

---

## Этап 2 (4 ч): Роутер + Интеграция + Тесты

### 2.1 — Создать `invoiceRouter.ts`

Файл: `backend/src/services/invoiceRouter.ts`

```
processInvoiceFile(filePath, savedMapping?) → ProcessedInvoice
```

Логика маршрутизации:
- `.xlsx` / `.xls` → `parseExcelInvoice()` → если `category === 'C'` → fallback на GigaChat
- `.pdf` → сначала `parsePdfFile()` (существующий парсер) → если confidence низкий → fallback на `parsePdfWithGigaChat()`
- `.jpg/.png/.tiff/.bmp` → сразу `parsePdfWithGigaChat()` (изображения)

Тип `ProcessedInvoice`:
```typescript
{
  source: 'excel' | 'pdf' | 'image' | 'gigachat_fallback';
  category: 'A' | 'B' | 'C';
  metadata: InvoiceMetadata;
  items: InvoiceRow[];
  confidence: number;
  validation: ValidationResult;
  rawData?: string[][];
}
```

### 2.2 — Обновить `routes/invoices.ts`

- Импортировать `processInvoiceFile` из `invoiceRouter`
- Заменить прямые вызовы `parseExcelInvoice` / `parsePdfFile` на `processInvoiceFile`
- Сохранять `source` в поле БД (добавить колонку `parsing_source TEXT` в таблицу `invoices` если нет)
- Логировать `confidence` и `source` при сохранении

### 2.3 — Тестовый скрипт

Файл: `backend/scripts/test-invoice-processing.ts`

Скрипт берёт файлы из `backend/experimental/test-invoices/` (4 PDF + 2 Excel),
прогоняет через `processInvoiceFile()` и выводит таблицу:

```
Файл | Source | Category | Confidence | Позиций | Поставщик | Валидация
```

Запуск: `npx ts-node backend/scripts/test-invoice-processing.ts`

---

## Ключевые решения

| Решение | Причина |
|---|---|
| PDF сначала через старый парсер, потом GigaChat fallback | Экономия токенов — GigaChat только если нужно |
| Изображения сразу в GigaChat | У текстовых парсеров нет OCR |
| Excel Category C → GigaChat fallback | Низкий confidence = нечитаемая структура |
| Модель GigaChat-2 | Баланс скорости и точности, доступна на Freemium |

---

## Проверка после реализации

1. Запустить тестовый скрипт на файлах из `experimental/test-invoices/`
2. Убедиться что PDF парсится (хотя бы один успешно)
3. Убедиться что Excel Руфлекс.xls даёт category A или B
4. `npx tsc --noEmit` — 0 ошибок TypeScript
5. Загрузить счёт через UI → проверить что данные сохраняются в БД
