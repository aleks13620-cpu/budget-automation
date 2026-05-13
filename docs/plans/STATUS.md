# Статус стабилизации v2

## Связанные материалы
- [Активный master-plan](plan_stabilization_v2_2026-05-03.md)
- [Правила работы с планами](../README.md)
- [Журнал реализации](../../IMPLEMENTATION_LOG.md)
- [Benchmark reports](../../benchmark-reports/)
- [Бизнес KPI](../../../.business/goals/kpi.md)
- [Отложенные варианты PDF spec parent/child](references/2026-05-12_pdf_spec_parent_child_followups.md)

## Текущая фаза: Шаг 8 — LLM-based matching

| Шаг | Задача | Ветка | Статус | Дата |
|-----|--------|-------|--------|------|
| 0 | Верификация 12 JSON (Иван/Сергей) | — | [ ] | |
| 0а | Разделить benchmark на train/holdout | step-0a-train-holdout | [x] | 2026-05-05 |
| 1 | Baseline парсинга | — | [x] | 2026-05-05 |
| 1а | Smoke-test + version pinning | step-1a-smoke-test | [x] | 2026-05-05 |
| 1б | Миграция operator_feedback | step-1b-migration | [x] | 2026-05-05 |
| 2 | Исправление провалов парсинга | step-2-fix-prices | [x] | 2026-05-05 |
| 2а | Quality monitor скрипт | step-2a-quality-monitor | [x] | 2026-05-05 |
| 3а | Feature flag USE_LEGACY_PARSER | step-3a-feature-flag | [x] | 2026-05-05 |
| 3 | Рефакторинг invoiceRouter | step-3-refactor-parser | [x] | 2026-05-05 |
| 4 | Baseline матчинга | — | [x] | 2026-05-05 |
| 5а | Conflict detection в matching_rules | step-5a-conflict-detection | [x] | 2026-05-05 |
| 5б | "Почему совпало" в UI | step-5b-match-reason | [x] | 2026-05-05 |
| 6а | feedback-report.py | step-6a-feedback-report | [x] | 2026-05-05 |
| 6б | export-benchmark.sh | step-6b-export-benchmark | [x] | 2026-05-06 |
| 6в | parser_overrides конфиг | step-6c-parser-overrides | [x] | 2026-05-06 |
| 6г | Исполнение parser_overrides: цены из GigaChat, текст из Gemini/основного результата | step-6d-execute-parser-overrides | [x] | 2026-05-06 |
| 7 | Field-level quality report без изменения парсинга | step-7b-field-quality-report | [x] | 2026-05-08 |
| 8 | Диагностика матчинга: Dice 0.1%, тест Gemini 87.5% | — | [x] | 2026-05-09 |
| 8.1 | Gemini Flash batch matching service + интеграция | step-8a-llm-matching-agent1-clean | [x] | 2026-05-10 |
| 8.2 | Rule learning из LLM-матчей + fix дубликатов правил | step-8b-rule-learning | [x] | 2026-05-11 |
| 8.3 | ~~Механические фиксы Dice fallback~~ — skipped (Dice 0.1%, Gemini 87.5%) | — | [~] | 2026-05-11 |
| PRB-008 | PDF spec variant-children fix (F0–F6) | main | [x] | 2026-05-13 |
