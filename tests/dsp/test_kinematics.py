"""Kinematic forcing model, Bayesian speed posterior and fault posterior on synthetic spectra."""
import numpy as np

from argonaut.dsp.kinematics import (Kinematics, bearing_orders, detect_line_hz, fault_posterior, order_lines,
                                     speed_posterior)

FS_DF = 0.25  # Hz per bin, like a 4 s Welch segment


def _spectrum(lines, fmax=1500.0, noise=0.01, seed=0):
    rng = np.random.default_rng(seed)
    f = np.arange(0, fmax, FS_DF)
    a = noise * (1 + 0.3 * rng.random(len(f)))
    for fc, amp in lines:
        a += amp * np.exp(-0.5 * ((f - fc) / 0.3) ** 2)
    return f, a


def test_bearing_orders_textbook():
    # 6205-like geometry: 9 balls, d = 7.94 mm, D = 39.0 mm, phi = 0 -> BPFO 3.58x, BPFI 5.42x
    b = bearing_orders(9, 7.94, 39.0, 0.0)
    assert abs(b["BPFO"] - 3.584) < 0.01 and abs(b["BPFI"] - 5.416) < 0.01
    assert abs(b["FTF"] - 0.398) < 0.01


def test_order_lines_families():
    kin = Kinematics(machine="genset", stroke=4, cylinders=12, blades=None)
    fam = {(l["order"], l["family"]) for l in order_lines(kin, max_order=8)}
    assert (0.5, "half_order") in fam and (6.0, "firing") in fam and (6.0, "shaft") in fam
    fan = {l["family"] for l in order_lines(Kinematics(machine="fan", blades=6), max_order=20)}
    assert "blade_pass" in fan and "half_order" not in fan


def test_four_stroke_half_orders_resolve_speed():
    # a 1500 rpm four-stroke engine: lines every 12.5 Hz (half orders), even ones stronger
    shaft = 25.0
    lines = [(k * shaft / 2, 1.0 if k % 2 == 0 else 0.8) for k in range(3, 21)]  # all 18 lines are picked
    f, a = _spectrum(lines)
    engine = speed_posterior(f, a, Kinematics(machine="engine", stroke=4))
    generic = speed_posterior(f, a, Kinematics())
    assert abs(engine["map_rpm"] - 1500) < 8 and engine["p_map"] > 0.7
    assert abs(generic["map_rpm"] - 750) < 5  # without kinematics the comb reads as 750 rpm integer orders


def test_blade_count_resolves_blade_pass():
    shaft, blades = 6.875, 6  # 412.5 rpm, BPF 41.25 Hz with harmonics
    lines = [(h * blades * shaft, 1.0 / h) for h in range(1, 12)] + [(shaft, 0.05), (2 * shaft, 0.04)]
    f, a = _spectrum(lines)
    known = speed_posterior(f, a, Kinematics(machine="fan", blades=6))
    unknown = speed_posterior(f, a, Kinematics(machine="fan"))
    assert abs(known["map_rpm"] - 412.5) < 3
    assert abs(unknown["map_rpm"] - 2475) < 15  # the blade-pass tone taken as 1x


def test_line_frequency_and_synchronous_prior():
    f, a = _spectrum([(h * 49.94, 0.8) for h in (2, 4, 6, 8)] + [(k * 12.485, 0.5) for k in range(3, 30)])
    line = detect_line_hz(f, a)
    assert line and line["nominal_hz"] == 50.0 and abs(line["line_hz"] - 49.94) < 0.05
    post = speed_posterior(f, a, Kinematics(machine="genset", stroke=4), line=line)
    assert abs(post["map_rpm"] - 1498.2) < 6


def test_display_used_only_for_validation():
    shaft = 25.7
    f, a = _spectrum([(k * shaft / 2, 1.0) for k in range(4, 40)])
    post = speed_posterior(f, a, Kinematics(machine="genset", stroke=4, display_rpm=1542.0))
    assert "flat" in post["prior"]  # the display never enters the prior
    assert abs(post["display_error_pct"]) < 0.5


def test_fault_posterior_misalignment_vs_imbalance():
    kin = Kinematics(machine="centrifugal_pump", blades=6)
    f, a = _spectrum([(24.67 * k, 0.3) for k in (1, 2, 6)])
    base = {"kin": kin, "audio_f": f, "audio_a": a, "modes": [], "criticals": [], "cavitation": {"index": 0.1}}
    mis = fault_posterior({**base, "video_orders": {1: 1.0, 2: 2.2, 3: 0.2}, "phase_2x_deg": 178.0}, [{"f_hz": 24.67, "p": 1.0}])
    imb = fault_posterior({**base, "video_orders": {1: 3.0, 2: 0.2, 3: 0.1}, "phase_2x_deg": 5.0}, [{"f_hz": 24.67, "p": 1.0}])
    p = lambda hs, i: next(h["p"] for h in hs if h["id"] == i)  # noqa: E731
    assert p(mis, "misalignment") > 0.8 and p(mis, "imbalance") < 0.2
    assert p(imb, "imbalance") > 0.5 and p(imb, "misalignment") < 0.05
    bearing = next(h for h in mis if h["id"] == "bearing")
    assert not bearing["evaluable"]  # no bearing geometry -> not guessed
