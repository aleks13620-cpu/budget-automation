# -*- coding: utf-8 -*-
"""Переносчик заданий поиска цен: прод -> рабочая машина -> прод (вариант A).

На проде кнопка кладёт задание в price_search_jobs. Здесь, на рабочей машине,
лежит ключ Yandex Search и «домашний» IP, поэтому сам поиск идёт тут:
берём задание по HTTP, складываем позиции во ВРЕМЕННУЮ sqlite, гоняем по ней
УЖЕ СУЩЕСТВУЮЩИЕ скрипты (research/zamer_sloj_marka.py -> research/zapis_v_sistemu.py)
подпроцессами, забираем из временной базы строки external_prices и отдаём на прод.

Логику скриптов не трогаем — она проверена на реальных данных. Им подсовывается
только окружение: SPEC_ID=1 и BUDGET_DB_PATH=<временная база>.

Env: BUDGET_API_URL (например http://<прод>:3001/api) — обязательно;
      BUDGET_API_SECRET — только если на проде задан API_SECRET.

Режимы:
  python worker.py            — цикл, опрос раз в 60 секунд
  python worker.py once       — один проход и выход
  python worker.py selfcheck  — assert-проверки без сети и без ключей
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))          # .../price-harvester
RESEARCH = os.path.join(ROOT, "research")
POLL_SECONDS = 60
STDERR_TAIL = 500

# Ровно поля UPSERT из src/db.py — их и ждёт прод в теле результата (без id: у прода
# своя автонумерация, идемпотентность держится на business_key).
UPSERT_FIELDS = [
    "business_key", "project_id", "spec_item_id", "query_name", "source", "source_url",
    "snapshot_date", "supplier_name", "manufacturer", "article", "name", "unit", "price",
    "currency", "vat_included", "vat_rate", "min_batch", "lead_time_days", "in_stock",
    "match_score", "status", "raw_data", "created_at", "updated_at",
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --- прод по HTTP ------------------------------------------------------------

def _api(path, body=None, timeout=120):
    """GET (body=None) или POST JSON. Секрет только из окружения и только в заголовке."""
    url = os.environ["BUDGET_API_URL"].rstrip("/") + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    # Секрет прода — необязательный: пока на сервере не задан API_SECRET, /api открыт и
    # заголовок не нужен. Задан будет — воркер начнёт его слать, менять здесь нечего.
    secret = os.environ.get("BUDGET_API_SECRET", "")
    if secret:
        headers["Authorization"] = "Bearer " + secret
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def parse_next(payload):
    """Ответ /price-search/jobs/next -> (job|None, позиции). Нет работы — (None, [])."""
    job = (payload or {}).get("job")
    if not job:
        return None, []
    return job, list((payload or {}).get("items") or [])


# --- временная база ----------------------------------------------------------

def _bind(v):
    """sqlite не умеет класть dict/list/bool — приводим к тому, что переживёт запись."""
    if v is None or isinstance(v, (int, float, str, bytes)):
        return int(v) if isinstance(v, bool) else v
    return json.dumps(v, ensure_ascii=False)


def build_temp_db(db_path, items):
    """Позиции прода -> specification_items во временной базе.

    Колонки — те, что пришли (типы не указываем, sqlite динамический). id остаются
    ПРОД-ОВСКИЕ: именно на них потом встанут цены. specification_id у всех = 1, чтобы
    скрипты, которые ищут по одной спецификации, увидели весь проект целиком.
    Переливать строки дампом из локальной базы нельзя — id там сквозные по базе.
    """
    cols = []
    for it in items:
        for k in it:
            if k not in cols:
                cols.append(k)
    if "specification_id" not in cols:
        cols.append("specification_id")

    con = sqlite3.connect(db_path)
    try:
        con.execute("CREATE TABLE specification_items (%s)" % ", ".join('"%s"' % c for c in cols))
        con.executemany(
            "INSERT INTO specification_items (%s) VALUES (%s)" % (
                ", ".join('"%s"' % c for c in cols), ", ".join("?" * len(cols))),
            [[1 if c == "specification_id" else _bind(it.get(c)) for c in cols] for it in items])
        con.commit()
    finally:
        con.close()
    return cols


def collect_rows(db_path):
    """Строки результата из временной базы — ровно поля UPSERT, без id."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("SELECT * FROM external_prices WHERE source='web_search'").fetchall()
    finally:
        con.close()
    return [{f: r[f] for f in UPSERT_FIELDS} for r in rows]


def result_body(rows):
    """Тело POST .../result. snapshotDate берём из самих строк (у прогона он один)."""
    dates = sorted({r["snapshot_date"] for r in rows if r.get("snapshot_date")})
    return {"snapshotDate": dates[-1] if dates else datetime.date.today().isoformat(),
            "rows": rows}


# --- прогон скриптов ---------------------------------------------------------

def run_step(args, env):
    """Подпроцесс python. stdout идёт на консоль живьём (видно ход прогона),
    stderr копим — из него собирается сообщение об ошибке для прода."""
    p = subprocess.run([sys.executable] + args, cwd=RESEARCH, env=env,
                       stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        tail = (p.stderr or "").strip()[-STDERR_TAIL:]
        raise RuntimeError("%s: код возврата %d\n%s" % (args[0], p.returncode, tail))
    return p


def process(job, items):
    """Один прогон задания. Возвращает число отданных на прод строк."""
    workdir = tempfile.mkdtemp(prefix="price_job_%s_" % job["id"])
    db_path = os.path.join(workdir, "job.db")
    try:
        cols = build_temp_db(db_path, items)
        log("задание %s: проект %s, позиций %d, колонок %d" % (
            job["id"], job.get("projectId"), len(items), len(cols)))

        # HITS_JSON — во временную папку задания: общий файл в out/ два одновременных
        # прогона перетирают друг другу, и результат уезжает молча неверный.
        env = dict(os.environ, SPEC_ID="1", BUDGET_DB_PATH=db_path, PYTHONUTF8="1",
                   HITS_JSON=os.path.join(workdir, "hits.json"))
        run_step(["zamer_sloj_marka.py"], env)
        run_step(["zapis_v_sistemu.py"], env)

        rows = collect_rows(db_path)
        _api("/price-search/jobs/%s/result" % job["id"], result_body(rows))
        log("задание %s: отдано строк %d" % (job["id"], len(rows)))
        return len(rows)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def report_error(job_id, message):
    try:
        _api("/price-search/jobs/%s/error" % job_id, {"message": message[:STDERR_TAIL]})
    except Exception as e:                      # прод недоступен — job снимет оператор
        log("не смогли сообщить об ошибке по заданию %s: %s" % (job_id, type(e).__name__))


def once():
    """Один проход: забрать задание, отработать, вернуть результат. True — работа была."""
    # POST, а не GET: захват задания меняет состояние на проде (задание уходит в running),
    # и случайный обходчик ссылок не должен уметь съесть работу Ивана одним переходом.
    job, items = parse_next(_api("/price-search/jobs/next", {}, timeout=60))
    if not job:
        return False
    try:
        process(job, items)
    except Exception as e:
        msg = "%s: %s" % (type(e).__name__, e)
        log("задание %s упало: %s" % (job["id"], msg.splitlines()[0]))
        report_error(job["id"], msg)
    return True


def loop():
    log("воркер запущен, опрос раз в %d сек" % POLL_SECONDS)
    while True:
        try:
            if once():
                continue                        # сразу за следующим заданием
        except Exception as e:
            log("прод недоступен (%s), ждём" % type(e).__name__)
        time.sleep(POLL_SECONDS)


# --- проверка ----------------------------------------------------------------

def _selfcheck():
    work = tempfile.mkdtemp(prefix="worker_selfcheck_")
    try:
        # 1. Разбор ответа «нет работы» и обычного ответа.
        assert parse_next({"job": None}) == (None, [])
        assert parse_next({}) == (None, [])
        job, items = parse_next({"job": {"id": 7, "projectId": 3},
                                 "items": [{"id": 5001}, {"id": 5002}]})
        assert job["id"] == 7 and len(items) == 2

        # 2. Сборка временной базы из фейкового ответа API.
        api_items = [
            {"id": 5001, "specification_id": 34, "project_id": 3, "parent_item_id": None,
             "full_name": "Кран шаровой BV.R.201", "name": "Кран шаровой",
             "product_code": "BV.R.201", "manufacturer": "Danfoss", "unit": "шт",
             "quantity": 4, "characteristics": "Ду20", "marking": None, "article": None},
            {"id": 5002, "specification_id": 34, "project_id": 3, "parent_item_id": 5001,
             "full_name": "Термометр TM-100", "name": "Термометр", "product_code": "TM-100",
             "manufacturer": None, "unit": "шт", "quantity": 2, "characteristics": None,
             "marking": None, "article": None},
        ]
        db_path = os.path.join(work, "job.db")
        cols = build_temp_db(db_path, api_items)
        assert cols == list(api_items[0].keys()), cols          # все пришедшие колонки, в порядке
        con = sqlite3.connect(db_path); con.row_factory = sqlite3.Row
        rows = con.execute("select * from specification_items order by id").fetchall()
        con.close()
        assert [r["id"] for r in rows] == [5001, 5002], [r["id"] for r in rows]   # id ПРОД-овские
        assert {r["specification_id"] for r in rows} == {1}     # спецификация переклеена на 1
        assert rows[0]["project_id"] == 3 and rows[1]["parent_item_id"] == 5001
        assert rows[0]["full_name"] == "Кран шаровой BV.R.201" and rows[0]["quantity"] == 4
        assert rows[1]["characteristics"] is None
        assert set(rows[0].keys()) == set(api_items[0].keys())
        print("selfcheck ok: временная база — %d строк, %d колонок, id прод-овские, "
              "specification_id=1" % (len(rows), len(cols)))

        # 3. Поля результата = поля UPSERT из src/db.py (без id) — сверяем с живым DDL.
        sys.path.insert(0, os.path.join(ROOT, "src"))
        import db as _db                                        # noqa: E402
        con = sqlite3.connect(db_path)
        con.executescript(_db.DDL)
        ddl_cols = [r[1] for r in con.execute("PRAGMA table_info(external_prices)")]
        assert ddl_cols[0] == "id" and ddl_cols[1:] == UPSERT_FIELDS, ddl_cols
        now = "2026-08-26T00:00:00+00:00"
        con.executemany(_db.UPSERT, [
            {f: None for f in UPSERT_FIELDS} | {
                "business_key": "web_search|5001|http://a/1|2026-08-26", "project_id": 3,
                "spec_item_id": 5001, "source": "web_search", "source_url": "http://a/1",
                "snapshot_date": "2026-08-26", "supplier_name": "a.ru", "name": "Кран",
                "price": 500.0, "currency": "RUB", "status": "found",
                "created_at": now, "updated_at": now},
            {f: None for f in UPSERT_FIELDS} | {
                "business_key": "other|5002|x|2026-08-26", "project_id": 3,
                "spec_item_id": 5002, "source": "supplier_feed", "source_url": "x",
                "snapshot_date": "2026-08-26", "name": "Термометр", "status": "found",
                "created_at": now, "updated_at": now},
        ])
        con.commit(); con.close()

        got = collect_rows(db_path)
        assert len(got) == 1, got                               # только source='web_search'
        assert list(got[0].keys()) == UPSERT_FIELDS
        assert "id" not in got[0]
        assert got[0]["spec_item_id"] == 5001 and got[0]["price"] == 500.0
        body = result_body(got)
        assert set(body) == {"snapshotDate", "rows"}
        assert body["snapshotDate"] == "2026-08-26" and body["rows"] == got
        assert result_body([])["snapshotDate"]                  # пустой прогон не роняет тело
        print("selfcheck ok: тело результата — %d строк, поля совпали с UPSERT из src/db.py"
              % len(body["rows"]))

        # 4. Ненулевой код возврата подпроцесса -> исключение, хвост stderr обрезан.
        bad = os.path.join(work, "bad.py")
        open(bad, "w", encoding="utf-8").write(
            "import sys; sys.stderr.write('ш'*900); sys.exit(3)")
        try:
            run_step([bad], dict(os.environ, PYTHONUTF8="1"))
            raise AssertionError("падение подпроцесса проехало молча")
        except RuntimeError as e:
            assert "код возврата 3" in str(e), str(e)
            assert str(e).count("ш") == STDERR_TAIL, str(e).count("ш")
        print("selfcheck ok: ненулевой код возврата поднимает ошибку, stderr обрезан до %d"
              % STDERR_TAIL)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "selfcheck":
        _selfcheck()
    else:
        missing = [k for k in ("BUDGET_API_URL",) if not os.environ.get(k)]
        if missing:
            sys.exit("Не заданы переменные окружения: %s. Пример:\n"
                     "  set BUDGET_API_URL=https://<прод>/api\n"
                     "  set BUDGET_API_SECRET=<секрет прода>" % ", ".join(missing))
        once() if mode == "once" else loop()
