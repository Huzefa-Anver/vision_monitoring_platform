"""Tab 12 "Serve videos as RTSP": play saved video files as RTSP camera streams (MediaMTX in Docker).

Each stream = one video file + how it is played:
  start     on_connect  starts from the beginning when the first viewer connects; stops idle_close_s after the last leaves
            always      plays all the time, like a live camera (a viewer joins wherever it is)
  end       stop        the stream ends after the last frame
            loop        goes straight back to the start point
            freeze_stop holds the last frame for freeze_s seconds, then ends
            freeze_loop holds the last frame for freeze_s seconds, then goes back to the start point (no disconnect)
  skip_s    start this many seconds into the video (also the loop point). In loop modes the jump lands on the key frame
            at or before skip_s, so it can be up to one key-frame gap early.
  reencode  H.264 with a key frame every second. Needed for every mode except "stop" (tested 2026-11-12: looping a copied
            stream fast-forwards at the loop point, and freezing needs new frames). Costs about half a CPU core per 1080p stream.

Only the one container named CONTAINER is ever started or stopped here. Config: DATA_DIR/rtsp_serve/live/mediamtx.yml (the
server reloads it by itself when it changes; a changed stream restarts and its viewers are disconnected, others keep
playing); every saved version is also kept in DATA_DIR/rtsp_serve/history/.
"""
import base64, hashlib, json, os, re, shlex, socket, subprocess, threading, time, urllib.request
from pathlib import Path

import core as C, recorder as REC
from config import DATA_DIR, PORT as PLATFORM_PORT, ffmpeg_bin

VIDEO_DIR = Path(os.environ.get("RTSP_VIDEO_DIR", str(DATA_DIR / "incoming_videos"))).expanduser()   # set per server in .env
RAW_DIR = DATA_DIR / "raw_videos"           # tab 7 uploads + videos made from frames (/raw in the container)
RAW_DIR.mkdir(parents=True, exist_ok=True)
CONTAINER = os.environ.get("RTSP_CONTAINER", "sack-rtsp-test")
IMAGE = os.environ.get("RTSP_IMAGE", "bluenviron/mediamtx:latest")
HOST = os.environ.get("RTSP_HOST", "127.0.0.1")          # address the RTSP port is published on (LAN)
PORT = int(os.environ.get("RTSP_PORT", "8554"))
API_PORT = int(os.environ.get("RTSP_API_PORT", "9997"))   # status API, published on 127.0.0.1 only
MEM = os.environ.get("RTSP_MEM", "4g")   # container RAM cap; one 3200x1800 re-encoded stream needs ~0.6-1 GB (2026-11-12: 1g OOM-killed a 2-stream group)
BASE = DATA_DIR / "rtsp_serve"; LIVE = BASE / "live"; HIST = BASE / "history"; CLIPS = LIVE / "clips"   # /cfg/clips in the container
for d in (LIVE, HIST, CLIPS): d.mkdir(parents=True, exist_ok=True)
STATE = C.ST / "rtsp_streams.json"
VIDEO_EXT = {".mp4", ".mkv", ".mov", ".avi", ".ts", ".m4v"}
STARTS = ("on_connect", "always"); ENDS = ("stop", "loop", "freeze_stop", "freeze_loop")
LOCK = threading.RLock(); _PROBE = {}

# The six test streams served by hand from eval/rtsp_candidates_e13/mediamtx_v007.yml (2026-11-10), as the first state.
DEFAULT = [
    dict(name="ch3_0930", file="ch3_0930_raw.mp4", note="camera 3, 1-2 Sep, about 13 blue carries (model estimate)"),
    dict(name="ch3_1426", file="ch3_1426_raw.mp4", note="camera 3, 1-2 Sep, about 63 blue carries; looks like loading"),
    dict(name="ch3_1545", file="ch3_1545.mp4", note="camera 3, 1-2 Sep, about 102 blue carries; busiest"),
    dict(name="ch3_1245", file="ch3_1245_5fps.mp4", reencode=True, note="camera 3, 5 fps file with a key frame every 50 s, so it is re-encoded"),
    dict(name="ch4_20261007_0032", file="ch4_20261007_0032.mp4", skip_s=30, note="camera 4, 7 Oct 00:32, same time as ch5; first 30 s empty"),
    dict(name="ch5_20261007_0032", file="ch5_20261007_0032.mp4", skip_s=30, note="camera 5, 7 Oct 00:32, same time as ch4; first 30 s empty"),
]


def _multi(s):
    return len(s.get("parts") or []) >= 1


def _norm(s):
    s = dict(s); g = s.get
    return dict(name=str(g("name") or "").strip(), file=str(g("file") or "").strip(), enabled=bool(g("enabled", True)),
                start=g("start") if g("start") in STARTS else "on_connect", end=g("end") if g("end") in ENDS else "stop",
                freeze_s=float(g("freeze_s") or 60), skip_s=float(g("skip_s") or 0), end_s=float(g("end_s") or 0), reencode=bool(g("reencode", False)),
                idle_close_s=int(float(g("idle_close_s") or 15)), note=str(g("note") or ""),
                group=re.sub(r"[^A-Za-z0-9_-]", "", str(g("group") or ""))[:32],
                parts=_norm_parts(g("parts")), offset_s=float(g("offset_s") or 0), wait_longest=bool(g("wait_longest", False)),
                auth_on=bool(g("auth_on", False)), public=bool(g("public", False)))   # use the top user/password; reachable from outside


def _norm_parts(v):
    """[[start, end] or [start, end, 1 = played backwards], ...] in play order (parts of the same video); [] = use skip_s / end_s."""
    out = []
    for x in (v or [])[:50]:
        try: a, b = float(x[0]), float(x[1])
        except (TypeError, ValueError, IndexError): continue
        out.append([round(a, 3), round(b, 3)] + ([1] if len(x) > 2 and x[2] else []))
    return out


def load():
    with LOCK:
        d = C.jload(STATE, None)
        return [_norm(s) for s in (d if d is not None else DEFAULT)]


# ---------------- videos ----------------
# A stream's "file" is either a name in VIDEO_DIR, or "rec/<session>/<name>.mp4" for a video recorded in tab 8
# (served from DATA_DIR/recordings, mounted read-only at /rec in the container).
def _rec(f):
    return re.fullmatch(r"rec/(\d{8}_\d{6})/([A-Za-z0-9_-]+\.mp4)", f or "")


def _raw(f):
    return re.fullmatch(r"raw/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)", f or "")


def host_path(f):
    m = _rec(f)
    if m: return REC.REC_DIR / m[1] / m[2]
    r = _raw(f)
    return RAW_DIR / r[1] if r else VIDEO_DIR / f


def ctr_path(f):
    m = _rec(f)
    if m: return f"/rec/{m[1]}/{m[2]}"
    r = _raw(f)
    return f"/raw/{r[1]}" if r else f"/video/{f}"


def label(f):
    m = _rec(f)
    if m: return f"{m[1]} / {m[2]}"
    r = _raw(f)
    return f"raw / {r[1]}" if r else f


def resolve(f):
    """Path of a video the page may play (tab 12 picker): a file directly in VIDEO_DIR or a tab 8 recording; else None."""
    m = _rec(f)
    if m: return REC.file_path(m[1], m[2])
    r = _raw(f)
    if r:
        p = RAW_DIR / r[1]
        return p if p.is_file() and p.suffix.lower() in VIDEO_EXT else None
    if not f or "/" in f or "\\" in f or f.startswith("."): return None
    p = VIDEO_DIR / f
    return p if p.is_file() and p.suffix.lower() in VIDEO_EXT else None


def probe(f):
    """Duration, codec, size, fps and key-frame gap of one file (cached by size + mtime)."""
    p = host_path(f); st = p.stat(); key = (f, st.st_size, st.st_mtime)
    if key in _PROBE: return _PROBE[key]
    ff = ffmpeg_bin(); info = dict(file=f, size_mb=round(st.st_size / 2**20))
    try:
        txt = subprocess.run([ff, "-hide_banner", "-i", str(p)], capture_output=True, text=True, timeout=30).stderr
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", txt)
        if m: info["duration_s"] = round(int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]), 2)
        m = re.search(r"Video: (\w+).*?, (\d{2,5})x(\d{2,5})", txt)
        if m: info.update(codec=m[1], width=int(m[2]), height=int(m[3]))
        m = re.search(r"([\d.]+) fps", txt)
        if m: info["fps"] = float(m[1])
        kf = subprocess.run([ff, "-hide_banner", "-skip_frame", "nokey", "-t", "120", "-i", str(p), "-vf", "showinfo", "-an", "-f", "null", "-"],
                            capture_output=True, text=True, timeout=60).stderr
        t = [float(x) for x in re.findall(r"pts_time:([\d.]+)", kf)]
        if len(t) >= 2: info["keyframe_gap_s"] = round(max(b - a for a, b in zip(t, t[1:])), 2)
        elif info.get("duration_s"): info["keyframe_gap_s"] = min(120.0, info["duration_s"])
    except Exception as e:
        info["error"] = str(e)
    _PROBE[key] = info; return info


def videos():
    out = []
    if VIDEO_DIR.is_dir():
        fs = sorted(p.name for p in VIDEO_DIR.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXT and not p.name.startswith("."))
        out += [dict(probe(f), source="folder", label=f) for f in fs]
    for p in sorted(RAW_DIR.iterdir()):
        if p.is_file() and p.suffix.lower() in VIDEO_EXT and not p.name.startswith(".") and p.stat().st_size > 0:
            f = f"raw/{p.name}"; out.append(dict(probe(f), source="raw", label=label(f)))
    busy = REC.S["session"] if REC.S["running"] else None          # a session still recording is not offered
    for d in sorted((x for x in REC.REC_DIR.iterdir() if x.is_dir() and re.fullmatch(r"\d{8}_\d{6}", x.name)), reverse=True):
        if d.name == busy: continue
        try: cams = json.loads((d / "session.json").read_text()).get("cameras", [])
        except Exception: cams = []
        for p in sorted(d.glob("*.mp4")):
            src = next((c.get("url", "") for c in cams if p.name in (c.get("files") or []) or p.name.startswith(c.get("name", "?") + "_part")), "")
            if re.fullmatch(r"[A-Za-z0-9_-]+\.mp4", p.name) and p.stat().st_size > 0:
                f = f"rec/{d.name}/{p.name}"; out.append(dict(probe(f), source="recording", session=d.name, label=label(f), rtsp=src))
    return dict(dir=str(VIDEO_DIR), rec_dir=str(REC.REC_DIR), videos=out,
                error=None if VIDEO_DIR.is_dir() else f"folder not found: {VIDEO_DIR}")


# ---------------- config ----------------
def _check(streams):
    errs = []; names = set(); have = {v["file"] for v in videos()["videos"]}
    for s in streams:
        n = s["name"]
        if not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", n): errs.append(f"'{n}': name may only use letters, digits, _ and -")
        if n in names: errs.append(f"'{n}': name used twice")
        names.add(n)
        if s["file"] not in have: errs.append(f"'{n}': video '{label(s['file'])}' not found (renamed or deleted?)")
        if s["end"] != "stop" and not s["reencode"]: errs.append(f"'{n}': loop and freeze need re-encoding")
        wl = s["wait_longest"] and s["group"]          # then freeze_s is only the extra freeze for the whole group, 0 allowed
        if s["end"].startswith("freeze") and not ((0 if wl else 1) <= s["freeze_s"] <= 86400): errs.append(f"'{n}': freeze must be {'0 s' if wl else '1 s'} to 24 h")
        if s["skip_s"] < 0: errs.append(f"'{n}': skip must be >= 0")
        if s["end_s"] < 0: errs.append(f"'{n}': play-until must be >= 0 (0 = to the end)")
        if s["end_s"] > 0 and s["end_s"] < s["skip_s"] + 1: errs.append(f"'{n}': play-until ({s['end_s']:g} s) must be at least 1 s after the start ({s['skip_s']:g} s)")
        if s["auth_on"] and not auth()["set"]: errs.append(f"'{n}': password ticked, but no user name / password is set at the top (RTSP server box)")
        if s["public"] and not s["auth_on"]: errs.append(f"'{n}': public (internet) needs 'password' ticked on this stream")
        if s["public"] and s["enabled"] and not auth()["public_host"]: errs.append(f"'{n}': public: type the public address in the server box first")
        if not (5 <= s["idle_close_s"] <= 3600): errs.append(f"'{n}': stop-after-idle must be 5-3600 s")
        if s["group"] and not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", s["group"]): errs.append(f"'{n}': sync group name may only use letters, digits, _ and -")
        d = probe(s["file"]).get("duration_s") if s["file"] in have else None
        if d and s["skip_s"] >= d - 1 and not _multi(s): errs.append(f"'{n}': skip {s['skip_s']} s is past the end of the video ({d} s)")
        if d and s["end_s"] > d + 0.5 and not _multi(s): errs.append(f"'{n}': play-until {s['end_s']:g} s is past the end of the video ({d} s)")
        for k, (a, b, *_) in enumerate(s["parts"], 1):
            if a < 0 or b < a + 0.5: errs.append(f"'{n}': part {k} ({a:g}-{b:g} s) must start at >= 0 and last at least 0.5 s")
            if d and b > d + 0.5: errs.append(f"'{n}': part {k} ends at {b:g} s, past the end of the video ({d} s)")
    for g, ms in groups(streams).items():
        if len(ms) < 2: continue
        a = ms[0]; L = lambda x: _len(x)
        for m in ms[1:]:
            if m["start"] != a["start"]: errs.append(f"sync group '{g}': '{m['name']}' must use the same 'Starts' setting as '{a['name']}'")
        wait = a["wait_longest"]
        for m in ms[1:]:
            if m["wait_longest"] != wait: errs.append(f"sync group '{g}': 'shorter streams wait for the longest' must be set the same on '{m['name']}' as on '{a['name']}'")
        if wait:
            for m in ms:
                if not _len(m): errs.append(f"sync group '{g}': the length of '{m['name']}' is unknown, so the others cannot wait for it")
        for m in ms[1:]:
            if m["end"] != a["end"] or (a["end"].startswith("freeze") and m["freeze_s"] != a["freeze_s"]):
                errs.append(f"sync group '{g}': '{m['name']}' must use the same 'at the end' setting{' and freeze time' if a['end'].startswith('freeze') else ''} as '{a['name']}'")
            if not wait and L(a) and L(m) and abs(L(a) - L(m)) > 0.05:
                errs.append(f"sync group '{g}': '{m['name']}' plays {L(m):.1f} s but '{a['name']}' plays {L(a):.1f} s; streams in one group must play the same length (or turn on 'shorter streams wait for the longest')")
    return errs


def groups(streams):
    """Enabled streams that share a sync group name, in list order (first = the one whose path starts the group)."""
    out = {}
    for s in streams:
        if s["enabled"] and s["group"]: out.setdefault(s["group"], []).append(s)
    return out


def wait_plan(ms):
    """Sync group with 'shorter streams wait for the longest': each member's end setting and freeze time as actually played.
    Every member gets the same end type with freeze = (longest length - own length) + the group's extra freeze, so all of
    them run the same cycle length and restart on the same frame. 'loop' becomes freeze_loop and 'stop' freeze_stop."""
    if len(ms) < 2 or not ms[0]["wait_longest"]: return ms
    Ls = [_len(m) or 0 for m in ms]; top = max(Ls); out = []
    extra = ms[0]["freeze_s"] if ms[0]["end"].startswith("freeze") else 0.0      # the group's extra freeze = the first stream's
    for m, L in zip(ms, Ls):
        m = dict(m)
        m["end"] = "freeze_loop" if m["end"] in ("loop", "freeze_loop") else "freeze_stop"
        m["freeze_s"] = round(top - L + extra, 3); out.append(m)
    return out


def _len(s):
    """How many seconds of video the stream plays (start..end), or None if the length is unknown."""
    if _multi(s): return sum(p[1] - p[0] for p in s["parts"])
    d = (probe(s["file"]).get("duration_s") if host_path(s["file"]).is_file() else None) or 0
    e = s["end_s"] if s["end_s"] > s["skip_s"] else d
    return (e - s["skip_s"]) if e else None


# ---------------- exact loop clips ----------------
# The concat demuxer starts every loop pass at the key frame BEFORE the start point, and those extra frames are played
# (tested 2026-11-12: a file with a key frame every 10 s looped from 0 s instead of 3 s, so each pass was 3 s longer and a
# sync group drifted apart). So a loop that starts inside a video plays a clip cut once, frame-exact, from start to end,
# whose first frame is a key frame. Clips live in LIVE/clips, named by stream + source file state + start/end; they are
# never deleted automatically.
JOB = dict(running=False, gen=0, total=0, done=0, cur="", err=None, applied=None)


def _needs_clip(s):
    return s["enabled"] and (_multi(s) or (s["end"] in ("loop", "freeze_loop") and s["skip_s"] > 0))


def _clip_name(s):
    p = host_path(s["file"]); st = p.stat(); e = s["end_s"] if s["end_s"] > s["skip_s"] else 0
    rng = ";".join(f"{p[0]:.3f}-{p[1]:.3f}{'r' if len(p) > 2 else ''}" for p in s["parts"]) if _multi(s) else f"{s['skip_s']:.3f}|{e:.3f}"
    # "v2": clips cut before 2026-11-13 lost their start time (they began at 0:00), so they must never be reused
    k = hashlib.md5(f"v2|{s['file']}|{st.st_size}|{st.st_mtime}|{rng}".encode()).hexdigest()[:10]
    return f"{s['name']}_{k}.mp4"


def _gray(path, t):
    """64x36 grey thumbnail bytes of the frame at t seconds (for checking a clip against its source)."""
    r = subprocess.run([ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                        "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"], capture_output=True, timeout=120)
    return r.stdout if len(r.stdout) == 64 * 36 else None


REV_CHUNK = 2.0     # a backwards part is reversed in pieces of this many seconds (ffmpeg's reverse holds a whole piece in RAM)


def _cut(s):
    """Cut the stream's part(s) of its video into one clip in CLIPS (H.264, key frame every second, original size), frame-exact:
    one start..end, or several parts joined in the listed order; a part marked backwards plays in reverse. Each part (and each
    2 s piece of a backwards part) is encoded on its own, then the pieces are joined without re-encoding. Finally the clip's
    first frame is checked against the source frame it must show. Returns an error text or None."""
    info = probe(s["file"]); fps = info.get("fps") or 25; gop = max(1, round(fps)); src = str(host_path(s["file"]))
    out = CLIPS / _clip_name(s); tmp = CLIPS / ("." + out.name + ".part.mp4"); wd = CLIPS / ("." + out.stem + ".pieces")
    parts = s["parts"] if _multi(s) else [[s["skip_s"], s["end_s"] if s["end_s"] > s["skip_s"] else (info.get("duration_s") or 0)]]
    enc = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
           "-pix_fmt", "yuv420p", "-r", f"{fps:g}", "-threads", "4"]
    run = lambda args: subprocess.run(["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=3G", "nice", "-n", "10",   # RAM cap: no swap
                                       ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y"] + args, capture_output=True, text=True)
    pieces = []                                             # (start, length, backwards) in play order
    for p in parts:
        a, b, back = p[0], p[1], len(p) > 2
        if not back: pieces.append((a, b - a, False)); continue
        t = b
        while t > a + 1e-3:                                 # last piece first, each one reversed
            c = max(a, t - REV_CHUNK); pieces.append((c, t - c, True)); t = c
    wd.mkdir(exist_ok=True); files = []
    try:
        for k, (a, L, back) in enumerate(pieces):
            f = wd / f"{k:04d}.mp4"
            r = run(["-ss", f"{a:.3f}", "-t", f"{L:.3f}", "-i", src, "-map", "0:v:0"] + (["-vf", "reverse"] if back else []) + enc + [str(f)])
            if r.returncode != 0 or not f.exists(): return (r.stderr.strip()[-300:] or "ffmpeg failed") + f" (piece {k + 1} of {len(pieces)})"
            files.append(f)
        lst = wd / "list.ffconcat"; lst.write_text("ffconcat version 1.0\n" + "".join(f"file {f.name}\n" for f in files))
        r = run(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(tmp)])
        if r.returncode != 0 or not tmp.exists(): return r.stderr.strip()[-300:] or "joining the pieces failed"
    finally:
        for f in list(wd.glob("*")): f.unlink(missing_ok=True)      # this job's own temporary pieces
        try: wd.rmdir()
        except OSError: pass
    first = parts[0]; want = (first[1] - 1.0 / fps) if len(first) > 2 else first[0]   # a backwards part starts on its last frame
    a0, b0 = _gray(tmp, 0), _gray(src, max(0.0, want))
    if a0 and b0 and sum(abs(x - y) for x, y in zip(a0, b0)) / len(a0) > 8:
        tmp.unlink(missing_ok=True); return f"check failed: the cut clip does not start at {want:g} s of the video"
    os.replace(tmp, out); return None


def _parts(s, k=0, force_reencode=False, host=False):
    """Input options, output options and playlist (or None) for one stream; k = its input number in the ffmpeg command.
    host=True: paths and target for an ffmpeg run on this machine (on-connect sync groups) instead of in the container."""
    info = probe(s["file"]); fps = info.get("fps") or 25; dur = info.get("duration_s") or 0
    src = shlex.quote(str(host_path(s["file"]))) if host else ctr_path(s["file"])
    out = f"-f rtsp -rtsp_transport tcp rtsp://{HOST if host else '127.0.0.1'}:{PORT if host else 8554}/{s['name']}"; sk = s["skip_s"]; ss = f"-ss {sk:g} " if sk > 0 else ""
    e = s["end_s"] if s["end_s"] > sk else 0; ss += f"-t {e - sk:.3f} " if e else ""     # play only start..end
    stop_at = e or dur
    if _multi(s):                                # several parts: always the joined clip (cut by save), played from its start
        dur = _len(s) or 0; src = shlex.quote(str(CLIPS / _clip_name(s))) if host else f"/cfg/clips/{_clip_name(s)}"
        sk, e, ss, stop_at = 0, 0, "", dur
    br = "3M" if (info.get("height") or 1080) >= 900 else "1500k"; gop = max(1, round(fps))
    enc = (f"-map {k}:v:0 -an -c:v libx264 -preset veryfast -tune zerolatency -b:v {br} -maxrate {br} -bufsize {br} "
           f"-g {gop} -keyint_min {gop} -sc_threshold 0 -pix_fmt yuv420p -threads 2")
    if s["end"] == "stop":
        if not (s["reencode"] or force_reencode): return f"-re {ss}-i {src}", f"-map {k}:v:0 -an -c copy {out}", None
        return f"{ss}-i {src}", f"-vf realtime {enc} {out}", None
    if s["end"] == "freeze_stop":
        return f"{ss}-i {src}", f"-vf tpad=stop_mode=clone:stop_duration={s['freeze_s']:g},realtime {enc} {out}", None
    # loops: a playlist of the same file from the skip point, looped forever; for freeze_loop the first entry is declared
    # freeze_s longer than it is and a 0.1 s piece from the start point follows, so the gap sits inside the loop and the fps
    # filter fills it with copies of the last frame (paced by realtime). Tested 2026-11-12, no disconnect at the loop point.
    # The concat demuxer starts each pass at the key frame before inpoint, with those extra frames timed before the pass;
    # fps start_time=0 drops them on the first pass (later passes drop them because they are behind), so each pass starts
    # on the exact start frame.
    if sk > 0:                                   # frame-exact clip of start..end (see _needs_clip); it starts on a key frame
        L = _len(s) or 0; src = shlex.quote(str(CLIPS / _clip_name(s))) if host else f"/cfg/clips/{_clip_name(s)}"; stop_at, sk, e = L, 0, 0
    pl = ["ffconcat version 1.0", f"file {src}"] + ([f"inpoint {sk:g}"] if sk > 0 else []) + ([f"outpoint {e:g}"] if e else [])
    if s["end"] == "loop":
        if stop_at: pl.append(f"duration {stop_at - sk:.3f}")
    else:
        pl += [f"duration {stop_at - sk + s['freeze_s']:.3f}", f"file {src}", f"inpoint {sk:g}", f"outpoint {sk + 0.1:g}", "duration 0.1"]
    pl = "\n".join(pl) + "\n"; fn = f"{s['name']}_{hashlib.md5(pl.encode()).hexdigest()[:8]}.ffconcat"   # new name per content, so a
    lp = shlex.quote(str(LIVE / fn)) if host else f"/cfg/{fn}"
    return f"-stream_loop -1 -f concat -safe 0 -i {lp}", f"-vf fps={fps:g}:start_time=0,realtime {enc} {out}", (fn, pl)  # skip/freeze change restarts it


HEAD = "/ffmpeg -hide_banner -loglevel warning -nostdin"


def _cmd(s):
    """ffmpeg command run inside the container for one stream, and the playlist file it needs (or None)."""
    i, o, pl = _parts(s)
    return f"{HEAD} {i} {o}", pl


def _group_cmd(ms, host=False):
    """One ffmpeg for every stream of a sync group: all inputs open before any frame is sent, and each output is paced
    against the same clock from the same moment, so the streams start, loop and freeze together. Always re-encoded."""
    ins, outs, pls = [], [], []; ms = wait_plan(ms)
    for k, s in enumerate(ms):
        i, o, pl = _parts(s, k, force_reencode=True, host=host); ins.append(i); outs.append(o)
        if pl: pls.append(pl)
    head = f"{shlex.quote(ffmpeg_bin())} -hide_banner -loglevel warning -nostdin" if host else HEAD
    tok = (C.jload(RESTARTS, {}) or {}).get(ms[0]["group"]) if not host else None
    if tok: outs = [o.replace(" -f rtsp ", f" -metadata title=r{int(tok)} -f rtsp ", 1) for o in outs]   # restart button: a new
    return f"{head} {' '.join(ins)} {' '.join(outs)}", pls      # command makes MediaMTX restart the group's player


# ---------------- on-connect sync groups ----------------
# MediaMTX's on-demand command belongs to ONE path, but a group must start for a viewer on ANY of its paths. So every path
# of an on-connect group gets a tiny on-demand "trigger": the container's ffmpeg reads an endless byte stream from this
# platform (/api/rtsp/hold). While at least one trigger is connected, or any path of the group has a viewer, the platform
# runs the group's ffmpeg here on the host (publishing all paths at once, so they start together). When none of that has
# been true for the group's idle time, it stops; the next viewer starts the whole group from the beginning.
RT = {}; RTL = threading.Lock(); _SUP = {"on": False}
START_GRACE = 30    # s a just-started group waits for its first viewer to finish connecting before it may stop


def reap_orphans():
    """At startup: stop group players left by an earlier platform process (same user, this ffmpeg, publishing to this server)."""
    ff = ffmpeg_bin() or ""; tgt = f"rtsp://{HOST}:{PORT}/"; me = os.getuid(); n = 0; hit = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit(): continue
        try:
            if d.stat().st_uid != me: continue
            a = (d / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        args = [x.decode(errors="ignore") for x in a if x]
        # only a player that SENDS to this server: its last argument (the output) is our RTSP address. A tab 8 recording that
        # READS one of our streams has the address as an input and a file as the last argument, so it never matches.
        if len(args) > 2 and args[0] == ff and "-nostdin" in args and args[-1].startswith(tgt) and args[-2] == "tcp":
            try: os.kill(int(d.name), 15); n += 1; hit.append(int(d.name))
            except OSError: pass
    for _ in range(50):                        # ffmpeg sending to RTSP can ignore SIGTERM (seen 2026-11-16): force after 5 s
        hit = [p for p in hit if Path(f"/proc/{p}").exists() and "zombie" not in (Path(f"/proc/{p}/status").read_text(errors="ignore") if Path(f"/proc/{p}/status").exists() else "")]
        if not hit: break
        time.sleep(0.1)
    for p in hit:
        try: os.kill(p, 9)
        except OSError: pass
    return n


def _platform_addr():
    a = os.environ.get("RTSP_PLATFORM_ADDR")              # how the container reaches this platform (no DNS in the static ffmpeg)
    if a: return a
    r = _docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}", timeout=15)
    gw = r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else "172.17.0.1"
    return f"{gw}:{PLATFORM_PORT}"


def _trigger_cmd(g, name):
    return (f"/ffmpeg -hide_banner -loglevel error -nostdin -f u8 -ar 1000 -ac 1 "
            f"-i http://{_platform_addr()}/api/rtsp/hold?g={g}&p={name} -f null -")


def _ondemand_groups(streams=None):
    return {g: ms for g, ms in groups(streams if streams is not None else load()).items() if len(ms) >= 2 and ms[0]["start"] == "on_connect"}


def _stop_proc(r):
    p = r.get("proc")
    if p and p.poll() is None:
        p.terminate()
        try: p.wait(5)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
    r["proc"] = None; r["gen"] = r.get("gen", 0) + 1         # open triggers end, so MediaMTX starts fresh ones later


def _ensure(g, ms):
    """Start (or restart, if its settings changed) the host ffmpeg of on-connect group g. Call with RTL held."""
    r = RT.setdefault(g, dict(proc=None, holders=0, last=time.time(), sig=None, gen=0, err=None))
    cmd, pls = _group_cmd(ms, host=True)
    if r["proc"] and r["proc"].poll() is None and r["sig"] == cmd: return r
    if r["proc"]: _stop_proc(r)
    for fn, t in pls:
        if not (LIVE / fn).exists(): _atomic(LIVE / fn, t)
    log = open(BASE / f"group_{g}.log", "ab")
    log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} start ({', '.join(m['name'] for m in ms)})\n".encode()); log.flush()
    # Started as a plain child (no systemd-run scope): it then lives in the platform service's own cgroup, so stopping or
    # restarting the service always stops it too, and it shares the service's RAM cap (16 GB).
    r["proc"] = subprocess.Popen(["nice", "-n", "5"] + shlex.split(cmd), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
    r.update(sig=cmd, last=time.time(), started=time.time(), seen=False); _sup_start(); return r


def hold(h, g, p):
    """/api/rtsp/hold: the trigger of one path of an on-connect group. Keeps the group playing while it stays connected."""
    ms = _ondemand_groups().get(g)
    if not ms or p not in [m["name"] for m in ms]:
        h.send_response(404); h.end_headers(); return
    with RTL:
        r = _ensure(g, ms); r["holders"] += 1; gen = r["gen"]
    try:
        h.send_response(200); h.send_header("Content-Type", "application/octet-stream"); h.end_headers()
        while True:
            with RTL:
                if r["gen"] != gen: break                       # the group stopped (end of video, settings changed)
            h.wfile.write(b"\x80" * 500); h.wfile.flush(); time.sleep(0.5)
    except Exception:
        pass
    finally:
        with RTL: r["holders"] -= 1; r["last"] = time.time()


def _supervise():
    while True:
        time.sleep(2)
        try:
            gs = _ondemand_groups(); paths = _api() or {}
            with RTL:
                for g, r in list(RT.items()):
                    if r["proc"] is None: continue
                    ms = gs.get(g)
                    if not ms: _stop_proc(r); continue          # group removed or no longer on-connect
                    if r["proc"].poll() is not None: _stop_proc(r); continue   # video ended (stop modes) or ffmpeg failed
                    # Decide on REAL viewers only. MediaMTX does not close a path's on-demand trigger while another process
                    # publishes that path (seen 2026-11-13: a trigger stayed connected 2 h with 0 viewers), so triggers are
                    # not a usable signal. After a stop the triggers are released (gen changes) and the next viewer starts over.
                    viewers = sum(len((paths.get(m["name"]) or {}).get("readers") or []) for m in ms)
                    now = time.time()
                    if viewers > 0: r["last"] = now; r["seen"] = True
                    elif now - r["last"] > max(m["idle_close_s"] for m in ms) and (r.get("seen") or now - r.get("started", now) > START_GRACE):
                        _stop_proc(r)
        except Exception:
            pass


def _sup_start():
    if not _SUP["on"]:
        _SUP["on"] = True; threading.Thread(target=_supervise, daemon=True).start()


def _reconcile(streams):
    """After a save: stop host group players whose group was removed or changed (viewers of that group are disconnected)."""
    gs = _ondemand_groups(streams)
    with RTL:
        for g, r in RT.items():
            if r["proc"] is None: continue
            if g not in gs or _group_cmd(gs[g], host=True)[0] != r["sig"]: _stop_proc(r)


def stop_groups():
    with RTL:
        for r in RT.values(): _stop_proc(r)


RESTARTS = C.ST / "rtsp_group_restarts.json"     # {group: how often its restart button was pressed} (always-playing groups)


def restart_group(g):
    """Restart every stream of sync group g from its first frame, together. Viewers are disconnected for a moment
    (players and recorders that reconnect by themselves come back on the first frame)."""
    ms = groups(load()).get(g)
    if not ms or len(ms) < 2: return dict(ok=False, error=f"no sync group '{g}' with two or more switched-on streams")
    if paused(): return dict(ok=False, error="all streams are paused; press Resume first")
    if JOB["running"]: return dict(ok=False, error="clips are still being cut; try again when that is done")
    names = ", ".join(m["name"] for m in ms)
    if ms[0]["start"] == "on_connect":
        with RTL:
            r = RT.get(g)
            if not r or not r["proc"] or r["proc"].poll() is not None:
                return dict(ok=True, note=f"Group {g} is not playing (nobody watching); the next viewer starts it from the first frame anyway.")
            p = r["proc"]; p.terminate()
            try: p.wait(5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
            r["proc"] = None; r["sig"] = None              # triggers stay connected; a fresh player starts right away
            _ensure(g, ms)
        return dict(ok=True, note=f"Group {g} ({names}) restarted from the first frame.")
    with LOCK:
        t = C.jload(RESTARTS, {}) or {}; t[g] = int(t.get(g, 0)) + 1; C.jsave(RESTARTS, t)
    _apply(load())
    return dict(ok=True, note=f"Group {g} ({names}) restarted from the first frame (takes a few seconds).")


AUTH = C.ST / "rtsp_auth.json"   # {user, pass, public_host, public_port}, mode 600: ONE viewer login (plain text so the page can
                                  # show full links) used by every stream that ticks "password"; the server config gets only a sha256.


def auth(full=False):
    a = C.jload(AUTH, {}) or {}
    out = dict(user=a.get("user") or "", set=bool(a.get("user") and a.get("pass")),
               public_host=a.get("public_host") or "", public_port=int(a.get("public_port") or PORT))
    if full: out["pass"] = a.get("pass") or ""
    return out


def set_auth(user, pw):
    """The one viewer login (user + password) for streams that tick "password". Empty password box = keep the saved one;
    empty user = remove the login (refused while a stream uses it)."""
    user = str(user or "").strip(); pw = str(pw or ""); a = C.jload(AUTH, {}) or {}
    if not user:
        used = [s["name"] for s in load() if s["auth_on"]]
        if used: return dict(ok=False, error=f"untick 'password' on {', '.join(used)} first")
        a.update(user="", **{"pass": ""})
    else:
        pw = pw or (a.get("pass") or "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", user): return dict(ok=False, error="user name: 1-32 letters, digits, _ . -")
        # only URL-safe characters: tested 2026-11-19, a password with @ : / # was refused even percent-encoded (ffmpeg client)
        if not re.fullmatch(r"[A-Za-z0-9._~-]{4,64}", pw): return dict(ok=False, error="password: 4-64 letters, digits or . _ - ~ (other symbols break RTSP links in many players)")
        a.update(user=user, **{"pass": pw})
    with LOCK:
        C.jsave(AUTH, a); _private(AUTH); _apply(load())
    return dict(ok=True, auth=auth(full=True))


def _private(p):
    try: os.chmod(p, 0o600)
    except OSError: pass


PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.1", "::1"]   # viewers allowed on a non-public stream


def set_public(host, port):
    """The router's public address + port (for the public links of streams marked public). The router must forward that
    port (TCP) to this machine's RTSP port; this does not change the router."""
    host = str(host or "").strip(); a = C.jload(AUTH, {}) or {}
    try: port = int(port or PORT)
    except (TypeError, ValueError): return dict(ok=False, error="public port must be a number")
    if host and not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host): return dict(ok=False, error="public address: an IP like 203.0.113.5 or a host name")
    if not 1 <= port <= 65535: return dict(ok=False, error="public port: 1-65535")
    if not host and any(s["public"] and s["enabled"] for s in load()): return dict(ok=False, error="some streams are public: switch them off first")
    with LOCK:
        a.update(public_host=host, public_port=port); C.jsave(AUTH, a)
        try: os.chmod(AUTH, 0o600)
        except OSError: pass
        _apply(load())
    return dict(ok=True, auth=auth(full=True))


PAUSE = C.ST / "rtsp_paused.json"


def paused():
    return bool((C.jload(PAUSE, {}) or {}).get("paused"))


def pause():
    """Pause every stream to free CPU/RAM: the server keeps running but serves nothing; all settings are kept."""
    with LOCK:
        C.jsave(PAUSE, dict(paused=True, since=time.strftime("%Y-%m-%d %H:%M:%S")))
        _apply(load())
    stop_groups()
    return dict(ok=True, paused=True)


def resume():
    """Undo pause: apply the saved stream settings again (cuts any missing clips first)."""
    with LOCK:
        C.jsave(PAUSE, dict(paused=False))
    r = save(load())
    return dict(r, paused=False)


def render(streams):
    if paused(): streams = [dict(s, enabled=False) for s in streams]   # paused: no stream is served, settings stay as they are
    y = ["# Written by the sack labelling platform (tab 12, Serve videos as RTSP). Edit there, not here.",
         "logLevel: info", "rtsp: yes", "rtspTransports: [tcp]", "rtspAddress: :8554",
         "rtmp: no", "hls: no", "webrtc: no", "srt: no", "moq: no", "api: yes", "apiAddress: :9997",
         "authInternalUsers:"]
    # Who may do what, per stream: only this machine (its own players) may publish; a stream without a password may be
    # watched from the local network only; a stream with a password needs it, and only a "public" stream may be watched
    # from outside the local network (the router must forward the port).
    y += ["- user: any", "  pass:", f"  ips: ['127.0.0.1', '::1', '172.16.0.0/12', '{HOST}']", "  permissions: [{action: publish}]"]
    on = [s for s in streams if s["enabled"]]
    rd = lambda n: f"[{{action: read, path: {n}}}, {{action: playback, path: {n}}}]"
    free = [s["name"] for s in on if not s["auth_on"]]
    if free:
        y += ["- user: any", "  pass:", f"  ips: {PRIVATE}",
              "  permissions: [" + ", ".join(f"{{action: read, path: {n}}}, {{action: playback, path: {n}}}" for n in free) + "]"]
    lg = auth(full=True)
    for s in on:
        if not s["auth_on"] or not lg["set"]: continue
        h = base64.b64encode(hashlib.sha256(lg["pass"].encode()).digest()).decode()
        y += [f"- user: {lg['user']}", f"  pass: 'sha256:{h}'", f"  ips: {[] if s['public'] else PRIVATE}", f"  permissions: {rd(s['name'])}"]
    y += ["- user: any", "  pass:", "  ips: ['127.0.0.1', '::1', '172.16.0.0/12']", "  permissions: [{action: api}]", "paths:"]
    lists = {}; G = {g: ms for g, ms in groups(streams).items() if len(ms) >= 2}
    OD = {m["name"]: g for g, ms in G.items() if ms[0]["start"] == "on_connect" for m in ms}
    G = {g: ms for g, ms in G.items() if ms[0]["start"] != "on_connect"}
    lead = {ms[0]["name"]: ms for ms in G.values()}; follow = {m["name"]: ms[0]["name"] for ms in G.values() for m in ms[1:]}
    for s in streams:
        if not s["enabled"]: continue
        y.append(f"  {s['name']}:")
        if s["name"] in OD:                       # on-connect sync group: a viewer on ANY path starts the whole group
            y += [f"    runOnDemand: {_trigger_cmd(OD[s['name']], s['name'])}   # sync group '{OD[s['name']]}', played by the platform",
                  "    runOnDemandRestart: no", "    runOnDemandStartTimeout: 30s", f"    runOnDemandCloseAfter: {s['idle_close_s']}s"]
            continue
        if s["name"] in follow:                   # published by its group's ffmpeg (started with the first stream of the group)
            y.append(f"    source: publisher   # sync group '{s['group']}', started together with {follow[s['name']]}"); continue
        if s["name"] in lead:
            cmd, pls = _group_cmd(lead[s["name"]])
            for pl in pls: lists[pl[0]] = pl[1]
            ms = lead[s["name"]]
            if s["start"] == "always":
                y += [f"    runOnInit: {cmd}", f"    runOnInitRestart: {'yes' if s['end'] in ('loop', 'freeze_loop') else 'no'}"]
            else:                                 # on_connect: a viewer on the first stream starts the whole group
                y += [f"    runOnDemand: {cmd}", "    runOnDemandRestart: no", "    runOnDemandStartTimeout: 20s",
                      f"    runOnDemandCloseAfter: {s['idle_close_s']}s"]
            continue
        cmd, pl = _cmd(s)
        if pl: lists[pl[0]] = pl[1]
        if s["start"] == "always":
            y += [f"    runOnInit: {cmd}", f"    runOnInitRestart: {'yes' if s['end'] in ('loop', 'freeze_loop') else 'no'}"]
        else:
            y += [f"    runOnDemand: {cmd}", "    runOnDemandRestart: no", "    runOnDemandStartTimeout: 20s",
                  f"    runOnDemandCloseAfter: {s['idle_close_s']}s"]
    if not any(s["enabled"] for s in streams): y[-1] = "paths: {}"
    return "\n".join(y) + "\n", lists


def _atomic(p, text):
    tmp = p.with_name("." + p.name + ".tmp"); tmp.write_text(text); os.replace(tmp, p)


def _apply(streams):
    with LOCK:
        yml, lists = render(streams); ts = time.strftime("%Y%m%d_%H%M%S")
        (HIST / f"mediamtx_{ts}.yml").write_text(yml); (HIST / f"streams_{ts}.json").write_text(json.dumps(streams, indent=1))
        _private(HIST / f"streams_{ts}.json")                     # holds stream passwords
        for n, t in lists.items():                                 # playlists first, so a reloaded stream finds its list
            if not (LIVE / n).exists(): _atomic(LIVE / n, t)       # name = content hash; a running stream may still read an older one
        _atomic(LIVE / "mediamtx.yml", yml)
        _TOUCH["n"] += 1; threading.Thread(target=_touch_later, args=(_TOUCH["n"],), daemon=True).start()
    _reconcile(streams)
    return ts


# MediaMTX misses a change that lands while it is still reloading an earlier one (tested 2026-11-19: three writes within
# ~1 s -> one reload, of an older version; a viewer password was not applied). So 3 s after the LAST write the same
# config is written once more; an unchanged config reloads as a no-op.
_TOUCH = {"n": 0}


def _touch_later(n):
    time.sleep(3)
    with LOCK:
        if _TOUCH["n"] != n: return                        # a newer write follows; its own re-write covers it
        p = LIVE / "mediamtx.yml"
        try: _atomic(p, p.read_text())
        except OSError: pass


def _clip_job(streams, gen, todo):
    for i, s in enumerate(todo):
        if JOB["gen"] != gen: return                               # a newer save took over
        JOB.update(cur=f"{s['name']} ({label(s['file'])}, {_len(s) or 0:.0f} s)", done=i)
        err = _cut(s)
        if err:
            if JOB["gen"] == gen: JOB.update(running=False, err=f"cutting the clip for {s['name']} failed: {err}")
            return
    if JOB["gen"] != gen: return
    ts = _apply(streams)
    JOB.update(running=False, done=len(todo), cur="", applied=ts)


def save(streams):
    """Check, store, and write the live server config. The running server reloads it by itself. Loops that start inside a
    video first need their clip; missing clips are cut in the background and the config is applied when they are ready."""
    streams = [_norm(s) for s in (streams or [])]
    errs = _check(streams)
    if errs: return dict(ok=False, errors=errs)
    with LOCK:
        C.jsave(STATE, streams); _private(STATE)
        todo = [s for s in streams if _needs_clip(s) and not (CLIPS / _clip_name(s)).exists()]
        JOB["gen"] += 1; gen = JOB["gen"]
        if todo:
            JOB.update(running=True, total=len(todo), done=0, cur="", err=None, applied=None)
            threading.Thread(target=_clip_job, args=(streams, gen, todo), daemon=True).start()
            mins = sum((_len(s) or 0) for s in todo) / 60
            return dict(ok=True, preparing=len(todo), note=f"Saved. Cutting {len(todo)} exact loop clip(s) ({mins:.1f} min of video) first; "
                        "the changed streams switch over by themselves when that is done (see the server box).", server=server())
        JOB.update(running=False, err=None)
        ts = _apply(streams)
    time.sleep(1.5)
    st = status()
    sv = st["server"]
    note = ("Saved, but all streams are PAUSED: press Resume all streams to serve them." if paused() else
            None if sv["running"] and sv["layout_ok"] else
            "Saved. The server is stopped: press Restart server to start it with these settings." if not sv["running"] else
            "Saved. The server running now uses an older setup (no recordings folder or not this config file): press Restart server to use it.")
    return dict(ok=True, saved=ts, server=sv, note=note)


# ---------------- server ----------------
def _docker(*a, timeout=60):
    return subprocess.run(["docker", *a], capture_output=True, text=True, timeout=timeout)


def _api():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/v3/paths/list?itemsPerPage=1000", timeout=2) as r:
            return {i["name"]: i for i in json.load(r)["items"]}
    except Exception:
        return None


def server():
    r = _docker("inspect", CONTAINER, "--format", "{{.State.Running}}|{{.State.StartedAt}}|{{json .HostConfig.Binds}}", timeout=15)
    if r.returncode != 0: return dict(container=CONTAINER, running=False, layout_ok=False, api=False, address=f"rtsp://{HOST}:{PORT}/")
    run, started, binds = r.stdout.strip().split("|", 2)
    try: binds = json.loads(binds) or []
    except Exception: binds = []
    lay = any(b.startswith(str(LIVE) + ":/cfg") for b in binds) and any(b.startswith(str(REC.REC_DIR) + ":/rec") for b in binds) \
          and any(b.startswith(str(RAW_DIR) + ":/raw") for b in binds)
    try: socket.create_connection((HOST, PORT), timeout=2).close(); port_ok = True
    except Exception: port_ok = False
    return dict(container=CONTAINER, running=run == "true", started=started, layout_ok=lay, rtsp_port_answers=port_ok,
                api=_api() is not None, address=f"rtsp://{HOST}:{PORT}/")


def status():
    srv = server(); paths = _api() or {}; out = []; pz = paused()
    for s in load():
        p = paths.get(s["name"]); rd = len(p.get("readers") or []) if p else 0
        state = ("off" if not s["enabled"] else "paused" if pz else "server stopped" if not srv["running"] else
                 "unknown (old setup)" if not srv["api"] else
                 "not loaded" if p is None else "playing" if p.get("ready") else "waiting for a viewer" if s["start"] == "on_connect" else "ended")
        out.append(dict(s, url=f"rtsp://{HOST}:{PORT}/{s['name']}", state=state, viewers=rd))
    return dict(server=srv, streams=out, viewers=sum(x["viewers"] for x in out), clips=dict(JOB), paused=pz, auth=auth(),
                players=sum(1 for r in RT.values() if r.get("proc") and r["proc"].poll() is None))


def restart():
    """(Re)create the one RTSP container with the current config. Viewers of every stream are disconnected."""
    stop_groups()
    with LOCK:
        if not (LIVE / "mediamtx.yml").exists():
            r = save(load())
            if not r["ok"]: return r
        ff = ffmpeg_bin()
        if not ff: return dict(ok=False, errors=["no ffmpeg binary found"])
        ff = os.path.realpath(ff)
        if _docker("inspect", CONTAINER, timeout=15).returncode == 0:
            r = _docker("stop", "-t", "5", CONTAINER, timeout=60)
            if r.returncode != 0: return dict(ok=False, errors=["docker stop: " + r.stderr.strip()])
            for _ in range(20):                    # the container is started with --rm: wait until it is gone
                if _docker("inspect", CONTAINER, timeout=15).returncode != 0: break
                time.sleep(0.5)
        r = _docker("run", "-d", "--rm", "--name", CONTAINER, "-m", MEM, "-p", f"{HOST}:{PORT}:8554", "-p", f"127.0.0.1:{API_PORT}:9997",
                    "-v", f"{LIVE}:/cfg:ro", "-v", f"{VIDEO_DIR}:/video:ro", "-v", f"{REC.REC_DIR}:/rec:ro", "-v", f"{RAW_DIR}:/raw:ro", "-v", f"{ff}:/ffmpeg:ro", IMAGE, "/cfg/mediamtx.yml", timeout=120)
        if r.returncode != 0: return dict(ok=False, errors=["docker run: " + r.stderr.strip()])
        for _ in range(20):
            if _api() is not None: break
            time.sleep(0.5)
        return dict(ok=True, server=server())


def stop():
    stop_groups()
    with LOCK:
        if _docker("inspect", CONTAINER, timeout=15).returncode != 0: return dict(ok=True, server=server())
        r = _docker("stop", "-t", "5", CONTAINER, timeout=60)
        return dict(ok=r.returncode == 0, errors=[r.stderr.strip()] if r.returncode else [], server=server())


def logs(n=60):
    r = _docker("logs", "--tail", str(int(n)), CONTAINER, timeout=15)
    return dict(text=(r.stdout + r.stderr)[-20000:])


def uses(sid, name):
    """Streams that play recording <sid>/<name>, with their current viewers."""
    f = f"rec/{sid}/{name}"; st = status()
    return [dict(name=x["name"], viewers=x["viewers"], enabled=x["enabled"]) for x in st["streams"] if x["file"] == f]


def rename_refs(sid, old, new):
    """After a recording was renamed in tab 8: point the streams that used it at the new name and apply."""
    o, n = f"rec/{sid}/{old}", f"rec/{sid}/{new}"
    with LOCK:
        streams = load()
        changed = [x["name"] for x in streams if x["file"] == o]
        if not changed: return dict(changed=[])
        for x in streams:
            if x["file"] == o: x["file"] = n
        r = save(streams)
        if not r["ok"]:                     # some other stream has a problem: still store the new name, apply later
            C.jsave(STATE, streams)
            return dict(changed=changed, applied=False, errors=r["errors"])
        return dict(changed=changed, applied=True, note=r.get("note"))


def clip_for(name):
    """The joined/exact clip a saved stream plays (for the page's preview), or why there is none yet."""
    s = next((x for x in load() if x["name"] == name), None)
    if not s: return dict(ok=False, error="stream not saved yet: press Save and apply first")
    if not _needs_clip(s): return dict(ok=False, error="this stream plays its video directly (no parts, no loop clip): use pick start / end to watch it")
    f = CLIPS / _clip_name(s)
    if not f.is_file():
        return dict(ok=False, error="the clip is still being cut (see the server box)" if JOB["running"] else "no clip for the saved settings yet: press Save and apply")
    return dict(ok=True, file=f.name, seconds=round(_len(s) or 0, 1))


def clip_path(fn):
    p = CLIPS / (fn or "")
    return p if re.fullmatch(r"[A-Za-z0-9_-]+\.mp4", fn or "") and p.is_file() else None
