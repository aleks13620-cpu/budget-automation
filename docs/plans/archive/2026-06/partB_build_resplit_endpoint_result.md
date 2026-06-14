# Part B · шаг 2 — BUILD+ГЕЙТ: эндпоинт in-place чистки спеки — РЕЗУЛЬТАТ

**Тип:** BUILD (новый код) + offline-доказательство + `pre-deploy-check`. Прод НЕ тронут, НЕ задеплоено, на проде НЕ вызывалось. Всё offline на temp-БД.
**Дата:** 2026-06-10. **Воркер:** Арта (build).
**Вердикт гейта:** ✅ **PASS** — деплой-готов. **Сам не деплоил** (по роли — нести оркестратору на гейт исполнения).

---

## ГДЕ КОД (ветка / worktree / коммиты)

| | |
|---|---|
| Ветка | `feat/spec-resplit-endpoint` (от `origin/main` = `87dd821`) |
| Worktree | `C:\Users\home\vscode101\budget-automation-resplit` (отдельный, чтобы не конфликтовать) |
| Коммиты | `a410264` эндпоинт · `505e983` offline-тест (оба ahead of origin/main) |
| Тулчейн | `backend/node_modules` = junction на `budget-automation-spec-repr` (package.json **байт-идентичен** 87dd821; нативный ребилд не нужен) |

> ⚠️ Текущий рабочий каталог (`budget-automation`) на ветке `feat/parser-clean` — это ДРУГАЯ линия работ. Код этой задачи лежит в worktree `budget-automation-resplit` на `feat/spec-resplit-endpoint`. **Деплой = смерджить/запушить именно эту ветку**, не parser-clean.

---

## ЧТО ДОБАВЛЕНО (file:line)

**`backend/src/routes/specifications.ts`** (+141 строк, 0 удалений, чисто аддитивно):
- стр. 13 — `import { applyVariantMarkersToItems } from '../services/variantMarkers';`
- стр. 589 / 603 / 630 — `interface ResplitCleanReport` / `function specLinkCounts(specId, db)` (приватная) / `export function resplitCleanSpec(specId, db)` — ядро операции (блок 574-686).
- стр. 870 — роут `POST /api/specifications/:id/resplit-clean` (тонкая обёртка: валидирует id → проверяет существование спеки → зовёт `resplitCleanSpec` → отдаёт отчёт JSON).

**`backend/scripts/resplit-clean-endpoint.integration.mjs`** (новый, 206 строк) — offline-интеграционный тест: гоняет **реальный `resplitCleanSpec`** на temp-БД из read-only кэша пр.11 с **армированным каскадом** (`PRAGMA foreign_keys=ON` + настоящие FK `matched_items ON DELETE CASCADE` и `operator_feedback.spec_item_id ON DELETE SET NULL`).

### Как работает (одной фразой)
В одной транзакции: `saveSpecSnapshot(specId,'resplit_clean_repr')` → `applyVariantMarkersToItems(rows)` (тот же прод-трансформ, что в чокпоинтах парсера) → `UPDATE specification_items SET name=?, full_name=?, characteristics=? WHERE id=?` только изменённых строк. **Никакого DELETE/реинсерта → id стабильны → все FK-связки целы.** Идемпотентно (2-й вызов = no-op, снимок не пишется). **`no_corrupt_through`-бэкстоп:** счётчики связок сверяются ДО/ПОСЛЕ внутри транзакции; любой дрейф → throw → откат (коррупция не коммитится). Общий по spec id (**no-hardcode проекта**). `matcher.ts` НЕ тронут.

---

## МЕТРИКА 1 — Сохранность связок + идемпотентность (offline, temp-БД, каскад армирован)

`node backend/scripts/resplit-clean-endpoint.integration.mjs` → **ALL 20 CHECKS PASSED**.

```
seeded: 328 spec rows, 150 confirmed matches (38 manual), 6 feedback links
BEFORE : {spec:328, matched:150, confirmed:150, manual:38, feedbackLinked:6, history:0, orphans:0}
pass 1 : itemsTouched=128  bareOrphanKept=72
AFTER  : {spec:328, matched:150, confirmed:150, manual:38, feedbackLinked:6, history:1, orphans:0}
pass 2 (idempotency): itemsTouched=0; history 1->1
```

- **id-сет стабилен**; matched 150→150, confirmed 150→150, manual 38→38, **feedback 6→6 (SET NULL НЕ сработал)**, **orphans=0**.
- **Идемпотентно:** 2-й проход touched=0, снимок не пишется.
- `itemsTouched=128` / `bareOrphanKept=72` — **точно совпадают** с числами recon-трансформа (`resplit-existing-proj11.mjs`) → эндпоинт воспроизводит доказанный трансформ.
- **Живая жалоба #433, строка id=2953** после чистки: `full_name="Радиатор настенный EVRA Compact C33-400-700"` (чистый ключ), маркеры ушли в `characteristics="EVRA Ventil Compact; Левое исполнение.; Боковое подключение; dп=15 мм; Q=1222 Вт"`, `name` оставлен как был (bare-orphan — нет чистой головы).
- **Откатопригодно:** снимок (action=`resplit_clean_repr`) хранит ОРИГИНАЛЬНЫЙ грязный текст.

## МЕТРИКА 2 — Прирост матчинга (offline AI-OFF, тот же трансформ)

`node scripts/replay-spec-clean-repr.mjs` (budget-automation-spec-repr, переснято сегодня):

| Вариант | overall@1 | 95-class@1 |
|---|---|---|
| `orig` (как лежит) | 4.7% (7/150) | 1% (1/101) |
| `prod-resplit` (после чистки) | **55.3% (83/150)** | **75.2% (76/101)** |

**TRIPWIRE рангов:** 150 пар → **94 улучшения / 56 без изм / 0 РЕГРЕССИЙ.** (Эндпоинт применяет ТОТ ЖЕ трансформ к ТЕМ ЖЕ хранимым строкам → прирост переносится.)

## МЕТРИКА 3 — `pre-deploy-check` (5-move) = ✅ **PASS**

- [x] Move 1 — Bugs (1a/1b/1c): **0 FIX.** Проверено: rollback-on-throw транзакции, bare-orphan-гард, no-hardcode в шиппинг-коде, тест не false-green.
- [x] Move 2 — Missed (2a/2b): **0 реальных упущений.** Проверено: ЭКСПОРТ не затронут (читает `name`; у детей пр.11 `name`=bare-orphan→неизменно), подтверждённые матчи целы, идемпотентно.
- [x] Move 3 — Reality filter: **ничего не блокирует деплой.**
- [x] Move 4 — Regressions + build: **регрессий нет, scope чист.** Нет шэдоуинга роутов, трансформ переиспользован без изменений. `cd backend && npm run build` = **PASS** (tsc exit 0).
- [x] Move 5 — Security: **0 FIX.** Паритет авторизации с соседями, SQL параметризован, нет outbound/LLM-пути, нет утечки токенов, строго менее разрушителен, чем `/reparse`.

### CARRY-TASKs (НЕ блокеры; для оркестратора/владельца на потом)
1. **Безопасный откат resplit ≠ `/rollback`.** Форвард-операция cascade-safe и хранит снимок, НО существующий роут `POST /:id/rollback` сам делает `DELETE FROM specification_items`+реинсерт → каскадно снёс бы matched_items. **Правильный undo:** восстановить 3 текст-колонки по id из снимка `resplit_clean_repr` (in-place UPDATE), НЕ через `/rollback`. Это операционная заметка для рантбука + кандидат на хардненинг (in-place rollback-вариант). (Существующее поведение `/rollback`, не внесено этой правкой.)
2. **Косметика:** добавить `ACTION_LABELS['resplit_clean_repr']` во фронт (история показывает сырую строку — не ломается, просто без перевода).
3. *(опц., crossed-out как диагностика)* `orphansAfter` в отчёте — глобальный по БД; на проде с легаси-сиротами от других спек число может смутить. На abort НЕ влияет (там spec-scoped счётчики).

---

## ЖЁСТКИЕ ИНВАРИАНТЫ (соблюдены)
- ✅ Ветка от `origin/main`, отдельный worktree. **НЕ деплоил, на проде НЕ вызывал, прод НЕ мутировал** (только temp-БД в `os.tmpdir`, hard-guard против записи в прод-путь).
- ✅ `matcher.ts` НЕ тронут. **no-hardcode** (общий по spec id, project_id=11 НЕ зашит; 11/2953/128/72 — только в ТЕСТЕ, что бриф разрешает).
- ✅ `no_corrupt_through` — реальный бэкстоп (доказан drift-rollback-пробой в Move 1), не просто detect.
- ✅ ASCII-коммиты, `git add` только именованных файлов, `git rev-parse --abbrev-ref HEAD` перед каждым коммитом, инкрементальные коммиты, `npm run build` зелёный.

---

## СВОДКА ВЛАДЕЛЬЦУ (простым языком)

Сделал «кнопку», которая чинит уже-загруженные строки Ласточки (пр.11) на месте: аккуратно вычищает мусор («левое исполнение, dп=15 мм, Q=1222 Вт») из имени-ключа, по которому идёт сопоставление, **не трогая сами строки по id**. Поэтому 150 подтверждённых совпадений, ручные связки и сами жалобы операторов остаются на месте (в отличие от перезаливки, которая всё это снесла бы каскадом по базе).

Доказал числами офлайн, прод не трогал: **0 потерянных связок**, повтор безопасен, точность матчинга на чистых ключах прыгает **4.7% → 55.3%** при **нуле ухудшений**. Прогнал формальный предделойный гейт из 5 ходов — **чисто, деплой не блокируется** (две мелкие задачи «на потом», не критичные).

**→ Нести оркестратору Арте на гейт ИСПОЛНЕНИЯ (деплой ветки `feat/spec-resplit-endpoint` + активация на пр.11).** Исполнение = задеплоить эндпоинт → снять счётчики связок пр.11 ДО (живой read-only) → вызвать на spec 5 и spec 6 → проверить связки == ДО + orphans=0 → пере-прогнать матчинг пр.11 (живой прирост ИЗМЕРИТЬ, не предположить). Откат — восстановлением текст-колонок из снимка `resplit_clean_repr` (НЕ через `/rollback`). **Сам не деплоил.**
