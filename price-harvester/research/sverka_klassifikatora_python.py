# -*- coding: utf-8 -*-
"""Расширенный эталон: КАЖДАЯ строка specification_items во всей базе (без фильтра
по количеству и без дедупа) — чтобы под сверку попали все ветки правил, а не только
те, что встретились в спецификации 34. Правила — из klassifikator_pozicij.py как есть.
"""
import io, json, os, re, sqlite3, sys

ROOT = r"C:\Users\home\vscode101\budget-automation"
DB = os.path.join(ROOT, "database", "budget_automation.db")
KLASS = os.path.join(ROOT, "price-harvester", "research", "klassifikator_pozicij.py")

ns = {"__name__": "k"}
exec(compile(io.open(KLASS, encoding="utf-8").read().replace("\nrun()\n", "\n"), "klass", "exec"), ns)
classify = ns["classify"]

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
rows = con.execute("select * from specification_items").fetchall()
by_id = {r["id"]: r for r in rows}
con.close()


def full(r):
    parts, cur, g = [], r, 0
    while cur is not None and g < 5:
        nm = (cur["full_name"] or cur["name"] or "").strip()
        if nm and nm not in parts:
            parts.insert(0, nm)
        cur = by_id.get(cur["parent_item_id"]); g += 1
    return re.sub(r"\s+", " ", " ".join(parts))[:120]


out = []
for r in rows:
    fn = full(r)
    k, mark, src = classify(r, fn)
    out.append({"id": r["id"], "full_name": fn, "group": k, "mark": mark, "mark_src": src})

io.open(os.path.join(ROOT, "price-harvester", "out", "sverka_python.json"),
        "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
print("python (вся база): %d строк" % len(out))
