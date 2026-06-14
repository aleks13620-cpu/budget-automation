# Воркер-бриф: канонический каталог-паспортов товаров (KB), бутстрап рабочим ИИ

> **СТАТУС: ОДОБРЕНО владельцем 2026-06-06, параллельно с parser_ai_hierarchy.**
> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation` и напиши: «выполни docs/plans/active/worker_brief_canonical_kb_bootstrap.md». Самодостаточно.

## Роль
Воркер. Ветка `feat/canonical-kb`, без push/деплоя. Прод/БД/проект 11 не трогать. По завершении — `worker_brief_canonical_kb_bootstrap_result.md`.

## Контекст (главное)
Сейчас «знание» матчера = ТОЧНЫЕ строковые пары (`construction_synonyms`, `matching_rules`), применяются через строковую похожесть ≥0.65 (`backend/src/services/matcher.ts:545-548`). На по-настоящему другом имени того же товара — 0% (измерено офлайн-харнессом `feat/verity-harness`: AI-OFF 0% / AI-ON 89.3% через Gemini-OpenRouter). Знание НЕ обобщается по смыслу — копится «вширь», не «вглубь».

**Стратегия владельца:** строить **канонический каталог-паспортов товаров** (тип + DN + признаки), бутстрапить РАБОЧИМ ИИ (Gemini): его 89% верных матчей → канонические записи; со временем durable растёт, AI-зависимость падает, знание переносится cross-project.

## Цель (фаза 1 — фундамент, НЕ полная стройка)
Создать минимальную работающую инфраструктуру каталога. **Это первая фаза**: схема + наполнение из подтверждённых матчей (бутстрап) + смок-замер «помогает ли». Полную интеграцию в матчинг (фаза 2) НЕ делать в этой задаче — только заложить чистый API.

## Скоуп
1. **Схема:** новая миграция в `backend/src/database/init.ts` (или новый файл `backend/migrations/`). Минимальная схема:
   ```
   canonical_products (id PK, canonical_name, product_type, key_attributes JSON, created_at, source TEXT)
   product_aliases (id PK, canonical_product_id FK, alias_text, source TEXT, confidence, supplier_id NULL, created_at)
   UNIQUE INDEX (alias_text, COALESCE(supplier_id, -1))
   ```
   `key_attributes` хранит структурированные признаки (DN, типоразмер, маркировка) — повторно использовать токены из `extractMarkingFeatures` в `backend/src/services/matcher.ts` (уже есть: dn, cross, config, marks, sizes). Глобальная (без project_id) — должна выживать удаление проекта (как `construction_synonyms`/`matching_rules`).
2. **Бутстрап-скрипт** `scripts/bootstrap-canonical-kb.mjs`:
   - Источник 1: операторские подтверждения с прода (`http://5.42.103.63:3001/api/projects/:id/matching`, read-only) — берём только пары с `is_confirmed=1`.
   - Источник 2: исторические эталоны владельца (Excel из `C:\Users\home\Downloads\`: «Новая Самара выход», «Совжи ВК/ОВ», «Сокольи выход», «Престиж комбо» — список в `docs/plans/active/data_handover_spec_for_owner_2026-06-06.md`).
   - Для каждой пары спека↔товар: извлеки канонический паспорт (тип+признаки через `extractMarkingFeatures`), нормализуй каноническое имя, добавь в `canonical_products`; обе строки (спека и счёт) → в `product_aliases`.
   - **Дедуп**: если паспорт уже есть (тот же тип + признаки) — не дублировать, alias просто добавить.
3. **Простой API чтения** (НЕ интегрировать в матчер!):
   - `getCanonicalByAlias(text)` → `canonical_product | null` (точное совпадение alias).
   - `getCanonicalByAttributes(features)` → `canonical_product[]` (по совпадению ключевых признаков).
   - Опц.: эндпоинт `GET /api/canonical/:id` для диагностики.
4. **Смок-замер на офлайн-харнессе:**
   - На том же `feat/verity-harness` пуле Сокольих (16-28 пар) измерь: сколько пар закрывается через каталог ДО матчера (точный alias-хит) и сколько через признаки. Сравни с baseline AI-OFF 0%.
   - Это первый durable-сигнал «работает ли каталог в принципе».

## Тестирование — ОБЯЗАТЕЛЬНО, метрики «до/после»
Минимум 2 теста:
1. **Юнит:** новые функции читают/пишут корректно; `getCanonicalByAttributes` находит товары с совпадающими признаками.
2. **Смок на реальных эталонах:** загрузи через бутстрап Новую Самару/Совжи; на парах Сокольих (тех же 28 из verity-harness) посчитай: alias-хит%, attribute-хит% — против baseline AI-OFF 0%.

**Цифры в result.md:**
- Загружено: N канонических товаров, M алиасов (из каких источников).
- Покрытие на Сокольих парах: X% alias-хит, Y% attribute-хит.
- Чистый прирост над baseline AI-OFF 0%.

Регрессии: `npm run build` чист; `npm run test:matcher` и `test:spec-pdf` без изменений (мы их не трогаем — это новая инфра, не правки матчера).

## Ограничения
- Только новые файлы + миграция (не трогать `matcher.ts`/`routes/matching.ts` — интеграция в матчер = ФАЗА 2).
- Ветка `feat/canonical-kb`, без push/деплоя.
- ≤4 ч. Если бутстрап не доезжает — отдай минимум: схема + 1 источник (Новая Самара) + смок.
- ASCII-коммиты.
- НЕ трогать проект 11; прод-API только read-only GET.

## Вернуть в `worker_brief_canonical_kb_bootstrap_result.md`
Ветка · изменённые/новые файлы · цифры (загружено / покрытие на парах Сокольих vs baseline) · риски для оркестратора · STOP/split-флаг.
