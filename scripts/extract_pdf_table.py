"""
Извлечение таблицы спецификации из PDF через pdfplumber + PyMuPDF.

PyMuPDF (fitz) — быстрое сканирование страниц (<2 сек на 55 стр.)
pdfplumber — точное извлечение таблиц (только на нужных страницах)

Вход: путь к PDF
Выход: JSON на stdout в формате {items: [{position, name, ...}]}

Запуск: python -X utf8 scripts/extract_pdf_table.py path/to/spec.pdf
"""

import sys
import os
import re
import json
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import fitz
import pdfplumber

HEADER_KEYWORDS = {
    'position_number': ['позици', 'поз', '№ п', 'п/п'],
    'name': ['наименование', 'название'],
    'characteristics': ['тип', 'обозначение', 'характеристик', 'стандарт'],
    'equipment_code': ['код оборудования', 'код изделия'],
    'manufacturer': ['поставщик', 'производител', 'изготовител', 'завод'],
    'unit': ['единица', 'ед.', 'ед '],
    'quantity': ['количест', 'кол-во', 'кол.'],
    'mass_per_unit': ['масса един', 'масса ед'],
    'total_mass': ['масса'],
    'note': ['примечание', 'прим.'],
}

SECTION_RE = re.compile(
    r'^(ОВ\d|СО\d|СВ\d|ВК\d|отопление|вентиляция|водоснабжение|канализация|'
    r'кондиционирование|тепломеханика|автоматизация|электрика|слаботочка|'
    r'материалы|оборудование|раздел)\b', re.I
)
SUMMARY_RE = re.compile(r'^(итого|всего|общий итог)', re.I)
COL_NUM_RE = re.compile(r'^\d{1,2}$')
POS_RE = re.compile(r'^(\d{1,3})\.?$')
UNIT_VALUES = re.compile(r'^(шт|м|мм|кг|компл|комп|т|л|п\.?м|м[²2³3]|м\.п|уп|рул|пач|бухт)\.?$', re.I)
NUMBER_RE = re.compile(r'^\d+([.,]\d+)?$')

NON_SPEC_TABLE_KEYWORDS = re.compile(
    r'(ведомость рабочих|ссылочные документ|расход тепла|расход холода|'
    r'установочная мощ|название листа|номер листа|объем,?\s*м[³3]|'
    r'период.*года|температур.*расчет|тепловые нагрузки|'
    r'характеристика помещен|экспликац|ведомость перемычек)', re.I
)

SPEC_PAGE_KEYWORDS = [
    'наименование', 'количеств', 'кол-во', 'спецификац',
    'ед.изм', 'ед. изм', 'единица изм',
]

MIN_SPEC_TABLE_ROWS = 4
MIN_SPEC_TABLE_COLS = 5


def clean_cell(cell):
    if cell is None:
        return ''
    return re.sub(r'\s+', ' ', str(cell)).strip()


def norm_header(cell):
    """Normalize a header cell for keyword matching.

    Multi-line column headers in proj drawings are soft-hyphenated when they
    wrap inside a narrow cell, e.g. "Коли-\\nчество", "Едини-\\nца изме-\\nрения",
    "Код обору- дования". A trailing hyphen splits the word across lines, so a
    plain whitespace-collapse leaves "коли- чество" — and substring keywords like
    "количест"/"единица" no longer match, silently losing the column.
    Joining hyphen+following-whitespace reconstructs the word: "количество",
    "единица измерения", "код оборудования". Returns lowercase.
    """
    if cell is None:
        return ''
    joined = re.sub(r'-\s*', '', str(cell))      # join hyphen-wrapped words
    return re.sub(r'\s+', ' ', joined).strip().lower()


def parse_float(text):
    if not text:
        return None
    text = text.strip().replace(',', '.').replace(' ', '')
    try:
        val = float(text)
        if val != val:
            return None
        return val
    except (ValueError, TypeError):
        return None


# ── Phase 1: Fast page scan with PyMuPDF ──

def scan_pages_fast(pdf_path):
    """Return set of 0-based page indices that likely contain specification tables."""
    doc = fitz.open(pdf_path)
    candidate_pages = set()

    for pi in range(len(doc)):
        text = doc[pi].get_text().lower()
        if len(text.strip()) < 50:
            continue
        if NON_SPEC_TABLE_KEYWORDS.search(text):
            continue
        has_spec_kw = any(kw in text for kw in SPEC_PAGE_KEYWORDS)
        has_numbers = bool(re.search(r'\b\d{1,4}[.,]\d', text))
        has_units = bool(re.search(r'\b(шт|м²|кг|компл|м\.п)\b', text, re.I))
        if has_spec_kw or (has_numbers and has_units) or len(text) > 500:
            candidate_pages.add(pi)

    doc.close()
    return candidate_pages


# ── Phase 2: Column mapping ──

def detect_column_mapping(header_cells):
    mapping = {}
    for col_idx, cell in enumerate(header_cells):
        # De-hyphenate wrapped headers before matching (norm_header), otherwise
        # "Коли-\nчество"/"Едини-\nца изме-\nрения" miss "количест"/"единица".
        text = norm_header(cell)
        if not text:
            continue
        for field, keywords in HEADER_KEYWORDS.items():
            if field in mapping:
                continue
            for kw in keywords:
                if kw.lower() in text:
                    mapping[field] = col_idx
                    break
    used_cols = set()
    final = {}
    for field, col in mapping.items():
        if col not in used_cols:
            final[field] = col
            used_cols.add(col)
    return final


def infer_mapping_from_data(data_rows):
    if not data_rows:
        return {}

    num_cols = max(len(row) for row in data_rows)
    col_stats = []
    for ci in range(num_cols):
        stats = {'total': 0, 'numbers': 0, 'units': 0, 'positions': 0, 'text_len_sum': 0}
        for row in data_rows:
            if ci >= len(row):
                continue
            val = clean_cell(row[ci])
            if not val:
                continue
            stats['total'] += 1
            stats['text_len_sum'] += len(val)
            if NUMBER_RE.match(val):
                stats['numbers'] += 1
            if UNIT_VALUES.match(val):
                stats['units'] += 1
            if POS_RE.match(val):
                stats['positions'] += 1
        stats['avg_len'] = stats['text_len_sum'] / stats['total'] if stats['total'] else 0
        col_stats.append(stats)

    mapping = {}
    used = set()
    min_sample = max(3, len(data_rows) // 4)

    for ci, s in enumerate(col_stats):
        if s['total'] >= min_sample and s['positions'] / s['total'] > 0.3:
            mapping['position_number'] = ci
            used.add(ci)
            break

    for ci, s in enumerate(col_stats):
        if ci in used:
            continue
        if s['total'] >= min_sample and s['units'] / s['total'] > 0.4:
            mapping['unit'] = ci
            used.add(ci)
            break

    best_qty, best_score = None, 0
    for ci, s in enumerate(col_stats):
        if ci in used or s['total'] < min_sample:
            continue
        ratio = s['numbers'] / s['total']
        if ratio < 0.5:
            continue
        score = ratio + (0.3 if 'unit' in mapping and abs(ci - mapping['unit']) == 1 else 0)
        if score > best_score:
            best_score, best_qty = score, ci
    if best_qty is not None:
        mapping['quantity'] = best_qty
        used.add(best_qty)

    best_name, best_len = None, 0
    for ci, s in enumerate(col_stats):
        if ci in used or s['total'] < min_sample:
            continue
        if s['avg_len'] > best_len:
            best_len, best_name = s['avg_len'], ci
    if best_name is not None and best_len > 5:
        mapping['name'] = best_name
        used.add(best_name)

    for ci in range(num_cols - 1, -1, -1):
        if ci in used:
            continue
        s = col_stats[ci]
        if s['total'] >= min_sample and s['numbers'] / max(s['total'], 1) > 0.4:
            mapping['mass_per_unit'] = ci
            used.add(ci)
            break

    best_char, best_clen = None, 0
    for ci, s in enumerate(col_stats):
        if ci in used or s['total'] < min_sample:
            continue
        if s['avg_len'] > best_clen and s['avg_len'] > 3:
            best_clen, best_char = s['avg_len'], ci
    if best_char is not None:
        mapping['characteristics'] = best_char
        used.add(best_char)

    return mapping


def merge_mappings(header_mapping, inferred_mapping):
    merged = dict(header_mapping)
    used_cols = set(merged.values())
    for field, col in inferred_mapping.items():
        if field not in merged and col not in used_cols:
            merged[field] = col
            used_cols.add(col)
    return merged


# ── Phase 3: Row classification ──

def is_header_row(cells):
    # De-hyphenate so wrapped headers ("Коли-\nчество", "Едини-\nца изме-\nрения")
    # still satisfy the qty/unit keyword test.
    text = ' '.join(norm_header(c) for c in cells)
    name_kws = ['наименование', 'название', 'описание', 'номенклатура']
    qty_kws = ['количест', 'кол-во', 'кол.', 'к-во']
    unit_kws = ['ед.', 'единиц', 'изм']
    has_name = any(kw in text for kw in name_kws)
    has_qty = any(kw in text for kw in qty_kws)
    has_unit = any(kw in text for kw in unit_kws)
    return has_name and (has_qty or has_unit)


def is_col_number_row(cells):
    non_empty = [clean_cell(c) for c in cells if clean_cell(c)]
    if len(non_empty) < 3:
        return False
    return all(COL_NUM_RE.match(c) for c in non_empty)


def is_empty_table(table):
    filled = 0
    checked = 0
    for row in table[:10]:
        for c in row:
            checked += 1
            if clean_cell(c):
                filled += 1
    return checked > 0 and filled / checked < 0.1


def is_stamp_table(table):
    if len(table) < MIN_SPEC_TABLE_ROWS:
        return True
    if table and len(table[0]) < MIN_SPEC_TABLE_COLS:
        return True
    if is_empty_table(table):
        return True
    text = ' '.join(clean_cell(c) for row in table[:5] for c in row).lower()
    if 'изм.' in text and 'лист' in text and 'подпись' in text:
        return True
    if 'гип' in text and 'н.контр' in text:
        return True
    if NON_SPEC_TABLE_KEYWORDS.search(text):
        return True
    return False


def is_stamp_rows(cells):
    text = ' '.join(clean_cell(c).lower() for c in cells)
    stamp_kws = ['гип', 'н.контр', 'разработал', 'проверил', 'нач.отд', 'подпись', 'дата']
    return sum(1 for kw in stamp_kws if kw in text) >= 2


# ── Phase 4: Item extraction ──

def extract_item(cells, mapping):
    name_col = mapping.get('name')
    if name_col is None:
        return None

    if name_col >= len(cells):
        for ci, c in enumerate(cells):
            txt = clean_cell(c)
            if len(txt) > 5 and not POS_RE.match(txt):
                name_col = ci
                break
        else:
            return None

    name = clean_cell(cells[name_col])
    if not name or len(name) < 2:
        return None

    if SUMMARY_RE.match(name):
        return None

    name_lower = name.lower()
    skip_names = ['наименование', 'название', 'обозначение', 'примечание',
                  'позиция', 'ед. изм', 'количество', 'масса']
    if name_lower in skip_names or name_lower.startswith('наименование '):
        return None

    def get_cell(field):
        col = mapping.get(field)
        if col is not None and col < len(cells):
            return clean_cell(cells[col])
        return ''

    pos_raw = get_cell('position_number')
    pos_match = POS_RE.match(pos_raw) if pos_raw else None
    position = pos_match.group(1) if pos_match else None

    quantity = parse_float(get_cell('quantity'))
    unit = get_cell('unit') or None
    if unit and len(unit) > 15:
        unit = None

    characteristics = get_cell('characteristics') or None
    manufacturer = get_cell('manufacturer') or None
    mass_per_unit = parse_float(get_cell('mass_per_unit'))
    note = get_cell('note') or None
    marking = get_cell('marking') or None

    is_section = bool(SECTION_RE.match(name))

    return {
        'position': position,
        'name': name,
        'characteristics': characteristics,
        'unit': unit,
        'quantity': quantity,
        'mass_per_unit': mass_per_unit,
        'total_mass': None,
        'manufacturer': manufacturer,
        'marking': marking,
        'note': note,
        '_is_section': is_section,
    }


# ── Main extraction pipeline ──

def extract_spec_items(pdf_path):
    t0 = time.time()

    # Phase 1: fast scan with PyMuPDF
    candidate_pages = scan_pages_fast(pdf_path)
    scan_time = time.time() - t0
    print(f'[info] Fast scan: {scan_time:.1f}s, {len(candidate_pages)} candidate pages', file=sys.stderr)

    if not candidate_pages:
        print('[warn] No spec pages found in PDF', file=sys.stderr)
        return {'items': [], 'stats': {'pages': 0, 'tables_found': 0}}

    # Phase 2: extract tables with pdfplumber (only candidate pages)
    pdf = pdfplumber.open(pdf_path)
    items = []
    stats = {
        'pages': len(pdf.pages),
        'pages_processed': len(candidate_pages),
        'pages_skipped': len(pdf.pages) - len(candidate_pages),
        'tables_found': 0,
        'header_detections': 0,
    }

    for page_idx in sorted(candidate_pages):
        if page_idx >= len(pdf.pages):
            continue

        page = pdf.pages[page_idx]
        tables = page.extract_tables() or []

        for table in tables:
            if not table:
                continue
            if is_stamp_table(table):
                continue

            stats['tables_found'] += 1
            page_mapping = None
            data_rows_buf = []

            for row in table:
                if not row:
                    continue

                if is_header_row(row):
                    header_mapping = detect_column_mapping(row)
                    stats['header_detections'] += 1
                    data_sample = [r for r in table if r and not is_header_row(r) and not is_col_number_row(r)][:20]
                    inferred = infer_mapping_from_data(data_sample)
                    page_mapping = merge_mappings(header_mapping, inferred)
                    if page_idx < 5:
                        print(f'[info] p{page_idx+1}: header mapping={page_mapping}', file=sys.stderr)
                    continue

                if is_col_number_row(row):
                    continue
                if is_stamp_rows(row):
                    continue

                cells = [clean_cell(c) for c in row]
                combined = ' '.join(cells)
                if len(combined) < 3:
                    continue
                non_empty = [c for c in cells if c]
                if non_empty and all(len(c) <= 2 for c in non_empty):
                    continue

                if page_mapping is None:
                    data_rows_buf.append(row)
                    if len(data_rows_buf) >= 15:
                        page_mapping = infer_mapping_from_data(data_rows_buf)
                        if 'name' in page_mapping:
                            print(f'[info] p{page_idx+1}: inferred mapping={page_mapping}', file=sys.stderr)
                            stats['inferred_pages'] = stats.get('inferred_pages', 0) + 1
                        else:
                            page_mapping = None
                    continue

                item = extract_item(row, page_mapping)
                if item:
                    items.append(item)

            if page_mapping and data_rows_buf:
                for row in data_rows_buf:
                    item = extract_item(row, page_mapping)
                    if item:
                        items.append(item)
                data_rows_buf.clear()

    pdf.close()

    section_count = sum(1 for it in items if it.get('_is_section'))
    data_count = len(items) - section_count

    for it in items:
        del it['_is_section']

    stats['items_total'] = len(items)
    stats['data_items'] = data_count
    stats['section_headers'] = section_count
    total_time = time.time() - t0
    print(f'[info] Extracted {data_count} items + {section_count} sections from {stats["pages"]} pages '
          f'({stats["pages_processed"]} processed, {stats["pages_skipped"]} skipped) '
          f'in {total_time:.1f}s', file=sys.stderr)

    return {'items': items, 'stats': stats}


def main():
    if len(sys.argv) < 2:
        print('Usage: python extract_pdf_table.py <path_to_pdf>', file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.isfile(pdf_path):
        print(f'File not found: {pdf_path}', file=sys.stderr)
        sys.exit(1)

    result = extract_spec_items(pdf_path)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
