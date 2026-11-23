"""RTSP recorder: record several camera streams at once into video files.

One recording session at a time. Each camera gets its own ffmpeg process writing
DATA_DIR/recordings/<session>/<camera>_partNNN.mp4.

- fps and frame width both empty -> the stream is copied as-is (no re-encode, almost no CPU).
- fps set and/or width set        -> re-encoded with libx264 at that rate / width (height keeps the aspect ratio);
                                     CPU cost grows with cameras x resolution.
- Files are fragmented MP4, so a clip is playable even if the server or ffmpeg dies mid-recording.
- If a stream drops, the camera reconnects automatically into the next part file
  (up to MAX_RESTARTS times), so a long recording survives network hiccups.
- Stop sends ffmpeg a clean 'q' so every file is finalised.
- session.json keeps each camera link exactly as entered (incl. password) so it can be shown and re-used;
  live status and logs show links masked (***). Keep the data folder private (it is git-ignored).
"""
import json, os, re, subprocess, threading, time
from datetime import datetime
from pathlib import Path

from config import DATA_DIR, ffmpeg_bin

REC_DIR = DATA_DIR / "recordings"
REC_DIR.mkdir(parents=True, exist_ok=True)
MAX_CAMS = 16
MAX_RESTARTS = 50
RESTART_DELAY_S = 3
LOCK = threading.Lock()
S = {"session": None, "running": False, "cams": [], "fps": None, "width": None, "started": None}


def is_playback(url):
    """Recorded-footage links (Dahua /cam/playback, or any link with starttime=) end by themselves; they must not be reconnected."""
    u = (url or "").lower()
    return "/cam/playback" in u or "starttime=" in u


def last_error(log_path):
    try:
        lines = [l for l in Path(log_path).read_text(errors="ignore").splitlines() if l.strip() and not l.startswith("===")]
        return mask(lines[-1])[-200:] if lines else ""
    except Exception:
        return ""


def mask(url):
    return re.sub(r"//[^/@\s]+@", "//***@", url or "")


def _safe(name, i):
    n = re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "").strip()).strip("_")
    return n or f"cam{i + 1}"


def _cmd(url, out, fps, width=None):
    ff = ffmpeg_bin()
    c = [ff, "-hide_banner", "-loglevel", "warning"]
    if url.lower().startswith("rtsp"):
        c += ["-rtsp_transport", "tcp", "-timeout", "15000000"]   # 15 s socket timeout -> dead stream ends the process
    c += ["-i", url, "-map", "0:v:0", "-an"]
    vf = ([f"fps={fps}"] if fps else []) + ([f"scale={width}:-2"] if width else [])   # -2 keeps aspect, even height
    if vf:
        c += ["-vf", ",".join(vf), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
              "-force_key_frames", "expr:gte(t,n_forced*2)"]   # keyframe every 2 s -> file grows/stays playable every 2 s
    else:
        c += ["-c:v", "copy"]
    c += ["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", str(out)]
    return c


def _launch(cam):
    cam["part"] += 1
    out = cam["dir"] / f"{cam['name']}_part{cam['part']:03d}.mp4"
    log = open(cam["dir"] / f"{cam['name']}.log", "ab")
    log.write(f"\n=== {datetime.now():%F %T} part {cam['part']}: {mask(cam['url'])} ===\n".encode())
    cam["proc"] = subprocess.Popen(_cmd(cam["url"], out, S["fps"], S["width"]), stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=log)
    cam["log"] = log
    cam["files"].append(out.name)
    cam["part_started"] = time.time()


def _watch():
    """Reconnect cameras whose ffmpeg exited while the session is still running."""
    while True:
        time.sleep(1)
        with LOCK:
            if not S["running"]:
                return
            for cam in S["cams"]:
                p = cam["proc"]
                if cam["state"] in ("failed", "finished") or (p is not None and p.poll() is None):
                    continue
                if p is not None:                      # just exited: record it, wait before reconnecting
                    cam["exit_codes"].append(p.returncode)
                    cam["log"].close()
                    cam["proc"] = None
                    cam["exited_at"] = time.time()
                    if is_playback(cam["url"]):        # playback reached its end (or was refused): never re-record it
                        cam["state"] = "finished" if p.returncode == 0 else "failed"
                        _write_meta()
                    else:
                        cam["state"] = "failed" if cam["restarts"] >= MAX_RESTARTS else "reconnecting"
                    continue
                if cam["state"] in ("finished",):
                    continue
                if time.time() - cam.get("exited_at", 0) >= RESTART_DELAY_S:
                    cam["restarts"] += 1
                    _launch(cam)
                    cam["state"] = "recording"
                    _write_meta()


def start(cams, fps=None, width=None):
    if not ffmpeg_bin():
        return dict(ok=False, error="ffmpeg not found - set FFMPEG_BIN")
    cams = [c for c in (cams or []) if (c.get("url") or "").strip()]
    if not cams:
        return dict(ok=False, error="add at least one RTSP link")
    if len(cams) > MAX_CAMS:
        return dict(ok=False, error=f"at most {MAX_CAMS} cameras")
    try:
        fps = float(fps) if fps not in (None, "", 0, "0") else None
    except ValueError:
        return dict(ok=False, error="fps must be a number")
    if fps is not None and not (0 < fps <= 60):
        return dict(ok=False, error="fps must be between 0 and 60 (empty = original)")
    try:
        width = int(width) if width not in (None, "", 0, "0", "original") else None
    except ValueError:
        return dict(ok=False, error="frame width must be a whole number")
    if width is not None:
        if not (160 <= width <= 3840):
            return dict(ok=False, error="frame width must be between 160 and 3840 px (empty = original)")
        width -= width % 2
    with LOCK:
        if S["running"]:
            return dict(ok=False, error="a recording is already running - stop it first")
        sid = datetime.now().strftime("%Y%m%d_%H%M%S")
        d = REC_DIR / sid
        d.mkdir(parents=True, exist_ok=False)
        names = set()
        S.update(session=sid, running=True, fps=fps, width=width, started=time.time(), cams=[], stopped=None)
        for i, c in enumerate(cams):
            n = _safe(c.get("name"), i)
            while n in names:
                n += "_b"
            names.add(n)
            cam = dict(name=n, url=c["url"].strip(), dir=d, part=0, files=[], restarts=0, exit_codes=[],
                       state="recording", proc=None)
            _launch(cam)
            S["cams"].append(cam)
        _write_meta()
    threading.Thread(target=_watch, daemon=True).start()
    return dict(ok=True, session=sid)


def stop():
    with LOCK:
        if not S["running"]:
            return dict(ok=False, error="nothing is recording")
        S["running"] = False
        procs = [c for c in S["cams"] if c["proc"] is not None and c["proc"].poll() is None]
    for c in procs:                       # ask every ffmpeg to finish its file cleanly
        try:
            c["proc"].stdin.write(b"q")
            c["proc"].stdin.flush()
        except Exception:
            pass
    deadline = time.time() + 15
    for c in procs:
        try:
            c["proc"].wait(timeout=max(0.1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            c["proc"].terminate()
            try:
                c["proc"].wait(timeout=5)
            except subprocess.TimeoutExpired:
                c["proc"].kill()
    with LOCK:
        for c in S["cams"]:
            if c["proc"] is not None:
                c["exit_codes"].append(c["proc"].returncode)
                c["log"].close()
                c["proc"] = None
            c["state"] = "stopped"
        S["stopped"] = time.time()
        _write_meta()
        sid = S["session"]
    return dict(ok=True, session=sid, files=session_files(sid))


def _write_meta():
    d = REC_DIR / S["session"]
    meta = dict(session=S["session"], fps=S["fps"] or "original", width=S["width"] or "original",
                started=datetime.fromtimestamp(S["started"]).isoformat(timespec="seconds"),
                stopped=datetime.fromtimestamp(S["stopped"]).isoformat(timespec="seconds") if S.get("stopped") and not S["running"] else None,
                cameras=[dict(name=c["name"], url=c["url"], files=c["files"], reconnects=c["restarts"]) for c in S["cams"]])   # full link as entered (user choice 2026-10-06)
    (d / "session.json").write_text(json.dumps(meta, indent=1))


def session_files(sid):
    d = REC_DIR / sid
    return [dict(name=f.name, bytes=f.stat().st_size) for f in sorted(d.glob("*.mp4"))]


def status():
    with LOCK:
        cams = []
        for c in S["cams"]:
            size = sum((c["dir"] / f).stat().st_size for f in c["files"] if (c["dir"] / f).exists())
            last = ""
            try:
                last = (c["dir"] / f"{c['name']}.log").read_text(errors="ignore").strip().splitlines()[-1][-160:]
            except Exception:
                pass
            cams.append(dict(name=c["name"], url=mask(c["url"]), state=c["state"], parts=len(c["files"]),
                             reconnects=c["restarts"], bytes=size, last_log=mask(last)))
        el = (time.time() if S["running"] else S.get("stopped", time.time())) - S["started"] if S["started"] else 0
        return dict(running=S["running"], session=S["session"], fps=S["fps"], width=S["width"], elapsed_s=int(el), cams=cams,
                    ffmpeg=bool(ffmpeg_bin()))


def sessions():
    out = []
    for d in sorted(REC_DIR.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        meta = {}
        try:
            meta = json.loads((d / "session.json").read_text())
        except Exception:
            pass
        files = session_files(d.name)
        errors = {}
        for c in meta.get("cameras", []):
            mine = set(c.get("files") or [])         # files may have been renamed; session.json keeps the current names
            if not any((f["name"] in mine or f["name"].startswith(c["name"] + "_part")) and f["bytes"] > 0 for f in files):
                errors[c["name"]] = last_error(d / f"{c['name']}.log") or "no video received"
        out.append(dict(session=d.name, started=meta.get("started"), stopped=meta.get("stopped"), errors=errors,
                        fps=meta.get("fps"), width=meta.get("width", "original"), cameras=[c["name"] for c in meta.get("cameras", [])],
                        links=[dict(name=c["name"], url=c.get("url", ""), files=c.get("files", [])) for c in meta.get("cameras", [])],
                        files=files, bytes=sum(f["bytes"] for f in files),
                        active=(S["running"] and S["session"] == d.name)))
    return out


def file_path(sid, name):
    """Resolve a download request safely (no path traversal)."""
    if not re.fullmatch(r"\d{8}_\d{6}", sid or "") or not re.fullmatch(r"[A-Za-z0-9_-]+\.(mp4|log|json)", name or ""):
        return None
    p = (REC_DIR / sid / name).resolve()
    return p if p.is_file() and p.parent.parent == REC_DIR.resolve() else None


def delete(sid, name=None):
    """Delete a whole session folder, or one video file in it. Never the session that is recording."""
    if not re.fullmatch(r"\d{8}_\d{6}", sid or ""):
        return dict(ok=False, error="bad session id")
    with LOCK:
        if S["running"] and S["session"] == sid:
            return dict(ok=False, error="this session is still recording - stop it first")
    d = (REC_DIR / sid).resolve()
    if d.parent != REC_DIR.resolve() or not d.is_dir():
        return dict(ok=False, error="session not found")
    if name:
        f = file_path(sid, name)
        if f is None or f.suffix != ".mp4":
            return dict(ok=False, error="file not found")
        f.unlink()
        return dict(ok=True, deleted=f"{sid}/{name}")
    for f in d.iterdir():                 # flat folder: videos, logs, session.json
        if f.is_file():
            f.unlink()
    d.rmdir()
    return dict(ok=True, deleted=sid)


def rename(sid, name, new):
    """Rename one recorded video inside its session folder (never overwrites; not while that session records).
    session.json is updated so the camera still owns the file. Returns the old and new file names."""
    new = re.sub(r"\.mp4$", "", (new or "").strip(), flags=re.I)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", new):
        return dict(ok=False, error="new name may use only letters, digits, _ and - (1-80 characters)")
    new += ".mp4"
    with LOCK:
        if S["running"] and S["session"] == sid:
            return dict(ok=False, error="this session is still recording - stop it first")
        f = file_path(sid, name)
        if f is None or f.suffix != ".mp4":
            return dict(ok=False, error="file not found")
        if new == f.name:
            return dict(ok=True, old=name, new=new)
        t = f.with_name(new)
        if t.exists():
            return dict(ok=False, error=f"{new} already exists in this session")
        os.link(f, t)                  # hard link + unlink = rename that can never replace an existing file
        f.unlink()
        mp = f.parent / "session.json"
        try:
            meta = json.loads(mp.read_text())
            for c in meta.get("cameras", []):
                c["files"] = [new if x == name else x for x in c.get("files", [])]
            tmp = mp.with_name(".session.json.tmp"); tmp.write_text(json.dumps(meta, indent=1)); os.replace(tmp, mp)
        except Exception:
            pass
    return dict(ok=True, old=name, new=new)
