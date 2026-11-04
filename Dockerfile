# The live backend: FastAPI + WebSockets, Meta model calls, OpenCV/NumPy/SciPy signal processing.
# Hugging Face Docker Spaces run this as uid 1000 on port 7860; Cloud Run and others set $PORT.
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY argonaut ./argonaut
COPY data/library ./data/library
COPY data/synth ./data/synth
RUN mkdir -p data/runs && chmod -R a+rwX /app/data

ENV PUBLIC_MODE=1 HOME=/tmp UV_NO_SYNC=1 PYTHONUNBUFFERED=1 TRACK_FPS=8 TRACK_PROXY_W=400
EXPOSE 7860
CMD ["sh", "-c", "exec /app/.venv/bin/uvicorn argonaut.server:app --host 0.0.0.0 --port ${PORT:-7860}"]
