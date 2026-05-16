# Статус проекта

## Связанные материалы
- [Активный план](active/plan_prod_readiness_2026-05-13.md)
- [Правила работы с планами](README.md)
- [Журнал реализации](../IMPLEMENTATION_LOG.md)
- [Benchmark reports](../benchmark-reports/)
- [Бизнес KPI](../../.business/goals/kpi.md)
- [Problem Registry](../problem-registry.yaml)
- [Handoff PRB-008](references/2026-05-13_pdf_spec_variant_children_handoff_status.md)
- [Handoff Step 3 Matching](references/2026-05-15_handoff_step3_matching.md)
- [Runbook Step A](references/2026-05-15_step_a_runbook.md) — текущий блокер прода
- [Handoff continuation bug 2026-05-16](references/2026-05-16_handoff_continuation_bug.md) — **точка остановки + готовый фикс**
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

### Оркестратор: PDF-парсинг 15%→80% (2026-05-13/14)

| Шаг | Задача | Метрика | Статус |
|-----|--------|---------|--------|
| 0 | Baseline замер | 15/750 = 2% | [x] 2026-05-13 |
| 1.1 | Скрипт pdfplumber + PyMuPDF | 739/750 = 98% | [x] 2026-05-14 |
| 1.2 | Тест на 4 PDF | 4/4 работают | [x] 2026-05-14 |
| 1.2A | Интеграция в backend | UI: 736/750 = 98% | [x] 2026-05-14 |
| 1.3 | Кэш версионирование | auto-invalidate on deploy | [x] 2026-05-14 |
| 2 | Точечные баги (B.1-B.3,B.5) | test:spec-pdf 7/7 | [x] 2026-05-14 |
| 2.5 | pdfplumber для счетов (invoice PDF) | 3/3 PDF, 534 позиций | [x] 2026-05-14 |
| 2.5+ | parent-child full_name рефакторинг | continuation merging, filterContinuations, двухпроходный matcher | [x] 2026-05-15 |
| 3.0 | Bench infra + BEFORE замер | matching-before-...json: проект 28 = 110s, 23.8% | [x] 2026-05-15 |
| 3.1 | Микро-3B: early exit + negative rule на LLM | matching-after-micro3B: −23% времени, качество не упало | [x] 2026-05-15 |
| 3 | Проверка матчинга | ≥70% | [ ] переход на Step A (прод) |
| 4 | Верификация прода | health OK | [ ] |
| 5 | Инфраструктура | HTTPS, Docker, .env | [ ] |
| 6 | Техдолг | git чистый | [ ] |

**Handoff:** `docs/plans/references/2026-05-15_handoff_step3_matching.md`

### Активный план (plan_prod_readiness_2026-05-13)

| Шаг | Задача | Приоритет | Статус |
|-----|--------|-----------|--------|
| A | Верификация прода (PRB-008, isScan, retry 429) | P0 | [ ] частично: A.1 PASS на 5-ПР_21 + ОВ-30.135 + 26 25-ТД-ОВ локально (multi-signal fix), Том 6 — GigaChat 402 |
| A.x | Multi-signal continuation fix (PARSER_VERSION 3→4) | bonus | [x] 2026-05-16: 3/3 local PASS, regression 7/7, рефлексия 16.05.26 |
| B | Carry-tasks: 5 багов парсинга | P1 | [x] 2026-05-16: B.1-B.3, B.5 (14.05) + B.4 (16.05, commit) |
| C | Инфраструктура: HTTPS, .dockerignore, deploy safety | P2 | [ ] → Шаг 5 оркестратора |
| D | Техдолг: PRB-001, PRB-002 | P3 | [ ] → Шаг 6 оркестратора |
