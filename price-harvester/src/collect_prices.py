"""
ШАГ 3 — сбор цен через рецепты open-data-harvester.

Поток на источник: чек-лист этики (robots/ToS) → СНЯТЬ СЫРЬЁ (фид в файл) →
ПАРСИТЬ ОФЛАЙН → сопоставить предложения с позициями пилота (лёгкий скоринг) →
записи с провенансом. Пустая позиция помечается not_found (НЕ выдумываем цену).

Предпочтение — feed_xml (YML-фид: один файл, вежливо). rest_html на пилоте не
используем (нужен индивидуальный парсер карточек). Антибот — отдельная ступень
(см. references/anti_bot.md), включается только если иначе данные не отдаются.
"""
from __future__ import annotations

import json
import os
import re
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import yaml

import common          # грузит .env + кладёт harvester/ в sys.path (ДО импорта rest_client)
import normalize as nz
import rest_client
import feed_xml

TOP_N = int(os.environ.get("TOP_N_OFFERS", "3"))
MATCH_THRESHOLD = float(os.environ.get("MATCH_THRESHOLD", "0.55"))


def load_sources_map() -> dict[str, dict]:
    cfg = yaml.safe_load((common.ROOT / "config" / "sources.yaml").read_text(encoding="utf-8"))
    return {s["key"]: s for s in cfg.get("sources", []) or []}


def check_robots(url: str) -> bool | None:
    """Вежливо тянем robots.txt и спрашиваем can_fetch. True/False/None(неизвестно)."""
    try:
        pr = urlparse(url)
        robots_url = f"{pr.scheme}://{pr.netloc}/robots.txt"
        resp = rest_client.request("GET", robots_url, accept="text/plain")
        rp = RobotFileParser()
        rp.parse(resp.text.splitlines())
        return rp.can_fetch(rest_client.USER_AGENT, url)
    except Exception as exc:  # noqa: BLE001
        print(f"    robots.txt не прочитан ({exc}) — считаем неизвестным")
        return None


def _resolve_xlsx_from_page(page_url: str) -> str | None:
    """Найти ссылку на свежий .xlsx-прайс на странице прайса (URL датирован → меняется)."""
    try:
        html = rest_client.request("GET", page_url, accept="text/html").text
    except Exception as exc:  # noqa: BLE001
        print(f"    страница прайса не прочитана ({exc})")
        return None
    from urllib.parse import urljoin
    hrefs = re.findall(r'href=["\']([^"\']+\.xlsx[^"\']*)["\']', html, re.I)
    if not hrefs:
        return None
    hrefs.sort(key=lambda h: (0 if "price" in h.lower() or "прайс" in h.lower() else 1, -len(h)))
    resolved = urljoin(page_url, hrefs[0])
    # SSRF-защита: качаем прайс только с того же хоста, что и страница прайса.
    if urlparse(resolved).netloc != urlparse(page_url).netloc:
        return None
    return resolved


def _params_of(offer: dict) -> dict:
    rd = offer.get("raw_data") or {}
    return rd.get("params") or offer.get("params") or {}


def _extract_extra(offer: dict) -> dict:
    params = _params_of(offer)

    def num(*keys):
        for k in keys:
            if k in params and params[k]:
                m = re.search(r"[\d.,]+", str(params[k]))
                if m:
                    return float(m.group(0).replace(",", "."))
        return None

    lead = num("Срок поставки, дн", "Срок поставки")
    return {
        "min_batch": num("Минимальная партия", "Мин. партия", "Кратность"),
        "lead_time_days": int(lead) if lead is not None else None,
    }


def offers_for_source(src: dict) -> tuple[list[dict], str, str]:
    """Вернуть (offers, status, note). status: ok | blocked."""
    recipe = src.get("recipe")
    label = src["key"]

    if recipe == "offline":
        path = common.ROOT / src["local_feed"]
        if not path.exists():
            return [], "blocked", f"нет файла образца: {path}"
        return feed_xml.parse_yml_offers(path, path.as_uri(), label), "ok", "офлайн-образец"

    if recipe == "feed_xml":
        if not (src.get("robots_checked") and src.get("tos_ok")):
            return [], "blocked", "не пройден чек-лист: robots_checked/tos_ok=false (см. config/sources.yaml)"
        url = src["feed_url"]
        allowed = check_robots(url)
        if allowed is False:
            return [], "blocked", "robots.txt запрещает этот путь"
        dest = common.OUT / f"feed_{label}.xml"
        try:
            feed_xml.download_feed(url, dest)      # снять сырьё (ядро кэширует)
        except Exception as exc:  # noqa: BLE001  обрыв сети не должен валить весь прогон
            return [], "blocked", f"источник недоступен: {exc}"
        return feed_xml.parse_yml_offers(dest, url, label), "ok", "сетевой YML-фид"

    if recipe == "price_xlsx":
        if not (src.get("robots_checked") and src.get("tos_ok")):
            return [], "blocked", "не пройден чек-лист: robots_checked/tos_ok=false (см. config/sources.yaml)"
        # Ссылка на прайс датирована и меняется — берём свежую со страницы прайса.
        url = src.get("price_url")
        if src.get("price_page"):
            resolved = _resolve_xlsx_from_page(src["price_page"])
            if resolved:
                url = resolved
        if not url:
            return [], "blocked", "не нашли ссылку на .xlsx (проверь price_page/price_url)"
        if check_robots(url) is False:
            return [], "blocked", "robots.txt запрещает этот путь"
        import price_xlsx
        dest = common.OUT / f"price_{label}.xlsx"
        try:
            resp = rest_client.request("GET", url, accept="application/octet-stream")  # снять сырьё
            dest.write_bytes(resp.content)
        except Exception as exc:  # noqa: BLE001  обрыв сети не должен валить весь прогон
            return [], "blocked", f"источник недоступен: {exc}"
        offers = price_xlsx.parse_price_xlsx(dest, url, label, src.get("sheets"), brand=src.get("brand"))
        return offers, "ok", f"официальный XLSX-прайс ({url.rsplit('/', 1)[-1]})"

    if recipe == "rest_html":
        if not (src.get("robots_checked") and src.get("tos_ok")):
            return [], "blocked", "не пройден чек-лист: robots_checked/tos_ok=false (см. config/sources.yaml)"
        urls = src.get("list_urls") or ([src["list_url"]] if src.get("list_url") else [])
        if not urls:
            return [], "blocked", "не заданы list_urls"
        if check_robots(urls[0]) is False:
            return [], "blocked", "robots.txt запрещает этот путь"
        import rest_html
        return rest_html.collect(src), "ok", "карточки сайта (schema.org)"

    return [], "blocked", f"неизвестный recipe={recipe}"


def _record(project_id, pos, src, off, score, snap, status, vat_incl, vat_rate, extra=None) -> dict:
    extra = extra or {}
    name = (off.get("name") if off else None) or pos["name"]
    article = off.get("article") if off else None
    unit = (off.get("unit") if off else None) or pos.get("unit")
    keyname = article or nz.canon(name)
    # Бизнес-ключ = источник | позиция | артикул/имя | единица | дата среза.
    # Идемпотентно в пределах дня; другой день = новая строка (история цен).
    business_key = f"{src['key']}|{pos['spec_item_id']}|{keyname}|{unit or ''}|{snap}"
    return {
        "business_key": business_key,
        "project_id": project_id,
        "spec_item_id": pos["spec_item_id"],
        "query_name": pos["name"],
        "source": src["key"],
        "source_url": (off.get("source_url") if off else None)
                      or src.get("feed_url") or src.get("local_feed") or src["key"],
        "snapshot_date": snap,
        "supplier_name": src.get("supplier_name"),
        "manufacturer": (off.get("manufacturer") if off else None) or pos.get("manufacturer"),
        "article": article,
        "name": name,
        "unit": unit,
        "price": off.get("price") if off else None,
        "currency": (off.get("currency") if off else "RUB") or "RUB",
        "vat_included": vat_incl,
        "vat_rate": vat_rate,
        "min_batch": extra.get("min_batch"),
        "lead_time_days": extra.get("lead_time_days"),
        "in_stock": off.get("in_stock") if off else None,
        "match_score": round(score, 3),
        "status": status,
        "raw_data": json.dumps(off.get("raw_data"), ensure_ascii=False) if off and off.get("raw_data") else None,
    }


def collect() -> list[dict]:
    plan_doc = common.read_out_json("source_plan.json")
    smap = load_sources_map()
    pos_by_id = {p["spec_item_id"]: p for p in plan_doc["pilot_positions"]}
    project_id, snap = plan_doc["project_id"], plan_doc["snapshot_date"]

    records: list[dict] = []
    source_status: list[dict] = []

    for entry in plan_doc["plan"]:
        src = smap[entry["source_key"]]
        offers, status, note = offers_for_source(src)
        source_status.append({"source": src["key"], "status": status, "note": note, "offers": len(offers)})
        print(f"  источник {src['key']}: {status} — {note} (offers={len(offers)})")

        vat_incl = 1 if src.get("vat_included", True) else 0
        vat_rate = src.get("vat_rate")

        for spec_id in entry["positions"]:
            pos = pos_by_id[spec_id]
            scored = []
            for off in offers:
                if not off.get("name") or off.get("price") is None:
                    continue
                cand_dn = off.get("dn")
                if cand_dn is None:
                    cand_dn = nz.extract_dn(off["name"])
                s = nz.score(pos["name"], off["name"], pos.get("dn"), cand_dn)
                if s >= MATCH_THRESHOLD:
                    scored.append((s, off))
            scored.sort(key=lambda t: t[0], reverse=True)

            if not scored and status == "ok":
                records.append(_record(project_id, pos, src, None, 0.0, snap, "not_found", vat_incl, vat_rate))
            for s, off in scored[:TOP_N]:
                records.append(_record(project_id, pos, src, off, s, snap, "found", vat_incl, vat_rate, _extract_extra(off)))

    (common.OUT / "external_prices.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    (common.OUT / "collect_status.json").write_text(
        json.dumps(source_status, ensure_ascii=False, indent=2), encoding="utf-8")

    found = sum(1 for r in records if r["status"] == "found")
    print(f"ШАГ 3 — записей: {len(records)} (найдено цен: {found}) → out/external_prices.json")
    return records


if __name__ == "__main__":
    collect()
