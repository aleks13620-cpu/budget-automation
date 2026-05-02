"""
Compare parser output against phase0_audit.xlsx reference data.
Usage: python scripts/compare_phase0.py <parser_output.json>

Parser output JSON must be a list of objects with fields:
  file, supplier, items: [{name, price, qty, article?}]
"""
import json
import sys
import openpyxl
from difflib import SequenceMatcher

AUDIT_FILE = "scripts/phase0_audit.xlsx"
DATA_START = 3

COL_FILE    = 2
COL_COUNT   = 4
COL_NAMES   = 5
COL_PRICES  = 7
COL_QTYS    = 9


def split_field(val):
    if val is None:
        return []
    return [x.strip() for x in str(val).replace("\n", ";").split(";") if x.strip()]


def load_reference():
    wb = openpyxl.load_workbook(AUDIT_FILE, data_only=True)
    ws = wb.active
    ref = {}
    for row in ws.iter_rows(min_row=DATA_START, values_only=True):
        filename = row[COL_FILE - 1]
        if not filename or not row[COL_NAMES - 1]:
            continue
        ref[str(filename)] = {
            "expected_count": row[COL_COUNT - 1],
            "names":  split_field(row[COL_NAMES - 1]),
            "prices": split_field(row[COL_PRICES - 1]),
            "qtys":   split_field(row[COL_QTYS - 1]),
        }
    return ref


def similarity(a, b):
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def compare_file(filename, ref, parsed):
    issues = []
    ref_names  = ref["names"]
    ref_prices = ref["prices"]
    ref_qtys   = ref["qtys"]
    parsed_items = parsed.get("items", [])

    # Count check
    if len(parsed_items) != len(ref_names):
        issues.append(
            f"Кол-во позиций: ожидалось {len(ref_names)}, получено {len(parsed_items)}"
        )

    # Per-item comparison
    for i, ref_name in enumerate(ref_names):
        if i >= len(parsed_items):
            issues.append(f"  Позиция {i+1}: отсутствует в выводе парсера (ожидалось: {ref_name[:50]})")
            continue
        parsed_name = parsed_items[i].get("name", "")
        sim = similarity(ref_name, parsed_name)
        if sim < 0.85:
            issues.append(
                f"  Позиция {i+1} наименование (схожесть {sim:.0%}):\n"
                f"    Эталон:  {ref_name[:80]}\n"
                f"    Парсер:  {parsed_name[:80]}"
            )

        if i < len(ref_prices):
            ref_price = ref_prices[i].replace(",", ".").replace(" ", "")
            parsed_price = str(parsed_items[i].get("price", "")).replace(",", ".").replace(" ", "")
            if ref_price and parsed_price and ref_price != parsed_price:
                issues.append(
                    f"  Позиция {i+1} цена: эталон={ref_prices[i]}, парсер={parsed_items[i].get('price')}"
                )

        if i < len(ref_qtys):
            ref_qty = ref_qtys[i]
            parsed_qty = str(parsed_items[i].get("qty", ""))
            if ref_qty and parsed_qty and ref_qty != parsed_qty:
                issues.append(
                    f"  Позиция {i+1} кол-во: эталон={ref_qty}, парсер={parsed_qty}"
                )

    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python compare_phase0.py <parser_output.json>")
        sys.exit(1)

    try:
        ref = load_reference()
    except FileNotFoundError:
        print(f"Эталонный файл не найден: {AUDIT_FILE}")
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        parser_output = json.load(f)  # list of {file, items:[{name,price,qty}]}

    output_by_file = {p["file"]: p for p in parser_output}

    print(f"\n{'='*60}")
    print("Фаза 0 — Сравнение парсера с эталоном")
    print(f"{'='*60}\n")

    total_files = 0
    ok_files = 0
    for filename, ref_data in ref.items():
        total_files += 1
        if filename not in output_by_file:
            print(f"[ПРОПУЩЕН] {filename} — нет в выводе парсера\n")
            continue
        issues = compare_file(filename, ref_data, output_by_file[filename])
        if issues:
            print(f"[ОШИБКИ] {filename}")
            for iss in issues:
                print(f"  {iss}")
            print()
        else:
            ok_files += 1
            print(f"[ОК] {filename}")

    print(f"\n{'='*60}")
    print(f"Итого: {ok_files}/{total_files} файлов без ошибок")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
