import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';
import { classifySpecPositions } from '../services/specClassifier';

const router = Router();

// Очередь заданий на поиск цен в интернете (вариант A). Прод сам НЕ ищет: кнопка кладёт
// задание в price_search_jobs, воркер с рабочей машины (там ключ Yandex Search и «домашний»
// IP) забирает его через /jobs/next и возвращает найденные цены в /jobs/:id/result.

type Job = {
  id: number;
  project_id: number;
  status: string;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  rows_written: number | null;
  message: string | null;
};

// Поля UPSERT'а external_prices — ровно те же и в том же порядке, что в
// price-harvester/src/db.py (константа UPSERT). Расхождение имён = молча потерянная колонка.
const PRICE_FIELDS = [
  'business_key', 'project_id', 'spec_item_id', 'query_name', 'source', 'source_url',
  'snapshot_date', 'supplier_name', 'manufacturer', 'article', 'name', 'unit', 'price',
  'currency', 'vat_included', 'vat_rate', 'min_batch', 'lead_time_days', 'in_stock',
  'match_score', 'status', 'raw_data', 'created_at', 'updated_at',
] as const;

// Один в один UPSERT из price-harvester/src/db.py, на именованных параметрах better-sqlite3.
const UPSERT_EXTERNAL_PRICE = `
INSERT INTO external_prices
  (business_key, project_id, spec_item_id, query_name, source, source_url, snapshot_date,
   supplier_name, manufacturer, article, name, unit, price, currency, vat_included, vat_rate,
   min_batch, lead_time_days, in_stock, match_score, status, raw_data, created_at, updated_at)
VALUES
  (:business_key, :project_id, :spec_item_id, :query_name, :source, :source_url, :snapshot_date,
   :supplier_name, :manufacturer, :article, :name, :unit, :price, :currency, :vat_included, :vat_rate,
   :min_batch, :lead_time_days, :in_stock, :match_score, :status, :raw_data, :created_at, :updated_at)
ON CONFLICT(business_key) DO UPDATE SET
   project_id=excluded.project_id, spec_item_id=excluded.spec_item_id, query_name=excluded.query_name,
   source_url=excluded.source_url, supplier_name=excluded.supplier_name, manufacturer=excluded.manufacturer,
   article=excluded.article, name=excluded.name, unit=excluded.unit, price=excluded.price,
   currency=excluded.currency, vat_included=excluded.vat_included, vat_rate=excluded.vat_rate,
   min_batch=excluded.min_batch, lead_time_days=excluded.lead_time_days, in_stock=excluded.in_stock,
   match_score=excluded.match_score, status=excluded.status, raw_data=excluded.raw_data,
   updated_at=excluded.updated_at
`;

// better-sqlite3 роняет запрос на undefined, boolean и объекте — приводим к тому, что sqlite
// умеет хранить. Отсутствующее поле = NULL (в схеме почти все колонки nullable), NOT NULL
// колонки при этом честно упадут констрейнтом, а не запишутся мусором.
function toBindable(value: unknown, now: string, field: string): string | number | null {
  if (value === undefined || value === null) {
    return field === 'created_at' || field === 'updated_at' ? now : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return JSON.stringify(value); // raw_data может приехать объектом
}

function nowIso(): string {
  return new Date().toISOString();
}

// Ф12. Цена с сайта — вариант в сопоставлении. Находка поиска оформляется как позиция
// прайс-листа «Сайт <продавец>» (price_lists.file_path = WEB_PRICE_LIST) и строка matched_items
// с match_type = WEB_MATCH_TYPE. Схема не меняется: CHECK в matched_items пускает только
// счёт или прайс, а выгрузка уже умеет цену и продавца выбранного прайса.
// Позиция держится своей позиции через price_list_items.row_index = external_prices.id:
// позицию спецификации берём из external_prices, а не из похожести имени, и матчер такие
// прайсы не видит (services/matcher.ts), а пересопоставление их не удаляет (routes/matching.ts).
export const WEB_PRICE_LIST = 'web_search';
export const WEB_MATCH_TYPE = 'web_search';

// На позицию один вариант — самое дешёвое найденное в последнем срезе, ровно то, что выгрузка
// подставляет «Интернетом». Идемпотентно: ключ — id строки external_prices, повтор прогона того
// же дня обновляет ту же строку UPSERT'ом и не плодит вариантов.
// Правила: вариант, который Иван выбрал, не удаляется, даже если свежий срез его не содержит;
// вариант, который Иван отклонил (прайс-позиция есть, matched_items нет), не воскрешается.
// ponytail: один вариант на позицию; «лучшее со своего сайта + лучшее из интернета» — после Ф11.
export function syncSiteVariants(db: ReturnType<typeof getDatabase>, projectId: number): void {
  db.transaction(() => {
    const wanted = db.prepare(`
      WITH ext_last AS (
        SELECT ep.spec_item_id, MAX(ep.snapshot_date) AS last_date
        FROM external_prices ep
        JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
        WHERE ep.source = 'web_search' AND ep.project_id = ?
        GROUP BY ep.spec_item_id
      ),
      ranked AS (
        SELECT ep.id, ep.spec_item_id, ep.supplier_name, ep.source_url, ep.name, ep.article,
               ep.unit, ep.price,
               ROW_NUMBER() OVER (PARTITION BY ep.spec_item_id ORDER BY ep.price ASC, ep.id ASC) AS rn
        FROM external_prices ep
        JOIN ext_last el ON el.spec_item_id = ep.spec_item_id AND ep.snapshot_date = el.last_date
        WHERE ep.source = 'web_search' AND ep.project_id = ? AND ep.status = 'found'
          AND ep.price IS NOT NULL
      )
      SELECT * FROM ranked WHERE rn = 1
    `).all(projectId, projectId) as Array<{
      id: number; spec_item_id: number; supplier_name: string | null; source_url: string;
      name: string; article: string | null; unit: string | null; price: number;
    }>;
    const wantedById = new Map(wanted.map(w => [w.id, w]));

    const existing = db.prepare(`
      SELECT pli.id AS pli_id, pli.row_index AS ep_id, pli.name, pli.article, pli.unit, pli.price,
             m.id AS m_id, m.is_selected, m.is_confirmed
      FROM price_list_items pli
      JOIN price_lists pl ON pl.id = pli.price_list_id
      LEFT JOIN matched_items m ON m.price_list_item_id = pli.id AND m.source = 'price_list'
      WHERE pl.project_id = ? AND pl.file_path = ?
    `).all(projectId, WEB_PRICE_LIST) as Array<{
      pli_id: number; ep_id: number; name: string; article: string | null; unit: string | null;
      price: number | null; m_id: number | null; is_selected: number | null; is_confirmed: number | null;
    }>;

    const updateItem = db.prepare('UPDATE price_list_items SET name = ?, article = ?, unit = ?, price = ? WHERE id = ?');
    const deleteMatch = db.prepare('DELETE FROM matched_items WHERE price_list_item_id = ?');
    const deleteItem = db.prepare('DELETE FROM price_list_items WHERE id = ?');
    const seen = new Set<number>();
    for (const e of existing) {
      const w = wantedById.get(e.ep_id);
      if (w) {
        seen.add(e.ep_id);
        if (w.name !== e.name || w.article !== e.article || w.unit !== e.unit || w.price !== e.price) {
          updateItem.run(w.name, w.article, w.unit, w.price, e.pli_id);
        }
      } else if (!e.is_selected && !e.is_confirmed) {
        deleteMatch.run(e.pli_id);
        deleteItem.run(e.pli_id);
      }
    }

    const findSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');
    const insertSupplier = db.prepare('INSERT OR IGNORE INTO suppliers (name) VALUES (?)');
    const findList = db.prepare('SELECT id FROM price_lists WHERE project_id = ? AND file_path = ? AND supplier_id = ?');
    const insertList = db.prepare(
      `INSERT INTO price_lists (project_id, supplier_id, file_name, file_path, status) VALUES (?, ?, ?, ?, 'web_search')`
    );
    const insertItem = db.prepare(
      'INSERT INTO price_list_items (price_list_id, article, name, unit, price, row_index) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertMatch = db.prepare(`
      INSERT INTO matched_items (specification_item_id, price_list_item_id, confidence, match_type,
                                 match_reason, is_confirmed, is_selected, source)
      VALUES (?, ?, 1.0, ?, 'Цена с сайта', 0, 0, 'price_list')
    `);
    for (const w of wanted) {
      if (seen.has(w.id)) continue;
      let seller = (w.supplier_name || '').trim();
      if (!seller) { try { seller = new URL(w.source_url).hostname; } catch { seller = 'сайт без названия'; } }
      insertSupplier.run(seller);
      const supplierId = (findSupplier.get(seller) as { id: number }).id;
      const list = findList.get(projectId, WEB_PRICE_LIST, supplierId) as { id: number } | undefined;
      const listId = list?.id
        ?? Number(insertList.run(projectId, supplierId, `Сайт ${seller}`, WEB_PRICE_LIST).lastInsertRowid);
      const itemId = Number(insertItem.run(listId, w.article, w.name, w.unit, w.price, w.id).lastInsertRowid);
      insertMatch.run(w.spec_item_id, itemId, WEB_MATCH_TYPE);
    }

    db.prepare(`
      DELETE FROM price_lists WHERE project_id = ? AND file_path = ?
        AND NOT EXISTS (SELECT 1 FROM price_list_items WHERE price_list_id = price_lists.id)
    `).run(projectId, WEB_PRICE_LIST);
  })();
}

// Задание, зависшее в running: рабочая машина выключилась посреди прогона, сообщить о сбое
// уже некому. Без отпуска кнопка у Ивана заблокирована навсегда — а он как раз и должен
// уметь перезапустить сам. Прогон на 175 позиций идёт ~40 минут, поэтому два часа без
// завершения = машина не ответила. Зовётся и из статуса: пока задание висит, кнопка серая,
// и POST, который снял бы её, отправить нечем.
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

function releaseStaleRunning(
  db: ReturnType<typeof getDatabase>,
  job: { id: number; status: string; started_at: string | null } | undefined,
): boolean {
  if (!job || job.status !== 'running') return false;
  const startedAt = job.started_at ? Date.parse(job.started_at) : NaN;
  if (Number.isNaN(startedAt) || Date.now() - startedAt <= STALE_RUNNING_MS) return false;
  db.prepare(
    `UPDATE price_search_jobs SET status = 'error', finished_at = ?, message = ? WHERE id = ?`
  ).run(nowIso(), 'Прогон не завершился: рабочая машина не ответила больше двух часов', job.id);
  return true;
}

// 0. GET /api/projects/:id/spec-groups — из чего состоит спецификация и что уже нашли.
// Правило деления на группы перенесено из price-harvester/research/klassifikator_pozicij.py
// в services/specClassifier.ts и сверено 1:1 на 7039 позициях (тест test_spec_classifier.ts).
// Показываем то же, по чему реально идёт поиск, иначе экран будет обещать одно, а искать другое.
router.get('/api/projects/:id/spec-groups', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const positions = classifySpecPositions({ projectId }, db);
    const groups: Record<string, number> = {};
    for (const p of positions) groups[p.group] = (groups[p.group] ?? 0) + 1;
    const searchable = positions.filter(p => p.group.startsWith('C')).length;

    // Ф12: подпись слоя 1 = число позиций, у которых в сопоставлении есть вариант-сайт. Он же
    // виден в таблице рядом с ценой счёта, поэтому экран и таблица говорят одно (закрывает Ф1.1).
    // Варианты досоздаются здесь лениво: цены, найденные до Ф12, иначе в таблице не появятся.
    // Дата прогона — по ВСЕМ статусам и только по живым позициям (JOIN на specification_items):
    // прогон, где ничего не нашлось, иначе выглядел бы как «поиск ещё не запускался».
    syncSiteVariants(db, projectId);
    const priced = db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT m.specification_item_id)
           FROM matched_items m
           JOIN specification_items si ON si.id = m.specification_item_id
          WHERE si.project_id = ? AND m.match_type = ?) AS n,
        (SELECT MAX(ep.snapshot_date)
           FROM external_prices ep
           JOIN specification_items si ON si.id = ep.spec_item_id AND si.project_id = ep.project_id
          WHERE ep.source = 'web_search' AND ep.project_id = ?) AS run_date
    `).get(projectId, WEB_MATCH_TYPE, projectId) as { n: number; run_date: string | null };

    res.json({
      total: positions.length,
      groups,
      layer1: { searchable, withPrice: priced?.n ?? 0, lastRunDate: priced?.run_date ?? null },
    });
  } catch (error) {
    console.error('GET /api/projects/:id/spec-groups error:', error);
    res.status(500).json({ error: 'Ошибка при разборе спецификации на группы' });
  }
});

// 1. POST /api/projects/:id/price-search — кнопка «Найти цены в интернете»
router.post('/api/projects/:id/price-search', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Проект не найден' });
    }

    const active = db.prepare(
      `SELECT id, status, started_at FROM price_search_jobs
       WHERE project_id = ? AND status IN ('queued', 'running')
       ORDER BY id DESC LIMIT 1`
    ).get(projectId) as { id: number; status: string; started_at: string | null } | undefined;

    if (active && releaseStaleRunning(db, active)) active.status = 'stale';

    if (active && active.status !== 'stale') {
      return res.status(409).json({
        error: 'Поиск цен по этому проекту уже идёт',
        jobId: active.id,
        status: active.status,
      });
    }

    const { items } = db.prepare(
      'SELECT COUNT(*) as items FROM specification_items WHERE project_id = ?'
    ).get(projectId) as { items: number };
    if (items === 0) {
      return res.status(400).json({ error: 'В проекте нет позиций спецификации' });
    }

    const result = db.prepare(
      `INSERT INTO price_search_jobs (project_id, status, requested_at)
       VALUES (?, 'queued', ?)`
    ).run(projectId, nowIso());

    res.json({ jobId: Number(result.lastInsertRowid), status: 'queued', items });
  } catch (error) {
    console.error('POST /api/projects/:id/price-search error:', error);
    res.status(500).json({ error: 'Ошибка при постановке задания на поиск цен' });
  }
});

// 2. GET /api/projects/:id/price-search/status — опрос из браузера
router.get('/api/projects/:id/price-search/status', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(String(req.params.id), 10);
    const db = getDatabase();

    const job = db.prepare(
      'SELECT * FROM price_search_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(projectId) as Job | undefined;
    if (!job) {
      return res.json({ status: 'idle' });
    }
    if (releaseStaleRunning(db, job)) {
      job.status = 'error';
      job.message = 'Прогон не завершился: рабочая машина не ответила больше двух часов';
      job.finished_at = nowIso();
    }

    res.json({
      jobId: job.id,
      status: job.status,
      requestedAt: job.requested_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      rowsWritten: job.rows_written,
      message: job.message,
    });
  } catch (error) {
    console.error('GET /api/projects/:id/price-search/status error:', error);
    res.status(500).json({ error: 'Ошибка при получении статуса поиска цен' });
  }
});

// 3. GET /api/price-search/jobs/next — воркер забирает работу.
// Захват атомарный (IMMEDIATE-транзакция берёт запись сразу): иначе два воркера успевают
// прочитать одну и ту же 'queued' и прогнать её дважды.
// Захват — POST, хотя по смыслу это «дай работу»: запрос МЕНЯЕТ состояние (переводит
// задание в running), а GET не попадает под общий mutation-лимитер и его может дёрнуть
// любой обходчик ссылок — тогда задание Ивана уедет в никуда.
router.post('/api/price-search/jobs/next', (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    const claim = db.transaction((): Job | null => {
      const job = db.prepare(
        `SELECT * FROM price_search_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1`
      ).get() as Job | undefined;
      if (!job) return null;

      db.prepare(
        `UPDATE price_search_jobs SET status = 'running', started_at = ? WHERE id = ?`
      ).run(nowIso(), job.id);
      return job;
    }).immediate;

    const job = claim();
    if (!job) {
      return res.json({ job: null });
    }

    // SELECT * намеренно: воркеру нужны id, project_id, parent_item_id, full_name, name,
    // product_code, manufacturer, unit, quantity, characteristics — список полей здесь
    // молча отстанет от схемы.
    const items = db.prepare('SELECT * FROM specification_items WHERE project_id = ?')
      .all(job.project_id);

    res.json({ job: { id: job.id, projectId: job.project_id }, items });
  } catch (error) {
    console.error('POST /api/price-search/jobs/next error:', error);
    res.status(500).json({ error: 'Ошибка при выдаче задания на поиск цен' });
  }
});

// 4. POST /api/price-search/jobs/:id/result — воркер отдаёт результат
router.post('/api/price-search/jobs/:id/result', (req: Request, res: Response) => {
  try {
    const jobId = parseInt(String(req.params.id), 10);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows as Record<string, unknown>[] : null;
    if (!rows) {
      return res.status(400).json({ error: 'Тело запроса должно содержать массив rows' });
    }

    const db = getDatabase();
    const now = nowIso();

    const apply = db.transaction(() => {
      const job = db.prepare('SELECT * FROM price_search_jobs WHERE id = ?').get(jobId) as Job | undefined;
      if (!job) return { code: 409 as const, body: { error: 'Задание не найдено' } };
      // Принимаем и у задания, которое статус успел пометить как error по двухчасовому
      // таймеру: воркер мог всё это время честно искать и добраться до отправки. Выбросить
      // готовые цены и оставить человеку «машина не ответила» — худший из исходов.
      // Чужие позиции всё равно отобьёт предохранитель ниже.
      if (job.status !== 'running' && job.status !== 'error') {
        return { code: 409 as const, body: { error: `Задание в статусе ${job.status}, результат не принимается` } };
      }

      // Предохранитель, ГРОМКИЙ: spec_item_id сквозной по всей базе, и цены по чужому id
      // молча встанут в чужую спецификацию — заказчик увидит их как свои и не узнает, что
      // это не его позиции. Поэтому — ни одной строки, job в error, 400 с виноватыми id.
      const belongs = db.prepare(
        'SELECT 1 FROM specification_items WHERE id = ? AND project_id = ?'
      );
      const badIds: unknown[] = [];
      for (const row of rows) {
        const specItemId = row.spec_item_id;
        if (typeof specItemId !== 'number' || !belongs.get(specItemId, job.project_id)) {
          if (!badIds.includes(specItemId)) badIds.push(specItemId);
        }
      }
      if (badIds.length > 0) {
        const message = `Отклонено: ${badIds.length} позиц. не принадлежат проекту ${job.project_id} `
          + `(например ${badIds.slice(0, 5).join(', ')}). Ничего не записано.`;
        db.prepare(
          `UPDATE price_search_jobs SET status = 'error', finished_at = ?, message = ? WHERE id = ?`
        ).run(now, message.slice(0, 500), job.id);
        return { code: 400 as const, body: { error: message, badIds: badIds.slice(0, 5) } };
      }

      const upsert = db.prepare(UPSERT_EXTERNAL_PRICE);
      for (const row of rows) {
        const params: Record<string, string | number | null> = {};
        for (const field of PRICE_FIELDS) params[field] = toBindable(row[field], now, field);
        upsert.run(params);
      }
      syncSiteVariants(db, job.project_id);

      // Сводка для Ивана — в ПОЗИЦИЯХ, а не в строках. Строк всегда больше: на одну позицию
      // приходится несколько предложений, плюс строки «не искали» и «продавец не отдал цену».
      // Показать «записано 408» там, где цена нашлась у 45 позиций, — ввести человека в
      // заблуждение; в проекте без артикулов это вообще «408» при нуле цен.
      const positions = new Set<unknown>();
      const withPrice = new Set<unknown>();
      const byStatus = new Map<string, number>();
      for (const row of rows) {
        positions.add(row.spec_item_id);
        if (row.status === 'found') withPrice.add(row.spec_item_id);
        const key = typeof row.status === 'string' ? row.status : 'unknown';
        byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
      }
      const breakdown = [...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
      const message = `цены нашлись по ${withPrice.size} позициям из ${positions.size} (${breakdown})`;

      db.prepare(
        `UPDATE price_search_jobs SET status = 'done', finished_at = ?, rows_written = ?, message = ?
         WHERE id = ?`
      ).run(now, rows.length, message.slice(0, 500), job.id);

      return { code: 200 as const, body: { status: 'done', rowsWritten: rows.length } };
    }).immediate;

    const { code, body } = apply();
    res.status(code).json(body);
  } catch (error) {
    console.error('POST /api/price-search/jobs/:id/result error:', error);
    res.status(500).json({ error: 'Ошибка при записи результата поиска цен' });
  }
});

// 5. POST /api/price-search/jobs/:id/error — воркер сообщает о падении
router.post('/api/price-search/jobs/:id/error', (req: Request, res: Response) => {
  try {
    const jobId = parseInt(String(req.params.id), 10);
    const message = String(req.body?.message ?? 'Поиск завершился ошибкой').slice(0, 500);

    const db = getDatabase();
    const job = db.prepare('SELECT id, status FROM price_search_jobs WHERE id = ?')
      .get(jobId) as { id: number; status: string } | undefined;
    if (!job) {
      return res.status(404).json({ error: 'Задание не найдено' });
    }

    // Только running. Два случая, когда затирать нельзя: (1) сервер уже отбил чужие
    // spec_item_id и записал понятное «Отклонено: …» — воркер получил 400 и прислал бы
    // сюда сухое «HTTP Error 400», потеряв смысл; (2) результат принят, а связь оборвалась
    // на чтении ответа — задание done, цены на месте, и превращать его в «ошибку» — врать.
    const changed = db.prepare(
      `UPDATE price_search_jobs SET status = 'error', finished_at = ?, message = ?
       WHERE id = ? AND status = 'running'`
    ).run(nowIso(), message, jobId).changes;

    res.json({ status: changed ? 'error' : job.status });
  } catch (error) {
    console.error('POST /api/price-search/jobs/:id/error error:', error);
    res.status(500).json({ error: 'Ошибка при фиксации сбоя поиска цен' });
  }
});

export default router;
