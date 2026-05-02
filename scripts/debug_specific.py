"""Debug specific files in detail."""
import os, sys, pdfplumber, xlrd
sys.stdout.reconfigure(encoding='utf-8')

UPLOADS = r'c:\Users\home\vscode101\budget-automation\data\uploads'

def get_path(name_part):
    for f in os.listdir(UPLOADS):
        if name_part in f and '— копия' not in f:
            return os.path.join(UPLOADS, f), f
    return None, None

# ─── 1. Итеса Радиаторы: extract_items debug ─────────────────────────────────
print("=== ИТЕСА РАДИАТОРЫ: table items ===")
path, fname = get_path('4171')
if path:
    with pdfplumber.open(path) as pdf:
        for pi, pg in enumerate(pdf.pages):
            for ti, tbl in enumerate(pg.extract_tables()):
                if not tbl: continue
                print(f"  Page {pi+1} Table {ti+1}: {len(tbl)} rows, {len(tbl[0]) if tbl else 0} cols")
                for ri, row in enumerate(tbl[:8]):
                    print(f"    r{ri}: {[str(c)[:30] if c else None for c in row]}")
print()

# ─── 2. 403 PRINTER: check "Всего с НДС" vs qty ──────────────────────────────
print("=== 403 PRINTER: Всего с НДС vs qty ===")
path, fname = get_path('PRINTER2')
if path:
    with pdfplumber.open(path) as pdf:
        for pi, pg in enumerate(pdf.pages):
            for ti, tbl in enumerate(pg.extract_tables()):
                if not tbl or len(tbl) < 3: continue
                header = [str(c).replace('\n', ' ') if c else '' for c in tbl[0]]
                print(f"  P{pi+1} T{ti+1} header: {header}")
                for ri, row in enumerate(tbl[1:6], 1):
                    print(f"    r{ri}: {[str(c)[:25] if c else None for c in row]}")
                break
print()

# ─── 3. Руфлекс: check all rows extracted as items ────────────────────────────
print("=== РУФЛЕКС: col7 scan ===")
path, fname = get_path('Руфлекс')
if path:
    wb = xlrd.open_workbook(path)
    sh = wb.sheets()[0]
    print(f"  Sheet rows={sh.nrows} cols={sh.ncols}")
    for ri in range(sh.nrows):
        col7 = str(sh.cell(ri, 7).value).strip()
        if col7 and col7 != '0.0':
            print(f"    r{ri} col7={col7!r}")

# ─── 4. КП АТК: check vat detection ──────────────────────────────────────────
print()
print("=== КП АТК: full text scan ===")
path, fname = get_path('АТК')
if path:
    wb = xlrd.open_workbook(path)
    sh = wb.sheets()[0]
    for ri in range(sh.nrows):
        row_text = ' '.join(str(sh.cell(ri,c).value).strip() for c in range(sh.ncols)
                            if str(sh.cell(ri,c).value).strip())
        if row_text:
            print(f"  r{ri}: {row_text[:80]}")
