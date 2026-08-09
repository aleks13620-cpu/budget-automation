"""
ШАГ 5 — Completion-QA. Честный отчёт: по скольким % позиций нашлась ≥1 внешняя
цена, сколько источников заблокировано, где пусто. Пустая позиция ПОМЕЧАЕТСЯ
(не нашли/заблокировано), а не заполняется выдуманной ценой.
"""
from __future__ import annotations

import json
import os

import common
import db


def report() -> dict:
    plan = common.read_out_json("source_plan.json")
    if plan["snapshot_date"] != common.today() and not os.environ.get("PH_ALLOW_STALE"):
        print(f"⚠ срез за {plan['snapshot_date']}, не сегодня — данные могут быть "
              f"устаревшими (PH_ALLOW_STALE=1 чтобы скрыть)")
    status_path = common.OUT / "collect_status.json"
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else []

    pilot = plan["pilot_positions"]
    project_id, snap = plan["project_id"], plan["snapshot_date"]
    sources = [s["source"] for s in status] or None   # считаем только источники этого прогона

    con = db.connect(readonly=True)
    try:
        sql = "SELECT spec_item_id, status, price FROM external_prices WHERE project_id=? AND snapshot_date=?"
        params = [project_id, snap]
        if sources:
            sql += f" AND source IN ({','.join('?' * len(sources))})"
            params += sources
        rows = con.execute(sql, params).fetchall()
    finally:
        con.close()

    found_ids = {r["spec_item_id"] for r in rows if r["status"] == "found" and r["price"] is not None}
    total = len(pilot)
    have = sum(1 for p in pilot if p["spec_item_id"] in found_ids)
    empty = [p for p in pilot if p["spec_item_id"] not in found_ids]
    blocked = [s for s in status if s["status"] == "blocked"]
    pct = (100 * have // total) if total else 0

    L = [f"# Completion-QA — {snap} (project_id={project_id})", ""]
    L.append(f"- Позиций в пилоте: **{total}**")
    L.append(f"- С ≥1 внешней ценой: **{have} ({pct}%)**")
    L.append(f"- Без цены (не нашли / заблокировано): **{len(empty)}**")
    L.append(f"- Источников заблокировано: **{len(blocked)}** из {len(status)}")
    if status:
        L += ["", "## Источники"]
        for s in status:
            L.append(f"- `{s['source']}`: **{s['status']}** — {s['note']} (offers={s['offers']})")
    if empty:
        L += ["", "## Позиции без внешней цены (помечены, НЕ выдуманы)"]
        for p in empty:
            L.append(f"- [{p.get('category_guess')}] {p['name']}")
    md = "\n".join(L)
    (common.OUT / "qa_report.md").write_text(md, encoding="utf-8")
    print(md)
    return {"total": total, "have": have, "pct": pct, "empty": len(empty), "blocked": len(blocked)}


if __name__ == "__main__":
    report()
