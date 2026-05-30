"""
Извлечение таблицы счёта/заказа из PDF через pdfplumber + PyMuPDF.

PyMuPDF (fitz) — быстрое сканирование страниц
pdfplumber — точное извлечение таблиц

Вход: путь к PDF
Выход: JSON на stdout в формате {items: [...], metadata: {...}, stats: {...}}

Запуск: python -X utf8 scripts/extract_invoice_table.py path/to/invoice.pdf
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

# ── Column keywords for invoice tables ──

HEADER_KEYWORDS = {
    'num': ['№ п/п', '№п/п', 'п/п', '№'],
    'article': ['артикул', 'арт.', 'арт', 'код товара', 'код', 'каталожный', 'номенклатурный'],
    'name': ['наименование', 'товар', 'название', 'описание', 'номенклатура',
             'товары', 'работы', 'услуги', 'продукция', 'материал'],
    'unit': ['ед.', 'единица', 'ед. изм', 'ед.изм', 'изм'],
    'quantity': ['количество', 'кол-во', 'кол.', 'к-во'],
    'price': ['цена', 'стоимость за ед', 'цена за ед', 'цена с ндс',
              'цена без ндс', 'цена,руб', 'цена руб'],
    'amount': ['сумма', 'total', 'стоимость', 'итого', 'сумма с ндс', 'всего с ндс', 'сумма с учётом ндс', 'сумма,руб', 'сумма руб', 'всего'],
}

# ── Patterns ──

SUMMARY_RE = re.compile(
    r'^(итого|всего|total|в т\.?ч\.?\s*ндс|ндс|итого к оплате|'
    r'итого с ндс|итого без ндс|всего к оплате|'
    r'итого по счёту|итого по счету)\b', re.I
)

REQUISITES_RE = re.compile(
    r'(бик|инн|кпп|р/с|к/с|расч[её]тный\s*сч[её]т|корреспондент|'
    r'банк\s|получатель|плательщик|назначение\s*платежа|'
    r'грузополучатель|грузоотправитель)', re.I
)

INVOICE_PAGE_KEYWORDS = [
    'наименование', 'количеств', 'кол-во', 'цена', 'сумма',
    'стоимость', 'ед.изм', 'ед. изм', 'единица изм',
    'артикул', 'товар', 'счет', 'счёт', 'заказ',
]

COL_NUM_RE = re.compile(r'^\d{1,2}$')
ROW_NUM_RE = re.compile(r'^(\d{1,4})\.?$')
UNIT_VALUES = re.compile(
    r'^(шт|м|мм|кг|компл|комп|т|л|п\.?м|м[²2³3]|м\.п|уп|рул|пач|бухт|погон|пог)\.?$', re.I
)
NUMBER_RE = re.compile(r'^[\d\s]+([.,]\d+)?$')

MIN_TABLE_ROWS = 3
MIN_TABLE_COLS = 4


def clean_cell(cell):
    if cell is None:
        return ''
    return re.sub(r'\s+', ' ', str(cell)).strip()


def parse_number(text):
    """Parse number with thousand separators: '1 275,30' → 1275.30"""
    if not text:
        return None
    text = text.strip()
    text = re.sub(r'\s*(?:руб|₽|р)\.?\s*$', '', text, flags=re.I)
    cleaned = text.replace('\xa0', '').replace(' ', '').replace(',', '.')
    if not cleaned:
        return None
    try:
        val = float(cleaned)
        if val != val:
            return None
        return val
    except (ValueError, TypeError):
        return None


# ── Phase 1: Fast page scan with PyMuPDF ──

def scan_pages_fast(pdf_path):
    with fitz.open(pdf_path) as doc:
        candidate_pages = set()
        for pi in range(len(doc)):
            text = doc[pi].get_text().lower()
            if len(text.strip()) < 30:
                continue
            has_invoice_kw = any(kw in text for kw in INVOICE_PAGE_KEYWORDS)
            has_numbers = bool(re.search(r'\b\d[\d\s]*[.,]\d{2}\b', text))
            if has_invoice_kw or has_numbers or len(text) > 300:
                candidate_pages.add(pi)
    return candidate_pages


# ── Phase 2: Column mapping ──

def _score_amount_column(text):
    """Score how strongly a header cell denotes the line-total ('amount') column.
    A bare "НДС" token ("Сумма НДС", "НДС, руб") marks the VAT-amount column, not the
    total → negative. \\b is unreliable for Cyrillic, so the token is bounded by
    non-Cyrillic-letter chars or string edges. Higher score = better amount candidate.
    Keep in sync with scoreVatDiscount in backend/src/services/pdfParser.ts."""
    bare_vat = re.search(r'(?:^|[^а-яё])ндс(?:$|[^а-яё])', text) is not None
    with_vat = re.search(r'с\s+ндс|с\s+учетом\s+ндс|с\s+учётом\s+ндс|включая\s+ндс', text) is not None
    without_vat = re.search(r'без\s+ндс', text) is not None
    score = 0
    if bare_vat and not with_vat and not without_vat:
        score -= 50
    if without_vat:
        score -= 20
    elif with_vat:
        score += 20
    if re.search(r'скидк', text):
        score += 30
    return score


def detect_column_mapping(header_cells):
    mapping = {}
    amount_candidates = []  # (col_idx, score) for every column that looks like a total
    for col_idx, cell in enumerate(header_cells):
        text = clean_cell(cell).lower()
        if not text:
            continue
        if any(kw.lower() in text for kw in HEADER_KEYWORDS['amount']):
            amount_candidates.append((col_idx, _score_amount_column(text)))
        # Greedy first-match for every non-amount field (unchanged behaviour)
        for field, keywords in HEADER_KEYWORDS.items():
            if field == 'amount' or field in mapping:
                continue
            for kw in keywords:
                if kw.lower() in text:
                    mapping[field] = col_idx
                    break
    # Best amount column = highest _score_amount_column; ties → leftmost, preserving the
    # original greedy first-match when scores are equal. Lets "Сумма" win over "Сумма НДС".
    if amount_candidates:
        amount_candidates.sort(key=lambda c: (-c[1], c[0]))
        for col_idx, _score in amount_candidates:
            if col_idx not in mapping.values():
                mapping['amount'] = col_idx
                break
    used_cols = set()
    final = {}
    for field, col in mapping.items():
        if col not in used_cols:
            final[field] = col
            used_cols.add(col)
    return final


def infer_mapping_from_data(data_rows, num_cols=None):
    if not data_rows:
        return {}

    if num_cols is None:
        num_cols = max(len(row) for row in data_rows)
    col_stats = []
    for ci in range(num_cols):
        stats = {'total': 0, 'numbers': 0, 'units': 0, 'positions': 0,
                 'text_len_sum': 0, 'large_numbers': 0}
        for row in data_rows:
            if ci >= len(row):
                continue
            val = clean_cell(row[ci])
            if not val:
                continue
            stats['total'] += 1
            stats['text_len_sum'] += len(val)
            num = parse_number(val)
            if num is not None:
                stats['numbers'] += 1
                if num > 100:
                    stats['large_numbers'] += 1
            if UNIT_VALUES.match(val):
                stats['units'] += 1
            if ROW_NUM_RE.match(val):
                stats['positions'] += 1
        stats['avg_len'] = stats['text_len_sum'] / stats['total'] if stats['total'] else 0
        col_stats.append(stats)

    mapping = {}
    used = set()
    min_sample = max(2, len(data_rows) // 4)

    # num column: mostly sequential numbers
    for ci, s in enumerate(col_stats):
        if s['total'] >= min_sample and s['positions'] / max(s['total'], 1) > 0.3:
            mapping['num'] = ci
            used.add(ci)
            break

    # unit column: units like шт, м, кг
    for ci, s in enumerate(col_stats):
        if ci in used:
            continue
        if s['total'] >= min_sample and s['units'] / max(s['total'], 1) > 0.3:
            mapping['unit'] = ci
            used.add(ci)
            break

    # name column: longest text
    best_name, best_len = None, 0
    for ci, s in enumerate(col_stats):
        if ci in used or s['total'] < min_sample:
            continue
        if s['avg_len'] > best_len:
            best_len, best_name = s['avg_len'], ci
    if best_name is not None and best_len > 5:
        mapping['name'] = best_name
        used.add(best_name)

    # Numeric columns (quantity, price, amount) — right-to-left
    numeric_cols = []
    for ci in range(num_cols - 1, -1, -1):
        if ci in used:
            continue
        s = col_stats[ci]
        if s['total'] >= min_sample and s['numbers'] / max(s['total'], 1) > 0.4:
            numeric_cols.append(ci)

    # amount = rightmost large numbers, price = next, quantity = smaller numbers
    if len(numeric_cols) >= 1:
        mapping['amount'] = numeric_cols[0]
        used.add(numeric_cols[0])
    if len(numeric_cols) >= 2:
        mapping['price'] = numeric_cols[1]
        used.add(numeric_cols[1])
    if len(numeric_cols) >= 3:
        mapping['quantity'] = numeric_cols[2]
        used.add(numeric_cols[2])

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
    text = ' '.join(clean_cell(c).lower() for c in cells)
    name_kws = ['наименование', 'название', 'описание', 'номенклатура', 'товар']
    qty_kws = ['количест', 'кол-во', 'кол.', 'к-во']
    price_kws = ['цена', 'стоимость за']
    amount_kws = ['сумма', 'стоимость']
    unit_kws = ['ед.', 'единиц', 'изм']
    has_name = any(kw in text for kw in name_kws)
    has_qty = any(kw in text for kw in qty_kws)
    has_price = any(kw in text for kw in price_kws)
    has_amount = any(kw in text for kw in amount_kws)
    has_unit = any(kw in text for kw in unit_kws)
    return has_name and (has_qty or has_price or has_amount or has_unit)


def is_col_number_row(cells):
    non_empty = [clean_cell(c) for c in cells if clean_cell(c)]
    if len(non_empty) < 3:
        return False
    return all(COL_NUM_RE.match(c) for c in non_empty)


def is_requisites_table(table):
    text = ' '.join(clean_cell(c) for row in table[:5] for c in row).lower()
    hits = len(REQUISITES_RE.findall(text))
    return hits >= 3


def is_stamp_table(table):
    if len(table) < MIN_TABLE_ROWS:
        return True
    if table and len(table[0]) < MIN_TABLE_COLS:
        return True
    filled = 0
    checked = 0
    for row in table[:10]:
        for c in row:
            checked += 1
            if clean_cell(c):
                filled += 1
    if checked > 0 and filled / checked < 0.1:
        return True
    text = ' '.join(clean_cell(c) for row in table[:5] for c in row).lower()
    if 'изм.' in text and 'лист' in text and 'подпись' in text:
        return True
    return False


def is_summary_row(cells, mapping):
    """Check if row is a summary row (Итого, Всего, etc.)"""
    name_col = mapping.get('name')
    if name_col is not None and name_col < len(cells):
        text = clean_cell(cells[name_col])
        if SUMMARY_RE.match(text):
            return True
    first_text = clean_cell(cells[0]) if cells else ''
    if SUMMARY_RE.match(first_text):
        return True
    combined = ' '.join(clean_cell(c) for c in cells)
    if SUMMARY_RE.match(combined.strip()):
        return True
    return False


# ── Phase 4: Item extraction ──

def extract_item(cells, mapping, row_idx):
    name_col = mapping.get('name')
    if name_col is None:
        return None
    if name_col >= len(cells):
        return None

    name = clean_cell(cells[name_col])
    if not name or len(name) < 2:
        return None

    if SUMMARY_RE.match(name):
        return None

    name_lower = name.lower()
    skip_names = ['наименование', 'название', 'товар', 'услуга',
                  'ед. изм', 'количество', 'цена', 'сумма', 'стоимость',
                  'позиция', 'артикул', 'примечание']
    if name_lower in skip_names:
        return None

    # Skip requisite-like content in name cell
    if REQUISITES_RE.search(name):
        return None

    def get_cell(field):
        col = mapping.get(field)
        if col is not None and col < len(cells):
            return clean_cell(cells[col])
        return ''

    num_raw = get_cell('num')
    num_match = ROW_NUM_RE.match(num_raw) if num_raw else None
    num = num_match.group(1) if num_match else None

    article = get_cell('article') or None
    if article and len(article) > 50:
        article = None

    unit = get_cell('unit') or None
    if unit and len(unit) > 15:
        unit = None

    quantity = parse_number(get_cell('quantity'))
    price = parse_number(get_cell('price'))
    amount = parse_number(get_cell('amount'))

    return {
        'num': num,
        'article': article,
        'name': name,
        'unit': unit,
        'quantity': quantity,
        'price': price,
        'amount': amount,
        'row_index': row_idx,
    }


# ── Metadata extraction ──

MONTH_NAMES = {
    'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
    'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
    'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12',
}


def extract_metadata(pdf_path):
    with fitz.open(pdf_path) as doc:
        text = ''
        for pi in range(min(3, len(doc))):
            text += doc[pi].get_text() + '\n'

    # Normalize non-breaking spaces for regex matching
    normalized = text.replace('\xa0', ' ')
    snippet = normalized[:5000]
    meta = {
        'invoiceNumber': None,
        'invoiceDate': None,
        'supplierName': None,
        'totalAmount': None,
    }

    # Invoice number
    num_match = re.search(
        r'(?:счёт|счет|invoice)\s+(?:на\s+оплату\s+)?[№#]\s*([A-Za-zА-Яа-я0-9\-\/]+)',
        snippet, re.I)
    if num_match:
        meta['invoiceNumber'] = num_match.group(1).strip()
    if not meta['invoiceNumber']:
        # "заказ клиента №NNN" or "КП №NNN" (within same line, max 60 chars window)
        alt_match = re.search(
            r'(?:заказ\s+клиента|КП|коммерческое\s+предложение)\s*[^\n]{0,60}[№#]\s*([A-Za-zА-Яа-я0-9\-\/]+)',
            snippet, re.I)
        if alt_match:
            meta['invoiceNumber'] = alt_match.group(1).strip()
    if not meta['invoiceNumber']:
        # "по заказу 4859" or "заказу №4859" — number after заказ/заказу
        order_match = re.search(
            r'(?:по\s+)?заказу?\s+[№#]?\s*(\d{2,10})', snippet, re.I)
        if order_match:
            meta['invoiceNumber'] = order_match.group(1).strip()
    if not meta['invoiceNumber']:
        # Standalone №, exclude bank accounts and pure Cyrillic words
        standalone = re.search(r'(?<!Сч\.\s)№\s*([A-Za-zА-Яа-я0-9\-\/]{2,15})', snippet)
        if standalone:
            val = standalone.group(1).strip()
            if not re.match(r'^[А-Яа-яЁё]+$', val):
                meta['invoiceNumber'] = val

    # Invoice date — check written month first (more specific, avoids contract dates)
    month_pat = '|'.join(MONTH_NAMES.keys())
    written = re.search(rf'(\d{{1,2}})\s+({month_pat})\s+(\d{{4}})', snippet, re.I)
    if written:
        day = written.group(1).zfill(2)
        month = MONTH_NAMES.get(written.group(2).lower(), '')
        year = written.group(3)
        if month:
            meta['invoiceDate'] = f'{day}.{month}.{year}'
    if not meta['invoiceDate']:
        date_match = re.search(
            r'(?:счёт|счет|заказ)[^\n]{0,40}от\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})',
            snippet, re.I)
        if date_match:
            meta['invoiceDate'] = date_match.group(1).strip()
    if not meta['invoiceDate']:
        date_match = re.search(r'(?:от|date|дата)\s*[:\s]*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})', snippet, re.I)
        if date_match:
            meta['invoiceDate'] = date_match.group(1).strip()
    if not meta['invoiceDate']:
        standalone_date = re.search(r'(\d{2}[.\-/]\d{2}[.\-/]\d{4})', snippet)
        if standalone_date:
            meta['invoiceDate'] = standalone_date.group(1).strip()

    # Supplier name (word boundary prevents matching "Поставщика" in running text)
    supplier_match = re.search(
        r'(?:поставщик|продавец|исполнитель)\b\s*:?\s*\n?\s*([^\n]{3,80})', snippet, re.I)
    if supplier_match:
        raw = supplier_match.group(1).strip()
        # Skip if captured text starts with role continuation like "(исполнитель):"
        raw = re.sub(r'^\(.*?\)\s*:?\s*', '', raw)
        raw = raw.split(',')[0].strip().strip('"«»\'')
        if len(raw) > 2:
            meta['supplierName'] = raw
    if not meta['supplierName']:
        org_match = re.search(
            r'(ООО|ОАО|ЗАО|ПАО|НАО|ФГУП|ИП|АО)\s*[«"\'(]?([^»"\')\\n]{2,50})[»"\')]?',
            snippet)
        if org_match:
            candidate = f'{org_match.group(1)} {org_match.group(2)}'.strip()
            lower = candidate.lower()
            if not any(w in lower for w in ['банк', 'бик', 'р/с', 'к/с', 'акб']):
                meta['supplierName'] = candidate.rstrip('.,;: ')

    # Total amount — search full text (may be at end of document)
    full_norm = normalized[:10000]
    total_match = re.search(
        r'(?:итого|всего|total|итого к оплате)\s*[:\s]*([0-9\s]+[.,]\d{2})',
        full_norm, re.I)
    if total_match:
        meta['totalAmount'] = parse_number(total_match.group(1))

    return meta


# ── Main extraction pipeline ──

def extract_invoice_items(pdf_path):
    t0 = time.time()

    candidate_pages = scan_pages_fast(pdf_path)
    scan_time = time.time() - t0
    print(f'[info] Fast scan: {scan_time:.1f}s, {len(candidate_pages)} candidate pages', file=sys.stderr)

    if not candidate_pages:
        print('[warn] No invoice pages found in PDF', file=sys.stderr)
        meta = extract_metadata(pdf_path)
        return {'items': [], 'metadata': meta, 'stats': {'pages': 0, 'tables_found': 0}}

    all_items = []
    global_row_idx = 0

    with pdfplumber.open(pdf_path) as pdf:
        stats = {
            'pages': len(pdf.pages),
            'pages_processed': len(candidate_pages),
            'tables_found': 0,
            'tables_skipped_requisites': 0,
            'tables_skipped_stamp': 0,
            'header_detections': 0,
            'summary_rows_skipped': 0,
        }

        prev_mapping = None

        for page_idx in sorted(candidate_pages):
            if page_idx >= len(pdf.pages):
                continue

            page = pdf.pages[page_idx]
            tables = page.extract_tables() or []

            for table in tables:
                if not table:
                    continue
                if is_requisites_table(table):
                    stats['tables_skipped_requisites'] += 1
                    continue

                if len(table) == 1 and table[0] and is_header_row(table[0]):
                    stats['header_detections'] += 1
                    if page_idx < 5:
                        print(f'[info] p{page_idx+1}: standalone header detected', file=sys.stderr)
                    continue

                if is_stamp_table(table):
                    if not (prev_mapping and table and len(table[0]) >= MIN_TABLE_COLS):
                        stats['tables_skipped_stamp'] += 1
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
                        data_sample = [r for r in table
                                       if r and not is_header_row(r)
                                       and not is_col_number_row(r)][:20]
                        inferred = infer_mapping_from_data(data_sample)
                        page_mapping = merge_mappings(header_mapping, inferred)
                        prev_mapping = page_mapping
                        if page_idx < 5:
                            print(f'[info] p{page_idx+1}: header mapping={page_mapping}',
                                  file=sys.stderr)
                        continue

                    if is_col_number_row(row):
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
                        if len(data_rows_buf) >= 3:
                            inferred = infer_mapping_from_data(data_rows_buf)
                            if 'name' in inferred:
                                page_mapping = inferred
                                prev_mapping = page_mapping
                                print(f'[info] p{page_idx+1}: inferred mapping='
                                      f'{page_mapping}', file=sys.stderr)
                            elif prev_mapping:
                                page_mapping = prev_mapping
                        continue

                    if is_summary_row(row, page_mapping):
                        stats['summary_rows_skipped'] += 1
                        continue

                    item = extract_item(row, page_mapping, global_row_idx)
                    if item:
                        all_items.append(item)
                    global_row_idx += 1

                if page_mapping is None and data_rows_buf:
                    if len(data_rows_buf) >= 2:
                        inferred = infer_mapping_from_data(data_rows_buf)
                        if 'name' in inferred:
                            page_mapping = inferred
                            prev_mapping = page_mapping
                    if page_mapping is None and prev_mapping:
                        page_mapping = prev_mapping

                if page_mapping and data_rows_buf:
                    for row in data_rows_buf:
                        if is_summary_row(row, page_mapping):
                            stats['summary_rows_skipped'] += 1
                            continue
                        item = extract_item(row, page_mapping, global_row_idx)
                        if item:
                            all_items.append(item)
                        global_row_idx += 1
                    data_rows_buf.clear()

    meta = extract_metadata(pdf_path)

    # If no totalAmount in metadata, compute from items
    if meta['totalAmount'] is None and all_items:
        total = sum(it['amount'] for it in all_items if it['amount'] is not None)
        if total > 0:
            meta['totalAmount'] = round(total, 2)

    stats['items_total'] = len(all_items)
    total_time = time.time() - t0
    print(f'[info] Extracted {len(all_items)} items from {stats["pages"]} pages '
          f'({stats["pages_processed"]} processed) in {total_time:.1f}s', file=sys.stderr)

    return {'items': all_items, 'metadata': meta, 'stats': stats}


def main():
    if len(sys.argv) < 2:
        print('Usage: python extract_invoice_table.py <path_to_pdf>', file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.isfile(pdf_path):
        print(f'File not found: {pdf_path}', file=sys.stderr)
        sys.exit(1)

    result = extract_invoice_items(pdf_path)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
