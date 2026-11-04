"""Limits for a public deployment (PUBLIC_MODE=1): anyone can reach it, and every analysis spends the owner's API credits.

Off by default, so a local install or a plant's own server has no limits.
"""

import ipaddress
import os
import socket
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from fastapi import HTTPException, Request

PUBLIC = os.environ.get("PUBLIC_MODE") == "1"
MAX_UPLOAD_MB = int(os.environ.get("PUBLIC_MAX_UPLOAD_MB", "80"))
MAX_CLIP_S = float(os.environ.get("PUBLIC_MAX_CLIP_S", "30"))
LIVE_LIMIT_S = float(os.environ.get("PUBLIC_LIVE_LIMIT_S", "120"))  # one live camera or feed session
PER_IP_HOUR = int(os.environ.get("PUBLIC_PER_IP_HOUR", "4"))
GLOBAL_DAY = int(os.environ.get("PUBLIC_GLOBAL_DAY", "60"))
MAX_RUNNING = int(os.environ.get("PUBLIC_MAX_RUNNING", "2"))

_by_ip: dict[str, deque] = defaultdict(deque)
_all: deque = deque()
_running: set = set()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def _spend(ip: str):
    now = time.time()
    q = _by_ip[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    while _all and now - _all[0] > 86400:
        _all.popleft()
    if len(q) >= PER_IP_HOUR:
        raise HTTPException(429, f"This public demo allows {PER_IP_HOUR} analyses an hour per visitor. The recorded runs stay available.")
    if len(_all) >= GLOBAL_DAY:
        raise HTTPException(429, "The public demo has used its analyses for today. The recorded runs stay available, or run Argonaut yourself.")
    q.append(now)
    _all.append(now)


def admit(request: Request, task=None):
    """Called before anything that spends model credits. No-op unless PUBLIC_MODE=1."""
    if not PUBLIC:
        return
    _running.difference_update({t for t in _running if t.done()})
    if len(_running) >= MAX_RUNNING:
        raise HTTPException(429, "The public demo is busy with another analysis. Try again in a minute, or watch a recorded run.")
    _spend(client_ip(request))


def track(task):
    if PUBLIC:
        _running.add(task)
    return task


def check_clip(duration_s: float, size_bytes: int):
    if not PUBLIC:
        return
    if size_bytes > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"The public demo takes videos up to {MAX_UPLOAD_MB} MB.")
    if duration_s > MAX_CLIP_S:
        raise HTTPException(413, f"The public demo takes videos up to {MAX_CLIP_S:.0f} s. Trim yours, or run Argonaut yourself for longer ones.")


def check_feed_url(url: str):
    """No camera indexes and no addresses inside the host's network: the server would be the one connecting."""
    if not PUBLIC:
        return
    u = urlparse(url.strip())
    if u.scheme not in ("http", "https", "rtsp", "rtsps") or not u.hostname:
        raise HTTPException(400, "Use a public http(s) or rtsp stream URL.")
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(u.hostname, None)}
    except OSError:
        raise HTTPException(400, f"Could not resolve {u.hostname}.") from None
    for a in addrs:
        ip = ipaddress.ip_address(a)
        if not ip.is_global:
            raise HTTPException(400, "The public demo only connects to public addresses. Run Argonaut on your own network for plant cameras.")
