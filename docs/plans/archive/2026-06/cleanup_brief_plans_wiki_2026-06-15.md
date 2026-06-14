# Бриф (отдельный чат): зачистка docs/plans/active/ + Tier-1 порядок в «вики»

> Дата постановки: 2026-06-15. Тип: **гигиена документации** (НЕ код, НЕ прод-логика). Правило «один план — один чат».
> Цель: в `docs/plans/active/` остаётся ТОЛЬКО (1) действующий стратегический план + (2) горстка файлов текущей фазы. Всё прочее → `archive/2026-06/` (правило №4 README: не удаляем). Снижает когнитивную нагрузку оркестратора.
> Этот файл сам уезжает в архив после выполнения.

## Уже сделано в чате 06-15 (вариант A)
Указатели «текущего плана» выровнены на `active/PLAN_track_A_B_metric_gated_2026-06-11.md` в: `docs/plans/README.md`, `docs/plans/STATUS.md` (+баннер), `.business/INDEX.md`.
- Действующий авторитетный план = **`PLAN_track_A_B_metric_gated_2026-06-11.md`**. Живой бэклог = **`carry_tasks_backlog_2026-06-15.md`**.

## Инвентаризация active/ (≈90 файлов, разведка 06-15)
**ОСТАВИТЬ в active/** (стратегия + текущая фаза; перед оставлением СВЕРИТЬ каждый с PLAN_track_A_B — если фаза закрыта, в архив):
- `PLAN_track_A_B_metric_gated_2026-06-11.md` (стратегия), `carry_tasks_backlog_2026-06-15.md` (бэклог)
- Текущая фаза В1/B1.2/семантика: `worker_brief_2026-06-14_metrics_dashboard_v1.md`(+`_fixes.md`), `worker_brief_2026-06-14_dashboard_visibility_flag.md`, `next_chat_prompt_2026-06-14_potok_b1_2_sokoliy_vk_offline.md`, `next_chat_prompt_2026-06-15_semantic_coverage_lever.md`, `operator_feedback_notifications_worker_brief.md`, `learning_engine_proof_2026-06-11.md`, `learning_methodology_rov_2026-06-11.md`, `semantic_engine_proof_2026-06-11.md`, `coverage_layer1_experiment_2026-06-14.md`, `accuracy_at_1_proj6_2026-06-14.(md/json)`

**В АРХИВ `archive/2026-06/`** (перекрытое/завершённое):
- `plan_prod_readiness_2026-05-13.md`, `master_plan_phased_2026-06-05.md` (перекрыты PLAN_track_A_B; операц-модель из master_plan живёт в памяти + скилле `pre-deploy-check`), `orchestrator_start_prompt_2026-06-05.md`
- ВСЕ `*_result.md` + их парные брифы/промпты (`worker_brief_*`, `next_chat_prompt_partB_*`) — завершены
- Старые `next_chat_prompt_*` (до 06-11) — кроме явно открытых по PLAN_track_A_B
- Завершённые `feature*`-брифы (vat/discount), `b1_*`-замеры 06-13, `discount_*`-диагностики 06-11, `parent_child_*`-результаты (Поток 0 = ПАРК), `proj12_*`-замеры

**РЕШИТЬ С ВЛАДЕЛЬЦЕМ** (stale-unclear, ~6): `worker_brief_canonical_kb_*` без результата, `feedback_loop_and_finish_metric_design_2026-06-03`, `opensource_landscape_2026-06-11`, `email_loop_*` артефакты, `data_handover_spec_for_owner_2026-06-06`, `task15_followups`.

## Как переносить (правило docs/plans/README.md)
1. `git mv` в `archive/2026-06/` (сохранять имя файла).
2. Обновить `archive/2026-06/README.md` — опись (файл / что это / почему в архиве). Там уже есть `next_chat_prompt_gigachat_model_fix.md`.
3. Дописать `docs/IMPLEMENTATION_LOG.md` групповой записью (дата, перечень, короткий итог).
4. Починить ЖИВЫЕ ссылки на перенесённые планы (`grep plan_prod_readiness_2026-05-13|master_plan_phased_2026-06-05`); ссылки внутри самих архивируемых/исторических файлов трогать не обязательно.
5. Включить страж: `cd backend && npm run plans:check:strict` → должен пройти (WIP=1, нет зависших, лог не пуст).
6. Гейт: doc-only → `git add` именованных файлов → коммит (ASCII-сообщение) → push. Прод-логику НЕ трогаем.

## Tier-1 порядок в «вики» (аудит 06-15; тем же чатом или следующим)
- Создать `architecture/INDEX.md`, связывающий 01–09 + единый «start here» (README → architecture → plans → .business → research).
- Освежить устаревшие факты (доки описывают систему середины мая):
  - `README.md`: парсер = **pdfplumber-first** (с 14.05), не «pdf-parse»; матчинг = **+ Gemini-tier (фаза 8.1)**, не только Dice.
  - `architecture/01-обзор`, `architecture/06-стек`: добавить pdfplumber как слой 0.
  - СВЕРЯТЬ С КОДОМ: `gigachatSpecFromPdf.ts` (pdfplumber-first подтверждён), matcher (Gemini-tier).
- НЕ трогать: датированные хендоффы/ретроспективы (история); прод-IP `5.42.103.63`/порт/путь-БД — совпадают ✓.

## Готово =
`active/` = только стратегия + текущая фаза; `archive/2026-06/` с описью; `IMPLEMENTATION_LOG` обновлён; `plans:check:strict` зелёный; (опц.) `architecture/INDEX.md` есть, README освежён. **Память чистить НЕ нужно — она уже актуальна** (указывает на PLAN_track_A_B).
