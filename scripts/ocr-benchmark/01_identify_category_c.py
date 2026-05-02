"""
Phase OCR-0: Identify scanned (Category C) PDFs.

For each PDF in data/uploads/:
  - Check text layer length
  - Check garbage character ratio (mirrors pdfParser.ts:checkTextQuality)
  - Classify as Category C (scanned) or has text layer

Output: scripts/ocr-benchmark/results/category_c_list.json
"""

import json
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    print("ERROR: PyMuPDF not installed. Run: pip install pymupdf")
    sys.exit(1)

# Mirror of pdfParser.ts:checkTextQuality (garbage threshold = 0.1)
def check_text_quality(text: str) -> dict:
    if not text or len(text) == 0:
        return {"ratio": 1.0, "is_garbled": True}

    garbage = 0
    for ch in text:
        code = ord(ch)
        if code == 0xFFFD:
            garbage += 1
        elif code < 0x20 and code not in (0x0A, 0x0D, 0x09):
            garbage += 1
        elif 0xE000 <= code <= 0xF8FF:
            garbage += 1
        elif 0xD800 <= code <= 0xDFFF:
            garbage += 1

    ratio = garbage / len(text)
    return {"ratio": ratio, "is_garbled": ratio > 0.1}


def classify_pdf(pdf_path: str) -> dict:
    filename = os.path.basename(pdf_path)
    result = {
        "filename": filename,
        "path": pdf_path,
        "pages": 0,
        "text_len": 0,
        "garbage_ratio": 0.0,
        "has_text_layer": False,
        "is_garbled": False,
        "candidate_for_ocr": False,
        "reason": "",
    }

    try:
        doc = fitz.open(pdf_path)
        result["pages"] = len(doc)

        full_text = ""
        for page in doc:
            full_text += page.get_text()
        doc.close()

        text_clean = full_text.strip()
        quality = check_text_quality(full_text)

        result["text_len"] = len(text_clean)
        result["garbage_ratio"] = round(quality["ratio"], 4)
        result["is_garbled"] = quality["is_garbled"]
        result["has_text_layer"] = len(text_clean) >= 100

        if len(text_clean) < 50:
            result["candidate_for_ocr"] = True
            result["reason"] = f"No text layer (only {len(text_clean)} chars)"
        elif quality["is_garbled"]:
            result["candidate_for_ocr"] = True
            result["reason"] = f"Garbled text ({round(quality['ratio']*100)}% garbage)"
        else:
            result["candidate_for_ocr"] = False
            result["reason"] = f"OK — {len(text_clean)} chars, {round(quality['ratio']*100, 1)}% garbage"

    except Exception as e:
        result["candidate_for_ocr"] = True
        result["reason"] = f"Parse error: {e}"

    return result


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    uploads_dir = os.path.join(project_root, "data", "uploads")
    output_path = os.path.join(script_dir, "results", "category_c_list.json")

    if not os.path.exists(uploads_dir):
        print(f"ERROR: uploads dir not found: {uploads_dir}")
        sys.exit(1)

    pdf_files = [
        os.path.join(uploads_dir, f)
        for f in os.listdir(uploads_dir)
        if f.lower().endswith(".pdf")
    ]

    if not pdf_files:
        print("No PDF files found in data/uploads/")
        sys.exit(1)

    print(f"Found {len(pdf_files)} PDF files\n")

    results = []
    ocr_candidates = []

    for pdf_path in sorted(pdf_files):
        r = classify_pdf(pdf_path)
        results.append(r)
        status = "SCAN/OCR" if r["candidate_for_ocr"] else "text OK"
        print(f"  [{status:8s}] {r['filename'][:55]:<55} | {r['reason']}")
        if r["candidate_for_ocr"]:
            ocr_candidates.append(r)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n{'='*70}")
    print(f"Total PDFs: {len(results)}")
    print(f"OCR candidates (Category C): {len(ocr_candidates)}")
    print(f"Has text layer: {len(results) - len(ocr_candidates)}")
    print(f"\nSaved: {output_path}")

    if not ocr_candidates:
        print("\nNOTE: No scanned PDFs found — all have text layers.")
        print("Gemini benchmark will still run on all PDFs to validate quality.")


if __name__ == "__main__":
    main()
