"""Step 2: watch a source and save a burst of frames on demand."""
import json, os, threading, time, gc
from collections import deque
from pathlib import Path
import numpy as np, cv2
import core as C

S=dict(url="",label="",model="v21",conf=0.35,run=False,fps=0.0,counts={},err="",
       frame=None,n=0,buf_n=10,buf_fps=1.0,source_id="",tag="")
BUF=deque(maxlen=60)
LOCK=threading.Lock()
_models={}          # used by the continuous live-watch worker() thread
_models_auto={}     # used by autocapture() - deliberately separate: an ultralytics
                    # YOLO object is not safe to call .predict() on from two threads
                    # at once (it keeps mutable predictor state internally), so
                    # anything that can run concurrently with the live-watch worker
                    # gets its own instance rather than sharing one. 63 MB each,
                    # trivial next to 16 GB of GPU memory - cheaper than serializing.

def get_model(name):
    if name not in _models:
        from ultralytics import YOLO
        _models[name]=C.single_class_remap(YOLO(str(C.PROJ/C.MODELS[name])))
    return _models[name]

def get_model_auto(name):
    if name not in _models_auto:
        from ultralytics import YOLO
        _models_auto[name]=C.single_class_remap(YOLO(str(C.PROJ/C.MODELS[name])))
    return _models_auto[name]

def _warm(m):
    """A bare YOLO(path) doesn't actually put weights on the GPU or compile
    CUDA kernels until the first predict() call - so 'preload' does one tiny
    inference to make 'loaded' a true statement, and to take the ~1s warm-up
    hit now instead of on your next real capture."""
    m.predict(np.zeros((640,640,3),dtype=np.uint8), device=0, verbose=False)

def preload(name):
    _warm(get_model(name)); return True
def preload_auto(name):
    _warm(get_model_auto(name)); return True
def _free(d,name):
    if d.pop(name,None) is not None:
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available(): torch.cuda.empty_cache()
        except Exception: pass
        return True
    return False
def unload_one(name): return _free(_models,name)
def unload_one_auto(name): return _free(_models_auto,name)
def status():
    return dict(live=sorted(_models), auto=sorted(_models_auto))

def unload():
    import torch
    _models.clear()
    _models_auto.clear()
    with LOCK:
        BUF.clear(); S["frame"]=None; S["counts"]={}; S["n"]=0; S["fps"]=0.0
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache(); torch.cuda.ipc_collect()
        return round(torch.cuda.mem_get_info()[0]/2**20)
    return 0

def annotate(fr,r):
    ann=fr.copy(); counts={}; dets=[]
    if r.masks is not None:
        for poly,c,q in zip(r.masks.xy,r.boxes.cls.cpu().numpy().astype(int),
                            r.boxes.conf.cpu().numpy()):
            c=int(c); pts=np.asarray(poly,np.int32)
            ov=ann.copy(); cv2.fillPoly(ov,[pts],C.COL[c]); ann=cv2.addWeighted(ov,.30,ann,.70,0)
            cv2.polylines(ann,[pts],True,C.COL[c],3)
            x,y=int(pts[:,0].min()),int(pts[:,1].min())
            t=f"{C.SHORT[c]} {q:.2f}"
            cv2.rectangle(ann,(x,y-26),(x+13*len(t),y),C.COL[c],-1)
            cv2.putText(ann,t,(x+4,y-7),cv2.FONT_HERSHEY_SIMPLEX,0.62,(0,0,0),2)
            counts[C.SHORT[c]]=counts.get(C.SHORT[c],0)+1
            dets.append(dict(cls=c,name=C.NAMES.get(c,"sack_any"),conf=round(float(q),3),
                             poly=[[round(float(a),1),round(float(b),1)] for a,b in poly]))
    return ann,counts,dets

BLACK_THRESH=5.0   # mean pixel value below this = effectively black (real footage measures ~94-103)
BLACK_LIMIT=20     # consecutive black reads before forcing a reconnect
FROZEN_LIMIT=90    # consecutive byte-identical reads before forcing a reconnect

def worker():
    cap=None; cur=""; last=0.0
    black_streak=0; frozen_streak=0; prev_sig=None; bad_reconnects=0
    while True:
        with LOCK:
            run,url,mn,cf,bfps,bn=S["run"],S["url"],S["model"],S["conf"],S["buf_fps"],S["buf_n"]
        if not run or not url:
            if cap: cap.release(); cap=None; cur=""
            black_streak=frozen_streak=bad_reconnects=0; prev_sig=None
            time.sleep(0.3); continue
        if cap is None or cur!=url:
            if cap: cap.release()
            cap=cv2.VideoCapture(url,cv2.CAP_FFMPEG); cap.set(cv2.CAP_PROP_BUFFERSIZE,1)
            cur=url; black_streak=frozen_streak=0; prev_sig=None
            with LOCK:
                S["err"]="" if cap.isOpened() else "cannot open stream - check URL / time"
                BUF.clear()
            if not cap.isOpened(): time.sleep(2); cap=None; continue
        ok,fr=cap.read()
        if not ok:
            with LOCK: S["err"]="stream ended or read failed"
            cap.release(); cap=None; time.sleep(1.5); continue
        # cap.read() reporting ok=True doesn't mean the frame is real content: an RTSP
        # reconnect often delivers a few near-black frames while the decoder warms up, and a
        # playback source that stalls (e.g. near the end of the recorded window) can keep
        # re-sending the exact same frame instead of ever failing the read. Neither trips
        # ok=False, so without this check the platform would silently broadcast a black or
        # frozen picture as if it were live - which is exactly what was reported.
        mean_val=float(fr.mean())
        sig=(round(mean_val,1), fr[::37,::41].tobytes())  # cheap, position-sensitive signature
        is_black=mean_val<BLACK_THRESH
        is_frozen=(prev_sig is not None and sig==prev_sig)
        black_streak=black_streak+1 if is_black else 0
        frozen_streak=frozen_streak+1 if is_frozen else 0
        prev_sig=sig
        if black_streak>=BLACK_LIMIT or frozen_streak>=FROZEN_LIMIT:
            reason="source went black" if black_streak>=BLACK_LIMIT else "source frozen (no new frames)"
            bad_reconnects+=1
            with LOCK: S["err"]=f"reconnecting ({reason}, attempt {bad_reconnects})"
            cap.release(); cap=None; black_streak=frozen_streak=0; prev_sig=None
            time.sleep(min(2+2*bad_reconnects,20)); continue  # escalating backoff on a source that never recovers
        if is_black or (is_frozen and frozen_streak>3):
            # a short blip: skip this frame entirely (keep showing the last GOOD one, don't
            # waste a GPU inference on it) - only a SUSTAINED streak above is a real stall
            time.sleep(0.02); continue
        bad_reconnects=0  # this frame is real content - the source has recovered
        t0=time.time()
        try: r=get_model(mn).predict(fr,conf=cf,imgsz=1024,device=0,verbose=False)[0]
        except Exception as e:
            with LOCK: S["err"]=f"inference: {type(e).__name__}"
            time.sleep(0.5); continue
        ann,counts,dets=annotate(fr,r)
        tot=sum(counts.values())
        hud=f"{mn} @{cf:.2f}   CARRIED: {tot}   {time.strftime('%H:%M:%S')}"
        cv2.rectangle(ann,(0,0),(ann.shape[1],44),(0,0,0),-1)
        cv2.putText(ann,hud,(12,30),cv2.FONT_HERSHEY_SIMPLEX,0.8,(90,255,255),2)
        h,w=ann.shape[:2]; W=1280
        ok2,jpg=cv2.imencode(".jpg",cv2.resize(ann,(W,int(h*W/w))),[cv2.IMWRITE_JPEG_QUALITY,80])
        now=time.time()
        with LOCK:
            S["frame"]=jpg.tobytes() if ok2 else None
            S["counts"]=counts; S["n"]=tot; S["err"]=""
            S["fps"]=0.8*S["fps"]+0.2*(1.0/max(1e-3,now-t0))
            if now-last >= 1.0/max(0.1,bfps):
                BUF.append((now,fr.copy(),ann.copy(),dets)); last=now
                while len(BUF)>bn: BUF.popleft()

def start_worker():
    threading.Thread(target=worker,daemon=True).start()

def save_burst(note=""):
    ts=time.strftime("%Y%m%d_%H%M%S")
    with LOCK:
        snap=list(BUF); mn=S["model"]; cf=S["conf"]; tag=S["tag"]; sid=S["source_id"]
    eid=f"{ts}_wrong"
    d=C.CAP/eid; d.mkdir(parents=True,exist_ok=True)
    meta=[]
    for i,(t,raw,ann,dets) in enumerate(snap):
        cv2.imwrite(str(d/f"{i:02d}_raw.jpg"),raw,[cv2.IMWRITE_JPEG_QUALITY,95])
        cv2.imwrite(str(d/f"{i:02d}_ann.jpg"),ann,[cv2.IMWRITE_JPEG_QUALITY,90])
        meta.append(dict(i=i,t=time.strftime("%H:%M:%S",time.localtime(t)),
                         seconds_before_click=round(snap[-1][0]-t,1),dets=dets))
    C.jsave(d/"event.json",dict(id=eid,kind="wrong",model=mn,conf=cf,tag=tag,
                                source=sid,note=note,frames=len(snap),frames_meta=meta))
    return dict(id=eid,frames=len(snap))

def autocapture(url, dt, model_name="v13", conf=0.35, tag="", note="", n_frames=6, source_id=""):
    """Fetch a short burst starting at a KNOWN timestamp and save it in the
    exact same event.json shape save_burst() writes - so it drops straight
    into step 3's correction queue. This is what turns a Saved moment (a
    reopen-and-watch-live-and-hope-to-click-at-the-right-second workflow) into
    one click: we already know the timestamp, so just go get it.

    Uses get_model_auto() (a separate cache from the live-watch worker and
    from scan.py) so this can run at the same time as either without any
    "stop that first" - see the comment by _models_auto above."""
    full=C.build_playback_url(url, dt) if dt else url
    cap=cv2.VideoCapture(full, cv2.CAP_FFMPEG); cap.set(cv2.CAP_PROP_BUFFERSIZE,1)
    if not cap.isOpened():
        return dict(ok=False, error="cannot open stream at that time")
    src_fps=cap.get(cv2.CAP_PROP_FPS) or 25.0
    if not (1<=src_fps<=60): src_fps=25.0
    m=get_model_auto(model_name)
    frames=[]
    for i in range(n_frames):
        ok,fr=cap.read()
        if not ok: break
        try:
            r=m.predict(fr, conf=conf, imgsz=1024, device=0, verbose=False)[0]
        except Exception as e:
            cap.release()
            return dict(ok=False, error=f"inference: {type(e).__name__}: {e}")
        ann,counts,dets=annotate(fr,r)
        frames.append((time.time(),fr,ann,dets))
        for _ in range(max(0,int(src_fps)-1)): cap.grab()   # ~1 real second per burst frame
    cap.release()
    if not frames:
        return dict(ok=False, error="no frames read from that time")
    ts=time.strftime("%Y%m%d_%H%M%S")
    eid=f"{ts}_auto"
    d=C.CAP/eid; d.mkdir(parents=True,exist_ok=True)
    meta=[]
    for i,(t,raw,ann,dets) in enumerate(frames):
        cv2.imwrite(str(d/f"{i:02d}_raw.jpg"),raw,[cv2.IMWRITE_JPEG_QUALITY,95])
        cv2.imwrite(str(d/f"{i:02d}_ann.jpg"),ann,[cv2.IMWRITE_JPEG_QUALITY,90])
        meta.append(dict(i=i,t=time.strftime("%H:%M:%S",time.localtime(t)),
                         seconds_before_click=0.0,dets=dets))
    C.jsave(d/"event.json",dict(id=eid,kind="auto",model=model_name,conf=conf,tag=tag,
                                source=source_id,note=note,frames=len(frames),frames_meta=meta))
    n_dets=sum(len(x["dets"]) for x in meta)
    return dict(ok=True,id=eid,frames=len(frames),detections=n_dets)
