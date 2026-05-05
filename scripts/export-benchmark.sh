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
[[ "$PROJECT_ID" =~ ^[0-9]+$ ]] || die "PROJECT_ID must be a positive integer"

mkdir -p "$OUTPUT_DIR"

python - "$PROJECT_ID" "$DB_PATH" "$OUTPUT_DIR" "$PROJECT_ROOT" <<'PY'
from __future__ import annotations

import json
import re
import sqlite3
import sys
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


def computed_total(invoice_total: Any, item_rows: list[sqlite3.Row]) -> float:
    if invoice_total is not None:
        return money(invoice_total) or 0.0

    total = Decimal("0")
    for row in item_rows:
        if row["amount"] is not None:
            total += Decimal(str(row["amount"]))
        elif row["price"] is not None and row["quantity"] is not None:
            total += Decimal(str(row["price"])) * Decimal(str(row["quantity"]))
    return round(float(total), 2)


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
    for invoice in invoices:
        item_rows = conn.execute(
            """
            SELECT
              row_index,
              name,
              article,
              price,
              quantity,
              unit,
              amount
            FROM invoice_items
            WHERE invoice_id = ?
            ORDER BY COALESCE(row_index, id), id
            """,
            (invoice["id"],),
        ).fetchall()

        source_invoice = invoice["file_name"] or Path(invoice["file_path"] or "").name
        source_invoice = source_invoice or f"invoice-{invoice['id']}"
        audit_file = invoice["file_path"] or source_invoice

        items: list[dict[str, Any]] = []
        for index, row in enumerate(item_rows):
            price = money(row["price"])
            items.append(
                {
                    "item_index": index,
                    "name": row["name"] or "",
                    "article": row["article"] or "",
                    "price_with_vat": price if price is not None else 0.0,
                    "quantity": quantity_text(row["quantity"], row["unit"]),
                }
            )

        payload = {
            "audit_file": audit_file,
            "source_invoice": source_invoice,
            "supplier": invoice["supplier"],
            "position_count": len(items),
            "total_sum": computed_total(invoice["total_amount"], item_rows),
            "items": items,
        }

        slug = safe_slug(source_invoice, f"invoice-{invoice['id']}")
        output_path = output_dir / f"project-{project_id}-invoice-{invoice['id']}-{slug}.json"
        output_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        exported.append(output_path)

    print("Exported benchmark files:")
    for path in exported:
        print(f"- {relative(path)}")
PY
