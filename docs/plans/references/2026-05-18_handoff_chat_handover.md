# Handoff для нового чата — 2026-05-18

## TL;DR для следующей сессии

**Контекст:** проект budget-automation, цель — вывести систему на 70% автоматического матчинга и передать заказчику для обучения сотрудников.

**Где остановились:** прод-сервер `5.42.103.63` сейчас **не отвечает на curl** к API матчинга (timeout). Image только что пересобран после revert последнего alias-патча. Health endpoint работает, но `/matching/run` и `/matching/status` дают timeout. Это **повторение вчерашнего паттерна**, что означает зависание НЕ из-за alias-кода (revert не помог).

**Точка стабильности:** 46.2% матчинга (331/717) + 114 импортированных исторических правил — это **подтверждённая цифра до начала alias-экспериментов**.

## Прод HEAD сейчас

```
15fd889 Revert "fix(matcher): apply aliases before punctuation strip and stop-word removal"
8ce420b docs(plan): handoff 2026-05-17 — pause, aliases deploy unverified
e12a83b fix(matcher): apply aliases before strip + stop-word removal (REVERTED ↑)
ffe74fd fix(matcher): bypass section gate for invoice/rule-side
7be8c33 feat(matcher): lexical aliases + dim separator *
```

Прод HEAD = `15fd889`. Контейнер был перезапущен сегодня после `docker compose up -d --build` (2s — cache hit, образ возможно не обновлён).

## Гипотеза по зависанию (НЕ verified)

После revert поведение НЕ изменилось → зависание не в alias-коде. Кандидаты:
1. **Docker cache hit 2s rebuild** — образ не пересобрался, в проде висит вчерашний `e12a83b`. Лечится `docker compose build --no-cache app`.
2. **GigaChat/OpenRouter LLM tier зависает** — недоступность внешнего API при `llmSuggestions=283` вызовах. Лечится: в логах искать LLM-таймауты, добавить per-call timeout.
3. **OOM или CPU starvation** при матчинге 717×218 пар (раньше работало, теперь нет).

**Первый шаг следующей сессии — это диагностика, не код.**

## План шагов (первые 4 действия)

### 1. Диагностика на сервере (user)
```bash
ssh root@5.42.103.63
cd /root/budget-automation
docker compose ps                    # контейнер up?
docker stats budget-automation-app-1 --no-stream  # CPU/RAM
docker compose logs app --tail=200 | grep -iE "error|llm|timeout|matcher"
docker exec budget-automation-app-1 grep -A2 'Section gate' /app/backend/dist/services/matcherAliases.js
# ↑ если выводит "only enforced when caller supplies" — образ обновлён
# ↑ если выводит "when a section is required but missing/mismatched" — кэш, нужен --no-cache
```

### 2. Если кэш не обновился
```bash
docker compose build --no-cache app && docker compose up -d
sleep 30 && curl -s http://localhost:3001/api/health
```

### 3. Триггер матчинга с диагностикой
```bash
# В одном терминале:
curl -X POST "http://localhost:3001/api/projects/4/matching/run" -d '{}' -H "Content-Type: application/json"
# В другом параллельно следить:
docker compose logs app -f --tail=10
```

Смотреть что происходит **строкой за строкой** — где именно зависает.

### 4. Решение по результату
- Матчинг прошёл → меряем %, декларируем готовность
- Матчинг висит на LLM tier → отключить временно: `ENABLE_OPENROUTER_LLM_MATCHING=false` в `.env`, restart
- Матчинг висит на normalize/alias loop → revert ещё на 2 коммита, до `acf21a1` (точка после A.1+B.5)

## Что точно работает (можно демонстрировать)

✅ Парсер PDF (v4) корректно мержит parent-child  
✅ Импорт исторических правил через `POST /api/projects/:id/import-matches`  
✅ Training mode полностью реализован (`matching_rules` глобальная)  
✅ UI кнопки 📊 Обучение и ⚠ Замечания на месте  
✅ 46.2% автомачтинг verified до alias-экспериментов  
✅ 114 правил активны в БД (импортированы из Веза/ИТЕСА/ЦИС файлов)

## Что НЕ работает / не верифицировано

❌ Lexical aliases в любой версии (3 деплоя, ни один не verified)  
❌ Текущий прод-матчер таймаутит на API  
⚠️ Скан-загрузка (jpg/tiff) — фича не реализована (отложено пользователем)  
⚠️ Silent matcher idle observability — задача E.1 в плане  

## Стабильный baseline для демо заказчику

Если завтра/сегодня нужно показывать систему — **достаточно вернуть прод на `acf21a1`** (предшествующий alias-экспериментам):

```bash
# на сервере:
cd /root/budget-automation
git fetch origin
git reset --hard acf21a1
docker compose build --no-cache app && docker compose up -d
```

Это **гарантированно рабочее состояние** на 46.2% + training mode + 114 правил.

## Стратегические задачи (не сегодня, в backlog)

- **Шаблон сметы** с колонкой "Наименование из спецификации" — даст автоматически сотни training-pairs с каждой закрытой сметой. Записать как продуктовое требование.
- **E.1 Matcher observability** — UI status badge + auto-trigger после parse. P0 для UX заказчика.
- **E.2 Diagnose 52 близнецов** — в коде нет 1-to-1 lock, реальная причина unknown.
- **F. Scan upload** — `.jpg/.tiff/.png` поддержка через OCR или конвертацию в PDF.
- **C.1 HTTPS** — nginx+certbot когда понадобится внешний клиентский доступ.
- **Aliases v2** — текущая стратегия (append + section-gate + co-occurrence) оказалась слаба. Подумать о REPLACE-стратегии или отдельной alias-tier в scoring.

## Файлы и SHA для нового чата

```
Worktree: C:\Users\home\vscode101\budget-automation\.claude\worktrees\fervent-bhaskara-d87216
Main:     C:\Users\home\vscode101\budget-automation
Branch:   claude/fervent-bhaskara-d87216 (1 коммит впереди main: 15fd889)
Server:   ssh root@5.42.103.63, path /root/budget-automation

Документы по делу:
- docs/plans/active/plan_prod_readiness_2026-05-13.md (генеральный план)
- docs/plans/references/2026-05-16_handoff_post_deploy.md (прошлый handoff)
- docs/plans/references/2026-05-17_handoff_aliases_hung.md (вчерашний)
- docs/plans/references/2026-05-18_handoff_chat_handover.md (этот документ)

Память пользователя:
- C:\Users\home\.claude\projects\C--Users-home-vscode101-budget-automation\memory\MEMORY.md
- ↑ см. правила: build-before-push, commit-named-files, no-action-without-confirmation, pre-deploy-check
- reflection_2026-05-17_matcher_silent_idle.md — диагностический урок (idle ≠ broken)
```

## Команды быстрого старта новой сессии

```bash
# В новом чате — стартовый prompt:

cd C:\Users\home\vscode101\budget-automation
git log --oneline -5
cat .claude/worktrees/fervent-bhaskara-d87216/docs/plans/references/2026-05-18_handoff_chat_handover.md
# затем юзер делает SSH-диагностику пункт 1 выше
```
