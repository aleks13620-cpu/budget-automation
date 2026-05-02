"""
Validate phase0_audit.xlsx for benchmark readiness.
Checks: separator consistency, item count, broken entries, empty statuses.
Usage: python scripts/validate_phase0.py
"""
import openpyxl
import sys

AUDIT_FILE = "scripts/phase0_audit.xlsx"
HEADER_ROW = 2  # row with column labels
DATA_START = 3  # first data row

COL_NUM        = 1   # A: №
COL_FILE       = 2   # B: Файл счёта
COL_SUPPLIER   = 3   # C: Поставщик
COL_COUNT      = 4   # D: Кол-во позиций (эталон)
COL_NAMES      = 5   # E: Наименования позиций
COL_NAME_ST    = 6   # F: Статус наименований
COL_PRICES     = 7   # G: Цена за ед. с НДС
COL_PRICE_ST   = 8   # H: Статус цен
COL_QTYS       = 9   # I: Кол-во и ед.изм.
COL_QTY_ST     = 10  # J: Статус кол-ва
COL_SECTION    = 11  # K: Родительский раздел


def split_field(val):
    if val is None:
        return []
    return [x.strip() for x in str(val).replace("\n", ";").split(";") if x.strip()]


def check_row(row_num, row):
    errors = []
    filename = row[COL_FILE - 1]
    if not filename:
        return []  # empty row, skip

    names_raw  = row[COL_NAMES - 1]
    prices_raw = row[COL_PRICES - 1]
    qtys_raw   = row[COL_QTYS - 1]
    expected_count = row[COL_COUNT - 1]

    # 1. Row not filled at all
    if not names_raw:
        errors.append("НЕ ЗАПОЛНЕНО — строка пропущена")
        return errors

    # 2. Newlines inside cell (ambiguous separator)
    if names_raw and "\n" in str(names_raw):
        errors.append("Наименования: содержит переносы строк — замените на ; и уберите Enter")
    if prices_raw and "\n" in str(prices_raw):
        errors.append("Цены: содержит переносы строк — замените на ; и уберите Enter")
    if qtys_raw and "\n" in str(qtys_raw):
        errors.append("Кол-во: содержит переносы строк — замените на ; и уберите Enter")

    names  = split_field(names_raw)
    prices = split_field(prices_raw)
    qtys   = split_field(qtys_raw)

    # 3. Item count mismatch
    if expected_count and len(names) != int(expected_count):
        errors.append(
            f"Кол-во позиций: эталон={expected_count}, найдено в ячейке={len(names)}"
        )

    # 4. Counts don't match across fields
    if prices and len(prices) != len(names):
        errors.append(
            f"Цены ({len(prices)}) не совпадают по кол-ву с наименованиями ({len(names)})"
        )
    if qtys and len(qtys) != len(names):
        errors.append(
            f"Кол-во/ед ({len(qtys)}) не совпадает по кол-ву с наименованиями ({len(names)})"
        )

    # 5. Broken item names (name seems split mid-word by accidental semicolon)
    for i, name in enumerate(names):
        words = name.split()
        if words and len(words[0]) <= 3 and name[0].islower():
            errors.append(
                f"Позиция {i+1}: подозрительно короткое начало '{name[:30]}' — возможна разбивка пополам"
            )

    # 6. Status columns empty when data is filled
    name_st  = row[COL_NAME_ST - 1]
    price_st = row[COL_PRICE_ST - 1]
    qty_st   = row[COL_QTY_ST - 1]
    if not name_st:
        errors.append("Статус наименований не заполнен — укажите ОК или Ошибка")
    if prices and not price_st:
        errors.append("Статус цен не заполнен — укажите ОК или Обновление")
    if qtys and not qty_st:
        errors.append("Статус кол-ва не заполнен — укажите ОК или Ошибка")

    return errors


def main():
    try:
        wb = openpyxl.load_workbook(AUDIT_FILE, data_only=True)
    except FileNotFoundError:
        print(f"Файл не найден: {AUDIT_FILE}")
        sys.exit(1)

    ws = wb.active
    total_rows = 0
    filled_rows = 0
    all_errors = {}

    for row in ws.iter_rows(min_row=DATA_START, values_only=True):
        row_num = (row[0] or "?")
        filename = row[COL_FILE - 1]
        if not filename:
            continue
        total_rows += 1
        errs = check_row(row_num, row)
        if errs:
            all_errors[f"#{row_num} {filename}"] = errs
        else:
            filled_rows += 1

    print(f"\n{'='*60}")
    print(f"Фаза 0 — Валидация: {AUDIT_FILE}")
    print(f"{'='*60}")
    print(f"Всего строк: {total_rows}  |  Готовы к бенчмарку: {filled_rows}")
    print()

    if not all_errors:
        print("Все заполненные строки прошли проверку.")
    else:
        for label, errs in all_errors.items():
            print(f"  {label}")
            for e in errs:
                print(f"    • {e}")
            print()

    print(f"{'='*60}\n")
    return 0 if not all_errors else 1


if __name__ == "__main__":
    sys.exit(main())
