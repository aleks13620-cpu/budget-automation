"""
Доступ к ОБЩЕЙ SQLite бэкенда. Backend (TS) НЕ трогаем: только ДОБАВЛЯЕМ свою
таблицу external_prices через CREATE TABLE IF NOT EXISTS. Пишем в ту же БД
безопасно — режим WAL (как у Node) + busy_timeout + короткие транзакции
(1 писатель + N читателей под WAL не мешают друг другу).
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import common  # noqa: F401  (грузит .env и пути ДО чтения BUDGET_DB_PATH)


def db_path() -> Path:
    return Path(os.environ["BUDGET_DB_PATH"]).resolve()


# Паспорт у каждой цены: провенанс (source/source_url/snapshot_date) + сопоставимость
# (валюта, НДС, мин.партия, срок), бизнес-ключ для идемпотентности, raw_data на сырьё.
DDL = """
CREATE TABLE IF NOT EXISTS external_prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_key   TEXT NOT NULL UNIQUE,
  project_id     INTEGER,
  spec_item_id   INTEGER,
  query_name     TEXT,
  source         TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  snapshot_date  TEXT NOT NULL,
  supplier_name  TEXT,
  manufacturer   TEXT,
  article        TEXT,
  name           TEXT NOT NULL,
  unit           TEXT,
  price          REAL,
  currency       TEXT DEFAULT 'RUB',
  vat_included   INTEGER,
  vat_rate       INTEGER,
  min_batch      REAL,
  lead_time_days INTEGER,
  in_stock       INTEGER,
  match_score    REAL,
  status         TEXT NOT NULL DEFAULT 'found',   -- found | not_found | blocked
  raw_data       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_external_prices_spec    ON external_prices(spec_item_id);
CREATE INDEX IF NOT EXISTS idx_external_prices_project ON external_prices(project_id);
CREATE INDEX IF NOT EXISTS idx_external_prices_source  ON external_prices(source);
"""

UPSERT = """
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
   updated_at=excluded.updated_at;
"""


def connect(readonly: bool = False) -> sqlite3.Connection:
    p = db_path()
    if readonly:
        con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True, timeout=10)
    else:
        con = sqlite3.connect(str(p), timeout=10)
    con.row_factory = sqlite3.Row
    # Режим журнала (WAL и т.п.) задаёт ВЛАДЕЛЕЦ БД — бэкенд; здесь его не форсируем.
    con.execute("PRAGMA busy_timeout=5000")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def ensure_schema(con: sqlite3.Connection) -> None:
    con.executescript(DDL)
    con.commit()
