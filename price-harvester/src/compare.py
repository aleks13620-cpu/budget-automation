"""
ШАГ 6 — сравнение «где дешевле». Для каждой позиции пилота: цена из счёта (база) +
внешние цены. Приводим к сопоставимому виду (с НДС).

Честность важнее красивой цифры. У разных брендов точное совпадение варианта редко,
поэтому:
  • показываем БЛИЖАЙШИЙ вариант, ДИАПАЗОН цен по «тип+размер» и ТОЧНОСТЬ (match_score);
  • «экономию %» заявляем ТОЛЬКО при уверенном совпадении (score ≥ CONFIDENT),
    иначе помечаем «похожие варианты — проверить»;
  • считаем только источники текущего прогона (без подмешивания старых).
Допущение: цена из счёта — «с НДС». Выгрузка: out/comparison.{json,csv,xlsx}.
"""
from __future__ import annotations

import csv
import json
import os

import common
import db

INVOICE_ASSUMED_VAT = True
CONFIDENT = 0.6        # порог уверенного совпадения для заявки об «экономии»
BAND = 0.15            # ширина «топ-полосы» вокруг лучшего совпадения


def comparable(price, vat_included, vat_rate) -> float | None:
    if price is None:
        return None
    if vat_included:
        return round(float(price), 2)
    return round(float(price) * (1 + (vat_rate or 22) / 100), 2)


def _current_sources() -> list[str] | None:
    p = common.OUT / "collect_status.json"
    if not p.exists():
        return None
    return [s["source"] for s in json.loads(p.read_text(encoding="utf-8"))] or None


def compare() -> list[dict]:
    pl = common.read_out_json("purchase_list.json")
    plan = common.read_out_json("source_plan.json")
    if plan["snapshot_date"] != common.today() and not os.environ.get("PH_ALLOW_STALE"):
        print(f"⚠ срез за {plan['snapshot_date']}, не сегодня — данные могут быть "
              f"устаревшими (PH_ALLOW_STALE=1 чтобы скрыть)")
    base_by_id = {p["spec_item_id"]: p.get("invoice_baseline") for p in pl["positions"]}
    pilot = {p["spec_item_id"]: p for p in plan["pilot_positions"]}
    project_id, snap = plan["project_id"], plan["snapshot_date"]
    sources = _current_sources()

    con = db.connect(readonly=True)
    try:
        sql = ("SELECT * FROM external_prices WHERE project_id=? AND snapshot_date=? "
               "AND status='found' AND price IS NOT NULL")
        params = [project_id, snap]
        if sources:
            sql += f" AND source IN ({','.join('?' * len(sources))})"
            params += sources
        rows = [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()

    by_spec: dict[int, list[dict]] = {}
    for r in rows:
        by_spec.setdefault(r["spec_item_id"], []).append(r)

    results = []
    for sid, pos in pilot.items():
        cands = sorted(by_spec.get(sid, []), key=lambda o: (o["match_score"] or 0), reverse=True)
        for o in cands:
            o["_cmp"] = comparable(o["price"], o["vat_included"], o["vat_rate"])
        cands = [o for o in cands if o["_cmp"] is not None]

        base = base_by_id.get(sid)
        base_cmp = comparable(base["price"], INVOICE_ASSUMED_VAT, 22) if base else None

        top_score = (cands[0]["match_score"] or 0) if cands else 0.0
        band = [o for o in cands if (o["match_score"] or 0) >= top_score - BAND]
        price_min = min((o["_cmp"] for o in band), default=None)
        price_max = max((o["_cmp"] for o in band), default=None)
        # «Где дешевле» = самый дешёвый среди топ-точных совпадений (а не самый похожий).
        best = min(band, key=lambda o: o["_cmp"]) if band else None
        delta = None
        if base_cmp and best and top_score >= CONFIDENT:
            delta = round(100 * (base_cmp - best["_cmp"]) / base_cmp, 1)

        results.append({
            "position": pos["name"],
            "dn": pos.get("dn"),
            "unit": pos.get("unit"),
            "invoice_price": base["price"] if base else None,
            "invoice_supplier": base["supplier"] if base else None,
            "n_candidates": len(cands),
            "confidence": round(top_score, 2),
            "best_name": best["name"] if best else None,
            "best_price": best["price"] if best else None,
            "best_source": best["source"] if best else None,
            "best_supplier": best["supplier_name"] if best else None,
            "best_url": best["source_url"] if best else None,
            "price_min": price_min,
            "price_max": price_max,
            "delta_pct": delta,
        })

    (common.OUT / "comparison.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_csv(results)
    _write_xlsx(results)

    print("ШАГ 6 — где дешевле (с НДС). «Экономия» — только при уверенном совпадении:")
    for r in results:
        if not r["n_candidates"]:
            print(f"  • {r['position'][:46]:<46}: внешних цен нет")
            continue
        rng = "" if r["price_min"] == r["price_max"] else f" (рынок {r['price_min']:g}–{r['price_max']:g}₽)"
        tail = f"[{r['n_candidates']} вар., точн {r['confidence']}]"
        best = f"{r['best_source']} {r['best_price']:g}₽" if r["best_price"] is not None else "—"
        if r["delta_pct"] is not None:
            verb = "экономия" if r["delta_pct"] > 0 else "дороже"
            print(f"  • {r['position'][:46]:<46}: счёт {r['invoice_price']}₽ / {best} → {verb} {abs(r['delta_pct'])}%{rng} {tail}")
        elif r["confidence"] >= CONFIDENT:
            print(f"  • {r['position'][:46]:<46}: {best}{rng} {tail} (счёта нет)")
        else:
            print(f"  • {r['position'][:46]:<46}: похожие по типу+размеру{rng} {tail} — проверить вариант")
    print("  → out/comparison.{json,csv,xlsx}")
    return results


def _write_csv(results: list[dict]) -> None:
    path = common.OUT / "comparison.csv"
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(results[0].keys()) if results else ["position"])
        w.writeheader()
        w.writerows(results)


def _write_xlsx(results: list[dict]) -> None:
    try:
        from openpyxl import Workbook
    except ImportError:
        return
    wb = Workbook()
    ws = wb.active
    ws.title = "Где дешевле"
    ws.append(["Позиция", "DN", "Ед.", "Цена счёта, ₽", "Поставщик (счёт)",
               "Кандидатов", "Точность", "Дешевле всего: товар", "Цена, ₽",
               "Источник", "Поставщик (внеш.)", "Ссылка", "Рынок от, ₽", "Рынок до, ₽", "Экономия, %"])
    for r in results:
        ws.append([r["position"], r["dn"], r["unit"], r["invoice_price"], r["invoice_supplier"],
                   r["n_candidates"], r["confidence"], r["best_name"], r["best_price"],
                   r["best_source"], r["best_supplier"], r["best_url"],
                   r["price_min"], r["price_max"], r["delta_pct"]])
    wb.save(common.OUT / "comparison.xlsx")


if __name__ == "__main__":
    compare()
