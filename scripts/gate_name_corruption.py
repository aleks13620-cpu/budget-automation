"""Regression gate for variant A (detect->review): read-only audit of what the
name-corruption detector would DECIDE across the whole prod corpus.

Variant A does not change parser output (names/finances untouched, forward-only),
so the classic OLD-vs-NEW parser diff is identical by construction. The real risk
surface is the DECISION: which invoices get downgraded A->B, and that no legit
invoice is wrongly downgraded. This walks projects -> invoices -> items via the
public read-only API and reports those decisions. ASCII-safe.

Usage: python scripts/gate_name_corruption.py [base_url]
"""
import sys
import os
import json
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from name_corruption import analyze_name_corruption, NAME_CORRUPTION_RATIO_THRESHOLD

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://5.42.103.63:3001"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.load(r)


projects = get("/api/projects")
rows = []
for p in projects:
    raw = get(f"/api/projects/{p['id']}/invoices")
    invs = raw.get("invoices", []) if isinstance(raw, dict) else raw
    for iv in invs:
        try:
            d = get(f"/api/invoices/{iv['id']}")
        except Exception:
            continue
        names = [str(it.get("name", "")) for it in (d.get("items") or [])]
        res = analyze_name_corruption(names)
        rows.append((iv["id"], iv.get("supplier_name") or "?",
                     iv.get("parsing_category"), iv.get("needs_amount_review"), res))

downgrade = [r for r in rows if r[4]["ratio"] >= NAME_CORRUPTION_RATIO_THRESHOLD]
sparse = [r for r in rows if r[4]["ratio"] < NAME_CORRUPTION_RATIO_THRESHOLD and r[4]["latWedgeRows"]]

print(f"threshold = {NAME_CORRUPTION_RATIO_THRESHOLD}")
print(f"invoices scanned: {len(rows)}")
print(f"\n=== WOULD DOWNGRADE A->B (ratio >= threshold) ===")
for iid, sup, cat, rev, res in sorted(downgrade, key=lambda r: -r[4]["ratio"]):
    print(f"  inv={iid:<4} ratio={res['ratio']:.2f} ({res['flaggedCount']}/{res['total']}) "
          f"latWedge={len(res['latWedgeRows'])} cat={cat} rev={rev} {ascii(sup)[:34]}")
print(f"\n=== SPARSE lat-wedge only (ratio < threshold, flag rows but keep category) ===")
for iid, sup, cat, rev, res in sorted(sparse, key=lambda r: -len(r[4]["latWedgeRows"])):
    print(f"  inv={iid:<4} ratio={res['ratio']:.2f} latWedgeRows={res['latWedgeRows']} {ascii(sup)[:34]}")
print(f"\nDOWNGRADE set: {sorted(r[0] for r in downgrade)}")
print(f"SPARSE set:    {sorted(r[0] for r in sparse)}")
