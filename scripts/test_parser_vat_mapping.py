"""
RED-тест pdfplumber-маппера: различение «Сумма НДС» (налог) и «Сумма» (итог).
Баг H3 (#10/#12): detect_column_mapping берёт первое вхождение подстроки «сумма»,
поэтому amount привязывается к «Сумма НДС» (она левее «Сумма»).

Запуск: python -X utf8 scripts/test_parser_vat_mapping.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_invoice_table import detect_column_mapping, parse_number, _classify_column_vat

failures = 0


def check(name, cond, details=''):
    global failures
    if cond:
        print(f'  PASS  {name}')
    else:
        print(f'  FAIL  {name}{(" -- " + details) if details else ""}')
        failures += 1


# ── Case A: структура счёта 30 — «Сумма НДС» И «Сумма» вместе ──
print('Case A: invoice #30 header (Сумма НДС + Сумма)')
header_a = ['№', 'Артикул', 'Товары (работы, услуги)', 'Количество', 'Ед.', 'Цена', 'Ставка НДС', 'Сумма НДС', 'Сумма']
data_a = ['1', 'SDZ134', 'УСИЛ.МУФТА', '124', 'шт', '190,99', '22%', '4 270,65', '23 682,70']
m_a = detect_column_mapping(header_a)
print(f'    mapping: {m_a}')
check('A: amount = col 8 (Сумма, итог)', m_a.get('amount') == 8, f'got {m_a}')
check('A: price  = col 5 (Цена)', m_a.get('price') == 5, f'got {m_a}')
if m_a.get('amount') is not None and m_a.get('quantity') is not None:
    amount = parse_number(data_a[m_a['amount']])
    qty = parse_number(data_a[m_a['quantity']])
    unit = round(amount / qty, 2) if amount is not None and qty else None
    check('A: derived unit ~= 190.99 (= колонка «Цена»)',
          unit is not None and abs(unit - 190.99) < 0.5,
          f'got {unit} (buggy col «Сумма НДС» дал бы 4270.65/124 = 34.44)')

# ── Case B: только «Сумма» (guard) ──
print('Case B: only Сумма')
m_b = detect_column_mapping(['№', 'Наименование', 'Количество', 'Цена', 'Сумма'])
print(f'    mapping: {m_b}')
check('B: amount = col 4 (Сумма)', m_b.get('amount') == 4, f'got {m_b}')

# ── Case C: «Сумма с НДС» должна остаться amount (guard) ──
print('Case C: Сумма с НДС (must stay amount)')
m_c = detect_column_mapping(['№', 'Наименование', 'Количество', 'Цена без НДС', 'Сумма с НДС'])
print(f'    mapping: {m_c}')
check('C: amount = col 4 (Сумма с НДС)', m_c.get('amount') == 4, f'got {m_c}')
check('C: price  = col 3 (Цена без НДС)', m_c.get('price') == 3, f'got {m_c}')

# ── Case D: «Сумма без НДС» + «Сумма» → итог = «Сумма» (guard) ──
print('Case D: Сумма без НДС + Сумма')
m_d = detect_column_mapping(['№', 'Наименование', 'Количество', 'Цена', 'Сумма без НДС', 'Сумма'])
print(f'    mapping: {m_d}')
check('D: amount = col 5 (Сумма, с НДС)', m_d.get('amount') == 5, f'got {m_d}')

# ── Case E: колонка «Итого» — CARRY-1 guard ──
# Before the fix Python HEADER_KEYWORDS['amount'] lacked 'итого', so this column
# was not detected at all (amount == None).  After adding it, amount == 4.
print('Case E: Итого column (CARRY-1 — итого keyword)')
m_e = detect_column_mapping(['№', 'Наименование', 'Количество', 'Цена', 'Итого'])
print(f'    mapping: {m_e}')
check('E: amount = col 4 (Итого)', m_e.get('amount') == 4, f'got {m_e}')

# ── Case F: колонка «Всего» — CARRY-1 guard ──
# Similarly 'всего' was absent before the fix.
print('Case F: Всего column (CARRY-1 — всего keyword)')
m_f = detect_column_mapping(['№', 'Наименование', 'Количество', 'Цена', 'Всего'])
print(f'    mapping: {m_f}')
check('F: amount = col 4 (Всего)', m_f.get('amount') == 4, f'got {m_f}')

# ── Case G: _classify_column_vat — vatness выбранной колонки (Фича #1) ──
# Зеркало classifyColumnVat в backend/src/services/pdfParser.ts. true=брутто(с НДС),
# false=нетто(без НДС), None=нейтрально (в т.ч. голая «Сумма НДС» — налоговая колонка).
print('Case G: _classify_column_vat (Feature #1 — VAT exactly once)')
check('G: "Сумма с НДС" -> gross/True', _classify_column_vat('Сумма с НДС') is True,
      f'got {_classify_column_vat("Сумма с НДС")!r}')
check('G: "Цена без НДС" -> net/False', _classify_column_vat('Цена без НДС') is False,
      f'got {_classify_column_vat("Цена без НДС")!r}')
check('G: "Сумма" -> neutral/None', _classify_column_vat('Сумма') is None,
      f'got {_classify_column_vat("Сумма")!r}')
check('G: "Сумма НДС" (налоговая) -> neutral/None', _classify_column_vat('Сумма НДС') is None,
      f'got {_classify_column_vat("Сумма НДС")!r}')
check('G: "Всего с учётом НДС" -> gross/True', _classify_column_vat('Всего с учётом НДС') is True,
      f'got {_classify_column_vat("Всего с учётом НДС")!r}')
check('G: пусто -> None', _classify_column_vat('') is None, f'got {_classify_column_vat("")!r}')

# ── Case H: «Сумма без скидки» НЕ выбирается, когда есть итоговая «Сумма с НДС» ──
# Feature #2: discount scorer fix. Before the fix, /скидк/ gave +30 to «Сумма без скидки»,
# beating «Сумма с НДС» (+20) → pre-discount column was chosen → budget overstatement.
# After the fix: /без\s+скидк/ → -20, so «Сумма с НДС» (+20) wins correctly.
print('Case H: Сумма без скидки vs Сумма с НДС (Feature #2 — discount scorer)')
header_h = ['№', 'Наименование', 'Кол-во', 'Цена', 'Сумма без скидки', 'Сумма с НДС']
m_h = detect_column_mapping(header_h)
print(f'    mapping: {m_h}')
check('H: amount = col 5 (Сумма с НДС, not Сумма без скидки)', m_h.get('amount') == 5,
      f'got {m_h} — "Сумма без скидки" (col 4) must NOT be chosen')

print('')
if failures:
    print(f'{failures} assertion(s) FAILED')
    sys.exit(1)
print('All Python parser-mapping assertions passed')
