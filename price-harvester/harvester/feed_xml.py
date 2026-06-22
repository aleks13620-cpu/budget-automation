"""
РЕЦЕПТ 3 — разбор каталожных XML/YML-фидов (вендорная копия из open-data-harvester,
расширенная под прайсы инженерки).

Где встречается: магазины и B2B-каталоги отдают «товарный фид» — XML со всем
каталогом (товары, цены, свойства) одним файлом. У рос. площадок это обычно
YML (Yandex Market Language): <yml_catalog><shop><offers><offer>…</offer>.
Это золотая жила: структурированные цены одним файлом, без скрейпинга карточек.

Приём «снять сырьё — парсить офлайн»: фид сначала скачиваем в файл (ядром
rest_client), затем разбираем из файла — переразбирать можно сколько угодно,
не дёргая источник, и хранить срез на дату.

К базовому рецепту (схемы A/B) добавлен parse_yml_offers() — он понимает YML:
vendor (производитель), vendorCode (артикул), <param name=…> (DN и пр.), цену,
валюту, наличие. Имена тегов — стандарт YML; под нестандартный фид правь маппинг.
"""
from __future__ import annotations

import os
from pathlib import Path

from lxml import etree

from rest_client import provenance, request

OUT = Path(os.environ.get("OUT_DIR", "out"))


def download_feed(feed_url: str, dest: Path | None = None) -> Path:
    """Скачать фид в файл (через ядро: ретраи + кэш сырья). Возвращает путь к сырью."""
    OUT.mkdir(parents=True, exist_ok=True)
    resp = request("GET", feed_url, accept="application/xml")
    raw = dest or (OUT / "feed.xml")
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_bytes(resp.content)
    print(f"  фид сохранён: {raw} ({len(resp.content)} байт)")
    return raw


def parse_yml_offers(xml_path: Path, source_url: str, source_label: str) -> list[dict]:
    """
    Разобрать YML-фид в единые записи цен. Возвращает список offer'ов с полями,
    готовыми к укладке в external_prices. Цена/валюта/наличие/артикул/производитель
    + сырьё (raw_data) + провенанс на каждой записи.
    """
    parser = etree.XMLParser(recover=True, huge_tree=True)
    tree = etree.parse(str(xml_path), parser)
    root = tree.getroot()

    # Словарь категорий id->имя (в YML categoryId в offer ссылается на <category id=..>).
    categories = {}
    for c in root.findall(".//category"):
        cid = c.get("id")
        if cid:
            categories[cid] = (c.text or "").strip()

    offers = root.findall(".//offer")
    records: list[dict] = []
    for o in offers:
        params = {}
        for p in o.findall("param"):
            nm = (p.get("name") or "").strip()
            if nm:
                params[nm] = (p.text or "").strip()

        price = _to_float(o.findtext("price"))
        cat_id = o.findtext("categoryId")
        name = (o.findtext("name") or o.findtext("model") or "").strip()
        # У части фидов имя собирают из typePrefix + vendor + model.
        if not name:
            name = " ".join(
                x for x in [o.findtext("typePrefix"), o.findtext("vendor"), o.findtext("model")]
                if x
            ).strip()

        available_attr = o.get("available")
        in_stock = None
        if available_attr is not None:
            in_stock = 1 if available_attr.lower() == "true" else 0

        rec = {
            "natural_key": o.get("id") or o.findtext("vendorCode") or name,
            "name": name or None,
            "article": (o.findtext("vendorCode") or "").strip() or None,
            "manufacturer": (o.findtext("vendor") or "").strip() or None,
            "price": price,
            "currency": (o.findtext("currencyId") or "RUB").strip() or "RUB",
            "unit": (params.get("Единица измерения") or params.get("Ед. изм.") or None),
            "url": (o.findtext("url") or "").strip() or None,
            "category": categories.get(cat_id) if cat_id else None,
            "in_stock": in_stock,
            "params": params,
        }
        rec["raw_data"] = {
            "offer_id": o.get("id"),
            "available": available_attr,
            "categoryId": cat_id,
            "children": {c.tag: (c.text or "").strip() for c in o if c.tag != "param"},
            "params": params,
        }
        # Провенанс: точный URL карточки, если есть, иначе адрес фида.
        rec.update(provenance(rec["url"] or source_url, source_label=source_label))
        records.append(rec)

    print(f"  YML: разобрано предложений: {len(records)}")
    return records


def _to_float(v):
    if v is None:
        return None
    try:
        return float(str(v).replace(",", ".").replace(" ", ""))
    except (TypeError, ValueError):
        return None
