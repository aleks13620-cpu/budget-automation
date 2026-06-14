# Архив планов и связанных материалов — 2026-06

Групповой архив по итогам зачистки `docs/plans/active/` 2026-06-15
(бриф: `cleanup_brief_plans_wiki_2026-06-15.md`, перенесён сюда последним).

Действующий стратегический план остаётся в `docs/plans/active/PLAN_track_A_B_metric_gated_2026-06-11.md`.
Бэклог хвостов — `docs/plans/active/carry_tasks_backlog_2026-06-15.md`.

Архив сохраняет историю по правилу №4 `docs/plans/README.md` (планы не удаляются).

## Опись (что — что это — почему в архиве)

### Перекрытые планы верхнего уровня
- `plan_prod_readiness_2026-05-13.md` — план готовности прода (май). Перекрыт `PLAN_track_A_B_metric_gated_2026-06-11.md`.
- `master_plan_phased_2026-06-05.md` — фазированный мастер-план 06-05. Перекрыт PLAN_track_A_B; операционная модель живёт в памяти + скилле `pre-deploy-check`.
- `plan_matching_quality_2026-05-29.md` — план повышения качества матчинга. Перекрыт последующими фазами (B1/семантика).
- `orchestrator_start_prompt_2026-06-05.md` — стартовый промпт оркестратора 06-05. Перекрыт текущим стартом сессии (память + хук).

### Завершённые next_chat_prompt_* (по фазам)
- `next_chat_prompt_2026-05-30_postdeploy.md` — postdeploy 05-30. Закрыт.
- `next_chat_prompt_2026-06-01_feature3.md`, `..._feature4.md` — фичи F3/F4. Закрыты.
- `next_chat_prompt_2026-06-04_lastochka_parser_and_open_items.md` — Сокольи парсер 06-04. Закрыт (Lastочка/clean repr — потолок ~52%, поток «парсер» в парке).
- `next_chat_prompt_2026-06-07_parser_canonical_gate.md` — парсер-канонический gate. Закрыт.
- `next_chat_prompt_2026-06-08_northstar_lastochka_lever.md` — рычаг Сокольи 06-08. Закрыт.
- `next_chat_prompt_2026-06-10_orchestrator_catalog_phase.md` — фаза каталога 06-10. Перекрыта последующими (потоки А/Б).
- `next_chat_prompt_2026-06-11_orchestrator_parent_child_phase.md` — parent-child 06-11. Опровергнут (см. `reflection_2026-06-11_parent_child_clean_repr_dominant_lever.md` в памяти).
- `next_chat_prompt_2026-06-12_learning_trust_phase.md` — фаза «обучения/доверия» 06-12. Перекрыта Потоком B1 (приземлён 06-13).
- `next_chat_prompt_F3_parser_version_bump.md` — бамп PARSER_VERSION. Сделан.
- `next_chat_prompt_F5_cron_and_bot_setup.md` — cron/бот. Закрыт.
- `next_chat_prompt_finish_spec_clean_repr_build.md` — финал spec/clean_repr. Закрыт.
- `next_chat_prompt_metrics_phase3_dashboard.md` — дашборд метрик. Заземлён в `worker_brief_2026-06-14_metrics_dashboard_v1*` (тек. фаза).
- `next_chat_prompt_operator_feedback.md`, `..._ch1_deploy.md` — operator feedback (две главы). Закрыты (`operator_feedback_notifications_worker_brief.md` ведётся в active).
- `next_chat_prompt_partB_build_resplit_endpoint.md`, `..._partB_recon_resplit_proj11.md` — расщепление позиций (части B). Закрыты (есть парные `_result.md`).
- `next_chat_prompt_predeploy_gate.md` — предеплой-гейт. Сделан, живёт в скилле `pre-deploy-check`.
- `next_chat_prompt_roven_form_b_finish.md` — финиш «Ровень/Форма Б». Закрыт.
- `next_chat_prompt_gigachat_model_fix.md` — фикс модели GigaChat. Сделан (deploy 06-15, `8e8dbe1` в проде).
- `next_chat_prompt_2026-06-15_wiki_tier1_audit.md` — Tier-1 wiki-аудит 06-15 (`architecture/INDEX.md`, освежение README по pdfplumber-first и Gemini-tier, врезка в 01-обзор/06-стек). Закрыт.

### Завершённые worker_brief_* и парные result.md
- `worker_brief_2026-06-13_potok_b1_load_27_pairs_to_memory.md` — загрузка 27 эталонных пар (Поток B1, приземлён 06-13).
- `worker_brief_deploy_dockerhub_fix.md` (+ `_result`) — фикс деплоя через Docker Hub. Закрыт.
- `worker_brief_lastochka_clean_repr_generic_gate.md` (+ `_result`) — Сокольи clean repr generic gate. Закрыт (поток парсера в парке).
- `worker_brief_lastochka_reparse_rematch.md` (+ `_result`) — reparse/rematch Сокольи. Закрыт.
- `worker_brief_lastochka_rootcause_diagnostic.md` — диагностика рута Сокольи. Закрыта.
- `worker_brief_marking_discriminator.md` (+ `_result`) — маркинг-дискриминатор. Закрыт.
- `worker_brief_parser_ai_hierarchy.md` (+ `_result`) — AI-иерархия парсера. Закрыта.
- `worker_brief_spec_clean_repr_build.md` — сборка spec/clean_repr. Закрыт.
- `worker_brief_verity_benchmark_baseline.md` (+ `_result`) — verity бенчмарк. Закрыт.
- `worker_proj12_parse_fix_phase1_result.md` — фикс парсинга проекта 12 (фаза 1). Закрыт.
- `worker_prompt_parser_2026-05-30.md` — промпт парсера 05-30. Закрыт.

### Канонический KB (поток заморожен)
- `worker_brief_canonical_kb_bootstrap.md`
- `worker_brief_canonical_kb_fix_alias_model.md`
- `worker_brief_canonical_kb_history_exam.md`
- `worker_brief_canonical_kb_phase2_matcher_integration.md` (+ `_result`)
  Поток приостановлен; в текущем плане (Поток А/Б) не активен.

### B1-замеры 06-13
- `b1_after_2026-06-13.md`, `b1_baseline_2026-06-13.md`, `b1_dryrun_2026-06-13.md`, `b1_landed_2026-06-13.md`, `b1_post_response_2026-06-13.json` — замеры до/после приземления Потока B1. Зафиксированы.
- `b1_1_accuracy_at_1_proj12_after_landing_2026-06-14.md` — accuracy@1 проекта 12 после приземления B1.

### Discount/VAT — фичи 06-11
- `discount_formd_fix_result_2026-06-11.md`, `discount_formd_predeploy_report_2026-06-11.md`, `discount_unit_price_diagnosis_2026-06-11.md` — скидки на «Форму Д». Закрыты.
- `feature1_vat_exactly_once_worker_brief.md`, `feature2_discount_column_worker_brief.md`, `feature3_invoice_discount_worker_brief.md`, `feature4_position_discount_worker_brief.md` — фичи VAT/discount. Закрыты.

### Email loop / ingestion (артефакты)
- `feature_email_invoice_ingestion_brief_2026-06-01.md` — бриф email-ingestion.
- `email_loop_questions_for_customer.md`, `email_loop_scheme_for_customer.html`, `email_loop_scheme_for_customer.png` — артефакты email-петли для клиента.
  Поток отложен.

### Parent-child / proj12 — диагностики 06-11
- `parent_child_proj11_mirror_result_2026-06-11.md`, `parent_child_proving_result_2026-06-11.md` — попытки парсер-зеркала. Опровергнуты (потолок ~52%, поток в парке).
- `proj12_ov_parse_quantity_loss_diagnosis_and_fix_cycle_2026-06-11.md`, `proj12_verity_at1_2026-06-11.md` — диагностика проекта 12.
- `clean_read_potok0_result_2026-06-12.md` — результат clean-read Потока 0 (парсер). В парке.

### Operator feedback / questions / registry
- `operator_feedback_memo.md`, `operator_questions_2026-05-30.md` — старые памятки/вопросы. Перекрыты `operator_feedback_notifications_worker_brief.md` (active) + памятью.
- `project_registry_and_metrics_focus_2026-06-03.md` — реестр и фокус метрик 06-03. Перекрыт `project_global_metrics_dashboard.md` (память) + дашбордом.
- `feedback_loop_and_finish_metric_design_2026-06-03.md` — дизайн finish-метрики 06-03. Перекрыт.
- `parser_h3_investigation_2026-05-30.md` — расследование H3 парсера. Закрыто.

### partB / опись_следования
- `partB_build_resplit_endpoint_result.md`, `partB_recon_resplit_proj11_result.md` — части B по расщеплению позиций.

### Метрики/дашборд (приземлённые)
- `metrics_dashboard_v1_landed_2026-06-14.md` — итог дашборда v1 (приземлён 06-14).

### Прочее
- `data_handover_spec_for_owner_2026-06-06.md` — спецификация хендоффа данных. Перекрыта `architecture/*` и памятью.
- `task15_design_dup_detector.md`, `task15_followups.md` — задача 15 (детектор дубликатов). Старый бэклог, закрыто/перекрыто.
- `opensource_landscape_2026-06-11.md` — обзор open-source landscape 06-11. Разведка завершена.
- `cleanup_brief_plans_wiki_2026-06-15.md` — сам бриф этой чистки (сам уезжает в архив после выполнения).
