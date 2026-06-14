# Стартовый промпт для НОВОГО чата — Замечания оператора Ч1: merge → deploy → verify + памятка

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation`, роль — деплой-инженер/оркестратор.
> Создан 2026-06-03 после того, как Ч1 «Замечания оператора» доведена до PASS (5 кругов pre-deploy 5-move).

---

## Задача
Задеплоить УЖЕ ГОТОВУЮ и ПРОВЕРЕННУЮ фичу **Ч1 «Замечания оператора»** (видимость тегов в выгрузке/списке + кнопка «Вопрос» + читаемые RU-ярлыки на всех командных экранах), доделать **памятку оператору**, оформить **CARRY-задачи**. Парсер/обучение НЕ трогать.

## Точка проекта (на момент handoff — ПЕРЕПРОВЕРЬ)
- `main` = `35b1915` (ПЕРЕПРОВЕРЬ `git fetch origin` — мог уехать).
- Готовая ветка: **`feature/operator-feedback-ch1`** — 5 коммитов от `35b1915`, **НЕ запушена, НЕ смержена**:
  - `6710c2f` feat: теги в `/feedback/all` + `/export` + тег `question`
  - `3ca41ff` fix: ярлыки тегов в общем списке `GlobalFeedbackPage` [гейт F1]
  - `c0b1f5c` fix: ярлыки тегов на per-project `FeedbackPage` (+`typeLabels`)
  - `f73be2a` fix: ярлык `confirm_analog`
  - `201ca5b` fix: ярлык `confirm_group_follower`
- Worktree: `C:\Users\home\vscode101\budget-automation-opfb-ch1` (`node_modules` = junction на main; **чистить ОСТОРОЖНО — см. §4**).
- Дифф: **4 файла, +87/−33**: `backend/src/routes/matching.ts`, `frontend/src/components/MatchTable.tsx`, `frontend/src/pages/GlobalFeedbackPage.tsx`, `frontend/src/pages/FeedbackPage.tsx`.
- Стек: Node/Express + SQLite + Docker, Timeweb (РФ), API `http://5.42.103.63:3001`, SSH по паролю у владельца. Health: `/api/health`.

## Что СДЕЛАНО и ПРОВЕРЕНО (доверять)
- **pre-deploy-check 5-move прогнан 5 кругов (loop-until-clean) → СОШЁЛСЯ / PASS:**
  - R1 нашёл F1 (общий список показывал сырые id тегов) → починен.
  - R2 нашёл per-project `FeedbackPage` с тем же → починен.
  - R3/R4 нашли пред-существующие сырые action-типы `confirm_analog`, `confirm_group_follower` → ярлыки добавлены.
  - **R5 CONVERGED:** доказано, что КАЖДЫЙ тип `operator_feedback` (`confirm`, `confirm_analog`, `confirm_group_follower`, `reject`, `manual_select`, `error_report`, `tag_×8`) читаем по-русски на ВСЕХ командных поверхностях (FeedbackPage, GlobalFeedbackPage, xlsx-экспорт). Сырых кодов в продукт-UI нет.
  - Move 4 build-gate каждый круг: backend `tsc` + frontend `tsc -b && vite build` = exit 0.
  - Move 5 security каждый круг: PASS (нет outbound, SQL без user-input, React экранирует, safelist ровно 8 тегов, нет `.env`/секретов).
- **Интеграционный тест на реальном пути** (собранный сервер на temp-SQLite, сид через настоящие endpoints): оба эндпоинта отдают `kind`/`label`/`typeLabels` корректно; тег `question` принимается; «левый» тег отбивается safelist'ом (400). PASS.
- **No-hardcode:** единый источник `TAG_LABELS` (бэк), `ALLOWED_TAGS = Object.keys(TAG_LABELS)`. Лернер `operator_feedback` НЕ читает (проверено) — теги в обучающий сигнал не текут.

## ЧТО ОСТАЛОСЬ (этот чат)

### 1. Деплой
0. pre-deploy-check фактически пройден (5 кругов PASS). Формально можно прогнать `/pre-deploy-check` на финальном диффе ещё раз — не обязательно.
1. `git fetch origin` → `main` всё ещё `35b1915`? Если уехал — отребейзь ветку/мёржи аккуратно (конфликтов не ждём, файлы фиче-специфичны).
2. **Откати грязный package-lock в main** перед мержем: `git checkout -- backend/package-lock.json` (там пред-существующий `M`; package-lock НЕ коммитим).
3. Мерж: `git checkout main && git merge feature/operator-feedback-ch1` (fast-forward, linear). **НЕ `-A`/`.`**.
4. **feedback_build_before_push:** в main-репо `cd backend && npm run build` (exit 0) + `cd frontend && npm run build` (exit 0).
5. `git push origin main`.
6. **Деплой** (по `reflection_2026-05-30_deploy_verification_gap`): GH Actions авто-деплой часто НЕ срабатывает. SSH на сервер, проверь CREATED-время контейнера; старое → вручную `docker compose up -d --build`.
7. **Верификация (push≠deployed!) — функциональная, не только health.** Через HTTP API прода:
   - `/api/health` ok;
   - есть tag-строки на проде? `GET /api/feedback/all` → у `kind:'tag'` строк есть RU `label`;
   - `GET /api/projects/<id>/feedback` → присутствует `typeLabels`, у tag-строк `label`;
   - или живой smoke в UI: «Все замечания» / «Обратная связь» показывают русские ярлыки вместо `tag_*`/`confirm_*`.

### 2. Памятка оператору (финал)
- Черновик: `docs/plans/active/operator_feedback_memo_DRAFT.md`.
- **Финальные названия кнопок = КАК В UI** (`MatchTable.tsx` QUICK_TAGS), сейчас ровно так:
  `💰 Цена не та` · `🔖 Не та маркировка` · `🔀 Нужны альтернативы` · `📑 Дубль` · `🚫 Не покупали` · `≈ Аналог другого бренда` · `🐛 Парсер пропустил` · `❓ Вопрос / не уверен`
  (в черновике другие иконки/слова — привести к этим).
- Авто-уведомление в Telegram (Ч3) пока пометить «скоро» (НЕ сделано).

### 3. CARRY-задачи (оформить, напр. problem-registry; деплою НЕ мешают)
- **F3:** `/feedback/all` `LIMIT 500` делят заметки и теги — при росте теги вытесняют старые заметки из окна. → пагинация/раздельные лимиты.
- **F4:** `/feedback/export` без LIMIT, строит весь xlsx в памяти. → стрим/кап.
- **dev-report:** `scripts/feedback-report.py` печатает сырые `type` (dev/ops-CLI, не команд-UI). → маппинг ярлыков, если нужно.
- **(наблюдение)** per-project `/api/projects/:id/feedback` НЕ возвращает `f.status` → на `FeedbackPage` «Разобрано» не переживает перезагрузку (resolve локальный). Пред-существующее, к тегам не относится. → отдельный фикс при желании.

### 4. Чистка worktree (⚠️ JUNCTION-FOOTGUN!)
После мержа. **СНАЧАЛА сними junction-ы — иначе рекурсивное удаление worktree может стереть `node_modules` в main!**
```
cmd /c rmdir "C:\Users\home\vscode101\budget-automation-opfb-ch1\backend\node_modules"
cmd /c rmdir "C:\Users\home\vscode101\budget-automation-opfb-ch1\frontend\node_modules"
```
(`rmdir` без `/s` на junction удаляет ТОЛЬКО ссылку. Проверь, что в main `backend\node_modules\.bin\tsc.cmd` на месте.) Затем:
```
git -C C:\Users\home\vscode101\budget-automation worktree remove C:\Users\home\vscode101\budget-automation-opfb-ch1 --force
git -C C:\Users\home\vscode101\budget-automation branch -d feature/operator-feedback-ch1
```

## Правила
feedback_no_action_without_confirmation; feedback_explain_before_after; feedback_build_before_push (реальный exit); feedback_commit_named_files (НЕ `-A`/`.`; package-lock не коммитить); forward-only (НЕ reparse — рвёт матчи). Контекст: фича дисплейная, обучение/матчер не трогает.

## Дальше (НЕ в этом чате — отдельные фазы)
- **Ч2** инбокс «Замечания»: по сути УЖЕ есть = `GlobalFeedbackPage` (кросс-проектный список, бейдж `newCount`, табы статуса, «Разобрано», экспорт). Доработка по брифу — отдельно.
- **Ч3** Telegram-пинг (дайджест; residency: только ID+ссылка; токен/chat_id в `.env`) — investigation-first, отдельно.
- Бриф: `docs/plans/active/operator_feedback_notifications_worker_brief.md`.
