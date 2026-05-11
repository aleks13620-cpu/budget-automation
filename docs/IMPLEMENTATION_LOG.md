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
