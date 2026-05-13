# План: стабилизация прода и закрытие carry-tasks

**Дата:** 2026-05-13
**Владелец:** Алексей
**Статус:** активный (замена plan_stabilization_v2_2026-05-03.md, архивирован в archive/2026-05/)

## Связанные материалы
- [Бизнес-контекст](../../../.business/INDEX.md)
- [KPI](../../../.business/goals/kpi.md) — автоматическое сопоставление ≥70%, время расчёта 1–2 дня
- [Статус стабилизации](../STATUS.md)
- [Журнал реализации](../../IMPLEMENTATION_LOG.md)
- [Problem Registry](../../problem-registry.yaml)
- [Handoff PRB-008](../references/2026-05-13_pdf_spec_variant_children_handoff_status.md)
- [Ретроспектива PRB-008](../../../retrospectives/13.05.26_pdf-spec-variant-children.md)
- [Предыдущий план (архив)](../archive/2026-05/plan_stabilization_v2_2026-05-03.md)

## Контекст

Шаги 0–8.2 master-plan стабилизации завершены. LLM-matching (Gemini 87.5%), rule learning, PDF parent-child linking и variant-children fix (PRB-008) — всё задеплоено. CI/CD переведён на сборку на сервере (без GHCR-токенов).

Проблема: **проект не может быть запущен в продуктивную работу**, потому что:
1. PRB-008 не верифицирован на реальных данных в проде
2. Есть 5 carry-tasks — функциональные баги парсинга, влияющие на качество
3. Инфраструктурные риски (открытый порт без HTTPS, отсутствие `.dockerignore`)

---

## Шаг A — Верификация прода (P0, блокер)

**Цель:** убедиться, что задеплоенный код реально работает на живых данных.

### A.1. Сброс кеша GigaChat и проверка PRB-008
- SSH на сервер, сбросить `gigachat_file_cache WHERE purpose='spec_pdf'`
- Загрузить радиаторный PDF через UI
- Убедиться: variant-дети (C11-300-500, C21-500-800) видны как отдельные позиции
- Файл: `backend/src/services/gigachatFileCache.ts`

### A.2. Проверка ошибки "does not support image input"
- Проверить `GIGACHAT_MODELS_FILES` env на сервере
- Если PDF — скан (`isScan=true`), модель должна поддерживать image input
- Загрузить реальный PDF-скан и убедиться что ошибки нет
- Файл: `backend/src/services/gigachatSpecFromPdf.ts` (строки 220–226)

### A.3. Проверка retry uploadFile 429
- Загрузить 2–3 PDF подряд
- Проверить в логах контейнера: нет ли `uploadFile 429 — retry`
- Файл: `backend/src/services/gigachatService.ts` (строка 298)

**Acceptance Criteria:**
- [ ] Радиаторный PDF загружен, variant-дети видны
- [ ] PDF-скан загружается без ошибки "image input"
- [ ] Последовательная загрузка нескольких PDF не падает с 429

**Definition of Done:** все три проверки пройдены, скриншоты или логи как подтверждение.

---

## Шаг B — Carry-tasks: баги парсинга (P1)

**Цель:** закрыть функциональные баги, выявленные в ретроспективах 8.3 и PRB-008.

### B.1. variant-ветка в excelParser.ts (parity Excel ↔ PDF)
- Добавить `VARIANT_CODE_PATTERN` в `linkDnChildren` (`excelParser.ts:371-422`)
- Без этого Excel-спецификации с variant-кодами теряют позиции
- Файл: `backend/src/services/excelParser.ts`

### B.2. DN_CHILD_PATTERN слишком жадный
- Паттерн глотает "500-10" как DN-ребёнка (ложное срабатывание)
- Ужесточить regex, добавить тест-кейс
- Файл: `backend/src/services/gigachatSpecFromPdf.ts`

### B.3. NaN quantity в mapPdfItemsToRows
- Валидация: `NaN` не должен проходить как валидный quantity
- Заменять на `null` или `0` с пометкой `needs_review`
- Файл: `backend/src/services/gigachatSpecFromPdf.ts`, функция `mapPdfItemsToRows`

### B.4. variant после "То же" привязывается к "То же", не к оригиналу
- Проверить каскадное связывание: variant-child должен привязываться к корневому родителю
- Файл: `backend/src/services/gigachatSpecFromPdf.ts`, функция `linkPdfParentChildren`

### B.5. isParameterizedChild ложные срабатывания
- "Воздуховод оцинкованный 200x200" — не parameterized child
- Добавить negative-тест, ужесточить условие
- Файл: `backend/src/services/gigachatSpecFromPdf.ts`

**Acceptance Criteria:**
- [ ] `linkDnChildren` в Excel обрабатывает variant-коды
- [ ] DN_CHILD_PATTERN не ловит "500-10"
- [ ] NaN quantity отфильтровывается
- [ ] variant после "То же" → привязка к корневому родителю
- [ ] "Воздуховод 200x200" не считается parameterized child
- [ ] Регрессионный runner 5/5 PASS
- [ ] `npm run build` для backend и frontend

**Definition of Done:** все 5 багов закрыты, тесты зелёные, задеплоено на сервер.

---

## Шаг C — Инфраструктура (P2)

### C.1. HTTPS перед портом 3001
- Проверить наличие nginx/reverse proxy на сервере
- Если нет — настроить nginx + certbot (Let's Encrypt)
- Коммит `6fc7e2f` открыл порт наружу без шифрования

### C.2. Добавить .dockerignore
- Исключить: `node_modules/`, `*.md`, `docs/`, `retrospectives/`, `scripts/`, `*.pdf`, `.git/`
- Ускорит сборку Docker-образа на сервере

### C.3. deploy.yml — защита .env от перезаписи
- `git reset --hard` может потерять ручные изменения на сервере
- Добавить `git stash` перед reset или исключить `.env` из checkout

**Acceptance Criteria:**
- [ ] API доступен только через HTTPS
- [ ] Docker-сборка быстрее (< 60 сек на чистом кеше без скачивания node)
- [ ] `.env` не перезаписывается при деплое

**Definition of Done:** инфраструктура стабильна, безопасна, деплой не теряет конфиги.

---

## Шаг D — Технический долг (P3)

### D.1. PRB-002: дубли файлов в git-индексе
- Нормализовать разделители путей (Windows/Unix)
- `.gitattributes` для предотвращения повторения

### D.2. PRB-001: временные артефакты в .gitignore
- Добавить debug-логи, sqlite wal/shm, временные json в `.gitignore`
- Удалить из отслеживания через `git rm --cached`

**Acceptance Criteria:**
- [ ] `git ls-files` не содержит дублей путей
- [ ] Временные файлы не отслеживаются

**Definition of Done:** git-индекс чистый, .gitignore полный.

---

## Порядок выполнения

```
A (верификация прода) → B (carry-tasks) → C (инфраструктура) → D (техдолг)
      блокер                 качество          безопасность        чистота
```

Правило: следующий шаг начинается только после полного закрытия предыдущего + ретроспектива.
