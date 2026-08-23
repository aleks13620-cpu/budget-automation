# -*- coding: utf-8 -*-
"""Позиции БЕЗ марки: собрать НЕСКОЛЬКО кандидатов у разных продавцов,
разобрать каждого по характеристикам и показать как выбор с галочкой.

Отличие от прошлых прогонов: раньше сохранял только самый дешёвый вариант.
Здесь сохраняю всех, кто прошёл проверку, — это и есть то, из чего выбирает человек.
"""
import base64, json, re, sqlite3, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import httpx
from bs4 import BeautifulSoup

ROOT = r"C:\Users\home\vscode101\budget-automation"
CRED = json.load(open(ROOT + r"\price-harvester\secrets\yandex_search.json", encoding="utf-8"))
env = {}
for line in open(ROOT + r"\backend\.env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
OR_KEY = env["OPENROUTER_API_KEY"]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
BLOCKED = ("yandex.ru", "google.", "youtube.", "wikipedia.", "avito.ru", "market.")
# площадки, которые не пускают программу — их показываем отдельно, а не выбрасываем
NO_ROBOTS = ("ozon.ru", "wildberries.ru", "vseinstrumenti.ru", "lunda.ru", "chipdip.ru")

POSITIONS = [
    "Кран шаровый Н-образный Ду15",
    "Комплект трубок из нержавеющей стали для подключения радиатора Г-образный Ø16",
    "Термометр биметаллический Ø80мм 0..160С, L=100 мм, кл. точн. 1.5, IP54",
    "Кран под манометр трехходовой резьбовой G1/2 Ру40",
    "Цилиндры теплоизоляционные из минеральной ваты кашированные фольгой Ø108 30мм",
]


def search(q, tries=3):
    body = {"query": {"searchType": "SEARCH_TYPE_RU", "queryText": q},
            "folderId": CRED["folder_id"], "responseFormat": "FORMAT_XML",
            "groupSpec": {"groupMode": "GROUP_MODE_DEEP", "groupsOnPage": "15", "docsInGroup": "1"}}
    for a in range(tries):
        try:
            req = urllib.request.Request("https://searchapi.api.cloud.yandex.net/v2/web/search",
                data=json.dumps(body).encode(),
                headers={"Authorization": "Api-Key " + CRED["api_key_secret"],
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as r:
                d = json.loads(r.read())
            xml = base64.b64decode(d["rawData"]).decode("utf-8", "replace")
            out, blocked = [], []
            for u in re.findall(r"<url>(.*?)</url>", xml):
                u = u.replace("&amp;", "&")
                if any(h in u for h in BLOCKED):
                    continue
                if any(h in u for h in NO_ROBOTS):
                    host = u.split("/")[2]
                    if host not in blocked:
                        blocked.append(host)
                    continue
                if u not in out:
                    out.append(u)
            return out, blocked
        except Exception:
            time.sleep(1.5 * (a + 1))
    return [], []


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
    if prods and len(prods) <= 3:
        return prods[0], soup
    if prods: return None, soup
    og = soup.find("meta", attrs={"property": "og:type"})
    scope = soup.find(attrs={"itemtype": re.compile(r"schema.org/Product", re.I)})
    if (og and "product" in (og.get("content") or "").lower()) or scope:
        el = (scope or soup).find(attrs={"itemprop": re.compile(r"^(price|lowPrice)$", re.I)})
        pr = _num(el.get("content") or el.get_text()) if el else None
        if pr:
            nm = soup.h1.get_text(strip=True) if soup.h1 else ""
            return (nm, pr), soup
    return None, soup


def fetch(url):
    try:
        with httpx.Client(follow_redirects=True, timeout=15,
                          headers={"User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9"}) as cl:
            r = cl.get(url)
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            return url, None
        return url, r.text
    except Exception:
        return url, None


SYSTEM = (u"Ты инженер ПТО. Сверяешь позицию проектной спецификации с карточкой товара.\n"
          u"Правила: расхождение размера/длины/диаметра/давления/материала — 'не подходит'; "
          u"другой производитель при совпадении характеристик — 'аналог'; "
          u"нет характеристик для проверки — 'не подходит'.\n"
          u'Ответ строго JSON: {"verdict":"подходит|аналог|не подходит","note":"коротко, до 6 слов"}')


def judge(spec, card_name, page_text):
    body = {"model": "google/gemini-2.5-flash", "temperature": 0,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": u"ПОЗИЦИЯ: %s\n\nКАРТОЧКА: %s\n\nСТРАНИЦА:\n%s"
                          % (spec, card_name, page_text[:1500])}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + OR_KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            txt = json.loads(r.read())["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", txt, re.S)
        return json.loads(m.group(0)) if m else {"verdict": "?", "note": ""}
    except Exception as e:
        return {"verdict": "?", "note": type(e).__name__}


for spec in POSITIONS:
    urls, blocked = search(spec + " купить цена")
    cands = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for url, html in ex.map(fetch, urls[:9]):
            if not html: continue
            card, soup = product_page(html)
            if not card: continue
            name, price = card
            txt = re.sub(r"\s+", " ", soup.get_text(" "))[:1500]
            cands.append({"host": url.split("/")[2], "name": name[:70], "price": price, "text": txt, "url": url})
    print("\n" + "=" * 100)
    print("ПОЗИЦИЯ:", spec)
    if blocked:
        print("  не пустили программу:", ", ".join(blocked))
    if not cands:
        print("  вариантов не найдено"); continue
    for c in cands[:5]:
        v = judge(spec, c["name"], c["text"])
        c["verdict"] = v.get("verdict"); c["note"] = v.get("note")
    shown = [c for c in cands[:5] if c.get("verdict") in ("подходит", "аналог")]
    print("  ПОКАЗАТЬ ЧЕЛОВЕКУ (%d из %d проверенных):" % (len(shown), min(5, len(cands))))
    for c in sorted(shown, key=lambda x: x["price"]):
        print("    [ ] %-28s %9.0f ₽  %-11s %s" % (c["host"][:28], c["price"], c["verdict"], c["name"][:44]))
    hidden = [c for c in cands[:5] if c.get("verdict") == "не подходит"]
    if hidden:
        print("  отсеяно программой (человек не видит): %d — %s" % (
            len(hidden), "; ".join("%s: %s" % (c["host"][:18], c["note"][:28]) for c in hidden[:3])))
