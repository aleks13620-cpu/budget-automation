# -*- coding: utf-8 -*-
"""
Кладёт результат уже выполненного прогона поиска цен (out/zamer_layerC_hits.json)
в общую таблицу external_prices вместе с квалификацией КАЖДОЙ позиции спецификации 34
(группы A/B/C/D из klassifikator_pozicij.py). Прогон (zamer_sloj_marka.py) не трогаем.

python zapis_v_sistemu.py selfcheck   — проверка на реальных данных, без записи в БД
python zapis_v_sistemu.py             — запись (UPSERT по business_key — повтор не плодит строки)
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../price-harvester
sys.path.insert(0, os.path.join(ROOT, "src"))
import common  # noqa: F401  (грузит .env, задаёт BUDGET_DB_PATH — ДО db.connect())
import db

KLASS = os.path.join(ROOT, "research", "klassifikator_pozicij.py")
HITS_JSON = os.environ.get("HITS_JSON", os.path.join(ROOT, "out", "zamer_layerC_hits.json"))
SPEC_ID = int(os.environ.get("SPEC_ID", 34))   # воркер (worker.py) гоняет по временной базе

# классификатор берём как есть (см. zamer_sloj_marka.py) — чтобы группы совпали с прогоном
_ns = {"__name__": "k"}
exec(compile(io.open(KLASS, encoding="utf-8").read().replace("\nrun()\n", "\n"),
             "klass", "exec"), _ns)
classify = _ns["classify"]
dedup_key = _ns["dedup_key"]   # ключ дедупа — одно определение на python, см. klassifikator_pozicij.py

# признак поиска — только для группы C. Типоразмер радиатора: буквы+цифры-цифры-цифры
# (C22-400-600, CV11-400-1000). Степень защиты: IP + только цифры (IP54). Остальное — артикул.
SIZE_MARK = re.compile(r"^[A-Za-zА-Яа-я]+\d+-\d+-\d+$")
IP_MARK = re.compile(r"^IP\d+$", re.I)
SCORE = {"артикул": 1.0, "типоразмер": 0.6, "без артикула": 0.3}


def found_by(mark: str) -> str:
    if SIZE_MARK.match(mark):
        return "типоразмер"
    if IP_MARK.match(mark):
        return "без артикула"
    return "артикул"


def load_positions(con):
    """ВСЕ позиции спецификации 34 (не только группа C) с квалификацией. Полное имя
    и дедуп — как в load_layer_c из zamer_sloj_marka.py, иначе классификация разойдётся
    с тем, что реально искалось."""
    rows = con.execute("select * from specification_items where specification_id=?", (SPEC_ID,)).fetchall()
    by_id = {r["id"]: r for r in rows}

    def full(r):
        parts, cur, g = [], r, 0
        while cur is not None and g < 5:
            nm = (cur["full_name"] or cur["name"] or "").strip()
            if nm and nm not in parts:
                parts.insert(0, nm)
            cur = by_id.get(cur["parent_item_id"]); g += 1
        return re.sub(r"\s+", " ", " ".join(parts))[:120]

    out, seen = [], set()
    for r in rows:
        if not r["quantity"]:
            continue
        fn = full(r)
        key = dedup_key(r, fn)
        if key in seen:
            continue
        seen.add(key)
        kind, mark, src = classify(r, fn)
        manuf = (r["manufacturer"] or "").strip()
        if manuf == mark:
            manuf = ""
        out.append({"id": r["id"], "project_id": r["project_id"], "name": fn, "mark": mark,
                    "manufacturer": manuf, "unit": r["unit"] or "", "group": kind, "mark_src": src})
    return out


def build_rows(positions, hits_by_id, snapshot_date, now):
    """Строки под именованные параметры db.UPSERT."""

    def row(pos, status, key_part, price=None, supplier=None, name=None, match=None,
            query=None, found=None):
        return {
            "business_key": "|".join(["web_search", str(pos["id"]), key_part, snapshot_date]),
            "project_id": pos["project_id"], "spec_item_id": pos["id"], "query_name": query,
            "source": "web_search", "source_url": key_part, "snapshot_date": snapshot_date,
            "supplier_name": supplier, "manufacturer": None, "article": None,
            "name": name or pos["name"], "unit": pos["unit"], "price": price, "currency": "RUB",
            "vat_included": None, "vat_rate": None, "min_batch": None, "lead_time_days": None,
            "in_stock": None, "match_score": match, "status": status,
            "raw_data": json.dumps({"group": pos["group"], "mark": pos.get("mark"),
                                     "mark_src": pos.get("mark_src"), "found_by": found},
                                    ensure_ascii=False),
            "created_at": now, "updated_at": now,
        }

    out = []
    for pos in positions:
        if not pos["group"].startswith("C"):
            out.append(row(pos, "skipped", pos["group"], query=pos["group"]))
            continue
        h = hits_by_id.get(pos["id"])
        fb = found_by(pos["mark"])
        score = SCORE[fb]
        query = re.sub(r"\s+", " ", " ".join(
            x for x in (pos["manufacturer"], pos["mark"], pos["name"]) if x))[:180]
        hits = (h.get("hits") or []) if h else []
        for price, url, host, card in hits:
            out.append(row(pos, "found", url, price=price, supplier=host, name=card,
                            match=score, query=query, found=fb))
        if not hits:
            out.append(row(pos, "not_found", "not_found", match=score, query=query, found=fb))
        for host in [b for b in ((h.get("blocked") or "") if h else "").split("; ") if b]:
            out.append(row(pos, "blocked", host, supplier=host, match=score, query=query, found=fb))
    return out


def snapshot_date_from_mtime() -> str:
    import datetime
    return datetime.date.fromtimestamp(os.path.getmtime(HITS_JSON)).isoformat()


def _selfcheck():
    con = db.connect(readonly=True)
    try:
        positions = load_positions(con)
        hits = json.loads(io.open(HITS_JSON, encoding="utf-8").read())
        hits_by_id = {h["id"]: h for h in hits}
        snapshot_date = snapshot_date_from_mtime()
        now = common.now_iso()

        c_pos = [p for p in positions if p["group"].startswith("C")]
        abd_pos = [p for p in positions if not p["group"].startswith("C")]
        assert len(c_pos) == len(hits), (len(c_pos), len(hits))  # классификация совпала с прогоном

        n_offers = sum(len(h.get("hits") or []) for h in hits)
        n_not_found = sum(1 for h in hits if not (h.get("hits") or []))
        n_blocked = sum(len([b for b in (h.get("blocked") or "").split("; ") if b]) for h in hits)
        expected_rows = n_offers + n_not_found + n_blocked + len(abd_pos)

        rows = build_rows(positions, hits_by_id, snapshot_date, now)
        assert len(rows) == expected_rows, (len(rows), expected_rows)
        print("selfcheck ok: строк к записи %d (предложения %d + без цены %d + блок %d + A/B/D %d)"
              % (len(rows), n_offers, n_not_found, n_blocked, len(abd_pos)))

        keys = [r["business_key"] for r in rows]
        assert len(keys) == len(set(keys)), "business_key не уникален"
        print("selfcheck ok: business_key уникален (%d строк)" % len(keys))

        for r in rows:
            if r["status"] == "found":
                assert r["price"] and r["supplier_name"] and r["source_url"], r
        print("selfcheck ok: у всех status=found заполнены price/supplier_name/source_url")

        fb_dist = Counter(found_by(p["mark"]) for p in c_pos)
        expected = {"артикул": 35, "типоразмер": 15, "без артикула": 4}
        assert fb_dist == Counter(expected), fb_dist
        print("selfcheck ok: found_by =", dict(fb_dist))
    finally:
        con.close()


def main():
    con = db.connect()
    try:
        db.ensure_schema(con)
        positions = load_positions(con)
        hits = json.loads(io.open(HITS_JSON, encoding="utf-8").read())
        hits_by_id = {h["id"]: h for h in hits}
        snapshot_date = snapshot_date_from_mtime()
        now = common.now_iso()

        # та же проверка, что в selfcheck: без неё устаревший hits.json тихо
        # превращается в status=not_found для позиций, которые на самом деле не искались
        c_pos = [p for p in positions if p["group"].startswith("C")]
        if len(c_pos) != len(hits):
            raise SystemExit(
                "hits.json не соответствует текущей спецификации: групп C %d, строк в hits %d "
                "— нужен свежий прогон zamer_sloj_marka.py" % (len(c_pos), len(hits)))

        rows = build_rows(positions, hits_by_id, snapshot_date, now)

        con.executemany(db.UPSERT, rows)
        con.commit()
        total = con.execute("select count(*) from external_prices where source='web_search'").fetchone()[0]
        by_status = con.execute(
            "select status, count(*) from external_prices where source='web_search' group by status").fetchall()
        print("записано/обновлено строк: %d" % len(rows))
        print("всего в external_prices (source=web_search): %d" % total)
        print("по статусам:", ", ".join("%s=%d" % (s, n) for s, n in by_status))
    finally:
        con.close()


if __name__ == "__main__":
    if "selfcheck" in sys.argv:
        _selfcheck()
    else:
        main()
