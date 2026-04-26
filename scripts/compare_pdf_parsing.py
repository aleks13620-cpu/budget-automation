"""
Сравнение качества распознавания PDF-счётов:
pdfplumber (локальный) vs GigaChat (через API проекта)

Запуск: python scripts/compare_pdf_parsing.py
"""

import os
import json
import urllib.request
import urllib.error
import re
import signal
from contextlib import contextmanager

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'uploads')
API_BASE = 'http://localhost:3001/api'

# pdfplumber не используем для файлов тяжелее этого предела (сканы)
SCAN_SIZE_THRESHOLD_MB = 5

PDF_FILES = sorted(f for f in os.listdir(UPLOADS_DIR) if f.lower().endswith('.pdf'))


# ─────────────────────────────────────────────
# pdfplumber extraction (только для текстовых PDF)
# ─────────────────────────────────────────────

def extract_with_pdfplumber(filepath: str) -> dict:
    import pdfplumber
    result = {
        'text_chars': 0,
        'tables': [],
        'table_rows_total': 0,
        'probable_item_lines': 0,
        'text_preview': '',
        'errors': [],
    }
    try:
        with pdfplumber.open(filepath) as pdf:
            full_text = ''
            for page in pdf.pages:
                text = page.extract_text() or ''
                full_text += text + '\n'
                tables = page.extract_tables() or []
                for table in tables:
                    if table:
                        result['tables'].append(table)
                        result['table_rows_total'] += len(table)

            result['text_chars'] = len(full_text.strip())
            result['text_preview'] = full_text.strip()[:800]

            lines = [l.strip() for l in full_text.splitlines() if l.strip()]
            item_lines = [l for l in lines if re.match(r'^\d+[\.\s]', l)]
            result['probable_item_lines'] = len(item_lines)

    except Exception as e:
        result['errors'].append(str(e))
    return result


# ─────────────────────────────────────────────
# GigaChat через API проекта
# ─────────────────────────────────────────────

def call_gigachat_via_api(filename: str) -> dict:
    """POST /api/gigachat/parse-invoice-file"""
    url = f'{API_BASE}/gigachat/parse-invoice-file'
    payload = json.dumps({'filename': filename}).encode('utf-8')
    req = urllib.request.Request(
        url, data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return {'ok': True, 'data': json.loads(resp.read().decode('utf-8'))}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        return {'ok': False, 'error': f'HTTP {e.code}: {body[:300]}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def check_api_available() -> bool:
    try:
        with urllib.request.urlopen(f'{API_BASE}/projects', timeout=3):
            return True
    except:
        return False


# ─────────────────────────────────────────────
# Форматирование
# ─────────────────────────────────────────────

def format_table(table: list, max_rows: int = 15) -> str:
    lines = []
    for row in table[:max_rows]:
        cells = [str(c or '').replace('\n', ' ').strip()[:35] for c in row]
        lines.append(' | '.join(cells))
    if len(table) > max_rows:
        lines.append(f'  ... ещё {len(table) - max_rows} строк')
    return '\n'.join(lines)


# ─────────────────────────────────────────────
# Главный цикл
# ─────────────────────────────────────────────

def main():
    print(f'PDF файлов найдено: {len(PDF_FILES)}')
    print()

    api_available = check_api_available()
    if not api_available:
        print('[!] Backend API (localhost:3001) недоступен — GigaChat пропущен')
        print('    Запустите: cd backend && npm run dev')
        print()

    for filename in PDF_FILES:
        filepath = os.path.join(UPLOADS_DIR, filename)
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        is_scan = size_mb > SCAN_SIZE_THRESHOLD_MB

        print(f'\n{"=" * 70}')
        print(f'ФАЙЛ: {filename}')
        print(f'Размер: {size_mb:.1f} МБ  |  Тип: {"скан (>5МБ)" if is_scan else "текстовый PDF"}')
        print('=' * 70)

        # ── pdfplumber ──────────────────────────────────────────────────────
        print('\n[pdfplumber]')
        if is_scan:
            print(f'  Пропущен — скан ({size_mb:.0f} МБ), pdfplumber зависает на растровых страницах')
            pl = None
        else:
            pl = extract_with_pdfplumber(filepath)
            if pl['errors']:
                print(f'  Ошибки: {pl["errors"]}')
            else:
                print(f'  Символов текста: {pl["text_chars"]}')
                print(f'  Таблиц: {len(pl["tables"])}, строк в таблицах: {pl["table_rows_total"]}')
                print(f'  Строк-позиций (начинаются с цифры): {pl["probable_item_lines"]}')

                if pl['tables']:
                    print(f'\n  Первая таблица ({len(pl["tables"][0])} строк):')
                    for line in format_table(pl['tables'][0]).splitlines():
                        print(f'  {line}')
                elif pl['text_preview']:
                    print(f'\n  Текст (первые 400 символов):')
                    print(pl['text_preview'][:400])

        # ── GigaChat ────────────────────────────────────────────────────────
        if api_available:
            print(f'\n[GigaChat]')
            gc = call_gigachat_via_api(filename)
            if gc['ok']:
                data = gc['data']
                items = data.get('items', [])
                meta = data.get('metadata', {})
                quality = data.get('parseQuality', {})
                doc_type = data.get('documentType', '?')
                print(f'  Тип: {doc_type}  |  №{meta.get("documentNumber")}  от {meta.get("documentDate")}')
                print(f'  Поставщик: {meta.get("supplierName")}  ИНН: {meta.get("supplierINN")}')
                print(f'  Покупатель: {meta.get("buyerName")}')
                print(f'  Позиций: {len(items)}  |  Итог с НДС: {meta.get("totalWithVat")}')
                if quality.get('warnings'):
                    for w in quality['warnings']:
                        print(f'  ⚠ {w}')
                if items:
                    print(f'\n  Первые 5 позиций:')
                    for it in items[:5]:
                        n = str(it.get("row_index", 0) + 1)
                        print(f'    #{n}: {str(it.get("name",""))[:60]}')
                        print(f'       арт={it.get("article")}  кол={it.get("quantity")}  цена={it.get("price")}  сумма={it.get("amount")}')
            else:
                print(f'  Ошибка: {gc["error"]}')

        # ── Сравнение ───────────────────────────────────────────────────────
        if api_available:
            gc2_result = gc if api_available else None
            if gc2_result and gc2_result['ok'] and pl is not None and not pl.get('errors'):
                gc_items = len(gc2_result['data'].get('items', []))
                pl_rows = pl['table_rows_total']
                pl_items = pl['probable_item_lines']
                print(f'\n  ── ВЫВОД ──')
                print(f'    pdfplumber: таблиц={len(pl["tables"])}, строк={pl_rows}, позиций~={pl_items}')
                print(f'    GigaChat:   позиций={gc_items}')
                if pl_rows == 0 and gc_items > 0:
                    print(f'    → GigaChat ЛУЧШЕ: pdfplumber не нашёл таблицы')
                elif gc_items == 0 and pl_items > 0:
                    print(f'    → pdfplumber ЛУЧШЕ: GigaChat не извлёк позиции')
                elif gc_items >= pl_items:
                    print(f'    → GigaChat извлёк больше/столько же позиций')
                else:
                    print(f'    → Расхождение — нужна ручная проверка')
            elif is_scan and api_available and gc2_result and gc2_result['ok']:
                gc_items = len(gc2_result['data'].get('items', []))
                print(f'\n  ── ВЫВОД ──')
                print(f'    pdfplumber: N/A (скан)')
                print(f'    GigaChat:   позиций={gc_items}')
                print(f'    → Только GigaChat применим для скан-PDF')

    print(f'\n{"=" * 70}')
    print('Готово.')


if __name__ == '__main__':
    main()
