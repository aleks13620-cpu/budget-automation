# Handoff: PDF spec variant-children fix — состояние на 2026-05-13 12:00 МСК

**Дата:** 2026-05-13
**Статус:** F0–F6 код задеплоен, баг PRB-008 НЕ подтверждён в проде (пользователь не смог проверить из-за ошибки загрузки)
**Исходный план:** `docs/plans/references/2026-05-13_pdf_spec_variant_children_handoff.md`

---

## 1. Что сделано (коммиты main, все запушены)

| Фаза | Коммит | Суть |
|------|--------|------|
| F0 | `8e120a9` | Followups references (Варианты 2, 3 решения) |
| F1 | `c098120` | PRB-008 в problem-registry, двусторонние ссылки |
| F2 | `0daf3e1` | 5 синтетических PDF-фикстур + 5 expected.json + генератор `_gen.mjs` |
| F3 | `b74c2ad` | Регрессионный runner `scripts/test-spec-parent-child.mjs` + 5 gigachat-response моков, export `mapPdfItemsToRows`, TO_ZHE guard в `isSectionHeaderRow` |
| F4 | `d26a022` | `VARIANT_CODE_PATTERN` + ветка variant-детей без position_number в `linkPdfParentChildren` (+12 строк) |
| F5 | `ab1c141` | Baseline метрики `docs/benchmark-baseline.md` |
| F6 | `18670af` | Implementation log, STATUS.md, ретроспектива, PRB-008 → resolved |
| — | `f4ee933` | **Правка GigaChat-промпта**: раздел «СТРОКИ БЕЗ НОМЕРА ПОЗИЦИИ», само-проверка считает ВСЕ строки, а не только с номерами позиций |

**Деплой:** GitHub Actions `.github/workflows/deploy.yml` (push → SSH → `git reset --hard origin/main` → `docker compose up -d --build`). Деплой #88 — success, health OK.

**Сервер:** `5.42.103.63:3001`, контейнер `budget-automation-app-1`, репо `/root/budget-automation`.

---

## 2. Что пошло не так в проде

1. **Кеш GigaChat**: `parseSpecFromPdf` кеширует результат по SHA256 файла (таблица `gigachat_file_cache`, purpose='spec_pdf'). После первого деплоя (F4) кеш вернул старый результат без variant-детей. Кеш сброшен (`DELETE ... WHERE purpose='spec_pdf'` → 1 запись удалена).

2. **Промпт GigaChat отбрасывал безномерные строки**: само-проверка «Посчитай строки с номерами позиций... числа должны совпадать» заставляла модель исключать variant-детей без position. Исправлено в коммите `f4ee933`.

3. **Ошибка загрузки в проде**: пользователь получил `Cannot read "гига чат.jpg" (this model does not support image input)` — похоже, загружался JPEG вместо PDF, или GigaChat-модель не поддерживает image input при `isScan = true` (PDF с <200 символов текста считается сканом).

---

## 3. Нерешённые проблемы

### 🔴 Критичное (требует проверки в проде)
- **PRB-008 в проде НЕ верифицирован.** Нужно: сбросить кеш → загрузить радиаторный PDF → убедиться что variant-дети (C11-300-500 и т.д.) видны как отдельные позиции. Сейчас пользователь не смог завершить проверку.

### 🟡 Carry-tasks (зафиксированы в ходе 5-ходовых циклов)
- `excelParser.ts:linkDnChildren` — нет variant-ветки (нарушение parity Excel ↔ PDF)
- `DN_CHILD_PATTERN` слишком жадный — глотает "500-10" как DN-ребёнка
- `NaN` пролетает как валидный quantity в `mapPdfItemsToRows`
- variant после «То же» привяжется к «То же» а не к оригинальному родителю
- `isParameterizedChild` ловит "Воздуховод оцинкованный 200x200" как parameterized child

---

## 4. Зоны риска

1. **GigaChat-модель не принимает image input**: если PDF — скан (<200 символов текста), `isScan=true` и модель должна обрабатывать как изображение. Не все модели GigaChat это поддерживают. Проверить `GIGACHAT_MODELS_FILES` env.
2. **Кеш**: при любых изменениях промпта или `linkPdfParentChildren` нужно сбрасывать `gigachat_file_cache WHERE purpose='spec_pdf'`.
3. **Промпт GigaChat**: новый раздел «СТРОКИ БЕЗ НОМЕРА ПОЗИЦИИ» может изменить поведение модели на других типах PDF — нужен мониторинг.
4. **Parity Excel ↔ PDF**: Excel-ветка (`excelParser.ts`) не имеет variant-связывания — спецификации из Excel с variant-кодами не получат `full_name`.

---

## 5. Ключевые файлы для понимания

| Файл | Зачем |
|------|-------|
| `backend/src/services/gigachatSpecFromPdf.ts` | Промпт + `linkPdfParentChildren` + `mapPdfItemsToRows` |
| `backend/src/services/gigachatFileCache.ts` | Кеш GigaChat (SQLite, TTL 30 дней) |
| `backend/src/services/excelParser.ts:371-422` | `linkDnChildren` — Excel-аналог (без variant-ветки) |
| `backend/tests/fixtures/spec-pdf/` | 5 синтетических PDF + expected JSON |
| `scripts/test-spec-parent-child.mjs` | Регрессионный runner (5/5 PASS локально) |
| `docs/benchmark-baseline.md` | Пороги метрик |
| `docs/problem-registry.yaml` | PRB-008 → resolved |

---

## 6. Что делать следующему агенту

1. **SSH на сервер** (`ssh root@5.42.103.63`) и сбросить кеш:
   ```
   docker exec budget-automation-app-1 sh -c "node -e 'const db = require(\"/app/backend/node_modules/better-sqlite3\")(\"/app/database/budget_automation.db\"); db.prepare(\"DELETE FROM gigachat_file_cache WHERE purpose = ?\").run(\"spec_pdf\"); console.log(\"Deleted:\", this.changes);'"
   ```
2. **Убедиться что загружается PDF, не JPEG.** Загрузить радиаторный PDF через UI `http://5.42.103.63:3001`.
3. **Проверить результат**: variant-дети (C11-300-500, C21-500-800 и т.д.) должны быть отдельными позициями.
4. Если ошибка `does not support image input` повторяется — проблема в GigaChat-модели (не поддерживает image input при `isScan=true`). Проверить `GIGACHAT_MODELS_FILES` env на сервере.
5. После верификации — закрыть ручную проверку F6.
