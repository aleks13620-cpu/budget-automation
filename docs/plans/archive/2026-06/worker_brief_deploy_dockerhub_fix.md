# Воркер-бриф: добить прод-деплой (Docker Hub 429) — durable

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation` и напиши:
> «выполни docs/plans/active/worker_brief_deploy_dockerhub_fix.md».
> Самодостаточно — предыдущих обсуждений не помнишь.

## Роль
Воркер-фиксер деплоя. Оркестратор («Арта») в другом чате ведёт план (гейт каталога `feat/canonical-kb`) — тебе отдан ТОЛЬКО технический деплой, чтобы не рвать его контекст. Прод/БД не ломать. По завершении — `worker_brief_deploy_dockerhub_fix_result.md`.

## Что произошло (факты, проверено)
- Парсер-фикс влит в `origin/main` = **`0c41f06`** (FF от 3829e4b). Это корректно, откатывать НЕ надо.
- GH Actions «Deploy to server» (run **27095210586**) ПАДАЕТ. На сервере (`root@5.42.103.63`):
  `git reset --hard origin/main` прошёл УСПЕШНО (репозиторий на 0c41f06), НО
  `docker compose up -d --build` падает на `FROM node:20-alpine`:
  **`429 Too Many Requests — You have reached your unauthenticated pull rate limit`** (registry-1.docker.io).
- Следствие: новый образ не собрался → **работает СТАРЫЙ контейнер (старый код)**.
- Прод ЖИВ, данные целы (read-only HTTP, проверено):
  - `GET http://5.42.103.63:3001/api/health` → `{"status":"ok","database":"connected"}`
  - `GET .../api/projects/6/matching/stats` → confirmed **268** (377/333/268/44)
  - `GET .../api/projects/11/matching/stats` → confirmed **150** (328/239/150/89)

## Почему сейчас (а 04.06 и 06.06 проходило)
Лимит анонимных пуллов Docker Hub — СКОЛЬЗЯЩЕЕ окно по IP. Те деплои были в пределах окна; сейчас окно исчерпано (общий IP провайдера / накопленные пуллы / ужесточение Docker Hub). buildkit при `--build` ВСЕГДА сверяет манифест base-образа с реестром (даже если node:20-alpine локально есть) → 429. Каждая неудачная попытка тоже шлёт manifest-GET и усугубляет лимит → **НЕ долбить ретраями**.

## Цель
Завести НОВЫЙ контейнер (код `0c41f06`) в проде, **durable** (чтобы 429 не повторялся), БЕЗ падения confirmed 268/150. Парсер/matcher/схему НЕ трогать.

## Ограничения окружения
- Из этого окружения **НЕТ SSH на прод** (5.42.103.63). Проверка — только HTTP API + `gh` (GitHub Actions доступен).
- `docker login` НА СЕРВЕРЕ может сделать ТОЛЬКО владелец (его руки) — у тебя нет SSH.
- Деплой/`gh run rerun` — повтор УЖЕ авторизованного деплоя, можно. Правка deploy.yml + push — инфра, согласуй push с владельцем. ASCII-коммиты, только именованные файлы. Секреты/токены НЕ логировать.

## Пути (выбрать с владельцем; рекомендация — B1)
- **B1 (durable, проще — РЕКОМЕНД.):** владелец один раз `ssh root@5.42.103.63` → `docker login` (бесплатный аккаунт Docker Hub). Креды → /root/.docker/config.json, деплой-SSH (root) их подхватит → авторизованные пуллы. После этого ТЫ: `gh run rerun 27095210586` → дождись success.
- **B2 (durable, всё в CI):** владелец заводит Docker Hub Access Token + 2 GH-секрета `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`. Ты правишь `.github/workflows/deploy.yml`: ВНУТРИ SSH-heredoc, ПЕРЕД `docker compose up -d --build`, добавляешь логин:
  `echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin`
  передав секреты в SSH-сессию (env в heredoc; токен не печатать). Коммит ASCII → push в main (с ок владельца) → деплой.
- **A (стопгап, без действий владельца):** подождать **≥1.5–2 ч** (окно дренажируется) и `gh run rerun 27095210586`. Если снова 429 — ещё подождать. НЕ durable (вернётся на след. деплоях). Прод пока на старом коде — это безопасно (данные целы).

## Проверка (Definition of Done)
1. GH Actions «Deploy to server» run = **success** (`gh run view <id>` / `gh run watch <id>`).
2. Прод жив: `GET /api/health` = ok.
3. **Жёсткий гейт — confirmed целы:** P6=**268**, P11=**150** (`/api/projects/6|11/matching/stats`). Если упали — СТОП, эскалация владельцу.
4. Свежесть кода: `/api/version` НЕТ (давний CARRY) → прямого маркера нет. Косвенно: success деплой-рана = `docker compose up --build` пересоздал контейнер. Хочешь твёрдую проверку — предложи владельцу добавить `/api/version` (отдельный мелкий PR, вне этого брифа).

## Вернуть в `worker_brief_deploy_dockerhub_fix_result.md`
Путь (A/B1/B2) · правки (если deploy.yml — диф) · deploy run id+статус · health + confirmed 268/150 · durable ли (повторится ли 429) · остаточные риски/CARRY (вкл. /api/version).
