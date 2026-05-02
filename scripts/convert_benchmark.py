import openpyxl
import json
from datetime import datetime, timezone

EXCEL_PATH = r'c:\Users\home\vscode101\budget-automation\scripts\benchmark-draft.xlsx'
JSON_PATH = r'c:\Users\home\vscode101\budget-automation\scripts\benchmark-data.json'
SHEET_NAME = 'Эталон'

SKIP_STATUSES = {'пропустить', 'вопрос'}
INCLUDE_STATUSES = {'ок', 'исправлено'}


def parse_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(',', '.').replace('\xa0', '').replace(' ', '')
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def main():
    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
    ws = wb[SHEET_NAME]

    items = []
    total_rows = 0
    skipped = 0
    null_price = []
    null_qty = []

    for row in ws.iter_rows(min_row=2, values_only=True):
        # Unpack columns A–N (14 columns)
        if len(row) < 14:
            row = list(row) + [None] * (14 - len(row))
        (file_, row_num, name_agent, section, qty_agent, unit,
         price_agent, vat_rate, price_method, comment,
         status, name_fix, price_fix, qty_fix) = row[:14]

        # Skip completely empty rows
        if all(v is None for v in (file_, row_num, name_agent, status)):
            continue

        total_rows += 1

        status_norm = str(status).strip().lower() if status else ''

        if status_norm in SKIP_STATUSES or status_norm not in INCLUDE_STATUSES:
            skipped += 1
            continue

        name = str(name_fix).strip() if name_fix else (str(name_agent).strip() if name_agent else '')
        price = parse_number(price_fix) if price_fix is not None else parse_number(price_agent)
        qty = parse_number(qty_fix) if qty_fix is not None else parse_number(qty_agent)
        unit_str = str(unit).strip() if unit else ''
        file_str = str(file_).strip() if file_ else ''
        section_str = str(section).strip() if section else ''
        vat_str = str(vat_rate).strip() if vat_rate else ''
        row_number = int(row_num) if row_num is not None else None

        item = {
            'file': file_str,
            'row_number': row_number,
            'section': section_str,
            'name': name,
            'quantity': qty,
            'unit': unit_str,
            'price_with_vat': price,
            'vat_rate': vat_str,
        }
        items.append(item)

        if price is None:
            null_price.append(file_str)
        if qty is None:
            null_qty.append(file_str)

    included = len(items)
    unique_files = sorted(set(i['file'] for i in items if i['file']))

    output = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'total_rows': included,
        'files': unique_files,
        'items': items,
    }

    with open(JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Verify the file is valid JSON
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        loaded = json.load(f)
    assert len(loaded['items']) == included, 'Item count mismatch after reload'

    print(f'Всего строк в Excel (без заголовка): {total_rows}')
    print(f'Включено в JSON (ОК + Исправлено):   {included}')
    print(f'Пропущено:                            {skipped}')
    print(f'Файлов охвачено:                      {len(unique_files)}')
    print(f'Строк с price_with_vat = null:        {len(null_price)}')
    print(f'Строк с quantity = null:              {len(null_qty)}')

    if included > 0 and len(null_price) / included > 0.05:
        bad_files = sorted(set(null_price))
        print(f'\nПРЕДУПРЕЖДЕНИЕ: более 5% строк без цены. Файлы:')
        for bf in bad_files:
            print(f'  {bf}')

    print(f'\nbenchmark-data.json создан и валиден. Путь: {JSON_PATH}')


if __name__ == '__main__':
    main()
