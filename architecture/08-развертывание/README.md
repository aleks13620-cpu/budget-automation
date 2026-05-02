# Развёртывание

## Продакшн

**Сервер:** `5.42.103.63`
**Порт:** 3001 (Express отдаёт и API, и статику фронтенда)
**Образ:** `ghcr.io/aleks13620-cpu/budget-automation:latest`

### Стандартный деплой

```bash
git pull
docker compose pull
docker compose up -d --no-deps --build
```

### Тома (volumes)

| Хост | Контейнер | Содержимое |
|---|---|---|
| `./database/` | `/app/database/` | SQLite-файл базы |
| `./data/uploads/` | `/app/data/uploads/` | Загруженные файлы |

Данные переживают обновление образа.

### Откат

```bash
docker compose down
docker compose up -d --no-deps budget-automation:previous-tag
```

## Разработка (локально)

```bash
# Первый запуск
cd backend && npm install && npm run db:init

# Backend (порт 3001)
cd backend && npm run dev

# Frontend (порт 5173, с прокси /api → 3001)
cd frontend && npm install && npm run dev
```

## CI/CD

Из кода видно наличие GHCR — образ публикуется через GitHub Actions (`.github/workflows/`). Детали pipeline не извлекались.

## Переменные окружения (`.env`)

```
PORT=3001
DATABASE_PATH=../database/budget_automation.db
UPLOAD_PATH=../data/uploads
GIGACHAT_AUTH_KEY=<base64>
GIGACHAT_SCOPE=GIGACHAT_API_PERS
GIGACHAT_MODELS_FILES=GigaChat-2-Lite,GigaChat-2-Pro,GigaChat-2-Max
```

## Инициализация базы

```bash
npm run db:init   # выполняет schema.ts — создаёт таблицы если их нет
```

Нет системы миграций — схема применяется через `CREATE TABLE IF NOT EXISTS`.
