# Handoff: continuation merging bug — состояние на 2026-05-16

**Контекст:** в рамках Step A (production verification) Алексей предоставил 4 реальных PDF спецификации для расширенной верификации. Тест A.1 на первом PDF (5-ПР_21) прошёл, на остальных вскрыт баг continuation logic + 2 смежные проблемы.

## Что работает (зафиксировано до этой точки)

| Артефакт | Коммит | Статус |
|---|---|---|
| Parent-child continuation merging | `0aca7a6` | Работает на 5-ПР_21, баг на 3 других PDF |
| Early exit + LLM-rejected negative rules | `6750abe` | OK, −23% bench |
| Research docs | `6cfab4e` | OK |
| Step A runbook | `a537932` | OK |

## Step A.1 — что проверено локально

**PASS на `5-ПР_21 – ОВ (1)-45-75.pdf`:**
- Распарсилось 704 позиции
- 34 variant-children (C11-300-500 и т.п.) — все с `full_name` склеенным из родителя + кода
- Continuation lines («с боковым подключением...», «...креплениями») слиты в родителя
- Используется кеш (parser_version=3), значит код после `0aca7a6` отрабатывает правильно на этом PDF

## Найденный баг — false-positive continuation merging

**Проблема:** на 3 из 4 реальных PDF логика `linkPdfParentChildren` в [gigachatSpecFromPdf.ts:180–271](../../../backend/src/services/gigachatSpecFromPdf.ts) **ошибочно сливает самостоятельные позиции оборудования в чужих родителей** когда у позиции нет `quantity` (pdfplumber не извлёк), хотя есть `unit` или `manufacturer`.

**Пример (ОВ-30.135 ИТП):**
- Родитель: «Счётчик тепла Пульсар Ду15 qp=0.6 куб.м/час»
- Ошибочно сливаются как continuation: 22 строки «Отопительный прибор стальной K-Profil тип 22 H=400мм» (Buderus) и 5 строк «Узел распределительный»
- Получается родитель с `full_name` = «Счётчик тепла ... Отопительный прибор K-Profil ... Отопительный прибор K-Profil ...» × 27 раз

**Причина:** условие continuation (matcher.ts:217+) проверяет только `quantity == null`. Реальные позиции с `unit="шт."`, `manufacturer="BUDERUS"` но `quantity=null` проходят через это условие.

## Готовый к применению фикс — multi-signal heuristic

```typescript
// В gigachatSpecFromPdf.ts добавить helper:
function isIndependentItem(item: SpecificationRow): boolean {
  return item.position_number != null
      || item.quantity != null
      || item.unit != null
      || item.manufacturer != null
      || item.mass_per_unit != null;
}

// В linkPdfParentChildren заменить блок continuation (примерно строка 217):
// БЫЛО:
if (
  lastParentIndex !== null &&
  item.quantity == null &&
  !isChildPattern(item.name)
) { ... continuation ... }

// СТАНЕТ:
if (
  lastParentIndex !== null &&
  !isIndependentItem(item) &&
  !isChildPattern(item.name)
) { ... continuation ... }
```

**Также bump:** `SPEC_PDF_PARSER_VERSION` 3 → 4 для инвалидации кеша.

## Валидация фикса на 4 реальных PDF (сравнение CURRENT vs PROPOSED)

| PDF | Сырых строк | CUR слепляет | PROP слепляет | Спасено правильно |
|---|---|---|---|---|
| 230-43.3-ОВ2 (251 стр) | 0 | — | — | (см. вопрос #2) |
| 26 25-ТД-ОВ | 226 | 18 | 4 | **14** (звукоизоляция Техносонус) |
| Том 6. 3-24-ОВ | 189 | 124 | 42 | **82** (радиаторы Valfex, узлы, клапаны) |
| ОВ-30.135 (ИТП) | 277 | 114 | 47 | **67** (Buderus K-Profil, Узел распределительный, Пульсар) |
| **Итого** | | | | **163 позиции спасены** |

**Истинные continuation** (которые сливаются и в PROPOSED) — выглядят корректно:
- «Т11, Т21;» — фрагмент описания
- «прямой с RS485» — характеристика
- «:+32мм/-10мм(сжатие/удлинение) при 5000 циклах срабатывания» — параметры
- «Шероховатость k=0,007 мм.» — параметр трубы

## Открытые вопросы — на завтра

### Вопрос 1 (главный): применить multi-signal фикс и пройти 5-ходовой цикл
- Применить изменение в `gigachatSpecFromPdf.ts`
- Bump `SPEC_PDF_PARSER_VERSION` 3→4
- Regression `test:spec-pdf` 7/7 (синтетические fixtures имеют continuation lines с unit=null — должны пройти)
- Прогон bench-matching на проектах 18/20/28 (full_name изменится → confidence матчинга может вырасти на 12% покрытии)
- Локальный тест на всех 4 PDF — ожидание: 5-ПР_21 продолжает работать, остальные больше не ломаются
- Если всё OK — commit

### Вопрос 2: PDF 230-43.3-ОВ2 — не таблица, а проектный том
- 145 страниц, текстовое описание с редкими таблицами
- Pdfplumber вернул 0 items
- Это **другой тип документа**, не наша спецификация
- Нужен **детектор** «это не таблично-структурированная спека → отвергнуть с понятной ошибкой» вместо тихого возврата 0 позиций
- Файлы: `backend/src/services/gigachatSpecFromPdf.ts` (parse_quality threshold)

### Вопрос 3: PDF Том 6 — кривое распознавание колонок pdfplumber'ом
- В строках типа «тип VС 33-50 L = 0,900м» поле `manufacturer="шт"` (это unit попавший не в ту колонку)
- Это **отдельный баг pdfplumber column detection**, не баг continuation
- Влияет на `multi-signal` heuristic (если шт → manufacturer, то PROPOSED считает строку независимой по ложному сигналу)
- Файлы: `scripts/extract_pdf_table.py` (header mapping logic)

## Текущее состояние рабочего дерева

- main HEAD: `a537932` (Step A runbook + STATUS handoff)
- Все temp-файлы удалены
- Никаких uncommitted code changes
- Untracked файлы пользователя оставлены как есть

## Команды быстрого восстановления контекста завтра

```bash
# Проверить где остановились
git log --oneline -6
cat docs/plans/STATUS.md
cat docs/plans/references/2026-05-16_handoff_continuation_bug.md

# Тест на 5-ПР_21 (быстрый, должен PASS)
# Воссоздать _step_a_local_test.ts если нужно

# Применить фикс
# Открыть backend/src/services/gigachatSpecFromPdf.ts
# Найти linkPdfParentChildren (строка 180+)
# Применить изменение из секции "Готовый к применению фикс" выше

# 5-ходовой цикл
cd backend && npm run build
node ../scripts/test-spec-parent-child.mjs  # ожидание 7/7
node ../scripts/bench-matching.mjs --label after-multisignal 18 20 28
```
