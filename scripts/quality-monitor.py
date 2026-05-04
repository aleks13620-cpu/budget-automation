"""
Manual quality monitor for OCR benchmark results.

Reads Gemini OCR output and benchmark-ready ground truth, then prints a
supplier-level status table using the same scoring functions as
scripts/ocr-benchmark/03_score_results.py.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from collections import defaultdict
from pathlib import Path
from types import ModuleType
from typing import Any


if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.dont_write_bytecode = True


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESULTS_PATH = PROJECT_ROOT / "scripts" / "ocr-benchmark" / "results" / "gemini_results.json"
BENCHMARK_ROOT = PROJECT_ROOT / "scripts" / "benchmark-ready"
SCORER_PATH = PROJECT_ROOT / "scripts" / "ocr-benchmark" / "03_score_results.py"


def load_scorer() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ocr_benchmark_scorer", SCORER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load scorer from {SCORER_PATH}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def benchmark_files() -> list[Path]:
    files: list[Path] = []
    for subset in ("train", "holdout"):
        subset_dir = BENCHMARK_ROOT / subset
        if subset_dir.is_dir():
            files.extend(sorted(subset_dir.glob("*.json")))
    return files


def percent(value: float | None) -> str:
    if value is None:
        return "N/A"
    return f"{value * 100:.1f}%"


def status_for(overall: float | None) -> str:
    if overall is None or overall < 0.85:
        return "FAIL"
    if overall < 0.95:
        return "WARN"
    return "OK"


def avg_score(values: list[float | None]) -> float:
    if not values:
        return 0.0
    return sum(value if value is not None else 0.0 for value in values) / len(values)


def print_table(rows: list[dict[str, Any]]) -> None:
    print("| поставщик | Overall% | Names% | Prices% | статус |")
    print("|---|---:|---:|---:|---|")
    for row in rows:
        print(
            f"| {row['supplier']} | {percent(row['overall'])} | "
            f"{percent(row['names'])} | {percent(row['prices'])} | {row['status']} |"
        )


def short_text(value: str, limit: int = 80) -> str:
    value = value.replace("\n", " ").strip()
    if len(value) <= limit:
        return value
    return value[: limit - 3].rstrip() + "..."


def price_failure_count(score: dict[str, Any] | None) -> int:
    if score is None:
        return 0
    return sum(
        1
        for match in score.get("matches", [])
        if not match.get("price_ok")
    )


def worst_items(score: dict[str, Any] | None, threshold: float = 0.78) -> list[dict[str, Any]]:
    if score is None:
        return []
    matches = [
        match
        for match in score.get("matches", [])
        if match.get("name_sim", 0) < threshold
    ]
    return sorted(matches, key=lambda match: match.get("name_sim", 0))


def print_status_details(rows: list[dict[str, Any]]) -> None:
    problem_rows = [row for row in rows if row["status"] in {"WARN", "FAIL"}]
    if not problem_rows:
        return

    print()
    for row in problem_rows:
        print(f"[{row['status']}] {row['supplier']}")
        for doc in row["documents"]:
            score = doc["score"]
            print(f"  file:          {doc['file']}")
            if score is None:
                print(f"  source:        {doc['source_invoice'] or 'N/A'}")
                print("  reason:        Gemini result not found")
                continue

            print(f"  items ref/gem: {score['item_count_ref']}/{score['item_count_gemini']}")
            items = worst_items(score)
            if items:
                print("  worst items (name_sim < 0.78):")
                for item in items[:5]:
                    print(
                        f"    - \"{short_text(item.get('ref_name', ''))}\" → "
                        f"\"{short_text(item.get('gem_name', ''))}\" "
                        f"(sim={item.get('name_sim', 0):.2f})"
                    )
            print(f"  price failures: {price_failure_count(score)}")


def main() -> int:
    scorer = load_scorer()

    with RESULTS_PATH.open(encoding="utf-8") as f:
        gemini_data = json.load(f)

    files = benchmark_files()
    if not files:
        print("FAIL: no benchmark JSON files found in train/holdout", file=sys.stderr)
        return 1

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for path in files:
        with path.open(encoding="utf-8") as f:
            ref = json.load(f)

        supplier = ref.get("supplier") or path.stem
        source_invoice = ref.get("source_invoice", "")
        ref_items = ref.get("items", [])
        gemini_items = scorer.find_gemini_result(gemini_data, source_invoice)

        if gemini_items is None:
            grouped[supplier].append(
                {
                    "file": path.relative_to(PROJECT_ROOT).as_posix(),
                    "source_invoice": source_invoice,
                    "score": None,
                }
            )
            continue

        grouped[supplier].append(
            {
                "file": path.relative_to(PROJECT_ROOT).as_posix(),
                "source_invoice": source_invoice,
                "score": scorer.score_document(ref_items, gemini_items),
            }
        )

    rows = []
    for supplier in sorted(grouped):
        documents = grouped[supplier]
        scores = [document["score"] for document in documents]
        overall = avg_score([score.get("overall_score") if score is not None else None for score in scores])
        names = avg_score([score.get("name_ok_pct") if score is not None else None for score in scores])
        prices = avg_score([score.get("price_ok_pct") if score is not None else None for score in scores])
        has_unscorable = any(score is None or score.get("overall_score") is None for score in scores)
        status = "FAIL" if has_unscorable else status_for(overall)
        rows.append(
            {
                "supplier": supplier,
                "overall": overall,
                "names": names,
                "prices": prices,
                "status": status,
                "documents": documents,
            }
        )

    print_table(rows)
    print_status_details(rows)
    return 1 if any(row["status"] == "FAIL" for row in rows) else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FileNotFoundError as exc:
        print(f"Missing required file: {exc.filename}", file=sys.stderr)
        raise SystemExit(2)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON: {exc}", file=sys.stderr)
        raise SystemExit(2)
