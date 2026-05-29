# Handoff 2026-05-29 — Carry-tasks #18 + Package B (#14, #17) deployed

## TL;DR для следующего чата

Сегодня закрыли 3 задачи (#14, #17, #18) в 2 deploy-цикла. Прод: проект 6 «тест для обучения» = **377/333/268/44** (88.3% покрытия), 21 learned synonym (после cleanup #18), 196+ matching_rules. Регрессий нет.

**Следующий приоритет:** Пакет A (#15 детектор дублей в спеке) — 137 дубль-строк = 37% спеки на проекте 6 (измерено), оператор тратит время вхолостую. Roadmap: `docs/plans/active/plan_matching_quality_2026-05-29.md`.

## Что задеплоено сегодня

### #18 — фильтр digit-prefix синонимов
**Коммит:** `fa3daa1 fix(learner): reject digit-prefix abbreviations as noise`

- `backend/src/services/constructionSynonymLearner.ts` +4 строки: `if (/^\d/.test(a)) return false;`
- На проде удалены 6 шумных синонимов (10→150мм, 32→32x20x32, и т.д.)
- Контейнер перезапущен, in-memory кэш матчера очищен
- Bakcup БД: `/root/budget-automation/database/budget_automation.db.bak-20260528-pre-cleanup`

### #14 + #17 — Package B
**Коммит:** `394e031 feat(matching): top-3 alternatives + one-click quick-tags`

- `backend/src/routes/matching.ts` +29 строк: новый endpoint `POST /api/projects/:id/feedback/tag` с ALLOWED_TAGS safelist (7 тегов)
- `frontend/src/components/MatchTable.tsx` +117 строк: top-3 strip (альтернативы #2-3 видны без раскрытия) + 7 chip-кнопок quick-tags под каждой строкой
- `frontend/src/pages/MatchingView.tsx` +1: передача `projectId` в MatchTable

### Live smoke на проде (4/4 PASS)

| Тест | Результат |
|---|---|
| POST `/feedback/tag` с unknown тегом | HTTP 400, `{error}` |
| POST без тега | HTTP 400 |
| POST с valid тегом `duplicate` для spec#2058 | HTTP 200 `{ok:true}` |
| Регрессия 333/268/44 после обоих деплоев | PASS |

## Что прошу оператора протестировать (опционально, 5-10 минут)

1. Открой проект «тест для обучения» (ID 6), страницу «Сопоставление»
2. Найди любые 2-3 спеки с несколькими кандидатами — убедись, что **под главной строкой видны 1-2 альтернативы** (если они с confidence ≥ 50%)
3. Под каждой строкой матча должна быть полоска **7 chip-кнопок**: 💰 Цена не та, 🔖 Не та маркировка, 🔀 Нужны альтернативы, 📑 Дубль, 🚫 Не покупали, ≈ Аналог, 🐛 Парсер пропустил
4. Кликни любой тег — он должен стать зелёным (с галочкой/выделением). Если так — фича работает.
5. Если что-то не отображается / не реагирует — скриншот в новый чат

## Известные минорные ограничения (на потом, не блокеры)

| Поведение | Причина |
|---|---|
| Теги «забываются» визуально после reload страницы | `appliedTags` per-session (запись в БД остаётся) |
| `supplier_id` в feedback всегда null | хардкоден в handleTag, нет сигнала кто из поставщиков |
| FK 500 на endpoint при несуществующем `spec_item_id` | защита целостности БД; UI всегда шлёт реальные id, не блокер |

## Текущие прод-метрики (project 6 = «тест для обучения»)

```
total: 377
matched: 333  (88.3%)
confirmed: 268
unmatched: 44
tierBreakdown:
  learned_rule: 47
  llm_suggestion: 204
  manual: 71
  name_similarity: 11
construction_synonyms (source='learned'): 21
matching_rules (source='manual'): 79
matching_rules (source='llm_confirm'): 117
matching_rules (source IS negative): 43
```

## Что должно быть в новой сессии

### Стартовый промпт (ниже отдельно)
Бутстрап новой сессии — путь в roadmap + рефлексии + текущий приоритет.

### Готовый roadmap
`docs/plans/active/plan_matching_quality_2026-05-29.md` — порядок Package A → C → парсер → аналоги → marking/приоритизация.

### Свежие рефлексии в памяти
- `reflection_2026-05-27_training_works_in_sample.md` — доказано in-sample transfer обучения
- `reflection_2026-05-27_feedback_ux_gap.md` — capture rate 17% (закрыто частично через #17)
- `reflection_2026-05-29_task18_noise_filter_deployed.md` — #18 deploy
- `reflection_2026-05-29_package_b_deployed.md` — Package B deploy

### Артефакты
- `backend/scripts/smoke-test-learner-filter.js` — smoke для regression на learner
- `scripts/analyze-noise-impact.js` — анализ шума
- Backup БД: `/root/budget-automation/database/budget_automation.db.bak-20260528-pre-cleanup`

## Следующая задача: Пакет A — #15 детектор дублей в спеке

### Измеренный impact
- 90 дубль-групп
- 137 строк-дублей (37% спеки)
- 230 спек в дубль-группах (177 матчены, 53 не матчены)
- Топ-3 группы: «труба стальная вгп оцинкованная dn 15x2 8» ×7 (0 матчено), «клапан шаровый valtec 214 dn 15» ×6 (6 матчено), и т.д.

### Acceptance criteria для #15
1. При запуске матчинга алгоритм группирует spec_items по `normalizeForMatching(name)` + DN/размер (если есть)
2. В UI оператор видит «лидера» с подсказкой `×N копий», подтверждает один раз, остальные `is_confirmed` ставятся автоматически
3. Учитель синонимов вызывается **один раз** на группу (не N раз)
4. Количество в спецификации сохраняется (НЕ схлопывается — нужно для отчёта по системам А1/Б2/...)

### Уроки, которые нужно помнить для #15
- НЕ трогать `matcher.ts` без классификации unmatched (см. `reflection_2026-05-20`)
- Группировка только в UI/обучении, не в `specification_items` DB (по архитектуре спецификации зависят от систем)
- 5-move цикл с sub-agent после каждой фазы (4-фазный ритуал)
- Pre-deploy-check skill обязателен перед push

## Decision point после #15

Решить, на основе данных накопленных через quick-tags (#17):
- Если в `operator_feedback` (type LIKE 'tag_%') большинство пометок про `price_wrong` или `wrong_marking` → парсер цены (#10/#12) первый
- Если про `analog_brand` или `not_purchased` → #8 UI-метка функционального аналога
- Если про `needs_alternatives` → возможно #14 нужно докрутить (больше альтернатив upfront)

Запрос на накопленные теги:
```bash
docker exec -w /app/backend budget-automation-app-1 node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/database/budget_automation.db', { readonly: true });
const tagged = db.prepare(\"SELECT type, COUNT(*) c FROM operator_feedback WHERE type LIKE 'tag_%' GROUP BY type ORDER BY c DESC\").all();
console.log(JSON.stringify(tagged, null, 2));
"
```

## Что НЕ делать в следующей сессии

- Не править `matcher.ts` без классификации (всегда сначала классификатор)
- Не делать парадные прогнозы — все цифры доказывать кодом / sub-agent / data
- Не накапливать uncommitted — 5-move cycle в конце каждой задачи
- Не пушить без `pre-deploy-check` PASS
- Не использовать `git add -A` или `.` — только именованные файлы

## Контакт

Прод-сервер: `5.42.103.63` (TimeWeb), SSH через root.
Контейнер: `budget-automation-app-1` (docker-compose), workdir `/app`.
API: `http://5.42.103.63:3001`.
Деплой: GitHub Actions автоматом на push в main.
