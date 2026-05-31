"""
Извлечение таблицы счёта/заказа из PDF через pdfplumber + PyMuPDF.

PyMuPDF (fitz) — быстрое сканирование страниц
pdfplumber — точное извлечение таблиц

Вход: путь к PDF
Выход: JSON на stdout в формате {items: [...], metadata: {...}, stats: {...}}

Запуск: python -X utf8 scripts/extract_invoice_table.py path/to/invoice.pdf

TS/Python sync (см. память «правило в 2 реализациях правится синхронно»):
  Это ПРОД-путь (pdfplumber); backend/src/services/pdfParser.ts — TS fallback
  (pdf-parse), активен только если pdfplumber упал.
  * Net-total ("Всего наименований N, на сумму X") — ЗЕРКАЛИРОВАН в обоих
    extractMetadata и extractMetadataFromRows в pdfParser.ts.
  * Групп-фильтр (is_group_subheader_row), перенос грида между страницами
    (multi-page carry) и refine_price_column — артефакты pdfplumber cell-grid:
    в TS-пути pdf-parse строит плоский текст, эти конкретные баги там не
    воспроизводятся, поэтому НЕ дублируются слепо (a structural rule, not a
    label list, так что прод-поведение совпадает).
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
    without_discount = re.search(r'без\s+скидк', text) is not None
    if without_discount:
        score -= 20
    elif re.search(r'скидк', text):
        score += 30
    return score


def _classify_column_vat(text):
    """Classify the VAT-state a column HEADER implies for the values in that column:
      True  -> values already INCLUDE VAT (gross): 'с НДС', 'с учётом НДС', 'включая НДС'
      False -> values EXCLUDE VAT (net):           'без НДС'
      None  -> neutral/unknown: plain 'Сумма'/'Цена', or a bare 'НДС' (tax-amount) column.
    Feeds Feature #1 (НДС ровно один раз): the router reconciles this against the supplier
    prices_include_vat flag so VAT is applied exactly once.
    MIRROR of classifyColumnVat in backend/src/services/pdfParser.ts — same with/without-VAT
    regexes as _score_amount_column, so column selection and vat-classification stay consistent."""
    if not text:
        return None
    t = text.lower()
    with_vat = re.search(r'с\s+ндс|с\s+учетом\s+ндс|с\s+учётом\s+ндс|включая\s+ндс', t) is not None
    without_vat = re.search(r'без\s+ндс', t) is not None
    if without_vat:
        return False
    if with_vat:
        return True
    return None


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


def _price_consistency(col, data_rows, mapping):
    """Fraction of sample rows where col_value * quantity ≈ amount (the per-unit
    price identity). Higher = stronger evidence `col` is the line's unit-price."""
    qty_col = mapping.get('quantity')
    amt_col = mapping.get('amount')
    if qty_col is None or amt_col is None or col is None:
        return 0.0
    ok = 0
    seen = 0
    for row in data_rows:
        if col >= len(row) or qty_col >= len(row) or amt_col >= len(row):
            continue
        p = parse_number(clean_cell(row[col]))
        q = parse_number(clean_cell(row[qty_col]))
        a = parse_number(clean_cell(row[amt_col]))
        if p is None or q is None or a is None or q <= 0 or a <= 0:
            continue
        seen += 1
        # tolerance scales with amount; covers source rounding (≤0.05₽) and ±0.5%
        if abs(p * q - a) <= max(0.05, abs(a) * 0.005):
            ok += 1
    return ok / seen if seen else 0.0


def refine_price_column(mapping, data_rows):
    """Choose the unit-price column structurally: the one whose value × Кол-во
    reproduces the line total (Сумма). On discount-bearing invoices the header's
    greedy 'Цена' grabs the BEFORE-discount gross unit; the AFTER-discount net
    unit ('Цена со скидкой') is the column satisfying price×qty == Сумма(net).
    Aligns `price` with the net line total without touching qty/amount, so
    computeUnitPriceWithVat (= amount/qty) is unchanged. No supplier/column
    hardcoding — purely the arithmetic identity. Conservative: only override when
    a different column is clearly more consistent than the current pick."""
    if not data_rows:
        return mapping
    reserved = {mapping.get('num'), mapping.get('name'), mapping.get('unit'),
                mapping.get('quantity'), mapping.get('amount')}
    num_cols = max((len(r) for r in data_rows), default=0)
    current = mapping.get('price')
    current_score = _price_consistency(current, data_rows, mapping)
    best_col, best_score = current, current_score
    for c in range(num_cols):
        if c in reserved or c == current:
            continue
        # must actually be a numeric column on the sample
        numeric = sum(1 for r in data_rows
                      if c < len(r) and parse_number(clean_cell(r[c])) is not None)
        if numeric < max(2, len(data_rows) // 2):
            continue
        score = _price_consistency(c, data_rows, mapping)
        if score > best_score + 1e-9:
            best_col, best_score = c, score
    # Require strong agreement and a real improvement before switching columns.
    if best_col is not None and best_col != current and best_score >= 0.8 \
            and best_score > current_score + 0.1:
        new_mapping = dict(mapping)
        new_mapping['price'] = best_col
        return new_mapping
    return mapping


# ── Phase 3: Row classification ──

def is_header_row(cells):
    text = ' '.join(clean_cell(c).lower() for c in cells)
    name_kws = ['наименование', 'название', 'описание', 'номенклатура', 'товар']
    qty_kws = ['количест', 'кол-во', 'кол.', 'к-во']
    price_kws = ['цена', 'стоимость за']
    amount_kws = ['сумма', 'стоимость', 'итого', 'всего', 'total']
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


def is_multicell_item_header(cells):
    """True when a row is a *real grid* header (name keyword in one cell AND a
    quantity/price/amount keyword in a DIFFERENT cell). Distinguishes a genuine
    column-header row from a single 'mega-cell' blob (where pdfplumber dumps the
    whole page text into one cell — that blob trips is_header_row but is not a
    usable grid). Used to keep an item table that carries a bank-block blob from
    being misclassified as a requisites table. Structural, no label hardcoding."""
    name_kws = ['наименование', 'название', 'описание', 'номенклатура', 'товар']
    field_kws = ['количест', 'кол-во', 'кол.', 'к-во', 'цена', 'сумма', 'ед.', 'изм']
    name_cols = set()
    field_cols = set()
    for ci, c in enumerate(cells):
        t = clean_cell(c).lower()
        if not t:
            continue
        # A blob cell holds the whole page — far too long to be a header label.
        if len(t) > 60:
            continue
        if any(kw in t for kw in name_kws):
            name_cols.add(ci)
        if any(kw in t for kw in field_kws):
            field_cols.add(ci)
    return bool(name_cols) and bool(field_cols - name_cols)


def table_has_item_header(table):
    """Does any row in the table look like a real multi-cell grid header?"""
    return any(row and is_multicell_item_header(row) for row in table)


def is_requisites_table(table):
    # A bank/requisites block hits the keyword regex, but so does an item table
    # that carries the receiver block inside a pdfplumber 'mega-cell' (the whole
    # page text in cell 0). Only drop the table when it has NO real grid header —
    # otherwise we would lose every position on that page (root cause of inv47
    # page-1 loss). Structural guard, not label-based.
    if table_has_item_header(table):
        return False
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


def is_group_subheader_row(cells, mapping):
    """True when a row is a group/section SUBTOTAL line, not a real position.

    Structural PRIMARY rule (no label hardcoding): a real position MUST carry a
    unit-price; a group subheader fills only the right-hand sum cluster (line
    totals) and leaves the per-unit price cell empty. Some suppliers (РОВЕН form
    B) emit per-section subtotals — `ПЕ2`, `ВЕ`, `П1`, `В1..В6`, `Пенофол` — that
    otherwise leak in as items AND, because they are sparse on the left, skew the
    data-driven column inference. They must be dropped BEFORE inference/extraction.

    Discriminators (need price column known; mapping must be the corrected grid):
      PRIMARY:   unit-price cell empty while a line-total (amount) cell is filled.
      STRONG:    no unit token (Ед.) present.
      SECONDARY: no leading row number.
    Require the unit-price to be ABSENT (primary) plus at least one corroborating
    signal, so a legitimate priced position is never dropped on величину Кол-во.
    """
    name_col = mapping.get('name')
    price_col = mapping.get('price')
    amount_col = mapping.get('amount')
    if name_col is None or price_col is None or amount_col is None:
        return False

    def cell(field):
        col = mapping.get(field)
        if col is not None and col < len(cells):
            return clean_cell(cells[col])
        return ''

    name = cell('name')
    if not name:
        return False

    has_unit_price = parse_number(cell('price')) is not None
    has_amount = parse_number(cell('amount')) is not None
    if has_unit_price or not has_amount:
        return False  # PRIMARY: a position has a unit-price; a group has a total but none

    # Corroborating signals (group rows also lack a unit token and a row number)
    no_unit = parse_number(cell('quantity')) is not None and not cell('unit')
    no_num = not ROW_NUM_RE.match(cell('num') or '')
    return no_unit or no_num


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

    # Total amount — prefer the NET payable, not the first "Итого".
    # Many discount invoices print "Итого:" as a ROW of three figures
    # (Сумма-без-скидки=gross, Скидка, Сумма=net); the bare regex below grabs the
    # FIRST (gross). The "Всего наименований N, на сумму X руб." sentence states
    # the net payable explicitly and unambiguously, so try it first. No hardcoded
    # sums — purely the document's own summary phrasing.
    full_norm = normalized
    net_match = re.search(
        r'всего\s+наименований\s+\d+\s*,?\s*на\s+сумму\s+([0-9][0-9\s]*[.,]\d{2})',
        full_norm, re.I)
    if net_match:
        meta['totalAmount'] = parse_number(net_match.group(1))
    if meta['totalAmount'] is None:
        total_match = re.search(
            r'(?:итого|всего|total|итого к оплате)\s*[:\s]*([0-9\s]+[.,]\d{2})',
            full_norm[:10000], re.I)
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
    # Feature #1: VAT-state of the chosen amount/price column, captured from the FIRST
    # header-based mapping (document-level signal). None = neutral/unknown → no reconciliation.
    amount_vat_included = None
    price_vat_included = None
    vat_state_captured = False

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

                    # Only treat a row as the column header when it is a real
                    # multi-cell grid header. A pdfplumber 'mega-cell' blob (whole
                    # page text in one cell) trips is_header_row but yields a bogus
                    # 1-field mapping; accepting it on a header-less continuation
                    # page (inv47 p2) drops the carried grid and shifts columns.
                    if is_header_row(row) and is_multicell_item_header(row):
                        header_mapping = detect_column_mapping(row)
                        stats['header_detections'] += 1
                        # Exclude group-subtotal rows from the inference sample:
                        # their sparse left side (no unit-price) skews data-driven
                        # column picking. They are dropped via the header grid here.
                        data_sample = [r for r in table
                                       if r and not is_header_row(r)
                                       and not is_col_number_row(r)][:20]
                        inferred = infer_mapping_from_data(data_sample)
                        page_mapping = merge_mappings(header_mapping, inferred)
                        page_mapping = refine_price_column(page_mapping, data_sample)
                        prev_mapping = page_mapping
                        if not vat_state_captured:
                            header_lc = [clean_cell(c).lower() for c in row]
                            a_idx = page_mapping.get('amount')
                            p_idx = page_mapping.get('price')
                            if a_idx is not None and a_idx < len(header_lc):
                                amount_vat_included = _classify_column_vat(header_lc[a_idx])
                            if p_idx is not None and p_idx < len(header_lc):
                                price_vat_included = _classify_column_vat(header_lc[p_idx])
                            vat_state_captured = True
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
                        # A header-less table on a multi-page document is a
                        # continuation: reuse the grid already established by the
                        # header on an earlier page. Re-inferring from this page's
                        # data alone re-derives the wrong right-to-left numeric
                        # columns (inv47 p2 → qty/price/amount shift). Only fall
                        # back to inference when there is no prior grid at all.
                        if prev_mapping:
                            page_mapping = prev_mapping
                            if page_idx < 5:
                                print(f'[info] p{page_idx+1}: carry prev mapping='
                                      f'{page_mapping}', file=sys.stderr)
                        else:
                            data_rows_buf.append(row)
                            if len(data_rows_buf) >= 3:
                                inferred = infer_mapping_from_data(data_rows_buf)
                                if 'name' in inferred:
                                    page_mapping = inferred
                                    prev_mapping = page_mapping
                                    print(f'[info] p{page_idx+1}: inferred mapping='
                                          f'{page_mapping}', file=sys.stderr)
                            continue
                        # fall through with carried mapping to classify THIS row

                    if is_summary_row(row, page_mapping):
                        stats['summary_rows_skipped'] += 1
                        continue

                    if is_group_subheader_row(row, page_mapping):
                        stats['group_rows_skipped'] = stats.get('group_rows_skipped', 0) + 1
                        global_row_idx += 1
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
                        if is_group_subheader_row(row, page_mapping):
                            stats['group_rows_skipped'] = stats.get('group_rows_skipped', 0) + 1
                            global_row_idx += 1
                            continue
                        item = extract_item(row, page_mapping, global_row_idx)
                        if item:
                            all_items.append(item)
                        global_row_idx += 1
                    data_rows_buf.clear()

    meta = extract_metadata(pdf_path)

    # Feature #1: surface the chosen amount/price column VAT-state for the router to reconcile
    # against the supplier prices_include_vat flag (НДС ровно один раз).
    meta['amountVatIncluded'] = amount_vat_included
    meta['priceVatIncluded'] = price_vat_included

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
