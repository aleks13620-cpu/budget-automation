# Handoff — пауза до завтра (2026-05-17)

## TL;DR

День был продуктивный по диагностике, но **финальный замер не подтверждён** — после force-rebuild с патчем ordering сервер завис на 25+ мин. Зафиксированная цифра: **46.2% автоматического матчинга** (331/717) на проде, проект 4 "тест 14.05". Эффект от alias-кода не подтверждён ни в плюс, ни в минус — последний прогон не дошёл.

## Прод HEAD

| Что | Где |
|---|---|
| Локально main | `e12a83b` (worktree branch claude/fervent-bhaskara-d87216) |
| Remote main | `e12a83b` — задеплоен ~17:05 UTC через `docker compose build --no-cache` (82.8s real rebuild) |
| Контейнер | возможно в зависшем состоянии после моего trigger матчинга |

## Что задеплоено сегодня (3 новых коммита)

| SHA | Описание | Результат |
|---|---|---|
| `7be8c33` | feat(matcher): lexical aliases for ventilation + dim separator * | Эффект ноль — section gate блокировал invoice-side |
| `ffe74fd` | fix(matcher): bypass section gate for invoice/rule-side | Эффект ноль — синонимы содержат стоп-слова, удалённые до проверки |
| `e12a83b` | fix(matcher): apply aliases before strip + stop-word removal | **НЕ ВЕРИФИЦИРОВАН** — сервер завис при матчинге |

## База на завтра — что точно работает

✅ **Прод-код актуальный** (`SPEC_PDF_PARSER_VERSION=4`, A.1+B.1-B.5 закрыты)
✅ **Парсер PDF корректно мержит parent-child** (verified локально и через API)
✅ **Матчер работает функционально**: 331/717 = 46.2% с conf>=0.6 кандидатами
✅ **Training mode полностью реализован** — endpoint `POST /api/projects/:id/import-matches`, таблица `matching_rules` глобальная cross-project
✅ **114 исторических правил импортированы** из файлов user'а (Веза, ИТЕСА, ЦИС и пр.)

## Главная находка дня — observability gap

Раньше "0 матчей" в UI воспринималось как баг кода. Реальная причина: матчинг просто никогда не запускался автоматически после загрузки спеки. Зафиксировано в memory: `reflection_2026-05-17_matcher_silent_idle.md`. Это **отдельная задача E.1** на план — UI badge "Сопоставление не запускалось" + auto-trigger после parse.

## Первые шаги завтра (по порядку)

### Шаг 1 — оживить прод
```bash
ssh root@5.42.103.63
cd /root/budget-automation
docker compose ps
docker compose logs app --tail=60
docker compose restart app
sleep 15
curl -s http://localhost:3001/api/health
```

### Шаг 2 — если в логах LLM-deadlock или OOM
Откатить последний коммит:
```bash
cd C:\Users\home\vscode101\budget-automation\.claude\worktrees\fervent-bhaskara-d87216
git revert e12a83b --no-edit
git push origin claude/fervent-bhaskara-d87216:main
# затем на сервере: git pull + docker compose up -d --build
```

После rebake aliases-not-firing уже доказан (ffe74fd-state) — это безопасный baseline. Декларируем **46.2% + 114 правил** как сегодняшний результат, начинаем обучение заказчика.

### Шаг 3 — если логи показывают что-то другое
Разбираемся точечно. Возможные сценарии:
- Просто долгий LLM tier — добавить timeout per LLM call
- Бесконечный цикл в applyDomainAliases — невероятно по коду, но возможно edge case с пустой строкой
- OOM при создании bigrams на длинных alias-текстах — добавить max length guard

### Шаг 4 — если e12a83b всё-таки работает
Скорее всего нет — но если матчинг отработает через `restart`, измеряем результат. Если >50% — победа, объявляем готовность.

## Открытые задачи (не сегодня)

- **E.1 Matcher observability** — UI status badge + auto-trigger после загрузки спеки. P0 для UX заказчика.
- **E.2 dig into 1-to-1 twin diagnosis** — оказалось не lock в коде, реальная причина 52 близнецов неизвестна. Нужна отдельная сессия с трассировкой similarity для конкретных пар.
- **F. Scan upload (jpg/tiff)** — пропущено сегодня по решению user'а, переезжает на следующий этап.
- **C.1 HTTPS** — не блокер сегодня (общий доступ), но нужно до внешнего клиентского демо.
- **Шаблон "Наименование из спецификации" в сметах** — стратегический — даст сотни training-pairs автоматически с каждой закрытой сметой. **Записать в .business как требование к продукту.**

## Файлы созданные сегодня

- `backend/src/services/matcherAliases.ts` (132 → 138 строк, 7 alias-групп)
- `backend/scripts/replay-matching.ts` (196 строк, local benchmark)
- `C:\Users\home\historical_matches.xlsx` (114 пар, импортированы на прод)
- `C:\Users\home\.claude\projects\.../memory/reflection_2026-05-17_matcher_silent_idle.md`

## Команды быстрого старта новой сессии

```bash
cd C:\Users\home\vscode101\budget-automation
git log --oneline -5
cat .claude/worktrees/fervent-bhaskara-d87216/docs/plans/references/2026-05-17_handoff_aliases_hung.md
ssh root@5.42.103.63 'cd /root/budget-automation && docker compose ps && docker compose logs app --tail=30'
```
