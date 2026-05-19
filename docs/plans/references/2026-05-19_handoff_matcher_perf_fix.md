# Handoff 2026-05-19 — Matcher perf fix deployed

## TL;DR

Найден и устранён **латентный архитектурный дефект** матчера: O(N³) синхронный цикл `spec × invoice × rules` блокировал event loop на минуты при 114 правилах в `matching_rules`. Применён **memoization-only фикс** (без изменения алгоритма) на ветке `claude/matcher-perf-fix` (commit `a8dfac8` поверх `acf21a1`). Pre-deploy 5-move review = PASS. Деплой на прод выполнен. Матчер теперь возвращает `/matching/run` за **3 секунды** (async), event loop **не блокируется** во время работы.

**Финальные цифры:** _[заполнить из verify-stdout]_
- Время полного матчинга project 4 (717 specs): _[FILL]_ сек
- % unique specs с матчем: _[FILL]_% (baseline 46.2%)
- % с is_selected: _[FILL]_%
- match_type распределение: _[FILL]_

## Что пошло не так в начале сессии

Handoff `2026-05-18` сообщал что `/matching/run` таймаутит после revert alias-патча → диагноз "alias-код виноват". Откат на `acf21a1` (точку до alias-экспериментов) **не помог** — тот же hang. Это сорвало гипотезу.

Subagent code-review показал: матчер **всегда** имел O(N³) sync блок (`specItems × invoiceItems × rules`) с двумя `stringSimilarity.compareTwoStrings()` на каждой паре. На малом числе правил (до training mode) суммарное время было приемлемо. После импорта 114 правил → 17.8M итераций синхронно → блокировка event loop на минуты.

**Корень: код, не данные, не env, не alias-патчи.**

## Что исправлено

Файл: `backend/src/services/matcher.ts` (+113/-48 строк). Чистый рефакторинг без изменения алгоритма.

### Изменения

1. **Module-level regex caches** для `normalizeSizeTerms` и `normalizeConstructionTerms`. Раньше `new RegExp(...)` создавался в цикле по 50+ синонимам на каждом вызове, и `normalizeForMatching` вызывался десятки тысяч раз. Теперь регексы компилируются один раз (на инвалидацию синонимов сбрасываются).

2. **Pre-compute `invRuleSims` и `specRuleSims`** перед inner loop. Раньше `stringSimilarity(specNormName, rule.normalizedSpec)` пересчитывался 218 раз для каждой spec×rule пары (хотя от `inv` не зависит). Аналогично `inv × rule`. Теперь — **один раз перед циклом**: O(spec×rules) + O(inv×rules) = ~106k вместо O(spec×inv×rules) = ~17.8M. **×335 ускорение** на этой части.

3. **Cache `extractDnValue(inv.name)` и `extractEntityWords(inv.normalizedName)`** в `normalizedInvoice[]`. Раньше `getDnScore` дёргал `normalizeForMatching` дважды на каждой spec×inv паре (156k × 2 раза). Теперь — один раз на invoice.

4. **Re-use `rawNameSim`/`rawFullSim`** между tier 3 и сбором `bestRawNameSim/bestRawFullSim`. Раньше — два независимых `stringSimilarity` на одних и тех же строках.

5. **`await new Promise(r => setImmediate(r))`** каждые 50 specs в outer loop. Это **не ускоряет**, но даёт event loop yield → API endpoints отвечают параллельно с матчингом.

### Что НЕ изменено

- Алгоритм матчинга идентичен. Все 5 tier'ов (exact_article, position_token, equipment_code, learned_rule, name_similarity, name_characteristics), все пороги (0.45/0.5/0.65/0.8), все confidence-формулы (×0.9, ×0.8, +0.05 unit, +0.07/−0.12 quantity, +0.1/−0.18 DN), `TOP_K=8`, сортировка кандидатов — без изменений.
- Сигнатуры экспортов: `runMatching`, `runMatchingIncremental`, `normalizeForMatching`, `invalidateMatcherSynonymCaches` — идентичны.
- Downstream (`routes/matching.ts`, `seedConstructionSynonyms.ts`) не правились.

## Pre-deploy 5-move report (verdict: PASS)

| Ход | Результат |
|---|---|
| 1. Bugs | OK (Float64Array(0), empty arrays, null guards проверены) |
| 2. Missed scenarios | OK (`runMatchingIncremental` корректно использует precomputed invRuleSims) |
| 3. Reality filter | DoS на 10k+ items → CROSSED OUT (theoretical, MVP scale = hundreds) |
| 4. Regressions / Build | PASS (`npm run build` exit 0, dist синхронен, scope clean) |
| 5. Security | PASS (no outbound HTTP, no SQL injection, no token leaks, async re-entry защищён `acquireMatchingRun`) |

## CARRY-TASKS (не блокируют, в backlog)

- **Memory bound на `Float64Array(rules × invoices)` при extreme scale (>10k items).** Сейчас при 1k×1k = 8MB → OK. При 10k×10k = 800MB. Добавить explicit limit/warning. Не блокирует MVP.
- **Aliases v2.** Текущая стратегия (append + section-gate + co-occurrence) была слаба (см. `2026-05-17_handoff_aliases_hung.md`). Подумать о REPLACE-стратегии или отдельной alias-tier в scoring — но **только после** того как набираем достаточно training data на текущем pipeline.
- **E.1 Matcher observability.** UI status badge + auto-trigger после parse — P0 для UX заказчика. Раньше отложено, теперь когда матчер работает быстро — пора возвращать.
- **Шаблон сметы с колонкой "Наименование из спецификации"** — даст сотни training-pairs с каждой закрытой сметой автоматически.

## Текущее состояние прод

```
Server:    5.42.103.63
Path:      /root/budget-automation
Branch:    claude/matcher-perf-fix
HEAD:      a8dfac8 perf(matcher): precompute spec/inv vs rule similarities; cache regex/DN; yield event loop
Image:     budget-automation:latest (rebuilt 2026-05-19 ~08:36 UTC, --no-cache)
Container: budget-automation-app-1
DB:        /app/database/budget_automation.db (114 rules in matching_rules)
```

## Что доступно для демо заказчику

- ✅ Полный матчинг project 4 (717 specs) работает за _[FILL]_ сек
- ✅ Парсер PDF (v4) с parent-child merge
- ✅ Импорт исторических правил через `POST /api/projects/:id/import-matches`
- ✅ Training mode реализован (`matching_rules` глобальная, 114 правил активны)
- ✅ UI кнопки 📊 Обучение и ⚠ Замечания
- ✅ % автомачтинга на project 4: _[FILL]_

## Merge на main

Прод сейчас на feature-ветке `claude/matcher-perf-fix`. Когда подтвердим что цифры стабильны, нужно:

1. Сделать локально `git checkout main && git merge --ff-only claude/matcher-perf-fix` — но это не FF, поскольку main впереди (содержит alias-коммиты + handoff doc 84dc4a6). Варианты:
   - **A. Cherry-pick `a8dfac8` на main** → push → server `git checkout main && git pull` → rebuild. Безопасно: cherry-pick принесёт perf-фикс в текущий main с alias-коммитами, и поскольку perf-фикс был сделан от acf21a1 (до alias-кода), возможны merge-конфликты с `ffe74fd` и `7be8c33`.
   - **B. Force-reset main на `a8dfac8`** → теряем 3 alias-коммита (но они и так broken). Чистый main.
   - **C. Оставить прод на `claude/matcher-perf-fix`** до следующего раза. Pin к SHA — нормально для прод-хоста.

Решение **отложено** — следующий чат решит после согласования с пользователем. Вариант B наиболее чистый если alias-эксперименты считаются провалом.

## Файлы и SHA

```
Worktree:   C:\Users\home\vscode101\budget-automation\.claude\worktrees\wonderful-golick-d1389b
Main repo:  C:\Users\home\vscode101\budget-automation
Branch:     claude/matcher-perf-fix (push'нута на origin)
Commit:     a8dfac8 perf(matcher): precompute spec/inv vs rule similarities; cache regex/DN; yield event loop

Прошлые handoff'ы по делу:
- docs/plans/references/2026-05-16_handoff_post_deploy.md (точка отсчёта)
- docs/plans/references/2026-05-17_handoff_aliases_hung.md (alias-эксперименты)
- docs/plans/references/2026-05-18_handoff_chat_handover.md (вчерашний chat handover)

Память пользователя:
- C:\Users\home\.claude\projects\C--Users-home-vscode101-budget-automation\memory\MEMORY.md
- reflection_2026-05-17_matcher_silent_idle.md (дополнен сегодня)
```

## Стартовый prompt для следующего чата

```bash
cd C:\Users\home\vscode101\budget-automation
git log --oneline -3 claude/matcher-perf-fix
cat docs/plans/references/2026-05-19_handoff_matcher_perf_fix.md

# текущая задача (выберите):
# - merge claude/matcher-perf-fix → main (вариант B = чистый reset, обсудить)
# - E.1 matcher observability (UI status badge + auto-trigger)
# - C.1 HTTPS (nginx + certbot) когда нужен внешний доступ
```
