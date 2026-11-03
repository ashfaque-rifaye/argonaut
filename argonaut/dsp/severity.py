"""Vibration severity zones (ISO 10816-1 / ISO 20816-1 style, broadband velocity RMS, mm/s).

Zone boundaries depend on machine class and mounting. A: newly commissioned, B: unrestricted
long-term operation, C: restricted operation, D: damage likely.
"""

ZONES_MM_S = {
    # class: (A/B, B/C, C/D)
    "I": (0.71, 1.8, 4.5),     # small machines, up to ~15 kW
    "II": (1.12, 2.8, 7.1),    # medium machines 15-75 kW, or up to 300 kW on special foundations
    "III": (1.8, 4.5, 11.2),   # large machines on rigid foundations
    "IV": (2.8, 7.1, 18.0),    # large machines on soft foundations
}


def machine_class(kw: float | None) -> str:
    if kw is None or kw <= 15:
        return "I"
    if kw <= 75:
        return "II"
    return "III"


def zone(vel_mm_s_rms: float, cls: str = "I") -> str:
    ab, bc, cd = ZONES_MM_S[cls]
    if vel_mm_s_rms < ab:
        return "A"
    if vel_mm_s_rms < bc:
        return "B"
    if vel_mm_s_rms < cd:
        return "C"
    return "D"
