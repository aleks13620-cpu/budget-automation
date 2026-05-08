from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
REPORT_SCRIPT_PATH = PROJECT_ROOT / "scripts" / "ocr-benchmark" / "04_field_quality_report.py"


def load_report_module():
    spec = importlib.util.spec_from_file_location("field_quality_report", REPORT_SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def build_report_text(module, *, full_row_details: bool, max_row_detail_docs: int = 6) -> tuple[str, list]:
    with module.GEMINI_RESULTS_PATH.open(encoding="utf-8") as f:
        gemini_data = json.load(f)

    legacy = module.load_legacy_scorer()
    documents = []
    for split, path in module.benchmark_files("all"):
        with path.open(encoding="utf-8") as f:
            ref = json.load(f)
        documents.append(module.build_document_report(split, path, ref, gemini_data, legacy))

    lines = module.render_report(
        documents,
        "all",
        full_row_details=full_row_details,
        max_row_detail_docs=max_row_detail_docs,
    )
    return "".join(lines), documents


def test_known_problem_section_has_required_blocks_and_next_action():
    mod = load_report_module()
    text, _ = build_report_text(mod, full_row_details=False)

    assert "## Known problem documents" in text
    assert "### Электротехмонтаж" in text
    assert "### САНТЕХПРОМ" in text
    assert "### Category C / scanned PDFs" in text

    assert text.count("**Next action:**") >= 3


def test_compact_mode_limits_row_details_and_shows_omitted_hint():
    mod = load_report_module()
    text, documents = build_report_text(mod, full_row_details=False, max_row_detail_docs=6)

    assert "Compact mode:" in text
    assert "Omitted documents:" in text

    tail = text.split("## Field-Level Row Details", 1)[1]
    doc_headers = re.findall(r"^### ", tail, flags=re.MULTILINE)
    assert len(doc_headers) <= min(6, len(documents))


def test_category_c_scan_ids_not_truncated():
    mod = load_report_module()
    text, _ = build_report_text(mod, full_row_details=False)

    for scan_name in mod.CATEGORY_C_SCANS:
        assert f"Legacy scan file: {scan_name}" in text

    for line in text.splitlines():
        if line.startswith("- Evidence: Legacy scan file:"):
            assert "..." not in line


def test_output_path_is_restricted_to_results_dir():
    mod = load_report_module()

    inside = mod.RESULTS_DIR / "safe-report.md"
    outside = mod.PROJECT_ROOT / "unsafe-report.md"

    assert mod.ensure_output_within_results_dir(inside) == inside.resolve()
    with pytest.raises(ValueError, match="--output must be inside"):
        mod.ensure_output_within_results_dir(outside)
