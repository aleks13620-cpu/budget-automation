"""
Отчёт «Сравнение цен поставщиков по счетам проекта».

Тянет счета одного проекта из прод-API budget-automation, группирует позиции по
типу товара и характерному размеру и honestly раскладывает на три корзины:
  ЗЕЛЁНЫЙ  — тот же товар (совпал ещё и бренд/модель/артикул) у 2+ поставщиков —
             тут и только тут считаем экономию;
  ЖЁЛТЫЙ   — тип+размер совпали, а бренд/модель разные — просто показываем цены
             рядом, экономию не считаем и не называем;
  СЕРЫЙ    — купить не у кого сравнить (один поставщик) — просто строка.

Только стандартная библиотека (urllib/json/re/html) — ничего ставить не нужно.
Результат — самодостаточный HTML (out/invoice-compare.html), без внешних ссылок.

Запуск:
    python invoice_compare.py [--base-url URL] [--project-id N] [--out PATH]
    python invoice_compare.py --selfcheck
"""
from __future__ import annotations

import argparse
import difflib
import html
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DEFAULT_BASE_URL = "http://109.73.206.178:3001"
DEFAULT_PROJECT_ID = 12
DEFAULT_OUT = str(Path(__file__).resolve().parents[1] / "out" / "invoice-compare.html")
TIMEOUT = 30
PROJECT_TITLE = "ЖК у БКК ОВ"
CLIENT_TITLE = "Арта ИС, Самара"


# ============================== HTTP ==============================

def fetch_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": "invoice-compare/1.0"})
    with urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_invoices(base_url: str, project_id: int) -> list[dict]:
    d = fetch_json(f"{base_url}/api/projects/{project_id}/invoices")
    return d.get("invoices") if d.get("invoices") is not None else (d.get("data") or [])


def get_invoice_items(base_url: str, invoice_id: int) -> list[dict]:
    d = fetch_json(f"{base_url}/api/invoices/{invoice_id}")
    items = d.get("items")
    if items is None:
        data = d.get("data") or {}
        items = data.get("items") or (d.get("invoice") or {}).get("items")
    return items or []


# ============================== Классификация ==============================

# Тип товара — по вхождению стема (с учётом русских окончаний) в имя.
# Порядок важен: более узкие/составные стемы проверяются раньше общих
# (напр. «балансиров» раньше «клапан», «воздухоотводчик» раньше «отвод»).
TYPE_STEMS = [
    ("кран шаровой", "кран шаров"),
    ("воздухоотводчик", "воздухоотводчик"),
    ("виброизолятор", "виброизолятор"),
    ("балансировочный клапан", "балансиров"),
    ("компенсатор", "компенсатор"),
    ("трубка", "трубк"),
    ("труба", "труба"),
    ("цилиндр", "цилиндр"),
    ("грунт", "грунт"),
    ("краска", "краск"),
    ("эмаль", "эмал"),
    ("конвектор", "конвектор"),
    ("завеса", "завес"),
    ("отвод", "отвод"),
    ("тройник", "тройник"),
    ("фильтр", "фильтр"),
    ("клапан", "клапан"),
    ("вентилятор", "вентилятор"),
    ("решётка", "решетк"),
    ("диффузор", "диффузор"),
    ("узел", "узел"),
    ("насос", "насос"),
    ("радиатор", "радиатор"),
    ("вставка", "вставк"),
    ("реле", "реле"),
    ("дроссель", "дроссел"),
    ("преобразователь", "преобразовател"),
    ("изоляция", "изоляц"),
    ("клей", "клей"),
    ("очиститель", "очистител"),
    ("лента", "лент"),
    ("скотч", "скотч"),
]


def _norm(s) -> str:
    return str(s or "").lower().replace("ё", "е")


def detect_type(name: str) -> str | None:
    n = _norm(name)
    for label, stem in TYPE_STEMS:
        if stem in n:
            return label
    return None


# Размер: (Ду|DN|D|Ø|∅)+2-3 цифры — приоритет; иначе пара NNNxNNN (х/x/*).
_SIZE_MARK_RE = re.compile(
    r"(?<![A-Za-zА-Яа-я0-9])(DN|Ду|ДУ|ду|Ø|∅|D)\.?\s*[:=]?\s*(\d{2,3})\b"
)
_SIZE_PAIR_RE = re.compile(r"(\d{2,4})\s*[xXхХ*×]\s*(\d{2,4})")


def detect_size(name: str) -> str | None:
    m = _SIZE_MARK_RE.search(name or "")
    if m:
        return f"DN{m.group(2)}"
    m = _SIZE_PAIR_RE.search(name or "")
    if m:
        return f"{m.group(1)}x{m.group(2)}"
    return None


# «Тот же товар» решаем побуквенным совпадением названия — не брендом/артикулом
# (бренд у обоих K-FLEX, но «K-ROCK ALU» и «K-ROCK ALU S» — разные исполнения,
# бренд их не различает и даёт ложные зелёные совпадения).
_LEADING_DIGIT_RE = re.compile(r"^\s*\d+")


def norm_name_key(raw_name: str) -> str:
    """Ключ для сравнения «тот же товар»: без ведущих цифр-артефактов OCR
    («4Клей…» -> «Клей…»), нижний регистр, схлопнутые пробелы."""
    s = _LEADING_DIGIT_RE.sub("", raw_name or "")
    s = s.lower().replace("ё", "е")
    return re.sub(r"\s+", " ", s).strip()


# Строки доставки/услуг — включая явный флаг и характерные слова. «Монтаж» —
# только когда это САМА услуга (монтаж/монтажа/монтажу/…), а не прилагательное
# в названии товара («лента монтажная» — это лента, а не работа).
_DELIVERY_RE = re.compile(r"достав|трансп\w*\s*расход|\bмонтаж(?:а|у|ом|е)?\b", re.I)


def is_delivery(item: dict) -> bool:
    if item.get("is_delivery"):
        return True
    return bool(_DELIVERY_RE.search(item.get("name") or ""))


def norm_unit(u) -> str:
    return re.sub(r"[^a-zA-Zа-яА-Я0-9]", "", str(u or "")).lower()


def norm_ws(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def diff_note(items: list[dict]) -> str | None:
    """Для пары похожих, но не идентичных названий — показать ЧЕМ именно они
    отличаются (не просто «разные модели»), чтобы инженер видел причину.
    Только для пары с высоким сходством строки — иначе шум длиннее пользы."""
    if len(items) != 2:
        return None
    a, b = items[0]["name_key"], items[1]["name_key"]
    sm = difflib.SequenceMatcher(None, a, b)
    if sm.ratio() < 0.75:
        return None
    da, db = [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        if a[i1:i2].strip():
            da.append(a[i1:i2].strip())
        if b[j1:j2].strip():
            db.append(b[j1:j2].strip())
    if not da and not db:
        return None
    return f"отличие в названии: «{' '.join(da) or '(ничего)'}» vs «{' '.join(db) or '(ничего)'}»"


# ============================== НДС ==============================

def to_gross(price: float, vat_rate, prices_include_vat) -> tuple[float | None, str]:
    """Цена «с НДС» + пометка, что с ней сделали. Не додумываем, если данных нет."""
    if price is None:
        return None, "нет цены"
    if prices_include_vat == 1 or prices_include_vat is True:
        return round(float(price), 2), "с НДС (из счёта)"
    if (prices_include_vat == 0 or prices_include_vat is False) and vat_rate:
        return round(float(price) * (1 + float(vat_rate) / 100), 2), f"приведено к НДС {vat_rate}%"
    return round(float(price), 2), "НДС не указан"


# ============================== Сбор позиций ==============================

def supplier_label(invoice: dict) -> str:
    name = norm_ws(invoice.get("supplier_name"))
    if name:
        return name
    return f"Поставщик (счёт №{invoice.get('invoice_number')} без названия)"


def collect_positions(base_url: str, project_id: int) -> tuple[list[dict], list[dict]]:
    """Вернуть (все нормализованные позиции, список счетов-метаданных)."""
    invoices = get_invoices(base_url, project_id)
    positions = []
    for inv in invoices:
        items = get_invoice_items(base_url, inv["id"])
        supplier = supplier_label(inv)
        for it in items:
            name = norm_ws(it.get("name"))
            price = it.get("price")
            gross, vat_note = to_gross(price, inv.get("vat_rate"), inv.get("prices_include_vat"))
            positions.append({
                "name": name,
                "raw_name": it.get("name") or "",
                "name_key": norm_name_key(it.get("name") or ""),
                "unit_raw": norm_ws(it.get("unit")),
                "unit_norm": norm_unit(it.get("unit")),
                "price_raw": price,
                "price_gross": gross,
                "vat_note": vat_note,
                "qty": it.get("quantity"),
                "article": it.get("article"),
                "is_delivery": is_delivery(it),
                "supplier": supplier,
                "invoice_number": inv.get("invoice_number"),
                "invoice_date": inv.get("invoice_date"),
                "type": detect_type(it.get("name") or ""),
                "size": detect_size(it.get("name") or ""),
            })
    return positions, invoices


# ============================== Группировка ==============================

def build_report(positions: list[dict]) -> dict:
    excluded_delivery = [p for p in positions if p["is_delivery"]]
    excluded_zero = [p for p in positions if not p["is_delivery"]
                      and (p["price_gross"] is None or p["price_gross"] <= 0)]
    kept = [p for p in positions if not p["is_delivery"]
            and p["price_gross"] is not None and p["price_gross"] > 0]

    # Тип не распознан -> сразу в серые: сравнивать не с чем, пока не знаем ЧТО это.
    # Иначе разные нераспознанные товары от разных поставщиков случайно попадут
    # в одну "группу" только потому, что оба не разобрались (ложное сходство).
    no_type = [p for p in kept if p["type"] is None]
    classified = [p for p in kept if p["type"] is not None]

    coarse: dict[tuple, list[dict]] = defaultdict(list)
    for p in classified:
        coarse[(p["type"], p["size"] or "—", p["unit_norm"])].append(p)

    green_groups, yellow_groups, grey_items = [], [], list(no_type)

    for (ptype, size, unit_norm), items in coarse.items():
        suppliers = {i["supplier"] for i in items}
        if len(suppliers) < 2:
            grey_items.extend(items)
            continue

        # ponytail: побуквенное совпадение названия — работает, пока поставщики
        # копируют номенклатуру производителя (K-FLEX). Для поставщиков со своим
        # написанием нужен артикул производителя как ключ.
        buckets: dict[str, list[dict]] = defaultdict(list)
        for i in items:
            buckets[i["name_key"]].append(i)

        remaining = []
        for key, bitems in buckets.items():
            bsup = {i["supplier"] for i in bitems}
            if len(bsup) >= 2:
                prices = [i["price_gross"] for i in bitems]
                pmin, pmax = min(prices), max(prices)
                cheapest = min(bitems, key=lambda i: i["price_gross"])
                overpay = sum((i["price_gross"] - pmin) * (i["qty"] or 0)
                              for i in bitems if i["price_gross"] > pmin)
                savings_pct = round((pmax - pmin) / pmax * 100, 1) if pmax else 0.0
                green_groups.append({
                    "type": ptype, "size": size, "unit": bitems[0]["unit_raw"],
                    "common_name": bitems[0]["name"], "items": sorted(bitems, key=lambda i: i["price_gross"]),
                    "price_min": pmin, "price_max": pmax, "savings_pct": savings_pct,
                    "overpay": round(overpay, 2), "cheapest_supplier": cheapest["supplier"],
                })
            else:
                remaining.extend(bitems)

        rem_suppliers = {i["supplier"] for i in remaining}
        if len(rem_suppliers) >= 2:
            prices = [i["price_gross"] for i in remaining]
            ratio = round(max(prices) / min(prices), 1) if min(prices) else None
            yellow_groups.append({
                "type": ptype, "size": size, "unit": remaining[0]["unit_raw"],
                "items": sorted(remaining, key=lambda i: i["price_gross"]),
                "ratio": ratio,
                "diff_note": diff_note(remaining),
            })
        else:
            grey_items.extend(remaining)

    green_groups.sort(key=lambda g: -g["overpay"])
    total_overpay = round(sum(g["overpay"] for g in green_groups), 2)

    return {
        "total_positions": len(positions),
        "excluded_delivery": len(excluded_delivery),
        "excluded_zero": len(excluded_zero),
        "coarse_groups": len(coarse),
        "multi_supplier_coarse_groups": sum(1 for items in coarse.values()
                                             if len({i["supplier"] for i in items}) >= 2),
        "green_groups": green_groups,
        "yellow_groups": yellow_groups,
        "grey_items": sorted(grey_items, key=lambda i: (i["type"] or "", i["size"] or "", i["name"])),
        "total_overpay": total_overpay,
    }


# ============================== Вопросы к инженеру ==============================

def engineer_questions(green_groups: list[dict], yellow_groups: list[dict]) -> list[str]:
    """Находки, которые важнее самих цифр — для показа инженеру человеческим языком.
    Считаются из тех же green/yellow групп, а не хардкодятся под один прогон."""
    qs = []

    # 1) Один тип встречается и зелёным, и жёлтым — значит на части размеров у
    # поставщика другое исполнение/модификация, чем на остальных (см. diff_note).
    green_types = {g["type"] for g in green_groups}
    variant_yellows = [g for g in yellow_groups if g["type"] in green_types and g.get("diff_note")]
    if variant_yellows:
        sizes = ", ".join(g["size"] for g in variant_yellows)
        example = variant_yellows[0]["diff_note"]
        qs.append(
            f"На размерах {sizes} ({variant_yellows[0]['type']}) в счёте другое исполнение, чем на "
            f"остальных размерах того же типа ({example}). Уточните: так и задумано, или в заказ "
            f"попало не то — исполнения обычно отличаются по цене."
        )

    # 2) Внутри одной пары поставщиков одна и та же пара обычно даёт похожую разницу
    # в цене (%). Позиция, где разница резко выбивается из этого ряда, — вероятная
    # ошибка в счёте или цена "наугад" (позиция, которую поставщик не возит).
    by_pair: dict[frozenset, list[dict]] = defaultdict(list)
    for g in green_groups:
        if len(g["items"]) == 2:
            by_pair[frozenset(i["supplier"] for i in g["items"])].append(g)
    for pair, groups in by_pair.items():
        if len(groups) < 3:
            continue
        sup_a, sup_b = sorted(pair)

        def ratio(g, a=sup_a, b=sup_b):  # цена b / цена a — фиксированное направление
            price = {i["supplier"]: i["price_gross"] for i in g["items"]}
            return price[b] / price[a]

        # r = цена(b) / цена(a). r>1 -> b дороже, a дешевле на (1 - a/b) = (1 - 1/r).
        # r<1 -> a дороже, b дешевле на (1 - b/a) = (1 - r).
        def cheaper_and_pct(r):
            if r > 1:
                return sup_a, round((1 - 1 / r) * 100, 1)
            return sup_b, round((1 - r) * 100, 1)

        ratios = sorted(ratio(g) for g in groups)
        median = ratios[len(ratios) // 2]
        typ_cheaper, typ_pct = cheaper_and_pct(median)
        for g in groups:
            r = ratio(g)
            if abs(r - median) <= 0.15 * median:
                continue
            this_cheaper, this_pct = cheaper_and_pct(r)
            qs.append(
                f"«{g['common_name']}» ({g['type']}, {g['size']}): здесь дешевле {this_cheaper} "
                f"(на {this_pct}%), хотя на остальных {len(groups) - 1} похожих позициях у тех же "
                f"двух поставщиков обычно дешевле {typ_cheaper} — и всего на {typ_pct}%. Один такой "
                f"выброс на фоне ровного ряда — стоит проверить перед закупкой (на этой строке "
                f"{_money(g['overpay'])} из общей переплаты по зелёным)."
            )
    return qs


# ============================== HTML ==============================

def _money(v) -> str:
    if v is None:
        return "—"
    return f"{v:,.2f}".replace(",", " ").replace(".", ",") + " ₽"


def _e(s) -> str:
    return html.escape(str(s if s is not None else ""))


def render_html(report: dict, invoices: list[dict], base_url: str, project_id: int) -> str:
    suppliers = sorted({norm_ws(i.get("supplier_name")) or supplier_label(i) for i in invoices})
    dates = sorted({i.get("invoice_date") for i in invoices if i.get("invoice_date")})

    green_rows = []
    for g in report["green_groups"]:
        rows = "".join(
            f"<tr class='{'best' if it['price_gross'] == g['price_min'] else ''}'>"
            f"<td>{_e(it['supplier'])}</td><td>{_e(it['name'])}</td>"
            f"<td>№{_e(it['invoice_number'])}</td>"
            f"<td class='num'>{_money(it['price_gross'])}</td>"
            f"<td>{_e(it['vat_note'])}</td></tr>"
            for it in g["items"]
        )
        green_rows.append(f"""
<div class="group">
  <h3>{_e(g['type'])}, {_e(g['size'])} — <span class="brand">{_e(g['common_name'])}</span></h3>
  <p class="meta">Единица: {_e(g['unit'])} · разброс цен {_money(g['price_min'])} – {_money(g['price_max'])}
     · <b>экономия {g['savings_pct']}%</b> · переплата у остальных: <b>{_money(g['overpay'])}</b>
     · дешевле всех — {_e(g['cheapest_supplier'])}</p>
  <table>
    <tr><th>Поставщик</th><th>Товар в счёте</th><th>Счёт</th><th>Цена</th><th>НДС</th></tr>
    {rows}
  </table>
</div>""")

    yellow_rows = []
    for g in report["yellow_groups"]:
        rows = "".join(
            f"<tr><td>{_e(it['supplier'])}</td><td>{_e(it['name'])}</td>"
            f"<td>№{_e(it['invoice_number'])}</td>"
            f"<td class='num'>{_money(it['price_gross'])}</td>"
            f"<td>{_e(it['vat_note'])}</td></tr>"
            for it in g["items"]
        )
        ratio_txt = f"дороже в {g['ratio']} раза" if g["ratio"] else ""
        note_txt = f" · {_e(g['diff_note'])}" if g.get("diff_note") else ""
        yellow_rows.append(f"""
<div class="group">
  <h3>{_e(g['type'])}, {_e(g['size'])}</h3>
  <p class="meta">Единица: {_e(g['unit'])} · разные модели одного размера, решать вам · {ratio_txt}{note_txt}</p>
  <table>
    <tr><th>Поставщик</th><th>Товар в счёте</th><th>Счёт</th><th>Цена</th><th>НДС</th></tr>
    {rows}
  </table>
</div>""")

    questions = engineer_questions(report["green_groups"], report["yellow_groups"])
    questions_html = ("<ol>" + "".join(f"<li>{_e(q)}</li>" for q in questions) + "</ol>") if questions \
        else "<p>Ничего настораживающего не нашлось.</p>"

    grey_rows = "".join(
        f"<tr><td>{_e(i['type'] or '—')}</td><td>{_e(i['size'] or '—')}</td>"
        f"<td>{_e(i['supplier'])}</td><td>{_e(i['name'])}</td><td>№{_e(i['invoice_number'])}</td>"
        f"<td class='num'>{_money(i['price_gross'])}</td><td>{_e(i['unit_raw'])}</td></tr>"
        for i in report["grey_items"]
    )

    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Сравнение цен поставщиков — {_e(PROJECT_TITLE)}</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, Arial, sans-serif; color:#1a1a1a; background:#fff;
         max-width:1100px; margin:24px auto; padding:0 16px; line-height:1.5; }}
  h1 {{ font-size:22px; margin-bottom:4px; }}
  h2 {{ font-size:18px; border-bottom:2px solid #ddd; padding-bottom:6px; margin-top:36px; }}
  h3 {{ font-size:15px; margin:0 0 4px; }}
  .intro {{ background:#f6f7f9; border-radius:8px; padding:14px 18px; margin:14px 0; font-size:14px; }}
  .intro p {{ margin:6px 0; }}
  .warn {{ color:#854f0b; }}
  .stats {{ display:flex; flex-wrap:wrap; gap:12px; margin:16px 0; }}
  .stat {{ background:#f6f7f9; border-radius:8px; padding:10px 16px; min-width:150px; }}
  .stat b {{ display:block; font-size:20px; }}
  .stat.green {{ background:#e1f5ee; }}
  .stat.yellow {{ background:#faeeda; }}
  .stat.grey {{ background:#eee; }}
  table {{ border-collapse:collapse; width:100%; margin:8px 0 18px; font-size:13px; }}
  th, td {{ border:1px solid #ddd; padding:5px 8px; text-align:left; }}
  th {{ background:#f0f1f3; }}
  td.num {{ text-align:right; white-space:nowrap; }}
  tr.best td {{ background:#e1f5ee; font-weight:600; }}
  .group {{ margin-bottom:22px; }}
  .meta {{ font-size:13px; color:#444; margin:2px 0 6px; }}
  .brand {{ color:#0f6e56; font-weight:600; }}
  details {{ margin-top:10px; }}
  summary {{ cursor:pointer; font-weight:600; padding:6px 0; }}
  @media print {{ body {{ margin:0; }} .group {{ page-break-inside:avoid; }} }}
</style></head>
<body>

<h1>Сравнение цен поставщиков по счетам проекта «{_e(PROJECT_TITLE)}»</h1>
<p class="meta">Заказчик: {_e(CLIENT_TITLE)}</p>

<div class="intro">
  <p>Это сравнение цен на одинаковые и похожие материалы у разных поставщиков — собрано
     автоматически из {_e(len(invoices))} счетов от {_e(len(suppliers))} поставщиков по проекту
     «{_e(PROJECT_TITLE)}» (даты счетов: {_e(', '.join(dates))}).</p>
  <p><b>Зелёное</b> — это точно один и тот же товар: название в счетах совпало слово в слово
     у двух и более поставщиков (мелкие опечатки распознавания не в счёт). Тут посчитана честная экономия.</p>
  <p class="warn"><b>Жёлтое</b> — похожие товары одного типа и размера, но разных моделей: цены рядом
     для сравнения, но экономию мы не считаем — решать вам, подходит ли замена.</p>
  <p><b>Серое</b> (внизу, свёрнуто) — товар встретился только у одного поставщика, сравнивать не с чем.</p>
</div>

<div class="stats">
  <div class="stat"><b>{report['total_positions']}</b>позиций в счетах</div>
  <div class="stat"><b>{report['excluded_delivery'] + report['excluded_zero']}</b>исключено (доставка/монтаж: {report['excluded_delivery']}, без цены: {report['excluded_zero']})</div>
  <div class="stat"><b>{report['coarse_groups']}</b>групп «тип+размер» ({report['multi_supplier_coarse_groups']} — у 2+ поставщиков)</div>
  <div class="stat green"><b>{len(report['green_groups'])}</b>зелёных групп</div>
  <div class="stat yellow"><b>{len(report['yellow_groups'])}</b>жёлтых групп</div>
  <div class="stat grey"><b>{len(report['grey_items'])}</b>серых позиций</div>
  <div class="stat green"><b>{_money(report['total_overpay'])}</b>переплата по зелёным</div>
</div>

<h2>Зелёное — тот же товар у разных поставщиков</h2>
{''.join(green_rows) if green_rows else '<p>Совпадений с одинаковым брендом/моделью у разных поставщиков не нашлось.</p>'}

<h2>Жёлтое — похожие товары, разные модели</h2>
{''.join(yellow_rows) if yellow_rows else '<p>Групп с похожими, но разными моделями не нашлось.</p>'}

<h2>Серое — сравнивать не с кем (один поставщик)</h2>
<details>
  <summary>Показать {len(report['grey_items'])} позиций одного поставщика</summary>
  <table>
    <tr><th>Тип</th><th>Размер</th><th>Поставщик</th><th>Товар в счёте</th><th>Счёт</th><th>Цена</th><th>Ед.</th></tr>
    {grey_rows}
  </table>
</details>

<h2>Вопросы к инженеру</h2>
<div class="intro">
  {questions_html}
</div>

<p class="meta" style="margin-top:30px;color:#999;">Источник данных: {_e(base_url)}, проект id={project_id}. Отчёт сгенерирован автоматически, price-harvester/src/invoice_compare.py.</p>
</body></html>"""


# ============================== Самопроверка ==============================

def _mk(raw_name, price, supplier, invoice_number, qty=1) -> dict:
    """Собрать синтетическую позицию так же, как collect_positions() из API-ответа."""
    return {
        "name": norm_ws(raw_name), "raw_name": raw_name, "name_key": norm_name_key(raw_name),
        "unit_raw": "м", "unit_norm": "м", "price_raw": price, "price_gross": price,
        "vat_note": "с НДС", "qty": qty, "article": None, "is_delivery": False,
        "supplier": supplier, "invoice_number": invoice_number, "invoice_date": "",
        "type": detect_type(raw_name), "size": detect_size(raw_name),
    }


def _selfcheck() -> None:
    # (а) одинаковое название, разная цена -> зелёная группа, экономия посчиталась
    n = "Цилиндр K-FLEX 30x022-1 K-ROCK ALU S /20"
    r = build_report([
        _mk(n, 346.91, "Тёплый дом", "1"),
        _mk(n, 341.65, "Фрегат ЛТД", "2"),
    ])
    assert len(r["green_groups"]) == 1, "ожидалась ровно 1 зелёная группа"
    assert len(r["yellow_groups"]) == 0
    g = r["green_groups"][0]
    assert g["savings_pct"] > 0, "экономия должна быть посчитана"
    assert abs(g["price_min"] - 341.65) < 0.01

    # (б) тот же тип+размер, разные бренды -> жёлтая, экономия НЕ считается
    r2 = build_report([
        _mk("Решетка Рск 600х600", 1785, "Сигма-Вент", "3"),
        _mk("Решетка АЛН 600х600", 7188, "Поставщик X", "4"),
    ])
    assert len(r2["green_groups"]) == 0, "разные бренды не должны давать зелёную группу"
    assert len(r2["yellow_groups"]) == 1, "ожидалась 1 жёлтая группа"

    # (в) разные единицы измерения -> не сравниваются (обе остаются серыми)
    p_a = _mk("Кран шаровой Ду 25", 100, "Поставщик A", "5")
    p_b = _mk("Кран шаровой Ду 25", 900, "Поставщик B", "6")
    p_b["unit_raw"], p_b["unit_norm"] = "компл.", "компл"
    r3 = build_report([p_a, p_b])
    assert len(r3["green_groups"]) == 0 and len(r3["yellow_groups"]) == 0
    assert len(r3["grey_items"]) == 2, "разные единицы -> обе серые, не сравниваются между собой"

    # (г) тот же бренд+артикул, но разный хвост (исполнение) -> жёлтая, БЕЗ экономии
    r4 = build_report([
        _mk("Цилиндр K-FLEX 30x076-1 K-ROCK ALU /7", 537.17, "Тёплый дом", "7"),
        _mk("Цилиндр K-FLEX 30x076-1 K-ROCK ALU S /7", 845.86, "Фрегат ЛТД", "8"),
    ])
    assert len(r4["green_groups"]) == 0, "разный хвост исполнения (ALU / ALU S) — не зелёное"
    assert len(r4["yellow_groups"]) == 1, "ожидалась 1 жёлтая группа"
    assert r4["yellow_groups"][0]["diff_note"], "у похожей пары должно быть отличие в названии"

    # (д) ведущая цифра-артефакт OCR не мешает совпадению, а «R» в хвосте — мешает
    r5 = build_report([
        _mk("4Клей K-FLEX 2.6 lt K 414", 5172.81, "Тёплый дом", "9"),
        _mk("Клей K-FLEX 2.6 lt K 414", 4310.66, "Фрегат ЛТД", "10"),
    ])
    assert len(r5["green_groups"]) == 1, "«4Клей…» и «Клей…» — тот же товар после нормализации"
    r6 = build_report([
        _mk("4Клей K-FLEX 2.6 lt K 414", 5172.81, "Тёплый дом", "9"),
        _mk("Клей K-FLEX 2.6 lt K 414 R", 4310.66, "Фрегат ЛТД", "10"),
    ])
    assert len(r6["green_groups"]) == 0, "«K 414» и «K 414 R» — разная модификация, не зелёное"
    assert len(r6["yellow_groups"]) == 1

    print("SELFCHECK OK: (а) зелёная экономия посчитана, (б) жёлтая без экономии, "
          "(в) разные единицы не сравниваются, (г) разный хвост исполнения -> жёлтая, "
          "(д) цифра-артефакт не мешает совпадению, но «R» в хвосте — мешает")


# ============================== main ==============================

def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--project-id", type=int, default=DEFAULT_PROJECT_ID)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--selfcheck", action="store_true", help="прогнать самопроверку и выйти")
    args = ap.parse_args(argv)

    if args.selfcheck:
        _selfcheck()
        return

    try:
        positions, invoices = collect_positions(args.base_url, args.project_id)
    except URLError as e:
        raise SystemExit(f"Не достучались до {args.base_url}: {e}")

    report = build_report(positions)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        render_html(report, invoices, args.base_url, args.project_id), encoding="utf-8"
    )

    print(f"Счетов: {len(invoices)}, позиций: {report['total_positions']}, "
          f"групп тип+размер: {report['coarse_groups']} (из них у 2+ поставщиков: "
          f"{report['multi_supplier_coarse_groups']}), зелёных: {len(report['green_groups'])}, "
          f"жёлтых: {len(report['yellow_groups'])}, серых: {len(report['grey_items'])}, "
          f"переплата по зелёным: {report['total_overpay']}")
    print(f"-> {out_path}")


if __name__ == "__main__":
    main()
