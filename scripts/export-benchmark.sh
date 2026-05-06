#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/export-benchmark.sh PROJECT_ID [--db path/to/db]

Export project invoices from SQLite into benchmark-ready proposed JSON files.

Arguments:
  PROJECT_ID          Project id to export.

Options:
  --db PATH           SQLite database path (default: database/budget_automation.db).
  -h, --help          Show this help message.
EOF
}

die() {
  echo "Error: $*" >&2
  echo >&2
  usage >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$PROJECT_ROOT/database/budget_automation.db"
OUTPUT_DIR="$PROJECT_ROOT/scripts/benchmark-ready/proposed"
PROJECT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --db)
      [[ $# -ge 2 ]] || die "--db requires a path"
      DB_PATH="$2"
      shift 2
      ;;
    --db=*)
      DB_PATH="${1#--db=}"
      shift
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "$PROJECT_ID" ]] || die "PROJECT_ID was provided more than once"
      PROJECT_ID="$1"
      shift
      ;;
  esac
done

[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID is required"
[[ "$PROJECT_ID" =~ ^[1-9][0-9]*$ ]] || die "PROJECT_ID must be a positive integer"

mkdir -p "$OUTPUT_DIR"

python - "$PROJECT_ID" "$DB_PATH" "$OUTPUT_DIR" "$PROJECT_ROOT" <<'PY'
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import tempfile
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


project_id = int(sys.argv[1])
db_path = Path(sys.argv[2]).expanduser()
output_dir = Path(sys.argv[3])
project_root = Path(sys.argv[4])

if not db_path.is_absolute():
    db_path = Path.cwd() / db_path

if not db_path.exists():
    raise SystemExit(f"Database not found: {db_path}")


def clean_decimal(value: Any) -> str:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return str(value)

    normalized = number.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal("1")))
    return format(normalized, "f")


def money(value: Any) -> float | None:
    if value is None:
        return None
    return round(float(value), 2)


def decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def valid_quantity(row: sqlite3.Row) -> Decimal | None:
    quantity = decimal_or_none(row["quantity"])
    if quantity is None or quantity == 0:
        return None
    return quantity


def row_total(row: sqlite3.Row, amount_mode: str) -> Decimal | None:
    amount = decimal_or_none(row["amount"])
    price = decimal_or_none(row["price"])
    quantity = valid_quantity(row)

    if amount_mode == "line_total" and amount is not None:
        return amount
    if price is not None and quantity is not None:
        return price * quantity
    if amount_mode == "unit_price" and amount is not None and quantity is not None:
        return amount * quantity

    return None


def total_for_mode(item_rows: list[sqlite3.Row], amount_mode: str) -> Decimal | None:
    total = Decimal("0")
    has_total = False
    for row in item_rows:
        line_total = row_total(row, amount_mode)
        if line_total is not None:
            total += line_total
            has_total = True
    return total if has_total else None


def choose_amount_mode(item_rows: list[sqlite3.Row], invoice_total: Any) -> str:
    expected_total = decimal_or_none(invoice_total)
    if expected_total is None:
        return "unknown"

    candidates = [
        ("line_total", total_for_mode(item_rows, "line_total")),
        ("unit_price", total_for_mode(item_rows, "unit_price")),
    ]
    candidates = [(mode, total) for mode, total in candidates if total is not None]
    if not candidates:
        return "unknown"

    best_mode, best_total = min(
        candidates,
        key=lambda candidate: abs(candidate[1] - expected_total),
    )
    if abs(best_total - expected_total) <= Decimal("1.00"):
        return best_mode

    return "unknown"


def unit_price_with_vat(row: sqlite3.Row, amount_mode: str) -> float | None:
    price = money(row["price"])
    if price is not None:
        return price

    amount = decimal_or_none(row["amount"])
    if amount is None:
        return None

    if amount_mode == "unit_price":
        return round(float(amount), 2)

    quantity = valid_quantity(row)
    if amount_mode == "line_total" and quantity is not None:
        return round(float(amount / quantity), 2)

    return None


def quantity_text(quantity: Any, unit: Any) -> str:
    parts: list[str] = []
    if quantity is not None:
        parts.append(clean_decimal(quantity))
    if unit is not None and str(unit).strip():
        parts.append(str(unit).strip())
    return " ".join(parts)


def safe_slug(value: str, fallback: str) -> str:
    slug = value.lower()
    slug = re.sub(r"\.[a-z0-9]+$", "", slug)
    slug = re.sub(r"[^a-z0-9а-яё]+", "-", slug, flags=re.IGNORECASE)
    slug = slug.strip("-")
    return slug[:80] or fallback


def relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return str(path)


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        text=True,
    )
    temp_path = Path(temp_name)

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            json.dump(payload, temp_file, ensure_ascii=False, indent=2)
            temp_file.write("\n")
            temp_file.flush()
            os.fsync(temp_file.fileno())
        temp_path.replace(path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def computed_total(
    item_rows: list[sqlite3.Row],
    invoice_total: Any,
    amount_mode: str,
) -> float:
    total = total_for_mode(item_rows, amount_mode)
    if total is not None:
        return round(float(total), 2)
    if invoice_total is not None:
        return money(invoice_total) or 0.0
    return 0.0


with sqlite3.connect(db_path) as conn:
    conn.row_factory = sqlite3.Row

    invoices = conn.execute(
        """
        SELECT
          i.id,
          i.file_name,
          i.file_path,
          i.total_amount,
          COALESCE(NULLIF(TRIM(s.name), ''), 'Без поставщика') AS supplier
        FROM invoices i
        LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.project_id = ?
        ORDER BY i.id
        """,
        (project_id,),
    ).fetchall()

    if not invoices:
        print(f"No invoices found for project {project_id}.")
        raise SystemExit(0)

    exported: list[Path] = []
    skipped_empty: list[str] = []
    warnings: list[str] = []
    for invoice in invoices:
        item_rows = conn.execute(
            """
            SELECT
              id,
              row_index,
              name,
              article,
              price,
              quantity,
              unit,
              amount
            FROM invoice_items
            WHERE invoice_id = ?
              AND COALESCE(is_delivery, 0) = 0
            ORDER BY COALESCE(row_index, id), id
            """,
            (invoice["id"],),
        ).fetchall()

        source_invoice = invoice["file_name"] or Path(invoice["file_path"] or "").name
        source_invoice = source_invoice or f"invoice-{invoice['id']}"
        audit_file = source_invoice

        if not item_rows:
            skipped_empty.append(f"invoice_id={invoice['id']} {source_invoice}")
            continue

        amount_mode = choose_amount_mode(item_rows, invoice["total_amount"])
        items: list[dict[str, Any]] = []
        for index, row in enumerate(item_rows):
            price_with_vat = unit_price_with_vat(row, amount_mode)
            items.append(
                {
                    "item_index": index,
                    "name": row["name"] or "",
                    "article": row["article"] or "",
                    "price_with_vat": price_with_vat,
                    "quantity": quantity_text(row["quantity"], row["unit"]),
                }
            )

        null_price_count = sum(1 for item in items if item["price_with_vat"] is None)
        if null_price_count / len(items) > 0.05:
            warnings.append(
                f"{source_invoice}: {null_price_count}/{len(items)} "
                "items have price_with_vat=null"
            )

        payload = {
            "audit_file": audit_file,
            "source_invoice": source_invoice,
            "supplier": invoice["supplier"],
            "position_count": len(items),
            "total_sum": computed_total(
                item_rows,
                invoice["total_amount"],
                amount_mode,
            ),
            "items": items,
        }

        slug = safe_slug(source_invoice, f"invoice-{invoice['id']}")
        output_path = output_dir / f"project-{project_id}-invoice-{invoice['id']}-{slug}.json"
        write_json_atomic(output_path, payload)
        exported.append(output_path)

    if exported:
        print("Exported benchmark files:")
        for path in exported:
            print(f"- {relative(path)}")
    else:
        print("No benchmark files exported.")

    if warnings:
        print()
        print("Warnings:")
        for warning in warnings:
            print(f"- {warning}")

    if skipped_empty:
        print()
        print("Skipped empty invoices:")
        for skipped in skipped_empty:
            print(f"- {skipped}")
PY
