# Журнал реализации планов

## Формат записи

```md
## YYYY-MM-DD — <Название плана>
- Статус: completed
- План: <путь к архивному файлу>
- Коммиты: <хэши/диапазон или n/a>
- Итог:
  - пункт 1
  - пункт 2
```

## 2026-04-14 — Инициализация единого процесса планирования
- Статус: completed
- План: `docs/plans/archive/2026-04/legacy-system-implementation-plan.md`
- Коммиты: n/a
- Итог:
  - Создана единая структура хранения планов (`active`, `archive`, `references`).
  - Добавлены правила жизненного цикла и обязательный журнал результатов.
  - Подготовлена миграция существующих планов из корня репозитория.

## 2026-04-14 — Миграция исторических планов
- Статус: completed
- План: `docs/plans/archive/2026-04/`
- Коммиты: n/a
- Итог:
  - Исторические планы перенесены в архив: `plan_v2.md`, `plan_3_03.md`, `plan_mistral_6_03.md`, `plan_gigachat_2026-03-09.md`.
  - Активные планы консолидированы в `docs/plans/active/`.
  - Сопутствующие материалы (ТЗ, тестирование, анализ) перенесены в `docs/plans/references/`.

## 2026-05-13 — Архивация plan_stabilization_v2 и переход к prod readiness
- Статус: completed
- План: `docs/plans/archive/2026-05/plan_stabilization_v2_2026-05-03.md`
- Коммиты: n/a
- Итог:
  - Все шаги 0–8.2 master-plan стабилизации закрыты.
  - Хотфиксы 8.3 (PDF parent-child) и PRB-008 (variant-children) задеплоены.
  - CI/CD переведён с GHCR на сборку на сервере (retry 429, без токенов).
  - Plan_stabilization_v2 архивирован, создан новый план `plan_prod_readiness_2026-05-13.md`.
  - Выявлены 5 carry-tasks (парсинг), 3 инфраструктурные задачи, 2 задачи техдолга.

## 2026-05-13 — PDF spec variant-children fix (PRB-008, F0–F6)
- Статус: completed
- План: `docs/plans/references/2026-05-13_pdf_spec_variant_children_handoff.md`
- Коммиты: `8e120a9`, `c098120`, `0daf3e1`, `b74c2ad`, `d26a022`, `ab1c141`
- Итог:
  - F0: followups references для вариантов 2 и 3 решения.
  - F1: PRB-008 зарегистрирован в problem-registry, двусторонние ссылки ретро↔registry.
  - F2: 5 синтетических PDF-фикстур + expected.json + генератор `_gen.mjs` (pdfkit).
  - F3: Red-first regression runner (`scripts/test-spec-parent-child.mjs`), 5 gigachat-response моков. На текущем коде 3/5 PASS.
  - F4: `VARIANT_CODE_PATTERN` + ветка в `linkPdfParentChildren` для variant-детей без position_number. 12 строк diff, 5/5 PASS.
  - F5: Baseline метрики в `docs/benchmark-baseline.md`: `variant_children_linked_ratio ≥ 0.95` (факт 1.00), позиций извлечено ≥ 90% (факт 100%).
  - F6: Деплой на прод, верификация dist/health, resolve PRB-008, ретроспектива.
  - Ретроспектива: `retrospectives/13.05.26_pdf-spec-variant-children.md`

## 2026-05-11 — Фаза 8.1–8.2: Gemini matching + Rule learning
- Статус: completed
- План: `docs/plans/active/plan_stabilization_v2_2026-05-03.md` (шаги 8.1–8.2)
- Коммиты: `bc1f082`, `95710d0`, `f5ed628`, `dade480`, `270ebe5`, `a348a8c`
- Итог:
  - 8.1: Gemini Flash batch matching через OpenRouter — 87.5% accuracy на тестовых проектах.
  - 8.2: UNIQUE index на matching_rules, upsert-хелперы, price-list schema split (matched_items + operator_feedback), unconfirm rollback, frontend type sync.
  - 8.3 пропущена: Dice fallback даёт 0.1%, Gemini уже покрывает потребность.
  - Ретроспектива: `retrospectives/11.05.26_фаза-8.1-8.2.md`

## 2026-05-03 — Консолидация активных планов стабилизации
- Статус: completed
- План: `docs/plans/archive/2026-05/README.md`
- Коммиты: n/a
- Итог:
  - `docs/plans/active/plan_stabilization_2026-04-22.md` оставлен единственным active master-plan.
  - В архив перенесены устаревшие active-планы: `plan_matching_improvement_2026-03-25.md`, `plan_budget_automation_v3.md`, `plan_issues_fix_phased_4h.md`, `2025-01-20-architecture-fixes.md`, `plan_pdf_quality_stabilization_2026-04-22.md`.
  - Архивные планы сохранены с исходными именами и описаны в `docs/plans/archive/2026-05/README.md`, чтобы их можно было найти по названию или смыслу.

## 2026-06-15 — Групповая чистка docs/plans/active/
- Статус: completed
- План: `docs/plans/archive/2026-06/cleanup_brief_plans_wiki_2026-06-15.md`
- Коммиты: см. push на ветке fix/gigachat-model-tier (doc-only)
- Итог:
  - Из `docs/plans/active/` перенесено 80 файлов в `docs/plans/archive/2026-06/` (включая сам бриф чистки).
  - В active/ оставлены 14 файлов: действующий стратегический план `PLAN_track_A_B_metric_gated_2026-06-11.md`, бэклог хвостов `carry_tasks_backlog_2026-06-15.md`, материалы текущей фазы B1/B1.2/семантика (worker briefs + next_chat_prompts 06-14/06-15) и методология (learning/semantic engine proofs).
  - В `docs/plans/archive/2026-06/README.md` — групповая опись по категориям (перекрытые планы, завершённые next_chat_prompt_*, worker briefs, canonical KB поток в парке, B1-замеры, discount/VAT, email loop, parent-child, operator feedback, прочее).
  - Сверка `plans:check:strict` — пройдена.
  - Tier-1 wiki-аудит (architecture/INDEX.md, освежение README.md по pdfplumber-first и Gemini-tier) вынесен в отдельный чат.

## 2026-06-15 — Tier-1 wiki audit
- Статус: completed
- План: `docs/plans/archive/2026-06/next_chat_prompt_2026-06-15_wiki_tier1_audit.md`
- Коммиты: см. push на ветке fix/gigachat-model-tier (doc-only)
- Итог:
  - Создан `architecture/INDEX.md` — единый навигационный лист по 9 разделам архитектуры + маршрут «start here» (README → architecture/INDEX → docs/plans/active/PLAN_track_A_B → .business/INDEX). `research/` не существует — пропущен.
  - `README.md` освежён по двум устаревшим строкам: парсинг — `pdfplumber` (Python, слой 0 PDF-спецификаций, с 2026-05-14) + `pdf-parse` (TS, PDF-счета); сопоставление — 5 уровней (добавлен `llm_suggestion`/Gemini-tier поверх Dice и правил, фаза 8.1 от 2026-05-10). Сверено с кодом: `backend/src/services/gigachatSpecFromPdf.ts`, `pdfParser.ts`, `matcher.ts` (вызов `matchWithGemini` из `llmMatcher.ts`).
  - `architecture/01-обзор/README.md` — врезан pdfplumber как боковой Python-процесс в слое Services + добавлены `geminiSpecFromPdf.ts`/`llmMatcher.ts`; обновлены принципы «Fallback-цепочка» и «Сопоставление в 5 уровней».
  - `architecture/06-стек/технологии.md` — добавлена строка про pdfplumber; уточнена роль pdf-parse (PDF-счета, TS-путь); в AI добавлен Gemini.
  - Промт чата (`docs/plans/active/next_chat_prompt_2026-06-15_wiki_tier1_audit.md`) перенесён в `docs/plans/archive/2026-06/`.
  - НЕ трогали: датированные снапшоты `backend/docs/`, ретроспективы, прод-параметры (5.42.103.63/порт/путь-БД), стратегический план и материалы текущей фазы.
