"""Numeric provenance: every number the agent writes must trace back to a tool output.

The agent sees measurements only through tools. We collect every number in those tool results
(with its JSON path), then scan the agent's text for numbers and match each one, allowing for
rounding to the precision written, percent/fraction conversion, and rpm/Hz conversion.
Unmatched numbers are flagged in the UI. This does not prove reasoning is right, but it does make
fabricated or mis-copied figures visible.
"""

import math
import re

NUM = re.compile(r"(?<![\w.])[-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])[-−]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


class Ledger:
    def __init__(self):
        self.values: list[tuple[float, str]] = []

    def add(self, obj, path: str = ""):
        if isinstance(obj, bool) or obj is None:
            return
        if isinstance(obj, (int, float)):
            if math.isfinite(obj):
                self.values.append((float(obj), path or "value"))
        elif isinstance(obj, dict):
            for k, v in obj.items():
                self.add(v, f"{path}.{k}" if path else str(k))
        elif isinstance(obj, (list, tuple)):
            if len(obj) > 64 and all(isinstance(v, (int, float)) for v in obj[:64]):
                return  # long numeric arrays (spectra, curves) are not quoted by the agent
            for i, v in enumerate(obj):
                self.add(v, f"{path}[{i}]")
        elif isinstance(obj, str):
            for m in NUM.finditer(obj):  # numbers embedded in tool-provided strings (e.g. labels)
                self.values.append((_to_float(m.group()), path or "text"))

    def match(self, value: float, decimals: int) -> str | None:
        tol = 0.5 * 10 ** (-decimals) + 1e-9  # rounding to the precision the agent wrote
        cands = (value, value / 100, value * 100, value / 60, value * 60)  # %, fraction, rpm<->Hz
        for v, path in self.values:
            for c in cands:
                t = tol if c is value else max(tol, abs(c) * 0.005)
                if abs(v - c) <= t or (abs(v) > 1 and abs(v - c) / abs(v) < 0.002):
                    return path
        return None


def _to_float(s: str) -> float:
    return float(s.replace(",", "").replace("−", "-"))


def _trivial(text: str, start: int, end: int, value: float) -> bool:
    """Ordinals and labels that are not measurements: '1×', '2x', 'ISO 20816', 'zone B', list numbering."""
    after = text[end:end + 2]
    before = text[max(0, start - 5):start]
    if after[:1] in ("×", "x", "X") or after.startswith(" ×"):
        return True
    if "ISO" in before or "class" in text[max(0, start - 7):start].lower():
        return True
    if value in (0, 1) and not text[end:end + 1] == ".":
        return True
    return start > 0 and text[start - 1] in "#§" or (after[:1] == "." and text[end + 1:end + 2] == " " and value < 20
                                                       and (start == 0 or text[start - 1] == "\n"))


def check(text: str, ledger: Ledger) -> tuple[list[dict], dict]:
    claims = []
    for m in NUM.finditer(text or ""):
        raw = m.group()
        value = _to_float(raw)
        if _trivial(text, m.start(), m.end(), value):
            continue
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        src = ledger.match(value, decimals)
        claims.append({"start": m.start(), "end": m.end(), "value": value, "verified": src is not None, "source": src})
    v = sum(c["verified"] for c in claims)
    return claims, {"verified": v, "unverified": len(claims) - v}
