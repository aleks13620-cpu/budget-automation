# Методологии и архитектурные паттерны

Что используют успешные игроки и open source. Только применимое к моему проекту.

## 1. Hybrid parsing (детерминированный + LLM-fallback)

**Кто использует:** Docling (IBM), Reducto, Field Materials, ChatFin. Все 2025 бенчи (docling vs llamaparse vs unstructured) сходятся на одном: **best result = pdfplumber/camelot + LLM только на сложных ячейках**.

**Паттерн:**
```
1. pdfplumber / docling → структурированный JSON (97% покрытие)
2. Если confidence < threshold или строк <50% от ожидаемого:
   2a. layoutparser/Donut → визуальный fallback
   2b. LLM (GigaChat / Gemini) → семантический fallback на спорных строках
3. Pre/post-processing на детерминированных правилах (units, lemmatization, parent-child)
```

**Применимо у меня:** уже делаю. Что добавить — Docling как 2-й fallback перед LLM, удалит часть провалов pdfplumber на borderless таблицах.

**Что НЕ работает:** pure LLM на всех PDF (медленно, дорого, нестабильно), RAG-over-tables как primary path (HN 47499356 подтверждает провал multi-field extraction).

## 2. Agentic extraction / VLM на скриншотах

**Кто использует:** LandingAI, Reducto, LlamaParse. Идея: скриншот страницы → vision LLM → структура. "Don't bother parsing, use images for RAG" (HN 44637715).

**Применимо у меня:** **не сейчас.** VLM-инференс долгий и дорогой, GigaChat-Pro Vision доступен но не подходит для production-volume. Когда-то в будущем — для самых битых сканов как 3-й fallback.

## 3. Probabilistic record linkage (Fellegi-Sunter)

**Кто использует:** Splink (UK Ministry of Justice), Zingg, dedupe.io. **Самый важный паттерн для меня.**

**Что это:** вместо одной формулы similarity ты учишься на парах "match/non-match" подбирать веса полей. Field weights через EM-алгоритм. Blocking rules (inverted index) убирают 95% невозможных пар до сравнения.

**Сравнение с моим текущим Dice:**

| | Dice (что у меня) | Splink (probabilistic linkage) |
|---|---|---|
| Точность | Одна формула на всё | Учится на исторических парах |
| Скорость | O(N×M) | O(N+M) после blocking |
| Объяснимость | "0.62 сходство" | "0.62 потому что unit совпал (×3.2) и brand близкий (×2.1)" |
| Качество | 24% match на проекте 28 | 50–70% реалистично после обучения |

**Применимо у меня:** заменить text similarity layer на Splink-пайплайн. Blocking: одинаковая единица измерения + первые 3 буквы нормализованного бренда. Обучение: на confirmed_matches из БД (operator_feedback уже есть).

## 4. Multi-tier matching с early exit

**Кто использует:** Stampli ("Billy the Bot"), Vic.ai, Kojo. Принцип: дешёвые проверки сначала, дорогие в конце.

**Tier-pattern:**
```
Tier 0: exact article match → confidence 0.98, early exit
Tier 1: equipment_code substring → 0.92
Tier 2: learned rules (negative блок + positive match)
Tier 3: name similarity / probabilistic linkage
Tier 4: name+characteristics
Tier 5: LLM batch (только для unmatched)
```

**Применимо у меня:** уже сделал. Что добавить:
- **Early exit при bestConfidence ≥ 0.95** — не идти в следующий тир
- **Pre-filter правил по supplier_id через Map** (а не linear scan)
- **Кэш specNormName** (сейчас пересчитывается в цикле)

## 5. Template-based extraction для повторяющихся форм

**Кто использует:** invoice2data (OSS), Rossum, Klippa. У каждого крупного поставщика свой формат → один YAML/regex шаблон → дальше парсинг без LLM.

**Применимо у меня:** топ-5 поставщиков по объёму → 5 шаблонов → 60–80% объёма счетов парсится без LLM. Экономия токенов и времени.

## 6. UX 15-минутного ревью (operator-in-the-loop)

**Кто использует:** Stampli (gold standard UX), Field Materials, Kojo. Принцип: AI делает 80%, оператор кликает только на 15–20 спорных позициях.

**Паттерн UI:**
- **Confidence buckets:** «high (auto)», «medium (review)», «low (manual)»
- **Inline diff:** показать spec ↔ invoice бок-о-бок, подсветить расхождения (qty/unit/brand)
- **One-click confirm/reject** с keyboard shortcuts (Y/N/Space)
- **Bulk-actions:** «принять все high», «отклонить все < 0.4»
- **Learning loop:** каждый клик → строка в operator_feedback → правило в matching_rules

**Применимо у меня:** проверить текущий UI на эти 5 паттернов. Скорее всего 2–3 уже есть, 2–3 надо добавить.

## 7. Distribution через стратегического партнёра

**Кто использует:** Kojo (Wesco invested + distribution), Field Materials (9 ERP интеграций как канал).

**Урок:** в construction cold-outbound даёт 0.05% meeting-booked rate (Cannonball GTM). Реальный канал — партнёрство с дистрибьютором/франчайзи/ассоциацией.

**Применимо у меня:** мой "Wesco" в РФ — 1С-франчайзи, отраслевые ассоциации (РСС, НОСТРОЙ), крупные стройбазы (Леруа Pro, Петрович).

## Что игнорировать

| Паттерн | Почему не подходит |
|---|---|
| Pure LLM на всём | Медленно, дорого, нестабильно — все бенчи против |
| RAG-over-tables как primary | Провалы на multi-field extraction (HN 47499356) |
| Fine-tune LayoutLM/Donut под себя | Нужны размеченные 500+ счетов, нет на стадии MVP |
| Заменять весь workflow клиента | Katerra умерла именно от этого |
| Cold-outbound SDR | 0.05% conversion в строителях |
