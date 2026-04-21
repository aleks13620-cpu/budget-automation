# Планы проекта

Эта папка — единая точка хранения всех планов и связанных материалов.

## Структура

- `docs/plans/active/` — активные планы в работе.
- `docs/plans/archive/` — завершенные планы (не удаляются, а архивируются).
- `docs/plans/references/` — вспомогательные материалы: ТЗ, анализ, заметки.
- `docs/IMPLEMENTATION_LOG.md` — краткий журнал того, что реализовано по планам.

## Правила

1. Новый план добавляется в `docs/plans/active/`.
2. После завершения план переносится в `docs/plans/archive/YYYY-MM/`.
3. После переноса в архив в `docs/IMPLEMENTATION_LOG.md` добавляется запись:
   - дата закрытия;
   - название плана;
   - короткий итог;
   - ссылка на архивный файл;
   - опционально коммиты/PR.
4. Планы не удаляются без следа: история всегда сохраняется через архив и Git.
5. Внутренние планы Cursor из `.cursor/plans/` считаются локальными; канон репозитория находится в `docs/plans/`.

## Скрипт жизненного цикла

- Добавить новый план в активные:
  - `node scripts/plan-workflow.mjs ingest "C:/path/to/plan.md" --normalize`
- Закрыть активный план и перенести в архив:
  - `node scripts/plan-workflow.mjs complete "docs/plans/active/plan_name.md" --summary "Реализован API;Добавлены тесты" --commits "abc123..def456"`
- Проверка без изменений:
  - `node scripts/plan-workflow.mjs ingest "C:/path/to/plan.md" --dry-run`
