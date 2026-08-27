# -*- coding: utf-8 -*-
"""Построчная сверка python-эталона и TS-переноса классификатора — по ВСЕЙ базе.

Правило деления спецификации на группы живёт в двух местах: klassifikator_pozicij.py
(по нему реально идёт поиск цен) и backend/src/services/specClassifier.ts (по нему
рисуется экран проекта). Разойдутся — экран будет обещать одно, а искаться будет другое.
Гонять после ЛЮБОЙ правки любого из двух файлов, три команды по порядку:

  python price-harvester/research/sverka_klassifikatora_python.py
  cd backend && npx ts-node sverka_klassifikatora_ts.ts
  python price-harvester/research/sverka_klassifikatora.py

Ожидаемый результат — «РАСХОЖДЕНИЙ НЕТ — 1:1». Сверено 26.08.2026: 7039 из 7039."""
import io, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
P = json.loads(io.open(os.path.join(HERE, "..", "out", "sverka_python.json"), encoding="utf-8").read())
T = json.loads(io.open(os.path.join(HERE, "..", "out", "sverka_ts.json"), encoding="utf-8").read())

pi = {r["id"]: r for r in P}
ti = {r["id"]: r for r in T}
only_p = sorted(set(pi) - set(ti))
only_t = sorted(set(ti) - set(pi))
both = sorted(set(pi) & set(ti))

print("позиций у python: %d,  у TS: %d,  общих id: %d" % (len(P), len(T), len(both)))
if only_p or only_t:
    print("ТОЛЬКО в python: %s" % only_p)
    print("ТОЛЬКО в TS:     %s" % only_t)

same_g = same_m = same_s = same_fn = same_k = 0
diffs = []
for i in both:
    a, b = pi[i], ti[i]
    if a["group"] == b["group"]:
        same_g += 1
    if a["mark"] == b["mark"]:
        same_m += 1
    if a["mark_src"] == b["mark_src"]:
        same_s += 1
    if a["full_name"] == b["full_name"]:
        same_fn += 1
    if a["key"] == b["key"]:
        same_k += 1
    if (a["group"], a["mark"], a["mark_src"], a["full_name"], a["key"]) != \
       (b["group"], b["mark"], b["mark_src"], b["full_name"], b["key"]):
        diffs.append((i, a, b))

print("совпало по группе:        %d / %d" % (same_g, len(both)))
print("совпало по марке:         %d / %d" % (same_m, len(both)))
print("совпало по полю-источнику:%d / %d" % (same_s, len(both)))
print("совпало по полному имени: %d / %d" % (same_fn, len(both)))
print("совпало по КЛЮЧУ ДЕДУПА:   %d / %d" % (same_k, len(both)))

from collections import Counter
print("\nраспределение по группам (python): %s" % dict(Counter(r["group"] for r in P)))
print("распределение по группам (TS):     %s" % dict(Counter(r["group"] for r in T)))

print("\nрасхождений: %d" % len(diffs))
for i, a, b in diffs:
    print("-" * 100)
    print("id=%d  %s" % (i, a["full_name"][:95]))
    print("   python: группа=%-20s марка=%-28r поле=%s" % (a["group"], a["mark"], a["mark_src"]))
    print("   TS:     группа=%-20s марка=%-28r поле=%s" % (b["group"], b["mark"], b["mark_src"]))
    if a["key"] != b["key"]:
        print("   КЛЮЧ ДЕДУПА РАЗОШЁЛСЯ:")
        print("     python: %r" % (a["key"],))
        print("     TS:     %r" % (b["key"],))
    if a["full_name"] != b["full_name"]:
        print("   ПОЛНОЕ ИМЯ РАЗОШЛОСЬ:\n     python: %r\n     TS:     %r" % (a["full_name"], b["full_name"]))
if not diffs and not only_p and not only_t:
    print("РАСХОЖДЕНИЙ НЕТ — 1:1")
