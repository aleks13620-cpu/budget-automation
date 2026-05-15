# Что украсть — конкретные решения готовые к интеграции

Список решений, упорядоченных по соотношению "польза / стоимость внедрения". Каждое — что взять, откуда, как встроить.

## TOP-5 (внедрить ближайшие 2 месяца)

### 1. Splink для replace text similarity

**Источник:** https://github.com/moj-analytical-services/splink (UK Ministry of Justice, MIT, активный)

**Что взять:** probabilistic record linkage с blocking rules. EM-обучение весов полей. DuckDB-backend, миллион записей <2 минут.

**Как встроить в мой проект:**
- Python-микросервис рядом с pdfplumber (уже есть Python infra)
- Backend node вызывает через execFile, отдаёт два списка (spec items, invoice items)
- Splink возвращает пары с score + причиной (какое поле сколько весит)
- Blocking rules: «совпадает unit + первые 3 буквы нормализованного бренда» — отрежет 90% невозможных пар, решит O(N×M)
- Обучение: на `operator_feedback` (confirmed matches) → таблица уже есть
- Replace Tier 3 (current Dice) или дополнить как Tier 2.5

**Ожидаемый эффект:** 24% → 50–60% auto-match + время с 304s до <30s на проекте 28.

**Цена:** 5–10 дней работы.

---

### 2. Docling как fallback к pdfplumber

**Источник:** https://github.com/docling-project/docling (IBM, MIT, ежемесячные релизы)

**Что взять:** TableFormer + layout detection для borderless/merged cells. Лидер 2025 бенчей (97.9% accuracy на сложных таблицах).

**Как встроить:**
- Запуск через Python subprocess, тот же entry-point что и pdfplumber
- Триггер: если pdfplumber вернул <50% строк или 0 числовых ячеек → прогнать через Docling
- Объединить результаты в существующий ParseResult
- В тот же `linkPdfParentChildren()` (continuation merging работает одинаково)

**Ожидаемый эффект:** покрытие парсинга 98% → 99%+ на сложных PDF.

**Цена:** 2–3 дня.

---

### 3. RapidFuzz вместо string-similarity (JS)

**Источник:** https://github.com/rapidfuzz/RapidFuzz, npm `rapidfuzz`

**Что взять:** C++ ядро, 10–50× быстрее fuzzywuzzy/string-similarity. token_set_ratio работает на русских наименованиях с переставленными словами.

**Как встроить:** replace `import stringSimilarity` на `import { ratio, tokenSetRatio } from 'rapidfuzz'` в `matcher.ts`. Если в итоге выбираем Splink (пункт 1), RapidFuzz не нужен. Если Splink откладываем — это самый дешёвый perf-fix.

**Цена:** 1 день.

---

### 4. invoice2data YAML-шаблоны для топ-5 поставщиков

**Источник:** https://github.com/invoice-x/invoice2data (MIT)

**Что взять:** template-based extraction. Один YAML на поставщика = поля парсятся regex'ом без LLM.

**Как встроить:**
- Identify топ-5 поставщиков по объёму счетов в БД
- Написать YAML-шаблон на каждого (vendor name, total, line item pattern)
- В pipeline: сначала try invoice2data → если матч шаблона, использовать → если нет, fallback на pdfplumber + LLM
- Шаблоны хранить в `backend/data/invoice-templates/<supplier_id>.yaml`

**Ожидаемый эффект:** 60–80% объёма счетов парсится без LLM. Экономия токенов GigaChat. Скорость +10×.

**Цена:** 3–5 дней + по 30 минут на каждого нового поставщика.

---

### 5. Natasha для русских единиц измерения

**Источник:** https://github.com/natasha/natasha (MIT, лёгкая русская NLP)

**Что взять:** морфология и лемматизация русского. «штука/штуки/шт./шт» → одна лемма.

**Как встроить:**
- Python helper в pipeline нормализации
- Заменит часть regex-логики в `normalizeForMatching()` для русских units
- Работает с минимальными ресурсами (без GPU)

**Цена:** 2 дня.

---

## TOP-5 (через 3–6 месяцев)

### 6. Field Materials UX-pattern: «catch errors before pay» messaging
Не код, а позиционирование. Их фраза «90% reduction in PO/invoice processing» работает. Моя адаптация: «−X часов сметчика в неделю». Применить в лендинге.

### 7. Kojo's invoice matching UX
Изучить https://www.usekojo.com/blog/introducing-automated-invoice-matching и снять паттерны inline-diff, confidence buckets, bulk-actions для моего UI.

### 8. Stampli Billy the Bot — UX «AI помощник»
Inline-чат с AI прямо в строке invoice. Применить как low-priority UX-эксперимент.

### 9. Splink + DuckDB вместо SQLite для матчинга
Если объём вырастет до миллиона позиций — DuckDB решает batch-аналитику быстрее SQLite. Сохранить SQLite как primary OLTP, DuckDB как read-replica для матчинга.

### 10. Распарсить ФЕР/ГЭСН и выложить в OSS
Минстрой публикует расценки как PDF/Excel. Парсера в open source нет. Если я сделаю — это SEO/community + leadgen в РФ.

---

## Чего НЕ брать (отвергнуто после анализа)

| Решение | Почему не |
|---|---|
| **Donut / LayoutLMv3** | Нужны размеченные 500+ счетов для fine-tune; overkill на стадии MVP |
| **Marker (PDF→Markdown)** | GPL-3.0 заразный для коммерческого кода. CLI можно, но Docling лучше и MIT |
| **Zingg** | AGPL-3.0 убийственна для SaaS (обязан раскрывать код) |
| **IfcOpenShell** | BIM/IFC файлы, не мой кейс |
| **DeepPavlov NER** | Обучен на новостях, для строительных терминов не работает |
| **Camelot/Tabula** | Устарели на фоне Docling |
| **Unstructured.io** | Хорош, но Docling делает то же лучше |
