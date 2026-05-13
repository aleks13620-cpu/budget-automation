# Spec PDF Test Fixtures

Synthetic PDFs and expected JSON for regression testing the spec PDF parser,
specifically PRB-008: variant children without `position_number` not linked to parent.

## Files

| File | Description |
|------|-------------|
| `_gen.mjs` | Deterministic generator (node script, uses pdfkit 0.17.x) |
| `01_radiator_variants_no_position.pdf` | Radiator variants (C11-..., C21-...) — children without position |
| `01_radiator_variants_no_position.expected.json` | Expected parse output for case 01 |
| `02_dn_children.pdf` | DN/Ду children under pipe parents |
| `02_dn_children.expected.json` | Expected parse output for case 02 |
| `03_to_zhe_children.pdf` | "То же" children under duct/grille parents |
| `03_to_zhe_children.expected.json` | Expected parse output for case 03 |
| `04_mixed.pdf` | Mixed: variant + DN + "То же" children in one document |
| `04_mixed.expected.json` | Expected parse output for case 04 |
| `05_negative_no_parent_variant.pdf` | Negative case: orphan variant with no preceding parent |
| `05_negative_no_parent_variant.expected.json` | Expected parse output for case 05 |
| `README.md` | This file |

## SHA256 Hashes

```
01_radiator_variants_no_position.pdf  1D47E6A6DD8252ED51E2818720EF83A809D80545CCE78B4CA7EE91B38B8CF2DC
02_dn_children.pdf                    1BCBAB1E053C036927E6954D2DEC01950DB4A00953D6CB2EAA9D1917B4C7231F
03_to_zhe_children.pdf                4F3609A8121B2D25B4A2ABED5343E0594A3A4A1758180E7DEEEB73E2C361DA4C
04_mixed.pdf                          54009FEA083894C8AF124C8EFA8F2AE80F87DEE0FF723C83026753E84A72FC7E
05_negative_no_parent_variant.pdf     94E82DC02A0D9C8702EA839239CE30FFA3BEB53D5D46596F2A7420505EBC15E0
```

## Case Descriptions

### Case 01 — Radiator variants without position_number
- Parent 1: pos=1, "Стальной панельный радиатор Royal Thermo Compact С 11", 13 шт
- 13 variant children: C11-300-500 through C11-500-1200 (no position_number, 1 шт each)
- Parent 2: pos=2, "Стальной панельный радиатор Royal Thermo Compact С 21", 2 шт
- 2 variant children: C21-500-800, C21-500-1200
- **Expected:** all children linked via `_parentIndex` to their parent, `full_name` = "parent child_name"

### Case 02 — DN children
- Parent "Труба стальная электросварная" with DN 50, DN 80, DN 100, Ду 150
- Parent "Отвод стальной" with DN 50, DN 80
- **Expected:** DN children linked to parent, full_name like "Труба стальная электросварная DN 50"

### Case 03 — "То же" children
- Parent "Воздуховод оцинкованный 200x200" with "То же, 300x200", "То же, 400x200", "То же"
- Parent "Решетка вентиляционная РВ-1" with "То же, РВ-2", "То же"
- **Expected:** children linked, name expanded to include parent context

### Case 04 — Mixed types in one document
- Parent "Радиатор биметаллический Rifar Base 500" with variant children: 500-10, 500-12, 500-14
- Parent "Труба полипропиленовая" with DN children: DN 20, DN 25, DN 32
- Parent "Хомут стальной" with "То же" child: "То же, оцинкованный"
- **Expected:** all three child types correctly linked to respective parents

### Case 05 — Negative: orphan variant (no parent)
- First row: "C22-300-500" (variant child with NO preceding parent)
- Then: parent "Радиатор алюминиевый" pos=1 with children "C22-350-500", "C22-350-600"
- **Expected:** orphan variant NOT linked (_parentIndex=null), children linked to parent

## Expected JSON Format

Each `.expected.json` is a `SpecificationRow[]` array. Key fields for parent-child linking:

- `_parentIndex`: index of parent item in the array (null for parents)
- `full_name`: "parent_name child_name" for linked children (null for parents)
- `position_number`: string for parent rows, null for children

## Regeneration

```bash
node backend/tests/fixtures/spec-pdf/_gen.mjs
```

The generator is fully deterministic (seeded PRNG replaces Math.random, fixed CreationDate).
Repeated runs produce bit-identical PDFs.

## Notes

- All data is synthetic — no real INN, BIK, company names, or personal data
- PDFs are simple text tables with columns: Позиция, Наименование, Характеристики, Ед., Кол-во
- Generated with pdfkit 0.17.2 (from backend devDependencies)
- Expected JSONs reflect behavior AFTER the F4 fix for PRB-008
