# Handoff: после деплоя 8 коммитов — 2026-05-16

## Состояние

**Прод:** HEAD = `a7e3aae`, бэк работает, GigaChat health отвечает 6 моделями (все доступны).

**Локально main = прод main.** Рабочее дерево чисто (только untracked dev-артефакты пользователя).

## Что задеплоили (8 коммитов от `0aca7a6` до `a7e3aae`)

| Коммит | Что |
|---|---|
| `a7e3aae` | fix: specNameAsCode prefix-only + supplier_id guard для negative rules |
| `1bb7269` | fix(B.4): «То же» siblings к корню, без каскада |
| `ee860e6` | fix: имена GigaChat моделей (без `-2-` префикса в default) |
| `c704a90` | fix: multi-signal continuation (qty + unit + manufacturer == null) |
| `ad510e6` | docs: handoff continuation bug |
| `a537932` | docs: step A runbook |
| `6cfab4e` | docs: 04-research (6 файлов: analogs, methodologies, what-to-steal/avoid, delta) |
| `6750abe` | perf+learn: early exit + LLM-rejected negative rules |
| `0aca7a6` | feat: parent-child continuation merging + two-pass matching |

## Где в плане

Активный план: `docs/plans/active/plan_prod_readiness_2026-05-13.md`

| Шаг | Статус |
|---|---|
| A.1 (PRB-008) | ✅ verified локально на 3/4 PDF + a7e3aae в проде |
| A.2 (isScan) | ⏳ требует PDF-скан + UI на проде |
| A.3 (retry 429) | ⏳ требует 3 sequential uploads через UI |
| B (5 carry-tasks) | ✅ все 5 закрыты (B.1-B.5) |
| C (HTTPS, .dockerignore, deploy safety) | ❌ не начат |
| D (PRB-001, PRB-002 техдолг) | ❌ не начат |

## Открытые вопросы — приоритет на следующую сессию

### 1. A.2 + A.3 на проде (нужны руки пользователя)

- **A.2:** загрузить PDF-скан через UI, проверить лог на `image input` ошибки
- **A.3:** 3 PDF подряд (5-ПР_21, ОВ-30.135, 26 25-ТД-ОВ), проверить лог на 429-retry

Runbook: `docs/plans/references/2026-05-15_step_a_runbook.md`

### 2. Опт. env на проде — cheap-first для GigaChat

Сейчас на проде `GIGACHAT_MODELS_FILES=GigaChat-Max,GigaChat-Pro,GigaChat-2-Max,GigaChat-2-Pro,GigaChat-2,GigaChat` — **Max первым**, тратит дорогие токены без причины.

**Фикс:**
```bash
ssh root@5.42.103.63
nano /root/budget-automation/.env
# заменить на: GIGACHAT_MODELS_FILES=GigaChat,GigaChat-Pro,GigaChat-Max
docker compose restart app
```

### 3. Carry-task: `confirm-analog` supplier_id симметрия

Найдено `/pre-deploy-check` ревью. `routes/matching.ts:917+` (POST /api/matching/:id/confirm-analog) создаёт **положительные** правила. Не проверено, что есть guard для `supplier_id == null` — симметрично нашему Fix 2. Менее опасно чем negative (positive только бустит confidence, не блокирует), но global positive rule на MVP может загрязнить precision. Адресовать после первого пилота.

### 4. PDF 230-43.3 — не таблица (детектор not-a-spec)

251-страничный текстовый том. Парсер возвращает 0 позиций тихо. Нужен warning в `parse_quality.warnings` если `totalRows == 0 && pages >= N`. Не блокер, отложено.

### 5. Том 6 — GigaChat fallback работает (80K токенов), но извлёк 14 поз

Может быть мало или норм — не знаем без сверки с PDF. Возможно prompt-tuning. Не блокер, после пилота.

### 6. Step C — HTTPS перед демо

Открытый порт `3001` без шифрования. **Критично перед демо клиенту.** Nginx + certbot. Это P2 в плане, но если идёт первый show клиенту — поднимать в приоритет.

## /pre-deploy-check skill

Создан Агентом A в этой сессии. Файлы:
- `.claude/skills/pre-deploy-check/SKILL.md` (локально, `.claude/` в gitignore)
- `AGENTS.md` — Step 0 в Deploy Checklist
- `docs/plans/references/5-hod-cycle-instructions.md` — ссылка
- `MEMORY.md` — пункт в Workflow & Git

**Команда:** `/pre-deploy-check` перед `git push origin main`. Возвращает PASS/FIX/SKIP. FIX → исправить → перепрогнать.

## Метрики (для KPI baseline)

- **Парсинг PDF:** 98% (pdfplumber) + GigaChat fallback (Том 6: 80K токенов, 14 поз)
- **Матчинг:** 23.8% conf≥0.6 на проекте 28 (синтетика, без real operator review)
- **Время матчинга:** 84-180s на 736×218 пар (вариация)
- **Continuation merging:** 0 подозрительных родителей на 3 реальных PDF после фиксов

## NOT BLOCKED, but recommended

- **GigaChat баланс:** пополнен 16.05 (Lite пакет)
- **Real-data measurement:** загрузить 1 свежий проект через UI на проде и замерить conf≥0.6 — единственный способ увидеть реальный эффект всех фиксов на матчинг

## Команды быстрого старта новой сессии

```bash
cd C:\Users\home\vscode101\budget-automation
git log --oneline -3                                                 # подтвердить HEAD = a7e3aae
cat docs/plans/STATUS.md                                              # статус плана
cat docs/plans/references/2026-05-16_handoff_post_deploy.md           # этот документ
cat docs/plans/references/2026-05-15_step_a_runbook.md                # для A.2/A.3
```
