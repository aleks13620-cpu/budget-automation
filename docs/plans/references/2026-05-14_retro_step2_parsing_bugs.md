# Ретроспектива: Шаг 2 — точечные баги парсинга

**Дата:** 2026-05-14
**Метрика:** test:spec-pdf 7/7 PASS (было 5/5)

## Результат

| Баг | Статус | Что сделали |
|-----|--------|-------------|
| B.1 | FIXED | VARIANT_CODE_PATTERN добавлен в excelParser.ts (parity Excel↔PDF) |
| B.2 | FIXED | DN_CHILD_PATTERN — убран `?`, префикс DN/Ду теперь обязателен |
| B.3 | FIXED | NaN guard в mapPdfItemsToRows (GigaChat-ветка) |
| B.4 | SKIPPED | "То же" как parent — по дизайну, подтверждено тестами |
| B.5 | FIXED | isParameterizedChild — length>25 guard от ложных срабатываний |

## 5-ходовый цикл

- **Move 1:** 1 EDGE_CASE (радиаторные варианты "500-10" теряют parent context) → CARRY-TASK
- **Move 4:** Build clean, 7/7 PASS
- **Move 5:** Security OK (нет ReDoS, нет sensitive data)

## Carry-tasks

- Расширить VARIANT_CODE_PATTERN для цифровых вариантов (500-10, 500-12)
- Дедупликация паттернов между excelParser.ts и gigachatSpecFromPdf.ts

## Коммит

`3227752` — fix: 4 parsing bugs + 2 new test cases (Step 2)
