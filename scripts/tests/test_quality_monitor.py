from __future__ import annotations

import importlib.util
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
QUALITY_MONITOR_PATH = PROJECT_ROOT / "scripts" / "quality-monitor.py"


def load_quality_monitor():
    spec = importlib.util.spec_from_file_location("quality_monitor", QUALITY_MONITOR_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_zero_prices_fail_quality_gate(tmp_path, monkeypatch, capsys):
    monitor = load_quality_monitor()

    benchmark_root = tmp_path / "benchmark-ready"
    train_dir = benchmark_root / "train"
    holdout_dir = benchmark_root / "holdout"
    train_dir.mkdir(parents=True)
    holdout_dir.mkdir()

    benchmark_file = train_dir / "Fail Supplier_200_00.json"
    benchmark_file.write_text(
        json.dumps(
            {
                "source_invoice": "fail-supplier.pdf",
                "supplier": "Fail Supplier",
                "items": [
                    {"name": "Valve DN20", "price_with_vat": 100.0},
                    {"name": "Pipe DN20", "price_with_vat": 100.0},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    results_path = tmp_path / "gemini_results.json"
    results_path.write_text(
        json.dumps(
            {
                "fail-supplier.pdf": {
                    "items": [
                        {"name": "Valve DN20", "price": 0.0},
                        {"name": "Pipe DN20", "price": 0.0},
                    ]
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(monitor, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(monitor, "BENCHMARK_ROOT", benchmark_root)
    monkeypatch.setattr(monitor, "RESULTS_PATH", results_path)

    exit_code = monitor.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "| Fail Supplier | 70.0% | 100.0% | 0.0% | FAIL |" in output
    assert "[FAIL] Fail Supplier" in output
    assert "price failures: 2" in output


def test_warn_detail_includes_worst_items(tmp_path, monkeypatch, capsys):
    monitor = load_quality_monitor()

    benchmark_root = tmp_path / "benchmark-ready"
    train_dir = benchmark_root / "train"
    train_dir.mkdir(parents=True)
    (benchmark_root / "holdout").mkdir()

    good_items_ref = [
        {"name": f"Клапан шаровый DN{i}", "price_with_vat": 100.0} for i in range(1, 8)
    ]
    good_items_gem = [
        {"name": f"Клапан шаровый DN{i}", "price": 100.0} for i in range(1, 8)
    ]

    benchmark_file = train_dir / "Warn Supplier_300_00.json"
    benchmark_file.write_text(
        json.dumps(
            {
                "source_invoice": "warn-supplier.pdf",
                "supplier": "Warn Supplier",
                "items": good_items_ref + [{"name": "Фитинг 3/4", "price_with_vat": 100.0}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    results_path = tmp_path / "gemini_results.json"
    results_path.write_text(
        json.dumps(
            {
                "warn-supplier.pdf": {
                    "items": good_items_gem + [{"name": "Fitting 3/4", "price": 100.0}],
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(monitor, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(monitor, "BENCHMARK_ROOT", benchmark_root)
    monkeypatch.setattr(monitor, "RESULTS_PATH", results_path)

    exit_code = monitor.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "WARN" in output
    assert "[WARN] Warn Supplier" in output
    assert "worst items" in output


def test_missing_gemini_result_reports_fail_without_crashing(tmp_path, monkeypatch, capsys):
    monitor = load_quality_monitor()

    benchmark_root = tmp_path / "benchmark-ready"
    train_dir = benchmark_root / "train"
    train_dir.mkdir(parents=True)
    (benchmark_root / "holdout").mkdir()

    benchmark_file = train_dir / "Missing Supplier_100_00.json"
    benchmark_file.write_text(
        json.dumps(
            {
                "source_invoice": "missing-supplier.pdf",
                "supplier": "Missing Supplier",
                "items": [{"name": "Valve DN20", "price_with_vat": 100.0}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    results_path = tmp_path / "gemini_results.json"
    results_path.write_text("{}", encoding="utf-8")

    monkeypatch.setattr(monitor, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(monitor, "BENCHMARK_ROOT", benchmark_root)
    monkeypatch.setattr(monitor, "RESULTS_PATH", results_path)

    exit_code = monitor.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "| Missing Supplier | 0.0% | 0.0% | 0.0% | FAIL |" in output
    assert "reason:        Gemini result not found" in output
