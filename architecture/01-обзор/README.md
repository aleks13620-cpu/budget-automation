# Обзор архитектуры

## Слои системы

```
[Браузер / React SPA]
       │  HTTP /api/*
       ▼
[Express 5 API — порт 3001]
       │
       ├── Routes (thin controllers)
       │     specifications.ts  invoices.ts  matching.ts
       │     suppliers.ts       export.ts    projects.ts
       │
       ├── Services (бизнес-логика)
       │     matcher.ts                excelParser.ts        pdfParser.ts
       │     invoiceRouter.ts          gigachatService.ts    sectionDetector.ts
       │     gigachatParser.ts         gigachatSpecParser.ts gigachatSpecFromPdf.ts
       │     geminiSpecFromPdf.ts      llmMatcher.ts (Gemini-tier)
       │
       │  ↳ Боковой процесс (Python, execFile):
       │     pdfplumber — слой 0 извлечения PDF-спецификаций (таблицы/координаты)
       │
       └── Database (SQLite / better-sqlite3)
             budget_automation.db  (WAL mode, foreign keys ON)
```

## Принципы, видимые из кода

- **Одна база на всё** — SQLite, синхронный драйвер, WAL для параллельных чтений
- **Routes — тонкие контроллеры** — логика в services; маршруты делают валидацию, вызывают сервис, возвращают JSON
- **Fallback-цепочка для парсинга** — для PDF-спецификаций: pdfplumber (Python, слой 0) → GigaChat Files API → Gemini; для PDF-счетов: pdf-parse (TS). Результат кэшируется по хэшу файла.
- **Сопоставление в 5 уровней** — артикул → выученные правила → Dice → Dice+характеристики → Gemini-tier (LLM-предложения для остатка)
- **Обучение через подтверждения** — каждое подтверждённое совпадение сохраняется как правило и применяется в следующих запусках
- **Stateless API** — нет сессий, нет аутентификации; предполагается доверенная сеть
- **SPA без роутера** — состояние навигации хранится в `useState` React, URL не меняется

## Граница фронтенд / бэкенд

Axios-клиент настроен на `/api` — Vite-прокси перенаправляет на `localhost:3001` при разработке. В продакшне Express отдаёт статику фронтенда и обрабатывает `/api/*`.
