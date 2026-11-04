# Deployment

Argonaut has two deployable halves with very different needs, so it ships as two tiers that work together.

| Tier | What it is | Where | Needs |
|---|---|---|---|
| **Showcase (static)** | The console and landing page. Every run recorded with the Meta models replays in the browser from static files. | Vercel: https://argonaut-sand.vercel.app | Nothing at runtime: no key, no server |
| **Live backend** | FastAPI + WebSockets: Meta model calls, signal processing, uploads, live feeds. | Cloud Run: https://argonaut-163580532635.us-central1.run.app | `MODEL_API_KEY`, ffmpeg, 2 CPU, 4 GB |

**Why two tiers.** Recorded runs must always work, instantly and at no cost, so the static site never depends on the backend. When a visitor uploads a video or connects a feed, the site calls `goLive()` (`web/src/lib/socket.ts`), creates a session on the backend and switches to it in place. If the backend is unreachable, the visitor is told so and recorded runs keep working.

## Showcase on Vercel

```bash
VITE_API_ORIGIN=https://argonaut-163580532635.us-central1.run.app uv run python scripts/export_static.py
npx -y vercel@latest deploy deploy --prod --yes --name argonaut
```

`export_static.py` builds `deploy/`: the web build with `VITE_SHOWCASE=1`, the runs under `/static/runs/`, the library and the footage. Without `VITE_API_ORIGIN` the site is recorded-runs only.

## Live backend on Cloud Run

```bash
gcloud run deploy argonaut --source . --region us-central1 --memory 4Gi --cpu 2 --timeout 3600 --max-instances 1 --min-instances 0 --concurrency 20
```

The `Dockerfile` copies the code, the footage library and the synthetic clips. `.gcloudignore` and `.dockerignore` keep `.env` out of the image. The API key is a setting on the service, never part of the image:

```bash
gcloud run services update argonaut --region us-central1 --update-env-vars MODEL_API_KEY=...
```

Public access is a separate, deliberate step: an `allUsers` invoker binding on the service.

**Why not Hugging Face Spaces.** Docker Spaces on free hardware now need a PRO subscription. `scripts/deploy_space.py` still pushes there for anyone who has one.

**WebSockets.** Cloud Run supports them, and an open socket counts as an active request, so CPU stays allocated while a visitor's analysis runs. Scale-to-zero means the first visitor waits for a cold start; `goLive()` allows 75 s for that.

## Limits on the public backend

Every analysis spends the owner's API credits, so `PUBLIC_MODE=1` (set in the Dockerfile; off locally) enforces, in `argonaut/guard.py`:

| Limit | Default | Setting |
|---|---|---|
| Analyses per visitor per hour | 4 | `PUBLIC_PER_IP_HOUR` |
| Analyses per day, in total | 60 | `PUBLIC_GLOBAL_DAY` |
| Analyses running at once | 2 | `PUBLIC_MAX_RUNNING` |
| Uploaded video | 80 MB, 30 s | `PUBLIC_MAX_UPLOAD_MB`, `PUBLIC_MAX_CLIP_S` |
| One live camera or feed session | 120 s | `PUBLIC_LIVE_LIMIT_S` |

Also in public mode:
- Feed URLs must be `http(s)` or `rtsp(s)` and resolve to public addresses, so the server can't be pointed at its own network.
- CORS accepts only the showcase site.
- Video tracking runs at lower resolution (`TRACK_FPS=8`, `TRACK_PROXY_W=400`), because mask decoding is CPU-heavy.
- The drive is not connected, so physical actions can't run.

Counters live in memory, so they reset when the instance restarts. Set a budget alert on the Meta API key as well.

## Open weights

Private mode runs the same agent loop on Muse Spark Open over any OpenAI-compatible endpoint. The first of these that is set wins (`argonaut/models/client.py`):

| Setting | Endpoint |
|---|---|
| `OPEN_API_KEY`, `OPEN_BASE_URL` | Your own server |
| `BASETEN_API_KEY`, `BASETEN_BASE_URL` | Baseten |
| `HF_TOKEN`, or the token from `hf auth login` | Hugging Face router |

`OPEN_MODEL` overrides the model id.
