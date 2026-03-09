# Архитектурный снимок проекта — 09.03.2026

> Создан перед началом доработки Excel-парсера (улучшение COLUMN_MARKERS, confidence score, валидатор).

---

## Структура проекта (дерево папок)

```
budget-automation/
├── backend/
│   ├── docs/                              ← Документация (создана 09.03.2026)
│   ├── src/
│   │   ├── database/
│   │   │   ├── connection.ts
│   │   │   ├── index.ts
│   │   │   ├── init.ts
│   │   │   └── schema.ts
│   │   ├── routes/
│   │   │   ├── export.ts
│   │   │   ├── invoices.ts
│   │   │   ├── matching.ts
│   │   │   ├── priceLists.ts
│   │   │   ├── specifications.ts
│   │   │   ├── suppliers.ts
│   │   │   └── unitTriggers.ts
│   │   ├── services/
│   │   │   ├── excelInvoiceParser.ts
│   │   │   ├── excelParser.ts
│   │   │   ├── matcher.ts
│   │   │   ├── pdfParser.ts
│   │   │   └── sectionDetector.ts
│   │   ├── types/
│   │   │   ├── invoice.ts
│   │   │   └── specification.ts
│   │   └── index.ts
│   ├── experimental/
│   │   ├── mistral-vision-parser.js
│   │   ├── test-runner.js
│   │   ├── results/
│   │   └── test-invoices/
│   ├── dist/
│   ├── .env
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── InvoicePreview.tsx
│       │   ├── MatchingView.tsx
│       │   ├── ProjectDetail.tsx
│       │   ├── ProjectList.tsx
│       │   └── UnitTriggers.tsx
│       ├── components/
│       │   ├── ColumnMapper.tsx
│       │   ├── ManualMatchFromSpec.tsx
│       │   ├── ManualMatchModal.tsx
│       │   └── MatchTable.tsx
│       ├── api.ts
│       ├── App.tsx
│       └── main.tsx
├── database/
│   └── budget_automation.db
└── data/
    └── uploads/
```

---

## Файлы backend/src/ — описание

| Файл | Описание |
|---|---|
| `index.ts` | Главный сервер Express 5, монтирует все роуты, статические файлы фронта |
| `database/connection.ts` | Инициализация better-sqlite3, WAL mode, foreign keys ON |
| `database/init.ts` | Создание таблиц при старте (CREATE TABLE IF NOT EXISTS) |
| `database/schema.ts` | SQL-схема всех 12 таблиц и индексов |
| `database/index.ts` | Реэкспорт connection |
| `routes/specifications.ts` | CRUD спецификаций, загрузка Excel-смет, bulk-upload с авто-определением раздела |
| `routes/invoices.ts` | Загрузка PDF/Excel счетов, preview, reparse, bulk-upload, статусы, скидки, ручной ввод |
| `routes/suppliers.ts` | CRUD поставщиков, конфиги парсера, настройки НДС |
| `routes/matching.ts` | Запуск матчинга, подтверждение/отклонение, ручной матч, summary |
| `routes/export.ts` | Экспорт проекта в Excel с НДС и subtotals |
| `routes/priceLists.ts` | Загрузка и парсинг прайс-листов |
| `routes/unitTriggers.ts` | CRUD триггеров конвертации единиц измерения |
| `services/excelInvoiceParser.ts` | Парсинг Excel-счетов: extractExcelRawRows, parseExcelInvoice, preview |
| `services/excelParser.ts` | Парсинг Excel-смет (иерархические позиции) |
| `services/pdfParser.ts` | Парсинг PDF-счетов: extractRawRows, parsePdfFile, detectColumns, metadata |
| `services/matcher.ts` | Алгоритм матчинга (4 уровня), нормализация, правила |
| `services/sectionDetector.ts` | Авто-определение раздела по имени файла и позициям |
| `types/invoice.ts` | Интерфейсы InvoiceRow, InvoiceParseResult |
| `types/specification.ts` | Интерфейсы SpecificationRow, ParseResult |

---

## package.json (зависимости)

```json
{
  "name": "budget-automation-backend",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "better-sqlite3": "^12.6.2",
    "canvas": "^3.2.1",
    "cors": "^2.8.6",
    "dotenv": "^17.2.4",
    "express": "^5.2.1",
    "multer": "^2.0.2",
    "pdf-parse": "^2.4.5",
    "pdfjs-dist": "^3.11.174",
    "string-similarity": "^4.0.4",
    "xlsx": "^0.18.5"
  }
}
```

---

## Схема базы данных (из schema.ts)

```sql
-- 12 таблиц:

projects           (id, name, description, created_at, updated_at)
specifications     (id, project_id, section, file_name, created_at)
specification_items(id, project_id, specification_id, position_number, name,
                    characteristics, equipment_code, manufacturer, unit, quantity,
                    section, created_at)
suppliers          (id, name UNIQUE, contact_info, created_at)
invoices           (id, project_id, supplier_id, invoice_number, invoice_date,
                    file_name, file_path, total_amount, status, created_at)
invoice_items      (id, invoice_id, article, name, unit, quantity, price, amount,
                    row_index, created_at)
matching_rules     (id, specification_pattern, invoice_pattern, confidence,
                    is_analog, times_used, created_at, updated_at)
matched_items      (id, specification_item_id, invoice_item_id, confidence,
                    match_type, is_confirmed, is_selected, created_at)
price_lists        (id, project_id, supplier_id, file_name, file_path, status,
                    parser_config JSON, created_at)
price_list_items   (id, price_list_id, article, name, unit, price, row_index,
                    created_at)
unit_conversion_triggers (id, keyword, from_unit, to_unit, description, created_at)
supplier_parser_configs  (id, supplier_id UNIQUE, config JSON, created_at, updated_at)

-- Примечание: в продакшн-базе присутствуют дополнительные колонки
-- (parsing_category, is_delivery, needs_unit_review и др.),
-- добавленные миграциями после начальной схемы.
```

---

## Текущий flow обработки счетов

```
POST /api/projects/:id/invoices
        │
        ▼
  Multer (файл → data/uploads/)
        │
  Определение типа (.pdf / .xlsx / .xls)
        │
  ┌─────┴──────┐
  │            │
pdfParser  excelInvoiceParser
  │            │
  └─────┬──────┘
        │
  extractRawRows() / extractExcelRawRows()
  → string[][]
        │
  extractMetadataFromRows(rows)
  → { invoiceNumber, invoiceDate, supplierName, totalAmount, bik, corrAccount }
        │
  Есть savedMapping (supplier_parser_configs)?
  ├─ Да → применить маппинг напрямую
  └─ Нет → detectColumns(rows) → ColumnMapping или null
        │
  parseTableData(rows, mapping, headerRow+1)
  → { items: InvoiceRow[], errors, skipped }
        │
  categorize: A (items найдены) / B (колонки не найдены) / C (garbled PDF)
        │
  Сохранить в invoices + invoice_items
        │
  Запустить matching (опционально)
```

---

## Состояние excelInvoiceParser.ts (первые 100 строк)

```typescript
import XLSX from 'xlsx';
import { InvoiceRow, InvoiceParseResult } from '../types/invoice';
import { detectDiscount } from './pdfParser';
import { detectColumns, parseTableData, parsePrice, SavedMapping, extractMetadataFromRows } from './pdfParser';

function normalizeRowWidths(rows: string[][]): string[][] { ... }

export function extractExcelRawRows(filePath: string): string[][] {
  // Читает Excel, сохраняет пустые колонки, возвращает string[][]
}

export function extractExcelPreviewData(filePath: string, sheetIndex = 0, maxRows = 200): {
  rows: string[][];
  sheetNames: string[];
  totalRows: number;
} { ... }

export function parseExcelInvoice(filePath: string, savedMapping?: SavedMapping): InvoiceParseResult {
  // 1. extractExcelRawRows
  // 2. extractMetadataFromRows (базовые метаданные)
  // 3. savedMapping? → применить / detectColumns
  // 4. parseTableData → items
  // 5. Вернуть InvoiceParseResult
}
```

## Состояние pdfParser.ts (первые 100 строк)

```typescript
import fs from 'fs';
import { InvoiceRow, InvoiceParseResult } from '../types/invoice';
const { PDFParse } = require('pdf-parse');

export interface ColumnMapping {
  article: number | null;
  name: number | null;
  unit: number | null;
  quantity: number | null;
  quantity_packages: number | null;
  price: number | null;
  amount: number | null;
}

export const COLUMN_KEYWORDS: Record<keyof ColumnMapping, string[]> = {
  article:  ['артикул', 'article', 'код', 'арт.', 'арт', ...],
  name:     ['наименование', 'товар', 'название', ...],
  quantity: ['количество', 'кол-во', 'qty', ...],
  quantity_packages: ['кол-во уп', 'упак', ...],
  price:    ['цена', 'price', 'цена за ед', ...],
  amount:   ['сумма', 'total', 'стоимость', ...],
  unit:     ['ед.', 'unit', 'ед. изм', ...],
};

export function normalizeText(text: unknown): string { ... }
export function parsePrice(value: string | null | undefined): number | null { ... }

export function detectColumns(rows: string[][]): { mapping: ColumnMapping; headerRowIndex: number } | null {
  // Ищет строку-заголовок в первых 30 строках
  // Требует: name + ещё минимум 1 колонка
}
```

---

*Документ создан автоматически перед началом доработки Excel-парсера (этап 1.1 плана exel.parsing.9.03.md)*
