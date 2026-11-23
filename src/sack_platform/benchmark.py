"""Benchmark tab: run a model on every frame the user approved for the benchmark (evalset.approved()) and score it
against the human labels in <eval set>/benchmark/labels/<frame id>.txt (YOLO-seg, normalised polygons).

Scoring per labelled frame, one model / confidence: predictions sorted by confidence are matched greedily to labelled sacks
by mask IoU >= 0.5 (class-agnostic). found = matched labelled sacks; class correct = matched with the same class;
false alarms = unmatched predictions; count exact = number of predictions == number of labelled sacks.
Labels marked as class -1 (written as 'ignore') are ignore regions: predictions on them count neither way.
Frames without a label file are run (overlay shown) but not scored."""
import json, threading, time, traceback
from pathlib import Path
import numpy as np, cv2
import core as C, evalset as EV

LOCK = threading.Lock()
ST = dict(run=False, model=None, done=0, total=0, err=None, started=None)


def runs_dir():
    d = EV.bench_dir() / "runs"
    d.mkdir(exist_ok=True)
    return d


def frames():
    a = EV.approved()
    lab = EV.bench_dir() / "labels"
    out = []
    for fid, v in sorted(a.items(), key=lambda kv: kv[1].get("screen_time", "")):
        out.append(dict(id=fid, labelled=(lab / f"{fid}.txt").exists(), **v))
    return out


def judge(tag, fid, verdict):
    """Human review of a model's prediction on a type-B (unlabelled) frame: fixed / partly / not_fixed / clear."""
    if verdict not in ("fixed", "partly", "not_fixed", "clear"):
        return dict(ok=False, error="bad verdict")
    if not (runs_dir() / f"{tag}.json").exists():
        return dict(ok=False, error="unknown run")
    p = runs_dir() / f"{tag}.judge.json"
    j = json.loads(p.read_text()) if p.exists() else {}
    if verdict == "clear":
        j.pop(fid, None)
    else:
        j[fid] = dict(verdict=verdict, at=time.strftime("%Y-%m-%d %H:%M:%S"))
    p.write_text(json.dumps(j, indent=1))
    return dict(ok=True, judgements=j)


def _labels(fid, W, H):
    p = EV.bench_dir() / "labels" / f"{fid}.txt"
    if not p.exists():
        return None
    gt = []
    for ln in p.read_text().splitlines():
        v = ln.split()
        if len(v) < 7:
            continue
        c = -1 if v[0] == "ignore" else int(v[0])
        P = (np.array(v[1:], float).reshape(-1, 2) * [W, H]).round().astype(np.int32)
        m = np.zeros((H, W), np.uint8)
        cv2.fillPoly(m, [P], 1)
        gt.append((c, m.astype(bool)))
    return gt


def _miou(a, b):
    i = (a & b).sum()
    return i / ((a | b).sum() + 1e-9)


def _score(preds, gt):
    keep = [g for g in gt if g[0] >= 0]
    ign = [g[1] for g in gt if g[0] < 0]
    used = set(); found = correct = fa = 0; conf_pairs = []
    for c, cf, pm in sorted(preds, key=lambda x: -x[1]):
        best = max(((_miou(pm, g[1]), i) for i, g in enumerate(keep) if i not in used), default=(0, -1))
        if best[0] >= 0.5:
            used.add(best[1]); found += 1; correct += int(c == keep[best[1]][0]); conf_pairs.append((keep[best[1]][0], c))
        elif any(_miou(pm, m) >= 0.3 or (pm & m).sum() > 0.5 * pm.sum() for m in ign):
            continue
        else:
            fa += 1
    return dict(gt=len(keep), found=found, class_correct=correct, false_alarms=fa, missed=len(keep) - found,
                count_exact=int(len(preds) == len(keep) + 0), pairs=conf_pairs)


def _region(f):
    """Carrier region of a session B frame (1600x900 scan coords) or None."""
    if f.get("source") != "session":
        return None
    try:
        d = json.loads((EV.EVAL / f["image"].split("/frames/")[0] / "dets.json").read_text())
        c = next(x for x in json.loads((EV.EVAL / f["image"].split("/frames/")[0] / "candidates.json").read_text())["candidates"] if x["id"] == f["candidate"])
    except Exception:
        return None
    ds = d["frames"][c["i"]]["dets"]
    bs = [e["box"] for e in ds if e["conf"] >= 0.25 and not e.get("static")] or [e["box"] for e in ds]
    if not bs:
        return None
    b = [min(x[0] for x in bs), min(x[1] for x in bs), max(x[2] for x in bs), max(x[3] for x in bs)]
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    hw = min(max(b[2] - b[0], b[3] - b[1]) * 0.9 + 60, 450)
    return [max(0, cx - hw), max(0, cy - hw), min(1600, cx + hw), min(900, cy + hw)]


def run(model, conf=0.25, imgsz=1024, iou=0.7, tag=None):
    with LOCK:
        if ST["run"]:
            return dict(ok=False, error=f"already running {ST['model']}")
        if model not in C.MODELS:
            return dict(ok=False, error="unknown model")
        fr = frames()
        if not fr:
            return dict(ok=False, error="no approved frames yet")
        ST.update(run=True, model=model, done=0, total=len(fr), err=None, started=time.time())
    threading.Thread(target=_run, args=(model, float(conf), int(imgsz), fr, float(iou), tag), daemon=True).start()
    return dict(ok=True)


def _run(model, conf, imgsz, fr, iou=0.7, tag=None):
    try:
        from ultralytics import YOLO
        m = C.single_class_remap(YOLO(str(C.PROJ / C.MODELS[model])))
        N = C.NAMES if hasattr(C, "NAMES") else m.names
        tag = tag or (f"{model}_c{conf:.2f}" + (f"_i{imgsz}" if imgsz != 1024 else "") + (f"_nms{iou:.2f}" if iou != 0.7 else ""))
        od = runs_dir() / tag
        od.mkdir(exist_ok=True)
        rows = []
        for f in fr:
            im = cv2.imread(str(EV.EVAL / f["image"]))
            H, W = im.shape[:2]
            r = m.predict(im, conf=conf, imgsz=imgsz, iou=iou, verbose=False, retina_masks=True)[0]
            preds = []
            ov = im.copy()
            if r.masks is not None:
                for mk, poly, c, cf in zip(r.masks.data.cpu().numpy(), r.masks.xy, r.boxes.cls.cpu().numpy().astype(int), r.boxes.conf.cpu().numpy()):
                    pm = mk > 0.5
                    if pm.shape != (H, W):
                        pm = cv2.resize(pm.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST) > 0
                    preds.append((int(c), float(cf), pm))
                    col = C.COL.get(int(c), (255, 0, 255))
                    P = poly.astype(np.int32)
                    cv2.polylines(ov, [P], True, col, 4)
                    cv2.putText(ov, f"{N.get(int(c), c) if isinstance(N, dict) else c} {cf:.2f}", (int(P[:, 0].max()) + 6, int(P[:, 1].mean())), 0, 1.1, col, 3)
            gt = _labels(f["id"], W, H) if f.get("type", "A") == "A" else None
            rv = f.get("review") or {}
            reg = _region(f) if f.get("type") == "B" and rv.get("true_count") is not None else None
            n_reg = None
            if reg is not None and r.boxes is not None:
                sx, sy = W / 1600, H / 900
                n_reg = sum(1 for bx in r.boxes.xyxy.cpu().numpy() if reg[0] * sx <= (bx[0] + bx[2]) / 2 <= reg[2] * sx and reg[1] * sy <= (bx[1] + bx[3]) / 2 <= reg[3] * sy)
            sc = _score(preds, gt) if gt is not None else None
            cv2.imwrite(str(od / f"{f['id']}.jpg"), cv2.resize(ov, (1600, int(1600 * H / W))), [cv2.IMWRITE_JPEG_QUALITY, 85])
            rows.append(dict(id=f["id"], type=f.get("type"), review=f.get("review"), tags=(f.get("review") or {}).get("situations") or f.get("tags", []), labelled=gt is not None, n_pred=len(preds),
                             preds=[dict(cls=p[0], conf=round(p[1], 3)) for p in preds], score=sc, overlay=f"{tag}/{f['id']}.jpg",
                             true_count=rv.get("true_count"), n_region=n_reg))
            with LOCK:
                ST["done"] += 1
        lab = [x for x in rows if x["score"]]
        tot = {k: sum(x["score"][k] for x in lab) for k in ("gt", "found", "class_correct", "false_alarms", "missed", "count_exact")}
        by_tag = {}
        for x in lab:
            for t in x["tags"]:
                b = by_tag.setdefault(t, dict(gt=0, found=0, class_correct=0, false_alarms=0))
                for k in b:
                    b[k] += x["score"][k]
        bc = [x for x in rows if x.get("n_region") is not None]
        bcount = dict(frames=len(bc), exact=sum(1 for x in bc if x["n_region"] == x["true_count"]),
                      under=sum(1 for x in bc if x["n_region"] < x["true_count"]), over=sum(1 for x in bc if x["n_region"] > x["true_count"]),
                      mean_abs_err=round(float(np.mean([abs(x["n_region"] - x["true_count"]) for x in bc])), 2) if bc else None)
        summary = dict(model=model, weights=C.MODELS[model], conf=conf, imgsz=imgsz, iou=iou, b_count=bcount, at=time.strftime("%Y-%m-%d %H:%M:%S"),
                       frames=len(rows), labelled_frames=len(lab), **tot,
                       recall=round(tot["found"] / tot["gt"], 3) if tot["gt"] else None,
                       class_accuracy=round(tot["class_correct"] / tot["found"], 3) if tot["found"] else None,
                       precision=round(tot["found"] / (tot["found"] + tot["false_alarms"]), 3) if (tot["found"] + tot["false_alarms"]) else None,
                       count_exact_rate=round(tot["count_exact"] / len(lab), 3) if lab else None, by_tag=by_tag)
        (runs_dir() / f"{tag}.json").write_text(json.dumps(dict(summary=summary, frames=rows), indent=1))
    except Exception as e:
        with LOCK:
            ST["err"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()
    finally:
        with LOCK:
            ST["run"] = False


def status():
    with LOCK:
        return dict(ST)


def results():
    out = []
    fr = frames()
    typ = {f["id"]: f.get("type") for f in fr}
    for p in sorted(runs_dir().glob("*.json")):
        if p.name.endswith(".judge.json"):
            continue
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        jp = runs_dir() / f"{p.stem}.judge.json"
        j = json.loads(jp.read_text()) if jp.exists() else {}
        bids = [f["id"] for f in d["frames"] if typ.get(f["id"]) == "B"]
        bj = dict(frames=len(bids), fixed=sum(1 for i in bids if j.get(i, {}).get("verdict") == "fixed"),
                  partly=sum(1 for i in bids if j.get(i, {}).get("verdict") == "partly"),
                  not_fixed=sum(1 for i in bids if j.get(i, {}).get("verdict") == "not_fixed"))
        bj["unreviewed"] = bj["frames"] - bj["fixed"] - bj["partly"] - bj["not_fixed"]
        out.append(dict(tag=p.stem, summary=d["summary"], frames=d["frames"], judgements=j, b=bj))
    errs = {}
    for f in fr:
        if f.get("type") == "B":
            for e in (f.get("review") or {}).get("errors", []):
                errs[e] = errs.get(e, 0) + 1
    return dict(runs=out, models=sorted(C.MODELS), frames=fr, b_errors=errs,
                counts=dict(A=sum(1 for f in fr if f.get("type") == "A"), B=sum(1 for f in fr if f.get("type") == "B")))


def file_path(*rel):
    base = runs_dir().resolve()
    p = (base / Path(*rel)).resolve()
    if base not in p.parents or not p.is_file():
        return None
    return p
