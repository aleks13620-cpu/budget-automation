"""
Pre-deploy regression check for the global invoice parser.

The fix under review changes the GLOBAL extractor (scripts/extract_invoice_table.py),
which every supplier flows through. Before deploying we must prove on REAL invoices
that recognition for OTHER suppliers did not get worse.

This tool runs TWO versions of the extractor on a set of PDFs and shows the delta:
  * NEW = the extractor in the current working copy (the branch with the fix).
  * OLD = the extractor as committed on origin/main (the currently-deployed code),
          materialised via `git show origin/main:scripts/extract_invoice_table.py`
          into a temp file (the working copy is NEVER overwritten).

Each extractor is run in an ISOLATED subprocess (exactly the production invocation
path: `python -X utf8 <extractor> <pdf>` -> JSON on stdout), so there is no module
import / global-state collision between the two versions.

Per invoice we compare:
  * item count
  * sum of line amounts        (printed as "sumAmount")
  * metadata.totalAmount       (printed as "total")
  * per-row unit price list (amount/qty), matched within +/-0.02 tolerance

Verdict per invoice:
  SAME       -> OLD and NEW agree on items, total, sum-of-amounts, and every unit price.
  CHANGED    -> any of the above differs. A human decides whether the change is better
               or worse (for the РОВЕН fix this is the EXPECTED, desired signal).
  ERROR      -> one or both extractors failed to run on that file.

Usage:
  python scripts/compare_parser_old_vs_new.py <dir-or-pdf> [<dir-or-pdf> ...] [--json out.json]
  python scripts/compare_parser_old_vs_new.py backend/tests/fixtures
  python scripts/compare_parser_old_vs_new.py a.pdf b.pdf --json report.json

Notes:
  * No supplier names / column indices are hardcoded — the comparison is purely
    structural (counts, sums, the amount/qty identity).
  * Output is Windows-cp1251 safe: no Unicode currency / Sigma glyphs are written to
    stdout (we print "sum"/"rub" instead) so it does not crash a cp1251 console.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

# Per-unit-price comparison tolerance (rounding noise between the two parsers).
UNIT_PRICE_TOL = 0.02
# Tolerance for comparing aggregate sums / totals between OLD and NEW.
AMOUNT_TOL = 0.02

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
EXTRACTOR_REL = 'scripts/extract_invoice_table.py'
NEW_EXTRACTOR = os.path.join(REPO_ROOT, 'scripts', 'extract_invoice_table.py')
# OLD = the deployed code on origin/main. Override the ref via --old-ref if origin/main
# is not the deployed baseline on a given machine.
DEFAULT_OLD_REF = 'origin/main'


def _eprint(*args):
    print(*args, file=sys.stderr)


def materialise_old_extractor(ref, dest_dir):
    """Write the extractor as committed at <ref> into a temp file and return its path.

    Uses `git show <ref>:scripts/extract_invoice_table.py`. The working copy of the
    extractor is never touched. Returns None (and logs) if the ref/file is unavailable.
    """
    target = f'{ref}:{EXTRACTOR_REL}'
    try:
        out = subprocess.run(
            ['git', 'show', target],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        _eprint('[error] git not found on PATH — cannot materialise OLD extractor.')
        return None
    if out.returncode != 0:
        err = out.stderr.decode('utf-8', 'replace').strip()
        _eprint(f'[error] `git show {target}` failed: {err}')
        # Help the operator find the right ref.
        rp = subprocess.run(['git', 'rev-parse', ref], cwd=REPO_ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if rp.returncode == 0:
            _eprint(f'[hint] {ref} resolves to {rp.stdout.decode().strip()}, '
                    f'but the file path may differ at that ref.')
        else:
            _eprint(f'[hint] `git rev-parse {ref}` also failed — the ref does not '
                    f'exist in this checkout. Run `git fetch` first, or pass '
                    f'--old-ref <branch-or-sha>.')
        return None
    dest = os.path.join(dest_dir, 'extract_invoice_table_OLD.py')
    with open(dest, 'wb') as f:
        f.write(out.stdout)
    return dest


def run_extractor(extractor_path, pdf_path):
    """Run one extractor in an isolated subprocess and return (parsed_json, error_str).

    Mirrors the production call: `python -X utf8 <extractor> <pdf>` with JSON on stdout.
    error_str is None on success, otherwise a short reason.
    """
    try:
        proc = subprocess.run(
            [sys.executable, '-X', 'utf8', extractor_path, pdf_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return None, 'timeout(>300s)'
    except Exception as exc:  # pragma: no cover - defensive
        return None, f'spawn-failed: {exc}'
    if proc.returncode != 0:
        tail = proc.stderr.decode('utf-8', 'replace').strip().splitlines()
        reason = tail[-1] if tail else f'exit {proc.returncode}'
        return None, f'exit {proc.returncode}: {reason}'
    raw = proc.stdout.decode('utf-8', 'replace')
    try:
        return json.loads(raw), None
    except json.JSONDecodeError as exc:
        return None, f'bad-json: {exc}'


def summarise(result):
    """Reduce an extractor's JSON into the comparable fields.

    Returns dict: items, sum_amount, total_amount, unit_prices (sorted list of
    amount/qty per row, rounded). Robust to missing/None fields.
    """
    items = result.get('items') or []
    sum_amount = 0.0
    unit_prices = []
    for it in items:
        amt = it.get('amount')
        if isinstance(amt, (int, float)):
            sum_amount += amt
        qty = it.get('quantity')
        if isinstance(amt, (int, float)) and isinstance(qty, (int, float)) and qty:
            unit_prices.append(round(amt / qty, 2))
    meta = result.get('metadata') or {}
    total = meta.get('totalAmount')
    return {
        'items': len(items),
        'sum_amount': round(sum_amount, 2),
        'total_amount': round(total, 2) if isinstance(total, (int, float)) else None,
        # Sorted so a pure row-order difference is not flagged; we compare the
        # MULTISET of unit prices, which is what matters for downstream matching.
        'unit_prices': sorted(unit_prices),
    }


def _num_close(a, b, tol):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return abs(a - b) <= tol


def _price_lists_close(old_list, new_list, tol):
    """Compare two sorted unit-price multisets within tolerance (greedy match)."""
    if len(old_list) != len(new_list):
        return False
    for a, b in zip(old_list, new_list):
        if abs(a - b) > tol:
            return False
    return True


def compare_one(old_sum, new_sum):
    """Return (verdict, diffs) for one invoice. diffs is a list of short reason strings."""
    diffs = []
    if old_sum['items'] != new_sum['items']:
        diffs.append(f"items {old_sum['items']}->{new_sum['items']}")
    if not _num_close(old_sum['total_amount'], new_sum['total_amount'], AMOUNT_TOL):
        diffs.append(f"total {old_sum['total_amount']}->{new_sum['total_amount']}")
    if not _num_close(old_sum['sum_amount'], new_sum['sum_amount'], AMOUNT_TOL):
        diffs.append(f"sumAmount {old_sum['sum_amount']}->{new_sum['sum_amount']}")
    if not _price_lists_close(old_sum['unit_prices'], new_sum['unit_prices'], UNIT_PRICE_TOL):
        diffs.append('unitPrices differ')
    verdict = 'SAME' if not diffs else 'CHANGED'
    return verdict, diffs


def collect_pdfs(paths):
    """Expand the CLI args (files and/or directories) into a sorted, de-duplicated
    list of PDF paths. Directories are walked recursively. Case-insensitive on the
    .pdf extension (some suppliers ship UPPERCASE .PDF). Uses os.walk so mojibake
    filenames that cannot be typed on a shell are still picked up."""
    found = set()
    for p in paths:
        if os.path.isdir(p):
            for root, _dirs, files in os.walk(p):
                for fn in files:
                    if fn.lower().endswith('.pdf'):
                        found.add(os.path.join(root, fn))
        elif os.path.isfile(p):
            if p.lower().endswith('.pdf'):
                found.add(p)
            else:
                _eprint(f'[warn] skipping non-pdf file: {p}')
        else:
            _eprint(f'[warn] path not found: {p}')
    return sorted(found)


def _short_name(path, base_len):
    """A compact, display-safe name for the table. Non-encodable chars (mojibake
    filenames on a cp1251 console) are replaced so printing never crashes."""
    name = os.path.basename(path)
    if len(name) > base_len:
        name = name[: base_len - 3] + '...'
    enc = sys.stdout.encoding or 'utf-8'
    try:
        name.encode(enc)
    except (UnicodeEncodeError, LookupError):
        name = name.encode(enc, 'replace').decode(enc, 'replace')
    return name


def _fmt_num(v):
    return '-' if v is None else f'{v:.2f}'


def print_table(rows):
    """rows: list of dicts with keys file, old, new, verdict, error."""
    name_w = 34
    header = (
        f"{'file':<{name_w}} | {'OLD_it':>6} | {'NEW_it':>6} | "
        f"{'OLD_total':>11} | {'NEW_total':>11} | "
        f"{'OLD_sum':>11} | {'NEW_sum':>11} | VERDICT"
    )
    print(header)
    print('-' * len(header))
    for r in rows:
        name = _short_name(r['file'], name_w)
        if r['error']:
            print(f"{name:<{name_w}} | {'?':>6} | {'?':>6} | "
                  f"{'?':>11} | {'?':>11} | {'?':>11} | {'?':>11} | "
                  f"ERROR ({r['error']})")
            continue
        o, n = r['old'], r['new']
        line = (
            f"{name:<{name_w}} | {o['items']:>6} | {n['items']:>6} | "
            f"{_fmt_num(o['total_amount']):>11} | {_fmt_num(n['total_amount']):>11} | "
            f"{_fmt_num(o['sum_amount']):>11} | {_fmt_num(n['sum_amount']):>11} | "
            f"{r['verdict']}"
        )
        print(line)
        if r['verdict'] == 'CHANGED' and r['diffs']:
            print(f"{'':<{name_w}} |   -> {'; '.join(r['diffs'])}")


def main():
    ap = argparse.ArgumentParser(
        description='Compare OLD (origin/main) vs NEW (working copy) invoice extractor '
                    'on a set of PDFs and report per-invoice deltas.')
    ap.add_argument('paths', nargs='+',
                    help='PDF files and/or directories (directories walked recursively).')
    ap.add_argument('--json', metavar='OUT', default=None,
                    help='write the full machine-readable report to this JSON file.')
    ap.add_argument('--old-ref', default=DEFAULT_OLD_REF,
                    help=f'git ref for the OLD/deployed extractor (default: {DEFAULT_OLD_REF}). '
                         f'On a server run `git fetch` first; pass e.g. --old-ref origin/main '
                         f'or a deployed commit SHA.')
    args = ap.parse_args()

    pdfs = collect_pdfs(args.paths)
    if not pdfs:
        _eprint('[error] no PDF files found in the given paths.')
        sys.exit(2)

    if not os.path.isfile(NEW_EXTRACTOR):
        _eprint(f'[error] NEW extractor not found: {NEW_EXTRACTOR}')
        sys.exit(2)

    with tempfile.TemporaryDirectory(prefix='parser_cmp_') as tmp:
        old_extractor = materialise_old_extractor(args.old_ref, tmp)
        if old_extractor is None:
            _eprint('[error] could not obtain the OLD extractor — aborting.')
            sys.exit(3)

        _eprint(f'[info] OLD extractor = {args.old_ref}:{EXTRACTOR_REL} '
                f'(materialised to temp)')
        _eprint(f'[info] NEW extractor = {NEW_EXTRACTOR} (working copy)')
        _eprint(f'[info] comparing {len(pdfs)} PDF(s)...')

        rows = []
        for pdf in pdfs:
            old_res, old_err = run_extractor(old_extractor, pdf)
            new_res, new_err = run_extractor(NEW_EXTRACTOR, pdf)
            if old_err or new_err:
                err = '; '.join(
                    s for s in (
                        f'OLD: {old_err}' if old_err else None,
                        f'NEW: {new_err}' if new_err else None,
                    ) if s)
                rows.append({'file': pdf, 'error': err, 'old': None, 'new': None,
                             'verdict': 'ERROR', 'diffs': []})
                continue
            old_sum = summarise(old_res)
            new_sum = summarise(new_res)
            verdict, diffs = compare_one(old_sum, new_sum)
            rows.append({'file': pdf, 'error': None, 'old': old_sum, 'new': new_sum,
                         'verdict': verdict, 'diffs': diffs})

    print()
    print_table(rows)

    same = [r for r in rows if r['verdict'] == 'SAME']
    changed = [r for r in rows if r['verdict'] == 'CHANGED']
    errored = [r for r in rows if r['verdict'] == 'ERROR']

    print()
    print('=' * 60)
    print(f'SUMMARY: {len(rows)} file(s) | SAME={len(same)} | '
          f'CHANGED={len(changed)} | ERROR={len(errored)}')
    if changed:
        print()
        print('CHANGED files (review these first — human decides better/worse):')
        for r in changed:
            print(f'  - {_short_name(r["file"], 80)}: {"; ".join(r["diffs"])}')
    if errored:
        print()
        print('ERROR files (one/both extractors failed):')
        for r in errored:
            print(f'  - {_short_name(r["file"], 80)}: {r["error"]}')
    if not changed and not errored:
        print('All files identical OLD vs NEW — fix did not alter these suppliers.')
    print('=' * 60)

    if args.json:
        payload = {
            'old_ref': args.old_ref,
            'new_extractor': NEW_EXTRACTOR,
            'tolerances': {'unit_price': UNIT_PRICE_TOL, 'amount': AMOUNT_TOL},
            'summary': {
                'total': len(rows),
                'same': len(same),
                'changed': len(changed),
                'error': len(errored),
                'changed_files': [r['file'] for r in changed],
                'error_files': [r['file'] for r in errored],
            },
            'results': rows,
        }
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        _eprint(f'[info] wrote JSON report -> {args.json}')

    # Exit code: 0 if nothing errored (CHANGED is an expected, non-failing signal —
    # it is for a human to judge, so it does NOT fail the run). 1 if any file errored.
    sys.exit(1 if errored else 0)


if __name__ == '__main__':
    main()
