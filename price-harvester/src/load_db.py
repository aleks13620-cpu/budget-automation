"""
ШАГ 4 — идемпотентная укладка в external_prices (общая SQLite бэкенда).

Идемпотентность по БИЗНЕС-ключу (источник|позиция|артикул/имя|единица|дата),
НЕ по байтам: повторный прогон в тот же день обновляет строки, а не задваивает.
"""
from __future__ import annotations

import json

import common
import db

COLS = ["project_id", "spec_item_id", "query_name", "supplier_name", "manufacturer",
        "article", "unit", "price", "currency", "vat_included", "vat_rate", "min_batch",
        "lead_time_days", "in_stock", "match_score", "raw_data"]


def load() -> dict:
    recs = common.read_out_json("external_prices.json")
    con = db.connect()
    try:
        db.ensure_schema(con)

        # Очистка среза: удаляем прежние строки за ту же дату по парам (позиция, источник),
        # которые мы сейчас пересчитали — чтобы исчезнувшие матчи не оставались сиротами.
        # Записи других дат / других позиций / других источников НЕ трогаем.
        pruned = 0
        pairs = {(r["project_id"], r["snapshot_date"], r["spec_item_id"], r["source"]) for r in recs}
        for project_id, snap, sid, source in pairs:
            cur = con.execute(
                "DELETE FROM external_prices WHERE project_id=? AND snapshot_date=? "
                "AND spec_item_id=? AND source=?",
                (project_id, snap, sid, source),
            )
            pruned += cur.rowcount or 0

        ins = upd = 0
        for raw in recs:
            r = dict(raw)
            existing = con.execute(
                "SELECT id FROM external_prices WHERE business_key=?", (r["business_key"],)
            ).fetchone()
            for c in COLS:
                r.setdefault(c, None)
            r.setdefault("status", "found")
            r["created_at"] = common.now_iso()   # на UPDATE не трогается (нет в SET)
            r["updated_at"] = common.now_iso()
            con.execute(db.UPSERT, r)
            upd += 1 if existing else 0
            ins += 0 if existing else 1
        con.commit()
        total = con.execute("SELECT COUNT(*) c FROM external_prices").fetchone()["c"]
    finally:
        con.close()
    print(f"ШАГ 4 — укладка: удалено устаревших {pruned}, вставлено {ins}, обновлено {upd}; "
          f"всего в external_prices: {total}")
    return {"pruned": pruned, "inserted": ins, "updated": upd, "total": total}


if __name__ == "__main__":
    load()
