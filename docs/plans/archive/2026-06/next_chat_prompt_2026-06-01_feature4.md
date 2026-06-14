# Стартовый промпт для НОВОГО чата — Фича #4 (оркестратор)

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation`, дай мне роль
> ОРКЕСТРАТОРА и вставь текст между линиями.

---

Привет. Возвращаюсь к budget-automation. Ты — ОРКЕСТРАТОР этого чата. Работаем над **фичей #4**
(скидка на отдельные позиции, форма B). **ВАЖНО: строго investigation-first** — форма B помечена
«по сигналу, не вперёд данных», а недавняя #3 (форма C) дала 0 реальных кейсов → авто-применение
отложили. #4 может быть так же — сперва выясняем данные, потом решаем scope.

=== СНАЧАЛА ПРОЧИТАЙ ===
1. Память: `memory/MEMORY.md` + рефлексии:
   - `reflection_2026-05-31_feature3_detect_review_deployed` — 0 кейсов → defer/flag, не код вперёд
     данных; detect→review = безопасный фундамент; junction-ловушка при cleanup isolation-worktree.
   - `reflection_2026-05-31_orchestrator_worker_pattern` — оркестратор+субагент-в-worktree; гейт >
     дизайн-чекпоинт; **unit-green ≠ wired-in** (интеграционный тест на `processInvoiceFile`); npm
     install в isolation-worktree затирает node_modules main (проверь `backend/node_modules/.bin/tsc`).
   - `reflection_2026-05-30_deploy_verification_gap` — **push ≠ deployed**: проверять CREATED-время
     контейнера; SSH по паролю работает (у оператора).
   - `reflection_2026-05-30_parser_vat_fix_deployed` — сверять с document total; reparse разрушителен
     (forward-only!); TS+Python синхронно.
2. Бриф фичи #4: `docs/plans/active/feature4_position_discount_worker_brief.md` — ТЗ, главный вопрос
   (есть ли форма B в данных), 2 этапа.
3. Контекст: `docs/plans/references/2026-05-30_handoff_parser_deployed_next_steps.md`.

=== ТОЧКА ПРОЕКТА (верифицировано на проде) ===
Прод = `27f1ed8` (верифицировано: HEAD + контейнер CREATED свежий + health ok). Контракт цены/ед =
**с НДС (×1) × со скидкой если есть**.
- Фича #1 (НДС ровно один раз) ✅ deployed (`99ad9a1`).
- Фича #2 (скидка-колонка, форма A) ✅ deployed (`2533dfd`).
- Фича #3 (скидка «−X%» в конце, форма C) ✅ deployed как **detect→review** (`27f1ed8`) — помечает
  счёт `needs_amount_review` + причиной, суммы строк НЕ трогает.
  - **#3b (авто-применение формы C) ОТЛОЖЕНА** — припаркована в ДРУГОМ (основном) чате до появления
    реальных form-C счетов (0 кейсов сейчас + блокер провенанса `total_amount`). Живёт в той же
    discount-зоне `processInvoiceFile`.
- **#4 = форма B (скидка на отдельные позиции)** — ЭТА фича, НО под вопросом данных (investigation-first).
North Star: «80% авто + ≤15 мин ревью». Покрытие матчинга 333/268/44 — не трогать.

=== ⚠ КООРДИНАЦИЯ С #3b ===
#3b и #4 ОБА трогают discount-логику в `processInvoiceFile`. Near-term оба в investigation/паузе →
конфликта нет. Работай в worktree от текущего `main` (27f1ed8). Кто мёржит первым — второй ребейзит
свой worktree от нового main. Синхронизируй с оператором перед merge.

=== ТВОЯ РОЛЬ И ЦИКЛ ===
Держишь цель/контракт/метрику; код сам не пишешь — делегируешь субагенту в isolation-worktree ИЛИ
worker-чату. Цикл: Этап-1 read-only расследование (есть ли форма B в реальных данных? как парсится?)
→ **твой чекпоинт (вердикт: строить сейчас или defer как #3b)** → (если кейсы есть) реализация в
worktree (НЕ пушить) → trust-but-verify diff + независимый прогон тестов → 5-move гейт (5 субагентов,
main-SKILL `.claude/skills/pre-deploy-check/SKILL.md`) → merge+push → деплой → верификация
(SHA + CREATED + health; CREATED старое → ручной `--build`).

=== ПРАВИЛА ПРОЕКТА (обязательные) ===
- feedback_no_action_without_confirmation — без явного «ок» не действовать.
- feedback_explain_before_after — состояние → изменение → результат до действия.
- feedback_build_before_push — реальный exit; если tsc пропал — `npm install` в backend.
- feedback_commit_named_files — только именованные файлы (НЕ `-A`/`.`; package-lock не коммитить).
- pre-deploy-check 5-move PASS перед `git push origin main` (ссылка на main-SKILL — worktree-копия может быть старой).
- feedback_no_hardcode; forward-only (НЕ reparse — рвёт 333/268/44).
- Прод: API `http://5.42.103.63:3001`; деплой авто на push, но проверять CREATED; SSH по паролю работает.

Контекст экономь. На ~60% флагни и предложи handoff.

Начни с: краткое подтверждение точки проекта (1-2 строки) + предложи план Этапа 1 (read-only:
картировать текущую обработку per-position скидок + проверить прод на реальные form-B счета +
вердикт «строить сейчас или defer как #3b») и жди моего «ок».

---
