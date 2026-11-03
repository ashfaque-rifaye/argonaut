from argonaut.models.provenance import Ledger, check


def test_verified_and_fabricated_numbers():
    L = Ledger()
    L.add({"modes": [{"f_hz": 14.7612, "zeta": 0.0166}], "speed_rpm_now": 1294.3, "orders": {"1": 0.76}})
    text = "Mode at 14.76 Hz with ζ = 1.66% (1× at 1294 rpm, 0.76 mm/s). Expect 37.5% savings."
    claims, prov = check(text, L)
    by = {c["value"]: c for c in claims}
    assert by[14.76]["verified"] and by[1.66]["verified"] and by[1294]["verified"] and by[0.76]["verified"]
    assert not by[37.5]["verified"]  # not in any tool output -> flagged
    assert prov == {"verified": 4, "unverified": 1}


def test_hz_rpm_conversion_and_ordinals_ignored():
    L = Ledger()
    L.add({"speed_hz_now": 24.6})
    claims, _ = check("Running at 1476 rpm; 2× is dominant.", L)
    assert [c["value"] for c in claims] == [1476] and claims[0]["verified"]
