"""Shared Meta Model API clients (OpenAI-compatible) and a tiny instrumentation hook.

Every call reports a `pipeline` event (stage, model, state, latency) so the UI can show
real models working in real time.
"""

import os
import time
from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

BASE_URL = os.environ.get("MODEL_BASE_URL", "https://api.meta.ai/v1")
SPARK = "muse-spark-1.3"
SPARK_AUDIO = "muse-spark-1.2"  # 1.3 audio understanding is not fully supported yet
WONDER = "muse-wonder-1.0"
SAM = "sam-3.1"
VOICE = "muse-voice-transcribe-1.0"
OPEN_WEIGHTS = os.environ.get("BASETEN_MODEL", "meta-models/muse-spark-open-1026")

Emit = Callable[[dict], Awaitable[None]]


def api_key() -> str:
    return os.environ.get("MODEL_API_KEY", "")


def available() -> bool:
    return bool(api_key())


_meta: AsyncOpenAI | None = None
_baseten: AsyncOpenAI | None = None


def meta() -> AsyncOpenAI:
    global _meta
    if _meta is None:
        _meta = AsyncOpenAI(base_url=BASE_URL, api_key=api_key() or "missing", timeout=180, max_retries=2)
    return _meta


def baseten() -> AsyncOpenAI | None:
    global _baseten
    key = os.environ.get("BASETEN_API_KEY", "")
    if not key:
        return None
    if _baseten is None:
        _baseten = AsyncOpenAI(base_url=os.environ.get("BASETEN_BASE_URL", "https://inference.baseten.co/v1"),
                               api_key=key, timeout=180, max_retries=2)
    return _baseten


async def _noop(_: dict) -> None:
    return None


@asynccontextmanager
async def stage(emit: Emit | None, stage_name: str, model: str, detail: str = ""):
    """Report running -> ok/error with latency for one model call."""
    emit = emit or _noop
    t0 = time.perf_counter()
    await emit({"type": "pipeline", "stage": stage_name, "state": "running", "model": model, "detail": detail})
    try:
        yield
    except Exception as e:
        await emit({"type": "pipeline", "stage": stage_name, "state": "error", "model": model,
                    "latency_ms": int((time.perf_counter() - t0) * 1000), "detail": str(e)[:200]})
        raise
    await emit({"type": "pipeline", "stage": stage_name, "state": "ok", "model": model,
                "latency_ms": int((time.perf_counter() - t0) * 1000), "detail": detail})
