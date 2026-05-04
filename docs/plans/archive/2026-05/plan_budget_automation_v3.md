# План развития Budget Automation v3.0

**Назначение:** единый документ для реализации в репозитории `budget-automation`. Дублирует план Cursor: `.cursor/plans/budget_automation_improvement_plan_b67c30fb.plan.md` (если есть локально).

---

## Правила реализации

- **Каждая фаза <= 4 часа** включая тестирование
- **GigaChat специфика:** использовать паттерны из существующего [backend/src/services/gigachatParser.ts](backend/src/services/gigachatParser.ts) — модель `GigaChat-2`, `temperature: 0.1`, Files API для PDF, `sanitizeJSON` для ремонта JSON, retry 2 попытки
- **Обратная совместимость:** Excel (.xlsx/.xls) для спецификаций остаётся рабочим форматом. PDF — дополнение, не замена
- **Cursor:** режим Auto для экономии токенов. Opus вручную только при сложных архитектурных задачах (Фазы 2.2, 3.1)
- **После каждой фазы:** тест на реальных данных, отметка о прохождении, **git commit** (см. ниже)
- **Деплой:** один раз **после завершения всего плана** (после Фазы 5 и финального e2e-теста), не после каждой фазы

### Git и деплой

- В конце **каждой** фазы: `git add` только изменений этой фазы, осмысленное сообщение коммита (шаблоны указаны в фазах).
- Между фазами **не** деплоить в прод/стенд (если не согласовано отдельно).
- После **Фазы 5:** полный прогон регрессии, затем деплой по вашему процессу (Docker / CI из [.github/workflows](.github/workflows)).

### Файл плана для другого чата / агента

- **В репозитории:** этот файл — `docs/plans/active/plan_budget_automation_v3.md`
- **В Cursor (внутренний план):** `.cursor/plans/budget_automation_improvement_plan_b67c30fb.plan.md`

---

## ФАЗА 1: Quick Wins — точечные улучшения парсинга
**Оценка: 3-4 часа | Риск: нулевой | Cursor: Auto**

### Задачи

1. **Увеличить лимит входного текста для GigaChat**
   - Файл: [backend/src/services/gigachatParser.ts](backend/src/services/gigachatParser.ts), строки 451 и 553
   - Изменение: `docText.slice(0, 20000)` -> `docText.slice(0, 40000)`
   - Добавить константу `const MAX_TEXT_LENGTH = 40000` в начало файла

2. **Авто-закрытие скобок в sanitizeJSON**
   - Файл: [backend/src/services/gigachatParser.ts](backend/src/services/gigachatParser.ts), функция `sanitizeJSON` (строка 261)
   - После строки 304 (`result = result.replace(...)`) добавить балансировку незакрытых `{`, `[`, `}`

3. **Keep-alive для GigaChat HTTP-клиента**
   - Файл: [backend/src/services/gigachatService.ts](backend/src/services/gigachatService.ts), строка 28
   - Изменение: `new https.Agent({ rejectUnauthorized: false })` -> `new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 5 })`

### Тест

- Загрузить счёт с >30 позициями — убедиться что все позиции извлечены
- Загрузить 3 счёта подряд — убедиться что время второго/третьего меньше (keep-alive)

### Git коммит (конец фазы)

- Сообщение: `feat(parser): phase 1 — GigaChat text limit, JSON brace fix, keep-alive`

### Чекпоинт

- [ ] Фаза 1 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 2.1: Снижение порога матчинга + активация spec_parse_rules
**Оценка: 3-4 часа | Риск: низкий | Cursor: Auto**

### Задачи

1. **Снизить порог применения learned rules с 0.8 до 0.65**
   - Файл: [backend/src/services/matcher.ts](backend/src/services/matcher.ts), строки 199-200
   - Изменение: `specMatch >= 0.8 && invMatch >= 0.8` -> `specMatch >= 0.65 && invMatch >= 0.65`
   - Одновременно: при match 0.65-0.79 снижать итоговый confidence на 0.1 (чтобы "мягкие" матчи не выглядели уверенными)
   - Аналогично для negative rules (строка 189): порог 0.8 -> 0.65

2. **Активировать чтение spec_parse_rules**
   - Файл: [backend/src/services/gigachatSpecParser.ts](backend/src/services/gigachatSpecParser.ts)
   - Добавить: при enrich загружать существующие `spec_parse_rules` и передавать в промпт как контекст ("уже известные исправления")
   - Таблица `spec_parse_rules` уже существует в [backend/src/database/schema.ts](backend/src/database/schema.ts), данные пишутся в [backend/src/routes/specifications.ts](backend/src/routes/specifications.ts) строки 587-617

### Тест

- Запустить матчинг на существующем проекте, сравнить количество автоматических матчей до/после
- Убедиться что не появились ложные матчи (проверить 5-10 новых пар вручную)

### Git коммит (конец фазы)

- Сообщение: `feat(matching): phase 2.1 — rule threshold 0.65, spec_parse_rules in enrich`

### Чекпоинт

- [ ] Фаза 2.1 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 2.2: PDF-спецификации — бэкенд (парсер + промпт)
**Оценка: 3-4 часа | Риск: средний | Cursor: Auto/Opus для промпта**

### Задачи

1. **Создать промпт SPECIFICATION_PROMPT для извлечения спецификации из чертежа**
   - Новый файл: `backend/src/services/gigachatSpecFromPdf.ts`
   - Промпт строить по образцу `INVOICE_PROMPT` из [backend/src/services/gigachatParser.ts](backend/src/services/gigachatParser.ts) (строки 20-175) — тот же формат, те же правила JSON, та же секция self-check
   - Ключевое отличие: искать таблицу "Спецификация оборудования" / "Ведомость материалов" / "Экспликация"
   - Выходной JSON: `{ section, items: [{ position, name, characteristics, unit, quantity }] }`

2. **Реализовать функцию `parseSpecFromPdf(filePath)`**
   - Использовать существующие функции из [backend/src/services/gigachatService.ts](backend/src/services/gigachatService.ts): `uploadFile`, `chatCompletion`, `deleteFile`
   - Паттерн: точная копия `parsePdfViaFileApi` из [backend/src/services/gigachatParser.ts](backend/src/services/gigachatParser.ts) строка 415-501
   - Модель: `GigaChat-2`, `temperature: 0.1`, `maxTokens: 32768`
   - Retry: 2 попытки (как в счетах)
   - JSON repair: использовать существующие `extractJSON` + `sanitizeJSON`

3. **Добавить PDF в fileFilter спецификаций (бэкенд)**
   - Файл: [backend/src/routes/specifications.ts](backend/src/routes/specifications.ts), строки 29-40
   - Добавить `.pdf` в допустимые расширения
   - В обработчике `POST /api/projects/:id/specifications`: если расширение `.pdf` — вызвать `parseSpecFromPdf`, иначе — существующий Excel-парсер

### Тест

- Загрузить векторный PDF-чертёж (текст копируется) — проверить извлечение таблицы спецификации
- Загрузить Excel-файл — убедиться что старый путь работает без изменений

### Git коммит (конец фазы)

- Сообщение: `feat(specs): phase 2.2 — PDF spec parse via GigaChat (backend)`

### Чекпоинт

- [ ] Фаза 2.2 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 2.3: PDF-спецификации — фронтенд + предпросмотр
**Оценка: 3-4 часа | Риск: низкий | Cursor: Auto**

### Задачи

1. **Добавить PDF в accept на фронтенде**
   - Файл: [frontend/src/pages/ProjectDetail.tsx](frontend/src/pages/ProjectDetail.tsx)
   - Массовая загрузка спецификаций: `accept=".xlsx,.xls"` -> `accept=".xlsx,.xls,.pdf"`
   - По-разделная загрузка: аналогично
   - Обновить текст подсказки: "Excel (.xlsx/.xls) или PDF-чертежи"

2. **Добавить PDF в bulk upload спецификаций (бэкенд)**
   - Файл: [backend/src/routes/specifications.ts](backend/src/routes/specifications.ts), endpoint `POST /api/projects/:id/specifications/bulk`
   - Обработка PDF-файлов в цикле bulk: определять расширение, для PDF вызывать `parseSpecFromPdf`

3. **Индикация источника в UI**
   - В таблице спецификаций показывать иконку/метку: "Excel" или "PDF (GigaChat)"
   - Добавить поле `parse_source` в таблицу `specifications` (значения: `excel`, `pdf_gigachat`)

### Тест

- Массовая загрузка: 2 Excel + 1 PDF — все три должны обработаться
- Предпросмотр извлечённых из PDF позиций в SpecificationEditor

### Git коммит (конец фазы)

- Сообщение: `feat(specs): phase 2.3 — PDF spec upload UI, parse_source, bulk PDF`

### Чекпоинт

- [ ] Фаза 2.3 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 2.4: PDF-спецификации — сканы + fallback
**Оценка: 3-4 часа | Риск: средний | Cursor: Auto**

### Задачи

1. **Различать векторные PDF и сканы**
   - В `parseSpecFromPdf`: после загрузки PDF проверить длину текста через `pdf-parse`
   - Если `text.length > 200` — векторный, отправить текст + File API
   - Если `text.length <= 200` — скан, отправить только через File API с дополнительным указанием: "Это скан документа, внимательно разбери изображение"

2. **Fallback при пустом результате**
   - Если GigaChat вернул 0 позиций из PDF — сохранить файл, вернуть `category: 'C'` с сообщением "Не удалось извлечь спецификацию из PDF, загрузите Excel"
   - Не блокировать загрузку — позволить оператору вручную ввести данные через SpecificationEditor

3. **Quality check для PDF-спецификаций**
   - Аналог `gigachatParseQuality.ts`: проверить что position нумерация последовательная, нет пропусков, name не пустые

### Тест

- Загрузить скан PDF-чертежа (текст не копируется)
- Загрузить "пустой" PDF (без таблицы спецификации) — должен вернуть category C

### Git коммит (конец фазы)

- Сообщение: `feat(specs): phase 2.4 — PDF scans, fallback, quality check`

### Чекпоинт

- [ ] Фаза 2.4 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 3.1: Словарь строительных сокращений — создание + интеграция
**Оценка: 3-4 часа | Риск: низкий | Cursor: Opus для генерации словаря**

### Задачи

1. **Создать таблицу `construction_synonyms` в БД**
   - Файл: [backend/src/database/schema.ts](backend/src/database/schema.ts) и [backend/src/database/init.ts](backend/src/database/init.ts)
   - Структура: `id, abbreviation, full_form, category (ОВ/ВК/ЭО/общее), source (seed/learned), times_used, created_at`
   - Это расширение существующей таблицы `size_synonyms` (используется в [backend/src/services/matcher.ts](backend/src/services/matcher.ts) функция `getSynonymMap`)

2. **Наполнить базовый словарь (~80 терминов)**
   - Категории: трубы (ПЭ, ПП, ВГП, ПВХ), арматура (КШ, КЗ, КО), оборудование (НС, КНС, ИТП), единицы, общие сокращения
   - Формат: seed-данные в migration/init
   - Примеры: ПЭ->полиэтилен, ВГП->водогазопроводная, КШ->кран шаровой, ДУ->DN, НС->насосная станция

3. **Интегрировать в normalizeForMatching**
   - Файл: [backend/src/services/matcher.ts](backend/src/services/matcher.ts), функция `normalizeSizeTerms` (строка 72)
   - Расширить: загружать как `size_synonyms`, так и `construction_synonyms`
   - Применять замену перед Dice coefficient

### Тест

- Матчинг: "труба ПЭ 100 SDR11" vs "труба полиэтиленовая SDR 11" — должны совпасть
- Матчинг: "Кран ш/з Ду25" vs "Кран шаровой DN25" — должны совпасть

### Git коммит (конец фазы)

- Сообщение: `feat(matching): phase 3.1 — construction_synonyms table + matcher integration`

### Чекпоинт

- [ ] Фаза 3.1 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 3.2: Автоматическое пополнение словаря из матчинга
**Оценка: 3-4 часа | Риск: низкий | Cursor: Auto**

### Задачи

1. **Извлечение сокращений при подтверждении матча**
   - Файл: [backend/src/routes/matching.ts](backend/src/routes/matching.ts), endpoint `PUT /api/matching/:id/confirm` (строки 340-393)
   - После создания matching_rule: сравнить нормализованные наименования, найти расхождения
   - Если в одном тексте "ПЭ", а в другом "полиэтилен" — добавить пару в `construction_synonyms` с `source='learned'`

2. **Алгоритм извлечения пар**
   - Токенизировать оба наименования
   - Для каждого токена из spec, которого нет в invoice: проверить есть ли в invoice токен, начинающийся с тех же букв (ПЭ ↔ полиэтилен: П...Э... → полиэтилен)
   - Консервативный подход: добавлять только при confidence матча >= 0.85

3. **Auto-learn supplier mapping после GigaChat**
   - Файл: [backend/src/routes/invoices.ts](backend/src/routes/invoices.ts), после успешного GigaChat fallback (~строка 380)
   - Если GigaChat вернул >= 3 позиции и supplierId известен — auto-save в `supplier_parser_configs`

### Тест

- Подтвердить матч "КШ Ду50" ↔ "Кран шаровой DN50" — проверить что в `construction_synonyms` появилась запись КШ->кран шаровой
- Загрузить счёт нового поставщика через GigaChat, затем второй счёт — проверить что используется сохранённый маппинг

### Git коммит (конец фазы)

- Сообщение: `feat(matching): phase 3.2 — learned synonyms from confirms, auto supplier mapping`

### Чекпоинт

- [ ] Фаза 3.2 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 4.1: Ускорение обработки
**Оценка: 3-4 часа | Риск: средний | Cursor: Auto**

### Задачи

1. **Параллельный bulk upload**
   - Файл: [backend/src/routes/invoices.ts](backend/src/routes/invoices.ts), endpoint `POST /api/projects/:id/invoices/bulk` (строки 524-540)
   - Заменить последовательный `for` на `Promise.allSettled` с concurrency=3
   - SQLite: убедиться что включен WAL mode (`PRAGMA journal_mode=WAL` в [backend/src/database/connection.ts](backend/src/database/connection.ts))

2. **Различение сканов от текстовых PDF в счетах**
   - Файл: [backend/src/services/gigachatParser.ts](backend/src/services/gigachatParser.ts), функция `parsePdfViaFileApi` (строки 443-469)
   - Если `readPdfText` возвращает < 200 символов — это скан, не делать бесполезный text fallback
   - Для сканов: повторный Files API с акцентом "это скан"

3. **Кеш hash файла для GigaChat ответов**
   - Новая таблица `gigachat_file_cache`: `file_hash, response_json, created_at`
   - Перед вызовом GigaChat: вычислить SHA256 файла, проверить кеш
   - Если есть — вернуть кешированный результат (мгновенно)

### Тест

- Bulk upload 5 счетов — время должно быть ~2x быстрее (параллельно)
- Загрузить тот же файл повторно — должен вернуть результат мгновенно (кеш)

### Git коммит (конец фазы)

- Сообщение: `perf: phase 4.1 — parallel bulk invoices, scan-aware invoice PDF, GigaChat file cache`

### Чекпоинт

- [ ] Фаза 4.1 выполнена и протестирована
- [ ] Коммит сделан

---

## ФАЗА 5: Финальная интеграция + документация
**Оценка: 2-3 часа | Риск: нулевой | Cursor: Auto**

### Задачи

1. **Обновить РУКОВОДСТВО_ПОЛЬЗОВАТЕЛЯ.md**
   - Добавить раздел "Загрузка спецификаций из PDF-чертежей"
   - Описать два варианта: Excel и PDF, когда какой использовать
   - Описать автодополнение словаря

2. **Обновить РУКОВОДСТВО_ПОЛЬЗОВАТЕЛЯ_ОБУЧЕНИЕ.md**
   - Добавить информацию об автоматическом обучении словаря
   - Обновить таблицу "Ожидаемые результаты"

3. **End-to-end тест полного цикла**
   - Загрузить PDF-чертёж как спецификацию
   - Загрузить 3 счёта (Excel + PDF)
   - Запустить матчинг
   - Подтвердить 5 матчей
   - Запустить матчинг повторно — проверить что правила применились
   - Проверить что словарь пополнился

### Git коммит (конец фазы)

- Сообщение: `docs: phase 5 — user guides + e2e verification (Budget Automation v3)`

### Чекпоинт

- [ ] Фаза 5 выполнена и протестирована
- [ ] Все предыдущие чекпоинты пройдены
- [ ] Коммит сделан
- [ ] **Деплой** выполнен (после финального теста, по вашему пайплайну)
- [ ] ПЛАН ЗАВЕРШЕН

---

## Сводная таблица

| Фаза | Название | Часы | Что получаем |
|------|----------|------|--------------|
| 1 | Quick Wins (текст, JSON, keep-alive) | 3-4 | Устранение обрезки позиций, -1-2 сек на запрос |
| 2.1 | Порог матчинга + spec_parse_rules | 3-4 | +10-15% автоматических матчей |
| 2.2 | PDF-спецификации: бэкенд | 3-4 | Парсер чертежей через GigaChat |
| 2.3 | PDF-спецификации: фронтенд | 3-4 | UI для загрузки PDF + предпросмотр |
| 2.4 | PDF-спецификации: сканы + fallback | 3-4 | Поддержка сканов, graceful degradation |
| 3.1 | Словарь сокращений: создание | 3-4 | 80 строительных терминов в матчинге |
| 3.2 | Словарь: автопополнение из матчинга | 3-4 | Самообучающийся словарь |
| 4.1 | Ускорение обработки | 3-4 | x2-3 быстрее bulk, кеш файлов |
| 5 | Интеграция + документация | 2-3 | Полный цикл протестирован |
| **ИТОГО** | | **~30 часов** | |

## Рекомендации по Cursor

- **Фазы 1, 2.1, 2.3, 3.2, 4.1, 5:** режим Auto (точечные правки, не нужен Opus)
- **Фазы 2.2, 3.1:** стоит использовать Opus вручную (написание промпта для GigaChat, генерация словаря — задачи, где нужно глубокое понимание предметной области)
- **Фаза 2.4:** Auto достаточно (логика ветвления, не сложная архитектура)
- **Автоматический режим Cursor** — оптимальный выбор для 7 из 9 фаз
