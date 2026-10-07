"""Step 1 scouting: plain playback, no model.

Scrubbing through hours of recording to find when a particular sack appears
should not need the GPU, so this decodes and streams the raw video only. The
current playback time is tracked here so the UI can jump forward and back
without the user hand-editing starttime in the URL.
"""
import threading, time
from datetime import datetime, timedelta
import cv2
import core as C

P=dict(base="",full="",dt="",run=False,err="",frame=None,fps=0.0,speed=1)
LOCK=threading.Lock()

def url_now():
    with LOCK:
        if P["full"] and not P["dt"]: return P["full"]
        return C.build_playback_url(P["base"],P["dt"])

import re as _re
def parse_starttime(url):
    """Pull starttime=YYYY_MM_DD_HH_MM_SS out of a URL, if present."""
    m=_re.search(r"starttime=(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})",url)
    if not m: return ""
    y,mo,d,h,mi,se=m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{se}"

def open_at(url,dt=""):
    """Take the URL exactly as given. If it carries a starttime, that wins."""
    url=url.strip()
    found=parse_starttime(url)
    with LOCK:
        P["base"]=_re.sub(r"[?&]starttime=[^&]*","",url) if found else url
        P["full"]=url if found else ""
        P["dt"]=found or dt
        P["run"]=True; P["err"]=""; P["frame"]=None

def seek(seconds):
    with LOCK:
        try: t=datetime.strptime(P["dt"].replace("T"," "),"%Y-%m-%d %H:%M:%S")
        except ValueError:
            try: t=datetime.strptime(P["dt"].replace("T"," "),"%Y-%m-%d %H:%M")
            except ValueError: return P["dt"]
        t=t+timedelta(seconds=seconds)
        P["dt"]=t.strftime("%Y-%m-%dT%H:%M:%S")
        P["frame"]=None; P["err"]=""
        return P["dt"]

def current_url():
    with LOCK:
        return C.build_playback_url(P["base"],P["dt"]) if P["dt"] else P["full"]

def stop():
    with LOCK: P["run"]=False; P["frame"]=None

def worker():
    cap=None; cur=""
    while True:
        with LOCK:
            run=P["run"]
            u=(C.build_playback_url(P["base"],P["dt"]) if P["dt"] else P["full"]) if P["base"] or P["full"] else ""
            sp=P["speed"]
        if not run or not u:
            if cap: cap.release(); cap=None; cur=""
            time.sleep(0.3); continue
        if cap is None or cur!=u:
            if cap: cap.release()
            cap=cv2.VideoCapture(u,cv2.CAP_FFMPEG); cap.set(cv2.CAP_PROP_BUFFERSIZE,1)
            cur=u
            with LOCK: P["err"]="" if cap.isOpened() else "cannot open - check URL, time, or that the NVR has this recording"
            if not cap.isOpened(): time.sleep(2); cap=None; continue
        t0=time.time()
        ok,fr=cap.read()
        if not ok:
            with LOCK: P["err"]="no video at this time (end of recording?)"
            cap.release(); cap=None; time.sleep(1.5); continue
        for _ in range(max(0,int(sp)-1)):
            cap.grab()
        h,w=fr.shape[:2]; W=1280
        small=cv2.resize(fr,(W,int(h*W/w)))
        with LOCK: stamp=P["dt"]
        cv2.rectangle(small,(0,0),(small.shape[1],38),(0,0,0),-1)
        cv2.putText(small,f"PLAYBACK  {stamp}   x{sp}",(12,26),
                    cv2.FONT_HERSHEY_SIMPLEX,0.72,(120,220,255),2)
        ok2,jpg=cv2.imencode(".jpg",small,[cv2.IMWRITE_JPEG_QUALITY,78])
        with LOCK:
            P["frame"]=jpg.tobytes() if ok2 else None
            P["err"]=""
            P["fps"]=0.8*P["fps"]+0.2*(1.0/max(1e-3,time.time()-t0))

def start_worker():
    threading.Thread(target=worker,daemon=True).start()
