# Статус проекта

## Связанные материалы
- [Активный план](active/plan_prod_readiness_2026-05-13.md)
- [Правила работы с планами](README.md)
- [Журнал реализации](../IMPLEMENTATION_LOG.md)
- [Benchmark reports](../benchmark-reports/)
- [Бизнес KPI](../../.business/goals/kpi.md)
- [Problem Registry](../problem-registry.yaml)
- [Handoff PRB-008](references/2026-05-13_pdf_spec_variant_children_handoff_status.md)
- [Предыдущий план (архив)](archive/2026-05/plan_stabilization_v2_2026-05-03.md)

## Текущая фаза: Стабилизация прода и carry-tasks

### Завершённые шаги (plan_stabilization_v2)

| Шаг | Задача | Статус | Дата |
|-----|--------|--------|------|
| 0–3 | Baseline, парсинг, рефакторинг | [x] | 2026-05-05 |
| 4–6 | Baseline матчинга, conflict detection, feedback, parser_overrides | [x] | 2026-05-06 |
| 7 | Field-level quality report | [x] | 2026-05-08 |
| 8.1 | Gemini Flash batch matching | [x] | 2026-05-10 |
| 8.2 | Rule learning + price-list schema | [x] | 2026-05-11 |
| 8.3 | PDF parent-child hotfix + GigaChat timeouts | [x] | 2026-05-12 |
| PRB-008 | PDF spec variant-children fix (F0–F6) | [x] | 2026-05-13 |
| CI/CD | Переход с GHCR на сборку на сервере + retry uploadFile 429 | [x] | 2026-05-12 |

### Активный план (plan_prod_readiness_2026-05-13)

| Шаг | Задача | Приоритет | Статус |
|-----|--------|-----------|--------|
| A | Верификация прода (PRB-008, isScan, retry 429) | P0 | [ ] |
| B | Carry-tasks: 5 багов парсинга | P1 | [ ] |
| C | Инфраструктура: HTTPS, .dockerignore, deploy safety | P2 | [ ] |
| D | Техдолг: PRB-001, PRB-002 | P3 | [ ] |
