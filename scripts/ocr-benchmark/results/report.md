# Gemini 2.5 Flash — OCR Benchmark Report
**Model:** google/gemini-2.5-flash via OpenRouter  
**Benchmarks matched:** 12/12  
**Total cost:** ~$0.025 (167K tokens)

## Aggregate Scores

| Metric | Score | Threshold | Status |
|--------|-------|-----------|--------|
| Overall score | **99.5%** | ≥85% | ✅ |
| Name match | 99.5% | ≥80% | ✅ |
| Price match (±5%) | 99.3% | ≥80% | ✅ |
| Item count ratio | 100.0% | ≥80% | ✅ |

## Decision

**✅ INTEGRATE** — Gemini 2.5 Flash meets the quality bar. Proceed to OCR-4 integration.

## Per-Document Results

| Supplier | Overall | Items ref/gem | Name% | Price% | Notes |
|----------|---------|---------------|-------|--------|-------|
| Веза-Самара | 100% | 5/5 | 100% | 100% | |
| ООО "ВОДОМЕР" | 100% | 2/2 | 100% | 100% | |
| ООО "ЭЛИТА-Центр" | 100% | 2/2 | 100% | 100% | |
| САНТЕХПРОМ | 100% | 23/23 | 100% | 100% | |
| Итеса | 100% | 18/18 | 100% | 100% | |
| ООО "Дюкс" | 100% | 3/3 | 100% | 100% | |
| ООО "ИТЕСА" | 100% | 11/11 | 100% | 100% | |
| ООО ПК "СТМ" | 100% | 14/14 | 100% | 100% | |
| ООО "ПОЖАРКА 63" | 100% | 7/7 | 100% | 100% | |
| Общество с ограниченной ответс | 100% | 9/9 | 100% | 100% | |
| РОВЕН-Самара | 100% | 9/9 | 100% | 100% | |
| Электротехмонтаж | 94% | 34/34 | 94% | 91% | |

## Category C (Scanned PDFs) Detail

| File | Text len | Garbage% | Gemini items | Status |
|------|----------|----------|--------------|--------|
| Арктика Предложение 873786 от 01.11.2025 (1). | 675 | 41% | 0 | ❌ Empty |
| ПК Курс doc02851820251216123708 (1).pdf | 0 | 100% | 0 | ❌ Empty |
| ПК Курс doc02851820251216123708 (1)1.pdf | 0 | 100% | 0 | ❌ Empty |

## Worst-Matched Items (name_sim < 0.75)

| Supplier | Expected name | Gemini name | Sim |
|----------|---------------|-------------|-----|
| Электротехмонтаж | Саморез 3.5x35 мм (1000 шт | Саморез 3.5х35 мм (1000 шт/уп) РTK-Acc e | 0.58 |
| Электротехмонтаж | /уп) PTK-Acc essories (состав ОКЛ) | Саморез 3.5х35 мм (1000 шт/уп) РTK-Acc e | 0.70 |
