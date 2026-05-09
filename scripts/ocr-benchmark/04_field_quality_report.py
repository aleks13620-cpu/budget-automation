"""
Field-level quality report for existing OCR benchmark JSON.

This script is intentionally read-only for benchmark/OCR inputs:
- scripts/benchmark-ready/train/
- scripts/benchmark-ready/holdout/
- scripts/ocr-benchmark/results/gemini_results.json

It writes only scripts/ocr-benchmark/results/field_quality_report.md and does
not call OCR, LLM, parser, API, UI, route, database, or frontend code.
"""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from types import ModuleType
from typing import Any, TextIO


if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.dont_write_bytecode = True


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_ROOT = PROJECT_ROOT / "scripts" / "benchmark-ready"
RESULTS_DIR = PROJECT_ROOT / "scripts" / "ocr-benchmark" / "results"
GEMINI_RESULTS_PATH = RESULTS_DIR / "gemini_results.json"
REPORT_PATH = RESULTS_DIR / "field_quality_report.md"
LEGACY_SCORER_PATH = PROJECT_ROOT / "scripts" / "ocr-benchmark" / "03_score_results.py"

STATUS_ORDER = ("OK", "FAIL", "MISSING_REF", "MISSING_RESULT", "NOT_APPLICABLE")
ROW_FIELDS = (
    "row_presence",
    "name",
    "article",
    "unit_price_with_vat",
    "quantity_number",
    "unit",
    "line_amount",
    "result_line_amount_invariant",
)
DOC_FIELDS = ("row_count", "document_total", "vat_rate", "vat_amount")
MONEY_QUANT = Decimal("0.01")
QTY_TOL = Decimal("0.001")
KNOWN_PROBLEM_SUPPLIERS = ("Электротехмонтаж", "САНТЕХПРОМ")
CATEGORY_C_SCANS = (
    "Арктика Предложение 873786 от 01.11.2025 (1).",
    "ПК Курс doc02851820251216123708 (1).pdf",
    "ПК Курс doc02851820251216123708 (1)1.pdf",
)
KNOWN_PROBLEM_DOCUMENTS = (
    {
        "title": "Электротехмонтаж",
        "supplier_aliases": ("Электротехмонтаж",),
        "source_invoice": "403_2026315_202511271152_5492386_PRINTER2.TXT (1).pdf",
    },
    {
        "title": "САНТЕХПРОМ",
        "supplier_aliases": ("САНТЕХПРОМ", "ООО САНТЕХПРОМ"),
        "source_invoice": "Коммерческое предложение № 91 от 03 февраля 2026 г.pdf",
    },
)


@dataclass
class RowPair:
    kind: str
    ref_index: int | None
    result_index: int | None
    ref_item: dict[str, Any] | None
    result_item: dict[str, Any] | None
    match_method: str
    name_similarity: float | None = None
    low_confidence: bool = False
    split_merge_cluster: bool = False


@dataclass
class RowComparison:
    pair: RowPair
    statuses: dict[str, str]
    values: dict[str, tuple[str, str]]
    notes: list[str] = field(default_factory=list)


@dataclass
class DocumentReport:
    split: str
    benchmark_path: Path
    supplier: str
    source_invoice: str
    ref_count: int
    result_count: int | None
    row_count_status: str
    legacy_score: dict[str, Any] | None
    exact_result_found: bool
    rows: list[RowComparison]
    warnings: list[str] = field(default_factory=list)
    row_matching_issues: list[dict[str, Any]] = field(default_factory=list)
    split_merge_clusters: list[dict[str, Any]] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build field-level OCR benchmark report")
    parser.add_argument(
        "--set",
        choices=["train", "holdout", "all"],
        default="all",
        help="Which benchmark set to report",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=REPORT_PATH,
        help="Markdown report path",
    )
    parser.add_argument(
        "--full-row-details",
        action="store_true",
        help="Render full row-level details for all documents (default is compact startup mode)",
    )
    parser.add_argument(
        "--max-row-detail-docs",
        type=int,
        default=6,
        help="Maximum documents in compact row-details mode",
    )
    return parser.parse_args()


def ensure_output_within_results_dir(output: Path) -> Path:
    output_resolved = output.resolve()
    results_resolved = RESULTS_DIR.resolve()
    if not output_resolved.is_relative_to(results_resolved):
        raise ValueError(f"--output must be inside {results_resolved}")
    return output_resolved


def load_legacy_scorer() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ocr_benchmark_legacy_scorer", LEGACY_SCORER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load legacy scorer from {LEGACY_SCORER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def benchmark_files(selected_set: str) -> list[tuple[str, Path]]:
    splits = ("train", "holdout") if selected_set == "all" else (selected_set,)
    files: list[tuple[str, Path]] = []
    for split in splits:
        split_dir = BENCHMARK_ROOT / split
        if split_dir.is_dir():
            files.extend((split, path) for path in sorted(split_dir.glob("*.json")))
    return files


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    text = re.sub(r"\s+", " ", text.strip())
    return text.lower()


def normalize_article(value: Any) -> str:
    text = normalize_text(value)
    text = re.sub(r"\s+", "", text)
    return text


def decimal_from(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return None

    text = unicodedata.normalize("NFKC", str(value)).strip()
    if not text:
        return None
    text = re.sub(r"[^0-9,.\-+]", "", text)
    if not text or text in {"-", "+", ".", ","}:
        return None
    text = text.replace(",", ".")
    if text.count(".") > 1:
        head, tail = text.rsplit(".", 1)
        text = head.replace(".", "") + "." + tail
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def round_money(value: Decimal) -> Decimal:
    return value.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def parse_quantity_number(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return decimal_from(value)

    text = unicodedata.normalize("NFKC", str(value)).strip()
    match = re.match(r"^([+-]?[\d\s]+(?:[,.]\d+)?)", text)
    if not match:
        return None
    return decimal_from(match.group(1))


def parse_benchmark_quantity(item: dict[str, Any] | None) -> Decimal | None:
    if not item:
        return None
    return parse_quantity_number(item.get("quantity"))


def parse_result_quantity(item: dict[str, Any] | None) -> Decimal | None:
    if not item:
        return None
    return parse_quantity_number(item.get("quantity"))


def parse_benchmark_unit(item: dict[str, Any] | None) -> str:
    if not item:
        return ""
    if "unit" in item and normalize_text(item.get("unit")):
        return normalize_text(item.get("unit"))
    quantity = item.get("quantity")
    if quantity is None or isinstance(quantity, (int, float, Decimal)):
        return ""
    text = unicodedata.normalize("NFKC", str(quantity)).strip()
    match = re.match(r"^[+-]?[\d\s]+(?:[,.]\d+)?\s*(.*)$", text)
    if not match:
        return ""
    return normalize_text(match.group(1))


def parse_result_unit(item: dict[str, Any] | None) -> str:
    if not item:
        return ""
    return normalize_text(item.get("unit"))


def canonical_unit(unit: str, paired_ref_unit: str | None = None) -> str:
    unit = normalize_text(unit).replace(".", "")
    unit = re.sub(r"\s+", "", unit)
    paired = paired_ref_unit or ""

    if unit in {"м", "m", "sm"}:
        return "м"
    if unit in {"шт", "штука", "pcs", "pc", "st"}:
        return "шт"
    if unit == "t" and paired == "шт":
        return "шт"
    if unit in {"уп", "упак", "упаковка"}:
        return "уп"
    if unit in {"кор", "коробка"}:
        return "кор"
    if unit in {"компл", "комплект", "к-т"}:
        return "компл"
    return unit


def levenshtein_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    if len(a) < len(b):
        a, b = b, a

    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            insert_cost = current[j - 1] + 1
            delete_cost = previous[j] + 1
            replace_cost = previous[j - 1] + (0 if ca == cb else 1)
            current.append(min(insert_cost, delete_cost, replace_cost))
        previous = current
    return previous[-1]


def name_similarity(a: Any, b: Any) -> float:
    left = normalize_text(a)
    right = normalize_text(b)
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    distance = levenshtein_distance(left, right)
    return 1 - (distance / max(len(left), len(right)))


def status_counts(statuses: list[str]) -> dict[str, int]:
    counts = Counter(statuses)
    return {status: counts.get(status, 0) for status in STATUS_ORDER}


def field_status(ref_present: bool, result_present: bool, equal: bool) -> str:
    if not ref_present:
        return "MISSING_REF"
    if not result_present:
        return "MISSING_RESULT"
    return "OK" if equal else "FAIL"


def format_decimal(value: Decimal | None, places: int | None = None) -> str:
    if value is None:
        return ""
    if places is not None:
        value = value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    text = format(value, "f")
    if "." in text and places is None:
        text = text.rstrip("0").rstrip(".")
    return text


def md_cell(value: Any, limit: int | None = None) -> str:
    if value is None:
        text = ""
    else:
        text = str(value)
    text = text.replace("\n", " ").replace("\r", " ").replace("|", "\\|").strip()
    text = re.sub(r"\s+", " ", text)
    if limit is not None and len(text) > limit:
        text = text[: max(0, limit - 3)].rstrip() + "..."
    return text


def pct(value: float | None) -> str:
    if value is None:
        return "N/A"
    return f"{value * 100:.1f}%"


def build_result_filename_index(gemini_data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for doc in gemini_data.values():
        if not isinstance(doc, dict):
            continue
        filename = doc.get("filename")
        if not isinstance(filename, str) or not filename:
            continue
        # Keep the first match to preserve previous fallback semantics.
        index.setdefault(filename, doc)
    return index


def find_exact_result(
    gemini_data: dict[str, Any],
    result_by_filename: dict[str, dict[str, Any]],
    source_invoice: str,
) -> dict[str, Any] | None:
    if source_invoice in gemini_data:
        return gemini_data[source_invoice]
    return result_by_filename.get(source_invoice)


def unique_article_indexes(items: list[dict[str, Any]]) -> dict[str, int]:
    normalized = [normalize_article(item.get("article")) for item in items]
    counts = Counter(article for article in normalized if article)
    return {
        article: index
        for index, article in enumerate(normalized)
        if article and counts[article] == 1
    }


def find_split_merge_clusters(
    ref_items: list[dict[str, Any]],
    result_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    result_articles = [
        normalize_article(item.get("article"))
        for item in result_items
    ]

    for ref_index in range(len(ref_items) - 1):
        left = ref_items[ref_index]
        right = ref_items[ref_index + 1]
        cluster_articles = {
            article
            for article in (
                normalize_article(left.get("article")),
                normalize_article(right.get("article")),
            )
            if article
        }
        if not cluster_articles:
            continue

        cluster_name = f"{left.get('name', '')} {right.get('name', '')}"
        for result_index, result_article in enumerate(result_articles):
            if result_article not in cluster_articles:
                continue
            sim = name_similarity(cluster_name, result_items[result_index].get("name", ""))
            if sim >= 0.80:
                clusters.append(
                    {
                        "ref_indexes": (ref_index, ref_index + 1),
                        "result_index": result_index,
                        "name_similarity": round(sim, 3),
                    }
                )
    return clusters


def build_row_pairs(
    ref_items: list[dict[str, Any]],
    result_items: list[dict[str, Any]],
) -> list[RowPair]:
    ref_unique = unique_article_indexes(ref_items)
    result_unique = unique_article_indexes(result_items)
    ref_counts = Counter(normalize_article(item.get("article")) for item in ref_items if normalize_article(item.get("article")))
    result_counts = Counter(normalize_article(item.get("article")) for item in result_items if normalize_article(item.get("article")))

    pairs_by_ref: dict[int, RowPair] = {}
    used_results: set[int] = set()

    for article, ref_index in ref_unique.items():
        if ref_counts[article] != 1 or result_counts.get(article) != 1:
            continue
        result_index = result_unique[article]
        sim = name_similarity(ref_items[ref_index].get("name", ""), result_items[result_index].get("name", ""))
        pairs_by_ref[ref_index] = RowPair(
            kind="matched",
            ref_index=ref_index,
            result_index=result_index,
            ref_item=ref_items[ref_index],
            result_item=result_items[result_index],
            match_method="article",
            name_similarity=round(sim, 3),
        )
        used_results.add(result_index)

    for ref_index, ref_item in enumerate(ref_items):
        if ref_index in pairs_by_ref:
            continue

        result_index = ref_index if ref_index < len(result_items) and ref_index not in used_results else None
        if result_index is None:
            pairs_by_ref[ref_index] = RowPair(
                kind="missing_result",
                ref_index=ref_index,
                result_index=None,
                ref_item=ref_item,
                result_item=None,
                match_method="none",
                name_similarity=None,
            )
            continue

        sim = name_similarity(ref_item.get("name", ""), result_items[result_index].get("name", ""))
        pairs_by_ref[ref_index] = RowPair(
            kind="matched",
            ref_index=ref_index,
            result_index=result_index,
            ref_item=ref_item,
            result_item=result_items[result_index],
            match_method="position",
            name_similarity=round(sim, 3),
            low_confidence=sim < 0.75,
        )
        used_results.add(result_index)

    pairs = [pairs_by_ref[index] for index in sorted(pairs_by_ref)]
    for result_index, result_item in enumerate(result_items):
        if result_index in used_results:
            continue
        pairs.append(
            RowPair(
                kind="extra_result",
                ref_index=None,
                result_index=result_index,
                ref_item=None,
                result_item=result_item,
                match_method="none",
                name_similarity=None,
            )
        )
    return pairs


def compare_quantity(pair: RowPair) -> tuple[str, str, str]:
    ref_qty = parse_benchmark_quantity(pair.ref_item)
    result_qty = parse_result_quantity(pair.result_item)
    status = field_status(
        ref_qty is not None,
        result_qty is not None,
        abs(ref_qty - result_qty) <= QTY_TOL if ref_qty is not None and result_qty is not None else False,
    )
    return status, format_decimal(ref_qty), format_decimal(result_qty)


def compare_unit(pair: RowPair) -> tuple[str, str, str]:
    ref_raw = parse_benchmark_unit(pair.ref_item)
    result_raw = parse_result_unit(pair.result_item)
    ref_unit = canonical_unit(ref_raw)
    result_unit = canonical_unit(result_raw, ref_unit)
    status = field_status(bool(ref_unit), bool(result_unit), ref_unit == result_unit)
    return status, ref_unit, result_unit


def compare_article(pair: RowPair) -> tuple[str, str, str]:
    ref_article = normalize_article(pair.ref_item.get("article")) if pair.ref_item else ""
    result_article = normalize_article(pair.result_item.get("article")) if pair.result_item else ""
    status = field_status(bool(ref_article), bool(result_article), ref_article == result_article)
    return status, ref_article, result_article


def compare_name(pair: RowPair) -> tuple[str, str, str]:
    ref_name = pair.ref_item.get("name", "") if pair.ref_item else ""
    result_name = pair.result_item.get("name", "") if pair.result_item else ""
    sim = name_similarity(ref_name, result_name)
    status = field_status(bool(normalize_text(ref_name)), bool(normalize_text(result_name)), sim >= 0.80)
    return status, f"{sim:.3f}", ""


def compare_unit_price(pair: RowPair) -> tuple[str, str, str]:
    ref_price = decimal_from(pair.ref_item.get("price_with_vat")) if pair.ref_item else None
    result_price = decimal_from(pair.result_item.get("price")) if pair.result_item else None
    if ref_price is None:
        status = "MISSING_REF"
    elif result_price is None:
        status = "MISSING_RESULT"
    else:
        status = "NOT_APPLICABLE"
    return status, format_decimal(ref_price, 2), format_decimal(result_price, 2)


def result_amount_invariant(pair: RowPair) -> tuple[str, str, str]:
    result = pair.result_item
    if not result:
        return "MISSING_RESULT", "", ""

    qty = parse_result_quantity(result)
    price = decimal_from(result.get("price"))
    amount = decimal_from(result.get("amount"))
    if qty is None or price is None or amount is None:
        return "MISSING_RESULT", "", format_decimal(amount, 2)

    expected = round_money(qty * price)
    actual = round_money(amount)
    status = "OK" if abs(expected - actual) <= Decimal("0.01") else "FAIL"
    return status, format_decimal(expected, 2), format_decimal(actual, 2)


def compare_row(pair: RowPair, split_merge_ref_indexes: set[int]) -> RowComparison:
    statuses: dict[str, str] = {}
    values: dict[str, tuple[str, str]] = {}
    notes: list[str] = []

    if pair.kind == "matched":
        statuses["row_presence"] = "OK"
    elif pair.kind == "missing_result":
        statuses["row_presence"] = "MISSING_RESULT"
    else:
        statuses["row_presence"] = "MISSING_REF"
    values["row_presence"] = (
        str(pair.ref_index) if pair.ref_index is not None else "",
        str(pair.result_index) if pair.result_index is not None else "",
    )

    for field_name, compare in (
        ("name", compare_name),
        ("article", compare_article),
        ("unit_price_with_vat", compare_unit_price),
        ("quantity_number", compare_quantity),
        ("unit", compare_unit),
    ):
        status, ref_value, result_value = compare(pair)
        statuses[field_name] = status
        values[field_name] = (ref_value, result_value)

    statuses["line_amount"] = "MISSING_REF"
    result_amount = decimal_from(pair.result_item.get("amount")) if pair.result_item else None
    values["line_amount"] = ("", format_decimal(result_amount, 2))

    invariant_status, expected_amount, actual_amount = result_amount_invariant(pair)
    statuses["result_line_amount_invariant"] = invariant_status
    values["result_line_amount_invariant"] = (expected_amount, actual_amount)

    if pair.ref_index in split_merge_ref_indexes:
        pair.split_merge_cluster = True
        for field_name in ("unit_price_with_vat", "quantity_number", "unit"):
            statuses[field_name] = "NOT_APPLICABLE"
        notes.append("split/merge cluster candidate; row financial fields are not standalone verdicts")

    if pair.low_confidence:
        notes.append("low-confidence positional row match")

    return RowComparison(pair=pair, statuses=statuses, values=values, notes=notes)


def integrity_warnings(ref: dict[str, Any], ref_items: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    position_count = ref.get("position_count")
    if position_count is not None and position_count != len(ref_items):
        warnings.append(
            f"benchmark position_count={position_count} differs from items.length={len(ref_items)}; using items.length"
        )

    schemas = set()
    for item in ref_items:
        has_unit = bool(normalize_text(item.get("unit"))) if "unit" in item else False
        schemas.add("v2" if has_unit else "v1")
    if len(schemas) > 1:
        warnings.append("mixed benchmark quantity schemas detected in document")

    for array_index, item in enumerate(ref_items):
        item_index = item.get("item_index")
        if item_index is not None and item_index != array_index:
            warnings.append(
                f"benchmark item_index={item_index} differs from array index={array_index}; using array order"
            )
            break
    return warnings


def build_document_report(
    split: str,
    path: Path,
    ref: dict[str, Any],
    gemini_data: dict[str, Any],
    legacy_scorer: ModuleType,
    result_by_filename: dict[str, dict[str, Any]] | None = None,
) -> DocumentReport:
    source_invoice = ref.get("source_invoice", "")
    supplier = ref.get("supplier") or path.stem
    ref_items = ref.get("items", [])
    warnings = integrity_warnings(ref, ref_items)

    if result_by_filename is None:
        result_by_filename = build_result_filename_index(gemini_data)

    exact_result = find_exact_result(gemini_data, result_by_filename, source_invoice)
    legacy_items = legacy_scorer.find_gemini_result(gemini_data, source_invoice)
    legacy_score = legacy_scorer.score_document(ref_items, legacy_items) if legacy_items is not None else None

    if exact_result is None:
        row_pairs = [
            RowPair(
                kind="missing_result",
                ref_index=index,
                result_index=None,
                ref_item=item,
                result_item=None,
                match_method="none",
            )
            for index, item in enumerate(ref_items)
        ]
        rows = [compare_row(pair, set()) for pair in row_pairs]
        return DocumentReport(
            split=split,
            benchmark_path=path,
            supplier=supplier,
            source_invoice=source_invoice,
            ref_count=len(ref_items),
            result_count=None,
            row_count_status="MISSING_RESULT",
            legacy_score=legacy_score,
            exact_result_found=False,
            rows=rows,
            warnings=warnings,
        )

    result_items = exact_result.get("items", []) if isinstance(exact_result, dict) else []
    row_count_status = "OK" if len(ref_items) == len(result_items) else "FAIL"
    split_merge_clusters = find_split_merge_clusters(ref_items, result_items)
    split_merge_ref_indexes = {
        index
        for cluster in split_merge_clusters
        for index in cluster["ref_indexes"]
    }
    row_pairs = build_row_pairs(ref_items, result_items)
    rows = [compare_row(pair, split_merge_ref_indexes) for pair in row_pairs]

    row_matching_issues: list[dict[str, Any]] = []
    if row_count_status == "FAIL":
        row_matching_issues.append(
            {
                "kind": "row_count",
                "ref_index": "",
                "result_index": "",
                "method": "document",
                "similarity": "",
                "reason": f"row count differs: ref={len(ref_items)}, result={len(result_items)}",
            }
        )
    for row in rows:
        pair = row.pair
        if pair.low_confidence:
            row_matching_issues.append(
                {
                    "kind": "low_confidence",
                    "ref_index": pair.ref_index,
                    "result_index": pair.result_index,
                    "method": pair.match_method,
                    "similarity": pair.name_similarity,
                    "reason": "positional match name similarity below 0.75",
                }
            )
        if pair.kind in {"missing_result", "extra_result"}:
            row_matching_issues.append(
                {
                    "kind": pair.kind,
                    "ref_index": pair.ref_index if pair.ref_index is not None else "",
                    "result_index": pair.result_index if pair.result_index is not None else "",
                    "method": pair.match_method,
                    "similarity": "",
                    "reason": "unpaired benchmark/result row",
                }
            )
    for cluster in split_merge_clusters:
        row_matching_issues.append(
            {
                "kind": "split_merge_candidate",
                "ref_index": f"{cluster['ref_indexes'][0]},{cluster['ref_indexes'][1]}",
                "result_index": cluster["result_index"],
                "method": "reverse split/merge",
                "similarity": cluster["name_similarity"],
                "reason": "2 adjacent benchmark rows can map to one result row",
            }
        )

    return DocumentReport(
        split=split,
        benchmark_path=path,
        supplier=supplier,
        source_invoice=source_invoice,
        ref_count=len(ref_items),
        result_count=len(result_items),
        row_count_status=row_count_status,
        legacy_score=legacy_score,
        exact_result_found=True,
        rows=rows,
        warnings=warnings,
        row_matching_issues=row_matching_issues,
        split_merge_clusters=split_merge_clusters,
    )


def document_field_counts(document: DocumentReport) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    counts["row_count"] = status_counts([document.row_count_status])
    counts["document_total"] = status_counts(["NOT_APPLICABLE"])
    counts["vat_rate"] = status_counts(["NOT_APPLICABLE"])
    counts["vat_amount"] = status_counts(["NOT_APPLICABLE"])
    for field_name in ROW_FIELDS:
        counts[field_name] = status_counts([row.statuses[field_name] for row in document.rows])
    return counts


def aggregate_counts(documents: list[DocumentReport]) -> dict[str, dict[str, int]]:
    aggregate: dict[str, Counter[str]] = defaultdict(Counter)
    for document in documents:
        for field_name, counts in document_field_counts(document).items():
            aggregate[field_name].update(counts)
    return {
        field_name: {status: counts.get(status, 0) for status in STATUS_ORDER}
        for field_name, counts in aggregate.items()
    }


def field_count_fragment(counts: dict[str, int]) -> str:
    return ", ".join(f"{status}={counts.get(status, 0)}" for status in STATUS_ORDER if counts.get(status, 0))


def collect_financial_risks(documents: list[DocumentReport]) -> list[dict[str, Any]]:
    risks: list[dict[str, Any]] = []
    for document in documents:
        legacy = document.legacy_score or {}
        legacy_price = legacy.get("price_ok_pct")
        if legacy_price is not None and legacy_price < 0.80:
            risks.append(
                {
                    "severity": 95,
                    "split": document.split,
                    "supplier": document.supplier,
                    "row": "doc",
                    "field": "legacy_price_signal",
                    "status": "FAIL",
                    "ref": "",
                    "result": pct(legacy_price),
                    "why": "legacy compatibility signal below 80%; not a field-level financial gate",
                }
            )

        if document.row_count_status != "OK":
            risks.append(
                {
                    "severity": 90,
                    "split": document.split,
                    "supplier": document.supplier,
                    "row": "doc",
                    "field": "row_count",
                    "status": document.row_count_status,
                    "ref": document.ref_count,
                    "result": document.result_count if document.result_count is not None else "",
                    "why": "row mismatch can corrupt all row-level financial conclusions",
                }
            )

        if document.row_matching_issues:
            risks.append(
                {
                    "severity": 85,
                    "split": document.split,
                    "supplier": document.supplier,
                    "row": "doc",
                    "field": "row_matching",
                    "status": "FAIL",
                    "ref": len(document.row_matching_issues),
                    "result": "",
                    "why": "likely row-matching issue present",
                }
            )

        for row in document.rows:
            row_label = row.pair.ref_index if row.pair.ref_index is not None else f"result:{row.pair.result_index}"
            for field_name, severity in (
                ("quantity_number", 80),
                ("unit", 70),
                ("result_line_amount_invariant", 60),
            ):
                status = row.statuses[field_name]
                if status not in {"FAIL", "MISSING_RESULT"}:
                    continue
                ref_value, result_value = row.values[field_name]
                risks.append(
                    {
                        "severity": severity,
                        "split": document.split,
                        "supplier": document.supplier,
                        "row": row_label,
                        "field": field_name,
                        "status": status,
                        "ref": ref_value,
                        "result": result_value,
                        "why": "field can change budget math or result arithmetic",
                    }
                )

    return sorted(
        risks,
        key=lambda item: (
            -item["severity"],
            item["split"],
            str(item["supplier"]),
            str(item["row"]),
            item["field"],
        ),
    )


def count_statuses(document: DocumentReport, field_name: str, statuses: set[str]) -> int:
    return sum(1 for row in document.rows if row.statuses.get(field_name) in statuses)


def find_known_problem_document(documents: list[DocumentReport], spec: dict[str, Any]) -> DocumentReport | None:
    source_invoice = normalize_text(spec.get("source_invoice"))
    if source_invoice:
        by_source = next(
            (doc for doc in documents if normalize_text(doc.source_invoice) == source_invoice),
            None,
        )
        if by_source is not None:
            return by_source

    aliases = [normalize_text(alias) for alias in spec.get("supplier_aliases", ())]
    for alias in aliases:
        by_supplier = next((doc for doc in documents if normalize_text(doc.supplier) == alias), None)
        if by_supplier is not None:
            return by_supplier
    return None


def known_problem_entries(documents: list[DocumentReport]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    for known_spec in KNOWN_PROBLEM_DOCUMENTS:
        title = known_spec["title"]
        document = find_known_problem_document(documents, known_spec)
        if document is None:
            entries.append(
                {
                    "severity": 999,
                    "title": title,
                    "kind": "document",
                    "split": "n/a",
                    "source": known_spec.get("source_invoice", "n/a"),
                    "label": "РИСК ЭТАЛОНА",
                    "evidence": [
                        "Документ не найден в текущем JSON boundary (train/holdout).",
                    ],
                    "next_action": "Проверить source_invoice и включение документа в benchmark-ready train/holdout.",
                }
            )
            continue

        legacy_price = None
        if document.legacy_score is not None:
            legacy_price = document.legacy_score.get("price_ok_pct")
        row_issue_count = len(document.row_matching_issues)
        qty_fail = count_statuses(document, "quantity_number", {"FAIL", "MISSING_RESULT"})
        unit_fail = count_statuses(document, "unit", {"FAIL", "MISSING_RESULT"})
        amount_fail = count_statuses(document, "result_line_amount_invariant", {"FAIL", "MISSING_RESULT"})
        line_missing_ref = count_statuses(document, "line_amount", {"MISSING_REF"})

        evidence: list[str] = []
        label = "РИСК НАБЛЮДЕНИЯ"
        severity = 0
        next_action = "Проверить документ вручную и уточнить точечную причину финансового расхождения."
        has_ocr_risk = False

        if row_issue_count:
            has_ocr_risk = True
            severity += 120 + row_issue_count * 10
            evidence.append(f"Сопоставление строк: {row_issue_count} issue(s), выводы по финансовым полям частично низкой надёжности.")
            next_action = "Сначала исправить/подтвердить row matching для проблемных строк, потом переоценить quantity/unit/amount."
        if qty_fail or unit_fail:
            has_ocr_risk = True
            severity += qty_fail * 20 + unit_fail * 18
            evidence.append(
                f"Field FAIL/MISSING_RESULT: quantity={qty_fail}, unit={unit_fail} (конкретный финансовый риск по строкам)."
            )
            if normalize_text(document.supplier) in {
                normalize_text("САНТЕХПРОМ"),
                normalize_text("ООО САНТЕХПРОМ"),
            }:
                next_action = "Проверить field-level quantity/unit по строкам и подтвердить, что риск не скрыт средним score."
        if amount_fail:
            has_ocr_risk = True
            severity += amount_fail * 8
            evidence.append(f"Result amount invariant FAIL/MISSING_RESULT: {amount_fail} строк(и).")
        if legacy_price is not None:
            evidence.append(f"Legacy price signal: {pct(legacy_price)} (compatibility signal, не field-level gate).")
            if legacy_price < 0.95:
                has_ocr_risk = True
                severity += int((0.95 - legacy_price) * 100)
        if line_missing_ref:
            evidence.append(
                f"line_amount: MISSING_REF={line_missing_ref} => РИСК ЭТАЛОНА, это пробел reference данных, не ошибка OCR."
            )
            if not has_ocr_risk:
                severity += 60
                next_action = "Дополнить benchmark явным line_amount для строк документа, затем пересчитать field-level риск."

        if has_ocr_risk:
            label = "OCR РИСК"

        if not evidence:
            evidence.append("Явных FAIL по текущему boundary нет; документ удерживается как known problem для регрессионного контроля.")
            severity = 20
            label = "РИСК НАБЛЮДЕНИЯ"
            next_action = "Оставить в регрессионном наборе и сверить поведение с legacy baseline."

        entries.append(
            {
                "severity": severity,
                "title": document.supplier,
                "kind": "document",
                "split": document.split,
                "source": document.source_invoice,
                "label": label,
                "evidence": evidence,
                "next_action": next_action,
            }
        )

    entries.append(
        {
            "severity": 70,
            "title": "Category C / scanned PDFs",
            "kind": "group",
            "split": "legacy",
            "source": "legacy baseline list",
            "label": "РИСК ЭТАЛОНА",
            "evidence": [
                "Эта группа выводится отдельно и не смешивается со средними по обычным train/holdout PDF/XLS/XLSX.",
                "Текущий JSON boundary не включает category_c_list.json, поэтому пересчёт не выполняется в этом отчёте.",
                f"Legacy scan file: {CATEGORY_C_SCANS[0]}",
                f"Legacy scan file: {CATEGORY_C_SCANS[1]}",
                f"Legacy scan file: {CATEGORY_C_SCANS[2]}",
            ],
            "next_action": "Добавить отдельный scoped прогон для category C и сравнивать его метрики отдельно от обычных документов.",
        }
    )

    return sorted(entries, key=lambda item: -item["severity"])


def document_problem_score(document: DocumentReport) -> int:
    score = 0
    if document.row_count_status != "OK":
        score += 40
    score += len(document.row_matching_issues) * 50
    for row in document.rows:
        if row.statuses["quantity_number"] in {"FAIL", "MISSING_RESULT"}:
            score += 10
        if row.statuses["unit"] in {"FAIL", "MISSING_RESULT"}:
            score += 8
        if row.statuses["result_line_amount_invariant"] in {"FAIL", "MISSING_RESULT"}:
            score += 4
        if row.statuses["name"] == "FAIL":
            score += 1
    return score


def render_report_to(
    output: TextIO,
    documents: list[DocumentReport],
    selected_set: str,
    full_row_details: bool = False,
    max_row_detail_docs: int = 6,
) -> None:
    class _LineWriter:
        def append(self, text: str) -> None:
            output.write(text)

        def extend(self, items: list[str]) -> None:
            for item in items:
                output.write(item)

    lines = _LineWriter()
    lines.append("# Field-Level OCR Benchmark Report\n\n")
    lines.append("Generated from existing JSON only. No external OCR/LLM/API calls are made by this report script.\n\n")
    lines.append("## Source Boundary\n\n")
    lines.append("- Benchmark train: `scripts/benchmark-ready/train/`\n")
    lines.append("- Benchmark holdout: `scripts/benchmark-ready/holdout/`\n")
    lines.append("- OCR results: `scripts/ocr-benchmark/results/gemini_results.json`\n")
    lines.append("- Output: `scripts/ocr-benchmark/results/field_quality_report.md`\n")
    lines.append("- Parser, production API, routes, UI, frontend, and database files are not read for metrics and not changed.\n")
    lines.append("- Category C legacy files are not recalculated in Phase 2 because they are outside the current JSON boundary.\n\n")

    matched = sum(1 for document in documents if document.exact_result_found)
    lines.append("## Run Summary\n\n")
    lines.append(f"- Selected set: `{selected_set}`\n")
    lines.append(f"- Benchmark documents: {len(documents)}\n")
    lines.append(f"- Exact Gemini document matches: {matched}/{len(documents)}\n")
    lines.append("- Legacy metrics are shown as compatibility signals only; their scoring semantics are unchanged.\n")
    lines.append("- `document_total`, `vat_rate`, and `vat_amount` are `NOT_APPLICABLE` under the current contract.\n")
    lines.append("- Benchmark-vs-result `line_amount` is `MISSING_REF`; Gemini amount is shown only as a result invariant.\n\n")

    lines.append("## Legacy Compatibility Signals\n\n")
    lines.append("| Split | Supplier | Overall | Name | Price | Items ref/result | Field row count | Notes |\n")
    lines.append("|---|---|---:|---:|---:|---:|---|---|\n")
    for document in documents:
        legacy = document.legacy_score or {}
        item_counts = (
            f"{legacy.get('item_count_ref', document.ref_count)}/"
            f"{legacy.get('item_count_gemini', document.result_count if document.result_count is not None else 'N/A')}"
        )
        notes = "; ".join(document.warnings)
        lines.append(
            f"| {document.split} | {md_cell(document.supplier, 30)} | "
            f"{pct(legacy.get('overall_score'))} | {pct(legacy.get('name_ok_pct'))} | "
            f"{pct(legacy.get('price_ok_pct'))} | {item_counts} | "
            f"{document.row_count_status} | {md_cell(notes, 80)} |\n"
        )

    lines.append("\n## Field Status Summary By Split\n\n")
    for split in ("train", "holdout"):
        split_docs = [document for document in documents if document.split == split]
        if not split_docs:
            continue
        lines.append(f"### {split}\n\n")
        lines.append("| Field | OK | FAIL | MISSING_REF | MISSING_RESULT | NOT_APPLICABLE |\n")
        lines.append("|---|---:|---:|---:|---:|---:|\n")
        counts_by_field = aggregate_counts(split_docs)
        for field_name in DOC_FIELDS + ROW_FIELDS:
            counts = counts_by_field.get(field_name, {})
            lines.append(
                f"| {field_name} | {counts.get('OK', 0)} | {counts.get('FAIL', 0)} | "
                f"{counts.get('MISSING_REF', 0)} | {counts.get('MISSING_RESULT', 0)} | "
                f"{counts.get('NOT_APPLICABLE', 0)} |\n"
            )
        lines.append("\n")

    risks = collect_financial_risks(documents)
    lines.append("## Top Financial Risks\n\n")
    if risks:
        lines.append("| Split | Supplier | Row | Field | Status | Ref | Result | Why |\n")
        lines.append("|---|---|---:|---|---|---:|---:|---|\n")
        for risk in risks[:25]:
            lines.append(
                f"| {risk['split']} | {md_cell(risk['supplier'], 28)} | {md_cell(risk['row'])} | "
                f"{risk['field']} | {risk['status']} | {md_cell(risk['ref'], 25)} | "
                f"{md_cell(risk['result'], 25)} | {md_cell(risk['why'], 70)} |\n"
            )
    else:
        lines.append("No field-level financial risks detected in the current comparable fields.\n")
    lines.append("\n")

    lines.append("## Likely Row-Matching Issue\n\n")
    issues = [
        (document, issue)
        for document in documents
        for issue in document.row_matching_issues
    ]
    if issues:
        lines.append("| Split | Supplier | Ref row | Result row | Method | Similarity | Reason |\n")
        lines.append("|---|---|---:|---:|---|---:|---|\n")
        for document, issue in issues:
            lines.append(
                f"| {document.split} | {md_cell(document.supplier, 28)} | "
                f"{md_cell(issue['ref_index'])} | {md_cell(issue['result_index'])} | "
                f"{md_cell(issue['method'])} | {md_cell(issue['similarity'])} | "
                f"{md_cell(issue['reason'], 80)} |\n"
            )
    else:
        lines.append("No low-confidence positional matches, missing rows, extra rows, or split/merge candidates detected.\n")
    lines.append("\n")

    lines.append("## Known problem documents\n\n")
    known_entries = known_problem_entries(documents)
    max_known_problem_lines = 200
    known_problem_lines: list[str] = []
    for entry in known_entries:
        entry_lines = [
            f"### {entry['title']}\n\n",
            f"- Scope: `{entry['split']}`\n",
            f"- Source: `{md_cell(entry['source'])}`\n",
            f"- Type: **{entry['label']}**\n",
        ]
        for reason in entry["evidence"]:
            entry_lines.append(f"- Evidence: {md_cell(reason)}\n")
        entry_lines.append(f"- **Next action:** {md_cell(entry['next_action'], 140)}\n\n")

        if len(known_problem_lines) + len(entry_lines) > max_known_problem_lines:
            if len(known_problem_lines) < max_known_problem_lines:
                known_problem_lines.append("- ... truncated: limit reached for known problem section (max 200 lines).\n")
            break
        known_problem_lines.extend(entry_lines)
    lines.extend(known_problem_lines)

    lines.append("## Benchmark Gaps And Not Applicable Metrics\n\n")
    lines.append("| Metric | Contract status now | Reason |\n")
    lines.append("|---|---|---|\n")
    lines.append("| line_amount | MISSING_REF | Current benchmark items do not store explicit line amounts; Gemini amount is only a result invariant. |\n")
    lines.append("| document_total | NOT_APPLICABLE | Current `total_sum` is audit metadata, not a verified document-total reference. |\n")
    lines.append("| vat_rate | NOT_APPLICABLE | Current benchmark and Gemini JSON do not expose explicit VAT rate. |\n")
    lines.append("| vat_amount | NOT_APPLICABLE | Current benchmark and Gemini JSON do not expose explicit VAT amount. |\n")
    lines.append("| unit_price_with_vat | NOT_APPLICABLE when both values exist | Gemini `price` does not expose whether VAT is included. Missing operands still show `MISSING_REF` or `MISSING_RESULT`. |\n\n")

    lines.append("## Per-Document Field Summary\n\n")
    lines.append("| Split | Supplier | Row count | Quantity | Unit | Line amount | Result amount invariant | Row issues |\n")
    lines.append("|---|---|---|---|---|---|---|---:|\n")
    for document in documents:
        counts = document_field_counts(document)
        lines.append(
            f"| {document.split} | {md_cell(document.supplier, 30)} | "
            f"{document.row_count_status} ({document.ref_count}/{document.result_count if document.result_count is not None else 'N/A'}) | "
            f"{md_cell(field_count_fragment(counts['quantity_number']), 50)} | "
            f"{md_cell(field_count_fragment(counts['unit']), 50)} | "
            f"{md_cell(field_count_fragment(counts['line_amount']), 50)} | "
            f"{md_cell(field_count_fragment(counts['result_line_amount_invariant']), 50)} | "
            f"{len(document.row_matching_issues)} |\n"
        )
    lines.append("\n")

    lines.append("## Field-Level Row Details\n\n")
    problem_scores = {id(document): document_problem_score(document) for document in documents}
    sorted_documents = sorted(
        documents,
        key=lambda document: (
            -problem_scores[id(document)],
            document.split,
            normalize_text(document.supplier),
        ),
    )
    if full_row_details:
        row_detail_documents = sorted_documents
        lines.append("- Full mode: all documents are shown (`--full-row-details`).\n\n")
    else:
        max_docs = max(1, max_row_detail_docs)
        problematic = [document for document in sorted_documents if problem_scores[id(document)] > 0]
        if not problematic:
            problematic = sorted_documents
        row_detail_documents = problematic[:max_docs]
        omitted_docs = len(sorted_documents) - len(row_detail_documents)
        lines.append(
            f"- Compact mode: showing top {len(row_detail_documents)} problematic document(s) for fast triage at startup volume.\n"
        )
        if omitted_docs > 0:
            lines.append(
                f"- Omitted documents: {omitted_docs}. Use `--full-row-details` to output all documents when needed.\n"
            )
        lines.append("\n")

    for document in row_detail_documents:
        lines.append(f"### {document.split}: {md_cell(document.supplier)}\n\n")
        lines.append(f"- Source invoice: `{md_cell(document.source_invoice)}`\n")
        lines.append(f"- Benchmark file: `{document.benchmark_path.relative_to(PROJECT_ROOT).as_posix()}`\n")
        lines.append(f"- Document total metric: `NOT_APPLICABLE`; `total_sum` remains audit metadata.\n")
        lines.append(f"- VAT rate/amount metrics: `NOT_APPLICABLE`.\n")
        if document.warnings:
            for warning in document.warnings:
                lines.append(f"- Benchmark integrity warning: {md_cell(warning)}\n")
        lines.append("\n")
        lines.append("| Ref row | Result row | Match | Low confidence | Name | Article | Price with VAT | Qty | Unit | Line amount | Result amount invariant | Notes |\n")
        lines.append("|---:|---:|---|---|---|---|---|---|---|---|---|---|\n")
        for row in document.rows:
            pair = row.pair
            ref_row = pair.ref_index if pair.ref_index is not None else ""
            result_row = pair.result_index if pair.result_index is not None else ""
            notes = "; ".join(row.notes)
            line_amount_ref, line_amount_result = row.values["line_amount"]
            invariant_ref, invariant_result = row.values["result_line_amount_invariant"]
            lines.append(
                f"| {ref_row} | {result_row} | {pair.match_method} | "
                f"{'yes' if pair.low_confidence else 'no'} | "
                f"{row.statuses['name']} ({md_cell(row.values['name'][0])}) | "
                f"{row.statuses['article']} | "
                f"{row.statuses['unit_price_with_vat']} "
                f"({md_cell(row.values['unit_price_with_vat'][0])}/{md_cell(row.values['unit_price_with_vat'][1])}) | "
                f"{row.statuses['quantity_number']} "
                f"({md_cell(row.values['quantity_number'][0])}/{md_cell(row.values['quantity_number'][1])}) | "
                f"{row.statuses['unit']} "
                f"({md_cell(row.values['unit'][0])}/{md_cell(row.values['unit'][1])}) | "
                f"{row.statuses['line_amount']} "
                f"({md_cell(line_amount_ref)}/{md_cell(line_amount_result)}) | "
                f"{row.statuses['result_line_amount_invariant']} "
                f"({md_cell(invariant_ref)}/{md_cell(invariant_result)}) | "
                f"{md_cell(notes, 70)} |\n"
            )
        lines.append("\n")

    return None


def render_report(
    documents: list[DocumentReport],
    selected_set: str,
    full_row_details: bool = False,
    max_row_detail_docs: int = 6,
) -> list[str]:
    """
    Backward-compatible API for tests/tools that expect list[str].
    """
    buffer = io.StringIO()
    render_report_to(
        buffer,
        documents,
        selected_set,
        full_row_details=full_row_details,
        max_row_detail_docs=max_row_detail_docs,
    )
    return [buffer.getvalue()]


def main() -> int:
    args = parse_args()
    try:
        output_path = ensure_output_within_results_dir(args.output)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    with GEMINI_RESULTS_PATH.open(encoding="utf-8") as f:
        gemini_data = json.load(f)
    result_by_filename = build_result_filename_index(gemini_data)

    legacy_scorer = load_legacy_scorer()
    files = benchmark_files(args.set)
    if not files:
        print(f"No benchmark JSON files found for set={args.set}", file=sys.stderr)
        return 1

    documents: list[DocumentReport] = []
    for split, path in files:
        with path.open(encoding="utf-8") as f:
            ref = json.load(f)
        documents.append(
            build_document_report(
                split,
                path,
                ref,
                gemini_data,
                legacy_scorer,
                result_by_filename=result_by_filename,
            )
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output:
        render_report_to(
            output,
            documents,
            args.set,
            full_row_details=args.full_row_details,
            max_row_detail_docs=args.max_row_detail_docs,
        )

    exact_matches = sum(1 for document in documents if document.exact_result_found)
    risks = collect_financial_risks(documents)
    row_issues = sum(len(document.row_matching_issues) for document in documents)
    print(f"Field-level report: {output_path}")
    print(f"Documents: {len(documents)}; exact Gemini matches: {exact_matches}/{len(documents)}")
    print(f"Top financial risks: {len(risks)}; likely row-matching issues: {row_issues}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FileNotFoundError as exc:
        print(f"Missing required file: {exc.filename}", file=sys.stderr)
        raise SystemExit(2)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON: {exc}", file=sys.stderr)
        raise SystemExit(2)
