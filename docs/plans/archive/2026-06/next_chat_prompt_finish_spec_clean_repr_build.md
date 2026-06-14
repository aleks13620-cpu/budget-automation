# Старт для нового чата — ЗАКОНЧИТЬ build парсера «чистого представления»

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation` и дай первым сообщением:
> **`выполни docs/plans/active/next_chat_prompt_finish_spec_clean_repr_build.md`**
> Работай АВТОНОМНО до конца — владелец не контролирует процесс. Это отдельная сессия (переживает паузы).

## Роль
Ты — **build-finisher** (фокусная код-задача), НЕ оркестратор. Доделай build НА ВЕТКЕ, напиши `result.md` + простую сводку владельцу. **НЕ деплой** (деплой-гейт = отдельно: оркестратор «Арта» + «ок» владельца ПОТОМ).

## Прочитай ПЕРВЫМ
- Память (авто-загружается): **`reflection_2026-06-08_clean_repr_generic_gate`** (ДОКАЗАТЕЛЬСТВО рычага — вход, не перепроверять), правила `feedback_no_corrupt_through`, `feedback_no_hardcode`, `feedback_build_before_push`, `feedback_commit_named_files`, `feedback_shared_worktree_branch_hazard`.
- Исходный бриф (полные требования/гейты): `docs/plans/active/worker_brief_spec_clean_repr_build.md`.

## Где работать
Worktree **`C:\Users\home\vscode101\budget-automation-spec-repr`** (ветка `feat/spec-clean-repr`, базис `origin/main`=0c41f06). `backend/node_modules` есть. ВЕСЬ труд там. Перед КАЖДЫМ коммитом `git rev-parse --abbrev-ref HEAD` (== `feat/spec-clean-repr`).

## Что УЖЕ сделано (НЕ переделывать — Read и продолжай)
3 коммита (`715d9ea`/`e827d5b`/`7f12fc9`):
- `backend/src/services/variantMarkers.ts` — `extractVariantMarkers` + `applyVariantMarkersToItems` (вычитание, лексикон=атрибут-синтаксис, no-hardcode).
- проводка в `excelParser.ts` + `gigachatSpecFromPdf.ts`.
- `scripts/test-variant-markers.mjs` (unit), `scripts/replay-spec-clean-repr.mjs` (офлайн-replay пр.11), `scripts/scan-variant-markers-multiproject.mjs`.
- фикс `Q=` (только теплоотдача «…Вт», не склеенные расходные ед.).
**Незакоммичено на диске** (от прерванного прохода — Read, закоммить ценное именованными файлами): `scripts/tripwire-power-markers.mjs`, `scripts/tripwire-variant-markers.mjs`. **Удали любые `_tmp_*`/`*inspect*` throwaway-скрипты.**

## Доказанные входы (НЕ передоказывать)
- Гейт доказал: вычитание → durable **53.3%/75.2%@95** & AI-ON **66%**. Твоё дело — ПРОИЗВЕСТИ это в парсере, не передоказать матчинг.
- Прерванный проход уже валидировал over-strip `Q=`: **0/56 power-строк изменено**; `Q=8,5м³/ч` (расход) НЕ снят, `P=…кВт`/`Ny=…кВт` целы → граница `Q=` точна.
- Офлайн-replay: парсер-выход **55.3%/75.2%**, НО orig-baseline **4.7% ≠ гейт 2.7%** — РАЗРЕШИ (replay apples-to-apples? иная нормализация/пул?).

## ДОДЕЛАТЬ (чек-лист, по важности)
1. **CHOKEPOINT-полнота:** `applyVariantMarkersToItems` вшит в excel+gigachat, НЕ в `geminiSpecFromPdf.ts`. Проверь: Gemini-выход спеки идёт через общий путь (excelParser/нормализацию) или пишет `specification_items` мимо? Покрой ВСЕ пути (Gemini+GigaChat+Excel/bulk) — вшей в gemini ИЛИ консолидируй в ЕДИНЫЙ downstream chokepoint. Доложи итоговую точку.
2. **ТРИВАЙР `confirmed 268 (пр.6) / 150 (пр.11)` НЕ падает + 0 match-регресса** (это ОТДЕЛЬНО от over-strip probe — подтверди, что матчинг confirmed-пар не просел). + `bareOrphanFraction` по доменам. Тест: голый `Дн57х3,5`/`Ду15` НЕ снят, «этажный» (adj) цел.
3. **Re-split existing пр.11** (CASCADE-safe: вычитание к сохранённому full_name, маркеры→characteristics НА МЕСТЕ, БЕЗ re-upload), офлайн-replay на temp-копии БД. НЕ применять к проду.
4. **`npm run build`** (НЕ только tsc) ЗЕЛЁНЫЙ.
5. Разреши replay orig **4.7%≠2.7%**.
6. **Лев/Прав риск** — задокументируй (снятие «исполнение» из ключа → возможная лев↔прав неоднозначность в проде).

## ЖЁСТКО
- `matcher.ts` НЕ трогать. **НИЧЕГО в прод** (нет push в main; пр.11 НЕ перезаливать; replay только temp-БД).
- no-hardcode, no_corrupt_through. ASCII-коммиты, ТОЛЬКО именованные файлы (без `git add -A`/`.`). **Коммить инкрементально** после каждого блока.
- **НЕ деплой.** Закончи на ветке `feat/spec-clean-repr`. Деплой-гейт (5-move) + решение = оркестратор + владелец ПОТОМ.

## DELIVERABLE
1. ЛЕДЖЕР → `docs/plans/active/worker_brief_spec_clean_repr_build_result.md` (структура §5 исходного брифа: файлы+итоговый chokepoint, лексикон+guard'ы, тесты, replay durable@1 + объяснение orig-дельты, multi-project+ТРИВАЙР 268/150+bareOrphanFraction, re-split дизайн+офлайн-replay, Лев/Прав, самооценка к 5-move).
2. + **Финальная СВОДКА ДЛЯ ВЛАДЕЛЬЦА** (в чате, простым языком): что сделано, тривайр цел/нет, `npm run build` зелёный/нет, что осталось/блокеры, готов ли к деплой-гейту. **Владелец принесёт эту сводку обратно оркестратору** для деплой-гейта.
