# Воркер-бриф: фикс модели алиасов каталога (BLOCKING gate-fix) — feat/canonical-kb

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation` и напиши:
> «выполни docs/plans/active/worker_brief_canonical_kb_fix_alias_model.md». Самодостаточно.

## Роль
Воркер. Ветка **`feat/canonical-kb`** (поверх `59daecb`). Без push/деплоя. matcher.ts/прод/БД не трогать. По завершении — `worker_brief_canonical_kb_fix_alias_model_result.md`.
⚠️ Общий worktree может быть занят другим агентом (деплой). ВСЕГДА `git rev-parse --abbrev-ref HEAD` перед коммитом. Если worktree занят — работай в своём: `git worktree add ../ckb-fix feat/canonical-kb` (там build/тесты; нужен свой node_modules — `npm ci` в backend, либо дождись освобождения общего).

## Зачем (5-move оркестратора дал FIX — 2 РЕАЛЬНЫХ дефекта схемы алиасов)
Каталог инертен в рантайме (не подключён к матчеру), поэтому в проде сейчас не кусает. НО схема, которую кладёт коммит, дефектна — и НЕ должна попасть в main непочиненной (оркестратор блокирует merge до фикса).

1. **`UNIQUE(alias_text, COALESCE(supplier_id,-1))` БЕЗ `canonical_product_id`** (`backend/src/database/schema.ts`, `idx_product_aliases_unique`). Все вызовы пишут `supplier_id=null` → ограничение схлопывается в «raw `alias_text` глобально уникален». `addAlias` использует `INSERT OR IGNORE` (`backend/src/services/canonicalKb.ts:~220`) → один и тот же текст («Кран 15»), встреченный у ДВУХ разных товаров, молча привязывается к ПЕРВОМУ; второй товар теряет алиас. Тихая потеря данных.
2. **Ключ записи `alias_text` ≠ ключ поиска `alias_norm`** (`canonicalKb.ts`: пишем по alias_text, ищем `WHERE pa.alias_norm = ?` на :~279). → норм-эквивалентные строки («Кран обратный DN50» vs «кран обратный, dn50») дублируются как разные alias-строки, раздувают alias_count, делают tie-break мёртвым.

## Фикс (точечно — schema.ts + canonicalKb.ts + тест)
1. **Индекс** в `CANONICAL_KB_MIGRATIONS` (schema.ts): заменить на
   `CREATE UNIQUE INDEX IF NOT EXISTS idx_product_aliases_unique ON product_aliases(canonical_product_id, alias_norm, COALESCE(supplier_id, -1))`.
   ⚠️ Имя индекса то же → на БД, где старый индекс уже создан, `IF NOT EXISTS` НЕ пересоздаст. Прод эти таблицы ещё НЕ имеет (ветка не мержена) — там создастся корректно. Для дев/тест-БД: пере-тестируй на СВЕЖЕЙ БД (или переименуй индекс, напр. `idx_product_aliases_unique_v2`, чтобы миграция была идемпотентно-безопасной и на уже-инициализированных БД — РЕКОМЕНДУЮ переименовать).
2. **`addAlias`/`getCanonicalByAlias` (canonicalKb.ts):** дедуп и вставка по `(canonical_product_id, alias_norm)`, чтобы ключ записи совпал с ключом поиска. Идемпотентность «тот же алиас к тому же товару» сохранить; «тот же текст к ДРУГОМУ товару» — РАЗРЕШИТЬ (отдельная строка). Поправить докстринг про идемпотентность (`canonicalKb.ts:~211`).
3. **Докстринг `extractCanonicalPassport`** (`canonicalKb.ts:~75-77`): убрать ложное «DB-free/pure» — функция читает синонимы из БД через `normalizeForMatching` → паспорт/`alias_norm` зависят от состояния синонимов. Добавить заметку: бутстрап гонялся с ПУСТЫМИ синонимами → перед наполнением прода нужна ре-нормализация (капкан re-normalization, [[reflection_2026-05-29_task18_noise_filter_deployed]]).

## Тесты — ОБЯЗАТЕЛЬНО доказать фикс (red→green)
В `scripts/test-canonical-kb.mjs` ДОБАВИТЬ кейсы, которых не было (M1/M2 поймали дыру покрытия):
- **Cross-product alias:** один и тот же `alias_text` к двум РАЗНЫМ паспортам → обе привязки сохраняются (без фикса — вторая молча терялась).
- **Norm-dedup:** «Кран обратный DN50» и «кран обратный, dn50» к одному товару → одна логическая запись (не две).
Регресс: `npm run build` чист; `npm run test:matcher` 41/41; `npm run test:spec-pdf` 7/7; `node scripts/test-canonical-kb.mjs` (старые + новые кейсы) зелёный. Опц.: пере-прогнать `canonical-kb-smoke-sokoliy.mjs` — подтвердить, что attribute-transfer 42.9% не упал (alias-фикс не должен его трогать).

## Границы / НЕ делать сейчас (это ФАЗА-2, отдельный бриф)
- НЕ подключать каталог к матчеру. НЕ добавлять гейт `no-corrupt-through` на `recordPair` (это фаза-2, когда появится рантайм-писатель). НЕ трогать matcher.ts. Только schema.ts + canonicalKb.ts + тест. Без push. ASCII-коммит.

## Вернуть в `worker_brief_canonical_kb_fix_alias_model_result.md`
Диф (3 файла) · как новые тесты ДОКАЗЫВАЮТ оба фикса (red→green) · регресс-сьюты · подтверждение что 42.9% не упал · риски. Оркестратор гонит закрывающий 5-move перед тем, как каталог станет деплоебельным.
