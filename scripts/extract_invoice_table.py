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


# ── Cell repair: detect and fix double-text corruption ──
#
# Some supplier PDFs (ITESA radiator catalogue, similar templates) embed an
# ASCII "shadow" glyph layer overlapping the visible Cyrillic glyphs in the
# SAME y-band and font. pdfplumber.extract_tables() concatenates BOTH layers
# (sorted by x) and produces corrupt cell text like
#   "PР0а0диатор стальной EVRA Compact C 33-600-1000 без крепежа"
# pdfplumber.extract_text() and fitz.get_textbox() use word-clustering and
# return the clean text. We detect the corruption signature per cell and
# fall back to fitz.get_textbox() with a validation gate (only accept fitz
# result if it itself looks clean and is not absurdly long).
#
# This is a STRUCTURAL fix (no supplier names, no item words). Validated on
# 50 real PDFs in data/uploads/: 152/184 corrupt cells repaired, 32 kept
# baseline (fitz also garbled), 0 regressions on Ровен/Неватом/Элита/Сшитый/
# PRINTER2/5-ПР drawings/floor numbers.
_CYR_RE = re.compile(r'[Ѐ-ӿ]')
_SHADOW_INTERIOR_RE = re.compile(r'[Ѐ-ӿ][A-Za-z0-9][Ѐ-ӿ]')
_LEAD_NOISE_RE = re.compile(r'^\s*[A-Za-z0-9]{2,}(?=[Ѐ-ӿ])')


def looks_double_text_corrupted(s):
    """Cell text matches the ITESA-class double-text shadow pattern:
    a Cyrillic letter followed by a single ASCII char followed by another
    Cyrillic letter, OR a 2+ ASCII run immediately before a Cyrillic letter."""
    if not s or not _CYR_RE.search(s):
        return False
    return bool(_SHADOW_INTERIOR_RE.search(s) or _LEAD_NOISE_RE.search(s))


def strip_leading_ascii_line(s):
    """Drop a leading ASCII-only line if a cyrillic-containing line follows.
    fitz.get_textbox() often returns the article-shadow row above the name."""
    if not s or '\n' not in s:
        return s
    first, _, rest = s.partition('\n')
    if first.strip() and first.isascii() and first.replace(' ', '').isalnum() and _CYR_RE.search(rest):
        return rest
    return s


def fitz_repair_cell(fitz_page, bbox, baseline):
    """Re-extract a cell via fitz.get_textbox; return repaired text only if it
    itself looks clean and is reasonably sized. Otherwise return baseline so
    we NEVER degrade an originally-acceptable cell."""
    try:
        x0, top, x1, bottom = bbox
        repaired = fitz_page.get_textbox(fitz.Rect(x0, top, x1, bottom)) or ''
    except Exception:
        return baseline
    repaired = strip_leading_ascii_line(repaired)
    if not repaired.strip():
        return baseline
    if looks_double_text_corrupted(repaired):
        return baseline
    if len(repaired) > max(40, len(baseline) * 3):
        return baseline
    return repaired


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


# A refine_price_column candidate must look like a PRICE column by its header.
# "Цена" and "Цена со скидкой" qualify; "Скидка"/"НДС"/"Сумма…" do NOT — they can
# satisfy value×qty≈amount by coincidence and would otherwise hijack `price`.
PRICE_HEADER_KEYS = ('цена', 'стоимость за', 'цена за')


def _header_has_price_key(header_cells, col):
    """True when column `col`'s header text contains a unit-price keyword."""
    if header_cells is None or col is None or col >= len(header_cells):
        return False
    t = clean_cell(header_cells[col]).lower()
    return any(k in t for k in PRICE_HEADER_KEYS)


def refine_price_column(mapping, data_rows, header_cells=None):
    """Choose the unit-price column structurally: the one whose value × Кол-во
    reproduces the line total (Сумма). On discount-bearing invoices the header's
    greedy 'Цена' grabs the BEFORE-discount gross unit; the AFTER-discount net
    unit ('Цена со скидкой') is the column satisfying price×qty == Сумма(net).
    Aligns `price` with the net line total without touching qty/amount, so
    computeUnitPriceWithVat (= amount/qty) is unchanged. No supplier/column
    hardcoding — purely the arithmetic identity. Conservative: only override when
    a different column is clearly more consistent than the current pick.

    F4: when the header row is available, restrict candidates to columns whose
    HEADER names a price ("цена"). A «Скидка»/«НДС»/«Сумма без скидки» column can
    coincidentally satisfy value×qty ≈ amount and would otherwise be promoted to
    `price`, corrupting the unit price. «Цена» and «Цена со скидкой» pass this
    filter, so the РОВЕН gross→net switch is preserved; «Скидка»/«НДС» are blocked.
    """
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
        # Only consider columns whose header denotes a price (when headers known).
        if header_cells is not None and not _header_has_price_key(header_cells, c):
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


# Numeric fields whose carried column index must still hold numbers on a
# continuation page for the previous-page mapping to be reusable.
_CARRY_NUMERIC_FIELDS = ('quantity', 'price', 'amount')


def page_classifiable_data_rows(table, limit=40):
    """Rows of `table` that look like item DATA rows — the subset a carried
    mapping would actually be applied to. Mirrors the noise filters of the main
    extraction loop (drops header / column-number / too-short / all-tiny rows) so
    the compatibility check below judges the mapping against the same rows that
    would be classified, not against headers or blank padding. Structural, no
    label hardcoding."""
    rows = []
    for row in table:
        if not row:
            continue
        if is_header_row(row):
            continue
        if is_col_number_row(row):
            continue
        cells = [clean_cell(c) for c in row]
        non_empty = [c for c in cells if c]
        # A fully blank row carries no layout signal and the main loop never
        # emits an item from it; exclude it so it does not dilute the numeric
        # ratio of the compatibility check below.
        if not non_empty:
            continue
        combined = ' '.join(cells)
        if len(combined) < 3:
            continue
        if all(len(c) <= 2 for c in non_empty):
            continue
        rows.append(row)
        if len(rows) >= limit:
            break
    return rows


def mapping_compatible_with_page(prev_mapping, page_data_rows):
    """Is a mapping established on an EARLIER page safe to carry onto THIS page?

    A header-less continuation page is normally a true continuation (same grid),
    but blindly carrying `prev_mapping` silently mis-maps qty/price/amount when the
    page actually has a different column layout. This guard validates the carry
    structurally — no supplier/column hardcoding:

      1. Width: the page's data rows must be wide enough to address every column
         the mapping references (the carried max index must exist on this page).
      2. Numeric coherence: every NUMERIC column the mapping names
         (quantity/price/amount) must still read as numbers here — at least half
         of the classifiable data rows must yield `parse_number` in that column.
         If a carried numeric column is empty/non-numeric on this page, the layout
         differs and the carry would shift values.

    Returns True  -> safe to carry (e.g. inv47 p2, a genuine continuation).
    Returns False -> layout differs; caller should re-infer per page instead.

    Conservative edges: with no data rows to judge (can't disprove) or a mapping
    that references no numeric columns (nothing numeric to validate), returns True
    so behaviour matches the pre-guard carry; the guard only ever BLOCKS a carry
    when it has positive evidence the layout is incompatible."""
    if not prev_mapping:
        return False
    if not page_data_rows:
        return True

    indices = [i for i in prev_mapping.values() if isinstance(i, int)]
    if not indices:
        return True
    max_idx = max(indices)

    # 1. Width: a majority of data rows must be wide enough to hold max_idx.
    wide_enough = sum(1 for r in page_data_rows if len(r) > max_idx)
    if wide_enough < max(1, (len(page_data_rows) + 1) // 2):
        return False

    # 2. Numeric coherence: each carried numeric column must read as numbers.
    numeric_fields = [f for f in _CARRY_NUMERIC_FIELDS
                      if isinstance(prev_mapping.get(f), int)]
    if not numeric_fields:
        return True
    threshold = max(1, (len(page_data_rows) + 1) // 2)
    for field in numeric_fields:
        col = prev_mapping[field]
        numeric = sum(1 for r in page_data_rows
                      if col < len(r) and parse_number(clean_cell(r[col])) is not None)
        if numeric < threshold:
            return False
    return True


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
    """Single-row STRUCTURAL test: does this row LOOK like a group/section subtotal?

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

    NOTE: a РОВЕН section subtotal and a lump-sum service line («Доставка»,
    «Монтаж» — name + amount, empty price, qty=1, no unit, no row number) are
    INDISTINGUISHABLE at the single-row level. The pipeline therefore does NOT
    drop on this predicate alone; it confirms via confirm_group_subheader_row(),
    which checks the section-subtotal identity against the following member rows.
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


# A section subtotal must reproduce the sum of its member rows to within this
# fraction. Kept loose enough to absorb source rounding and the occasional member
# pdfplumber drops mid-block, tight enough that an unrelated следующая позиция
# (a lump-sum service line's neighbour) does not accidentally match.
GROUP_SUBTOTAL_TOL_FRAC = 0.02


def _row_is_classifiable(row):
    """Mirror of the pipeline's per-row gate: rows the extractor would consider as
    data (not headers / column-number strips / 2-char noise). Used by the member
    scan so the subtotal identity is measured over the same rows the pipeline maps."""
    if not row:
        return False
    cells = [clean_cell(c) for c in row]
    if len(' '.join(cells)) < 3:
        return False
    non_empty = [c for c in cells if c]
    if non_empty and all(len(c) <= 2 for c in non_empty):
        return False
    if is_header_row(row) or is_col_number_row(row):
        return False
    return True


def confirm_group_subheader_row(table, row_index, mapping):
    """CONTEXT-AWARE confirmation that the flagged row is a section subtotal (drop)
    rather than a legitimate lump-sum line (keep). A РОВЕН subtotal and a service
    line look identical in isolation; only the surrounding rows disambiguate them.

    Rule — drop the row ONLY when its `amount` is corroborated by the member rows
    that follow it (the rows belonging to the section), so we never eat a real
    «Доставка»/«Монтаж»:
      * Walk the following classifiable rows until the next group-shaped row or a
        summary row (the section boundary), summing their `amount`s.
      * cnt == 0  → no members at all (e.g. trailing service line, or a service
        block where the next row is itself group-shaped) → KEEP (not a subtotal).
      * clean stop (hit a group/summary boundary) → DROP iff Σmembers ≈ amount;
        otherwise the "members" are unrelated siblings → KEEP.
      * truncated by table/page end with cnt ≥ 1 → the member run is incomplete
        (РОВЕН splits a section across a page boundary), so the sum cannot be
        verified; fall back to the legacy behaviour and DROP. A service line is
        almost never the 2nd-to-last row of a table, so this is safe in practice.

    No supplier/label hardcoding — purely the subtotal = Σ(parts) arithmetic.
    """
    row = table[row_index]
    if not is_group_subheader_row(row, mapping):
        return False
    amount_col = mapping.get('amount')
    amount = parse_number(clean_cell(row[amount_col])) if (
        amount_col is not None and amount_col < len(row)) else None
    if amount is None:
        return False

    member_sum = 0.0
    member_count = 0
    ended_cleanly = False
    for k in range(row_index + 1, len(table)):
        nxt = table[k]
        if not _row_is_classifiable(nxt):
            continue
        if is_summary_row(nxt, mapping) or is_group_subheader_row(nxt, mapping):
            ended_cleanly = True  # reached the section boundary
            break
        a = parse_number(clean_cell(nxt[amount_col])) if (
            amount_col is not None and amount_col < len(nxt)) else None
        if a is not None:
            member_sum += a
            member_count += 1

    if member_count == 0:
        return False  # a leaf line (service / standalone), not a section subtotal
    if not ended_cleanly:
        return True   # incomplete member run (section spans page break) → legacy drop
    return abs(member_sum - amount) <= max(0.05, abs(amount) * GROUP_SUBTOTAL_TOL_FRAC)


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
        # Header fields (number/date/supplier) live near the top, so the first few
        # pages are enough and keep us away from late-page noise. The NET total
        # sentence ("Всего наименований N, на сумму X"), however, sits AFTER the
        # item table and on a long discount invoice can land on page 4+ — so it is
        # searched over the WHOLE document (full_text below), not just these pages.
        text = ''
        for pi in range(min(3, len(doc))):
            text += doc[pi].get_text() + '\n'
        full_text = ''
        if len(doc) <= 3:
            full_text = text
        else:
            for pi in range(len(doc)):
                full_text += doc[pi].get_text() + '\n'

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
    #
    # F3: the NET sentence follows the item table and may land on page 4+ on a long
    # discount invoice. Search the WHOLE document for it (full_doc_norm), not just
    # the first-3-pages snippet — otherwise we silently fall back to the gross total.
    # The regex is highly specific ("всего наименований N … на сумму X.YY"), so a
    # wider search window does not introduce false positives. Mirrors the TS path,
    # whose extractMetadata already runs this match over the full text.
    full_doc_norm = full_text.replace('\xa0', ' ')
    net_match = re.search(
        r'всего\s+наименований\s+\d+\s*,?\s*на\s+сумму\s+([0-9][0-9\s]*[.,]\d{2})',
        full_doc_norm, re.I)
    if net_match:
        meta['totalAmount'] = parse_number(net_match.group(1))
    if meta['totalAmount'] is None:
        # Fallback gross "Итого" stays scoped to the early text: it is a generic
        # keyword grab that could match late-page boilerplate if widened.
        total_match = re.search(
            r'(?:итого|всего|total|итого к оплате)\s*[:\s]*([0-9\s]+[.,]\d{2})',
            normalized[:10000], re.I)
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

    # Open the PDF via fitz too — used by fitz_repair_cell() to repair cells
    # whose pdfplumber.extract_tables() output matches the double-text
    # corruption signature (see looks_double_text_corrupted). Per-cell fallback
    # only; baseline kept whenever fitz also returns garbage.
    fitz_doc = None
    try:
        fitz_doc = fitz.open(str(pdf_path))
    except Exception as _exc:
        print(f'[warn] fitz unavailable for cell repair: {_exc}', file=sys.stderr)

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

            # Repair double-text-corrupted cells via fitz. Detector matches the
            # ITESA-class signature (Cyr+ASCII+Cyr inside a word, or leading
            # ASCII shadow before a Cyrillic word). For each flagged cell we
            # re-extract via fitz.get_textbox at the same bbox; fitz_repair_cell
            # validates the result and keeps the baseline if fitz also fails.
            # find_tables() returns the same logical tables in the same order as
            # extract_tables() (both go through pdfplumber's TableFinder), so the
            # ti/ri/ci alignment is reliable.
            if fitz_doc is not None and any(
                looks_double_text_corrupted(c)
                for _tbl in tables for _row in (_tbl or []) for c in (_row or []) if c
            ):
                try:
                    finder_tables = list(page.find_tables() or [])
                except Exception as _exc:
                    finder_tables = []
                    print(f'[warn] p{page_idx+1}: find_tables failed: {_exc}', file=sys.stderr)
                if finder_tables and len(finder_tables) == len(tables):
                    try:
                        fpage = fitz_doc[page_idx]
                    except Exception:
                        fpage = None
                    if fpage is not None:
                        repaired_count = 0
                        for ti, tbl in enumerate(finder_tables):
                            try:
                                rows = list(tbl.rows)
                            except Exception:
                                continue
                            for ri, row in enumerate(rows):
                                if ri >= len(tables[ti]):
                                    break
                                try:
                                    cells_bboxes = list(row.cells)
                                except Exception:
                                    continue
                                for ci, cell_bbox in enumerate(cells_bboxes):
                                    if cell_bbox is None:
                                        continue
                                    if ci >= len(tables[ti][ri]):
                                        continue
                                    baseline = tables[ti][ri][ci] or ''
                                    if not looks_double_text_corrupted(baseline):
                                        continue
                                    repaired = fitz_repair_cell(fpage, cell_bbox, baseline)
                                    if repaired != baseline:
                                        tables[ti][ri][ci] = repaired
                                        repaired_count += 1
                        if repaired_count and page_idx < 5:
                            print(f'[info] p{page_idx+1}: repaired {repaired_count} double-text cells',
                                  file=sys.stderr)

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
                # F5: data rows of THIS table, used to decide whether a mapping
                # carried from an earlier page is structurally compatible here
                # (computed once; the carry decision below fires on the first
                # header-less row, before the loop has seen the rest).
                page_data_rows = page_classifiable_data_rows(table)

                for row_index, row in enumerate(table):
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
                        # F4: pass the header row so refine_price_column restricts
                        # price candidates to columns whose HEADER names a price.
                        # Without it header_cells defaults to None and the filter is
                        # a no-op (a «Скидка»/«НДС» column could hijack `price`).
                        page_mapping = refine_price_column(page_mapping, data_sample,
                                                           header_cells=row)
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
                        # columns (inv47 p2 → qty/price/amount shift). Carry only
                        # when the prior grid is STRUCTURALLY COMPATIBLE with this
                        # page (F5: same width + carried numeric columns still hold
                        # numbers here) — otherwise the page has a different layout
                        # and a blind carry would silently mis-map qty/price/amount,
                        # so fall back to per-page inference instead.
                        if prev_mapping and mapping_compatible_with_page(
                                prev_mapping, page_data_rows):
                            page_mapping = prev_mapping
                            if page_idx < 5:
                                print(f'[info] p{page_idx+1}: carry prev mapping='
                                      f'{page_mapping}', file=sys.stderr)
                        else:
                            if prev_mapping and page_idx < 5:
                                print(f'[info] p{page_idx+1}: prev mapping '
                                      f'incompatible with page → re-infer',
                                      file=sys.stderr)
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

                    # Drop only CONFIRMED section subtotals (amount == Σ following
                    # members). A lump-sum service line looks identical to a РОВЕН
                    # subtotal in isolation, so confirmation against the member rows
                    # is what keeps «Доставка»/«Монтаж» from being eaten.
                    if confirm_group_subheader_row(table, row_index, page_mapping):
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
                    # F5: same compatibility guard before carrying onto the
                    # buffered continuation rows — only reuse the earlier grid when
                    # it structurally matches these rows (width + numeric columns),
                    # otherwise leave page_mapping None so they are NOT emitted with
                    # a mismatched grid rather than silently mis-mapped.
                    if page_mapping is None and prev_mapping \
                            and mapping_compatible_with_page(prev_mapping, data_rows_buf):
                        page_mapping = prev_mapping

                if page_mapping and data_rows_buf:
                    for buf_index, row in enumerate(data_rows_buf):
                        if is_summary_row(row, page_mapping):
                            stats['summary_rows_skipped'] += 1
                            continue
                        # Same confirmed-subtotal gate as the main loop, scoped to
                        # the buffered continuation rows as the member context.
                        if confirm_group_subheader_row(data_rows_buf, buf_index, page_mapping):
                            stats['group_rows_skipped'] = stats.get('group_rows_skipped', 0) + 1
                            global_row_idx += 1
                            continue
                        item = extract_item(row, page_mapping, global_row_idx)
                        if item:
                            all_items.append(item)
                        global_row_idx += 1
                    data_rows_buf.clear()

    if fitz_doc is not None:
        try:
            fitz_doc.close()
        except Exception:
            pass

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
