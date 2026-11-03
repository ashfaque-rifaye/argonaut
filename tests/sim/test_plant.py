import asyncio
import math
import socket
import time
from dataclasses import replace

import numpy as np
import pytest

from argonaut.sim import vfd_client
from argonaut.sim.plant import (
    ModbusPlantServer,
    Plant,
    PlantConfig,
    critical_speeds,
    evaluate,
    pump_head,
    sdof_gain,
    sweep,
)


def test_sdof_gain():
    assert sdof_gain(0.0, 0.02) == pytest.approx(1.0)
    assert sdof_gain(1.0, 0.02) == pytest.approx(25.0)
    assert sdof_gain(10.0, 0.02) < 0.02


@pytest.mark.parametrize("cfg", [PlantConfig.pump(static_head=0.0), PlantConfig.fan()])
def test_affinity_laws_on_friction_only_system(cfg):
    a, b = evaluate(cfg, 1450.0), evaluate(cfg, 1000.0)
    r = 1000.0 / 1450.0
    assert b["q"] / a["q"] == pytest.approx(r, rel=1e-6)
    assert b["h"] / a["h"] == pytest.approx(r**2, rel=1e-6)
    assert b["shaft_kw"] / a["shaft_kw"] == pytest.approx(r**3, rel=1e-6)
    assert b["eta"] == pytest.approx(a["eta"], rel=1e-9)


def test_affinity_pump_curve_scaling():
    cfg = PlantConfig.pump()
    q = np.linspace(0, 150, 7)
    r = 0.7
    # H_N(r*Q) = r^2 * H_N0(Q)
    assert np.allclose(pump_head(cfg, r * q, r * cfg.rated_rpm), r**2 * pump_head(cfg, q, cfg.rated_rpm))


def test_operating_point_sanity():
    cfg = PlantConfig.pump()
    st = evaluate(cfg, cfg.rated_rpm)
    # on both curves
    assert pump_head(cfg, st["q"], cfg.rated_rpm) == pytest.approx(st["h"], rel=1e-9)
    assert cfg.static_head + cfg.k_sys * st["q"] ** 2 == pytest.approx(st["h"], rel=1e-9)
    assert 0.8 * cfg.q_bep < st["q"] < 1.3 * cfg.q_bep
    assert 0.0 < st["eta"] <= cfg.eta_bep
    assert st["kw"] > st["shaft_kw"] > 0
    assert st["specific_energy"] == pytest.approx(st["kw"] / st["q"])
    assert st["npsh_margin"] > 1.3 and not st["cavitating"]
    # hydraulic power consistency: rho g Q H / eta == shaft power
    p_hyd = 1000 * 9.81 * st["q"] / 3600 * st["h"] / 1000
    assert p_hyd / st["eta"] == pytest.approx(st["shaft_kw"], rel=1e-6)
    # flow rises with speed; below the static-head speed there is no flow
    sw = sweep(np.arange(600, 1801, 100), cfg)
    assert np.all(np.diff(sw["q"]) > 0)
    n_min = cfg.rated_rpm * math.sqrt(cfg.static_head / cfg.h0)
    assert evaluate(cfg, n_min * 0.95)["q"] == 0.0
    assert evaluate(cfg, 0.0)["kw"] == pytest.approx(cfg.standby_kw)


@pytest.mark.parametrize("cfg", [PlantConfig.pump(), PlantConfig.fan()])
def test_resonance_peak_near_critical_speed(cfg):
    speeds = np.arange(700.0, 1000.0, 1.0)
    v = sweep(speeds, cfg)["vel_mm_s_rms"]
    m = cfg.modes[0]
    n_crit = m.fn_hz * 60 / 1  # 1x crossing the first mode
    peak = speeds[np.argmax(v)]
    assert abs(peak - n_crit) / n_crit < 0.01
    # 2x crossing the second mode gives a local maximum too
    n2 = cfg.modes[1].fn_hz * 60 / 2
    is_max = np.r_[False, (v[1:-1] > v[:-2]) & (v[1:-1] > v[2:]), False]
    assert np.any(np.abs(speeds[is_max] - n2) / n2 < 0.01)
    # resonance is much worse than a nearby off-resonance speed
    assert v[np.argmax(v)] > 2.5 * evaluate(cfg, 1150)["vel_mm_s_rms"]
    crit = {(c["order"], c["mode_f_hz"]): c["rpm"] for c in critical_speeds(cfg)}
    assert crit[(1, m.fn_hz)] == pytest.approx(n_crit)


def test_npsh_throttle_and_backoff():
    cfg = PlantConfig.pump()
    ok = evaluate(cfg, 1480, throttle=0.0)
    bad = evaluate(cfg, 1480, throttle=0.5)
    assert bad["npsh_margin"] < 1.0 and bad["cavitating"] and bad["cavitation_index"] > 0.5
    assert bad["npsha_m"] < ok["npsha_m"]
    assert bad["vel_mm_s_rms"] > ok["vel_mm_s_rms"]  # cavitation adds broadband vibration
    backed_off = evaluate(cfg, 1200, throttle=0.5)
    assert backed_off["npsh_margin"] > 1.3 and not backed_off["cavitating"]


def test_vfd_ramp_limit():
    p = Plant(PlantConfig.pump())
    p.set_setpoint(1000)
    p.step(1.0)
    assert p.speed_rpm == pytest.approx(1480 - 150)
    p.step(10.0)
    assert p.speed_rpm == pytest.approx(1000)
    assert p.set_setpoint(9999) == cfg_max()


def cfg_max():
    return PlantConfig.pump().max_rpm


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def vfd_server():
    port = _free_port()
    plant = Plant(PlantConfig.pump())
    srv = ModbusPlantServer(plant, "127.0.0.1", port).start_in_thread()
    yield plant, port
    srv.stop()


def test_modbus_round_trip(vfd_server):
    plant, port = vfd_server
    st = vfd_client.read_state(port=port)
    assert st["speed_rpm"] == pytest.approx(1480, abs=1)
    assert st["q"] == pytest.approx(plant.state()["q"], abs=0.11)
    assert st["kw"] == pytest.approx(plant.state()["kw"], abs=0.011)
    assert st["running"] and st["at_setpoint"] and not st["cavitating"]

    assert vfd_client.write_setpoint(1000, port=port) == 1000
    st = vfd_client.read_state(port=port)
    assert st["ramping"] and st["speed_rpm"] > 1300  # 150 rpm/s ramp limit: not there yet
    assert st["setpoint_rpm"] == 1000

    assert vfd_client.write_ramp(4000, port=port) == 4000
    time.sleep(0.5)
    st = vfd_client.read_state(port=port)
    assert st["speed_rpm"] == pytest.approx(1000, abs=1)
    assert st["at_setpoint"] and not st["ramping"]
    expect = evaluate(plant.cfg, 1000)
    assert st["q"] == pytest.approx(expect["q"], abs=0.11)
    assert st["h"] == pytest.approx(expect["h"], abs=0.11)
    assert st["vel_mm_s_rms"] == pytest.approx(expect["vel_mm_s_rms"], abs=0.011)
    assert st["npsh_margin"] == pytest.approx(expect["npsh_margin"], abs=0.011)

    assert vfd_client.write_setpoint(5000, port=port) == plant.cfg.max_rpm  # clamped
    assert vfd_client.write_throttle(0.5, port=port) == 0.5
    time.sleep(0.4)
    st = vfd_client.read_state(port=port)
    assert st["cavitating"] and st["throttle"] == 0.5


def test_modbus_async_client(vfd_server):
    _, port = vfd_server

    async def go():
        acc = await vfd_client.awrite_setpoint(1100, port=port)
        st = await vfd_client.aread_state(port=port)
        return acc, st

    acc, st = asyncio.run(go())
    assert acc == 1100 and st["setpoint_rpm"] == 1100


def test_asset_card_matches_physics():
    p = Plant(PlantConfig.pump())
    card = p.asset_card()
    assert card["bep"]["q"] == p.cfg.q_bep
    assert len(card["pump_curve"]["q"]) == len(card["pump_curve"]["h"]) == len(card["pump_curve"]["npshr"])
    assert card["system"]["static_head_m"] == p.cfg.static_head
    fan = Plant(replace(PlantConfig.fan()))
    assert "npshr" not in fan.asset_card()["pump_curve"]
