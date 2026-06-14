# Старт для нового чата — BUILD+ГЕЙТ: эндпоинт in-place чистки спеки (Part B · шаг 2)

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation`. Первым сообщением:
> **`выполни docs/plans/active/next_chat_prompt_partB_build_resplit_endpoint.md`**
> Реализуешь ОДИН эндпоинт + гейтишь его. **На ветке от origin/main, НЕ деплой, НЕ запускать на проде.**

## Роль
Точечный build-воркер. Реализуй и докажи **idempotent in-place эндпоинт**, который чистит ключи спеки БЕЗ удаления строк (сохраняя все FK-связки), + прогони на нём `pre-deploy-check`. Пишешь `result.md`. Прод не трогаешь, не деплоишь, не вызываешь.

## КАРТИНА ДО (факт, проверено оркестратором кодом)
- Трансформ чистки `applyVariantMarkersToItems` задеплоен (`origin/main=87dd821`), но СУЩЕСТВУЮЩИЕ спеки (особенно пр.11) хранят грязные `name/full_name`.
- `/reparse` и re-upload **НЕЛЬЗЯ**: `DELETE FROM specification_items` (specifications.ts:503) каскадит `matched_items` (ON DELETE CASCADE, schema.ts:107, `foreign_keys=ON` connection.ts:18) и обнуляет `operator_feedback.spec_item_id` (SET NULL, schema.ts:228 = сами жалобы #433/#326). Re-upload теряет 150 матчей + ручные связки + сами жалобы.
- Безопасный путь доказан recon'ом: **in-place UPDATE BY id** (id неизменен → все FK целы). Демо: `budget-automation-spec-repr/scripts/resplit-existing-proj11.mjs`.

## КАРТИНА ПОСЛЕ (твой артефакт — деплой-готовый, но НЕ задеплоенный)
Новый эндпоинт `POST /api/specifications/:id/resplit-clean` (общий, по spec id — **no-hardcode проекта**), который в ОДНОЙ транзакции:
1. `saveSpecSnapshot(specId)` (существующий, specifications.ts:562 — для отката в `specification_items_history`),
2. для каждой строки спеки: `applyVariantMarkersToItems` → получить чистые `name/full_name` + маркеры,
3. `UPDATE specification_items SET name=?, full_name=?, characteristics=? WHERE id=?` — **только эти 3 колонки, by id, без DELETE/INSERT**.
Идемпотентный (повторный вызов = no-op, т.к. трансформ идемпотентен). Возвращает отчёт: `itemsTouched`, `bareOrphanKept`, и счётчики связок ДО/ПОСЛЕ (matched_items + operator_feedback по этим spec id) — assert равны. `matcher.ts` НЕ трогать.

## МЕТРИКА (доказать числами — иначе не принято)
1. **Сохранность связок (offline-интеграция на снимке пр.11):** matched_items + operator_feedback + parent_item_id по spec id — **0 потерь, 0 осиротевших, id-сет стабилен**; идемпотентность (2-й вызов: itemsTouched=0).
2. **Прирост (offline AI-OFF, переиспользуй `replay-spec-clean-repr.mjs`-подход):** durable@1 пр.11 на пост-UPDATE данных → **~55%** (95-class ~75%), **0 регрессий рангов**.
3. **`pre-deploy-check` (5-move) = PASS** на diff эндпоинта; `npm run build` зелёный.
4. **Тривайр-дух:** эндпоинт opt-in по одному spec id, ничего не мутирует при вызове — confirmed 268/150 не затрагивается; `matcher.ts` нетронут.

## ЗАДАЧИ
1. Реализовать эндпоинт (переиспользуй `saveSpecSnapshot`, `applyVariantMarkersToItems`; транзакция; UPDATE by id). Валидация: spec существует; авторизация как у соседних мутирующих роутов.
2. Offline-интеграционный тест на снимке пр.11 (temp-БД, как `resplit-existing-proj11.mjs`/`replay-spec-clean-repr.mjs`): метрики 1-2.
3. Прогнать `pre-deploy-check` на ветке → вердикт.

## ЖЁСТКО
- Ветка от `origin/main` (свой worktree, чтобы не конфликтовать). **НЕ деплой, НЕ вызывать на проде, прод НЕ мутировать.** Offline только temp-БД.
- `matcher.ts` НЕ трогать. **no-hardcode** (эндпоинт общий по spec id, не зашивать project_id=11). `no_corrupt_through`, `evidence-before-claims`. ASCII-коммиты, именованные файлы, `git rev-parse --abbrev-ref HEAD` перед коммитом. Коммить инкрементально.

## Deliverable
`docs/plans/active/partB_build_resplit_endpoint_result.md` — что добавлено (file:line), offline сохранность связок + прирост (числа), `pre-deploy-check` вердикт, build-статус, ветка/коммит. + сводка владельцу простым языком → «нести оркестратору Арте на деплой-гейт». **Сам не деплоить.**
