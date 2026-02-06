# Budget Automation

Система автоматизации обработки счетов для инженерных сетей.

## Стек технологий

- **Backend:** Node.js, Express, TypeScript
- **Frontend:** React, Vite, TypeScript
- **База данных:** SQLite (better-sqlite3)
- **Парсинг:** xlsx (Excel), pdf-parse (PDF)

## Структура проекта

```
budget-automation/
├── backend/          # Express API сервер
├── frontend/         # React SPA (Vite)
├── database/         # SQLite файл БД
├── data/uploads/     # Загруженные файлы
└── docs.md           # План реализации
```

## Быстрый старт

### Backend

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

Сервер запустится на `http://localhost:3001`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Приложение откроется на `http://localhost:5173`.

## API

- `GET /api/health` — проверка состояния сервера и БД
- `GET /api/projects` — список проектов
- `POST /api/projects` — создание проекта
- `GET /api/projects/:id` — получение проекта

## Переменные окружения

| Переменная | Описание | По умолчанию |
|---|---|---|
| `PORT` | Порт сервера | `3001` |
| `DATABASE_PATH` | Путь к файлу БД | `../database/budget_automation.db` |
| `UPLOAD_PATH` | Путь для загрузок | `../data/uploads` |
