# Компоненты системы

## Backend — маршруты (routes/)

| Файл | Ответственность |
|---|---|
| `projects.ts` | CRUD проектов, каскадное удаление |
| `specifications.ts` | Загрузка спецификаций, парсинг, GigaChat-обогащение, история |
| `invoices.ts` | Загрузка счетов, парсинг, переразбор, расчёт цен, история |
| `matching.ts` | Запуск алгоритма, подтверждения, итоги, экспорт правил |
| `suppliers.ts` | Список поставщиков, конфигурация парсера, ставка НДС |
| `export.ts` | Генерация итогового Excel |

## Backend — сервисы (services/)

| Файл | Ответственность |
|---|---|
| `matcher.ts` | 4-уровневый алгоритм совпадений |
| `pdfParser.ts` | Извлечение таблиц из PDF, сырые строки для предпросмотра |
| `excelParser.ts` | Парсинг Excel-спецификаций с иерархией |
| `excelInvoiceParser.ts` | Парсинг Excel-счетов с confidence scoring |
| `invoiceRouter.ts` | Выбор парсера (классика vs GigaChat), категоризация |
| `invoiceValidator.ts` | Валидация структуры распарсенного счёта |
| `gigachatService.ts` | Аутентификация GigaChat, HTTP-вызовы API |
| `gigachatParser.ts` | Парсинг документов через GigaChat (fallback) |
| `gigachatFileCache.ts` | Кэш ответов по SHA256-хэшу файла |
| `gigachatParseQuality.ts` | Оценка качества результата GigaChat |
| `gigachatSpecFromPdf.ts` | Парсинг PDF-спецификаций через GigaChat |
| `gigachatSpecParser.ts` | Обогащение спецификации через GigaChat |
| `gigachatSpecParseQuality.ts` | Оценка качества обогащения |
| `sectionDetector.ts` | Определение раздела (8 разделов) по ключевым словам |
| `constructionSynonymLearner.ts` | Накопление аббревиатур из подтверждённых совпадений |

## Frontend — страницы (pages/)

| Компонент | Что показывает |
|---|---|
| `ProjectList` | Список проектов, создание, редактирование, удаление |
| `ProjectDetail` | Состав проекта, загрузка файлов, итоги по разделам |
| `InvoicePreview` | Сырые таблицы счёта, настройка маппинга колонок |
| `MatchingView` | Результаты совпадений, подтверждения, статистика |
| `SpecificationEditor` | Позиции спецификации, GigaChat-обогащение, история |
| `UnitTriggers` | Управление правилами конвертации единиц измерения |
| `FeedbackPage` | Ошибки оператора по конкретному проекту |
| `GlobalFeedbackPage` | Все ошибки по всем проектам, экспорт |

## Frontend — переиспользуемые компоненты (components/)

| Компонент | Назначение |
|---|---|
| `ColumnMapper` | Визуальный маппинг колонок Excel-счёта |
| `SpecColumnMapper` | Маппинг колонок Excel-спецификации |
| `MatchTable` | Таблица совпадений с кнопками подтверждения |
| `ManualMatchModal` | Модальное окно ручного создания совпадения |
| `ManualMatchFromSpec` | Поиск и выбор позиции спецификации для ручного совпадения |
