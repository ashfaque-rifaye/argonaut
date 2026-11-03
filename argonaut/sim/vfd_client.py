"""Client helpers for the simulated VFD (``argonaut.sim.plant`` Modbus TCP server).

Sync (blocking, one short TCP connection per call)::

    from argonaut.sim.vfd_client import read_state, write_setpoint
    write_setpoint(1220)
    read_state()  # {'speed_rpm': 1371.0, 'q': 98.1, 'h': 25.3, 'kw': 9.62, ...}

Async (for FastAPI / the agent loop)::

    st = await aread_state(); await awrite_setpoint(1220)

Host/port default to ``ARGONAUT_VFD_HOST`` / ``ARGONAUT_VFD_PORT`` (127.0.0.1:5020).
"""

from __future__ import annotations

import os

from argonaut.sim.plant import (
    HR_RAMP_RPM_S,
    HR_SPEED_SETPOINT_RPM,
    HR_THROTTLE_PERMILLE,
    N_IR,
    NA,
    REGISTER_MAP,
)

DEVICE_ID = 1


def _addr(host: str | None, port: int | None) -> tuple[str, int]:
    return (host or os.environ.get("ARGONAUT_VFD_HOST", "127.0.0.1"),
            int(port or os.environ.get("ARGONAUT_VFD_PORT", "5020")))


def decode_input_registers(regs: list[int]) -> dict:
    """Input registers -> engineering units (None where the register holds 65535 = N/A)."""
    out: dict = {}
    for addr, (key, scale) in REGISTER_MAP["input"].items():
        raw = regs[addr]
        if key == "status":
            out["running"] = bool(raw & 1)
            out["ramping"] = bool(raw & 2)
            out["cavitating"] = bool(raw & 4)
            out["at_setpoint"] = bool(raw & 8)
            continue
        out[key] = None if raw == NA else raw / scale
    return out


def _check(resp, what: str):
    if resp is None or resp.isError():
        raise IOError(f"Modbus {what} failed: {resp}")
    return resp


# ---------------------------------------------------------------- sync -------------------------


def read_state(host: str | None = None, port: int | None = None, timeout: float = 2.0) -> dict:
    """Read all input registers (measured speed, flow, head, kW, vibration, NPSH margin, ...)."""
    from pymodbus.client import ModbusTcpClient

    h, p = _addr(host, port)
    with ModbusTcpClient(h, port=p, timeout=timeout, retries=1) as c:
        if not c.connect():
            raise ConnectionError(f"cannot connect to VFD at {h}:{p}")
        ir = _check(c.read_input_registers(0, count=N_IR, device_id=DEVICE_ID), "read input registers")
        hr = _check(c.read_holding_registers(0, count=3, device_id=DEVICE_ID), "read holding registers")
    st = decode_input_registers(list(ir.registers))
    st["ramp_rpm_s"] = float(hr.registers[HR_RAMP_RPM_S])
    st["throttle"] = hr.registers[HR_THROTTLE_PERMILLE] / 1000.0
    return st


def _write(reg: int, value: int, host, port, timeout) -> int:
    from pymodbus.client import ModbusTcpClient

    h, p = _addr(host, port)
    with ModbusTcpClient(h, port=p, timeout=timeout, retries=1) as c:
        if not c.connect():
            raise ConnectionError(f"cannot connect to VFD at {h}:{p}")
        _check(c.write_register(reg, int(value), device_id=DEVICE_ID), f"write register {reg}")
        hr = _check(c.read_holding_registers(reg, count=1, device_id=DEVICE_ID), "read back")
    return int(hr.registers[0])


def write_setpoint(rpm: float, host: str | None = None, port: int | None = None, timeout: float = 2.0) -> int:
    """Write the speed setpoint (rpm). Returns the accepted (clamped) setpoint."""
    return _write(HR_SPEED_SETPOINT_RPM, max(0, round(rpm)), host, port, timeout)


def write_ramp(rpm_per_s: float, host: str | None = None, port: int | None = None, timeout: float = 2.0) -> int:
    return _write(HR_RAMP_RPM_S, max(1, round(rpm_per_s)), host, port, timeout)


def write_throttle(fraction: float, host: str | None = None, port: int | None = None, timeout: float = 2.0) -> float:
    """Suction valve closure 0 (open) .. 0.95. Returns the accepted value."""
    return _write(HR_THROTTLE_PERMILLE, max(0, round(fraction * 1000)), host, port, timeout) / 1000.0


# ---------------------------------------------------------------- async ------------------------


async def aread_state(host: str | None = None, port: int | None = None, timeout: float = 2.0) -> dict:
    from pymodbus.client import AsyncModbusTcpClient

    h, p = _addr(host, port)
    c = AsyncModbusTcpClient(h, port=p, timeout=timeout, retries=1)
    try:
        if not await c.connect():
            raise ConnectionError(f"cannot connect to VFD at {h}:{p}")
        ir = _check(await c.read_input_registers(0, count=N_IR, device_id=DEVICE_ID), "read input registers")
        hr = _check(await c.read_holding_registers(0, count=3, device_id=DEVICE_ID), "read holding registers")
    finally:
        c.close()
    st = decode_input_registers(list(ir.registers))
    st["ramp_rpm_s"] = float(hr.registers[HR_RAMP_RPM_S])
    st["throttle"] = hr.registers[HR_THROTTLE_PERMILLE] / 1000.0
    return st


async def awrite_setpoint(rpm: float, host: str | None = None, port: int | None = None, timeout: float = 2.0) -> int:
    from pymodbus.client import AsyncModbusTcpClient

    h, p = _addr(host, port)
    c = AsyncModbusTcpClient(h, port=p, timeout=timeout, retries=1)
    try:
        if not await c.connect():
            raise ConnectionError(f"cannot connect to VFD at {h}:{p}")
        _check(await c.write_register(HR_SPEED_SETPOINT_RPM, max(0, round(rpm)), device_id=DEVICE_ID), "write setpoint")
        hr = _check(await c.read_holding_registers(HR_SPEED_SETPOINT_RPM, count=1, device_id=DEVICE_ID), "read back")
    finally:
        c.close()
    return int(hr.registers[0])


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) > 1:
        print("accepted setpoint:", write_setpoint(float(sys.argv[1])))
    print(json.dumps(read_state(), indent=2))
