# Стартовый промпт для НОВОГО чата — Дашборд метрик обучения, Фаза 3 (страница-график)

> Открой новый чат в `C:\Users\home\vscode101\budget-automation`, роль — фуллстек-разработчик/оркестратор. Создан 2026-06-03 после деплоя Фаз 1+2.

## Точка проекта (ПЕРЕПРОВЕРЬ `git fetch origin`)
- `main` = `a5b599e` (запушено, на проде). ПЕРЕПРОВЕРЬ — мог уехать.
- Незапушенных локальных доков может не быть (всё в main). Проверь `git log origin/main..main`.

## Что УЖЕ сделано и ПРОВЕРЕНО на проде (доверять)
- **Ч1 «Замечания оператора»** — задеплоена (`201ca5b`), RU-ярлыки тегов.
- **Метрики обучения Фаза 1 «Захват»** — таблица `metric_snapshots` + `recordMetricSnapshot` (никогда не бросает) + хуки: на прогон матчинга, на КАЖДОЕ действие оператора (confirm/reject/analog/group/unconfirm/select/manual/gigachat-remove), на старт сервера (baseline всех проектов), раз в день. matcher/learner НЕ тронуты.
- **Метрики Фаза 2 «Чтение»** — `GET /api/projects/:id/metrics/history?limit=2000` (read-only). Возвращает:
  ```json
  { "projectId": 11, "count": N, "series": [
    { "id", "createdAt", "kind"('startup'|'matching_run'|'operator_action'|'daily'),
      "actionType", "total", "matched", "confirmed",
      "coverage"(%), "confirmedPct"(%), "tierBreakdown"({llm_suggestion, name_similarity, learned_rule,...}),
      "learnedSynonyms", "learnedRules" } ... ] }
  ```
  Новейшие N снимков в хронологическом порядке (oldest→newest).
- **Живая верификация прода (2026-06-03):** проект 6 → cov=88.3% (333/377), conf=268, learnedRules=452, learnedSyn=22. Ласточка 11 → cov=64.3% (211/328), conf=0, learnedRules=452, learnedSyn=22, tiers llm 207/sim 4. Захват и чтение работают.

## ЗАДАЧА ЭТОГО ЧАТА — Фаза 3: страница-дашборд (frontend)
Построить страницу, потребляющую `GET /api/projects/:id/metrics/history`:
- 📈 **График покрытия** (coverage%) и **подтверждено** (confirmedPct) по времени (`createdAt`).
- 🧩 **Состав по тирам** (`tierBreakdown`) — сколько тянет LLM vs name_similarity vs **learned_rule** (рост learned_rule = система учит домен).
- 🧠 **Рост памяти** — `learnedRules` + `learnedSynonyms` во времени.
- Селектор проекта (есть `GET /api/projects`).
- Точки `kind='operator_action'` можно аннотировать (видно, что действие двигает цифру).

**Frontend:** `frontend/src/pages/` (примеры: `MatchingView.tsx`, `GlobalFeedbackPage.tsx`), API-клиент `frontend/src/api` (`api.get(...)`). Роутинг — посмотри как подключены существующие страницы. Графики — выбери лёгкую либу или SVG; не тащи тяжёлое без нужды (проверь, что уже есть в `package.json`).

## CARRY по метрикам (в реестре `project_registry_and_metrics_focus_2026-06-03.md`)
- **C1:** bulk-циклы (bulk-confirm/reject/analog, group-followers) пишут N снимков на одно bulk-действие → снимок один раз после цикла (perf + меньше дублей).
- **C2:** нет прунинга `metric_snapshots` (рост) + read-эндпоинт капит на 10000 строк, дефолт 2000, без пагинации/даунсэмплинга → при большом объёме нужна агрегация.
- **C3:** memory-счётчики в одном try с coverage-счётчиками (хрупкость).
- **(сделано)** newest-N: эндпоинт уже отдаёт свежие, не старые.
- **Перенос обучения** (учим A → растёт авто-матч на B) — отдельная кросс-проектная метрика, этот per-project эндпоинт её не покрывает.

## Дальше (НЕ в этом чате)
- **FB-RICH** — кнопка «зафиксировать ситуацию + замечание» (лёгкий вариант: данные позиции/распарса/кандидатов + коммент, НЕ картинка). Зарегистрирована.
- **SEC-1** — прод `/api` без `API_SECRET` (открыт). Метрики наружу = агрегаты (низкая чувствительность), но дыра общая.

## Правила проекта (обязательные)
`feedback_build_before_push` (реальный `npm run build` обоих перед push); `feedback_commit_named_files` (только именованные, не `-A`/`.`, package-lock не коммитить); **pre-deploy-check 5-move перед `git push origin main`, вердикт PASS** (5 агентов, loop-until-clean); `feedback_no_hardcode`; `feedback_no_action_without_confirmation`; `feedback_explain_before_after`; forward-only (НЕ reparse).

## Деплой/верификация
GH Actions «Deploy to server» обычно срабатывает сам (~1мин); `Plan guard` workflow всегда красный (CI-1, игнор). Верификация — боевым HTTP API (`http://5.42.103.63:3001`), НЕ только health: дёрни `/api/projects/6/metrics/history` и смотри `series`. SSH только у владельца.

## Хвост-гигиена (по желанию владельца, на ЕГО ПК)
Чистка worktree `…-opfb-ch1` (sandbox у ассистента блокирует `rmdir` junction-ов): владелец сам `cmd /c rmdir ...\backend\node_modules` + `...\frontend\node_modules`, затем ассистент `git worktree remove --force` + `branch -d`.
