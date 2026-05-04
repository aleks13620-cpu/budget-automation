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


def avg(values: list[float | None]) -> float | None:
    clean = [value for value in values if value is not None]
    if not clean:
        return None
    return sum(clean) / len(clean)


def print_table(rows: list[dict[str, Any]]) -> None:
    print("| поставщик | Overall% | Names% | Prices% | статус |")
    print("|---|---:|---:|---:|---|")
    for row in rows:
        print(
            f"| {row['supplier']} | {percent(row['overall'])} | "
            f"{percent(row['names'])} | {percent(row['prices'])} | {row['status']} |"
        )


def main() -> int:
    scorer = load_scorer()

    with RESULTS_PATH.open(encoding="utf-8") as f:
        gemini_data = json.load(f)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for path in benchmark_files():
        with path.open(encoding="utf-8") as f:
            ref = json.load(f)

        supplier = ref.get("supplier") or path.stem
        source_invoice = ref.get("source_invoice", "")
        ref_items = ref.get("items", [])
        gemini_items = scorer.find_gemini_result(gemini_data, source_invoice)

        if gemini_items is None:
            grouped[supplier].append(
                {"overall_score": None, "name_ok_pct": None, "price_ok_pct": None}
            )
            continue

        grouped[supplier].append(scorer.score_document(ref_items, gemini_items))

    rows = []
    for supplier in sorted(grouped):
        scores = grouped[supplier]
        overall = avg([score.get("overall_score") for score in scores])
        names = avg([score.get("name_ok_pct") for score in scores])
        prices = avg([score.get("price_ok_pct") for score in scores])
        status = status_for(overall)
        rows.append(
            {
                "supplier": supplier,
                "overall": overall,
                "names": names,
                "prices": prices,
                "status": status,
            }
        )

    print_table(rows)
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
