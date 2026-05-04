from __future__ import annotations

import importlib.util
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_GEMINI_PATH = PROJECT_ROOT / "scripts" / "ocr-benchmark" / "02_benchmark_gemini.py"


def load_benchmark_gemini():
    spec = importlib.util.spec_from_file_location("benchmark_gemini", BENCHMARK_GEMINI_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_vat_duplicate_normalizer_leaves_unrelated_gross_rows_unchanged():
    bench = load_benchmark_gemini()

    items = [
        {"article": "A1", "name": "Item 1", "price": 100, "amount": 1000},
        {"article": "A1", "name": "Item 1", "price": 120, "amount": 1200},
        {"article": "A2", "name": "Item 2", "price": 200, "amount": 2000},
        {"article": "A2", "name": "Item 2", "price": 240, "amount": 2400},
        {"article": "A3", "name": "Item 3", "price": 300, "amount": 3000},
        {"article": "A3", "name": "Item 3", "price": 360, "amount": 3600},
        {"article": "B1", "name": "Already gross unrelated", "price": 50, "amount": 500},
    ]

    normalized = bench.normalize_vat_duplicates(items)

    assert [item["article"] for item in normalized] == ["A1", "A2", "A3", "B1"]
    assert [item["price"] for item in normalized] == [120.0, 240.0, 360.0, 50]
    assert [item["amount"] for item in normalized] == [1200.0, 2400.0, 3600.0, 500]


def test_normalize_items_converts_currency_strings_to_numbers():
    bench = load_benchmark_gemini()

    normalized = bench.normalize_items(
        [
            {"name": "Valve DN20", "quantity": "2 шт", "price": "1 200 руб.", "amount": "2 400,50 руб."},
            {"name": "Pipe DN20", "quantity": True, "price": "not a number"},
        ]
    )

    assert normalized[0]["quantity"] == 2.0
    assert normalized[0]["price"] == 1200.0
    assert normalized[0]["amount"] == 2400.5
    assert normalized[1]["quantity"] is None
    assert normalized[1]["price"] is None


def test_pdf_document_is_closed_when_rendering_fails(monkeypatch):
    bench = load_benchmark_gemini()

    class FakeDoc:
        closed = False

        def __len__(self):
            return 1

        def __getitem__(self, _index):
            return object()

        def close(self):
            self.closed = True

    fake_doc = FakeDoc()
    monkeypatch.setattr(bench.fitz, "open", lambda _path: fake_doc)
    monkeypatch.setattr(
        bench,
        "render_page_as_jpeg",
        lambda _page: (_ for _ in ()).throw(RuntimeError("render failed")),
    )

    result = bench.ocr_pdf_with_gemini(client=object(), pdf_path="fake.pdf")

    assert result["error"] == "render failed"
    assert fake_doc.closed is True
