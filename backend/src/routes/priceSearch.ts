import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';

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
