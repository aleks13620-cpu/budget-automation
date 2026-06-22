"""
ШАГ 2 — источники цен по приоритету. Выбираем позиции для пилота и привязываем к
каждой включённые источники (по категории/ключевым словам из config/sources.yaml).

Результат: out/source_plan.json — что у каких источников искать.
"""
from __future__ import annotations

import json
import os

import yaml

import common

DEFAULT_CATEGORIES = {"счетчики", "арматура", "отопление"}


def load_sources() -> list[dict]:
    cfg = yaml.safe_load((common.ROOT / "config" / "sources.yaml").read_text(encoding="utf-8"))
    return cfg.get("sources", []) or []


def pick_pilot(positions: list[dict], limit: int, category: str | None) -> list[dict]:
    target = {category} if category else DEFAULT_CATEGORIES
    cand = [p for p in positions if p.get("category_guess") in target]
    if not cand:  # запас: берём опознаваемые (с DN или производителем)
        cand = [p for p in positions if p.get("dn") or p.get("manufacturer")]
    # Сначала самые опознаваемые (есть производитель, есть DN) — детерминированно.
    cand.sort(key=lambda p: (p.get("manufacturer") is None, p.get("dn") is None, p["name"]))
    return cand[:limit]


def source_matches(src: dict, pos: dict) -> bool:
    m = src.get("match", {}) or {}
    cats = set(m.get("categories", []))
    if cats and pos.get("category_guess") in cats:
        return True
    hay = pos["name"].lower()
    return any(str(k).lower() in hay for k in m.get("keywords", []))


def resolve(limit: int | None = None, category: str | None = None) -> dict:
    pl = common.read_out_json("purchase_list.json")
    limit = limit or int(os.environ.get("PILOT_LIMIT", "5"))
    category = category or os.environ.get("PILOT_CATEGORY") or None

    pilot = pick_pilot(pl["positions"], limit, category)
    sources = load_sources()
    enabled = [s for s in sources if s.get("enabled")]

    plan = []
    for s in enabled:
        ids = [p["spec_item_id"] for p in pilot if source_matches(s, p)]
        if ids:
            plan.append({"source_key": s["key"], "positions": ids})

    out = {
        "project_id": pl["project_id"],
        "snapshot_date": pl["snapshot_date"],
        "pilot_positions": pilot,
        "plan": plan,
        "enabled_sources": [s["key"] for s in enabled],
        "disabled_sources": [s["key"] for s in sources if not s.get("enabled")],
    }
    (common.OUT / "source_plan.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"ШАГ 2 — план источников: пилот={len(pilot)} позиций, включённых источников={len(enabled)}")
    for p in pilot:
        print(f"  • [{p.get('category_guess')}] {p['name'][:55]} (DN={p.get('dn')})")
    if not enabled:
        print("  ⚠ нет включённых источников (enabled:true) в config/sources.yaml")
    elif not plan:
        print("  ⚠ включённые источники не подошли ни к одной позиции пилота (проверь match.categories)")
    return out


if __name__ == "__main__":
    resolve()
