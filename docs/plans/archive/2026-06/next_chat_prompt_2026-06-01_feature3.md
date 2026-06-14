# Стартовый промпт для НОВОГО чата — Фича #3 (оркестратор)

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation`, дай мне роль
> ОРКЕСТРАТОРА и вставь текст между линиями.

---

Привет. Возвращаюсь к budget-automation. Ты — ОРКЕСТРАТОР этого чата. Реализуем **фичу #3**.

=== СНАЧАЛА ПРОЧИТАЙ ===
1. Память: `memory/MEMORY.md` + ключевые рефлексии:
   - `reflection_2026-05-31_orchestrator_worker_pattern` — serial worker/субагент на фичу; гейт > дизайн-чекпоинт; **unit-green ≠ wired-in** (нужен интеграционный тест на боевой путь `processInvoiceFile`, не только юнит); npm install в isolation-worktree затирает node_modules main (перед pre-push билдом проверь `backend/node_modules/.bin/tsc`).
   - `reflection_2026-05-30_deploy_verification_gap` — **push ≠ deployed**: GH Actions делает `git reset`, но НЕ всегда пересобирает образ → проверять **CREATED-время контейнера** (`docker compose ps`), при старом — ручной `docker compose up -d --build` (pdfplumber pip install ~17 мин). SSH на прод по паролю РАБОТАЕТ.
   - `reflection_2026-05-30_parser_vat_fix_deployed` — сверять с document total (не гадать про колонку); reparse рушит матчи + минует автодетект (forward-only!); TS+Python синхронно.
2. Главный бриф фичи #3: `docs/plans/active/feature3_invoice_discount_worker_brief.md` — ТЗ, главный риск (двойная скидка), безопасное направление (сверка с печатным Итого), 2 этапа.
3. Handoff/контекст проекта: `docs/plans/references/2026-05-30_handoff_parser_deployed_next_steps.md`.

=== ТОЧКА ПРОЕКТА (верифицировано на проде) ===
Прод = `2533dfd`, контейнер пересобран, health ok. Канонический контракт цены/ед = **с НДС (×1) × со скидкой если есть**.
- Фича #1 (НДС ровно один раз) ✅ задеплоена+верифицирована (`99ad9a1`).
- Фича #2 (скидка-колонка, форма A) ✅ задеплоена+верифицирована (`2533dfd`).
- Порядок фич 1→2→3→4. **СЛЕДУЮЩЕЕ = #3** (скидка «−X%» в конце счёта, форма C).
North Star: «80% авто + ≤15 мин ревью». Покрытие матчинга 88.3% (333/268/44) — не трогать.

=== ФИЧА #3 (что делаем) ===
Авто-применять детектированную скидку «−X%» из конца счёта к строкам — НО только когда доказано
сверкой с печатным «Итого» (иначе двойная скидка / false-positive). Детали и главный риск — в брифе.
**РИСК ВЫШЕ #1/#2** (меняет суммы строк) → строго **design-first**: worker/субагент возвращает
ДИЗАЙН до кода, ты (оркестратор) утверждаешь направление, потом реализация.

=== ТВОЯ РОЛЬ И МЕХАНИЗМ ===
- Держишь цель/контракт/метрику; код сам не пишешь — делегируешь субагенту в isolation-worktree
  (как #2) ИЛИ worker-чату; ведёшь 5-move гейт, merge+push, верификацию на проде.
- Цикл: read-only дизайн → **твой чекпоинт (утвердить направление)** → реализация в worktree (НЕ пушить)
  → trust-but-verify diff + независимый прогон тестов → 5-move гейт (5 субагентов, main-SKILL
  `.claude/skills/pre-deploy-check/SKILL.md`) → merge+push → деплой → верификация (SHA + CREATED + health,
  при старом CREATED — ручной `--build`).

=== ПРАВИЛА ПРОЕКТА (обязательные) ===
- feedback_no_action_without_confirmation — без явного «ок» не действовать.
- feedback_explain_before_after — состояние → изменение → результат до действия.
- feedback_build_before_push — `npm run build` чистый перед push (проверяй РЕАЛЬНЫЙ exit, не код `tail` в пайпе; если tsc пропал — `npm install` в backend).
- feedback_commit_named_files — `git add` только именованные файлы (НЕ `-A`/`.`; package-lock от npm install НЕ коммитить).
- pre-deploy-check 5-move (5 отдельных субагентов, ссылка на main-версию SKILL) — PASS перед `git push origin main`. При активных worktree гонять через Agent с явной ссылкой на main SKILL (worktree-копия может быть старой).
- feedback_no_hardcode — без хардкода поставщиков/индексов/порогов.
- forward-only: НЕ reparse существующих счетов (рвёт матчи 333/268/44).
- Прод: API `http://5.42.103.63:3001`; деплой авто на push, но проверять CREATED; SSH по паролю работает.

Контекст экономь. На ~60% флагни и предложи handoff.

Начни с: краткое подтверждение точки проекта (1-2 строки) + предложи план Этапа 1 фичи #3
(read-only дизайн: подтвердить detectDiscount/apply-discount, проверить на проде счета с
discount_detected, спроектировать безопасное авто-применение по сверке с Итого) и жди моего «ок».

---
