"""Tab 11: which recordings exist between two times.
RTSP has no "list recordings" command, so each time step is probed: ask the recorder for playback at that time and see whether
a frame comes back. One probe at a time with a pause, and the run stops at the first login failure, because recorders lock an
account (and sometimes the client IP) after a few wrong passwords. A thumbnail is kept per hit so the clock printed on the video
can be checked: some recorders' playback time is offset from that clock, and a request inside a gap may start at the next recording.
Every result is saved in state/availability.json, keyed by the link WITHOUT its password and time, so a later check reuses it:
a hit is reused, and a miss is reused when that time was already more than an hour in the past when it was checked."""
import base64, datetime as D, re, subprocess, threading, time
import core as C
from config import ffmpeg_bin

S = dict(run=False, rows=[], err="", total=0, base="", started="", finished="")
LOCK = threading.Lock(); STOP = threading.Event()
MAX_PROBES = 200; PAUSE_S = 2.0; TIMEOUT_S = 20
STORE_F = C.ST / "availability.json"; SLOCK = threading.Lock()

def _mask(u): return re.sub(r"//[^@/]+@", "//***@", u or "")
def _key(u):
    """Saved-result key: the link without password, start or end time."""
    k = re.sub(r"[?&](starttime|endtime)=[^&]*", "", _mask((u or "").strip()))
    return k if "?" in k or "&" not in k else k.replace("&", "?", 1)
def _store(): return C.jload(STORE_F, {})
def _reusable(e):
    if not e or e.get("status") == "auth": return False
    if e["status"] == "yes": return True
    try: return D.datetime.fromisoformat(e["checked_at"]) - D.datetime.strptime(e["t"], "%Y-%m-%d %H:%M") > D.timedelta(hours=1)
    except Exception: return False

def probe(url):
    """One frame from a playback link -> ('yes', jpeg base64, '') | ('no', None, reason) | ('auth', None, reason)."""
    cmd = [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", "10000000", "-skip_frame", "nokey",
           "-i", url, "-frames:v", "1", "-vf", "scale=320:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]
    try: r = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired: return "no", None, f"no video within {TIMEOUT_S} s"
    err = r.stderr.decode(errors="ignore")
    if "401" in err or "Unauthorized" in err: return "auth", None, "login refused (401): check the username and password in the link"
    if r.stdout[:2] == b"\xff\xd8": return "yes", base64.b64encode(r.stdout).decode(), ""
    last = err.strip().splitlines()[-1][:140] if err.strip() else "no video"
    return "no", None, last

def _times(start, end, step_min):
    a = D.datetime.fromisoformat(start); b = D.datetime.fromisoformat(end); out = []
    while a <= b and len(out) < MAX_PROBES: out.append(a); a += D.timedelta(minutes=step_min)
    return out

def _worker(base, times, recheck):
    key = _key(base)
    for t in times:
        if STOP.is_set(): break
        ts = t.strftime("%Y-%m-%d %H:%M")
        with SLOCK: e = _store().get(key, {}).get(ts)
        if not recheck and _reusable(e):
            with LOCK: S["rows"].append(dict(e, saved=True))
            continue
        st, img, note = probe(C.build_playback_url(base, t.strftime("%Y-%m-%dT%H:%M:%S")))
        row = dict(t=ts, status=st, note=note, img=img, checked_at=D.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
        with LOCK: S["rows"].append(row)
        if st == "auth":
            with LOCK: S["err"] = note
            break
        with SLOCK:
            db = _store(); db.setdefault(key, {})[ts] = row; C.jsave(STORE_F, db)
        STOP.wait(PAUSE_S)
    with LOCK: S["run"] = False; S["finished"] = time.strftime("%H:%M:%S")

def start(url, start_dt, end_dt, step_min=60, recheck=False):
    url = (url or "").strip()
    if not url.lower().startswith("rtsp://"): return dict(ok=False, error="Paste an rtsp:// playback link")
    try:
        step_min = max(5, int(step_min)); times = _times(start_dt, end_dt, step_min)
    except Exception: return dict(ok=False, error="Start and end must be valid date-times")
    if not times: return dict(ok=False, error="End is before start")
    with LOCK:
        if S["run"]: return dict(ok=False, error="A check is already running")
        S.update(run=True, rows=[], err="", total=len(times), base=_key(url), started=time.strftime("%H:%M:%S"), finished="")
    STOP.clear(); threading.Thread(target=_worker, args=(url, times, bool(recheck)), daemon=True).start()
    return dict(ok=True, total=len(times), capped=len(times) >= MAX_PROBES)

def stop():
    STOP.set(); return dict(ok=True)

def status():
    with LOCK: return dict(S, rows=list(S["rows"]))

def saved(url=None, key=None):
    """Every saved result for a link (or a saved key), oldest time first."""
    k = key or _key(url)
    with SLOCK: rows = _store().get(k, {})
    return dict(key=k, rows=[dict(r, saved=True) for _, r in sorted(rows.items())])

def links():
    """Links with saved results: key, times checked, times with video, first and last time."""
    with SLOCK: db = _store()
    out = []
    for k, rows in db.items():
        ts = sorted(rows); rg = []; cur = None
        for t in ts:
            if rows[t]["status"] == "yes": cur = [t, t] if cur is None else [cur[0], t]
            elif cur: rg.append(cur); cur = None
        if cur: rg.append(cur)
        dt = [D.datetime.strptime(b, "%Y-%m-%d %H:%M") - D.datetime.strptime(a, "%Y-%m-%d %H:%M") for a, b in zip(ts, ts[1:])]
        step = min([d for d in dt if d.total_seconds() > 0], default=D.timedelta(hours=1))
        rg = [dict(a=a, b=b, img=rows[a].get("img"), end=(D.datetime.strptime(b, "%Y-%m-%d %H:%M") + step).strftime("%Y-%m-%d %H:%M")) for a, b in rg]
        out.append(dict(key=k, n=len(ts), yes=sum(1 for t in ts if rows[t]["status"] == "yes"), first=ts[0] if ts else "", last=ts[-1] if ts else "", ranges=rg))
    return dict(links=sorted(out, key=lambda x: x["last"], reverse=True))

def _creds():
    """rtsp_user / rtsp_pass from the project's .env (read on every call, never logged or saved)."""
    u = p = None
    try:
        for ln in (C.PROJ / ".env").read_text().splitlines():
            k, _, v = ln.partition("=")
            k = k.strip().lower(); v = v.strip().strip('"').strip("'")
            if k == "rtsp_user": u = v
            if k == "rtsp_pass": p = v
    except OSError: pass
    return u, p

def full_url(key, start, end=None):
    """Complete playback link for a saved key: username and password from .env, plus starttime (and endtime)."""
    from urllib.parse import quote
    u, p = _creds()
    if not u or not p: return dict(ok=False, error="rtsp_user / rtsp_pass not found in the project .env")
    k = re.sub(r"([?&])(starttime|endtime)=[^&]*&?", r"\1", key or "").rstrip("?&")
    if "//***@" not in k: return dict(ok=False, error="Unknown link")
    k = k.replace("//***@", "//" + quote(u, safe="") + ":" + quote(p, safe="") + "@", 1)
    f = lambda t: t.replace("-", "_").replace(":", "_").replace(" ", "_") + "_00"
    url = k + ("&" if "?" in k else "?") + "starttime=" + f(start) + (("&endtime=" + f(end)) if end else "")
    return dict(ok=True, url=url)

TRASH_F = C.ST / "availability_deleted.json"
def delete(key, t=None):
    """Remove a saved link (or one time of it). Removed results go to availability_deleted.json, so a mistake can be undone by hand."""
    with SLOCK:
        db = _store()
        if key not in db: return dict(ok=False, error="Not found")
        if t:
            if t not in db[key]: return dict(ok=False, error="Not found")
            gone = {t: db[key].pop(t)}
            if not db[key]: db.pop(key)
        else: gone = db.pop(key)
        trash = C.jload(TRASH_F, [])
        trash.append(dict(key=key, deleted_at=D.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), rows=gone))
        C.jsave(TRASH_F, trash); C.jsave(STORE_F, db)
    return dict(ok=True, removed=len(gone))

# Held-out test videos served by the sack-rtsp-test container (eval/rtsp_candidates_e13/mediamtx_v007.yml). Never in training.
TEST_STREAMS = [
    dict(name="ch3_0930", length="9 min", note="camera 3, 1-2 Sep, about 13 blue carries (model estimate)"),
    dict(name="ch3_1426", length="30 min", note="camera 3, 1-2 Sep, about 63 blue carries; looks like loading"),
    dict(name="ch3_1545", length="45 min", note="camera 3, 1-2 Sep, about 102 blue carries; busiest"),
    dict(name="ch3_1245", length="45 min", note="camera 3, 1-2 Sep, stored at 5 fps, not like a live camera"),
    dict(name="ch4_20261007_0032", length="12.5 min", note="camera 4, 7 Oct, starts at clock 00:32:34 (first 30 s skipped), 704x576 sub-stream, same time as the ch5 one"),
    dict(name="ch5_20261007_0032", length="12.5 min", note="camera 5, 7 Oct, starts at clock 00:32:34 (first 30 s skipped), 704x576 sub-stream, same time as the ch4 one"),
]
def test_streams():
    """The test links and whether the stream server answers (a plain TCP connect, no video is pulled)."""
    import socket
    try: socket.create_connection(("10.1.1.147", 8554), timeout=2).close(); live = True
    except OSError: live = False
    return dict(live=live, streams=[dict(s, url="rtsp://10.1.1.147:8554/" + s["name"]) for s in TEST_STREAMS])
