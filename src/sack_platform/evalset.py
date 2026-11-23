"""Eval events tab: read-only view of the verified eval events under <PROJECT_ROOT>/eval/<set>/events/*/event.json
(full RTSP playback link, screen/PKT times, description, tags, v21 issue, frames and preview clip) plus eval/EVAL_RESERVED.json."""
import json
from pathlib import Path
from config import PROJECT_ROOT

EVAL = PROJECT_ROOT / "eval"


def _events_dirs():
    return sorted(EVAL.glob("*/events/*/event.json"))


def events():
    out = []
    for f in _events_dirs():
        try:
            ev = json.loads(f.read_text())
        except Exception:
            continue
        key = f"{f.parent.parent.parent.name}/{f.parent.name}"      # <set>/<event dir>
        ev["key"] = key
        ev["set"] = f.parent.parent.parent.name
        out.append(ev)
    reserved = {}
    try:
        reserved = json.loads((EVAL / "EVAL_RESERVED.json").read_text())
    except Exception:
        pass
    return dict(events=out, reserved=reserved)


def sessions():
    """Rule-based hard-frame candidates per scanned session, with the user's accept/reject decisions."""
    out = []
    for f in sorted(EVAL.glob("*/sessions/*/candidates.json")):
        try:
            s = json.loads(f.read_text())
        except Exception:
            continue
        dec = {}
        try:
            dec = json.loads((f.parent / "decisions.json").read_text())
        except Exception:
            pass
        s["key"] = f"{f.parent.parent.parent.name}/{f.parent.name}"
        s["decisions"] = dec
        out.append(s)
    return dict(sessions=out)


def file_path(set_name, event_dir, *rel, kind="events"):
    """Only files inside a known event / session directory (no path escapes)."""
    base = (EVAL / set_name / kind / event_dir).resolve()
    if not ((base / "event.json").exists() or (base / "candidates.json").exists()):
        return None
    p = (base / Path(*rel)).resolve()
    if base not in p.parents or not p.is_file():
        return None
    return p


# ---------------- benchmark membership (only frames the user approved) ----------------
BENCH_SET = "v21_hard_pilot_v001"


def bench_dir():
    d = EVAL / BENCH_SET / "benchmark"
    (d / "labels").mkdir(parents=True, exist_ok=True)
    return d


def approved():
    p = bench_dir() / "approved.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _save_approved(a):
    (bench_dir() / "approved.json").write_text(json.dumps(a, indent=1))


ERRORS = ["not_detected", "merged", "double_count", "duplicate", "wrong_class", "fp_person", "fp_background", "bad_outline", "low_confidence", "other"]
SITUATIONS = ["multi_sack", "single_sack", "bright_doorway", "partly_hidden", "frame_edge", "overlapping_carriers", "far_small", "coloured_clothing"]
LABEL_CONF = 0.25          # type A: v21 outlines at/above this confidence become the label


def _write_label(fid, polys, W, H):
    """polys: [(cls or 'ignore', [[x,y],...] in pixels of a W x H image)] -> benchmark/labels/<fid>.txt (YOLO-seg normalised)."""
    lines = []
    for c, P in polys:
        if len(P) < 3:
            continue
        lines.append(" ".join([str(c)] + [f"{x / W:.5f} {y / H:.5f}" for x, y in P]))
    (bench_dir() / "labels" / f"{fid}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
    return len([l for l in lines if not l.startswith("ignore")])


def _drop_label(fid):
    p = bench_dir() / "labels" / f"{fid}.txt"
    if p.exists():
        p.unlink()


def _clean_review(r):
    r = r or {}
    errs = [e for e in (r.get("errors") or []) if e in ERRORS]
    tags = [t for t in (r.get("situations") or []) if t in SITUATIONS]
    tc = r.get("true_count")
    try:
        tc = int(tc) if tc not in (None, "") else None
    except Exception:
        tc = None
    return dict(errors=errs, situations=tags, true_count=tc, note=str(r.get("note") or "")[:500])


def approve_event_frame(event_key, frame_file, decision, btype=None, review=None):
    """decision accept (btype 'A' = v21 correct -> its outlines become the label, 'B' = v21 wrong -> needs labels) / reject."""
    import time
    set_name, _, ed = event_key.partition("/")
    j = EVAL / set_name / "events" / ed / "event.json"
    if not j.exists():
        return dict(ok=False, error="unknown event")
    ev = json.loads(j.read_text())
    fr = next((f for f in ev["frames"] if f["file"] == frame_file), None)
    if fr is None:
        return dict(ok=False, error="unknown frame")
    fid = f"{ev['id']}__{Path(frame_file).stem}"
    a = approved()
    rv = _clean_review(review)
    if decision == "accept":
        if btype not in ("A", "B"):
            return dict(ok=False, error="choose A or B")
        if btype == "B" and not rv["errors"]:
            return dict(ok=False, error="tick at least one 'what is wrong' box")
        polys = [(p["cls_id"], p["poly"]) for p in fr.get("v21_polys", []) if p["conf"] >= LABEL_CONF]
        a[fid] = dict(source="event", event=ev["id"], event_key=event_key, image=f"{set_name}/events/{ed}/{frame_file}",
                      screen_time=fr["screen_time"], channel=ev["channel"], rtsp=ev["rtsp"], description=ev["description"],
                      tags=ev.get("tags", []), note=fr.get("note", ""), sha256=fr.get("sha256"), type=btype,
                      v21_count=len(polys), review=rv, approved_at=time.strftime("%Y-%m-%d %H:%M:%S"))
        if btype == "A":
            if not fr.get("v21_polys") and fr.get("v21"):
                return dict(ok=False, error="no stored v21 outlines for this frame")
            _write_label(fid, polys, *fr.get("size", [3200, 1800]))
        else:
            _drop_label(fid)
        fr["benchmark"] = btype
    else:
        a.pop(fid, None)
        _drop_label(fid)
        fr["benchmark"] = None
    _save_approved(a)
    j.write_text(json.dumps(ev, indent=1))
    return dict(ok=True, id=fid, type=fr["benchmark"])


def _extract_candidate(sdir, c):
    """Native-resolution frame of an accepted candidate, cut from the session clip at its exact offset."""
    import subprocess, hashlib
    from config import ffmpeg_bin
    s = json.loads((sdir / "candidates.json").read_text())
    clip = sdir / s["clip"]
    out = sdir / "frames" / f"{c['id']}.png"
    out.parent.mkdir(exist_ok=True)
    if not out.exists():
        if not clip.exists():
            return None
        subprocess.run([ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-ss", f"{c['clip_offset_s']:.3f}", "-i", str(clip),
                        "-frames:v", "1", str(out)], check=True)
    return out, hashlib.sha256(out.read_bytes()).hexdigest()


def decide(key, cid, decision, note="", btype=None, review=None):
    import time
    set_name, _, sess = key.partition("/")
    d = (EVAL / set_name / "sessions" / sess).resolve()
    if EVAL.resolve() not in d.parents or not (d / "candidates.json").exists():
        return dict(ok=False, error="unknown session")
    if decision not in ("accept", "reject", "clear"):
        return dict(ok=False, error="bad decision")
    s = json.loads((d / "candidates.json").read_text())
    c = next((x for x in s["candidates"] if x["id"] == cid), None)
    if c is None:
        return dict(ok=False, error="unknown candidate")
    p = d / "decisions.json"
    dec = json.loads(p.read_text()) if p.exists() else {}
    a = approved()
    fid = f"{sess}__{cid}"
    rv = _clean_review(review)
    if decision == "accept":
        if btype not in ("A", "B"):
            return dict(ok=False, error="choose A or B")
        if btype == "B" and not rv["errors"]:
            return dict(ok=False, error="tick at least one 'what is wrong' box")
        r = _extract_candidate(d, c)
        if r is None:
            return dict(ok=False, error="session clip already deleted - cannot cut the native frame")
        img, sha = r
        # v21 outlines the scan saw on this exact frame (1600x900 coords); static = stored stock -> ignore region
        dets = json.loads((d / "dets.json").read_text())["frames"][c["i"]]["dets"]
        moving = [(x["cls"], x["poly"]) for x in dets if x["conf"] >= LABEL_CONF and not x.get("static")]
        stock = [("ignore", x["poly"]) for x in dets if x["conf"] >= LABEL_CONF and x.get("static")]
        dec[cid] = dict(decision="accept", type=btype, review=rv, note=note, at=time.strftime("%Y-%m-%d %H:%M:%S"))
        a[fid] = dict(source="session", session=sess, candidate=cid, image=f"{set_name}/sessions/{sess}/frames/{cid}.png",
                      screen_time=c["screen_time"], channel=s.get("channel"), rtsp=s.get("rtsp"), description=s.get("description", ""),
                      tags=s.get("tags", []), note="; ".join(c.get("reasons", [])), sha256=sha, type=btype, v21_count=len(moving),
                      review=rv, approved_at=dec[cid]["at"])
        if btype == "A":
            _write_label(fid, moving + stock, 1600, 900)
        else:
            _drop_label(fid)
    elif decision == "reject":
        dec[cid] = dict(decision="reject", note=note, at=time.strftime("%Y-%m-%d %H:%M:%S"))
        a.pop(fid, None)
        _drop_label(fid)
    else:
        dec.pop(cid, None)
        a.pop(fid, None)
        _drop_label(fid)
    p.write_text(json.dumps(dec, indent=1))
    _save_approved(a)
    return dict(ok=True, decisions=dec)


def finish_session(key):
    """After the user has decided every candidate: delete the big session clip (the accepted frames are already cut)."""
    set_name, _, sess = key.partition("/")
    d = (EVAL / set_name / "sessions" / sess).resolve()
    if EVAL.resolve() not in d.parents or not (d / "candidates.json").exists():
        return dict(ok=False, error="unknown session")
    s = json.loads((d / "candidates.json").read_text())
    dec = json.loads((d / "decisions.json").read_text()) if (d / "decisions.json").exists() else {}
    open_ = [c["id"] for c in s["candidates"] if c["id"] not in dec]
    if open_:
        return dict(ok=False, error=f"{len(open_)} candidates not decided yet")
    clip = d / s["clip"]
    freed = 0
    if clip.exists():
        freed = clip.stat().st_size
        clip.unlink()
    s["clip_deleted"] = True
    (d / "candidates.json").write_text(json.dumps(s, indent=1))
    return dict(ok=True, freed_mb=round(freed / 2**20, 1))


def rtsp_sources():
    """One row per RTSP playback link used for the benchmark: what it contains + how many approved frames."""
    a = approved()
    rows = []
    for e in events()["events"]:
        n = sum(1 for v in a.values() if v.get("event") == e["id"])
        rows.append(dict(kind="event", id=e["id"], rtsp=e.get("rtsp"), channel=e.get("channel"), window=f"{e['screen_start']} - {e['screen_end'][11:]}",
                         contains=e.get("contains") or ", ".join(e.get("tags", [])), classes=e.get("classes", []),
                         description=e.get("description", ""), approved_frames=n))
    for s in sessions()["sessions"]:
        n = sum(1 for v in a.values() if v.get("session") == s["session"])
        rows.append(dict(kind="session", id=s["session"], rtsp=s.get("rtsp"), channel=s.get("channel"), window=s.get("window", ""),
                         contains=s.get("contains", ""), classes=s.get("classes", []), description=s.get("description", ""), approved_frames=n))
    return dict(sources=rows)
