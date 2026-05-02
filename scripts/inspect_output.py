"""Print benchmark-draft.xlsx contents — UTF-8 safe."""
import sys, openpyxl
sys.stdout.reconfigure(encoding='utf-8')

wb = openpyxl.load_workbook(
    r'c:\Users\home\vscode101\budget-automation\scripts\benchmark-draft.xlsx')
ws = wb['Эталон']

for row in ws.iter_rows(min_row=2, values_only=True):
    fname, status, count = row[0], row[1], row[2]
    d, e, f, g = row[3], row[4], row[5], row[6]
    h, i, j, k = row[7], row[8], row[9], row[10]
    l, m, n, o = row[11], row[12], row[13], row[14]
    vat, how, comment = row[15], row[16], row[17]
    print(f"{'─'*70}")
    print(f"FILE : {fname}")
    print(f"      status={status}  count={count}  vat={vat}  Q={how}")
    if d:  print(f"  FIRST  name={d[:55]!r}")
    if e:  print(f"         price_with_vat={e}  qty={f}  unit={g!r}")
    if h:  print(f"  MIDDLE name={h[:55]!r}")
    if i:  print(f"         price_with_vat={i}  qty={j}  unit={k!r}")
    if l:  print(f"  LAST   name={l[:55]!r}")
    if m:  print(f"         price_with_vat={m}  qty={n}  unit={o!r}")
    if comment: print(f"  NOTE : {comment}")
