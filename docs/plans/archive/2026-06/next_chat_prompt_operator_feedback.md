# Стартовый промпт для НОВОГО чата — Замечания оператора + авто-уведомление (оркестратор)

> Открой новый чат Claude Code в `C:\Users\home\vscode101\budget-automation`, дай мне роль
> ОРКЕСТРАТОРА и вставь текст между линиями.

---

Привет. Возвращаюсь к budget-automation. Ты — ОРКЕСТРАТОР этого чата. Делаем фичу
**«Замечания оператора»**: довести до рабочего варианта (видимость тегов в выгрузке + кнопка
«Вопрос» + авто-уведомление в Telegram) **и написать простую памятку оператору**.

=== СНАЧАЛА ПРОЧИТАЙ ===
1. Бриф (ТЗ): `docs/plans/active/operator_feedback_notifications_worker_brief.md`
2. Черновик памятки оператору: `docs/plans/active/operator_feedback_memo_DRAFT.md` — довести до финала
   после сборки (финальные названия кнопок = как в UI).
3. Память: `MEMORY.md` + рефлексии:
   - `reflection_2026-05-27_feedback_ux_gap` — связь недоиспользована (1 запись на 6 устных проблем).
   - `reflection_2026-05-29_package_b_deployed` — #17 теги + safelist `ALLOWED_TAGS`, **валидация тега
     на бэке, не на фронте**.
   - `reflection_2026-05-31_orchestrator_worker_pattern` — оркестратор+субагент-в-worktree; гейт >
     дизайн-чекпоинт; **unit-green ≠ wired-in** (интеграционный тест на боевом пути); npm install в
     isolation-worktree затирает node_modules main (проверь `backend/node_modules/.bin/tsc`).
   - `reflection_2026-05-30_deploy_verification_gap` — **push ≠ deployed** (CREATED-время контейнера).
   - `reflection_2026-06-01_roven_form_b_deployed` — последний деплой (bc03dcc), гейт/верификация.

=== ТОЧКА ПРОЕКТА ===
Прод = `bc03dcc` (#4 Ровен задеплоен+верифицирован). Стек: Node/Express + SQLite + Docker на
**Timeweb (РФ)**, API `http://5.42.103.63:3001`. SSH по паролю работает у владельца.
УЖЕ ЕСТЬ (проверено в коде): таблица `operator_feedback`; **7 one-click тегов**
(`POST /api/projects/:id/feedback/tag`, `ALLOWED_TAGS` в `matching.ts:1995`); **free-text**
(`POST /api/projects/:id/feedback`); вывод `/api/feedback/all` + `/api/feedback/export` — но они
фильтруют **только `type='error_report'`**, теги (`type='tag_%'`) НЕ видны.

=== РЕШЕНО (не пере-обсуждать, владелец утвердил) ===
- **Канал = Telegram-бот в рабочую группу.** Достижимость с прод-сервера ПОДТВЕРЖДЕНА (2026-06-01:
  `curl api.telegram.org/bot0:0/getMe` с сервера → `{ok:false,401}` = связь есть).
- **Residency:** наружу уходит ТОЛЬКО пинг (проект + № позиции + тег + ссылка в инбокс), **БЕЗ
  названий материалов/поставщиков**. Полный контент — в системе на RF-сервере.
- **Каденс** — дайджест (сводка «N новых по проекту X»), не на каждый клик (анти-спам). Иное —
  обосновать и спросить.
- **Токен/chat_id — в `.env`, не в коде. Секреты НЕ логировать.**

=== SCOPE (из брифа) ===
- **Ч1 (мелко, низкий риск):** включить теги (`type LIKE 'tag_%'`) в `/feedback/all` + `/export` с
  читаемыми RU-ярлыками (единый источник tag→label рядом с `ALLOWED_TAGS`); добавить тег `question`
  в `ALLOWED_TAGS` + кнопку на review-экране.
- **Ч2:** инбокс «Замечания» + счётчик новых (проверить, не покрыто ли уже `/feedback/all` UI).
- **Ч3:** Telegram-пинг (дайджест) + `.env`-конфиг + минимальный контент.
- **+ финальная памятка оператору** (простой язык, из черновика).

=== ЦИКЛ И ПРАВИЛА ===
Investigation для Ч3 (контент=пинг, каденс) → твой чекпоинт → реализация в worktree от ТЕКУЩЕГО `main`
(НЕ пушить) → trust-but-verify diff + независимый прогон тестов → **pre-deploy-check 5-move**
(`.claude/skills/pre-deploy-check/SKILL.md`; Move 5 особо: токен в логах, `.env` не в коммите,
исходящие данные = residency) → merge+push → деплой → верификация (SHA + CREATED + health; CREATED
старое → ручной `docker compose up -d --build`).
Правила: feedback_no_action_without_confirmation; feedback_explain_before_after;
feedback_build_before_push (реальный exit); feedback_commit_named_files (НЕ `-A`/`.`; package-lock не
коммитить); feedback_no_hardcode; forward-only (НЕ reparse — рвёт матчи 333/268/44).
Контекст экономь; на ~60% флагни handoff.

Начни с: подтверждение точки проекта (1-2 строки) + план **Ч1** (мелкая, низкий риск — начни с неё) и
жди моего «ок».

---
