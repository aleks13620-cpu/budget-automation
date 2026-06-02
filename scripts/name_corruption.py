"""Broken-font name-corruption detector — PYTHON MIRROR.

Keep this in lock-step with backend/src/services/nameCorruption.ts (identical logic,
identical code points). Used by the regression gate (gate_name_corruption.py).

Signal = a "sandwich": a Latin letter or digit wedged BETWEEN two Cyrillic letters
inside one maximal alphanumeric run. Cyrillic х/Х (U+0445/U+0425) are NOT anchors
(they are used as the «×» dimension sign, e.g. Ду32х25). No hardcoded suppliers/words.
"""

NAME_CORRUPTION_RATIO_THRESHOLD = 0.5


def _is_digit(o): return 0x30 <= o <= 0x39
def _is_latin(o): return (0x41 <= o <= 0x5a) or (0x61 <= o <= 0x7a)
def _is_cyr(o): return 0x0400 <= o <= 0x04ff
def _is_cyr_anchor(o): return _is_cyr(o) and o != 0x0445 and o != 0x0425
def _is_run(o): return _is_digit(o) or _is_latin(o) or _is_cyr(o)


def is_name_corrupted(name):
    """Return (sandwich, lat_wedge) for a single item name."""
    sandwich = False
    lat_wedge = False
    if not name:
        return (sandwich, lat_wedge)
    n = len(name)
    i = 0
    while i < n:
        if not _is_run(ord(name[i])):
            i += 1
            continue
        j = i
        while j < n and _is_run(ord(name[j])):
            j += 1
        first = last = -1
        for k in range(i, j):
            if _is_cyr_anchor(ord(name[k])):
                if first == -1:
                    first = k
                last = k
        if first != -1 and last > first:
            for k in range(first + 1, last):
                o = ord(name[k])
                if _is_digit(o) or _is_latin(o):
                    sandwich = True
                    if _is_latin(o):
                        lat_wedge = True
        if sandwich and lat_wedge:
            break
        i = j
    return (sandwich, lat_wedge)


def analyze_name_corruption(names):
    """Aggregate over an invoice's item names."""
    total = len(names)
    if total == 0:
        return {"ratio": 0.0, "flaggedCount": 0, "total": 0, "latWedgeRows": []}
    flagged = 0
    lat_rows = []
    for idx, nm in enumerate(names):
        s, l = is_name_corrupted(str(nm))
        if s:
            flagged += 1
        if l:
            lat_rows.append(idx)
    return {"ratio": flagged / total, "flaggedCount": flagged,
            "total": total, "latWedgeRows": lat_rows}
