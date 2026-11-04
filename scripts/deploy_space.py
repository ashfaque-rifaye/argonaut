"""Push the live backend to a Hugging Face Docker Space (see docs/DEPLOY.md).

    uv run --with huggingface_hub python scripts/deploy_space.py [--space user/name]

Uses the token from `hf auth login` (or HF_TOKEN). Never uploads .env: secrets are set on the Space itself.
"""
import argparse
import os
import shutil
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parent.parent
CARD = """---
title: Argonaut backend
emoji: 🛠️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Live backend of Argonaut, vibration analysis from any camera
---

The live backend of [Argonaut](https://github.com/ashfaque-rifaye/argonaut): FastAPI and WebSockets around Meta's
models and a signal-processing core. The console is at https://argonaut-sand.vercel.app.

Footage in `data/library` belongs to its authors under the licences in `data/library/CREDITS.md`.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", default="Ashfaque94/argonaut")
    a = ap.parse_args()
    token = os.environ.get("HF_TOKEN") or (Path.home() / ".cache/huggingface/token").read_text().strip()
    api = HfApi(token=token)
    api.create_repo(a.space, repo_type="space", space_sdk="docker", exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        out = Path(d)
        for f in ("Dockerfile", ".dockerignore", "pyproject.toml", "uv.lock"):
            shutil.copy(ROOT / f, out / f)
        skip = shutil.ignore_patterns("__pycache__", "*.pyc")
        shutil.copytree(ROOT / "argonaut", out / "argonaut", ignore=skip)
        shutil.copytree(ROOT / "data" / "library", out / "data" / "library", ignore=skip)
        shutil.copytree(ROOT / "data" / "synth", out / "data" / "synth", ignore=skip)
        (out / "README.md").write_text(CARD, encoding="utf-8")
        api.upload_folder(repo_id=a.space, repo_type="space", folder_path=str(out), commit_message="Deploy Argonaut backend",
                          delete_patterns=["argonaut/**"])
    name = a.space.replace("/", "-").lower()
    print(f"https://huggingface.co/spaces/{a.space}\nhttps://{name}.hf.space")


main()
