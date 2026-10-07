"""Step 1 extension: walk a playback range and auto-tag moments where a chosen
class appears, in one of four ways ("signal"):

  model     the real detector's own class call, at your deploy confidence.
  hsv       the seam-colour vote on the SAME region the model localized -
            classify_crop() re-runs cosmos/hsv3.py's validated algorithm on a
            live crop instead of a stored training crop. HSV alone cannot
            localize (measured: 25.6 spurious blobs/frame scanning whole
            frames blind - wall stacks carry the same seam colours as carried
            sacks), so it always rides on the model's own detection box.
            It also can only report a FAMILY, not a class: red_sack and
            other_sack_red_grey share a hue and differ by body brightness, not
            colour, so a "red" vote may be either - the saved tag says so.
  either    counts a hit if the model OR the hsv vote matches a selected class.
  disagree  flags detections where the model's class and the hsv vote on the
            SAME region give different colour families - e.g. model says
            blue_sack but the seam it drew a box around reads red. That is
            exactly the kind of conflict the manual label audit went looking
            for; this finds candidates for it automatically. Ignores hsv
            abstentions (none/hidden/mixed) - only a CONFIDENT contradiction
            counts, since hsv "can't tell" is not evidence the model is wrong.

Every mode still requires the model to run (for localization), so unlike the
plain scrubbing preview this does use the GPU. Runs in a background thread so
the UI can poll progress; keeps its OWN model cache (see _get_model below),
separate from capture.py's live-watch worker and from autocapture, so a scan
can run at the same time as either without one blocking the other.
"""
import threading, time, re, shutil
from datetime import datetime, timedelta
from pathlib import Path
import numpy as np, cv2
import core as C
import preview as PV
import hsv_detect as HD

EVID_DIR = C.ROOT/"scan_events"
EVID_DIR.mkdir(exist_ok=True)
MAX_EVIDENCE_PER_EVENT = 4   # cap how many crops one hit-range accumulates

_models={}   # scan's OWN model cache - deliberately not shared with capture.py's
            # get_model()/get_model_auto(). An ultralytics YOLO object isn't safe
            # to call .predict() on from two threads at once, so a scan (its own
            # background thread) never touches the same instance the live-watch
            # worker or autocapture use - each gets its own ~63 MB copy instead of
            # the three being serialized against each other.
def _get_model(name):
    if name not in _models:
        from ultralytics import YOLO
        _models[name]=C.single_class_remap(YOLO(str(C.PROJ/C.MODELS[name])))
    return _models[name]
def preload(name):
    m=_get_model(name)
    m.predict(np.zeros((640,640,3),dtype=np.uint8), device=0, verbose=False)
    return True
def unload_one(name):
    if _models.pop(name,None) is None: return False
    import gc; gc.collect()
    try:
        import torch
        if torch.cuda.is_available(): torch.cuda.empty_cache()
    except Exception: pass
    return True
def model_status():
    return sorted(_models)
def unload():
    _models.clear()

SC=dict(run=False, base="", dt_start="", dt_end="", cur="", pct=0.0,
        err="", classes=[], model="v21", conf=0.35, speed=8, signal="model", min_hits=2,
        hits=0, found=[], dropped=0, done=False)
LOCK=threading.Lock()
_stop=threading.Event()
MERGE_GAP=20.0
REOPEN_EVERY=400

def _parse(dt):
    dt=dt.replace("T"," ")
    for fmt in ("%Y-%m-%d %H:%M:%S","%Y-%m-%d %H:%M"):
        try: return datetime.strptime(dt,fmt)
        except ValueError: continue
    raise ValueError(f"bad datetime: {dt!r}")

def status():
    with LOCK: return dict(SC)

def stop():
    _stop.set()
    with LOCK: SC["run"]=False

def start(url, duration_min, classes, model="v21", conf=0.35, speed=8, signal="model", min_hits=2):
    if not classes:
        return dict(ok=False, error="pick at least one class")
    if signal not in ("model","hsv","either","disagree"):
        return dict(ok=False, error=f"unknown signal: {signal}")
    with LOCK:
        if SC["run"]:
            return dict(ok=False, error="a scan is already running - stop it first")
    url=url.strip()
    found_dt=PV.parse_starttime(url)
    if not found_dt:
        return dict(ok=False, error="URL has no starttime= - open it in the preview above first, or paste it directly")
    base=__import__("re").sub(r"[?&]starttime=[^&]*","",url)
    try:
        t0=_parse(found_dt); t1=t0+timedelta(minutes=float(duration_min))
    except ValueError as e:
        return dict(ok=False, error=str(e))
    _stop.clear()
    with LOCK:
        SC.update(run=True, base=base, dt_start=found_dt, dt_end=t1.strftime("%Y-%m-%d %H:%M:%S"),
                  cur=found_dt, pct=0.0, err="", classes=list(classes), model=model,
                  conf=float(conf), speed=int(speed), signal=signal, min_hits=max(1,int(min_hits)),
                  hits=0, found=[], dropped=0, done=False)
    threading.Thread(target=_worker, daemon=True).start()
    return dict(ok=True)

def _reopen(base, dt):
    cap=cv2.VideoCapture(C.build_playback_url(base, dt), cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap

def _evid_folder(session_id, key, start_dt):
    slug=re.sub(r"[^A-Za-z0-9_.-]","_", f"{key}_{start_dt}")
    return EVID_DIR/session_id/slug

def _save_evidence(frame, det, folder, idx):
    """Tight, generously-padded crop around the one detection that fired,
    with the model's box and the hsv vote (if any) burned in - the actual
    pixels that caused the event, not just a timestamp pointing back at a
    live camera that may not have this footage tomorrow."""
    x1,y1,x2,y2=[int(v) for v in det["box"]]
    H,W=frame.shape[:2]
    pad=int(0.8*max(x2-x1,y2-y1))+40
    cx1,cy1=max(0,x1-pad),max(0,y1-pad); cx2,cy2=min(W,x2+pad),min(H,y2+pad)
    if cx2<=cx1 or cy2<=cy1: return None
    crop=frame[cy1:cy2,cx1:cx2].copy()
    bx1,by1,bx2,by2=x1-cx1,y1-cy1,x2-cx1,y2-cy1
    cid=C.NAME2ID.get(det["cls_name"]); col=C.COL.get(cid,(200,200,200))
    cv2.rectangle(crop,(bx1,by1),(bx2,by2),col,3)
    lab=f"{det['cls_name']} {det['conf']:.2f}"
    if det["hsv"]: lab+=f"   hsv:{det['hsv']['vote']}"
    cv2.rectangle(crop,(0,0),(crop.shape[1],26),(0,0,0),-1)
    cv2.putText(crop,lab,(6,19),cv2.FONT_HERSHEY_SIMPLEX,0.56,(120,220,255),2)
    if max(crop.shape[:2])>500:
        s=500/max(crop.shape[:2]); crop=cv2.resize(crop,None,fx=s,fy=s,interpolation=cv2.INTER_AREA)
    folder.mkdir(parents=True,exist_ok=True)
    p=folder/f"f{idx:02d}.jpg"
    ok=cv2.imwrite(str(p),crop,[cv2.IMWRITE_JPEG_QUALITY,90])
    return p.relative_to(EVID_DIR).as_posix() if ok else None

def _flush(key, rec, base, min_hits):
    """A hit-range only becomes a saved moment once it has repeated at least
    min_hits times. A single stray vote is exactly the ~5-7% baseline error
    rate measured on hsv3 - not evidence of anything, just noise; requiring
    persistence is what tells a real, repeatable signal apart from that.
    A dropped range's evidence crops are deleted - no point keeping images
    for something we just decided was noise."""
    folder=rec.get("folder")
    if rec["n"] < min_hits:
        if folder and folder.exists(): shutil.rmtree(folder, ignore_errors=True)
        with LOCK: SC["dropped"]=SC.get("dropped",0)+1
        return
    note=f"auto-found ({rec['kind']}): {rec['n']} hit(s), conf {rec['lo']:.2f}-{rec['hi']:.2f}, " \
         f"{rec['start']} to {rec['last']}"
    C.add_source(dict(url=C.build_playback_url(base, rec["start"]), base=base,
                      datetime=rec["start"], tag=f"{rec['label']} (auto)", note=note,
                      frames=rec.get("frames",[])))
    with LOCK:
        SC["found"]=[dict(key=key, label=rec["label"], start=rec["start"], end=rec["last"],
                          n=rec["n"], conf_lo=round(rec["lo"],3), conf_hi=round(rec["hi"],3),
                          frames=rec.get("frames",[]))]+SC["found"]

def _detections(r, frame, signal):
    """One sampled frame -> list of per-box dicts: box, poly, cls_name, conf,
    hsv (vote dict or None). Shared by event logic and the live overlay so hsv
    is only computed once per box."""
    out=[]
    if r.boxes is None: return out
    polys = r.masks.xy if r.masks is not None else None
    boxes = r.boxes.xyxy.cpu().numpy()
    clss = r.boxes.cls.cpu().numpy().astype(int)
    confs = r.boxes.conf.cpu().numpy()
    for i in range(len(clss)):
        cname=C.NAMES.get(int(clss[i]))
        if cname is None: continue
        poly = polys[i] if polys is not None and i<len(polys) else \
               np.array([[boxes[i][0],boxes[i][1]],[boxes[i][2],boxes[i][1]],
                         [boxes[i][2],boxes[i][3]],[boxes[i][0],boxes[i][3]]])
        hsv=None
        if signal in ("hsv","either","disagree"):
            hsv=HD.classify_crop(frame, poly)
        out.append(dict(box=boxes[i], poly=poly, cls_name=cname, conf=float(confs[i]), hsv=hsv))
    return out

def _frame_events(dets, classes, signal):
    """Per-box detections (with hsv already computed) -> (key, label, score, kind, det)
    hits. det travels with the event so the worker can save the exact crop
    that triggered it, not just a timestamp."""
    events=[]
    for d in dets:
        cname,q,hsv_vote = d["cls_name"], d["conf"], (d["hsv"]["vote"] if d["hsv"] else None)
        model_hit = cname in classes
        confident_hsv = hsv_vote in ("red","green","blue","tan")

        if signal=="model" and model_hit:
            events.append((cname, cname, q, f"model:{cname}", d))
        elif signal=="hsv" and confident_hsv:
            if any(c in classes for c in C.FAM2CLASS.get(hsv_vote,[])):
                events.append((f"hsv:{hsv_vote}", f"{hsv_vote} family", q, f"hsv:{hsv_vote}", d))
        elif signal=="either":
            if model_hit: events.append((cname, cname, q, f"model:{cname}", d))
            if confident_hsv and any(c in classes for c in C.FAM2CLASS.get(hsv_vote,[])):
                events.append((f"hsv:{hsv_vote}", f"{hsv_vote} family", q, f"hsv:{hsv_vote}", d))
        elif signal=="disagree" and model_hit and confident_hsv:
            if hsv_vote != C.FAM.get(cname):
                lab=f"{cname} vs {hsv_vote}"
                events.append((f"disagree:{cname}:{hsv_vote}", lab, q, f"model {cname} / hsv {hsv_vote}", d))
    return events

def _annotate(frame, dets, dt_str, meta):
    """Draw model boxes (+ hsv vote alongside, when computed) and a HUD line,
    same visual language as capture.py's live view. Returns JPEG bytes."""
    ann=frame.copy()
    for d in dets:
        x1,y1,x2,y2 = [int(v) for v in d["box"]]
        cid=C.NAME2ID.get(d["cls_name"]); col=C.COL.get(cid,(200,200,200))
        cv2.rectangle(ann,(x1,y1),(x2,y2),col,3)
        lab=f"{C.SHORT.get(cid,d['cls_name'])} {d['conf']:.2f}"
        if d["hsv"]:
            v=d["hsv"]["vote"]
            agree = (v==C.FAM.get(d["cls_name"]))
            vcol=(90,220,90) if agree else ((60,60,220) if v in ("red","green","blue","tan") else (140,140,140))
            lab+=f"  hsv:{v}"
            cv2.putText(ann,lab,(x1+2,max(16,y1-8)),cv2.FONT_HERSHEY_SIMPLEX,0.58,vcol,2)
        else:
            cv2.rectangle(ann,(x1,y1-22),(x1+13*len(lab),y1),col,-1)
            cv2.putText(ann,lab,(x1+3,y1-6),cv2.FONT_HERSHEY_SIMPLEX,0.55,(0,0,0),2)
    hud=f"SCAN [{meta['signal']}]  {meta['model']} @{meta['conf']:.2f}  {meta['speed']}x   " \
        f"{dt_str}   {meta['pct']:.1f}%   hits {meta['hits']}"
    cv2.rectangle(ann,(0,0),(ann.shape[1],40),(0,0,0),-1)
    cv2.putText(ann,hud,(10,27),cv2.FONT_HERSHEY_SIMPLEX,0.68,(120,220,255),2)
    h,w=ann.shape[:2]; W=1280
    ok,jpg=cv2.imencode(".jpg",cv2.resize(ann,(W,int(h*W/w))),[cv2.IMWRITE_JPEG_QUALITY,80])
    return jpg.tobytes() if ok else None

_FRAME_LOCK=threading.Lock()
_frame=None
def latest_jpeg():
    with _FRAME_LOCK: return _frame
def _publish(jpg):
    global _frame
    with _FRAME_LOCK: _frame=jpg

def _worker():
    with LOCK:
        base,dt0,dt1=SC["base"],SC["dt_start"],SC["dt_end"]
        classes,model,conf,speed,signal=SC["classes"],SC["model"],SC["conf"],SC["speed"],SC["signal"]
        min_hits=SC["min_hits"]
    t0=_parse(dt0); t1=_parse(dt1); total_s=max(1.0,(t1-t0).total_seconds())
    cur_t=t0
    cap=_reopen(base, cur_t.strftime("%Y-%m-%d %H:%M:%S"))
    if not cap.isOpened():
        with LOCK: SC["err"]="cannot open stream at start time"; SC["run"]=False; SC["done"]=True
        return
    src_fps=cap.get(cv2.CAP_PROP_FPS) or 25.0
    if not (1<=src_fps<=60): src_fps=25.0
    reads=0; active={}
    session_id=time.strftime("%Y%m%d_%H%M%S")
    try:
        while cur_t<t1 and not _stop.is_set():
            ok,fr=cap.read()
            if not ok:
                cap.release(); cap=_reopen(base, cur_t.strftime("%Y-%m-%d %H:%M:%S")); reads=0
                if not cap.isOpened():
                    with LOCK: SC["err"]="lost stream, could not resume"
                    break
                time.sleep(0.4); continue
            for _ in range(max(0,int(speed)-1)): cap.grab()
            cur_t=cur_t+timedelta(seconds=speed/src_fps); reads+=1
            dt_str=cur_t.strftime("%Y-%m-%d %H:%M:%S")
            try:
                r=_get_model(model).predict(fr, conf=conf, imgsz=1024, device=0, verbose=False)[0]
            except Exception as e:
                with LOCK: SC["err"]=f"inference: {type(e).__name__}: {e}"
                break
            dets=_detections(r, fr, signal)
            evs=_frame_events(dets, classes, signal)
            seen=set()
            for key,label,q,kind,det in evs:
                seen.add(key)
                rec=active.get(key)
                if rec:
                    rec["n"]+=1; rec["last"]=dt_str
                    rec["lo"]=min(rec["lo"],q); rec["hi"]=max(rec["hi"],q)
                else:
                    folder=_evid_folder(session_id, key, dt_str)
                    rec=dict(start=dt_str,last=dt_str,n=1,lo=q,hi=q,label=label,kind=kind,
                             folder=folder,frames=[])
                    active[key]=rec
                if len(rec["frames"])<MAX_EVIDENCE_PER_EVENT:
                    p=_save_evidence(fr, det, rec["folder"], len(rec["frames"]))
                    if p: rec["frames"].append(p)
                with LOCK: SC["hits"]+=1
            for key in list(active):
                if key in seen: continue
                if (cur_t-_parse(active[key]["last"])).total_seconds()>MERGE_GAP:
                    _flush(key, active.pop(key), base, min_hits)
            with LOCK:
                SC["cur"]=dt_str
                SC["pct"]=round(100*min(1.0,(cur_t-t0).total_seconds()/total_s),1)
                _hits_now=SC["hits"]
            _publish(_annotate(fr, dets, dt_str,
                               dict(signal=signal,model=model,conf=conf,speed=speed,
                                    pct=SC["pct"],hits=_hits_now)))
            if reads and reads%REOPEN_EVERY==0:
                cap.release(); cap=_reopen(base, dt_str); reads=0
                if not cap.isOpened():
                    with LOCK: SC["err"]="lost stream on reconnect"
                    break
    finally:
        for key,rec in list(active.items()): _flush(key, rec, base, min_hits)
        if cap: cap.release()
        _publish(None)
        with LOCK: SC["run"]=False; SC["done"]=True; SC["pct"]=100.0
