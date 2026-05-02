import os, pdfplumber

uploads = r'c:\Users\home\vscode101\budget-automation\data\uploads'
files = os.listdir(uploads)
# Find and test a small PDF
for f in sorted(files):
    if f.endswith('.pdf') and 'копия' not in f:
        p = os.path.join(uploads, f)
        size = os.path.getsize(p)
        if size < 300000:
            print(f"Testing: {f!r}  size={size}")
            try:
                with pdfplumber.open(p) as pdf:
                    print(f"  Pages: {len(pdf.pages)}")
                    for pg in pdf.pages[:2]:
                        t = pg.extract_text()
                        print(f"  TEXT snippet: {repr(t[:200]) if t else 'NONE'}")
                        tbls = pg.extract_tables()
                        print(f"  TABLES: {len(tbls)}")
                        for tbl in tbls[:1]:
                            print(f"  Headers row: {tbl[0] if tbl else 'empty'}")
                            for row in tbl[1:4]:
                                print(f"    row: {row}")
            except Exception as e:
                print(f"  ERROR: {e}")
            print()
            break
