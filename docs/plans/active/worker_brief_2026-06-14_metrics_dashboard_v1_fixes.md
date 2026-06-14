# Бриф воркеру — доработка таблицы метрик (3 блокера + правильная ветка)
**Дата:** 2026-06-14 · **Заказчик:** оркестратор «Арта» · **Контекст:** стройка v1 прошла, гейт нашёл 3 блокера. Это **fix-loop** по скиллу pre-deploy-check.

> Базовый бриф (v1): `docs/plans/active/worker_brief_2026-06-14_metrics_dashboard_v1.md`. Текущий — только правки.

## 0. Прочитай перед стартом
- `MEMORY.md` — индекс.
- `project_global_metrics_dashboard.md` — главные метрики.
- `worker_brief_2026-06-14_metrics_dashboard_v1.md` — изначальный бриф (не менять цель, только починить).
- `feedback_no_action_without_confirmation` · `feedback_no_hardcode` · `feedback_commit_named_files` · `feedback_build_before_push` · `feedback_plain_language_no_abbrev`.

## 1. Что НЕ ТРОГАТЬ (контроль scope)
- Не правь матчер (`matcher.ts`), нормализацию, парсер.
- Не правь существующие эндпоинты `/api/projects/:id/matching*`, `/import-matches`.
- Не правь `backend/src/services/excelParser.ts` (там сидит парковая правка не из нашего scope).
- Не правь существующую страницу «Метрики» (`MetricsDashboard.tsx`) — это другая фича.
- Не коммить и не пушь — это решит архистратор.

## 2. Три правки (по приоритету)

### 2.1 Правильная ветка (СНАЧАЛА, иначе бессмысленно)
Сейчас рабочая ветка `feat/parser-clean` — 1 ahead / 13 behind `origin/main`. Пушить отсюда нельзя.

Сделай:
1. `git fetch origin main`
2. `git checkout -b feat/metrics-dashboard-v1 origin/main`
3. Перенеси наши новые файлы с прошлой ветки:
   - `git checkout feat/parser-clean -- backend/src/routes/metricsDashboard.ts backend/test_metrics_dashboard.ts frontend/src/pages/MainMetrics.tsx docs/plans/active/metrics_dashboard_v1_landed_2026-06-14.md docs/plans/active/worker_brief_2026-06-14_metrics_dashboard_v1.md docs/plans/active/worker_brief_2026-06-14_metrics_dashboard_v1_fixes.md`
4. Правки `backend/src/index.ts` и `frontend/src/App.tsx` НЕ копируй cherry-pick'ом — там могут быть посторонние правки. Открой эти файлы на свежей ветке (т.е. в состоянии origin/main) и руками внеси те же 2 изменения (импорт + регистрация роута / страница в роутинг). Это маленькие правки, повторяй ровно.
5. После переноса: `git status` — должен показать ровно 5 новых файлов + 2 модифицированных (`backend/src/index.ts`, `frontend/src/App.tsx`). Никаких посторонних правок.
6. `git diff origin/main..HEAD` должен быть пустым (мы ещё не коммитили).

### 2.2 Top-1 по `is_selected`, не по `confidence` (бэкенд)
**Где:** `backend/src/routes/metricsDashboard.ts:102-117`.
**Проблема:** прод-UI показывает «первый вариант» как тот, у которого `is_selected = 1` (выставляется матчером по сложному тай-брейку: dnScore → quantityScore → confidence). Сейчас наш SQL берёт просто `ORDER BY m.confidence DESC` — это даёт другую цифру на 39% позиций Ласточки.
**Доказательство** (замер прода 06-14): расхождение Сокольи=17, Ласточка=**118**, БКК ОВ=3, БКК ВК=2.
**Правка SQL:**
```sql
-- было (внутри top1Stmt):
ORDER BY m2.confidence DESC, m2.id ASC
LIMIT 1

-- стало:
ORDER BY m2.is_selected DESC, m2.confidence DESC, m2.id ASC
LIMIT 1
```
То есть `is_selected = 1` идёт первым (потому что DESC: 1 перед 0). При равных `is_selected` — продолжаем по confidence, потом по id.
**Обновить комментарий** в `metricsDashboard.ts:11-13`: вместо «mirrors `/matching` ORDER BY m.confidence DESC» написать «top-1 = matched_items where is_selected=1 (fallback by confidence). Это зеркалит существующую логику tierBreakdown в /matching, см. matching.ts:486-494».

### 2.3 Все типы матчей в ответе + в сноске (бэк + фронт)
**Бэкенд** (`metricsDashboard.ts`): расширить интерфейс ответа на 2 новых поля:
```typescript
interface ProjectMetrics {
  // ... existing fields ...
  manual_top1: number;
  exact_article_top1: number;
  name_characteristics_top1: number;
  // existing: memory_top1, llm_top1, name_sim_top1
}
```
И заполнить их в `top1Counts['manual'] ?? 0` и т.д.

**Фронт** (`MainMetrics.tsx:184-191`): в сноске под карточками показать ВСЕ типы (только если > 0, чтобы не засорять):

```
Подтверждено оператором: X · Память (Memory): X · 
Подтверждение в прошлом (manual): X · 
Точное совпадение артикула: X · 
ИИ (Gemini): X · 
По сходству имён: X · 
По характеристикам: X · 
Без варианта: X
```

Скрывать пункт, если число = 0 (короче).

**КОНТРОЛЬ:** сумма «Память + manual + точный артикул + ИИ + по имени + по характеристикам + без варианта» = `spec_total`. Если сумма НЕ сходится — есть ещё какой-то тип, которого мы не учли. Логируй ошибку в консоль (warning), не падай.

**Карточку №3 «Сколько работы делает Память» НЕ ТРОГАТЬ** — она про learned_rule только, это правильно по семантике плана (Память = выученные правила).

## 3. Гейт PASS (новая версия)
1. Эндпоинт возвращает все 8 числовых полей + 2 строковых (project_name, accuracy_at_1_status). Время ответа ≤ 2 с.
2. На странице сноска показывает все типы с > 0, сумма сходится с `spec_total`.
3. **Сверка с прод-UI** на двух самых проблемных проектах:
   - Возьми пр.6 (Сокольи горы ВК): `memory_top1` после правки SQL должно остаться 47 (правило matcher всегда даёт `is_selected=1` learned_rule матчам). 
   - **Главное:** число расхождений между нашим top-1 и прод-UI top-1 должно стать 0 на всех 4 проектах. Проверь — напиши маленький контрольный скрипт (~30 строк), который берёт `/api/projects/:id/matching`, для каждого spec'а top-1 by isSelected и сравнивает с нашим `/api/metrics/dashboard` distribution. Должны сойтись.
4. Тривайр прода цел: пр.6=47/268, пр.11=117/150, пр.12=22/0, пр.13=5/0. Скидка 894066: 9605.4 / 13572.6 / 7119.
5. `cd backend && npm run build` PASS. `cd frontend && npm run build` PASS.
6. `git diff origin/main..HEAD` пустой (ещё не коммитили). `git status` показывает 7 файлов в нашем scope, ни одного постороннего.

## 4. Что вернуть архистратору (≤300 слов)
1. Имя новой ветки (должно быть `feat/metrics-dashboard-v1`).
2. Список файлов в `git status` (ровно наш scope, ни больше).
3. Изменения в `metricsDashboard.ts`: цитата нового SQL + цитата 3 новых полей в ответе.
4. Изменения в `MainMetrics.tsx`: что добавлено в сноску.
5. Контроль-замер расхождений нашего top-1 vs прод-UI top-1: должно быть 0 на всех 4 проектах. Если не 0 — назови проект и число.
6. Тривайр прода — целы или нет.
7. Сборка бэка + фронта — PASS / FAIL.
8. Готово ли к закрытию-гейту (Ход 1 + Ход 4 сокращённо).

## 5. Запреты (ещё раз — это правила проекта)
- Не коммить, не пушить.
- Не править матчер/normalize/matching.ts/import-matches/excelParser.ts.
- Не добавлять новые карточки или новые страницы.
- Не вводить новых эндпоинтов кроме `/api/metrics/dashboard`.
- Не использовать жаргон в UI: подсказки только простыми словами.
- Не подгонять цифры — если контроль-замер показывает расхождение, доложи как есть.
