"""Debug Excel files - full width."""
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
            print(f"  Sheet {ws.title!r}, rows={ws.max_row}, cols={ws.max_column}")
            for ri, row in enumerate(ws.iter_rows(values_only=True)):
                if any(v is not None for v in row):
                    vals = [f"[{ci}]{str(v)[:20]}" for ci,v in enumerate(row) if v is not None]
                    print(f"    r{ri}: {vals}")
    else:
        wb = xlrd.open_workbook(fpath)
        for sh in wb.sheets():
            print(f"  Sheet {sh.name!r}, rows={sh.nrows}, cols={sh.ncols}")
            for ri in range(sh.nrows):
                row = [(ci, str(sh.cell(ri,ci).value)) for ci in range(sh.ncols)
                       if str(sh.cell(ri,ci).value).strip() and str(sh.cell(ri,ci).value) != '0.0']
                if row:
                    print(f"    r{ri}: {[(ci, v[:20]) for ci,v in row]}")
