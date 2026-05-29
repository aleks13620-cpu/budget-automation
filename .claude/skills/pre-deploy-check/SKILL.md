---
name: pre-deploy-check
description: Run the 5-move verification cycle on changes pending push to origin/main before deploying to production. Trigger before every `git push origin main`, when the user says "готов к деплою" / "пушим на прод" / "deploy", or explicitly via `/pre-deploy-check`. Outputs a PASS/FIX/SKIP report grouped by the 5 moves. If any finding is FIX, the user must fix and re-run the skill before pushing.
---

# Pre-deploy 5-move verification

Formal pre-push check for Budget Automation. Mirrors the project's existing 5-hod cycle (`docs/plans/references/5-hod-cycle-instructions.md`), adapted for the deploy gate (not phase close).

## When this runs

- Before any `git push origin main` that ends up on the prod Docker image.
- When the user signals readiness to deploy ("готов к деплою", "пушим", "deploy", "release").
- On explicit `/pre-deploy-check` invocation.

Do NOT run on:
- Pushes to feature branches that won't trigger prod.
- Documentation-only diffs (use the shortened cycle: only moves 1, 3, 4).

## Принципы исполнения

- **Каждый ход — отдельный субагент с чистым контекстом.** Контекст хода 2 не должен быть загрязнён находками хода 1; контекст хода 3 не должен быть загрязнён сырыми результатами ходов 1–2 и так далее. Это критично для свежего взгляда.
- **Между ходами оркестратор резюмирует результат** (короткий summary: что найдено, какие вердикты), не передаёт следующему ходу raw transcript.
- **Не пропускать ходы и не сливать в один проход.** Структура цикла = качество гейта. Любое «давай я быстро всё сразу проверю» убивает смысл гейта.

## Inputs

Compute the diff to review:

```
git fetch origin main
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
git log origin/main..HEAD --oneline
```

If `origin/main` is not reachable, fall back to `git diff HEAD~N..HEAD` where N = number of unpushed commits from `git log @{u}..HEAD --oneline`.

## The 5 moves

Run each move as a focused review pass in its own subagent with clean context. Do NOT auto-suggest "all good" — actively look for findings. Each finding gets a verdict: **OK** / **FIX** / **N/A**.

### Move 1 — Find bugs

Three sub-passes. Do NOT mix «найти / доказать / починить» in one shot — each sub-step gets its own pass.

#### 1a. Найди ошибки

Look at the diff with fresh eyes. Find bugs in these categories:
- off-by-one (array indices, `_parentIndex`, slice/splice boundaries)
- null / undefined (uninitialized fields, missing guards, optional chaining gaps)
- edge cases (empty array, single row, very long names, Cyrillic + Latin mix, zero, negative, very large numbers)
- race / concurrency (shared state, async without await, parallel writes)
- resource leaks (file handles, DB connections, fetch sessions, timers)
- invariant violations from project rules: `architecture/03-данные/сущности.md`, `architecture/03-данные/schema.prisma`, the user feedback file `feedback_no_hardcode` (no hardcoded supplier names / column indices / thresholds), and any invariants the user has stored in `memory/MEMORY.md` (e.g. parent_item_id, full_name, position_number, confidence range 0..1). If `architecture/` is missing for a given concern, fall back to MEMORY and `feedback_*.md` as the source of invariants.

If no bugs found → name **3 specific places** that will break at ×100 current load.

#### 1b. Докажи каждый пункт

For every finding from 1a, prove it with a code citation (`file:line`) or a concrete scenario (input → expected vs actual). Tag each finding explicitly: **«реально»** or **«паранойя»**. Items without proof get crossed out at this step.

#### 1c. Применяй diff (по доказанным)

Only for findings tagged **«реально»** in 1b. Produce a decision as a diff (not a list of options). If a finding cannot be expressed as a diff because it needs design discussion → it becomes a CARRY-TASK, not a FIX.

### Move 2 — What was missed

Two sub-passes.

#### 2a. Что упустили

Look for what is not covered by the diff:
- Scenarios not covered (all combinations: DN + variant, "То же" + variant, all three types together, mixed parsers).
- Edge inputs (child without parent, child after section header, inside `splitMonsterRow`, etc.).
- Dependencies on other code (matcher, learnConstructionSynonyms, matched_items, parent_item_id in DB, full_name in export, frontend display).
- What breaks after a month of use (new templates, accumulated data, DB growth, cache staleness).

#### 2b. Реальное vs теоретическое

For each item from 2a, prove: is it a **real omission in OUR code** (cite file:line or fixture name that exposes it) or an **abstract risk**?
- Real → goes into the funnel for Move 3.
- Abstract → goes straight to **CARRY-TASK**, never into FIX. Do not let abstract risks block deploy.

### Move 3 — Is it real?

For every finding that survived moves 1–2, prove it is a REAL problem in THIS project. Consider:
- product (KPI: budget reconciliation accuracy)
- audience (Russian construction estimators, small ops volume)
- current scale (handful of projects, hundreds of items per file, not millions)
- priority (MVP → sell → scale)
- history (recent retros in `docs/plans/references/`)

"Theoretically could, but not critical" → cross out. Keep only what actually blocks KPI on current flow.

Verdict per finding: **FIX** (block deploy) / **CARRY-TASK** (file new task, deploy OK) / **CROSSED OUT** (theoretical).

### Move 4 — Fresh-eye regressions

After mental walkthrough of fixes:
- What is NEW in this diff (new code paths, new files, new tables, new env vars, new npm scripts).
- What could be broken — regressions in adjacent branches:
  - Excel parsing branch (if PDF was changed) and vice versa
  - existing fixtures (do all still pass as before?)
  - `npm run build` in `backend/` (zero TS errors? — required per project rule)
  - runner exit codes
- Scope creep (files touched outside the declared phase scope?).

If no new risks → state "регрессий нет, scope чист".

### Move 5 — Security review

Preferred path: invoke the project's `security review` sub-skill if available.

**Fallback (если sub-skill `security review` недоступен или вернул ошибку — отработай чек-лист ниже самостоятельно):**

- **ОПАСНАЯ ТРОЙКА** (personal data + foreign content + outbound send). Any path where user-uploaded content reaches an outbound HTTP call?
- **SQL / NoSQL injection** (raw query concatenation, user input in `WHERE`).
- **XSS / CSRF / SSRF** (user input rendered as HTML, unprotected POST, server-side fetch to user-supplied URL).
- **Token leaks in logs** (`GIGACHAT_AUTH_KEY`, `OPENROUTER_API_KEY`, any new API key). `console.log` of request/response objects is the usual culprit.
- **`.env` in code or commits** (check diff for hardcoded keys; check no `.env` was added).
- **Права на API / новые порты** (new npm scripts opening external access, new public endpoints).
- **Rate limiting** on new endpoints (mark **N/A** explicitly if not applicable).
- **Валидация входов** (file size limits, JSON shape checks, content-type checks).

Verdict per item: **OK** / **FIX — <what>** / **N/A**.

## Output format

Produce a single report:

```
# Pre-deploy 5-move report — <branch> → origin/main
Diff: <N> files, +<A>/-<D> lines, <K> commits

## Move 1 — Bugs
- [OK|FIX|N/A] <category>: <finding> — <file:line> — <реально|паранойя>
- ...

## Move 2 — Missed scenarios
- [OK|FIX|N/A] <finding> — <evidence: реальное в коде | абстрактный риск → CARRY-TASK>

## Move 3 — Reality filter
- <finding from M1/M2> → FIX | CARRY-TASK | CROSSED OUT — <reason tied to KPI/scale>

## Move 4 — Regressions
- New: <list>
- Risk: <list or "регрессий нет, scope чист">
- Build: <PASS | FAIL — error>

## Move 5 — Security
- Dangerous trio: [OK|FIX|N/A] — <why>
- SQL injection: ...
- XSS/CSRF/SSRF: ...
- Token leaks: ...
- .env exposure: ...
- Rate limiting: ...
- Input validation: ...

## Verdict
- PASS — safe to `git push origin main`
- FIX — <N> findings block deploy. Fix and re-run targeted closure check (see Fix loop).
- CARRY-TASKS — <N> items filed for later (list with one-liners), deploy OK.
```

## Fix loop

If verdict is **FIX**:
1. Show the user the FIX list with file:line references.
2. Wait for user confirmation before changing code (per project rule: no action without confirmation).
3. После применения фиксов проверь **ТОЛЬКО закрытие найденных FIX-пунктов** (по эталону `docs/plans/references/5-hod-cycle-instructions.md`, секция «Закрытие цикла»). **Не перезапускай весь цикл.** Полный re-run только если scope правок вышел за рамки одной фазы (новые файлы, новая модель данных, новые внешние вызовы) — тогда это уже другой diff и другой гейт.
4. Only push when verdict is **PASS** (CARRY-TASK items are acceptable, FIX items are not).

## Build gate

Move 4 must include `cd backend && npm run build`. If the build fails, verdict is FIX regardless of other findings. Never bypass with `--no-verify`.

## Return to orchestrator

After Verdict is written, hand control back to the orchestrator with an explicit checklist of completed moves:

```
- [x] Move 1 — Find bugs (1a/1b/1c)
- [x] Move 2 — What was missed (2a/2b)
- [x] Move 3 — Reality filter
- [x] Move 4 — Fresh-eye regressions + build gate
- [x] Move 5 — Security review (sub-skill | fallback checklist)
- Verdict: PASS | FIX | CARRY-TASKS
```

If **Verdict = FIX** — the orchestrator does NOT push to origin/main until the user has applied the fixes and the targeted closure check (Fix loop step 3) returns PASS. Push is gated by orchestrator, not by this skill.
