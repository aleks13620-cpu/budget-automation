"""
Рецепт rest_html — разбор карточек товара на сайте (когда нет файла-прайса/фида).

Опора на МИКРОРАЗМЕТКУ schema.org (itemprop name/price/sku): она стабильнее вёрстки
и есть на многих магазинах. Снимаем страницы списка (с пагинацией ?p=), парсим
офлайн. Цена 0/пусто = «по запросу» → пропускаем (не выдумываем).

Конфиг источника (sources.yaml):
  list_urls   — страницы-списки категорий;
  max_pages   — сколько страниц пагинации пройти (по умолчанию 1);
  brand       — производитель для провенанса;
  dn_regex    — (опц.) как достать DN из имени, напр. "СВ-(\\d{2,3})";
  article_regex — (опц.) как достать артикул из имени, если нет itemprop=sku.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

import common  # noqa: F401  (путь к harvester + .env до импорта rest_client)
import normalize as nz
import rest_client


def _itemprop(node, key: str) -> str | None:
    el = node.find(attrs={"itemprop": key})
    if not el:
        return None
    return (el.get("content") or el.get_text(" ", strip=True) or "").strip() or None


_LINK_JUNK = ("compare", "sravn", "cart", "basket", "korzin", "javascript",
              "login", "tel:", "mailto:", "wishlist", "favorite")


def _product_link(block) -> str | None:
    """Ссылка именно на карточку товара (не «сравнить»/«в корзину»)."""
    a = block.find("a", attrs={"itemprop": "url"}, href=True)
    if a:
        return a["href"]
    nm = block.find(attrs={"itemprop": "name"})
    if nm:
        a = nm.find_parent("a", href=True) or nm.find("a", href=True)
        if a:
            return a["href"]
    for a in block.find_all("a", href=True):
        h = a["href"].lower().strip()
        if h in ("#", "") or any(j in h for j in _LINK_JUNK):
            continue
        return a["href"]
    return None


def _abs_url(href: str, page_url: str) -> str:
    """Абсолютный URL. Ссылки в каталогах обычно корне-относительные («produkcziya/…»),
    поэтому клеим к корню домена, а не к пути страницы (иначе путь задваивается)."""
    if not href:
        return page_url
    if href.startswith("http"):
        return href
    pr = urlparse(page_url)
    root = f"{pr.scheme}://{pr.netloc}"
    return urljoin(root + "/", href.lstrip("/"))


def _to_float(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(re.sub(r"[^\d.,]", "", str(v)).replace(",", "."))
        return f if f > 0 else None
    except ValueError:
        return None


def parse_listing(html: str, page_url: str, label: str, cfg: dict) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    blocks = soup.find_all(attrs={"itemtype": lambda v: v and "Product" in v})
    dn_re = cfg.get("dn_regex")
    art_re = cfg.get("article_regex")
    out = []
    for b in blocks:
        name = _itemprop(b, "name")
        price = _to_float(_itemprop(b, "price"))
        if not name or price is None:        # «по запросу» / нет цены — пропускаем
            continue
        href = _product_link(b)
        url = _abs_url(href, page_url) if href else page_url

        article = _itemprop(b, "sku") or _itemprop(b, "mpn")
        if not article and art_re:
            m = re.search(art_re, name)
            article = m.group(1) if m else None

        dn = None
        if dn_re:
            m = re.search(dn_re, name)
            dn = int(m.group(1)) if m else None
        if dn is None:
            dn = nz.extract_dn(name)

        rec = {
            "natural_key": article or url,
            "name": name,
            "article": article,
            "manufacturer": cfg.get("brand"),
            "price": price,
            "currency": "RUB",
            "unit": "шт",
            "dn": dn,
            "in_stock": None,
            "raw_data": {"page": page_url},
        }
        rec.update(rest_client.provenance(url, source_label=label))
        out.append(rec)
    return out


def collect(cfg: dict) -> list[dict]:
    label = cfg["key"]
    max_pages = int(cfg.get("max_pages", 1))
    urls = cfg.get("list_urls") or ([cfg["list_url"]] if cfg.get("list_url") else [])
    seen: set[str] = set()
    out: list[dict] = []
    for u in urls:
        for page in range(1, max_pages + 1):
            page_url = u if page == 1 else f"{u}{'&' if '?' in u else '?'}p={page}"
            try:
                html = rest_client.request("GET", page_url, accept="text/html").text
            except Exception as exc:  # noqa: BLE001
                print(f"    {page_url}: {exc}")
                break
            recs = parse_listing(html, page_url, label, cfg)
            fresh = [r for r in recs if r["natural_key"] not in seen]
            if not fresh:
                break                         # пустая страница / конец пагинации
            for r in fresh:
                seen.add(r["natural_key"])
            out.extend(fresh)
    print(f"  rest_html: разобрано карточек с ценой: {len(out)}")
    return out
