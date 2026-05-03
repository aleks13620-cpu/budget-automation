"""
Phase OCR-1: Gemini Flash OCR benchmark via OpenRouter.

For each benchmark-ready source invoice (PDF or Excel):
  - Render pages as images via PyMuPDF (200 DPI)
  - Read Excel sheets as tab-delimited text
  - Send to google/gemini-2.5-flash via OpenRouter
  - Parse structured JSON table of invoice items
  - Save results to scripts/ocr-benchmark/results/gemini_results.json

Usage:
    set OPENROUTER_API_KEY=sk-or-v1-...
    python scripts/ocr-benchmark/02_benchmark_gemini.py

    # Or pass key inline:
    OPENROUTER_API_KEY=sk-or-... python scripts/ocr-benchmark/02_benchmark_gemini.py
"""

import base64
import io
import json
import os
import sys
import time
from difflib import SequenceMatcher

# Force UTF-8 output on Windows to avoid cp1251 encode errors
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

try:
    import fitz  # PyMuPDF
except ImportError:
    print("ERROR: PyMuPDF not installed. Run: pip install pymupdf")
    sys.exit(1)

try:
    from openai import OpenAI
except ImportError:
    print("ERROR: openai not installed. Run: pip install openai")
    sys.exit(1)

try:
    import openpyxl
except ImportError:
    openpyxl = None

try:
    import xlrd
except ImportError:
    xlrd = None

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "google/gemini-2.5-flash"
DPI = 200
MAX_PAGES = 4          # process first N pages per PDF
MAX_EXCEL_ROWS = 250
MAX_EXCEL_COLS = 40
RETRY_ATTEMPTS = 3
RETRY_DELAY = 5        # seconds between retries on rate limit
SUPPORTED_EXTS = {".pdf", ".xlsx", ".xls"}

PROMPT = """Это страница счёта поставщика строительных материалов (русский язык).

Найди таблицу с товарами/работами/услугами и извлеки ВСЕ строки.
Верни ТОЛЬКО JSON массив — без пояснений, без markdown, без ```json:

[
  {
    "name": "полное наименование позиции",
    "article": "артикул или null",
    "unit": "ед. изм. или null",
    "quantity": число или null,
    "price": цена за единицу (число) или null,
    "amount": сумма по строке (число) или null
  }
]

Правила:
- quantity, price, amount — только числа, без пробелов и единиц измерения
- Не включай строки-итоги (Итого, Всего, НДС, Итого к оплате)
- Не включай заголовки таблицы
- Если на странице нет таблицы товаров — верни []
"""

EXCEL_PROMPT = PROMPT.replace(
    "Это страница счёта",
    "Это текстовое представление счёта",
)


def render_page_as_jpeg(page: fitz.Page, dpi: int = DPI) -> bytes:
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
    return pix.tobytes("jpeg")


def parse_gemini_response(text: str) -> list:
    """Parse JSON from Gemini response, stripping markdown code fences if present."""
    text = text.strip()
    # Strip ```json ... ``` or ``` ... ```
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first and last fence lines
        inner = []
        in_block = False
        for line in lines:
            if line.startswith("```") and not in_block:
                in_block = True
                continue
            elif line.startswith("```") and in_block:
                break
            elif in_block:
                inner.append(line)
        text = "\n".join(inner).strip()

    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "items" in data:
            return data["items"]
        return []
    except json.JSONDecodeError as e:
        print(f"    JSON parse error: {e} | raw: {text[:200]}")
        return []


def load_benchmark_invoices(benchmark_dir: str) -> list[dict]:
    """Load canonical benchmark source_invoice values from train/holdout JSONs."""
    invoices = []
    seen = set()
    for subset in ("train", "holdout"):
        subset_dir = os.path.join(benchmark_dir, subset)
        if not os.path.isdir(subset_dir):
            continue
        for filename in sorted(os.listdir(subset_dir)):
            if not filename.endswith(".json"):
                continue
            json_path = os.path.join(subset_dir, filename)
            with open(json_path, encoding="utf-8") as f:
                data = json.load(f)
            source_invoice = data.get("source_invoice", "").strip()
            if not source_invoice or source_invoice in seen:
                continue
            seen.add(source_invoice)
            invoices.append({
                "source_invoice": source_invoice,
                "benchmark_set": subset,
                "benchmark_json": json_path,
                "candidate_for_ocr": True,
            })
    return invoices


def resolve_source_invoice(source_invoice: str, source_dirs: list[str]) -> tuple[str, str]:
    """Find source_invoice in benchmark source directories."""
    for directory in source_dirs:
        candidate = os.path.join(directory, source_invoice)
        if os.path.exists(candidate):
            return candidate, "exact"

    best_path = None
    best_sim = 0
    src_lower = source_invoice.lower()
    for directory in source_dirs:
        if not os.path.isdir(directory):
            continue
        for filename in os.listdir(directory):
            ext = os.path.splitext(filename)[1].lower()
            if ext not in SUPPORTED_EXTS:
                continue
            sim = SequenceMatcher(None, src_lower, filename.lower()).ratio()
            if sim > best_sim:
                best_sim = sim
                best_path = os.path.join(directory, filename)

    if best_path and best_sim >= 0.85:
        return best_path, f"fuzzy:{best_sim:.3f}"

    raise FileNotFoundError(source_invoice)


def cell_to_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).replace("\r", " ").replace("\n", " ").strip()


def read_excel_as_text(path: str) -> tuple[str, int]:
    ext = os.path.splitext(path)[1].lower()
    parts = []
    sheets_processed = 0

    if ext == ".xlsx":
        if openpyxl is None:
            raise RuntimeError("openpyxl not installed. Run: pip install openpyxl")
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        try:
            for ws in wb.worksheets:
                sheets_processed += 1
                parts.append(f"=== Sheet: {ws.title} ===")
                rows_added = 0
                for row in ws.iter_rows(values_only=True):
                    values = [cell_to_text(v) for v in row[:MAX_EXCEL_COLS]]
                    if not any(values):
                        continue
                    parts.append("\t".join(values).rstrip())
                    rows_added += 1
                    if rows_added >= MAX_EXCEL_ROWS:
                        parts.append("[truncated]")
                        break
        finally:
            wb.close()
    elif ext == ".xls":
        if xlrd is None:
            raise RuntimeError("xlrd not installed. Run: pip install xlrd")
        wb = xlrd.open_workbook(path)
        for sh in wb.sheets():
            sheets_processed += 1
            parts.append(f"=== Sheet: {sh.name} ===")
            rows_added = 0
            for r in range(sh.nrows):
                values = [
                    cell_to_text(sh.cell_value(r, c))
                    for c in range(min(sh.ncols, MAX_EXCEL_COLS))
                ]
                if not any(values):
                    continue
                parts.append("\t".join(values).rstrip())
                rows_added += 1
                if rows_added >= MAX_EXCEL_ROWS:
                    parts.append("[truncated]")
                    break
    else:
        raise RuntimeError(f"Unsupported Excel extension: {ext}")

    return "\n".join(parts), sheets_processed


def ocr_pdf_with_gemini(client: OpenAI, pdf_path: str, result_filename: str | None = None) -> dict:
    filename = result_filename or os.path.basename(pdf_path)
    result = {
        "filename": filename,
        "source_path": pdf_path,
        "items": [],
        "pages_processed": 0,
        "tokens_used": 0,
        "error": None,
    }

    try:
        doc = fitz.open(pdf_path)
        pages_to_process = min(len(doc), MAX_PAGES)
        all_items = []

        for page_num in range(pages_to_process):
            page = doc[page_num]
            img_bytes = render_page_as_jpeg(page)
            b64 = base64.b64encode(img_bytes).decode()

            for attempt in range(RETRY_ATTEMPTS):
                try:
                    response = client.chat.completions.create(
                        model=MODEL,
                        messages=[
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": f"data:image/jpeg;base64,{b64}"
                                        },
                                    },
                                    {"type": "text", "text": PROMPT},
                                ],
                            }
                        ],
                        max_tokens=4096,
                        temperature=0,
                    )

                    raw_text = response.choices[0].message.content or ""
                    items = parse_gemini_response(raw_text)

                    if response.usage:
                        result["tokens_used"] += (
                            response.usage.prompt_tokens
                            + response.usage.completion_tokens
                        )

                    all_items.extend(items)
                    result["pages_processed"] += 1
                    print(
                        f"    page {page_num + 1}/{pages_to_process}: "
                        f"{len(items)} items found"
                    )
                    break

                except Exception as e:
                    err_str = str(e)
                    if "rate" in err_str.lower() or "429" in err_str:
                        if attempt < RETRY_ATTEMPTS - 1:
                            print(f"    Rate limit, retrying in {RETRY_DELAY}s...")
                            time.sleep(RETRY_DELAY)
                        else:
                            raise
                    else:
                        raise

        doc.close()
        result["items"] = all_items

    except Exception as e:
        result["error"] = str(e)
        print(f"    ERROR: {e}")

    return result


def ocr_excel_with_gemini(client: OpenAI, excel_path: str, result_filename: str | None = None) -> dict:
    filename = result_filename or os.path.basename(excel_path)
    result = {
        "filename": filename,
        "source_path": excel_path,
        "items": [],
        "pages_processed": 0,
        "sheets_processed": 0,
        "tokens_used": 0,
        "error": None,
    }

    try:
        table_text, sheets_processed = read_excel_as_text(excel_path)
        result["sheets_processed"] = sheets_processed

        for attempt in range(RETRY_ATTEMPTS):
            try:
                response = client.chat.completions.create(
                    model=MODEL,
                    messages=[
                        {
                            "role": "user",
                            "content": (
                                f"{EXCEL_PROMPT}\n\n"
                                f"Файл: {os.path.basename(excel_path)}\n\n"
                                f"{table_text}"
                            ),
                        }
                    ],
                    max_tokens=4096,
                    temperature=0,
                )

                raw_text = response.choices[0].message.content or ""
                result["items"] = parse_gemini_response(raw_text)

                if response.usage:
                    result["tokens_used"] += (
                        response.usage.prompt_tokens
                        + response.usage.completion_tokens
                    )

                print(
                    f"    excel: {sheets_processed} sheet(s), "
                    f"{len(result['items'])} items found"
                )
                break

            except Exception as e:
                err_str = str(e)
                if "rate" in err_str.lower() or "429" in err_str:
                    if attempt < RETRY_ATTEMPTS - 1:
                        print(f"    Rate limit, retrying in {RETRY_DELAY}s...")
                        time.sleep(RETRY_DELAY)
                    else:
                        raise
                else:
                    raise

    except Exception as e:
        result["error"] = str(e)
        print(f"    ERROR: {e}")

    return result


def ocr_invoice_with_gemini(client: OpenAI, path: str, result_filename: str | None = None) -> dict:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        return ocr_pdf_with_gemini(client, path, result_filename)
    if ext in {".xlsx", ".xls"}:
        return ocr_excel_with_gemini(client, path, result_filename)
    raise RuntimeError(f"Unsupported file extension: {ext}")


def main():
    if not API_KEY:
        print("ERROR: OPENROUTER_API_KEY environment variable not set.")
        print("  Windows: set OPENROUTER_API_KEY=sk-or-v1-...")
        print("  Linux/Mac: export OPENROUTER_API_KEY=sk-or-v1-...")
        sys.exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    uploads_dir = os.path.join(project_root, "data", "uploads")
    sample_sources_dir = os.path.join(uploads_dir, "исходники счетов для образцов")
    benchmark_dir = os.path.join(project_root, "scripts", "benchmark-ready")
    results_dir = os.path.join(script_dir, "results")
    category_c_path = os.path.join(results_dir, "category_c_list.json")
    output_path = os.path.join(results_dir, "gemini_results.json")

    invoice_order = []
    benchmark_invoices = load_benchmark_invoices(benchmark_dir)
    if benchmark_invoices:
        source_dirs = [sample_sources_dir, uploads_dir]
        print(f"Loaded benchmark-ready source invoices: {len(benchmark_invoices)}")
        print("Source directories:")
        for directory in source_dirs:
            print(f"  - {directory}")

        missing = []
        for entry in benchmark_invoices:
            try:
                path, match_type = resolve_source_invoice(
                    entry["source_invoice"], source_dirs
                )
                invoice_order.append({
                    **entry,
                    "path": path,
                    "match_type": match_type,
                })
            except FileNotFoundError:
                missing.append(entry["source_invoice"])

        if missing:
            print("\nERROR: missing benchmark source invoices:")
            for source_invoice in missing:
                print(f"  - {source_invoice}")
            sys.exit(1)

        print(f"Processing {len(invoice_order)} benchmark invoices\n")

    elif os.path.exists(category_c_path):
        # Backward-compatible fallback: load Category C list if no benchmark set exists.
        with open(category_c_path, encoding="utf-8") as f:
            category_data = json.load(f)
        for entry in category_data:
            invoice_order.append({
                "candidate_for_ocr": entry["candidate_for_ocr"],
                "source_invoice": os.path.basename(entry["path"]),
                "path": entry["path"],
                "match_type": "category_c",
            })
        invoice_order.sort(key=lambda x: (
            not x["candidate_for_ocr"],
            x["path"],
        ))  # candidates first
        print(
            "Loaded Category C list: "
            f"{sum(1 for x in invoice_order if x['candidate_for_ocr'])} candidates"
        )
    else:
        # Fallback: process all supported invoice files in uploads root.
        print("No benchmark-ready JSON or category_c_list.json found — processing uploads")
        for f in sorted(os.listdir(uploads_dir)):
            if os.path.splitext(f)[1].lower() in SUPPORTED_EXTS:
                invoice_order.append({
                    "candidate_for_ocr": True,
                    "source_invoice": f,
                    "path": os.path.join(uploads_dir, f),
                    "match_type": "uploads",
                })

        # Skip копии (duplicates) only for the broad uploads fallback.
        invoice_order = [
            entry for entry in invoice_order
            if "копия" not in os.path.basename(entry["path"]).lower()
        ]
        print(f"Processing {len(invoice_order)} unique invoices (копии skipped)\n")

    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=API_KEY,
    )

    all_results = {}
    total_tokens = 0

    for i, entry in enumerate(invoice_order, 1):
        invoice_path = entry["path"]
        result_key = entry["source_invoice"]
        filename = os.path.basename(invoice_path)
        ext = os.path.splitext(invoice_path)[1].lower()
        tag = "[EXCEL]" if ext in {".xlsx", ".xls"} else (
            "[SCAN]" if entry["candidate_for_ocr"] else "[text]"
        )
        print(
            f"[{i:2d}/{len(invoice_order)}] {tag} {result_key[:60]} "
            f"({entry['match_type']}: {filename[:60]})"
        )

        r = ocr_invoice_with_gemini(client, invoice_path, result_key)
        r["source_path"] = os.path.relpath(invoice_path, project_root)
        all_results[result_key] = r
        total_tokens += r["tokens_used"]

        status = "OK" if not r["error"] else f"ERR: {r['error'][:50]}"
        print(
            f"         -> {len(r['items'])} items | "
            f"{r['pages_processed']} pages | "
            f"{r['tokens_used']} tokens | {status}\n"
        )

        # Save intermediate results after each invoice
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)

    # Cost estimate: $0.10/1M input + $0.40/1M output (rough 80/20 split)
    estimated_cost = total_tokens * 0.00000015
    print(f"{'='*70}")
    print(f"Done. {len(all_results)} invoices processed.")
    print(f"Total tokens: {total_tokens:,} (~${estimated_cost:.4f})")
    print(f"Results saved: {output_path}")


if __name__ == "__main__":
    main()
