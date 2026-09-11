# -*- coding: utf-8 -*-
"""Ф9.3, бесплатно: какое предложение станет первым (самым дешёвым), если отсеивать по диаметру.

Вход — выгрузка уже найденных предложений (offers_16_17.json), сеть не трогаем.
М (мягкий): отбрасываем только size_ok is False.
С (строгий): отбрасываем False и None, если у позиции размер указан.
Запуск: python proverka_razmera_offline.py [путь к offers.json]
"""
import csv, io, json, os, sys
from collections import defaultdict
from zamer_sloj_marka import dn_sizes, size_ok      # файл защищён __main__, поиск не запускается

SRC = sys.argv[1] if len(sys.argv) > 1 else (
    r"C:\Users\home\AppData\Local\Temp\claude\C--Users-home-vscode101"
    r"\ad7e0b97-6d07-4c48-b9e1-8d6d4ed2f76c\scratchpad\offers_16_17.json")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proverka_razmera_offline.csv")

offers = json.load(io.open(SRC, encoding="utf-8"))
pos = defaultdict(list)
for o in offers:
    pos[(o["project_id"], o["spec_item_id"])].append(o)

first = lambda lst: min(lst, key=lambda o: o["price"]) if lst else None
cell = lambda o: [o["price"], o["card_name"], o["source_url"]] if o else ["", "", ""]
rows, stat, diff = [], defaultdict(lambda: defaultdict(int)), []
for (pid, sid), lst in sorted(pos.items()):
    spec = " ".join(x for x in (lst[0]["spec_name"], lst[0]["spec_chars"]) if x)
    ok = [(o, size_ok(spec, o["card_name"])) for o in lst]
    was = first(lst)
    v = {"М": first([o for o, s in ok if s is not False]),
         "С": first([o for o, s in ok if s is True] if dn_sizes(spec) else [o for o, s in ok if s is not False])}
    rows.append([pid, sid, lst[0]["spec_name"]] + cell(was) + cell(v["М"]) + cell(v["С"]) +
                [str(size_ok(spec, was["card_name"]))])
    for k, o in v.items():
        if o is None:
            stat[pid][k + " потеряли цену"] += 1
        elif o is not was:
            stat[pid][k + " сменили первое"] += 1
        if o is not was:
            diff.append("%s %s %s: %s | %s -> %s" % (pid, sid, k, spec[:50], was["card_name"][:60],
                                                   o["card_name"][:60] if o else "ЦЕНЫ НЕТ"))

with io.open(OUT, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["project_id", "spec_item_id", "spec_name", "было_цена", "было_карточка", "было_url",
                "М_цена", "М_карточка", "М_url", "С_цена", "С_карточка", "С_url", "size_первого_было"])
    w.writerows(rows)

print("предложений: %d, позиций: %d -> %s" % (len(offers), len(rows), OUT))
for pid in sorted(stat.keys() | {p for p, _ in pos}):
    print("проект %s: %s" % (pid, ", ".join("%s %d" % (k, stat[pid][k]) for k in
          ("М сменили первое", "М потеряли цену", "С сменили первое", "С потеряли цену"))))
print("\n".join(diff))
