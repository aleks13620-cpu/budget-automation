# Улучшение: парсинг PDF через файловое API GigaChat

## Суть

Текущий подход для PDF-счетов:
1. Извлекаем текст из PDF вручную через `pdf-parse`
2. Вставляем текст в `message.content` (ограничение ~8000 символов)
3. Отправляем в `/chat/completions`

**Проблема:** pdf-parse плохо читает PDF со сложной вёрсткой (таблицы, колонки, объединённые ячейки). Текст получается "разломанным" и GigaChat не может его правильно разобрать.

**Решение:** использовать официальный файловый API GigaChat — загрузить PDF как файл, передать его `id` в `attachments`. GigaChat сам читает файл нативно, без потери структуры.

---

## Как работает (по документации Сбера)

```
PDF файл
    ↓
POST /files  (загрузить файл, purpose="general")
    ↓
Получить file_id
    ↓
POST /chat/completions
  messages[].attachments = [file_id]
  function_call = "auto"
    ↓
GigaChat читает файл через get_file_content()
    ↓
JSON с позициями
```

---

## Поддерживаемые форматы

| Формат | MIME-тип |
|--------|----------|
| pdf    | application/pdf |
| doc    | application/msword |
| docx   | application/vnd.openxmlformats-officedocument.wordprocessingml.document |
| txt    | text/plain |

Excel (.xlsx/.xls) — **не поддерживается** через файловый API.

---

## Что нужно реализовать

### 1. Добавить метод `uploadFile()` в `gigachatService.ts`

```typescript
POST https://gigachat.devices.sberbank.ru/api/v1/files
Headers:
  Authorization: Bearer <token>
  Content-Type: multipart/form-data
Body:
  file: <binary>
  purpose: "general"

Ответ: { id: string, filename: string, bytes: number, ... }
```

### 2. Добавить метод `deleteFile()` в `gigachatService.ts`

```typescript
POST https://gigachat.devices.sberbank.ru/api/v1/files/{file_id}/delete
```
Вызывать после получения ответа — не засорять хранилище.

### 3. Обновить `parsePdfWithGigaChat()` в `gigachatParser.ts`

```typescript
// Вместо:
const text = await readPdfText(filePath);
const message = PROMPT + text;

// Сделать:
const fileId = await uploadFile(filePath, 'application/pdf');
try {
  const response = await chatCompletionWithAttachment(fileId, PROMPT);
  return parseResponse(response);
} finally {
  await deleteFile(fileId);
}
```

### 4. Обновить `chatCompletion()` в `gigachatService.ts`

Добавить поддержку `attachments` в объекте сообщения и параметра `function_call: "auto"`:

```typescript
interface GigaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: string[];  // добавить
}

interface GigaChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  functionCall?: 'auto' | 'none';  // добавить
}
```

---

## Затрагиваемые файлы

| Файл | Изменение |
|------|-----------|
| `backend/src/services/gigachatService.ts` | Добавить `uploadFile()`, `deleteFile()`, поддержку `attachments` и `function_call` |
| `backend/src/services/gigachatParser.ts` | Обновить `parsePdfWithGigaChat()` — использовать file upload вместо text extraction |
| `backend/src/routes/gigachat.ts` | Опционально: добавить тестовый эндпоинт |

**Не трогать:** `invoiceRouter.ts`, `invoiceValidator.ts`, `pdfParser.ts`

---

## Ожидаемый результат

- PDF со сложной вёрсткой (Элита 3351, Элита 3360) будут парситься корректно
- Убрать зависимость от `pdf-parse` для GigaChat-пути
- Итоговые суммы и ИНН будут извлекаться точнее

---

## Приоритет

Средний. Текущий fallback (через текст) уже работает для большинства PDF.
Этот апгрейд нужен для PDF с нечитаемой структурой текстового слоя.
