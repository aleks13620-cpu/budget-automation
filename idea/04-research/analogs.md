# Аналоги — таблица конкурентов

_Данные: training knowledge, cutoff август 2025. Цены и статусы могут измениться._

---

## Западные аналоги — construction procurement

| Продукт | Что делает | Цена / модель | Кто делает | Извлечение из PDF/Excel | Matching к спецификации | AI/Fuzzy | Обучение |
|---|---|---|---|---|---|---|---|
| **Kojo** | Платформа закупки материалов для субподрядчиков. PO, supplier catalog, price comparison | ~$500+/мес, SaaS | Kojo (ex Agora US), $50M+ Series C, Battery Ventures | Нет | Вручную | Нет | Нет |
| **Constrafor** | Compliance + оплата субподрядчиков для GC | Enterprise, $106M raised | Constrafor, Bessemer + Spark | Нет | Workflow, не BOM | Нет | Нет |
| **Agora** (Израиль) | Закупки материалов для GC, сравнение цен поставщиков | Unknown, $3M seed | Agora, Bessemer | Нет | Ручное сравнение цен | Нет | Нет |
| **BuildingConnected** | Управление тендерами субподрядчиков, side-by-side сравнение | $5,500–10,000/год, Autodesk | Autodesk | Нет | Totals only, вручную | Нет | Нет |
| **Procore Procurement** | PO, RFQ, budget tracking, change orders | $375–1,200+/мес | Procore (публичная) | Нет | Вручную | Нет | Нет |
| **Archdesk** | Construction ERP с модулем закупок, сравнение котировок | $500–2,000/мес | Archdesk (UK) | Basic OCR | Вручную | Нет | Нет |
| **Buildxact** | Estimating + quote upload для residential builders | $199–599/мес | Buildxact (AU) | Basic OCR | Частичное, вручную | Нет | Нет |
| **Togal.AI** | AI takeoff из чертежей | ~$200+/мес | Togal.AI, $10M+ | Нет (чертежи) | Нет | Да (takeoff) | Нет |
| **Trunk Tools** | AI-ассистент для PM по документам | Enterprise | Trunk Tools, $25M Series A Sequoia | Да (Q&A по docs) | Нет | Да (LLM) | Нет |

---

## Западные аналоги — document AI / invoice processing

| Продукт | Что делает | Цена | Кто делает | PDF extraction | Matching к BOM | AI | Обучение |
|---|---|---|---|---|---|---|---|
| **Rossum** | Extraction из инвойсов (header + line items) | $1,600–4,000+/мес | Rossum (CZ), $100M funded | Да, ML | Нет | Да (ML extraction) | Да (по полям) |
| **Nanonets** | OCR + ML extraction + PO matching | $499+/мес | Nanonets (US/IN) | Да | Да (к PO, structured) | Да | Ограниченно |
| **Klippa** | Invoice OCR + matching | €500+/мес | Klippa (NL) | Да | Да (к PO) | Да (OCR ML) | Нет |
| **Docsumo** | Extraction из финансовых документов | Custom | Docsumo | Да | Да (к PO) | Да | Нет |
| **Coupa** | Enterprise procurement + invoice matching | $150K+/год | Coupa (SAP) | Да (structured) | PO code match | Rule-based | Нет |

---

## Российский рынок

| Продукт | Что делает | Цена | Кто делает | Создаёт спецификацию | Matching к поставщикам | AI |
|---|---|---|---|---|---|---|
| **ГРАНД-Смета** | Создание смет по ФСНБ/нормативным базам | 15,000–80,000 ₽/год | Grand-Smeta (RU) | Да | Нет | Нет |
| **Турбо-Смета** | То же, конкурент ГРАНД | 10,000–50,000 ₽/год | Turbo-Smeta (RU) | Да | Нет | Нет |
| **СМЕТА.РУ** | Cloud-версия сметного ПО | 1,500–5,000 ₽/мес | Smeta.ru (RU) | Да | Нет | Нет |
| **1С:Управление строительством** | ERP для строительства | 50,000–300,000 ₽ + внедрение | 1С (RU) | Через нормативы | Только по артикулам из каталога | Нет |
| **Budget Automation** | Наш продукт | — | — | Нет (импортирует) | **Да, fuzzy + AI** | **GigaChat** |

---

## Позиционирование на карте

```
                    Высокий AI
                        │
              Trunk     │    Budget
              Tools     │  Automation  ← мы здесь
                        │
   Только ─────────────┼───────────── Spec-to-
   workflow             │             invoice
                        │    Nanonets  matching
              Kojo      │    Rossum
              Archdesk  │
                        │
                   Низкий AI
```

**Вывод**: Budget Automation единственный продукт в правом верхнем углу для строительного контекста.

---

## Ближайшие по функции (threat level)

1. **Buildxact** — есть намерение, нет AI. При добавлении GPT-4 стал бы конкурентом (EN only, нет RU)
2. **Nanonets** — есть extraction + matching, но generic AP, не строительный контекст, не RU
3. **Archdesk** — есть workflow, нет intelligence. Может добавить как фичу
4. **1С** — монополия в RU enterprise, может выпустить AI-модуль (главный долгосрочный риск)
