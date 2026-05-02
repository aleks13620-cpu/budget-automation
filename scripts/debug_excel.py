"""Debug Excel files deeper to find item rows."""
import os, sys, xlrd, openpyxl
sys.stdout.reconfigure(encoding='utf-8')

UPLOADS = r'c:\Users\home\vscode101\budget-automation\data\uploads'

def is_copy(n): return '— копия' in n or '- копия' in n

for fname in sorted(os.listdir(UPLOADS)):
    if is_copy(fname): continue
    ext = os.path.splitext(fname)[1].lower()
    if ext not in ('.xls', '.xlsx'): continue
    fpath = os.path.join(UPLOADS, fname)
    print(f"\n=== {fname} ===")

    if ext == '.xlsx':
        wb = openpyxl.load_workbook(fpath, data_only=True)
        for ws in wb.worksheets:
            print(f"  Sheet {ws.title!r}, rows={ws.max_row}")
            for ri, row in enumerate(ws.iter_rows(values_only=True)):
                if any(v is not None for v in row):
                    vals = [str(v)[:25] if v is not None else None for v in row[:14]]
                    print(f"    r{ri}: {vals}")
    else:
        wb = xlrd.open_workbook(fpath)
        for sh in wb.sheets():
            print(f"  Sheet {sh.name!r}, rows={sh.nrows}")
            for ri in range(sh.nrows):
                row = [str(sh.cell(ri,c).value)[:25] for c in range(sh.ncols)]
                if any(v.strip() and v != '0.0' for v in row):
                    print(f"    r{ri}: {row[:14]}")
