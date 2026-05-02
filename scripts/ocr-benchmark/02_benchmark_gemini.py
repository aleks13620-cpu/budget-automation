"""
Phase OCR-1: Gemini Flash OCR benchmark via OpenRouter.

For each PDF (prioritising Category C candidates, then all others):
  - Render pages as images via PyMuPDF (200 DPI)
  - Send to google/gemini-2.0-flash via OpenRouter
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

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "google/gemini-2.5-flash"
DPI = 200
MAX_PAGES = 4          # process first N pages per PDF
RETRY_ATTEMPTS = 3
RETRY_DELAY = 5        # seconds between retries on rate limit

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


def ocr_pdf_with_gemini(client: OpenAI, pdf_path: str) -> dict:
    filename = os.path.basename(pdf_path)
    result = {
        "filename": filename,
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


def main():
    if not API_KEY:
        print("ERROR: OPENROUTER_API_KEY environment variable not set.")
        print("  Windows: set OPENROUTER_API_KEY=sk-or-v1-...")
        print("  Linux/Mac: export OPENROUTER_API_KEY=sk-or-v1-...")
        sys.exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    uploads_dir = os.path.join(project_root, "data", "uploads")
    results_dir = os.path.join(script_dir, "results")
    category_c_path = os.path.join(results_dir, "category_c_list.json")
    output_path = os.path.join(results_dir, "gemini_results.json")

    # Load Category C list if available to sort OCR candidates first
    pdf_order = []  # (is_candidate, path)
    if os.path.exists(category_c_path):
        with open(category_c_path, encoding="utf-8") as f:
            category_data = json.load(f)
        for entry in category_data:
            pdf_order.append((entry["candidate_for_ocr"], entry["path"]))
        pdf_order.sort(key=lambda x: (not x[0], x[1]))  # candidates first
        print(f"Loaded Category C list: {sum(1 for c, _ in pdf_order if c)} candidates")
    else:
        # Fallback: process all PDFs
        print("No category_c_list.json found — processing all PDFs")
        for f in sorted(os.listdir(uploads_dir)):
            if f.lower().endswith(".pdf"):
                pdf_order.append((True, os.path.join(uploads_dir, f)))

    # Skip копии (duplicates)
    pdf_order = [
        (c, p) for c, p in pdf_order
        if "копия" not in os.path.basename(p).lower()
    ]
    print(f"Processing {len(pdf_order)} unique PDFs (копии skipped)\n")

    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=API_KEY,
    )

    all_results = {}
    total_tokens = 0

    for i, (is_candidate, pdf_path) in enumerate(pdf_order, 1):
        filename = os.path.basename(pdf_path)
        tag = "[SCAN]" if is_candidate else "[text]"
        print(f"[{i:2d}/{len(pdf_order)}] {tag} {filename[:60]}")

        r = ocr_pdf_with_gemini(client, pdf_path)
        all_results[filename] = r
        total_tokens += r["tokens_used"]

        status = "OK" if not r["error"] else f"ERR: {r['error'][:50]}"
        print(
            f"         -> {len(r['items'])} items | "
            f"{r['pages_processed']} pages | "
            f"{r['tokens_used']} tokens | {status}\n"
        )

        # Save intermediate results after each PDF
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)

    # Cost estimate: $0.10/1M input + $0.40/1M output (rough 80/20 split)
    estimated_cost = total_tokens * 0.00000015
    print(f"{'='*70}")
    print(f"Done. {len(all_results)} PDFs processed.")
    print(f"Total tokens: {total_tokens:,} (~${estimated_cost:.4f})")
    print(f"Results saved: {output_path}")


if __name__ == "__main__":
    main()
