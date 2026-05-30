# Task #15 — Design: Детектор дублей в спеке

**Статус:** Phase 1 (Design)
**Roadmap:** `docs/plans/active/plan_matching_quality_2026-05-29.md` → Пакет A
**Скоуп:** UI + обучение (НЕ трогаем `matcher.ts` и `specification_items` DB)

## 1. Измеренный impact (проект 6 = «тест для обучения»)

- 90 дубль-групп
- 137 строк-дублей (37% всей спеки = 377 спек)
- 230 спек участвуют в дубль-группах (177 матчены, 53 не матчены)
- Топ-3 группы: «труба стальная вгп оцинкованная dn 15x2 8» ×7 (0 матчено), «клапан шаровый valtec 214 dn 15» ×6 (6 матчено)

**Проблема, которую решаем:** оператор тратит 137 confirm-кликов вместо 90; учитель синонимов (`constructionSynonymLearner`) вызывается N раз на одну и ту же пару (specPattern, invoicePattern) при подтверждении дублей.

## 2. Acceptance criteria (из roadmap'а)

1. При запуске матчинга алгоритм **группирует** `spec_items` по `normalizeForMatching(name)` + DN/размер (если есть).
2. В UI оператор видит «лидера» с подсказкой «×N копий», подтверждает один раз, остальные `is_confirmed` ставятся **автоматически**.
3. Учитель синонимов вызывается **один раз** на группу (не N раз).
4. Количество в спецификации **сохраняется** (НЕ схлопывается — нужно для отчёта по системам А1/Б2/...).

## 3. Анализ текущего кода

### Backend

**`backend/src/services/matcher.ts`:**
- `normalizeForMatching(text, section?)` — единая нормализация (lowercase, GOST брекеты, синонимы, конструкционные термины, стоп-слова). Уже используется везде.
- `extractDnValue(text)` (line 189) — выделяет `dn N` из нормализованного текста, возвращает number|null.
- `matchSpecItems(specs)` (line 218) — независимый матчинг каждой spec_item. **Дублирует работу** для дубль-строк.

**`backend/src/routes/matching.ts`:**
- `GET /api/projects/:id/matching` (line 555) возвращает items: каждая spec_item = отдельная запись.
- `PUT /api/matching/:id/confirm` (line 696):
  ```ts
  upsertPositiveMatchingRule(db, specPattern, invoicePattern, supplier_id, 0.92, ruleSource);
  learnConstructionSynonymsFromConfirmedMatch(db, specPattern, invoicePattern, confidence);
  ```
- `POST /api/matching/bulk/confirm` (line 748) — то же в цикле по matchIds. **Для 7 дублей → learner 7 раз.**

### Frontend

**`frontend/src/components/MatchTable.tsx`:**
- `groupedItems: SectionGroup[]` — текущая группировка только по `section`.
- Каждая `MatchRow` рендерится отдельной строкой.
- `handleConfirm(matchId)` шлёт `PUT /matching/:id/confirm`.
- Чек-боксы + `bulk/confirm` — требует ручного выбора N строк.

**`frontend/src/pages/MatchingView.tsx`:**
- Загружает `/matching` → группирует по section → передаёт в MatchTable.
- `projectId` уже пробрасывается (после Package B).

## 4. Дизайн

### 4.1 Ключ группы

```
groupKey = normalizeForMatching(spec.full_name || spec.name) + '|DN' + (extractDnValue(...) ?? '')
```

**Почему без section:** на проекте 6 одинаковая «труба DN15» может быть в 3 системах (Б1, А2, ...) — оператор не должен подтверждать её 3 раза. По acceptance criterion #4 количество в DB сохраняется → каждая копия остаётся отдельной строкой `specification_items` для отчёта по системам.

**Почему full_name || name:** в `matchSpecItems` уже используется `nameBase = full_name || synthesizedNameById.get(id) || name`. Берём `full_name || name` (синтез только для параметризованных дочерних, в проекте 6 редкий случай).

**DN:** вычисляем через существующий `extractDnValue(nameBase)`. Если DN отсутствует → суффикс `|DN`. Это сохраняет различение «трубы без DN» как отдельных групп от «труб с DN N».

### 4.2 Лидер группы

**Правило:** лидер = `spec_item` с **минимальным `id`** в группе.

**Почему min(id):** стабильно при рематче, не зависит от изменчивого confidence. Если operator удалит spec_item с min id (теоретически), лидер автоматически смещается на следующий min id.

**Состав группы:**
```ts
{
  key: string,
  size: number,           // >= 1; null/no dupGroup field если size === 1
  leaderSpecItemId: number,
  role: 'leader' | 'follower'
}
```

### 4.3 Backend: computeDupGroups helper

Расположение: `backend/src/routes/matching.ts` (приватный helper) или новый файл `backend/src/services/dupGroups.ts`. **Решение:** в `routes/matching.ts` (single-use, не публичный API).

```ts
type DupGroupMeta = {
  key: string;
  size: number;
  leaderSpecItemId: number;
  role: 'leader' | 'follower';
};

function computeDupGroups(
  specItems: Array<{
    id: number;
    name: string;
    full_name: string | null;
    position_number: string | null;
  }>
): Map<number, DupGroupMeta> {
  // Synthesize full_name for parameterized children (e.g. "DN15" rows
  // that inherit context from a parent row with same position_number).
  // Mirrors logic in matcher.ts:226-238.
  const synthesizedNameById = new Map<number, string>();
  const lastParentByPosition = new Map<string, string>();
  for (const spec of specItems) {
    const position = (spec.position_number || '').trim().toLowerCase();
    const hasPosition = position.length > 0;
    const isParam = isParameterizedSpecName(spec.name);
    if (hasPosition && isParam) {
      const parent = lastParentByPosition.get(position);
      if (parent) synthesizedNameById.set(spec.id, `${parent} ${spec.name}`.trim());
    } else if (hasPosition) {
      lastParentByPosition.set(position, spec.full_name || spec.name);
    }
  }

  const groups = new Map<string, number[]>();
  for (const spec of specItems) {
    const nameBase = spec.full_name || synthesizedNameById.get(spec.id) || spec.name;
    const normalized = normalizeForMatching(nameBase);
    const dn = extractDnValue(nameBase);
    const key = `${normalized}|DN${dn ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(spec.id);
  }
  const result = new Map<number, DupGroupMeta>();
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;  // single → no dupGroup field
    ids.sort((a, b) => a - b);
    const leaderSpecItemId = ids[0];
    for (const id of ids) {
      result.set(id, {
        key,
        size: ids.length,
        leaderSpecItemId,
        role: id === leaderSpecItemId ? 'leader' : 'follower',
      });
    }
  }
  return result;
}
```

**Примечания:**
- `extractDnValue` и `isParameterizedSpecName` сейчас private в matcher.ts. Решение: **экспортировать оба**, чтобы единая логика синтеза/нормализации.
- Без `synthesizedNameById` параметризованные дочерние («DN15») из разных родителей дали бы один ключ «|DN15» и ложно объединились. (Замечание sub-agent verification, B.3.)

### 4.4 Backend: GET /matching возвращает dupGroup

В `GET /api/projects/:id/matching` после загрузки `specItems`:
```ts
const dupGroupBySpecId = computeDupGroups(specItems);
// ... в map по items:
return {
  specItem: { ...spec, parentItemId, fullName },
  matches: [...],
  dupGroup: dupGroupBySpecId.get(spec.id) ?? null,  // NEW
};
```

**Совместимость:** добавление optional поля → старый клиент игнорирует, не ломается.

### 4.5 Backend: POST /api/projects/:id/matching/group-confirm

```ts
router.post('/api/projects/:id/matching/group-confirm', (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const leaderMatchId = parseInt(req.body.leaderMatchId, 10);
  // 1. Load leader match details
  const leader = getMatchRuleActionDetails(db, leaderMatchId);
  if (!leader || !leader.invoice_name) return 404;
  if (leader.project_id !== projectId) return 400;
  if (!ensureMatchingNotRunning(projectId, res)) return;

  // 2. Compute groups, find leader's group
  const specItems = db.prepare(SPEC_ITEMS_BY_PROJECT_SQL).all(projectId);
  const dupGroups = computeDupGroups(specItems);
  const leaderMeta = dupGroups.get(leader.specification_item_id);
  if (!leaderMeta || leaderMeta.role !== 'leader') {
    return 400; // переданный matchId — не лидер группы
  }

  const followerSpecIds = [...dupGroups.entries()]
    .filter(([_, m]) => m.key === leaderMeta.key && m.role === 'follower')
    .map(([id, _]) => id);

  // 3. Transaction: confirm leader (with rule + learner), auto-confirm followers (no rule, no learner)
  const result = db.transaction(() => {
    // Leader full confirm
    clearSelectedForSpec(db, leader.specification_item_id);
    db.prepare('UPDATE matched_items SET is_confirmed=1, is_selected=1, is_analog=0 WHERE id=?').run(leaderMatchId);
    const specPattern = normalizeForMatching(leader.spec_name);
    const invoicePattern = normalizeForMatching(leader.invoice_name);
    const ruleSource = leader.match_type === LLM_MATCH_TYPE ? 'llm_confirm' : 'manual';
    upsertPositiveMatchingRule(db, specPattern, invoicePattern, leader.supplier_id, 0.92, ruleSource);
    learnConstructionSynonymsFromConfirmedMatch(db, specPattern, invoicePattern, leader.confidence ?? 0);
    saveFeedback(db, 'confirm', projectId, leader.specification_item_id, leader.target_item_id, leader.supplier_id, leader.source);

    // Followers auto-confirm — same invoice_item_id only.
    // 3 buckets:
    //   autoConfirmed: follower had unconfirmed match on same invoice → confirm.
    //   conflicted:    follower already has another confirmed match (incl. analog) → skip,
    //                  don't overwrite operator's prior decision.
    //   skipped:       follower has no match on this invoice (different best) → leave for operator.
    const autoConfirmed: number[] = [];
    const conflicted: number[] = [];
    const skipped: number[] = [];

    for (const followerSpecId of followerSpecIds) {
      // Check: does follower already have ANY confirmed match (analog or exact)?
      const existingConfirmed = db.prepare(`
        SELECT id, COALESCE(is_analog, 0) as is_analog
        FROM matched_items
        WHERE specification_item_id = ? AND is_confirmed = 1
        LIMIT 1
      `).get(followerSpecId) as { id: number; is_analog: number } | undefined;

      if (existingConfirmed) {
        // Operator already made a decision (could be analog or exact on different invoice).
        // Don't overwrite — flag as conflicted for the UI toast.
        conflicted.push(followerSpecId);
        continue;
      }

      const followerMatch = db.prepare(`
        SELECT id FROM matched_items
        WHERE specification_item_id = ?
          AND COALESCE(invoice_item_id, price_list_item_id) = ?
          AND COALESCE(source, 'invoice') = ?
      `).get(followerSpecId, leader.target_item_id, leader.source) as { id: number } | undefined;

      if (followerMatch) {
        clearSelectedForSpec(db, followerSpecId);
        db.prepare('UPDATE matched_items SET is_confirmed=1, is_selected=1, is_analog=0 WHERE id=?').run(followerMatch.id);
        saveFeedback(db, 'confirm_group_follower', projectId, followerSpecId, leader.target_item_id, leader.supplier_id, leader.source);
        autoConfirmed.push(followerSpecId);
      } else {
        skipped.push(followerSpecId);
      }
    }
    return { autoConfirmed, conflicted, skipped };
  })();

  res.json({
    leaderSpecItemId: leader.specification_item_id,
    autoConfirmedSpecIds: result.autoConfirmed,
    conflictedSpecIds: result.conflicted,
    skippedSpecIds: result.skipped,
    groupSize: leaderMeta.size,
  });
});
```

**Ключевые свойства:**
- Учитель `learnConstructionSynonymsFromConfirmedMatch` вызывается **ровно 1 раз** (для лидера). ✅ Acceptance #3.
- `upsertPositiveMatchingRule` тоже 1 раз — не раздувает `times_used` дубликатами.
- Followers без того же invoice пропускаются (новый `feedback type='confirm_group_follower'` для аналитики; followers с другим best operator проверит при expand вручную).
- Транзакция атомарна → concurrent calls безопасны.

### 4.6 Frontend: MatchTable.tsx

**Изменения:**

1. **Тип `MatchRow`** — добавить optional поле `dupGroup`:
   ```ts
   interface MatchRow {
     specItem: SpecItem;
     matches: MatchItem[];
     dupGroup?: { key: string; size: number; leaderSpecItemId: number; role: 'leader' | 'follower' } | null;
   }
   ```

2. **Фильтрация followers** из основного рендера:
   ```tsx
   const visibleRows = group.rows.filter(r =>
     !r.dupGroup || r.dupGroup.role === 'leader'
   );
   ```
   Followers индексируются по `leaderSpecItemId` для expand.

3. **На строке лидера** показываем chip `×N копий` и кнопку «Подтвердить группу»:
   ```tsx
   {row.dupGroup?.role === 'leader' && row.dupGroup.size > 1 && (
     <button onClick={() => toggleDupExpand(row.specItem.id)}>
       ×{row.dupGroup.size} копий ▼
     </button>
   )}
   {row.dupGroup?.role === 'leader' && best && !best.isConfirmed && (
     <button onClick={() => handleGroupConfirm(best.id, row.dupGroup.size)}>
       ✓ Группа (×{row.dupGroup.size})
     </button>
   )}
   ```

4. **Expand followers** — отдельный state `expandedDupGroups: Set<number>` (по leaderSpecItemId). При раскрытии отображаются followers с обычными действиями (на случай если оператору надо разойтись).

5. **API call** с честным toast по результатам:
   ```tsx
   const handleGroupConfirm = async (leaderMatchId: number) => {
     const { data } = await api.post(
       `/projects/${projectId}/matching/group-confirm`,
       { leaderMatchId }
     );
     // size-1 = expected followers. autoConfirmed / conflicted / skipped — three buckets.
     const auto = data.autoConfirmedSpecIds.length;
     const conflicted = data.conflictedSpecIds.length;
     const skipped = data.skippedSpecIds.length;
     const total = data.groupSize - 1;  // exclude leader
     showToast(
       `Группа ×${data.groupSize}: лидер + ${auto}/${total} автоподтверждено`
       + (conflicted > 0 ? `, ${conflicted} уже подтверждены ранее` : '')
       + (skipped > 0 ? `, ${skipped} с другим матчем (проверить вручную)` : '')
     );
     onRefresh();
   };
   ```

### 4.7 Frontend: MatchingView.tsx

Минимальные изменения:
- В `loadMatching` сохранять `dupGroup` (axios уже разворачивает все поля).
- Опционально: в summary показать «В дубль-группах: 137 строк / 90 групп» — но это можно carry-task, не блокер.

## 5. Метрика успеха

| Метрика | До (текущая) | После (ожидание) |
|---|---|---|
| total spec_items | 377 | 377 (без изменений) |
| matched | 333 | 333 (без изменений) |
| unmatched | 44 | 44 (без изменений) |
| confirmed | 268 | 268 + ~N (где N — followers с тем же invoice) |
| Confirm-кликов оператора на 137 дублей | 137 | 90 (-34%) |
| Вызовов learner-а на 137 дублей | 137 | 90 (-34%) |
| Кол-во matching_rules с раздутым times_used | да | нет |

## 6. Риски и принятые решения

| Риск | Решение |
|---|---|
| Section в ключе | НЕ включаем — копии в разных системах объединяются (acceptance #4 разрешает) |
| Лидер сменился при рематче | OK, min(id) стабилен; следующая загрузка просто покажет новую группировку |
| Follower с другим best invoice | НЕ auto-confirm, остаётся в `skipped` bucket, видим после expand |
| Follower уже confirmed на другую invoice (exact или analog) | НЕ перетираем, в `conflicted` bucket — operator signal сохраняется |
| Follower с `is_analog=1` ранее | Попадает в `conflicted` (is_confirmed=1) → не перетираем analog-signal на 0 |
| Параметризованные дочерние без full_name | `synthesizedNameById` fallback — мешает ложному merge'у «DN15» из разных родителей |
| Concurrent group-confirm | Транзакция атомарна; повторный вызов — `existingConfirmed` уже есть → followers идут в `conflicted` (no-op) |
| API shape changed | Поле `dupGroup` опционально → backward compatible |
| Тиры в metrics могут сместиться | confirmed растёт, distribution тиров (learned_rule/llm_suggestion) не меняется. Это feature. |
| Перформанс computeDupGroups на 377 спек | O(n) с нормализацией — < 50ms, не блокер |
| Hardcode 0.92 confidence повторно | Уже magic-constant в существующих confirm/bulk endpoint-ах. Carry-task `CONFIRM_RULE_CONFIDENCE`. Не блокер. |

## 7. Открытые вопросы для sub-agent verification

1. Правильно ли `extractDnValue` выделит DN из `full_name` строки спеки (а не только из нормализованного matchText)? — он внутри вызывает `normalizeForMatching` → должно быть OK.
2. Хорошо ли работает `normalizeForMatching` без section при группировке (без section-aliases)? — для группировки section-aliases необязательны (они только расширяют, не меняют семантику).
3. Нет ли уже механизма группировки в коде, который дублируется? — проверить.
4. `getMatchRuleActionDetails` использует `target_item_id = COALESCE(invoice_item_id, price_list_item_id)` — корректно ли сравнивать его с follower's соответствующим полем? — да, через `COALESCE(invoice_item_id, price_list_item_id) = ?`.
5. Не сломается ли `upsertNegativeMatchingRule` в `DELETE /matching/:id`? — followers могут быть отклонены отдельно, это OK.

## 8. План реализации (Phase 2)

1. Экспортировать `extractDnValue` и `isParameterizedSpecName` из matcher.ts.
2. Добавить `computeDupGroups` helper в routes/matching.ts (с `synthesizedNameById` fallback).
3. Расширить ответ `GET /matching` полем `dupGroup` (optional, не ломает старый клиент).
4. Реализовать `POST /api/projects/:id/matching/group-confirm` endpoint с тремя bucket-ами: `autoConfirmed`, `conflicted`, `skipped`.
5. Frontend MatchTable: расширить `MatchRow` тип, фильтровать followers из основного рендера, добавить chip `×N копий` + кнопку «✓ Группа (×N)», expand для followers.
6. Frontend MatchTable: показывать toast по результатам group-confirm (`N автоподтверждено / M уже подтверждены / K пропущены`).
7. Smoke test на dev: проект 6 → подтвердить группу из 7 труб → проверить что:
   - leader confirmed, 6 followers с тем же invoice — confirmed (или меньше с conflicted/skipped)
   - `matching_rules.times_used` для этой пары вырос на 1, не на 7
   - в `operator_feedback` — 1 confirm + N confirm_group_follower
   - Регрессия: matched=333, unmatched=44 не меняются
8. Smoke test edge: попытаться group-confirm спеку, у которой follower уже confirmed на analog → ожидание: тот follower → `conflicted` bucket, не перетёрт.

## 9. Sub-agent verification log

**2026-05-29 Phase 1 verification:** `Agent (general-purpose)` прочитал design + relevant code (matcher.ts, matching.ts, learner, MatchTable), вердикт **PASS с 3 правками**, все 3 внесены:

1. ✅ `conflicted` bucket в group-confirm (skip уже-confirmed followers, в т.ч. analog).
2. ✅ `synthesizedNameById` fallback в `computeDupGroups`.
3. ✅ UI toast: `autoConfirmed/size-1` + `conflicted` + `skipped` отдельно.

Дополнительно покрыт риск из раздела C.4: follower с `is_analog=1` → `conflicted` (не перетираем).
