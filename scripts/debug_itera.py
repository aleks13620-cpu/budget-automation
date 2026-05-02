"""Trace exactly what extract_items_from_table does for Итеса Радиаторы."""
import os, sys, pdfplumber
sys.stdout.reconfigure(encoding='utf-8')

UPLOADS = r'c:\Users\home\vscode101\budget-automation\data\uploads'

HEADER_KWS = ['наименование', 'название', 'позиция', 'кол', 'цена', 'сумма', 'ед', 'шт', 'артикул', 'товар']
SKIP_SET = {'итого', 'всего', 'total', 'в том числе', 'ндс', 'сумма'}

def clean(s):
    return str(s).strip() if s is not None else ""

def find_header_row(rows):
    for i, row in enumerate(rows):
        row_text = " ".join(clean(c).lower() for c in row if c)
        hits = sum(1 for kw in HEADER_KWS if kw in row_text)
        if hits >= 2:
            return i, hits, row_text
    return None, 0, ""

# Find Итеса Радиаторы
for fname in os.listdir(UPLOADS):
    if '4171' in fname and '— копия' not in fname:
        path = os.path.join(UPLOADS, fname)
        print(f"File: {fname!r}")
        with pdfplumber.open(path) as pdf:
            all_tables = []
            for pi, pg in enumerate(pdf.pages):
                for ti, tbl in enumerate(pg.extract_tables()):
                    if tbl:
                        all_tables.append((pi+1, ti+1, tbl))

        print(f"Total tables: {len(all_tables)}")
        for pi, ti, tbl in all_tables:
            print(f"\n  P{pi} T{ti}: {len(tbl)} rows")
            hidx, hits, htext = find_header_row(tbl)
            print(f"  header_idx={hidx}  hits={hits}  text[:80]={htext[:80]!r}")
            if hidx is not None:
                headers = tbl[hidx]
                print(f"  headers: {[str(h)[:20] if h else None for h in headers]}")
                # Try to find col_name
                for i, h in enumerate(headers):
                    hl = clean(h).lower().replace('\n', ' ')
                    if 'товар' in hl or 'наименование' in hl or 'услуга' in hl:
                        print(f"  col_name candidate: idx={i} val={h!r}")
                # Count extractable items
                count = 0
                for row in tbl[hidx+1:]:
                    if not any(clean(c) for c in row):
                        continue
                    col3 = clean(row[3]) if len(row) > 3 else ""
                    if col3 and len(col3) >= 2:
                        count += 1
                        if count <= 3:
                            print(f"  item: {col3[:50]!r}")
                print(f"  extractable items (col3): {count}")
        break
