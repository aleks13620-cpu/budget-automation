# -*- coding: utf-8 -*-
"""Слой «с заводской маркой» строго по классификатору klass.py — те самые 80 позиций.

Прошлый прогон был собран наспех: в него протекли проектные позиции (узлы TDU.5R),
а запрос строился без производителя. Здесь и то и другое исправлено.
"""
import base64, csv, io, json, re, sqlite3, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import httpx
from bs4 import BeautifulSoup

ROOT = r"C:\Users\home\vscode101\budget-automation"
SCRATCH = r"C:\Users\home\AppData\Local\Temp\claude\C--Users-home-vscode101\294d7754-6bc7-400f-8df5-525f115a26cf\scratchpad"
CRED = json.load(io.open(ROOT + r"\price-harvester\secrets\yandex_search.json", encoding="utf-8"))
RESULT = ROOT + r"\price-harvester\out\zamer_layerC_clean.csv"

# классификатор берём как есть, чтобы состав слоя совпал с документом
ns = {"__name__": "k"}
exec(compile(io.open(SCRATCH + r"\klass.py", encoding="utf-8").read().replace("\nrun()\n", "\n"),
             "klass", "exec"), ns)
classify, find_mark = ns["classify"], ns["find_mark"]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
BLOCKED = ("yandex.ru", "google.", "youtube.", "wikipedia.", "avito.ru", "market.")
NO_ROBOTS = ("ozon.ru", "wildberries.ru", "vseinstrumenti.ru", "lunda.ru", "chipdip.ru")


def log(*a): print(*a, flush=True)


def search(q, tries=3):
    body = {"query": {"searchType": "SEARCH_TYPE_RU", "queryText": q},
            "folderId": CRED["folder_id"], "responseFormat": "FORMAT_XML",
            "groupSpec": {"groupMode": "GROUP_MODE_DEEP", "groupsOnPage": "15", "docsInGroup": "1"}}
    for a in range(tries):
        try:
            req = urllib.request.Request("https://searchapi.api.cloud.yandex.net/v2/web/search",
                data=json.dumps(body).encode(),
                headers={"Authorization": "Api-Key " + CRED["api_key_secret"], "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as r:
                d = json.loads(r.read())
            xml = base64.b64decode(d["rawData"]).decode("utf-8", "replace")
            out, blocked = [], []
            for u in re.findall(r"<url>(.*?)</url>", xml):
                u = u.replace("&amp;", "&")
                if any(h in u for h in BLOCKED):
                    continue
                if any(h in u for h in NO_ROBOTS):
                    h = u.split("/")[2]
                    if h not in blocked: blocked.append(h)
                    continue
                if u not in out: out.append(u)
            return out, blocked, None
        except Exception as e:
            time.sleep(1.5 * (a + 1)); err = "%s%s" % (type(e).__name__, getattr(e, "code", ""))
    return [], [], err


def _num(v):
    if v is None: return None
    s = re.sub(r"[^\d.]", "", str(v).replace("\xa0", "").replace(" ", "").replace(",", "."))
    if s.count(".") > 1: s = s.replace(".", "", s.count(".") - 1)
    try: f = float(s)
    except ValueError: return None
    return f if 1 < f < 100000000 else None


def product_page(html):
    soup = BeautifulSoup(html, "lxml")
    prods = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try: data = json.loads(tag.string or "{}")
        except Exception: continue
        stack = [data]
        while stack:
            n = stack.pop()
            if isinstance(n, list): stack.extend(n); continue
            if not isinstance(n, dict): continue
            stack.extend(v for v in n.values() if isinstance(v, (dict, list)))
            t = n.get("@type"); t = " ".join(t) if isinstance(t, list) else str(t or "")
            if "Product" in t:
                pr = None
                offers = n.get("offers")
                for off in (offers if isinstance(offers, list) else [offers] if offers else []):
                    if isinstance(off, dict): pr = _num(off.get("price") or off.get("lowPrice")) or pr
                pr = pr or _num(n.get("price"))
                if pr: prods.append((str(n.get("name") or ""), pr))
    if prods:
        if len(prods) > 3: return None, soup, "витрина"
        return prods[0], soup, ""
    og = soup.find("meta", attrs={"property": "og:type"})
    scope = soup.find(attrs={"itemtype": re.compile(r"schema.org/Product", re.I)})
    if (og and "product" in (og.get("content") or "").lower()) or scope:
        el = (scope or soup).find(attrs={"itemprop": re.compile(r"^(price|lowPrice)$", re.I)})
        pr = _num(el.get("content") or el.get_text()) if el else None
        if not pr:
            m = soup.find("meta", attrs={"property": re.compile(r"(product|og):price:amount")})
            pr = _num(m.get("content")) if m else None
        if pr:
            nm = soup.h1.get_text(strip=True) if soup.h1 else ""
            return (nm, pr), soup, ""
        return None, soup, "карточка без цены"
    return None, soup, "не карточка"


def mark_on_page(mark, soup, card_name):
    hay = ((card_name or "") + " " + (soup.title.get_text() if soup.title else "") + " " +
           soup.get_text(" ")[:30000]).lower()
    m = mark.lower()
    flat = lambda s: re.sub(r"[\s\-_./]", "", s)
    return m in hay or (flat(m) and flat(m) in flat(hay))


def fetch(url):
    try:
        with httpx.Client(follow_redirects=True, timeout=15,
                          headers={"User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9"}) as cl:
            r = cl.get(url)
            if r.status_code == 429:
                time.sleep(3); r = cl.get(url)
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            return url, None
        return url, r.text
    except Exception:
        return url, None


def load_layer_c():
    c = sqlite3.connect(ROOT + "/database/budget_automation.db"); c.row_factory = sqlite3.Row
    rows = c.execute("select * from specification_items where specification_id=34").fetchall()
    by_id = {r["id"]: r for r in rows}

    def full(r):
        parts, cur, g = [], r, 0
        while cur is not None and g < 5:
            nm = (cur["full_name"] or cur["name"] or "").strip()
            if nm and nm not in parts: parts.insert(0, nm)
            cur = by_id.get(cur["parent_item_id"]); g += 1
        return re.sub(r"\s+", " ", " ".join(parts))[:120]

    out, seen = [], set()
    for r in rows:
        if not r["quantity"]: continue
        fn = full(r)
        key = (fn[:60], r["product_code"] or "", r["manufacturer"] or "")
        if key in seen: continue
        seen.add(key)
        kind, mark, src = classify(r, fn)
        if not kind.startswith("C"): continue      # только слой «с заводской маркой»
        manuf = (r["manufacturer"] or "").strip()
        if manuf == mark: manuf = ""               # в этой спеке в поле производителя бывает артикул
        out.append({"id": r["id"], "name": fn, "mark": mark, "manufacturer": manuf,
                    "unit": r["unit"] or "", "qty": r["quantity"], "mark_src": src})
    return out


def main():
    positions = load_layer_c()
    log("слой «с заводской маркой»: %d позиций\n" % len(positions))
    results = []
    for i, p in enumerate(positions, 1):
        t0 = time.time()
        query = re.sub(r"\s+", " ", " ".join(x for x in (p["manufacturer"], p["mark"], p["name"]) if x))[:180]
        urls, blocked, err = search(query)
        hits = []
        if urls:
            with ThreadPoolExecutor(max_workers=6) as ex:
                for url, html in ex.map(fetch, urls[:9]):
                    if not html: continue
                    card, soup, why = product_page(html)
                    if not card: continue
                    name, price = card
                    if not mark_on_page(p["mark"], soup, name): continue
                    hits.append((price, url, url.split("/")[2], name[:70]))
        hits.sort()
        row = dict(p, status="found" if hits else "not_found",
                   price=round(hits[0][0], 2) if hits else "",
                   shops=len(hits), host=hits[0][2] if hits else "",
                   card=hits[0][3] if hits else "",
                   blocked="; ".join(blocked), note=err or "")
        results.append(row)
        log("[%2d/%d] %-10s %5.0fs %10s  %-18s %s" % (
            i, len(positions), row["status"], time.time() - t0, row["price"] or "-",
            p["mark"][:18], p["name"][:40]))

    cols = ["id", "name", "mark", "mark_src", "manufacturer", "unit", "qty",
            "status", "price", "shops", "host", "card", "blocked", "note"]
    with io.open(RESULT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore"); w.writeheader(); w.writerows(results)

    ok = [r for r in results if r["status"] == "found"]
    summa = sum(float(r["price"]) * float(r["qty"]) for r in ok if r["price"] and r["qty"])
    log("\n" + "=" * 70)
    log("позиций в слое:  %d" % len(results))
    log("цена найдена:    %d  (%.0f%%)" % (len(ok), len(ok) / len(results) * 100))
    log("сумма:           %s ₽" % format(int(summa), ",d").replace(",", " "))
    from collections import Counter
    log("продавцы: %s" % ", ".join("%s×%d" % (h, n) for h, n in Counter(r["host"] for r in ok if r["host"]).most_common(8)))
    nb = Counter(h for r in results for h in (r["blocked"] or "").split("; ") if h)
    log("не пустили программу: %s" % ", ".join("%s×%d" % (h, n) for h, n in nb.most_common(6)))


main()
