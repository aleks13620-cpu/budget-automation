"""
Экспорт самодостаточного HTML-отчёта «Где дешевле» для показа на ПРОДЕ.

Зачем так: прод на Timeweb (датацентр-IP) — антибот-источники там лягут, и Python
на проде нет. Поэтому СБОР идёт локально (РФ-IP), а на прод едет уже готовый
СТАТИЧЕСКИЙ файл с данными внутри. Бэкенд раздаёт frontend/dist статикой публично
(index.ts: express.static), Vite копирует frontend/public/* → dist/*. Значит этот
файл, положенный в frontend/public/, откроется на проде по /price-report.html
без токена и без обращения к БД/матчингу прода.

Данные берём из таблицы external_prices (локальная БД после сбора). HTML без внешних
запросов — всё внутри (инлайн-стили, данные отрендерены в таблицу).
"""
from __future__ import annotations

import html

import yaml

import common
import db

BAND = 0.15
CONFIDENT = 0.6


def _enabled_real_sources() -> list[str]:
    cfg = yaml.safe_load((common.ROOT / "config" / "sources.yaml").read_text(encoding="utf-8"))
    return [s["key"] for s in (cfg.get("sources") or [])
            if s.get("enabled") and s.get("recipe") != "offline"]


def comparable(price, vat_included, vat_rate) -> float | None:
    if price is None:
        return None
    if vat_included:
        return round(float(price), 2)
    return round(float(price) * (1 + (vat_rate or 22) / 100), 2)


def _rub(x) -> str:
    if x is None:
        return "—"
    return f"{x:,.0f}".replace(",", " ") + " ₽"


def _gather() -> dict:
    pl = common.read_out_json("purchase_list.json")
    project_id = pl["project_id"]
    snap = common.today()
    base_by_id = {p["spec_item_id"]: p.get("invoice_baseline") for p in pl["positions"]}
    pos_by_id = {p["spec_item_id"]: p for p in pl["positions"]}
    srcs = _enabled_real_sources()

    con = db.connect(readonly=True)
    try:
        q = ("SELECT * FROM external_prices WHERE project_id=? AND snapshot_date=? "
             "AND status='found' AND price>0")
        params = [project_id, snap]
        if srcs:
            q += f" AND source IN ({','.join('?' * len(srcs))})"
            params += srcs
        rows = [dict(r) for r in con.execute(q, params).fetchall()]
    finally:
        con.close()

    by_spec: dict[int, list[dict]] = {}
    for r in rows:
        r["_cmp"] = comparable(r["price"], r["vat_included"], r["vat_rate"])
        if r["_cmp"] is not None:
            by_spec.setdefault(r["spec_item_id"], []).append(r)

    items = []
    for sid, cands in by_spec.items():
        cands.sort(key=lambda c: (c["match_score"] or 0), reverse=True)
        top = cands[0]["match_score"] or 0
        band = [c for c in cands if (c["match_score"] or 0) >= top - BAND]
        best = min(band, key=lambda c: c["_cmp"])
        pmin = min(c["_cmp"] for c in band)
        pmax = max(c["_cmp"] for c in band)
        base = base_by_id.get(sid)
        base_cmp = comparable(base["price"], True, 22) if base else None
        delta = round(100 * (base_cmp - best["_cmp"]) / base_cmp, 1) if (base_cmp and top >= CONFIDENT) else None
        pos = pos_by_id.get(sid, {})
        status = "точное" if top >= 0.66 else "проверить"
        items.append({
            "name": pos.get("name") or best["query_name"],
            "unit": pos.get("unit") or best.get("unit"),
            "invoice_price": base["price"] if base else None,
            "invoice_supplier": base["supplier"] if base else None,
            "best_name": best["name"], "best_price": best["price"],
            "best_source": best["source"], "best_url": best["source_url"],
            "supplier_name": best.get("supplier_name"),
            "pmin": pmin, "pmax": pmax, "n": len(cands), "score": round(top, 2),
            "delta": delta, "status": status,
        })
    items.sort(key=lambda i: (i["delta"] is None, -(i["delta"] or 0), i["name"]))
    return {"project_id": project_id, "snapshot": snap, "sources": srcs, "items": items}


def _render(data: dict) -> str:
    e = html.escape
    n = len(data["items"])
    n_eco = sum(1 for i in data["items"] if i["delta"] and i["delta"] > 0)
    rows = []
    for i in data["items"]:
        badge = ("background:#e1f5ee;color:#0f6e56" if i["status"] == "точное"
                 else "background:#faeeda;color:#854f0b")
        delta = (f"<span style='color:#0f6e56;font-weight:500'>−{i['delta']}%</span>"
                 if i["delta"] and i["delta"] > 0 else
                 (f"<span style='color:#a32d2d'>+{abs(i['delta'])}%</span>" if i["delta"] else "—"))
        rng = "" if i["pmin"] == i["pmax"] else f"<div style='font-size:11px;color:#888'>рынок {_rub(i['pmin'])}–{_rub(i['pmax'])}</div>"
        link = (f"<a href='{e(i['best_url'])}' target='_blank' rel='noopener' style='color:#185fa5;text-decoration:none'>↗</a>"
                if i["best_url"] and str(i["best_url"]).startswith("http") else "")
        rows.append(
            f"<tr>"
            f"<td>{e(i['name'])}<div style='font-size:11px;color:#888'>{e(i['unit'] or '')}</div></td>"
            f"<td style='text-align:right'>{_rub(i['invoice_price'])}<div style='font-size:11px;color:#888'>{e(i['invoice_supplier'] or '')[:22]}</div></td>"
            f"<td style='text-align:right'>{_rub(i['best_price'])} {link}{rng}</td>"
            f"<td>{e(i['best_source'])}<div style='font-size:11px;color:#888'>{e(i['best_name'])[:40]}</div></td>"
            f"<td style='text-align:right'>{delta}</td>"
            f"<td><span style='font-size:12px;padding:2px 8px;border-radius:6px;{badge}'>{i['status']}</span>"
            f"<div style='font-size:11px;color:#888'>точн {i['score']}</div></td>"
            f"</tr>"
        )
    rows_html = "\n".join(rows) or "<tr><td colspan='6'>Нет данных — запусти сбор (run.py)</td></tr>"
    sources = ", ".join(data["sources"]) or "—"
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Где дешевле — внешние цены ({e(data['snapshot'])})</title>
<style>
 body{{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a;margin:0;background:#fff;padding:24px;max-width:1000px}}
 h1{{font-size:22px;font-weight:500;margin:0 0 4px}}
 .sub{{color:#666;font-size:14px;margin-bottom:16px}}
 .cards{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}}
 .card{{background:#f1efe8;border-radius:8px;padding:12px 16px}}
 .card .l{{font-size:13px;color:#666}} .card .v{{font-size:22px;font-weight:500}}
 table{{width:100%;border-collapse:collapse;font-size:13px}}
 th{{text-align:left;color:#666;font-weight:500;font-size:12px;border-bottom:1px solid #ddd;padding:8px 10px}}
 td{{border-bottom:1px solid #f0f0f0;padding:9px 10px;vertical-align:top}}
 .note{{margin-top:16px;font-size:12px;color:#888;line-height:1.6}}
</style></head><body>
<h1>Где дешевле — внешние цены поставщиков</h1>
<div class="sub">Проект #{data['project_id']} · срез {e(data['snapshot'])} · источники: {e(sources)}</div>
<div class="cards">
  <div class="card"><div class="l">Позиций с ценой</div><div class="v">{n}</div></div>
  <div class="card"><div class="l">Где есть экономия</div><div class="v">{n_eco}</div></div>
  <div class="card"><div class="l">Источников</div><div class="v">{len(data['sources'])}</div></div>
</div>
<table>
<thead><tr><th>Позиция</th><th style="text-align:right">Цена счёта</th><th style="text-align:right">Дешевле всего</th><th>Источник</th><th style="text-align:right">Экономия</th><th>Статус</th></tr></thead>
<tbody>
{rows_html}
</tbody></table>
<div class="note">
 Снимок публичных базовых цен (без индивидуальных скидок личного кабинета — их при необходимости добавляем как % на поставщика).<br>
 «точное» — уверенное совпадение; «проверить» — тот же тип и размер, вариант стоит сверить. У каждой цены есть ссылка на источник (↗).
</div>
</body></html>"""


def export() -> dict:
    data = _gather()
    out = _render(data)
    out_file = common.OUT / "price-report.html"
    out_file.write_text(out, encoding="utf-8")
    published = None
    public_dir = common.ROOT.parent / "frontend" / "public"
    if public_dir.exists():
        published = public_dir / "price-report.html"
        published.write_text(out, encoding="utf-8")
    print(f"Экспорт: {len(data['items'])} позиций → {out_file}")
    if published:
        print(f"  опубликовано в фронт: {published} (попадёт в dist → прод /price-report.html)")
    else:
        print("  ⚠ frontend/public не найден — скопируй price-report.html туда вручную")
    return data


if __name__ == "__main__":
    export()
