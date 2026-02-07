# Budget Automation

Система автоматизации обработки счетов для инженерных сетей.
Сопоставляет позиции спецификации заказчика с позициями из счетов поставщиков, формирует итоговую спецификацию с ценами.

## Стек технологий

- **Backend:** Node.js, Express 5, TypeScript
- **Frontend:** React 19, Vite, TypeScript
- **База данных:** SQLite (better-sqlite3)
- **Парсинг:** xlsx (Excel), pdf-parse (PDF)
- **Сопоставление:** string-similarity (Dice coefficient)

## Структура проекта

```
budget-automation/
├── backend/          # Express API сервер
│   └── src/
│       ├── index.ts              — точка входа, project CRUD
│       ├── database/             — SQLite schema, connection
│       ├── routes/
│       │   ├── specifications.ts — загрузка спецификаций
│       │   ├── invoices.ts       — загрузка и парсинг счетов
│       │   ├── matching.ts       — сопоставление, подтверждение
│       │   ├── export.ts         — экспорт в Excel
│       │   └── suppliers.ts      — поставщики, настройки парсера
│       └── services/
│           ├── matcher.ts          — алгоритм сопоставления (4 уровня)
│           ├── pdfParser.ts        — парсер PDF-счетов
│           ├── excelInvoiceParser.ts — парсер Excel-счетов
│           ├── excelParser.ts      — парсер Excel-спецификаций
│           └── sectionDetector.ts  — определение разделов
├── frontend/         # React SPA (Vite)
│   └── src/
│       ├── App.tsx               — роутинг (state-based)
│       ├── pages/
│       │   ├── ProjectList.tsx   — список проектов
│       │   ├── ProjectDetail.tsx — детали проекта
│       │   ├── InvoicePreview.tsx— предпросмотр счёта
│       │   └── MatchingView.tsx  — сопоставление + итоги + экспорт
│       └── components/
│           ├── MatchTable.tsx    — таблица сопоставлений
│           └── ColumnMapper.tsx  — настройка колонок парсера
├── database/         # SQLite файл БД
├── data/uploads/     # Загруженные файлы
└── docs.md           # План реализации
```

## Быстрый старт

### Предварительно

- Node.js 18+
- npm

### Backend

```bash
cd backend
npm install
npm run db:init   # создание БД (один раз)
npm run dev       # запуск dev-сервера на порту 3001
```

### Frontend

```bash
cd frontend
npm install
npm run dev       # запуск dev-сервера на порту 5173
```

Открыть в браузере: http://localhost:5173

## Рабочий процесс оператора

1. **Создать проект** на главной странице (название + описание)
2. **Загрузить спецификацию** (.xlsx/.xls) — позиции автоматически разбиваются по разделам
3. **Загрузить счета** (.pdf/.xlsx/.xls) — система определит поставщика и распарсит позиции
4. **Настроить парсер** (опционально) — через "Предпросмотр" указать колонки вручную
5. **Запустить сопоставление** — система найдёт совпадения по артикулу, правилам, названию
6. **Подтвердить/отклонить** — решения сохраняются как правила для будущих проектов
7. **Выбрать цену** — при нескольких вариантах можно вручную выбрать нужный
8. **Экспорт в Excel** — итоговая спецификация с ценами по разделам

## API

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | /api/health | Проверка работоспособности |
| GET | /api/projects | Список проектов |
| POST | /api/projects | Создать проект |
| GET | /api/projects/:id | Получить проект |
| POST | /api/projects/:id/specification | Загрузить спецификацию (Excel) |
| GET | /api/projects/:id/specification | Позиции спецификации |
| DELETE | /api/projects/:id/specification | Удалить спецификацию |
| POST | /api/projects/:id/invoices | Загрузить счёт (PDF/Excel) |
| GET | /api/projects/:id/invoices | Список счетов проекта |
| GET | /api/invoices/:id | Счёт с позициями |
| GET | /api/invoices/:id/preview | Предпросмотр файла |
| DELETE | /api/invoices/:id | Удалить счёт |
| POST | /api/projects/:id/matching/run | Запустить сопоставление |
| GET | /api/projects/:id/matching | Результаты сопоставления |
| PUT | /api/matching/:id/confirm | Подтвердить матч |
| POST | /api/matching/:id/confirm-analog | Подтвердить как аналог |
| DELETE | /api/matching/:id | Отклонить матч |
| PUT | /api/matching/select/:id | Выбрать матч (цену) |
| GET | /api/projects/:id/summary | Итоги по разделам |
| GET | /api/projects/:id/export | Экспорт в Excel (.xlsx) |
| GET | /api/suppliers | Список поставщиков |
| GET | /api/suppliers/:id/parser-config | Настройки парсера |
| PUT | /api/suppliers/:id/parser-config | Сохранить настройки парсера |

## Переменные окружения

| Переменная | Описание | По умолчанию |
|---|---|---|
| `PORT` | Порт сервера | `3001` |
| `DATABASE_PATH` | Путь к файлу БД | `../database/budget_automation.db` |
| `UPLOAD_PATH` | Путь для загрузок | `../data/uploads` |

## Алгоритм сопоставления

Система использует 4 уровня сопоставления (по убыванию приоритета):

1. **Точное совпадение артикула** (95% уверенности)
2. **Выученные правила** — из подтверждённых ранее сопоставлений
3. **Нечёткое совпадение по названию** (Dice coefficient, порог 60%)
4. **Название + характеристики** (порог 50%)

Подтверждённые решения сохраняются в таблице `matching_rules` и используются в будущих проектах.
