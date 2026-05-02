"""
Phase OCR-3: Score Gemini results against benchmark-ready ground truth.

Matches each benchmark-ready JSON to its corresponding Gemini result by
source_invoice filename, then computes accuracy metrics.

Output: scripts/ocr-benchmark/results/report.md
"""

import io
import json
import os
import re
import sys
from difflib import SequenceMatcher

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# ── Config ────────────────────────────────────────────────────────────────────

NAME_SIM_THRESHOLD = 0.75   # min SequenceMatcher ratio for name match
PRICE_TOL = 0.05            # 5% price tolerance (VAT rounding differences)
COUNT_TOL = 0.80            # min item_count_ratio to be considered OK


def name_sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def parse_qty_value(qty_str) -> float | None:
    """Extract numeric value from quantity string like '5 шт', '208 м', or a number."""
    if qty_str is None:
        return None
    if isinstance(qty_str, (int, float)):
        return float(qty_str)
    m = re.match(r'^([\d\s.,]+)', str(qty_str).strip())
    if m:
        try:
            return float(m.group(1).replace(' ', '').replace(',', '.'))
        except ValueError:
            return None
    return None


def price_ok(expected: float | None, actual: float | None) -> bool:
    if expected is None or actual is None:
        return False
    if expected == 0:
        return actual == 0
    return abs(expected - actual) / abs(expected) <= PRICE_TOL


def score_document(ref_items: list, gemini_items: list) -> dict:
    """
    Match each ref item to the best Gemini item by name similarity.
    Returns per-item metrics and aggregate scores.
    """
    n_ref = len(ref_items)
    n_gem = len(gemini_items)

    if n_ref == 0:
        return {
            "item_count_ref": 0, "item_count_gemini": n_gem,
            "count_ratio": None, "matches": [],
            "name_ok_pct": None, "price_ok_pct": None, "overall_score": None,
        }

    matches = []
    used_gemini = set()

    for ref in ref_items:
        ref_name = ref.get("name", "")
        ref_price = ref.get("price_with_vat")

        best_sim = -1
        best_idx = -1
        for gi, gem in enumerate(gemini_items):
            if gi in used_gemini:
                continue
            sim = name_sim(ref_name, gem.get("name", ""))
            if sim > best_sim:
                best_sim = sim
                best_idx = gi

        if best_idx >= 0 and best_sim >= NAME_SIM_THRESHOLD:
            used_gemini.add(best_idx)
            gem = gemini_items[best_idx]
            gem_price = gem.get("price")
            p_ok = price_ok(ref_price, gem_price)
            matches.append({
                "ref_name": ref_name,
                "gem_name": gem.get("name", ""),
                "name_sim": round(best_sim, 3),
                "ref_price": ref_price,
                "gem_price": gem_price,
                "price_ok": p_ok,
                "matched": True,
            })
        else:
            matches.append({
                "ref_name": ref_name,
                "gem_name": gemini_items[best_idx].get("name", "") if best_idx >= 0 else "",
                "name_sim": round(best_sim, 3) if best_idx >= 0 else 0,
                "ref_price": ref_price,
                "gem_price": None,
                "price_ok": False,
                "matched": False,
            })

    name_ok_count = sum(1 for m in matches if m["matched"])
    price_ok_count = sum(1 for m in matches if m["price_ok"])
    count_ratio = min(n_gem, n_ref) / n_ref

    name_ok_pct = name_ok_count / n_ref
    price_ok_pct = price_ok_count / n_ref
    overall_score = (name_ok_pct * 0.5 + price_ok_pct * 0.3 + min(count_ratio, 1.0) * 0.2)

    return {
        "item_count_ref": n_ref,
        "item_count_gemini": n_gem,
        "count_ratio": round(count_ratio, 3),
        "matches": matches,
        "name_ok_pct": round(name_ok_pct, 3),
        "price_ok_pct": round(price_ok_pct, 3),
        "overall_score": round(overall_score, 3),
    }


def find_gemini_result(gemini_data: dict, source_invoice: str) -> list | None:
    """Find Gemini result by source_invoice filename (fuzzy filename match)."""
    # Exact match first
    if source_invoice in gemini_data:
        return gemini_data[source_invoice]["items"]

    # Fuzzy: find best matching key
    best_sim = 0
    best_key = None
    src_lower = source_invoice.lower()
    for key in gemini_data:
        sim = SequenceMatcher(None, src_lower, key.lower()).ratio()
        if sim > best_sim:
            best_sim = sim
            best_key = key

    if best_key and best_sim >= 0.6:
        return gemini_data[best_key]["items"]

    return None


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    benchmark_dir = os.path.join(project_root, "scripts", "benchmark-ready")
    gemini_path = os.path.join(script_dir, "results", "gemini_results.json")
    report_path = os.path.join(script_dir, "results", "report.md")

    with open(gemini_path, encoding="utf-8") as f:
        gemini_data = json.load(f)

    bench_files = [f for f in os.listdir(benchmark_dir) if f.endswith(".json")]
    print(f"Benchmark files: {len(bench_files)}")
    print(f"Gemini results: {len(gemini_data)} PDFs\n")

    doc_scores = []

    for bench_file in sorted(bench_files):
        with open(os.path.join(benchmark_dir, bench_file), encoding="utf-8") as f:
            ref = json.load(f)

        source_invoice = ref.get("source_invoice", "")
        supplier = ref.get("supplier", bench_file)
        ref_items = ref.get("items", [])

        gemini_items = find_gemini_result(gemini_data, source_invoice)

        if gemini_items is None:
            print(f"  [NO MATCH] {supplier} <- {source_invoice}")
            doc_scores.append({
                "supplier": supplier,
                "source_invoice": source_invoice,
                "matched_pdf": None,
                "score": None,
                "note": "Gemini result not found",
            })
            continue

        score = score_document(ref_items, gemini_items)
        pct = f"{score['overall_score']*100:.0f}%" if score['overall_score'] is not None else "N/A"
        print(
            f"  [{pct:>4s}] {supplier[:35]:<35} | "
            f"ref={score['item_count_ref']} gem={score['item_count_gemini']} | "
            f"name={score['name_ok_pct']*100:.0f}% price={score['price_ok_pct']*100:.0f}%"
        )

        doc_scores.append({
            "supplier": supplier,
            "source_invoice": source_invoice,
            "score": score,
            "note": "",
        })

    # ── Aggregate stats ────────────────────────────────────────────────────────
    scored = [d for d in doc_scores if d["score"] is not None]
    unmatched = [d for d in doc_scores if d["score"] is None]

    if scored:
        avg_overall = sum(d["score"]["overall_score"] for d in scored) / len(scored)
        avg_name = sum(d["score"]["name_ok_pct"] for d in scored) / len(scored)
        avg_price = sum(d["score"]["price_ok_pct"] for d in scored) / len(scored)
        avg_count = sum(d["score"]["count_ratio"] for d in scored) / len(scored)
    else:
        avg_overall = avg_name = avg_price = avg_count = 0

    # ── Write report.md ────────────────────────────────────────────────────────
    lines = []
    lines.append("# Gemini 2.5 Flash — OCR Benchmark Report\n")
    lines.append(f"**Model:** google/gemini-2.5-flash via OpenRouter  \n")
    lines.append(f"**Benchmarks matched:** {len(scored)}/{len(bench_files)}  \n")
    lines.append(f"**Total cost:** ~$0.025 (167K tokens)\n\n")

    lines.append("## Aggregate Scores\n\n")
    lines.append("| Metric | Score | Threshold | Status |\n")
    lines.append("|--------|-------|-----------|--------|\n")

    def badge(val, thr): return "✅" if val >= thr else "❌"

    lines.append(f"| Overall score | **{avg_overall*100:.1f}%** | ≥85% | {badge(avg_overall, 0.85)} |\n")
    lines.append(f"| Name match | {avg_name*100:.1f}% | ≥80% | {badge(avg_name, 0.80)} |\n")
    lines.append(f"| Price match (±5%) | {avg_price*100:.1f}% | ≥80% | {badge(avg_price, 0.80)} |\n")
    lines.append(f"| Item count ratio | {avg_count*100:.1f}% | ≥80% | {badge(avg_count, 0.80)} |\n")

    lines.append("\n## Decision\n\n")
    if avg_overall >= 0.85:
        lines.append("**✅ INTEGRATE** — Gemini 2.5 Flash meets the quality bar. Proceed to OCR-4 integration.\n")
    elif avg_overall >= 0.70:
        lines.append("**⚠️ TUNE** — Quality is acceptable but below target. Consider prompt tuning or using gemini-2.5-pro for difficult documents.\n")
    else:
        lines.append("**❌ REJECT** — Quality below 70%. Do not integrate without significant improvement.\n")

    lines.append("\n## Per-Document Results\n\n")
    lines.append("| Supplier | Overall | Items ref/gem | Name% | Price% | Notes |\n")
    lines.append("|----------|---------|---------------|-------|--------|-------|\n")

    for d in doc_scores:
        if d["score"] is None:
            lines.append(f"| {d['supplier'][:30]} | N/A | — | — | — | {d['note']} |\n")
            continue
        s = d["score"]
        overall = f"{s['overall_score']*100:.0f}%"
        counts = f"{s['item_count_ref']}/{s['item_count_gemini']}"
        name_p = f"{s['name_ok_pct']*100:.0f}%"
        price_p = f"{s['price_ok_pct']*100:.0f}%"
        lines.append(f"| {d['supplier'][:30]} | {overall} | {counts} | {name_p} | {price_p} | |\n")

    if unmatched:
        lines.append(f"\n> {len(unmatched)} benchmark(s) had no matching Gemini result (PDF not in uploads/).\n")

    lines.append("\n## Category C (Scanned PDFs) Detail\n\n")
    category_c_path = os.path.join(script_dir, "results", "category_c_list.json")
    if os.path.exists(category_c_path):
        with open(category_c_path, encoding="utf-8") as f:
            cat_c = json.load(f)
        candidates = [x for x in cat_c if x["candidate_for_ocr"]]
        if candidates:
            lines.append("| File | Text len | Garbage% | Gemini items | Status |\n")
            lines.append("|------|----------|----------|--------------|--------|\n")
            for c in candidates:
                fname = c["filename"]
                gem = gemini_data.get(fname, {})
                n_items = len(gem.get("items", []))
                status = "✅ Extracted" if n_items > 0 else "❌ Empty"
                lines.append(
                    f"| {fname[:45]} | {c['text_len']} | "
                    f"{c['garbage_ratio']*100:.0f}% | {n_items} | {status} |\n"
                )
        else:
            lines.append("No Category C (scanned) PDFs found in uploads/.\n")

    lines.append("\n## Worst-Matched Items (name_sim < 0.75)\n\n")
    mismatches = []
    for d in scored:
        for m in d["score"]["matches"]:
            if not m["matched"]:
                mismatches.append((d["supplier"], m["ref_name"], m["gem_name"], m["name_sim"]))

    if mismatches:
        lines.append("| Supplier | Expected name | Gemini name | Sim |\n")
        lines.append("|----------|---------------|-------------|-----|\n")
        for sup, ref_n, gem_n, sim in mismatches[:20]:
            lines.append(f"| {sup[:20]} | {ref_n[:40]} | {gem_n[:40]} | {sim:.2f} |\n")
    else:
        lines.append("All items matched above threshold.\n")

    with open(report_path, "w", encoding="utf-8") as f:
        f.writelines(lines)

    print(f"\n{'='*70}")
    print(f"RESULTS: {len(scored)}/{len(bench_files)} benchmarks scored")
    print(f"  Overall:     {avg_overall*100:.1f}%  {'✅' if avg_overall >= 0.85 else '⚠️' if avg_overall >= 0.70 else '❌'}")
    print(f"  Name match:  {avg_name*100:.1f}%")
    print(f"  Price match: {avg_price*100:.1f}%")
    print(f"  Count ratio: {avg_count*100:.1f}%")
    print(f"\nReport: {report_path}")


if __name__ == "__main__":
    main()
