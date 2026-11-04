"""Agent actions executed against the simulated drive over Modbus TCP: field balancing and skip bands."""
import asyncio
import cmath
import math
import os
import socket

import pytest

from argonaut.actions import iso21940_uper, priority, trial_mass_g
from argonaut.sim.plant import ModbusPlantServer, Plant, PlantConfig, one_x_vector, unbalance_vector


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def drive(monkeypatch):
    port = _free_port()
    plant = Plant(PlantConfig.pump(), noise=0.0, seed=1)
    srv = ModbusPlantServer(plant, "127.0.0.1", port).start_in_thread()
    monkeypatch.setenv("ARGONAUT_VFD_PORT", str(port))
    from argonaut.sim import vfd_client
    yield plant, vfd_client
    srv.stop()


class _Session:
    def __init__(self, plant):
        self.plant, self.ident, self.proposal, self.asset_name, self.events = plant, {}, None, "Pump P-101", []

    async def emit(self, ev):
        self.events.append(ev)


def test_iso21940_and_trial_mass():
    # 25 kg rotor at 1480 rpm, G6.3: U_per = 9549 * 6.3 * 25 / 1480 = 1016 g.mm
    assert abs(iso21940_uper(6.3, 25.0, 1480) - 1016.2) < 1
    assert 1.0 < trial_mass_g(25.0, 120.0, 1480) < 10.0
    assert priority(0.8, "D", True)[0] == "P1" and priority(0.2, "A", False)[0] == "P4"


def test_one_x_scales_with_unbalance_vector():
    cfg = PlantConfig.pump()
    u0 = unbalance_vector(cfg)
    v0, _ = one_x_vector(cfg, 1480, u0)
    v_half, _ = one_x_vector(cfg, 1480, u0 * 0.5)
    assert abs(v_half / v0 - 0.5) < 1e-6
    # a mass that exactly cancels the residual unbalance removes the 1x term
    g = cfg.unbalance_gmm / cfg.balance_radius_mm
    u = unbalance_vector(cfg, [(g, cfg.unbalance_deg + 180)])
    assert abs(u) < 1e-6


def test_field_balance_and_skip_bands_over_modbus(drive):
    plant, client = drive
    from argonaut.actions import Actions
    s = _Session(client)
    acts = Actions(s)

    async def go():
        a = await acts.propose("balance", "Field-balance", "test", {"grade": 6.3, "rotor_kg": 25.0, "radius_mm": 120.0})
        assert a["status"] == "proposed"  # physical: waits for the operator
        await acts.approve(a["id"], True)
        for _ in range(200):
            if a["status"] in ("done", "failed"):
                break
            await asyncio.sleep(0.05)
        b = await acts.propose("skip_bands", "Skip", "test", {"bands_rpm": [[800, 900]]})
        await acts.approve(b["id"], True)
        for _ in range(100):
            if b["status"] in ("done", "failed"):
                break
            await asyncio.sleep(0.05)
        return a, b

    a, b = asyncio.run(go())
    assert a["status"] == "done", a.get("error")
    r = a["result"]
    assert r["reduction_pct"] > 90 and r["pass"]
    # the correction found by the influence-coefficient method cancels the true residual unbalance
    true_c = cmath.rect(plant.cfg.unbalance_gmm / plant.cfg.balance_radius_mm, math.radians(plant.cfg.unbalance_deg + 180))
    assert abs(r["correction_g"] - abs(true_c)) / abs(true_c) < 0.05
    assert b["status"] == "done" and b["result"]["pass"]
    assert b["result"]["bands"] == [(850, 50)]
    os.environ.pop("ARGONAUT_VFD_PORT", None)
