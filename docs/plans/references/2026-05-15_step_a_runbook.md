# Runbook: Step A — Production Verification

**Дата:** 2026-05-15
**Исполнитель:** Алексей (требуется SSH и доступ к прод-UI)
**Источник:** [plan_prod_readiness_2026-05-13.md](../active/plan_prod_readiness_2026-05-13.md) — Шаг A

## Когда выполнять
После коммита `6750abe` (micro-3B завершён). Step A блокирует все дальнейшие фазы оркестратора — пока прод не проверен, нельзя двигаться к B/C/D.

## Что нужно подготовить заранее
- SSH-ключ к серверу `5.42.103.63`
- Один **нативный** PDF (radiator или подобный с variant-children без position_number) — для A.1
- Один **PDF-скан** (изображение страниц) — для A.2
- Два-три любых PDF спецификации — для A.3 (sequential upload)
- Доступ к UI на проде (URL уточни в `.env` или у себя)

---

## A.1 — Сброс кеша GigaChat и проверка PRB-008

### Цель
Убедиться, что закоммиченный код **6750abe → 0aca7a6 → f424599 → 46839db → 3227752 → 3baa6ee** действительно отрабатывает на проде. PRB-008 — это variant-children без position_number (C11-300-500 и т.п.).

### Команды на сервере

```bash
# 1. Подключиться
ssh user@5.42.103.63   # подставь свой логин

# 2. Найти путь к prod-БД (проверь docker-compose / .env)
ls -la /path/to/budget_automation.db

# 3. Сбросить кеш парсинга PDF-спек (заставит парсер пройти заново на свежем коде)
sqlite3 /path/to/budget_automation.db "DELETE FROM gigachat_file_cache WHERE purpose='spec_pdf';"

# 4. Проверить что удалилось
sqlite3 /path/to/budget_automation.db "SELECT COUNT(*) FROM gigachat_file_cache WHERE purpose='spec_pdf';"
# Ожидаемо: 0

# 5. (Опционально) Перезапустить backend если он кеширует в памяти
docker compose restart backend   # или твоя команда рестарта
```

### Через UI

1. Открыть проект (новый или существующий)
2. Загрузить **radiator PDF** через раздел «Спецификация»
3. Подождать парсинга (10–30 сек обычно)
4. Открыть список позиций спецификации
5. **Найти variant-children:** должны быть видны `C11-300-500`, `C11-300-600`, …, `C21-500-400` — **как отдельные строки таблицы**
6. У каждой variant-строки в поле `full_name` должно быть склеено: «Стальной панельный радиатор Royal Thermo Compact … C11-300-500»

### Acceptance criteria
- [ ] **PASS:** ≥10 variant-positions видны в списке после загрузки radiator PDF
- [ ] **PASS:** `full_name` содержит родителя + variant-код
- [ ] **FAIL если:** только parent-row без variants (regression PRB-008)

### Если FAIL
Скопировать в чат:
- Список позиций спецификации (скриншот UI)
- Лог `docker compose logs backend | grep -i "parseSpecFromPdf"` за последние 5 мин
- Результат `sqlite3 ... "SELECT id, position_number, name, full_name FROM specification_items WHERE project_id=<id> LIMIT 30;"`

---

## A.2 — Проверка ошибки "does not support image input" (isScan flow)

### Цель
Убедиться, что GigaChat-модель, заданная в `GIGACHAT_MODELS_FILES`, **поддерживает image input** для PDF-сканов (когда текстовый слой <200 символов).

### Команды на сервере

```bash
# 1. Проверить какая модель указана
grep "GIGACHAT_MODELS_FILES" /path/to/.env
# Ожидаемо: GIGACHAT_MODELS_FILES=<имя модели>
# Например: GigaChat-Pro или GigaChat-Max

# 2. Проверить логи на наличие ошибки за последние сутки
docker compose logs backend --since 24h | grep -i "image input\|does not support"
# Ожидаемо: либо пусто, либо только старые ошибки до текущего деплоя
```

### Через UI

1. Загрузить **PDF-скан** (например, отсканированная бумажная спецификация — текстового слоя почти нет)
2. Парсер должен определить `isScan=true` и отправить страницы как изображения в GigaChat
3. Проверить что не возникает ошибки в UI и в логах

### Acceptance criteria
- [ ] **PASS:** PDF-скан парсится без ошибки, позиции извлечены (хотя бы частично)
- [ ] **PASS:** В логах нет нового `does not support image input`
- [ ] **FAIL если:** ошибка `does not support image input` в свежих логах

### Если FAIL
Изменить `GIGACHAT_MODELS_FILES` в `.env` на модель с image input (например `GigaChat-Pro` если ранее стояла Lite), перезапустить backend, повторить тест.

---

## A.3 — Проверка retry uploadFile на ошибке 429

### Цель
Убедиться что при `429 Too Many Requests` от GigaChat Files API код делает retry, а не падает.

### Команды

```bash
# 1. Очистить старые логи или зафиксировать timestamp
date -Iseconds
# скопировать вывод

# 2. После теста через UI — посмотреть логи
docker compose logs backend --since <timestamp> | grep -iE "uploadFile|429|retry"
```

### Через UI

1. Загрузить **2–3 PDF подряд** в течение 30 секунд (нативные, не сканы — чтобы быстрее)
2. Все должны успешно распарситься
3. В логах могут появиться сообщения `uploadFile: 429, retrying...` — это **нормально**, retry должен пройти

### Acceptance criteria
- [ ] **PASS:** все 2–3 PDF распарсились (видны позиции в UI)
- [ ] **PASS:** если в логах есть `429` — после него идёт успешный upload (а не error)
- [ ] **FAIL если:** какой-то из PDF в статусе error, в логах `uploadFile 429` без последующего успеха

### Если FAIL
Скопировать в чат полный фрагмент логов вокруг 429-ошибки.

---

## Когда всё PASS

Обновить `docs/plans/STATUS.md`:
- Шаг A → `[x]`
- Дата завершения
- Краткие заметки если были нюансы

Закоммитить:
```
docs(status): step A production verification complete

A.1 PASS: variant-children visible on radiator PDF (PRB-008 verified in prod)
A.2 PASS: PDF scan uploads without "image input" error
A.3 PASS: sequential PDF uploads handle 429 retry correctly

Next: Step B (carry-tasks parsing bugs B.1-B.5)
```

После этого можно переходить к **Шагу B** (carry-tasks по парсингу).

## Если что-то FAIL

Не запускать Шаг B пока Step A не закрыт. Приоритет — починить продакшн. Возвращайся с логами и скриншотами, разберём вместе.
