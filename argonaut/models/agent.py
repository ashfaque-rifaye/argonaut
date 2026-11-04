"""Muse Wonder as the reliability / real-time-optimisation engineer.

The model never measures; it calls tools that return measured, uncertainty-tagged numbers,
decides, and explains. Every diagnosis and proposal it emits must reference tool evidence.
The same reasoning can run on Muse Spark Open (Baseten) in private mode.
"""

import json
import uuid
from typing import Any, Awaitable, Callable

from .client import OPEN_WEIGHTS, WONDER, Emit, baseten, meta, stage

SYSTEM = """You are Argonaut, a senior machinery-dynamics and process-optimisation engineer.
You work ONLY from tool results: measured spectra, identified modes (frequency, damping with error
bars), order amplitudes, ISO 20816 severity, cavitation index, digital-twin optimisation results.
Never invent a number. If evidence is weak (low confidence, wide error bars, uncorroborated peaks,
near-Nyquist frequencies), say so and ask for a better capture instead of concluding.

Workflow:
1. Call get_identification to read what was measured.
2. Report each finding with report_diagnosis (severity info|warn|alarm, cite evidence ids and numbers).
   Use practitioner rules: 1x dominant & radial -> imbalance; 2x with ~180 deg phase across a coupling
   -> misalignment; many harmonics -> looseness; an order line crossing a natural frequency during
   operation -> resonance (critical speed); high-frequency impulsive noise + cavitation index -> cavitation.
3. If the asset is variable-speed, call run_optimiser and then propose_setpoint with the result and a
   short engineering rationale (resonance margin, duty, specific energy, NPSH). A human must approve.
Kinematics: get_identification includes `kinematics` - the machine model Muse Spark read (class, stroke,
blades, poles, display rpm), a Bayesian speed posterior (modes with probabilities, prior used, peaks
explained) and a fault posterior (P per hypothesis with evidence in decibans; `evaluable: false` means
the evidence needed is missing - say what capture would provide it). If the speed posterior is
ambiguous (p_map < 0.8) or a kinematic assumption is doubtful, call test_kinematic_hypothesis with the
alternative (e.g. blades, stroke, machine_class) and compare posteriors before concluding; report the
probabilities, not certainty. A display_rpm read from the frame is an independent check: report the error.
If scale_calibrated is false, do NOT report ISO zones or absolute mm/s severity: say amplitudes are
relative (uncalibrated scale) and base conclusions on frequencies, orders, phase and ratios only.
Be concise, technical and specific. Use units."""

TOOLS = [
    {"type": "function", "name": "get_identification",
     "description": "Measured identification of the asset: speed, orders, spectra peaks, modes, Campbell criticals, "
                    "FDD mode shapes, ISO zone, audio corroboration, cavitation index, capture quality.",
     "parameters": {"type": "object", "properties": {}, "required": []}},
    {"type": "function", "name": "run_optimiser",
     "description": "Constrained speed optimisation on the identified digital twin. Returns current vs proposed "
                    "setpoint, constraints, feasible and exclusion bands, expected % change in vibration and energy.",
     "parameters": {"type": "object", "properties": {
         "duty_min_frac": {"type": "number", "description": "minimum flow as fraction of current, e.g. 0.8"},
         "resonance_margin": {"type": "number", "description": "fractional separation from critical speeds, e.g. 0.1"}},
         "required": ["duty_min_frac", "resonance_margin"]}},
    {"type": "function", "name": "test_kinematic_hypothesis",
     "description": "What-if: re-run the Bayesian speed posterior and the fault posterior under changed kinematic "
                    "assumptions (only the fields you pass change). Returns the new kinematics block. Use revert=true "
                    "to go back to what Muse Spark read.",
     "parameters": {"type": "object", "properties": {
         "machine_class": {"type": "string", "enum": ["induction_motor", "fan", "centrifugal_pump", "gear_pump", "genset",
                                                      "engine", "washer", "gearbox", "wind_turbine", "structure", "generic"]},
         "blades": {"type": "integer"}, "cylinders": {"type": "integer"}, "stroke": {"type": "integer"},
         "poles": {"type": "integer"}, "line_hz": {"type": "number"}, "revert": {"type": "boolean"}},
         "required": []}},
    {"type": "function", "name": "report_diagnosis",
     "description": "Publish one finding to the operator with evidence.",
     "parameters": {"type": "object", "properties": {
         "title": {"type": "string"}, "severity": {"type": "string", "enum": ["info", "warn", "alarm"]},
         "summary": {"type": "string"}, "confidence": {"type": "number"},
         "evidence": {"type": "array", "items": {"type": "string"},
                      "description": "evidence ids from get_identification, e.g. 'peak:s1:24.6', 'mode:14.2', 'zone'"}},
         "required": ["title", "severity", "summary", "confidence", "evidence"]}},
    {"type": "function", "name": "propose_setpoint",
     "description": "Send the optimiser's proposal to the operator for approval, with your rationale.",
     "parameters": {"type": "object", "properties": {"rationale": {"type": "string"}}, "required": ["rationale"]}},
]

ToolFn = Callable[[dict], Awaitable[Any]]


async def run(tools: dict[str, ToolFn], emit: Emit, user_msg: str = "Assess this asset and optimise it.",
              max_turns: int = 8, private: bool = False, ledger=None) -> str:
    """Agent loop. `tools` maps tool name -> async fn(args) -> JSON-serialisable result.

    Every tool result is recorded in a provenance ledger; every number in the agent's text is
    checked against it and the result is attached to the emitted message (`claims`)."""
    from .provenance import Ledger, check

    ledger = ledger if ledger is not None else Ledger()

    async def say(text: str):
        claims, prov = check(text, ledger)
        await emit({"type": "agent", "role": "assistant", "text": text, "final": True,
                    "claims": claims, "provenance": prov})
    client, model = (baseten(), OPEN_WEIGHTS) if private and baseten() else (meta(), WONDER)
    stage_name = "open_weights" if model == OPEN_WEIGHTS else "wonder"
    if model == OPEN_WEIGHTS:
        return await _run_chat(client, tools, emit, user_msg, max_turns, ledger)

    async with stage(emit, stage_name, model, "planning"):
        resp = await client.responses.create(model=model, instructions=SYSTEM, input=user_msg, tools=TOOLS)
    history: list[dict] = [{"role": "user", "content": user_msg}]
    for _ in range(max_turns):
        if resp.output_text:  # each turn's narration is a complete message for the UI
            await say(resp.output_text)
        calls = [i for i in resp.output if i.type == "function_call"]
        if not calls:
            break
        outputs = []
        for call in calls:
            args = json.loads(call.arguments or "{}")
            await emit({"type": "pipeline", "stage": stage_name, "state": "running", "model": model,
                        "detail": f"tool: {call.name}"})
            try:
                result = await tools[call.name](args)
            except Exception as e:  # tool errors go back to the model, which can re-plan
                result = {"error": str(e)}
            ledger.add(result, call.name)
            outputs.append({"type": "function_call_output", "call_id": call.call_id,
                            "output": json.dumps(result, default=float)})
        history += [i.model_dump(exclude_none=True) for i in resp.output] + outputs
        async with stage(emit, stage_name, model, "reasoning"):
            try:
                resp = await client.responses.create(model=model, instructions=SYSTEM, input=outputs,
                                                     previous_response_id=resp.id, tools=TOOLS)
            except Exception as e:
                if "not found or expired" not in str(e):
                    raise
                # Server-side state expired: resend the whole conversation instead.
                resp = await client.responses.create(model=model, instructions=SYSTEM, input=history, tools=TOOLS)
    return resp.output_text or ""


async def _run_chat(client, tools: dict[str, ToolFn], emit: Emit, user_msg: str, max_turns: int,
                    ledger=None) -> str:
    """Same loop over Chat Completions for open-weight Muse Spark Open on Baseten."""
    chat_tools = [{"type": "function", "function": {k: t[k] for k in ("name", "description", "parameters")}}
                  for t in TOOLS]
    from .provenance import Ledger, check

    ledger = ledger if ledger is not None else Ledger()
    msgs: list[dict] = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_msg}]
    final = ""
    for _ in range(max_turns):
        async with stage(emit, "open_weights", OPEN_WEIGHTS, "reasoning on open weights"):
            r = await client.chat.completions.create(model=OPEN_WEIGHTS, messages=msgs, tools=chat_tools,
                                                     max_tokens=4000)
        m = r.choices[0].message
        msgs.append(m.model_dump(exclude_none=True))
        if m.content:
            final = m.content
            claims, prov = check(m.content, ledger)
            await emit({"type": "agent", "role": "assistant", "text": m.content, "final": True,
                        "claims": claims, "provenance": prov})
        if not m.tool_calls:
            break
        for tc in m.tool_calls:
            try:
                result = await tools[tc.function.name](json.loads(tc.function.arguments or "{}"))
            except Exception as e:
                result = {"error": str(e)}
            ledger.add(result, tc.function.name)
            msgs.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result, default=float)})
    return final


def new_id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:6]}"
