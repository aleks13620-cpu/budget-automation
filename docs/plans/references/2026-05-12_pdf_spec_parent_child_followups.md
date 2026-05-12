# PDF spec parent/child — отложенные варианты (followups)

**Дата создания:** 2026-05-12
**Источник:** [retrospectives/12.05.26_pdf-позиции-экспертное-заключение.md](../../../retrospectives/12.05.26_pdf-позиции-экспертное-заключение.md)
**Связанный план:** локальный Cursor-план `pdf_spec_variant-children_fix_22290548.plan.md` (хранится в `.cursor/plans/` на машине автора согласно [docs/plans/README.md](../README.md) §5; не active, в репо не коммитится).
**Связанная проблема:** будет зарегистрирована в F1 (см. `docs/problem-registry.yaml`).

## Контекст

Активный путь — Вариант 1 из экспертного заключения: точечная правка `linkPdfParentChildren` и регрессионный набор фикстур. Ниже зафиксированы Варианты 2 и 3 как кандидаты на следующий active master-план, если Вариант 1 не закрывает 100% реальных кейсов в production.

## Вариант 2 — spec_parser_overrides на уровне проекта/поставщика

**Идея:** расширить существующий механизм `supplier_parser_configs.config.parser_overrides` (см. [backend/src/services/invoiceRouter.ts](../../../backend/src/services/invoiceRouter.ts), функции `readParserOverridesFromConfig` и `loadSupplierParserOverrides`) до уровня спецификаций (по проекту или поставщику оборудования). В конфиг кладётся карта колонок и правило parent/child (например: "строки в колонке Наименование без значения в колонке Позиция — варианты последнего родителя").

**Acceptance (на момент старта реализации):**
- Карта проекта/поставщика хранится в существующей таблице `supplier_parser_configs` (или новой `spec_parser_overrides` — решить при старте); миграция backward-compatible.
- Парсер `parseSpecFromPdf` загружает карту до `mapPdfItemsToRows` и использует её до общих эвристик.
- Оператор задаёт карту через UI один раз на проект/поставщика; повторные загрузки PDF этого же проекта парсятся стабильно.

**Риски:** scope creep (см. ретро 8.2). Если делать — строго ограничить scope одним типом override и одной точкой применения.

**Оценка:** 2–4 фазы по образцу Варианта 1 (followups → migration → loader → UI → deploy).

## Вариант 3 — LLM-verifier поверх результата GigaChat

**Идея:** после `parseSpecFromPdf` (см. [backend/src/services/gigachatSpecFromPdf.ts](../../../backend/src/services/gigachatSpecFromPdf.ts)) при `category !== 'A'` или малой длине items запускать Gemini Flash через уже подключённый OpenRouter (как в [backend/src/services/geminiOcr.ts](../../../backend/src/services/geminiOcr.ts)) для проверки "какие позиции/типоразмеры пропущены или склеены". Дополнять недостающие строки в существующий результат.

**Acceptance (на момент старта реализации):**
- Verifier вызывается только при category != A или count < N (порог зафиксировать в плане).
- Жёсткий timeout (урок ретро 8.3).
- Fallback на исходный JSON при любой ошибке Gemini.
- Метрики на эталонных фикстурах: variant_children_linked_ratio не падает (не должен регрессировать Вариант 1).

**Риски:** стоимость OpenRouter, latency, "другой класс ошибок" (склеивание строк моделью). Включаем только условно.

**Оценка:** 3 фазы (followups → service + integration → deploy с метриками).

## Когда поднимать

- Если в production после Варианта 1 остаются регрессии на нестандартных шаблонах поставщиков — поднимаем Вариант 2 в active как `plan_pdf_spec_overrides_<дата>.md` после закрытия `plan_stabilization_v2`.
- Если остаются ошибки даже с per-supplier картой (склейка строк моделью, missed variants) — поднимаем Вариант 3.
- НЕ поднимать оба одновременно: правило WIP=1.
