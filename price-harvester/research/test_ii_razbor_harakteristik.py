# -*- coding: utf-8 -*-
"""Те же 10 позиций, но модель сильнее (через OpenRouter). Вопрос: потолок в подходе или в модели."""
import csv, io, json, re, urllib.request
import httpx
from bs4 import BeautifulSoup

ROOT = r"C:\Users\home\vscode101\budget-automation"
env = {}
for line in open(ROOT + r"\backend\.env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
KEY = env["OPENROUTER_API_KEY"]
MODEL = "google/gemini-2.5-flash"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

ETALON = {
    "Комплект трубок": "подходит", "Цилиндры теплоизоляционные": "подходит",
    "Компенсатор тепловых": "подходит", "Сетка для затягивания": "не подходит",
    "Металл сортовой": "не подходит", "Термометр биметаллический": "не подходит",
    "Кран под манометр": "подходит", "Преобразователь давления": "не подходит",
    "Термометр сопротивления": "подходит", "Теплоизоляция труб": "не подходит",
}

SYSTEM = (u"Ты инженер ПТО. Сверяешь позицию проектной спецификации с карточкой товара в магазине "
          u"и решаешь, можно ли поставить её цену в смету.\n"
          u"Правила:\n"
          u"1) Любое расхождение типоразмера, длины, диаметра, давления, материала — 'не подходит'.\n"
          u"2) Другой производитель или другая модель при совпадении функции — 'аналог', не 'подходит'.\n"
          u"3) Если на странице нет характеристик, чтобы это проверить — 'не подходит' (нельзя подтвердить).\n"
          u"4) Сомневаешься — выбирай более строгий вердикт.\n"
          u'Ответ строго один JSON: {"verdict":"подходит|аналог|не подходит","reason":"кратко","mismatch":"что разошлось"}')


def ask(prompt):
    body = {"model": MODEL, "temperature": 0,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        txt = json.loads(r.read())["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", txt, re.S)
    return json.loads(m.group(0)) if m else {"verdict": "?", "reason": txt[:90], "mismatch": ""}


def card_text(url):
    try:
        with httpx.Client(follow_redirects=True, timeout=20, headers={"User-Agent": UA}) as cl:
            r = cl.get(url)
        soup = BeautifulSoup(r.text, "lxml")
        for t in soup(["script", "style", "nav", "footer", "header"]):
            t.decompose()
        txt = re.sub(r"\s+", " ", soup.get_text(" "))
        i = txt.lower().find("характеристик")
        return txt[max(0, i - 200): i + 2000] if i > 0 else txt[:2200]
    except Exception as e:
        return "(страница не открылась: %s)" % type(e).__name__


rows = [r for r in csv.DictReader(io.open(ROOT + r"\price-harvester\out\zamer_spec2_result.csv", encoding="utf-8-sig"))
        if r["status"] == "found" and not r["code"]]
print("модель: %s\nпозиций: %d\n" % (MODEL, len(rows)))
ok = 0
for r in rows:
    et = next((v for k, v in ETALON.items() if k.lower() in r["name"].lower()), "?")
    prompt = (u"ПОЗИЦИЯ СПЕЦИФИКАЦИИ: %s\nединица: %s\n\nКАРТОЧКА: %s\nцена: %s\n\nСТРАНИЦА:\n%s"
              % (r["name"], r["unit"], r["card"], r["price"], card_text(r["url"])[:2000]))
    try:
        v = ask(prompt)
    except Exception as e:
        v = {"verdict": "ошибка", "reason": str(e)[:90], "mismatch": ""}
    hit = v["verdict"] == et or (v["verdict"] == "аналог" and et == "не подходит")
    ok += 1 if hit else 0
    print("%s эталон:%-12s ИИ:%-12s %s" % ("OK  " if hit else "MISS", et, v["verdict"], r["name"][:42]))
    print("      %s | %s\n" % (str(v.get("reason"))[:88], str(v.get("mismatch"))[:55]))
print("=" * 70)
print("СОВПАЛО: %d из %d" % (ok, len(rows)))
