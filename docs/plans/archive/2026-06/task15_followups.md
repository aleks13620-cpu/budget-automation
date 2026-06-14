# Task #15 — Follow-up carry-tasks

Отложенные находки из pre-deploy 5-move gate (2026-05-30). Основной #15 задеплоен (`c7dd1cf`). Эти пункты сознательно вынесены за скоуп — ни один не блокирует KPI на текущем масштабе.

## Из Move 3 (reality filter)

### CT-1: equipment_code в ключе группы
**Источник:** Move 2 F2 → Move 3 CARRY-TASK.
**Что:** `computeDupGroups` (`backend/src/routes/matching.ts`) строит ключ из `normalizeForMatching(name) + DN`, игнорируя `equipment_code` (артикул). Две спеки с идентичным именем+DN, но разными артикулами (Valtec VT.214 vs аналог AN.214) попадут в одну группу.
**Почему отложено:** на текущем scale (десятки проектов) разные артикулы при идентичном name+DN — exception. `conflicted`/`skipped` buckets уже защищают: follower с собственным confirmed match или другим best invoice не перетирается.
**Триггер реализации:** первый реальный инцидент, когда оператор пожалуется «склеило разные артикулы».
**Решение:** добавить `+ '|ART' + (equipment_code ?? '')` в ключ, либо опционально (флаг строгости группировки).

### CT-2: group-confirm early-return на already-confirmed leader
**Источник:** Move 1 CARRY-TASK / Move 3 F5.
**Что:** `POST /matching/group-confirm` не делает early-return если `leader.is_confirmed === 1`. Двойной POST (race / replay / прямой curl) повторно вызовет learner и `times_used++` на rule.
**Почему отложено:** UI-кнопка скрыта при `best.isConfirmed` → прикрывает 99% кейсов. Не corruptит данные, только шум в статистике одного rule. Single-tenant solo-founder MVP.
**Решение (2 строки):** после `getMatchRuleActionDetails`, `if (leader.is_confirmed === 1) return res.json({ leaderSpecItemId, groupSize, autoConfirmedSpecIds: [], conflictedSpecIds: [...], skippedSpecIds: [] });`

## Из Move 2 (abstract risks)

### CT-3: DN-asymmetric noise smoke fixture
**Что:** если у одной копии в `name` есть «шум» (скобки/слово), убивающий regex `\bdn\s*(\d+)\b` в `extractDnValue` → DN=null vs DN=15 → разные ключи → группа из 2 семантически идентичных копий распадётся на 2 singleton.
**Почему отложено:** нет конкретной фикстуры в проекте 6, гипотеза.
**Решение:** добавить smoke-кейс в `smoke-test-dup-detector.js` (одна копия со скобкой, другая без) → если распадается, нормализовать DN до группировки.

### CT-4: виртуализация expand при большой группе
**Что:** дубль-группа 30-50+ копий → expand рендерит 50 `<tr>` без виртуализации, нет CSS overflow на `<tbody>`.
**Почему отложено:** на текущих данных дубль-группы до 7 копий, worst-case не наблюдался.
**Решение:** react-window для followers если `size > 30`.

### CT-5: PDF parser без position_number
**Что:** `synthesizedNameById` fallback в `computeDupGroups` зависит от `position_number`. Если новый PDF-парсер не заполняет `position_number`, все «DN15» дочерние из разных родителей сольются в одну ложную группу.
**Почему отложено:** проект 6 — XLSX, заполняет position_number. Реально только при transfer на PDF-проект.
**Связь:** [[reflection_2026-05-29_task18_noise_filter_deployed]] — класс «re-normalization при смене парсера».
**Решение:** при добавлении PDF-парсера спеки — fallback на `parent_item_id` если `position_number` пуст.

### CT-6: smoke на manual-match follower → group-confirm leader
**Что:** оператор делает `POST /manual-match` follower'а ДО group-confirm лидера. Backend кладёт его в `conflicted` bucket (защищён), но путь не покрыт тестом.
**Почему отложено:** конкретного бага нет, `conflicted` bucket покрывает.
**Решение:** добавить интеграционный smoke на этот порядок действий.

### CT-7: leader unmatched + followers matched — feature или gap?
**Что:** UI требует `best && !best.isConfirmed` для рендера кнопки `✓×N`. Если у лидера (min id) 0 матчей, а у followers есть — кнопка group-confirm недоступна, оператор «теряет» фичу на группе.
**Почему отложено:** возможно by-design; нет жалобы оператора.
**Решение (если gap):** UI «promote follower to leader» — выбрать в качестве точки подтверждения follower-а с матчем. Либо лидер = min(id среди тех, у кого есть match).

## Также вне скоупа (замечено в Move 2, не carry)
- `MatchingView.tsx:38-41` локальный `MatchRow` interface без `dupGroup` — CROSSED (TS компилируется structural typing, tech-debt без KPI-влияния). Закрыть при следующем рефакторе типов API.
