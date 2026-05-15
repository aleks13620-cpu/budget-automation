# Handoff: Шаг 3 матчинг — состояние на 2026-05-15

## Где мы в плане

**Активный план:** `docs/plans/active/plan_prod_readiness_2026-05-13.md`
**Оркестратор:** шаги 0–2.5 завершены, **шаг 3 (проверка матчинга) — текущий**

### Прогресс

| Шаг | Статус | Детали |
|-----|--------|--------|
| 0–2.5 | ✅ DONE | pdfplumber 98%, parent-child linking, invoice PDF, 4 бага парсинга |
| 2.5+ | ✅ DONE | parent-child full_name рефакторинг: continuation merging + filterContinuations |
| 3 — Матчинг | ⏳ ТЕКУЩИЙ | Незакоммиченные изменения в matcher.ts готовы, нужен прогон |
| 4–6 | ⏳ Ждут | Верификация прода, инфраструктура, техдолг |

## Незакоммиченные изменения (3 файла, 160 строк)

### gigachatSpecFromPdf.ts (+90/-45)
- `linkPdfParentChildren()` полностью переписан: 4 категории (parent → "То же" → continuation → child)
- `accumulatedName` — накапливает контекст через continuation lines
- `filterContinuations()` — убирает слитые строки, ремапит `_parentIndex`
- `isChildPattern()` — унификация проверки DN/parameterized/variant
- `DN_CHILD_PATTERN` — добавлены `Дн`, кириллический `х`, запятая
- `SPEC_PDF_PARSER_VERSION` 2→3 (сброс кэша)
- `PYTHON_CMD` — кросс-платформенный (win32: python, unix: python3)

### matcher.ts (+20/-5)
- `specNormShort` — двухпроходный матчинг (full + short name)
- `specNameAsCode` — если имя выглядит как код (C11-300-500), используем как equipment_code
- `codeToCheck` — расширен поиск по коду на specNameAsCode
- `simThreshold` — 0.45 если есть код, 0.6 без кода

### pdfParser.ts (+2/-1)
- `PYTHON_CMD` — аналогичная кросс-платформа

## Верификация в БД (read-only аудит)

### full_name работает корректно (проект 31)
```
pos=1 | name: "Стальной панельный радиатор Royal Thermo Compact"
  full_name: "...Royal Thermo Compact с боковым подключением, тип C 11, в компл. с краном для выпуска воздуха и креплениями"

pos=- | name: "C11-300-500"  (variant child)
  full_name: "...тип C 11, в компл. с краном...креплениями C11-300-500"
```

Continuation lines ("с боковым подключением...", "краном для выпуска воздуха...") слиты в родителя, не торчат отдельными строками.

### Матчинг НЕ прогнан
- `matched_items` содержит результаты только для project_id=11 (4 позиции, тест)
- Проекты 29–31 (704–736 спек × 1498 счетов) — загружены, но matching не запущен

### Известные мелкие баги
- 4 variant кода `VC33-500-1100 L` не подхвачены (VARIANT_CODE_PATTERN не допускает суффикс L/R)
- matching_rules всего 8 — Tier 2 фактически не работает

## Метрики

| Метрика | Цель | Было | Сейчас |
|---------|------|------|--------|
| Парсинг спек (PDF) | ≥80% | 2% | 98% ✅ |
| Парсинг спек (Excel) | ≥80% | ~80% | ~80% (stable) |
| Парсинг счетов (PDF) | ≥80% | 0% | 534 позиций из 3 PDF ✅ |
| full_name coverage | >0 | 0 | 106/704 items (проект 31) ✅ |
| Матчинг позиций | ≥70% | ~20% (оценка) | **не измерено** ← СЛЕДУЮЩИЙ ШАГ |

## Следующие действия

1. **Коммит** 3 файлов (gigachatSpecFromPdf.ts, matcher.ts, pdfParser.ts) с 5-ходовым циклом
2. **Запуск матчинга** на проектах 29–31 через API, замер % и времени
3. **Диагностика производительности** — если время > 60 сек, профилировать по тирам
4. **Фикс VC33 L/R** — расширить VARIANT_CODE_PATTERN если матчинг покажет проблему

## Ключевые файлы

| Файл | Что |
|------|-----|
| `backend/src/services/gigachatSpecFromPdf.ts` | Parent-child linking + pdfplumber integration |
| `backend/src/services/matcher.ts` | Двухпроходный матчинг, specNameAsCode |
| `backend/src/services/pdfParser.ts` | PYTHON_CMD |
| `backend/src/routes/matching.ts` | POST /api/projects/:id/matching/run |
| `scripts/extract_pdf_table.py` | pdfplumber extraction |
| `database/budget_automation.db` | Рабочая БД |
