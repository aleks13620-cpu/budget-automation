# Research: рынок construction invoice reconciliation

Дата: 2026-05-15. Собрано 5 параллельными агентами (LinkedIn/founders, соцсети+OSS, SaaS-конкуренты, акселераторы+провалы, open source).

## TL;DR — что нашли

**Прямого аналога Budget Automation в РФ нет.** Сметные incumbent'ы (ГРАНД-Смета, Smeta.RU) сверяют смету против ФЕР, 1С/БИТ — сверяют деньги (акт сверки), Синтека — закрывает закупочный цикл внутри своего PO-flow. **Никто не делает построчную сверку внешней спецификации (Excel) с внешними накладными поставщиков (PDF/Excel)** для русского подрядчика.

**На западе ниша занята одной компанией.** Field Materials (Eldar Sadikov, $10.5M Series A апр-2025) — каноничный конкурент по сути и messaging. 9 интеграций с US-construction-ERP, LLM-pipeline на quotes/slips/invoices. Adaptive, Kojo, Buildertrend, Stampli — соседние слои (AP automation, procurement-first), не reconciliation post-fact.

**Тех-стек 2025/2026 сошёлся на гибриде:** детерминированный парсер (pdfplumber/docling) + LLM-fallback на сложных ячейках + probabilistic record linkage (Splink) вместо ручного Dice. RAG-over-tables на 2025 не взлетел — все бенчи показывают слабую multi-field extraction.

**Главный недозанятый whitespace индустрии — line items.** Header extraction (vendor/total/date) решён всеми (97%+). Построчная точность с parent-child иерархией остаётся главным дифференциатором даже у Reducto/Rossum.

## Главная дельта моего проекта

| Что | Где никто не закрывает | Почему это моё преимущество |
|---|---|---|
| **Parent-child в табличных PDF** | Никто публично не пишет про иерархию (раздел → подраздел → позиция) | У меня уже работает на 98% (pdfplumber + linkPdfParentChildren) |
| **RU-домен + GigaChat** | Все западные строят на OpenAI/Anthropic, не выйдут на РФ-рынок (compliance, серверы) | Geo-политическое окно 12–24 мес до того как Gectaro/Синтека добавят LLM |
| **External invoice reconciliation** | Kojo/Stampli требуют свой PO-flow; Field Materials matches against ERP-PO | Я матчу против произвольной Excel-сметы от заказчика, не требуя замены workflow |
| **Unit-of-measure нормализация** | Упоминается только в rental (days/weeks); полная нормализация м²↔м³↔т↔шт публично не декларируется | Естественная следующая фича на 12% покрытия full_name |

## 5 действий по результатам research

1. **Изучить Field Materials в деталях** — их messaging «−90% времени на PO/invoice» и UX 3-way match. Это roadmap.
2. **Заменить string-similarity (Dice) на Splink** — probabilistic record linkage с blocking rules решает и качество, и O(N×M) производительность одновременно. Это самый дешёвый upgrade с 24% к 40-50%.
3. **Forknуть Docling как fallback к pdfplumber** для PDF, где pdfplumber возвращает <50% строк. Покрытие парсинга вырастет с 98% baseline до близких к 100% на сложных формах.
4. **invoice2data YAML-шаблоны для топ-5 поставщиков** — снимет 60-80% объёма с LLM, ускорит и удешевит.
5. **Изучить Синтеку как самого опасного RU-конкурента** — снять UI, понять есть ли у них хотя бы OCR накладных. Если нет — у меня window 12–24 мес.

## Структура research

- [analogs.md](analogs.md) — таблица конкурентов (3 категории × 5–8 продуктов)
- [methodologies.md](methodologies.md) — архитектурные паттерны (hybrid parsing, agentic extraction, probabilistic linkage)
- [what-to-steal.md](what-to-steal.md) — конкретные решения готовые к интеграции
- [what-to-avoid.md](what-to-avoid.md) — провалы и их причины (Katerra, Veev), GTM-ловушки
- [delta.md](delta.md) — где именно моё уникальное преимущество
