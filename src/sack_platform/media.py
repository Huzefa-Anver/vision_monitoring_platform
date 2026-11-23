"""Tab 7 raw media: raw videos and raw frame sets, uploads, and making a video from frames (so it can be served as RTSP).

Raw videos   = the RTSP video folder (RTSP_VIDEO_DIR), tab 8 recordings, and DATA_DIR/raw_videos (uploads and videos
               made from frames; each may have a <name>.json beside it saying where it came from).
Raw frames   = frame sets: capture events (DATA_DIR/captures/<event>/NN_raw.jpg), saved frames (DATA_DIR/frames, grouped
               by capture), uploaded sets (DATA_DIR/raw_frames/<set>/) and the image splits of labelled datasets.
Uploads      = streamed to disk in chunks (never held in memory), written as .part and renamed at the end; an existing name
               is refused, never overwritten. Zips are unpacked with every path checked; only images (and for labelled
               datasets labels/yaml/json/txt) are kept.
Benchmark    = frames whose md5 matches an image of the benchmark/eval folder, or whose name carries a reserved eval day,
               are flagged. Serving them as RTSP is fine for testing the counter, but anything captured from such a stream
               must never be used for training.
Only uploads and videos made here can be deleted from the page; existing captures, frames, recordings, datasets and
videos are only read.
"""
import hashlib, json, os, re, shutil, subprocess, threading, time, zipfile
from collections import Counter
from pathlib import Path

import core as C, recorder as REC, rtsp_serve as RS
from config import DATA_DIR, PROJECT_ROOT, ffmpeg_bin

RAW_V = RS.RAW_DIR
RAW_F = DATA_DIR / "raw_frames"
CAPS = DATA_DIR / "captures"
FRAMES = DATA_DIR / "frames"
DSROOT = PROJECT_ROOT / "datasets"
BENCH_DIRS = [PROJECT_ROOT / "eval" / "v21_hard_pilot_v001"]          # benchmark images (md5 leak check)
RESERVED = PROJECT_ROOT / "eval" / "EVAL_RESERVED.json"
for d in (RAW_V, RAW_F): d.mkdir(parents=True, exist_ok=True)
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp"}
NAME = r"[A-Za-z0-9_-]{1,80}"
FREE_MARGIN = 5 * 2**30                                                 # keep 5 GB free on the disk after any upload
LOCK = threading.Lock()


def _safe(name, keep_ext=False):
    p = Path(name or "").name
    stem, ext = (p.rsplit(".", 1) + [""])[:2] if "." in p else (p, "")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_")[:80]
    return (stem + ("." + ext.lower() if keep_ext and ext else "")) if stem else ""


def _meta(p):
    try: return json.loads(p.with_suffix(".json").read_text())
    except Exception: return {}


# ---------------- raw videos ----------------
def videos():
    v = RS.videos()
    for x in v["videos"]:
        if x.get("source") == "raw": x["meta"] = _meta(RS.host_path(x["file"]))
    used = {}
    for s in RS.load(): used.setdefault(s["file"], []).append(s["name"])
    for x in v["videos"]: x["streams"] = used.get(x["file"], [])
    return v


# ---------------- frame sets ----------------
def _imgs(d, pattern="*"):
    return sorted(p for p in d.glob(pattern) if p.is_file() and p.suffix.lower() in IMG_EXT)


def _set_files(sid):
    """Files of one frame set, in name order, or None if the id is not valid."""
    k, _, rest = (sid or "").partition("/")
    if k == "cap" and re.fullmatch(r"[A-Za-z0-9_-]+", rest) and (CAPS / rest).is_dir():
        return _imgs(CAPS / rest, "*_raw.jpg")
    if k == "frm" and re.fullmatch(r"[A-Za-z0-9_-]+", rest):
        return [p for p in _imgs(FRAMES, rest + "_*") if re.fullmatch(re.escape(rest) + r"_\d+", p.stem)]
    if k == "up" and re.fullmatch(NAME, rest) and (RAW_F / rest).is_dir():
        return _imgs(RAW_F / rest)
    m = re.fullmatch(r"([A-Za-z0-9_.+-]+)/([A-Za-z0-9_-]+)", rest)
    if k == "ds" and m and (DSROOT / m[1] / "images" / m[2]).is_dir():
        return _imgs(DSROOT / m[1] / "images" / m[2])
    return None


def _size(p):
    try:
        from PIL import Image
        with Image.open(p) as im: return im.size
    except Exception:
        return None


_FS = {"sig": None, "data": None}


def frame_sets():
    sig = tuple(int(d.stat().st_mtime) if d.exists() else 0 for d in (CAPS, FRAMES, RAW_F, DSROOT))
    if _FS["sig"] == sig: return _FS["data"]
    out = []
    for d in sorted((x for x in RAW_F.iterdir() if x.is_dir()), reverse=True):
        fs = _imgs(d)
        out.append(dict(id=f"up/{d.name}", group="uploaded", label=d.name, count=len(fs), meta=_meta(d / "set"),
                        date=time.strftime("%Y-%m-%d %H:%M", time.localtime(d.stat().st_mtime))))
    if CAPS.is_dir():
        for d in sorted((x for x in CAPS.iterdir() if x.is_dir()), reverse=True):
            n = len(list(d.glob("*_raw.jpg")))
            if n: out.append(dict(id=f"cap/{d.name}", group="capture events", label=d.name, count=n, date=_date(d.name, d)))
    if FRAMES.is_dir():
        g = Counter(re.sub(r"_\d+$", "", p.stem) for p in _imgs(FRAMES))
        for k in sorted(g, reverse=True):
            out.append(dict(id=f"frm/{k}", group="saved frames", label=k, count=g[k], date=_date(k, FRAMES)))
    if DSROOT.is_dir():
        for d in sorted(x for x in DSROOT.iterdir() if (x / "images").is_dir()):
            for sp in sorted(x for x in (d / "images").iterdir() if x.is_dir()):
                n = sum(1 for e in os.scandir(sp) if e.is_file() and Path(e.name).suffix.lower() in IMG_EXT)
                if n: out.append(dict(id=f"ds/{d.name}/{sp.name}", group="labelled datasets", label=f"{d.name} / {sp.name}", count=n,
                                      date=time.strftime("%Y-%m-%d %H:%M", time.localtime(d.stat().st_mtime))))
    for x in out:
        fs = _set_files(x["id"]) or []
        x["picture"] = "x".join(map(str, _size(fs[0]))) if fs and _size(fs[0]) else "?"
    _FS.update(sig=sig, data=dict(sets=out)); return _FS["data"]


def _date(name, d):
    m = re.match(r"(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})", name)
    return f"{m[1]}-{m[2]}-{m[3]} {m[4]}:{m[5]}" if m else time.strftime("%Y-%m-%d %H:%M", time.localtime(d.stat().st_mtime))


def set_file(sid, i):
    fs = _set_files(sid)
    if not fs: return None
    i = max(0, min(int(i), len(fs) - 1)); return fs[i]


_TH = {}


def thumb(sid, i, w=240):
    """Small JPEG of frame i of a set (kept in memory, up to 3000 thumbnails)."""
    f = set_file(sid, i)
    if f is None: return None
    w = w if w in (160, 240, 320, 480) else 240; st = f.stat(); k = (str(f), st.st_size, st.st_mtime, w)
    if k in _TH: return _TH[k]
    from PIL import Image
    import io
    with Image.open(f) as im:
        im = im.convert("RGB"); im.thumbnail((w, w * 3)); b = io.BytesIO(); im.save(b, "JPEG", quality=80)
    if len(_TH) > 3000: _TH.clear()
    _TH[k] = b.getvalue(); return _TH[k]


def set_list(sid):
    fs = _set_files(sid)
    return dict(ok=fs is not None, files=[p.name for p in fs or []])


# ---------------- benchmark check ----------------
_BH = {"sig": None, "md5": set()}


def _md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def bench_md5():
    """md5 of every benchmark image (cached on disk by path + size + mtime)."""
    cache = C.jload(C.ST / "bench_md5_cache.json", {}) or {}
    files = [p for d in BENCH_DIRS if d.is_dir() for p in d.rglob("*") if p.is_file() and p.suffix.lower() in IMG_EXT]
    sig = len(files), max((int(p.stat().st_mtime) for p in files), default=0)
    if _BH["sig"] == sig: return _BH["md5"]
    out, new = set(), {}
    for p in files:
        st = p.stat(); k = f"{p}|{st.st_size}|{int(st.st_mtime)}"
        new[k] = cache.get(k) or _md5(p); out.add(new[k])
    C.jsave(C.ST / "bench_md5_cache.json", new); _BH.update(sig=sig, md5=out); return out


def _reserved_days():
    try:
        return [e["date"] for e in json.loads(RESERVED.read_text()).get("entries", []) if e.get("date")]
    except Exception:
        return []


def leak_check(files):
    """Which files are benchmark frames (same md5) or carry a reserved eval day in their name."""
    bm = bench_md5(); days = [(d, d.replace("-", "")) for d in _reserved_days()]
    same = [p.name for p in files if _md5(p) in bm]
    day = [p.name for p in files if any(a in p.name or b in p.name for a, b in days)]
    return dict(checked=len(files), benchmark_md5=same[:50], n_benchmark=len(same), reserved_day=day[:50], n_reserved_day=len(day))


# ---------------- make a video from frames ----------------
JOB = dict(running=False, name="", pct=0.0, err=None, done=None, frames=0)


def _speed(mode, hold_s, fps):
    """(seconds per image, video fps, hold_s, fps) or an error text."""
    try: hold_s = float(hold_s); fps = float(fps)
    except (TypeError, ValueError): return "hold / fps must be numbers"
    if mode == "rate":
        if not 0.1 <= fps <= 60: return "images per second must be 0.1-60"
        return 1.0 / fps, fps, hold_s, fps
    if not 0.04 <= hold_s <= 600: return "hold must be 0.04-600 s per image"
    return hold_s, max(5.0, round(1.0 / hold_s, 3)), hold_s, fps


def make_video(sets, name, mode="hold", hold_s=1.0, fps=5.0, order="name"):
    """Turn frame sets into one H.264 video in RAW_V (background job). mode hold: every image stays hold_s seconds
    (video at 5 fps, or faster for short holds); mode rate: fps images per second, one video frame per image.
    Different picture sizes are scaled and padded (black bars) to the most common size."""
    name = _safe(name)
    if not re.fullmatch(NAME, name or ""): return dict(ok=False, error="name may use only letters, digits, _ and -")
    out = RAW_V / f"{name}.mp4"
    if out.exists(): return dict(ok=False, error=f"a raw video called {name}.mp4 already exists")
    files = []
    for sid in sets or []:
        fs = _set_files(sid)
        if fs is None: return dict(ok=False, error=f"frame set {sid} not found")
        files += fs
    if not files: return dict(ok=False, error="no frames selected")
    if order == "time": files.sort(key=lambda p: p.stat().st_mtime)
    sp = _speed(mode, hold_s, fps)
    if isinstance(sp, str): return dict(ok=False, error=sp)
    dur, out_fps, hold_s, fps = sp
    with LOCK:
        if JOB["running"]: return dict(ok=False, error=f"already making {JOB['name']}; wait for it to finish")
        JOB.update(running=True, name=name, pct=0.0, err=None, done=None, frames=len(files))
    threading.Thread(target=_make, args=(files, out, dur, out_fps, dict(sets=list(sets), mode=mode, hold_s=hold_s if mode != "rate" else None,
                     fps=fps if mode == "rate" else None, order=order)), daemon=True).start()
    return dict(ok=True, name=name, frames=len(files), seconds=round(dur * len(files), 1))


def _make(files, out, dur, out_fps, info):
    err = _encode(files, out, dur, out_fps, info)
    if err: JOB.update(running=False, err=err)
    else: JOB.update(running=False, pct=100.0, done=out.name)


def _encode(files, out, dur, out_fps, info):
    """Write the video and its .json; returns an error text or None. Updates JOB['pct']."""
    try:
        sizes = Counter(_size(p) for p in files[:: max(1, len(files) // 200)]); W, H = (sizes.most_common(1)[0][0] or (1920, 1080))
        W, H = W - W % 2, H - H % 2
        lst = out.with_name("." + out.stem + ".ffconcat"); part = out.with_name("." + out.stem + ".part.mp4")
        q = lambda p: "'" + str(p).replace("'", "'\\''") + "'"
        lst.write_text("ffconcat version 1.0\n" + "".join(f"file {q(p)}\nduration {dur:.4f}\n" for p in files) + f"file {q(files[-1])}\n")
        total = dur * len(files); g = max(1, round(out_fps))
        vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={out_fps:g},format=yuv420p"
        cmd = ["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=3G", "nice", "-n", "10", ffmpeg_bin(), "-hide_banner",
               "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", vf, "-t", f"{total:.3f}",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", str(g), "-keyint_min", str(g), "-sc_threshold", "0",
               "-movflags", "+faststart", "-progress", "pipe:1", str(part)]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in p.stdout:
            if line.startswith("out_time_us=") and line[12:].strip().isdigit():
                JOB["pct"] = min(99.0, int(line[12:]) / 1e6 / total * 100)
        err = p.stderr.read(); p.wait()
        try: lst.unlink()
        except Exception: pass
        if p.returncode != 0 or not part.exists(): return err.strip()[-300:] or "ffmpeg failed"
        if out.exists(): return f"{out.name} appeared meanwhile; the new video is kept as {part.name}"
        os.replace(part, out)
        meta = dict(info, kind="made from frames", frames=len(files), size=f"{W}x{H}", video_fps=out_fps, seconds=round(total, 1),
                    created=time.strftime("%Y-%m-%d %H:%M:%S"), leak=leak_check(files))
        out.with_suffix(".json").write_text(json.dumps(meta, indent=1)); return None
    except Exception as e:
        return str(e)


def job():
    return dict(JOB)


def auto_streams(sets, mode="hold", hold_s=1.0, fps=5.0, together=False, group=""):
    """One video per frame set, then one Serve RTSP stream per video (background job). Stream name = the set's camera
    folder (cam2, ...) when that name is free, else the set name. together: one sync group, always playing, looping, and
    every camera trimmed to the shortest one so they stay the same length."""
    sp = _speed(mode, hold_s, fps)
    if isinstance(sp, str): return dict(ok=False, error=sp)
    dur, out_fps, hold_s, fps = sp
    todo, taken = [], {x["name"] for x in RS.load()}
    for sid in sets or []:
        fs = _set_files(sid)
        if not fs: return dict(ok=False, error=f"frame set {sid} not found or empty")
        base = _safe(sid.split("/", 1)[1].replace("/", "_"))[:80]
        if (RAW_V / f"{base}.mp4").exists(): return dict(ok=False, error=f"a raw video called {base}.mp4 already exists")
        folder = _meta(RAW_F / sid[3:] / "set").get("folder") if sid.startswith("up/") else None
        sname = next(n for n in [_safe(folder or "")[:60], base[:60]] + [f"{base[:56]}_{k}" for k in range(2, 99)] if n and n not in taken)
        taken.add(sname); todo.append(dict(set=sid, files=fs, video=base, stream=sname, folder=folder))
    if not todo: return dict(ok=False, error="no frame sets")
    n_min = min(len(t["files"]) for t in todo)
    if together:
        for t in todo: t["cut"] = len(t["files"]) - n_min; t["files"] = t["files"][:n_min]
    group = _safe(group or "")[:32] or ("cams" if together else "")
    with LOCK:
        if JOB["running"]: return dict(ok=False, error=f"already making {JOB['name']}; wait for it to finish")
        JOB.update(running=True, name=f"{len(todo)} videos", pct=0.0, err=None, done=None, frames=sum(len(t["files"]) for t in todo),
                   step="", streams=None, note=None)
    threading.Thread(target=_auto, args=(todo, dur, out_fps, dict(mode=mode, hold_s=hold_s if mode != "rate" else None,
                     fps=fps if mode == "rate" else None, order="name"), together, group), daemon=True).start()
    return dict(ok=True, videos=[t["video"] for t in todo], streams=[t["stream"] for t in todo],
                trimmed={t["stream"]: t["cut"] for t in todo if t.get("cut")}, seconds=round(dur * (n_min if together else max(len(t["files"]) for t in todo)), 1))


def _auto(todo, dur, out_fps, info, together, group):
    for i, t in enumerate(todo):
        JOB.update(step=f"video {i + 1} of {len(todo)}: {t['video']}.mp4", pct=0.0)
        err = _encode(t["files"], RAW_V / f"{t['video']}.mp4", dur, out_fps, dict(info, sets=[t["set"]], folder=t["folder"]))
        if err:
            JOB.update(running=False, err=f"{t['video']}: {err}", done=[x["video"] + ".mp4" for x in todo[:i]]); return
    JOB.update(step="adding the streams to Serve RTSP")
    streams = RS.load()
    for t in todo:
        streams.append(dict(name=t["stream"], file=f"raw/{t['video']}.mp4", enabled=True, start="always" if together else "on_connect",
                            end="loop" if together else "stop", reencode=bool(together), group=group if together else "",
                            note=f"made from frame set {t['set']}" + (f" (camera folder {t['folder']})" if t["folder"] else "")))
    r = RS.save(streams)
    done = [t["video"] + ".mp4" for t in todo]
    if not r.get("ok"):
        JOB.update(running=False, done=done, err="videos made, but the streams could not be saved: " + "; ".join(r.get("errors", []))); return
    JOB.update(running=False, pct=100.0, done=done, streams=[dict(name=t["stream"], url=f"rtsp://{RS.HOST}:{RS.PORT}/{t['stream']}") for t in todo],
               note=r.get("note"), step="")


# ---------------- uploads ----------------
def _receive(h, target):
    """Stream the request body to target (via .part). Refuses an existing target and a too-full disk."""
    n = int(h.headers.get("Content-Length") or 0)
    if n <= 0: return "empty upload"
    if target.exists(): return f"{target.name} already exists"
    if shutil.disk_usage(target.parent).free - n < FREE_MARGIN: return "not enough free disk space"
    part = target.with_name("." + target.name + ".part")
    left = n
    try:
        with open(part, "wb") as f:
            while left > 0:
                b = h.rfile.read(min(1 << 20, left))
                if not b: break
                f.write(b); left -= len(b)
        if left: part.unlink(missing_ok=True); return "upload interrupted"
        if target.exists(): part.unlink(missing_ok=True); return f"{target.name} already exists"
        os.replace(part, target); return None
    except Exception as e:
        part.unlink(missing_ok=True); return str(e)


def _drain(h):
    n = int(h.headers.get("Content-Length") or 0)
    while n > 0:
        b = h.rfile.read(min(1 << 20, n))
        if not b: break
        n -= len(b)


def upload(h, Q):
    kind = Q.get("kind", "")
    if kind == "video":
        fn = _safe(Q.get("file"), keep_ext=True)
        if not fn or Path(fn).suffix.lower() not in RS.VIDEO_EXT: _drain(h); return dict(ok=False, error="video must be .mp4 .mkv .mov .avi .ts or .m4v")
        err = _receive(h, RAW_V / fn)
        if err: _drain(h); return dict(ok=False, error=err)
        (RAW_V / fn).with_suffix(".json").write_text(json.dumps(dict(kind="uploaded", original_name=Q.get("file"),
                                                                     created=time.strftime("%Y-%m-%d %H:%M:%S")), indent=1))
        return dict(ok=True, file=f"raw/{fn}")
    if kind == "frame":                                   # one image into an upload set created by new_set()
        st, fn = Q.get("set", ""), _safe(Q.get("file"), keep_ext=True)
        if not re.fullmatch(NAME, st) or not (RAW_F / st).is_dir(): _drain(h); return dict(ok=False, error="frame set not found")
        if not fn or Path(fn).suffix.lower() not in IMG_EXT: _drain(h); return dict(ok=False, error=f"{Q.get('file')}: not an image")
        err = _receive(h, RAW_F / st / fn)
        if err: _drain(h); return dict(ok=False, error=err)
        return dict(ok=True)
    if kind in ("frames_zip", "dataset_zip"):
        name = _safe(Q.get("name"))
        if not re.fullmatch(NAME, name or ""): _drain(h); return dict(ok=False, error="name may use only letters, digits, _ and -")
        tmp = DATA_DIR / f".upload_{int(time.time() * 1000)}.zip"
        err = _receive(h, tmp)
        if err: _drain(h); return dict(ok=False, error=err)
        try:
            return _unzip_frames(tmp, name, Q.get("file")) if kind == "frames_zip" else _unzip_dataset(tmp, name, Q.get("file"))
        finally:
            tmp.unlink(missing_ok=True)
    _drain(h); return dict(ok=False, error="unknown upload kind")


def new_set(name):
    name = _safe(name)
    if not re.fullmatch(NAME, name or ""): return dict(ok=False, error="name may use only letters, digits, _ and -")
    d = RAW_F / name
    if d.exists(): return dict(ok=False, error=f"a frame set called {name} already exists")
    d.mkdir(); (d / "set.json").write_text(json.dumps(dict(kind="uploaded", created=time.strftime("%Y-%m-%d %H:%M:%S")), indent=1))
    return dict(ok=True, set=name)


def finish_set(name):
    d = RAW_F / (name or "")
    if not re.fullmatch(NAME, name or "") or not d.is_dir(): return dict(ok=False, error="frame set not found")
    fs = _imgs(d); meta = _meta(d / "set"); meta.update(frames=len(fs), leak=leak_check(fs))
    (d / "set.json").write_text(json.dumps(meta, indent=1)); _FS["sig"] = None
    return dict(ok=True, frames=len(fs), leak=meta["leak"])


def rename_set(old, new):
    """Rename an uploaded frame set (DATA_DIR/raw_frames/<old> -> <new>). Never overwrites; refused while a video is being
    made. Videos already made from it keep working (they are separate files); their .json is updated to the new name."""
    new = _safe(new)
    if not re.fullmatch(NAME, old or "") or not (RAW_F / old).is_dir(): return dict(ok=False, error="frame set not found (only uploaded sets can be renamed)")
    if not re.fullmatch(NAME, new or ""): return dict(ok=False, error="new name may use only letters, digits, _ and -")
    if new == old: return dict(ok=True, id=f"up/{new}")
    with LOCK:
        if JOB["running"]: return dict(ok=False, error=f"a video is being made ({JOB['name']}); rename when it has finished")
        if (RAW_F / new).exists(): return dict(ok=False, error=f"a frame set called {new} already exists")
        os.rename(RAW_F / old, RAW_F / new)
    for j in RAW_V.glob("*.json"):                       # keep "made from" notes pointing at the set's new name
        try:
            m = json.loads(j.read_text())
            if f"up/{old}" in (m.get("sets") or []):
                m["sets"] = [f"up/{new}" if x == f"up/{old}" else x for x in m["sets"]]; j.write_text(json.dumps(m, indent=1))
        except Exception:
            pass
    _FS["sig"] = None
    return dict(ok=True, id=f"up/{new}", old=f"up/{old}")


def _members(z):
    """(member, safe relative path) for every regular file in the zip with a safe path."""
    for m in z.infolist():
        if m.is_dir(): continue
        p = m.filename.replace("\\", "/")
        if p.startswith("/") or ".." in p.split("/") or ":" in p or p.startswith("__MACOSX/"): continue
        yield m, p


def _unzip_frames(zp, name, orig):
    """Images of the zip -> frame sets. Images inside folders: one set per top folder, named <name>_<folder> (deeper folders
    are kept in the file name); images at the top of the zip: the set <name>. Never an existing set."""
    try: z = zipfile.ZipFile(zp)
    except zipfile.BadZipFile: return dict(ok=False, error="not a zip file")
    with z:
        imgs = [(m, p.split("/")) for m, p in _members(z) if Path(p).suffix.lower() in IMG_EXT]
        # one wrapper folder around everything (cams/cam2/..., the usual "compress folder" zip): look inside it
        while imgs and all(len(pt) > 2 for _, pt in imgs) and len({pt[0] for _, pt in imgs}) == 1:
            imgs = [(m, pt[1:]) for m, pt in imgs]
        groups = {}
        for m, pt in imgs:
            top = pt[0] if len(pt) > 1 else ""
            groups.setdefault(top, []).append((m, "_".join(pt[1:]) if top else pt[0]))
        if not groups: return dict(ok=False, error="the zip has no images")
        names = {top: (f"{name}_{_safe(top)}" if top else name)[:80] for top in groups}
        bad = [n for n in names.values() if not re.fullmatch(NAME, n) or (RAW_F / n).exists()]
        if bad: return dict(ok=False, error="frame set(s) already exist or have a bad name: " + ", ".join(bad))
        out = []
        for top, items in sorted(groups.items()):
            d = RAW_F / names[top]; d.mkdir()
            for m, fn in items:
                fn = _safe(fn, keep_ext=True); t = d / fn; k = 2
                while t.exists(): t = d / f"{Path(fn).stem}_{k}{Path(fn).suffix}"; k += 1
                with z.open(m) as src, open(t, "wb") as dst: shutil.copyfileobj(src, dst, 1 << 20)
            (d / "set.json").write_text(json.dumps(dict(kind="uploaded zip", original_name=orig, upload=name, folder=top or None,
                                                        created=time.strftime("%Y-%m-%d %H:%M:%S")), indent=1))
            r = finish_set(names[top]); out.append(dict(set=names[top], id=f"up/{names[top]}", folder=top or None, frames=r.get("frames", 0), leak=r.get("leak")))
    tot = lambda k: sum((x["leak"] or {}).get(k, 0) for x in out)
    return dict(ok=True, sets=out, frames=sum(x["frames"] for x in out), leak=dict(n_benchmark=tot("n_benchmark"), n_reserved_day=tot("n_reserved_day")))


def _unzip_dataset(zp, name, orig):
    """A YOLO dataset zip -> datasets/<name>_upload_vNNN (never an existing folder). The zip must contain images/ and labels/
    (optionally under one top folder) and may contain data.yaml."""
    try: z = zipfile.ZipFile(zp)
    except zipfile.BadZipFile: return dict(ok=False, error="not a zip file")
    with z:
        mem = list(_members(z))
        roots = {p.split("images/")[0] for _, p in mem if "/images/" in "/" + p}
        if len(roots) != 1: return dict(ok=False, error="the zip needs exactly one images/ folder (with labels/ beside it)")
        root = roots.pop()
        if not any(p.startswith(root + "labels/") for _, p in mem): return dict(ok=False, error="no labels/ folder beside images/")
        k = 1
        while (DSROOT / f"{name}_upload_v{k:03d}").exists(): k += 1
        d = DSROOT / f"{name}_upload_v{k:03d}"; d.mkdir(); n = dict(images=0, labels=0, other=0)
        for m, p in mem:
            if not p.startswith(root): continue
            rel = p[len(root):]; ext = Path(rel).suffix.lower()
            top = rel.split("/")[0]
            if top == "images" and ext in IMG_EXT: n["images"] += 1
            elif top == "labels" and ext == ".txt": n["labels"] += 1
            elif "/" not in rel and ext in (".yaml", ".yml", ".json", ".txt", ".md"): n["other"] += 1
            else: continue
            t = d / rel; t.parent.mkdir(parents=True, exist_ok=True)
            with z.open(m) as src, open(t, "wb") as dst: shutil.copyfileobj(src, dst, 1 << 20)
    imgs = [p for p in (d / "images").rglob("*") if p.is_file() and p.suffix.lower() in IMG_EXT]
    leak = leak_check(imgs)
    man = dict(kind="uploaded labelled dataset", original_name=orig, created=time.strftime("%Y-%m-%d %H:%M:%S"), counts=n, leak=leak,
               rule="uploaded through the platform; not merged into any training dataset" +
                    ("; CONTAINS BENCHMARK / RESERVED FRAMES: never train on it" if leak["n_benchmark"] or leak["n_reserved_day"] else ""))
    (d / "upload_manifest.json").write_text(json.dumps(man, indent=1)); _FS["sig"] = None
    return dict(ok=True, dataset=d.name, counts=n, leak=leak)


# ---------------- delete (only what was uploaded or made here) ----------------
def delete(kind, ident):
    if kind == "video":
        m = re.fullmatch(r"raw/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)", ident or "")
        p = RAW_V / m[1] if m else None
        if not p or not p.is_file(): return dict(ok=False, error="video not found (only uploaded / made videos can be deleted here)")
        users = [s["name"] for s in RS.load() if s["file"] == ident]
        if users: return dict(ok=False, error=f"used by Serve RTSP stream(s) {', '.join(users)}: remove or change them first")
        p.unlink(); p.with_suffix(".json").unlink(missing_ok=True); return dict(ok=True, deleted=ident)
    if kind == "frames":
        m = re.fullmatch(r"up/(" + NAME + ")", ident or "")
        d = RAW_F / m[1] if m else None
        if not d or not d.is_dir(): return dict(ok=False, error="frame set not found (only uploaded sets can be deleted here)")
        for f in d.iterdir():
            if f.is_file(): f.unlink()
        d.rmdir(); _FS["sig"] = None; return dict(ok=True, deleted=ident)
    if kind == "dataset":
        if not re.fullmatch(r"[A-Za-z0-9_-]+_upload_v\d{3}", ident or "") or not (DSROOT / ident / "upload_manifest.json").is_file():
            return dict(ok=False, error="only datasets uploaded here (…_upload_vNNN) can be deleted here")
        shutil.rmtree(DSROOT / ident); _FS["sig"] = None; return dict(ok=True, deleted=ident)
    return dict(ok=False, error="unknown kind")
