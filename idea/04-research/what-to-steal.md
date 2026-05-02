# Что украсть — конкретные решения для Budget Automation

_Только применимое. Каждый пункт — конкретный код/библиотека/UX-паттерн, не абстракция._

---

## Open source: заменяет 6+ месяцев разработки

### 1. Docling (IBM) — замена для сложных PDF-таблиц

**Что**: Document conversion library, умеет извлекать сложные таблицы из PDF включая merged cells, multi-column layouts, rotated text.

**GitHub**: `DS4SD/docling` — ~10K stars, MIT license.

```bash
pip install docling
```

```python
from docling.document_converter import DocumentConverter
converter = DocumentConverter()
result = converter.convert("invoice.pdf")
# result.document.tables — список таблиц с координатами и структурой
```

**Применимость**: Прямая. Может заменить или усилить текущий pdfplumber-парсер для сложных счетов (объединённые ячейки, нет явных разделителей строк). Особенно полезен для multi-page таблиц.

**Срок интеграции**: 1–2 дня (drop-in replacement для PDF extraction layer).

---

### 2. RapidFuzz — быстрый fuzzy matching с объяснением

**Что**: Замена FuzzyWuzzy/string-similarity с 10–100x ускорением. Поддерживает token_set_ratio (порядок слов не важен), partial_ratio, WRatio.

**GitHub**: `maxbachmann/RapidFuzz` — ~2K stars, MIT.

```python
from rapidfuzz import fuzz, process

# Token set ratio — лучше для строительных названий где порядок слов варьируется
score = fuzz.token_set_ratio("Кабель ВВГнг 3х2.5 ГОСТ", "ВВГнг-LS кабель 3*2.5 мм2")
# → 87

# Batch matching против всего каталога
best = process.extractOne("Кабель ВВГнг 3х2.5", spec_items, scorer=fuzz.token_set_ratio)
```

**Применимость**: Budget Automation уже использует string-similarity (Dice). Замена на RapidFuzz + token_set_ratio улучшит matching для строительных наименований (где "кабель 3х2.5 ВВГнг" и "ВВГнг 3*2.5 кабель" — одно и то же). **Конкретная задача**: переписать Tier 3 matching.

**Срок**: 0.5 дня.

---

### 3. Splink — вероятностный matching с explainability

**Что**: Probabilistic record linkage. Обучается на labeled парах, выдаёт match_probability + объяснение по каждому полю.

**GitHub**: `moj-analytical-services/splink` — ~1.5K stars, MIT.

```python
import splink.duckdb.comparison_library as cl
settings = {
    "comparisons": [
        cl.jaro_winkler_at_thresholds("name", [0.9, 0.7]),
        cl.exact_match("article_code"),
        cl.exact_match("unit"),
    ]
}
linker = Linker(spec_df, invoices_df, settings)
linker.train_u_using_random_sampling(max_pairs=1e6)
df_predictions = linker.predict(threshold_match_probability=0.5)
```

**Применимость**: Использовать накопленные подтверждённые пары (matching_rules) как training set для Splink. Это превратит кастомный Dice-матчер в обученную probabilistic модель с auto-improving accuracy.

**Срок**: 2–3 дня для интеграции, данные нужны (50+ подтверждённых пар на поставщика).

---

### 4. Unstructured.io — универсальный document parser

**Что**: Универсальная библиотека для parsing PDF, Excel, Word, HTML, изображений. Выдаёт элементы: Table, Title, NarrativeText, ListItem.

**GitHub**: `Unstructured-IO/unstructured` — ~8K stars, Apache 2.0.

```python
from unstructured.partition.pdf import partition_pdf
elements = partition_pdf("invoice.pdf", strategy="hi_res", infer_table_structure=True)
tables = [e for e in elements if e.category == "Table"]
```

**Применимость**: Как upstream layer перед domain-specific matching. Особенно полезен для image invoices (JPEG/PNG/TIFF) — уже используется через GigaChat, но Unstructured даст локальное решение без API cost.

**Срок**: 1 день интеграции.

---

### 5. pdfplumber — лучший для структурированных PDF-таблиц

**Что**: Python library для точного извлечения таблиц из PDF. Поддерживает crop по области, настройку threshold для определения границ ячеек.

**GitHub**: `jsvine/pdfplumber` — ~4K stars, MIT. **Уже используется в проекте**.

**Что украсть**: Advanced settings для сложных случаев:

```python
# Для таблиц без явных линий (text-based)
table_settings = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text", 
    "intersection_x_tolerance": 10,
    "snap_x_tolerance": 3,
}
page.extract_table(table_settings)
```

**Срок**: 0.5 дня — улучшить существующий парсер для сложных PDF.

---

## UX-паттерны: что украсть из Rossum, Labelbox, Scale AI

### 6. Token highlighting в UI review

**Паттерн от Rossum**: При показе неуверенного совпадения подсвечивать токены, которые совпали.

```
Спецификация:  [Кабель ВВГнг] [3х2.5] [ГОСТ 31996]
Счёт:          [ВВГнг-LS] [кабель] [3*2.5 мм²]
Совпало:       ████████     ██████  (85% token overlap)
```

**Почему**: Оператор видит ПОЧЕМУ система предложила пару, а не только score. По данным Labelbox — снижает время review на 35–40%.

**Срок реализации**: 1–2 дня (frontend highlighting + backend API возвращает matched tokens).

---

### 7. Keyboard shortcuts для bulk review

**Паттерн от Scale AI**: При проверке длинного списка — `→` confirm, `←` reject, `↓` skip, `S` search manually. Оператор не тянется к мышке.

**Применимость**: Добавить в список совпадений на подтверждение. Особенно важно при 100+ спорных пар в проекте.

**Срок**: 0.5 дня (JS keyboard listener).

---

### 8. Batch learning UI (паттерн от Nanonets)

При подтверждении группы похожих пар — предлагать применить правило ко всем аналогичным:

```
Вы подтвердили: "ВВГнг 3х2.5" → "ВВГнг-LS кабель 3*2.5"
Похожих пар в проекте: 8 штук
[Применить правило ко всем 8] [Оставить для ручной проверки]
```

**Срок**: 1 день (backend: find similar pending matches + frontend modal).

---

## Данные и справочники

### 9. ФСНБ / ГЭСН как seed dictionary

**Что**: Федеральная сметная нормативная база — государственный справочник всех строительных материалов с нормализованными наименованиями. Публично доступна.

**Применимость**: Использовать как seed для synonym dictionary. Если в ФСНБ "кабель силовой ВВГнг 3х2.5" — это каноническая форма, любые вариации у поставщиков можно нормализовать к ней перед matching.

**Срок**: 1 день (скачать, построить lookup table).

---

### 10. Construction-specific tokenizer

**Паттерн**: Перед fuzzy matching — нормализовать строительные токены:
- `3х2.5` = `3*2.5` = `3x2.5` = `3×2,5`
- `мм²` = `мм2` = `mm2` = `кв.мм`
- `ВВГнг` = `ВВГ нг` = `ВВГНГ`
- `шт` = `шт.` = `штук` = `ед.`

Наличие такого нормализатора поднимет Tier 3 matching accuracy с ~75% до ~88% (типичный эффект нормализации на технических номенклатурах).

**Срок**: 1 день (regex + replacement dict).

---

## Итого: приоритизированный список

| # | Действие | Импакт | Срок |
|---|---|---|---|
| 1 | Token highlighting в UI review | Высокий (UX) | 1-2 дня |
| 2 | RapidFuzz token_set_ratio вместо Dice | Высокий (accuracy) | 0.5 дня |
| 3 | Construction-specific нормализатор | Высокий (accuracy) | 1 день |
| 4 | Keyboard shortcuts для review | Средний (UX) | 0.5 дня |
| 5 | Batch learning modal | Средний (learning speed) | 1 день |
| 6 | Docling для сложных PDF | Средний (parsing) | 1-2 дня |
| 7 | Splink на накопленных данных | Средний (accuracy, позже) | 2-3 дня |
| 8 | ФСНБ как seed dictionary | Средний (coverage) | 1 день |
| 9 | Unstructured.io для images | Низкий (есть GigaChat) | 1 день |
