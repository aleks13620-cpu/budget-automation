# Архитектурные паттерны конкурентов

_Что использует рынок: agent loops, matching pipelines, HITL, active learning._

---

## 1. Hybrid cascade pipeline (самый распространённый)

Паттерн: несколько слоёв matching от дешёвого к дорогому, каждый следующий вызывается только при неудаче предыдущего.

```
Rule-based (артикул) → Fuzzy string (название) → Embedding similarity → LLM validation → Human review
        ↓ hit                ↓ hit                    ↓ hit                  ↓ hit
       done                 done                      done                  done
```

Кто использует: Nanonets, Rossum (частично), академические record linkage системы.

**Budget Automation уже реализует это** — 4-уровневый алгоритм + GigaChat Tier 5. Это правильный выбор.

Ключевые метрики каскада:
- Tier 1–2 должны закрывать 70–80% случаев (дёшево)
- Tier 3–4 — ещё 15%
- LLM — только 5–10% (дорого)
- Human — <5% (только реально спорные)

---

## 2. Probabilistic record linkage (Fellegi-Sunter model)

Используется в: Splink, dedupe.io, government data linking (UK ONS, US Census).

Идея: вместо threshold (совпадение ≥ 0.85) — вероятностная модель, обученная на labeled парах. Каждое поле (название, артикул, единица) имеет свой вес, финальный score — произведение весов.

```python
# Splink-подход
m_probability_name = 0.9   # P(match | same name)
u_probability_name = 0.01  # P(match | different name, random)
weight_name = log(m/u)     # = log(90) ≈ 4.5
```

**Применимость к Budget Automation**: Splink можно форкнуть как движок matching вместо кастомного Dice. Даёт explainability — "эта пара совпала на 94% потому что артикул +4.5, название +3.2, производитель +1.8".

---

## 3. Active learning loop (Human-in-the-Loop)

Паттерн, который используют Scale AI, Labelbox, Rossum, Nanonets для дообучения моделей:

```
Модель делает предсказание
         ↓
Confidence < threshold → показываем оператору
         ↓
Оператор подтверждает/исправляет
         ↓
Пара попадает в training set
         ↓
Периодически переобучаем модель → порог confidence растёт
```

**Budget Automation реализует это** через matching_rules. Следующий шаг — использовать накопленные пары для переобучения fuzzy-weights (не только хранить правила, но и корректировать веса).

---

## 4. Document understanding pipeline (pre-LLM era vs LLM era)

**Pre-LLM (2018–2022)**:
```
PDF → OCR (Tesseract/AWS Textract) → Table detection (heuristics) → Field extraction (regex + ML classifier) → Output
```

Ограничение: каждый формат документа требовал отдельного шаблона.

**LLM era (2023+)**:
```
PDF → Vision/text extraction → LLM prompt ("извлеки таблицу с полями: название, количество, цена") → Structured JSON
```

Ограничение: дорого, медленно, недетерминировано.

**Hybrid (оптимальный, 2024–2025)**:
```
PDF → pdfplumber/Camelot (таблицы) → Нашли таблицу? → structured extraction
                                    → Не нашли? → LLM fallback
```

Это именно то, что делает Budget Automation (классический парсер → GigaChat fallback). Это правильная архитектура.

---

## 5. Multi-agent architecture (trending 2024–2025)

Паттерн, продвигаемый LangChain, LlamaIndex, AutoGen:

```
Orchestrator Agent
    ├── Extraction Agent (читает документ)
    ├── Normalization Agent (стандартизирует единицы, НДС)
    ├── Matching Agent (fuzzy + rules)
    ├── Validation Agent (проверяет спорные пары через LLM)
    └── Export Agent (формирует Excel)
```

Trunk Tools использует этот паттерн для construction document Q&A. Применимость к Budget Automation — умеренная: агенты добавляют latency и стоимость. Оправданы только там, где нужна реальная параллельность.

---

## 6. OODA loop для HITL систем

Observe → Orient → Decide → Act

Применяется в системах с человеком в петле (Labelbox, Scale AI RLHF):

- **Observe**: система показывает оператору неуверенные совпадения (confidence < 0.8)
- **Orient**: UI помогает оператору понять ПОЧЕМУ система предложила эту пару (highlighting совпавших токенов)
- **Decide**: оператор confirm/reject/выбрать другое
- **Act**: правило сохраняется, confidence threshold пересчитывается

Budget Automation реализует Observe + Act. Пробел — **Orient**: операторам сейчас неясно, почему система предложила конкретную пару. Добавление объяснения ("совпало по артикулу 4АП + ключевым словам кабель/медь/0.75мм²") снизит время review на ~40% (данные из исследований Labelbox).

---

## 7. Supplier-specific learned models

Паттерн от enterprise procurement AI (Ivalua, Zycus):

Каждый поставщик имеет свою "модель нормализации" — словарь его специфических сокращений, типичных форматов артикулов, структуры таблиц.

Budget Automation реализует это через parser configs по поставщику. Следующее развитие — хранить не только column mapping, но и per-supplier synonym table из подтверждённых пар.

---

## Итоговая оценка архитектуры Budget Automation

| Паттерн | Статус в BA | Зрелость |
|---|---|---|
| Hybrid cascade pipeline | ✅ Реализован (4 tier + GigaChat) | Зрелый |
| Active learning из подтверждений | ✅ Реализован (matching_rules) | Базовый |
| Per-supplier learned config | ✅ Реализован | Базовый |
| Probabilistic record linkage | ❌ Нет (используется Dice similarity) | Возможность улучшить |
| OODA Orient (объяснение пар) | ❌ Нет | Quick win для UX |
| Multi-agent pipeline | ❌ Нет (монолитный сервис) | Не нужен сейчас |
| Weights update из накопленных данных | ❌ Нет | Средний приоритет |
