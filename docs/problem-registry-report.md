# Problem Registry Report

Updated: 2026-04-15T18:06:02.422Z

## Top priorities to solve now
- PRB-002 [P0/critical] score=4.14 Duplicate path variants tracked in Git -> user impact: Есть дубли одних и тех же файлов с разными разделителями путей (backend/src/... и backend\\src\\...), что ломает чистоту индекса и усложняет ревью.
  next: Deduplicate duplicated path entries and normalize separators
- PRB-001 [P0/critical] score=3.65 Repo contains transient/debug artifacts -> user impact: В репозитории отслеживаются временные файлы (debug-логи, sqlite wal/shm, временные json), что шумит в git и повышает риск случайных коммитов.
  next: Extend .gitignore for transient files and clean tracked artifacts
- PRB-003 [P1/high] score=3.34 Test invoices and binary samples are mixed with production tree -> user impact: Тестовые PDF/XLSX образцы лежат рядом с кодом без четкой политики хранения, что увеличивает вес репозитория и риск утечки данных.
  next: Move binary test files to dedicated test-data policy folder
- PRB-006 [P1/high] score=3.34 Database schema knowledge is not part of delivery checklist -> user impact: Изменения схемы БД могут происходить без обновления описания и проверки совместимости, что повышает риск регрессий на деплое.
  next: Formalize DB checklist and require db snapshot update
- PRB-004 [P2/medium] score=2.1 Documentation migration is incomplete and fragmented -> user impact: Часть документации перемещена, часть удалена/дублируется, из-за чего сложно понять актуальный источник правды.

## Aging issues (14+ days open)
- none

## Overdue issues
- none

## open (7)
- PRB-002 [P0/critical] score=4.14 Duplicate path variants tracked in Git
  user impact: Есть дубли одних и тех же файлов с разными разделителями путей (backend/src/... и backend\\src\\...), что ломает чистоту индекса и усложняет ревью.
  due: 2026-04-20
- PRB-001 [P0/critical] score=3.65 Repo contains transient/debug artifacts
  user impact: В репозитории отслеживаются временные файлы (debug-логи, sqlite wal/shm, временные json), что шумит в git и повышает риск случайных коммитов.
  due: 2026-04-22
- PRB-003 [P1/high] score=3.34 Test invoices and binary samples are mixed with production tree
  user impact: Тестовые PDF/XLSX образцы лежат рядом с кодом без четкой политики хранения, что увеличивает вес репозитория и риск утечки данных.
  due: 2026-04-25
- PRB-006 [P1/high] score=3.34 Database schema knowledge is not part of delivery checklist
  user impact: Изменения схемы БД могут происходить без обновления описания и проверки совместимости, что повышает риск регрессий на деплое.
  due: 2026-04-27
- PRB-004 [P2/medium] score=2.1 Documentation migration is incomplete and fragmented
  user impact: Часть документации перемещена, часть удалена/дублируется, из-за чего сложно понять актуальный источник правды.
- PRB-005 [P2/medium] score=2.1 No enforced pre-commit quality gate
  user impact: Нет обязательного pre-commit процесса (lint/test/validate registry), из-за чего дефекты и несогласованные изменения попадают в ветки.
- PRB-007 [P2/medium] score=2.1 Issue backlog process was previously informal
  user impact: До внедрения реестра проблемы фиксировались несистемно, из-за чего терялись приоритеты и статус выполнения.

## in_progress (0)
- none

## blocked (0)
- none

## resolved (0)
- none

