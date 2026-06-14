# Бриф воркеру — Поток Б1.1: залить 27 high-confidence пар Эталон→Память (пр.12)
**Дата:** 2026-06-13 · **Заказчик:** оркестратор-контролёр «Арта» · **Исполнитель:** новый рабочий чат Claude Code · **Ветка прода:** `origin/main = c00c3a2` LIVE

> Этот файл — **самодостаточный** промпт. Скопируй его в новый чат в `C:\Users\home\vscode101\budget-automation`. Все ссылки — относительно репозитория.

---

## 0. Твоя роль и правила
- Ты **воркер** для одного хода Потока Б1 (см. [PLAN_track_A_B_metric_gated_2026-06-11.md](PLAN_track_A_B_metric_gated_2026-06-11.md)). Архистратор ведёт по метрике, ты — выполняешь и докладываешь дельтой ДО→ПОСЛЕ.
- **МУТАЦИЯ ПРОДА БЕЗ ЯВНОГО «ОК» ВЛАДЕЛЬЦА — ЗАПРЕЩЕНА.** На шаге 5 ты ОСТАНАВЛИВАЕШЬСЯ и ждёшь «ок» перед POST. Это не вежливость — это правило процесса (см. `feedback_no_action_without_confirmation`).
- Прочитай перед стартом: `MEMORY.md` (индекс), `reflection_2026-06-12_discount_deployed_potok0_parked_learning_next.md`, `PLAN_track_A_B_metric_gated_2026-06-11.md`, [learning_engine_proof_2026-06-11.md](learning_engine_proof_2026-06-11.md) (прогон-источник), `feedback_no_corrupt_through`, `feedback_evidence_before_claims`.
- PowerShell для прод-проб (bash рвёт кириллицу). ASCII в коммитах. Именованные файлы в `git add`.

## 1. Цель и гейт
**Цель:** перевести Поток Б1 из «доказан на TEMP-БД» в «работает на проде» — залить **27 high-confidence пар** из Эталона владельца в прод-Память (`matching_rules` + автоматические синонимы), запустить полный rematch пр.12, замерить дельту.

**Гейт (PASS = всё ДА):**
1. Доля памяти пр.12 выросла: `learned_rule@1` ≥ +20 (с 1 до ≥21; прогноз = ~28).
2. Тривайр цел: пр.6 `learned_rule@1` = 47 ± 2, пр.11 = 117 ± 2.
3. Регрессий нет: confirmed-матчи пр.6/11/12 — не уменьшились.
4. Скидка Form D на счёте 894066 — цена 9605 цела (тривайр Потока А).
5. `pre-deploy-check` 5-ходов PASS (если правил код), иначе пропустить.

**FAIL → СТОП**, откатить (см. §8 Откат), писать рефлексию.

## 2. Источник пар (готов офлайн)
- Скрипт: [backend/scripts/extract-ethalon-pairs.ts](backend/scripts/extract-ethalon-pairs.ts) — уже прогнан 06-11; вывод в [learning_engine_proof_2026-06-11.md](learning_engine_proof_2026-06-11.md).
- Эталон: `C:\Users\home\Downloads\01_05-07-24-ОВ эталон жк бкк арта.xlsx`.
- TEMP-БД (от прошлого прогона): `backend/scripts/learning_engine_proof_tmp.db`.
- **27 high-confidence пар** = 7 AYVAZ (explicit col P name) + 4 НЗВЗ (price+name tiebreak) + 16 OBM (explicit model code). Состав в proof'е §VERDICT/п.5.
- **17 derived пар (price-proximity) НЕ ЛЬЁМ** — доказано в proof'е: содержат ложные links (PEX-труба 174 ₽ → шаровой кран 198.9 ₽ по совпадению цены). См. `feedback_no_corrupt_through` — отравлять Память нельзя.
- 13 SANEXT-пар не разрешились (счёт SANEXT в прод не загружен) — выходят за рамки этого брифа.

## 3. Эндпоинт заливки (изучи перед использованием)
[backend/src/routes/matching.ts:1825](backend/src/routes/matching.ts:1825) — `POST /api/projects/:id/import-matches`.
- **Принимает multipart/form-data**, поле `file` = XLSX (не JSON).
- **Колонки XLSX** (детект по ключевым словам в header — case/space-tolerant):
  - «Наименование спецификации» (обяз.)
  - «Наименование в счёте» (обяз.; допускается несколько столбцов с этим именем)
  - «Поставщик» (опц.; если есть — fuzzy join к `suppliers` ≥0.75; для нас опц. — оставим NULL → глобальное правило)
- **Что делает:**
  - upsert в `matching_rules` (`confidence=0.95`, `source='import'`).
  - вызов `learnConstructionSynonymsFromConfirmedMatch` на каждой паре → автоматически растит `construction_synonyms`.
  - **Auto-rematch:** запускает `runMatchingBackground(projectId, 'full')` на УКАЗАННОМ проекте, если лок свободен. Это **пересчитает все матчи пр.12** — будь готов, что non-confirmed предложения обновятся (confirmed — не трогаются).
- **Глобальность правил:** `supplier_id=NULL` → правила сработают на ЛЮБОМ проекте, где встретится похожее имя. Это и есть кросс-проект-перенос. AYVAZ/OBM/НЗВЗ — специфика пр.12 ЖК у БКК ОВ; в пр.6/11 их быть не должно → тривайр НЕ должен дрогнуть. Но **проверка тривайра обязательна** после деплоя.

## 4. Шаги (последовательно)

### Шаг 1 — Baseline read-only (PowerShell + UTF-8)
Собери и сохрани в `docs/plans/active/b1_baseline_2026-06-13.md`:
- git: `git rev-parse origin/main` (должен совпасть с c00c3a2 на момент начала; если другое — стоп, не лей на смещённую базу).
- Прод-числа (через PowerShell `Invoke-RestMethod`):
  - пр.12: spec total, learned_rule@1 (top-1 по confidence), confirmed-spec-count
  - пр.6: learned_rule@1, confirmed
  - пр.11: learned_rule@1, confirmed
- Скидка пр.12, счёт 894066: цена `9605` (GET `/api/invoices/66`/items или эквивалент) — записать.
- Размер Памяти: `matching_rules` total + `construction_synonyms` source='learned' total — если эндпоинт-обзор есть; иначе skip.

### Шаг 2 — Сгенерировать ровно 27 пар
Доработай скрипт [backend/scripts/extract-ethalon-pairs.ts](backend/scripts/extract-ethalon-pairs.ts) (или сделай отдельный `export-high-conf-xlsx.ts` рядом — твой выбор), чтобы он:
- При флаге `--emit-prod-xlsx` записывал XLSX (`backend/scripts/b1_high_conf_27_2026-06-13.xlsx`) с двумя колонками: «Наименование спецификации» (исходное имя позиции из эталона) и «Наименование в счёте» (резолвленное имя из counter-invoice). **Без нормализации** — `import-matches` нормализует сам.
- Использовал ТОЛЬКО пары с `confidence === 'high'` (фильтр по полю `ExtractedPair.confidence`).
- Печатал список 27 пар в stdout и сохранял JSON-копию рядом (`b1_high_conf_27_2026-06-13.json`) — для аудита.
- **Не печатал derived и не включал их в XLSX.** Проверь — если их там окажется ≠ 27 пар, СТОП и доложи: возможно состав изменился (новый эталон, прод-данные сместились).

Запуск: `cd backend; npx tsx scripts/extract-ethalon-pairs.ts --emit-prod-xlsx`.

### Шаг 3 — Dry-run отчёт (ОБЯЗАТЕЛЕН перед POST)
Запиши `docs/plans/active/b1_dryrun_2026-06-13.md`:
- Перечисли 27 пар (spec → invoice) с категорией (AYVAZ/НЗВЗ/OBM).
- Прогноз: пр.12 learned_rule@1 1 → ≥21 (целевой прогноз 28; диапазон 21–34 c учётом Dice-диффузии).
- Риск: глобальный supplier_id=NULL → если в пр.6/11 окажется случайное похожее имя — может отъесть тривайр. **Запланированный тест:** dice-similarity нормализованных spec_pattern против всех spec-items пр.6/11 — для каждой пары посмотри топ-1 score; если ≥0.65 на пр.6/11 — выпиши, может потребовать `supplier_id` (тогда залить пары с supplier_id, не NULL).
- Команда POST (curl-эквивалент в PowerShell): подготовь, но НЕ выполняй.

### Шаг 4 — ⛔ СТОП. Запроси «ок» владельца
Доложи владельцу одним сообщением:
- 1 строка: «Б1.1 готов к заливке. 27 пар, прогноз: Доля памяти пр.12 0.2% → ~5.4% (+5.2pp). Тривайр-риск: …. Ок на POST?»
- Покажи путь к `b1_dryrun_2026-06-13.md` + `b1_high_conf_27_2026-06-13.xlsx`.
- **НЕ POST'ай без явного «ок».** Если «нет» / «подожди» — стоп, опиши в чате.

### Шаг 5 — POST + дождаться rematch
После «ок»:
- POST `/api/projects/12/import-matches` с XLSX. PowerShell:
  ```powershell
  $form = @{ file = Get-Item 'backend/scripts/b1_high_conf_27_2026-06-13.xlsx' }
  Invoke-RestMethod -Uri 'http://5.42.103.63:3001/api/projects/12/import-matches' -Method Post -Form $form -TimeoutSec 600
  ```
- Поллить `/api/projects/12/matching/status` пока `status = idle`. Не race'ить — дай auto-rematch завершиться (full на 518 spec items может занять несколько минут).
- Сохрани JSON-ответ в `docs/plans/active/b1_post_response_2026-06-13.json`.

### Шаг 6 — After-snapshot + дельта
Замер ровно как §Шаг 1, сохрани в `docs/plans/active/b1_after_2026-06-13.md`:
- пр.12 learned_rule@1 ДО=1 → ПОСЛЕ=N
- пр.6 ДО=47 → ПОСЛЕ=? (Δ должен быть 0±2)
- пр.11 ДО=117 → ПОСЛЕ=? (Δ должен быть 0±2)
- confirmed пр.6/11/12 — без уменьшений
- Скидка 894066 цена = 9605 (не дрогнула)

### Шаг 7 — Отчёт
`docs/plans/active/b1_landed_2026-06-13.md` — короткий вердикт PASS/FAIL по §1, таблица ДО→ПОСЛЕ, ссылки на артефакты, рекомендация следующего шага.

## 5. Артефакты на выходе (пути зафиксированы)
- `backend/scripts/b1_high_conf_27_2026-06-13.xlsx` — payload
- `backend/scripts/b1_high_conf_27_2026-06-13.json` — аудит-копия
- `docs/plans/active/b1_baseline_2026-06-13.md` — ДО
- `docs/plans/active/b1_dryrun_2026-06-13.md` — план + риск-тест (ДО POST)
- `docs/plans/active/b1_post_response_2026-06-13.json` — ответ сервера
- `docs/plans/active/b1_after_2026-06-13.md` — ПОСЛЕ
- `docs/plans/active/b1_landed_2026-06-13.md` — вердикт + дельта (ПОСЛЕ всего)

## 6. Что НЕ делать
- Не лей 44 пары (derived отравят — proof'ом доказано).
- Не лей с `is_analog=1` — это другой контракт, путать нельзя.
- Не делай `/reparse` — рушит matched_items каскадом (`reflection_2026-06-10_partB_recon_resplit_proj11`).
- Не правь матчер/нормализацию — это не задача брифа.
- Не подключай SANEXT-счёт — это отдельный ход (нужен ресурс владельца).
- Не push на main без `pre-deploy-check` PASS, если правил код. Если только данные (xlsx) — push не нужен, прод сам обновится после POST.

## 7. Если что-то не так
- POST вернул 4xx — не ретраить вслепую, читай тело ответа, доложи владельцу.
- `auto-rematch = skipped_busy` — это значит на пр.12 уже шёл матчинг; подожди idle, потом POST `/api/projects/12/matching/run` руками.
- Тривайр пр.6 или пр.11 дрогнул — СТОП, не пиши отчёт PASS. Открой инцидент: правила слишком общие; вариант — перезалить с `supplier_id`.
- Доля памяти пр.12 не выросла или выросла <20 — ищи причину в `match_reason` новых матчей (`/api/projects/12/matching` → `items[].matches[].matchReason`).

## 8. Откат (если PASS не достигнут)
Правила-import лежат с `source='import'`. Откат — точечное удаление по `source='import' AND created_at > '<начало шага 5>'`:
```sql
-- ЧЕРНОВИК, выполнить ТОЛЬКО с «ок» владельца:
DELETE FROM matching_rules WHERE source = 'import' AND created_at > '2026-06-13 HH:MM:SS';
DELETE FROM construction_synonyms WHERE source = 'learned' AND created_at > '2026-06-13 HH:MM:SS';
```
SSH на прод нет → откат через эндпоинт админ-удаления или прямой доступ к sqlite на сервере. Если оператор не дотягивается — это **гейт на план Б1.2: построить эндпоинт «откат-импорт»**. Пока что — НЕ ЛИТЬ, если не уверен в составе пар.

## 9. Принятые решения архистратора (для прозрачности)
- **Только 27 high-conf** — derived доказанно засоряют (proof'а §INTERPRETATION/п.2 + `feedback_no_corrupt_through`).
- **NULL supplier_id** — глобальные правила нужны для кросс-проект-переноса (главная гипотеза Потока Б). Контр-риск гасим тривайром.
- **Полный rematch пр.12 (auto)** — приемлем: confirmed не трогается, non-confirmed обновятся в лучшую сторону.
- **Метрика-гейт +20 матчей**, а не +27 — оставлен запас на пары, которые после нормализации могут схлопнуться в один pattern.

---

**Конец брифа.** Подтверди роль, прочитай §0, запусти Шаг 1.
