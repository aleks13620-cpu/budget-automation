# Аналоги — конкурентный ландшафт

## Категория 1: Construction-specific (запад)

| Продукт | Фичи | Цена/модель | Кто делает | Совпадение со мной |
|---|---|---|---|---|
| **Field Materials** | Парсит quotes/slips/invoices, 3-way match, 9 ERP интеграций | $10.5M Series A апр-2025, Navitas Capital | Eldar Sadikov (ex-Jetlore→PayPal) | **90%** — прямой конкурент по сути и messaging |
| **Kojo** | Procurement OS для trades, авто 3-way match (invoice↔PO↔delivery), $9.2M обработано | $94M raised, Series C | Maria Davidson (ex-Goldman) | **60%** — соседний слой: procurement-first, не reconciliation |
| **Adaptive** | AP automation + payments, ~700 customers, Procore интеграция | $19M Series A июль-2024 (a16z, Emergence) | Matt Calvano (Stanford MBA) | **40%** — pay-faster, не catch-errors |
| **Trunk Tools** | AI ответы по unstructured docs стройки | $30M (Redpoint) | Sarah Buchner | **15%** — другой use-case (field ops) |
| **Procore Pay + Levelset** | 3-way match только внутри их portal | $10–50K+/год, custom ACV | NYSE: PCOR | **30%** — закрытая экосистема, требует переход в Procore |
| **Buildertrend / CoConstruct** | Bill OCR auto-fill, без матчинга | $400–700/мес + per-user | residential US | **10%** — residential, без сверки |
| **Planyard** | "Invoices auto-matched to POs and subcontract agreements" — маркетинг идентичен моему | Bootstrapped, Estonia | Andres + co | **80%** по позиционированию, но они слабее по парсингу |

## Категория 2: AP automation / horizontal invoice matching

| Продукт | Фичи | Цена | Сегмент | Совпадение |
|---|---|---|---|---|
| **Stampli** | Line-level PO matching ("Billy the Bot"), STP 70–80% | По запросу, mid-market | 50–1000 чел | **50%** — против PO, не против внешней спеки |
| **Vic.ai** | 2/3/4-way match (invoice/PO/receipt/delivery) | Enterprise | Mid-large | **45%** — PO-centric |
| **Tipalti** | Mass-payee global AP | $500–2500/мес + transaction | Mid-market global | **20%** — payments-focused |
| **Bill.com** | SMB AP/AR | $45–79/user/мес | SMB US | **15%** — basic approval |
| **Rossum** | IDP extraction из инвойсов, top по точности | от $18K/год | Mid-large | **35%** — pipeline, не продукт. Сильное extraction, не reconciliation |
| **Nanonets** | OCR/IDP pay-per-page | $0.02–0.30/стр | SMB→Enterprise | **20%** — building block |
| **AppZen** | AI invoice audit с risk scoring | Enterprise | Fortune-500 | **30%** — аудит, не сверка |

## Категория 3: Российский рынок

| Продукт | Фичи | Цена | Сегмент | Совпадение |
|---|---|---|---|---|
| **ГРАНД-Смета** | RU-стандарт сметы, ~75% сметчиков, экспертиза против ФЕР | ~30–60K руб/раб.место, perpetual | Все сметчики RU | **15%** — сверка с нормативом, не с накладной. Доминирует в смете, пустая ниша в reconciliation |
| **Smeta.RU** | Альтернатива ГРАНД, импорт прайсов | Аналогично | Сметчики RU | **15%** — то же |
| **Турбосметчик** | Сметная программа, силён в РЖД | Lower-end | Сметчики (ж/д) | **10%** |
| **1С:Подрядчик / БИТ.Строительство** | Бухучёт стройки, КС-2/КС-3/М-29, акт сверки взаиморасчётов | от 50K руб + внедрение | Подрядчик 20–500 | **40%** — самый опасный по близости. Сверяет деньги (debit/credit), не line items |
| **Синтека** | Снабжение и закупки в стройке (RU SaaS) | По запросу, mid-market RU | Подрядчик/застройщик | **55%** — самый прямой RU-конкурент. Закрывает заявки→поставка, не reconciliation post-fact |
| **ПУСК.Снабжение** | Заявки/снабжение, IIDF Sprint | По запросу | RU подрядчик | **30%** — сосед, не прямой |
| **Gectaro** | 10 модулей: сметы, снабжение, КС-2/3, финучёт | По запросу | RU SMB подрядчик | **45%** — самый прямой sweep-end-to-end в РФ, но reconciliation не выделен как killer-feature |

## Кого изучать детальнее (приоритеты)

1. **Field Materials** (fieldmaterials.com) — их demo и blog. Лучший западный референс.
2. **Kojo Automated Invoice Matching** (usekojo.com/blog) — лучший UX для AI-assisted review разночтений.
3. **Stampli Billy the Bot** (stampli.com/ai-line-level-po-matching) — паттерн UX "15-минутного оператора".
4. **Синтека** (cynteka.ru) — снять скриншоты, понять есть ли у них хоть какой-то OCR накладных.
5. **Gectaro** (gectaro.com) — изучить как они продают модули, цены, как описывают reconciliation.

## Кто опасный конкурент

| Конкурент | Угроза | Защита |
|---|---|---|
| Синтека | Тот же сегмент, тот же язык. Если добавят парсинг внешних накладных — съедят | Скорость: успеть до того как они влезут в matching |
| 1С / БИТ | Уже стоят у клиента. Могут "достроить" модуль | Специализированный fuzzy/LLM + UX 15-минутного ревью, которого в 1С не будет никогда |
| Field Materials | Если выйдут на EAEU — угроза | Геополитическое окно 12–24 мес; GigaChat + ru-домен = их moat недостижим |
| Gectaro | Sweep-end-to-end, могут добавить reconciliation как модуль | Глубина одной операции против их ширины 10 модулей |
