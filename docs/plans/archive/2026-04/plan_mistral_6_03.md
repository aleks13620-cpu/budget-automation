# PLAN: Mistral Vision Invoice Parser
**Дата:** 06.03.2026

---

## Контекст

Текущий pdf-parse v2 ломается на водяных знаках (ANTARUS -> "S S S U U U") и таблицах без границ.
Решение: изолированный тестовый модуль на базе Mistral Vision API. `backend/src/` — не трогать.

**Платформа:** Windows 11 — нет `pdftoppm`. Используем `pdfjs-dist` + `canvas` (pure Node.js).

---

## Этап 1 — Окружение и структура (~1–2ч) ✅ ВЫПОЛНЕНО

- [x] `npm install pdfjs-dist canvas` в `backend/`
- [x] Создать `backend/experimental/`, `test-invoices/`, `results/`
- [x] Добавить `MISTRAL_API_KEY=` в `backend/.env`

---

## Этап 2 — Модуль парсинга (~2–3ч) ✅ ВЫПОЛНЕНО

- [x] Создать `backend/experimental/mistral-vision-parser.js`
  - `pdfPageToPng(pdfPath, pageNum)` — PDF -> PNG Buffer (pdfjs-dist + canvas, без temp-файлов)
  - `parseWithMistral(imageBuffer, apiKey)` — base64 PNG -> Mistral API -> JSON
  - `parsePdfInvoice(pdfPath, apiKey)` — оркестратор
  - Экспорт: `{ parsePdfInvoice, pdfPageToPng, parseWithMistral }`

Проверка пройдена: `node -e "require('./mistral-vision-parser')"` — OK

---

## Этап 3 — Тест-раннер и первый запуск (~1–2ч) — В ПРОЦЕССЕ

- [x] Создать `backend/experimental/test-runner.js`
- [x] Проверка без PDF: "Найдено 0 PDF" — OK
- [ ] Запустить на 2–3 проблемных PDF (ANTARUS и др.) — **нужны PDF от Алексея**
- [ ] Проверить качество: номер документа, позиции, итого
- [ ] Результаты в `results/test_<timestamp>.json`

**Как запустить:**
```bash
cd backend/experimental
# Положить тестовые PDF в test-invoices/
# Задать API ключ в backend/.env: MISTRAL_API_KEY=ключ_от_алексея
node test-runner.js
```

---

## Этап 4 — Продакшен-интеграция (~3–4ч)

> **Только после согласования с Алексеем (Этап 3 успешен)**

- [ ] `backend/services/mistralVisionParser.js` — продакшен-версия
- [ ] `MISTRAL_API_KEY` в `index.ts`
- [ ] Роут `POST /api/invoices/parse-vision` (A/B тест)
- [ ] Feature flag: ключ есть -> Mistral, нет -> старый pdf-parse

---

## Ограничения

- `backend/src/` — **не трогать**
- Новый модуль — **не импортировать** в существующий код
- `backend/experimental/` — полностью изолирован
