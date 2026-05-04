# Архитектурные исправления — от безопасных к рискованным

## Статус: В работе

## Контекст
Аудит выявил 10 архитектурных проблем. Работаем от безопасных к рискованным.
Корневая причина возвращающихся багов — две параллельные реализации парсинга
(проблема №8). К ней переходим только после стабилизации видимости ошибок (шаги 1–4).

---

## Фаза 1 — Логирование GigaChat вместо тихого проглатывания
- [x] Файл: backend/src/routes/matching.ts:1018-1020
- [x] Добавить структурный лог + счётчик skipped/failed в ответ API
- Выполнено: 2026-04-20 — добавлен структурный лог GigaChat-ошибок, счётчик skipped и поле skipped в API-ответ.

## Фаза 2 — Централизованный safeUnlink()
- [x] Создать helper safeUnlink() с логированием
- [x] Заменить fs.unlink(..., () => {}) в:
  - [x] backend/src/routes/invoices.ts:837
  - [x] backend/src/routes/specifications.ts:190
  - [x] backend/src/routes/priceLists.ts:131
  - [x] backend/src/index.ts:152
- Выполнено: 2026-04-20 — создан `safeUnlink()` и заменены 4 вызова `fs.unlink(..., () => {})` на безопасный helper с логированием ошибок.

## Фаза 3 — parseJsonSafe() wrapper
- [x] Создать wrapper parseJsonSafe() с fallback и логом
- [x] Заменить JSON.parse в:
  - [x] backend/src/routes/invoices.ts:808
  - [x] backend/src/routes/invoices.ts:1486
- Выполнено: 2026-04-20 — создан parseJsonSafe в fileUtils.ts, заменены два JSON.parse в invoices.ts:808 и :1486

## Фаза 4 — Общий helper для fixFilename и multer
- [ ] Создать backend/src/utils/uploadConfig.ts
- [ ] Перенести fixFilename и multer-конфигурацию из:
  - [ ] backend/src/routes/invoices.ts
  - [ ] backend/src/routes/specifications.ts
  - [ ] backend/src/routes/priceLists.ts

---

## Следующие фазы (не трогать до завершения 1–4)

## Фаза 5 — Единый jsonRepair.ts для GigaChat-парсеров
- [ ] Средний риск. Начинать только после завершения фаз 1–4.

## Фаза 6 — Разделение routes/matching.ts
- [ ] Средний риск.

## Фаза 7 — Разделение routes/specifications.ts
- [ ] Средний риск.

## Фаза 8 — Единый центр парсинга счетов ⚠️ КОРНЕВАЯ ПРИЧИНА
- [ ] Высокий риск. Оставить invoiceRouter.ts как единый источник истины.
- [ ] routes/invoices.ts превратить в тонкий адаптер.

## Фаза 9 — Рефакторинг routes/invoices.ts (god-file)
- [ ] Высокий риск.

## Фаза 10 — Frontend: вынести логику в hooks
- [ ] Высокий риск.

---

## Правило обновления
Любой агент, завершивший фазу, обязан:
1. Отметить чекбоксы [x]
2. Дописать строку: "Выполнено: [дата] — [что именно сделано]"
3. Проверить: не сломал ли что-то из следующих фаз
