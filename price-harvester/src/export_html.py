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
import re
import sys

import yaml

# Локальный запуск может быть в консоли cp1251 (Windows) — печать кириллицы и «→»
# тогда падает. Переводим вывод в UTF-8, не роняя скрипт, если это недоступно.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import common
import db
import normalize as nz

BAND = 0.15
CONFIDENT = 0.6

# Статус позиции: внутренний ключ → (подпись для человека, цвет плашки).
STATUS_VIEW = {
    "точное": ("совпадает", "background:#e1f5ee;color:#0f6e56"),
    "проверить": ("похоже, сверьте по ссылке", "background:#faeeda;color:#854f0b"),
}


def _sources_cfg() -> list[dict]:
    cfg = yaml.safe_load((common.ROOT / "config" / "sources.yaml").read_text(encoding="utf-8"))
    return cfg.get("sources") or []


def _enabled_real_sources() -> list[str]:
    return [s["key"] for s in _sources_cfg()
            if s.get("enabled") and s.get("recipe") != "offline"]


def _source_names() -> dict:
    # Человеческое имя источника берём из конфига (brand/title) — не хардкодим.
    return {s["key"]: (s.get("brand") or s.get("title") or s["key"]) for s in _sources_cfg()}


_WORD_RE = re.compile(r"[а-яёa-z]+", re.I)


def _norm(s) -> str:
    return str(s or "").lower().replace("ё", "е")


def _type_tokens(name, k: int = 2) -> list[str]:
    # Ведущие значимые слова (≥4 букв) имени — обычно это ТИП товара (кран/отвод/изоляция).
    sig = [w for w in _WORD_RE.findall(_norm(name)) if len(w) >= 4]
    return sig[:k]


def _type_consistent(query_name, matched_name) -> bool:
    """Фильтр СЛОЯ ОТЧЁТА (НЕ матчинг): матч «того же типа», если хотя бы одно ведущее
    тип-слово позиции есть в подобранном названии. Отсекает изоляция→кронштейн,
    тройник→ниппель, отвод→переходник; сохраняет переход→переходник, труба→труба."""
    toks = _type_tokens(query_name)
    if not toks:
        return True  # тип не опознали — не прячем (не наша вина)
    mn = _norm(matched_name)
    return any(t in mn for t in toks)


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
    dropped_type = 0
    for sid, cands in by_spec.items():
        cands.sort(key=lambda c: (c["match_score"] or 0), reverse=True)
        top = cands[0]["match_score"] or 0
        band = [c for c in cands if (c["match_score"] or 0) >= top - BAND]
        best = min(band, key=lambda c: c["_cmp"])
        pmin = min(c["_cmp"] for c in band)
        pmax = max(c["_cmp"] for c in band)
        base = base_by_id.get(sid)
        base_cmp = comparable(base["price"], True, 22) if base else None
        pos = pos_by_id.get(sid, {})
        qname = pos.get("name") or best["query_name"]
        # «Экономию %» заявляем ТОЛЬКО при уверенном совпадении ТИПА (опознан и совпал
        # у запроса и кандидата). Иначе матч держится на случайном общем слове —
        # и «−78%» выходит ложной (напр. «Фланец обратный» ↔ «Обратный клапан»).
        qt, ct = nz.product_type(qname), nz.product_type(best["name"])
        type_ok = qt is not None and qt == ct
        delta = round(100 * (base_cmp - best["_cmp"]) / base_cmp, 1) if (base_cmp and top >= CONFIDENT and type_ok) else None
        status = "точное" if top >= 0.66 else "проверить"
        # Фильтр слоя ОТЧЁТА (не матчинг): прячем матчи другого типа товара
        # (изоляция→кронштейн, тройник→ниппель) — они противоречат подписи «тот же тип».
        if not _type_consistent(pos.get("name") or best["query_name"], best["name"]):
            dropped_type += 1
            continue
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
    if dropped_type:
        print(f"  фильтр отчёта: скрыто матчей другого типа — {dropped_type}")
    items.sort(key=lambda i: (i["delta"] is None, -(i["delta"] or 0), i["name"]))
    return {"project_id": project_id, "snapshot": snap, "sources": srcs,
            "src_names": _source_names(), "items": items}


def _render(data: dict) -> str:
    e = html.escape
    items = data["items"]
    names = data["src_names"]
    n = len(items)
    n_eco = sum(1 for i in items if i["delta"] and i["delta"] > 0)
    # Блок «Цена счёта / Экономия» показываем ТОЛЬКО при наличии уверенной экономии:
    # иначе (как при одной случайной базе) колонки сплошь «—» и лишь путают — а цель
    # этой страницы — понятность. has_base = «есть что показать в блоке экономии».
    has_base = n_eco > 0

    # Заголовки колонок — без пустых, если базы из счёта нет.
    heads = ["<th>Позиция</th>"]
    if has_base:
        heads.append('<th style="text-align:right">Цена счёта</th>')
    heads.append('<th style="text-align:right">Дешевле всего</th>')
    heads.append("<th>Источник · что нашли</th>")
    if has_base:
        heads.append('<th style="text-align:right">Экономия</th>')
    heads.append("<th>Статус</th>")
    head_html = "".join(heads)

    rows = []
    for i in items:
        label, badge = STATUS_VIEW.get(i["status"], (i["status"], "background:#eee;color:#444"))
        rng = ("" if i["pmin"] == i["pmax"]
               else f"<div class='dim'>рынок {_rub(i['pmin'])}–{_rub(i['pmax'])}</div>")
        link = (f"<a href='{e(i['best_url'])}' target='_blank' rel='noopener' class='lnk'>↗ сверить</a>"
                if i["best_url"] and str(i["best_url"]).startswith("http") else "")
        cells = [f"<td>{e(i['name'])}<div class='dim'>{e(i['unit'] or '')}</div></td>"]
        if has_base:
            delta = (f"<span style='color:#0f6e56;font-weight:500'>−{i['delta']}%</span>"
                     if i["delta"] and i["delta"] > 0 else
                     (f"<span style='color:#a32d2d'>+{abs(i['delta'])}%</span>" if i["delta"] else "—"))
            cells.append(f"<td style='text-align:right'>{_rub(i['invoice_price'])}"
                         f"<div class='dim'>{e(i['invoice_supplier'] or '')}</div></td>")
        cells.append(f"<td style='text-align:right'>{_rub(i['best_price'])} {link}{rng}</td>")
        cells.append(f"<td>{e(names.get(i['best_source'], i['best_source']))}<div class='dim'>{e(i['best_name'] or '')}</div></td>")
        if has_base:
            cells.append(f"<td style='text-align:right'>{delta}</td>")
        cells.append(f"<td><span class='badge' style='{badge}'>{label}</span></td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    rows_html = "\n".join(rows) or f"<tr><td colspan='{len(heads)}'>Нет данных — запусти сбор (run.py)</td></tr>"

    cards = [f"<div class='card'><div class='l'>Позиций с ценой</div><div class='v'>{n}</div></div>"]
    if has_base:
        cards.append(f"<div class='card'><div class='l'>Где есть экономия</div><div class='v'>{n_eco}</div></div>")
    cards.append(f"<div class='card'><div class='l'>Источников</div><div class='v'>{len(data['sources'])}</div></div>")
    cards_html = "".join(cards)

    sources = ", ".join(names.get(s, s) for s in data["sources"]) or "—"
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Где дешевле — внешние цены ({e(data['snapshot'])})</title>
<style>
 body{{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a;margin:0;background:#fff;padding:24px;max-width:1000px}}
 h1{{font-size:22px;font-weight:500;margin:0 0 4px}}
 .sub{{color:#666;font-size:14px;margin-bottom:14px}}
 .intro{{background:#f7f6f2;border:1px solid #eceae3;border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.6;margin-bottom:18px}}
 .intro b{{font-weight:600}}
 .cards{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}}
 .card{{background:#f1efe8;border-radius:8px;padding:12px 16px}}
 .card .l{{font-size:13px;color:#666}} .card .v{{font-size:22px;font-weight:500}}
 table{{width:100%;border-collapse:collapse;font-size:13px}}
 th{{text-align:left;color:#666;font-weight:500;font-size:12px;border-bottom:1px solid #ddd;padding:8px 10px}}
 td{{border-bottom:1px solid #f0f0f0;padding:9px 10px;vertical-align:top}}
 .dim{{font-size:11px;color:#888}}
 .badge{{font-size:12px;padding:2px 8px;border-radius:6px;white-space:nowrap}}
 .lnk{{color:#185fa5;text-decoration:none;white-space:nowrap}}
 .note{{margin-top:16px;font-size:12px;color:#888;line-height:1.6}}
</style></head><body>
<h1>Где дешевле — цены поставщиков из открытых источников</h1>
<div class="sub">Проект #{data['project_id']} · срез {e(data['snapshot'])} · источники: {e(sources)}</div>
<div class="intro">
 <b>Что это.</b> Снимок публичных цен поставщиков по позициям проекта — видно рыночную цену каждой вещи и у кого она дешевле всего сегодня. Цены берём с официальных сайтов и прайсов, без скидок личного кабинета.<br>
 <b>Как проверить.</b> В колонке «Источник · что нашли» — что именно подобрала система. Нажмите <b>↗ сверить</b> — откроется карточка или прайс поставщика, убедитесь, что это тот самый товар. «рынок …–…» — разброс цен по этому типу и размеру.
</div>
<div class="cards">
  {cards_html}
</div>
<table>
<thead><tr>{head_html}</tr></thead>
<tbody>
{rows_html}
</tbody></table>
<div class="note">
 Снимок публичных базовых цен (без индивидуальных скидок личного кабинета — их при необходимости добавляем как % на поставщика).<br>
 Ярлык <b>совпадает</b> — система уверена в подборе; <b>похоже, сверьте по ссылке</b> — тот же тип и размер, но конкретный вариант стоит сверить вручную по ссылке ↗.
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
