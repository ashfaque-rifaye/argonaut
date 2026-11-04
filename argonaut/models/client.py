"""Shared Meta Model API clients (OpenAI-compatible) and a tiny instrumentation hook.

Every call reports a `pipeline` event (stage, model, state, latency) so the UI can show
real models working in real time.
"""

import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
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
# Muse Spark Open on any OpenAI-compatible endpoint: yours, Baseten (BASETEN_*) or the Hugging Face router (HF_TOKEN).
OPEN_WEIGHTS = (os.environ.get("OPEN_MODEL") or
                ("meta-models/muse-spark-open-1026" if os.environ.get("BASETEN_API_KEY") else "meta-models/Muse-Spark-Open-816B-A42B"))

Emit = Callable[[dict], Awaitable[None]]


def api_key() -> str:
    return os.environ.get("MODEL_API_KEY", "")


def available() -> bool:
    return bool(api_key())


_meta: AsyncOpenAI | None = None
_open: AsyncOpenAI | None = None


def meta() -> AsyncOpenAI:
    global _meta
    if _meta is None:
        _meta = AsyncOpenAI(base_url=BASE_URL, api_key=api_key() or "missing", timeout=180, max_retries=2)
    return _meta


def _hf_token() -> str:
    tok = os.environ.get("HF_TOKEN", "")
    if tok:
        return tok
    cached = Path.home() / ".cache" / "huggingface" / "token"
    return cached.read_text().strip() if cached.exists() else ""


def open_weights() -> AsyncOpenAI | None:
    """Client for private mode, or None when no open-weights endpoint is configured."""
    global _open
    if _open is None:
        if os.environ.get("OPEN_API_KEY"):
            url, key = os.environ.get("OPEN_BASE_URL", "http://localhost:8080/v1"), os.environ["OPEN_API_KEY"]
        elif os.environ.get("BASETEN_API_KEY"):
            url, key = os.environ.get("BASETEN_BASE_URL", "https://inference.baseten.co/v1"), os.environ["BASETEN_API_KEY"]
        else:
            url, key = "https://router.huggingface.co/v1", _hf_token()
        if not key:
            return None
        _open = AsyncOpenAI(base_url=url, api_key=key, timeout=180, max_retries=2)
    return _open


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
