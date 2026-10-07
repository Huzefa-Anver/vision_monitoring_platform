"""Shared logic for the labelling platform.

Four steps, one dataset:
  1 sources   a library of RTSP playback URLs tagged with what they contain
  2 capture   watch a source, save a burst of frames when something looks wrong
  3 correct   fix the model's classes polygon by polygon
  4 commit    review, then merge into the dataset
"""
import json, os, re, shutil, threading, time
from pathlib import Path
from collections import defaultdict
import numpy as np, cv2

# Every state-file read-modify-write (correct, correct/bulk, reject, frame/exclude,
# frame/defer[/bulk], frame/archive[/bulk], commit, ...) happens inside a request thread
# (ThreadingHTTPServer, daemon_threads=True). Bulk UI actions (e.g. "reject all") fire many
# of these concurrently via Promise.all. Without serialization, two threads racing the SAME
# tmp filename in jsave() crash with FileNotFoundError (os.replace on a tmp file the other
# thread already consumed) - the browser then sees the request just die, no response, "nothing
# happens". This lock serializes every jsave AND every call site that wraps a jload+mutate+
# jsave sequence (via the `locked()` helper below), which also closes the quieter bug of two
# concurrent writers silently losing one update to the same file.
STATE_LOCK=threading.RLock()
def locked(fn):
    """Decorator: run fn() holding STATE_LOCK. Use on any function whose body does
    jload(...) -> mutate -> jsave(...) on shared state, so the whole cycle is one step."""
    def wrap(*a,**k):
        with STATE_LOCK: return fn(*a,**k)
    return wrap

from config import DATA_DIR, PROJECT_ROOT
ROOT=DATA_DIR          # runtime data (captures, frames, crops, state, scan_events, ...)
CAP=ROOT/"captures"; CAP.mkdir(exist_ok=True)
ST=ROOT/"state"; ST.mkdir(exist_ok=True)
PROJ=PROJECT_ROOT      # training project: models/, datasets/, runs/, eval/
NAMES={0:"red_sack",1:"green_sack",2:"blue_sack",3:"other_sack_yellow",
       4:"other_sack_white",5:"other_sack_red_grey"}
NAME2ID={v:k for k,v in NAMES.items()}
SHORT={0:"red",1:"green",2:"blue",3:"yellow",4:"white",5:"red_grey",6:"sack"}
COL={0:(60,60,220),1:(60,200,60),2:(255,140,0),3:(0,215,255),
     4:(245,245,245),5:(150,150,190),
     6:(255,0,255)}   # 6 = DISPLAY-ONLY 'sack' (class-agnostic synthetic models); not a labelling class, not in NAMES/export
MODELS={"v21":"models/sack_seg_v21_real_best.pt",   # v19 labels, same recipe as v20 (2026-09-10) - chosen as production model; bench-best conf 0.40, fewest FP at 0.45
        "v20":"models/sack_seg_v20_real_best.pt",   # v18 labels, correct recipe (2026-09-09); prod conf 0.45
        "v18":"models/sack_seg_v18_best.pt",
        "v13":"models/sack_seg_v13_best.pt",
        "v11_neg119":"models/sack_seg_v11_neg119_best.pt",
        "v10_NONEG":"models/sack_seg_v10_NONEG_best.pt",
        # EXPERIMENTAL - 100% synthetic training data (Isaac Sim), not for production use.
        # Benchmark (2026-09-09): MAE 1.26 vs v20's 0.24, near-zero recall on blue/green (the
        # real footage's dominant classes). Added only so it can be watched live for a look.
        "v20_synth":"models/sack_seg_v20_synth_best.pt",
        # EXPERIMENTAL - 100% synthetic, Isaac v006 assets (white bodies, seam-colour classes,
        # draped poses). Real-val mask mAP50 0.040, benchmark MAE 1.30 (2026-09-10); blue is the
        # only class that transfers (recall 0.51 at conf 0.70), everything else ~0. Watch-only.
        "v22_synth":"models/sack_seg_v22_synth_best.pt",
        # EXPERIMENTAL - 100% synthetic, ONE class (blue_sack only), Isaac blue_sack_isaac_handoff_v003,
        # 997 frames (2026-09-14). Blue-only benchmark: recall 0.56 at conf 0.70 with 167 FP, 37% of its
        # detections on the two static stored piles (left edge, bottom edge). Watch-only. Its single class id 0
        # is remapped to blue_sack (2) by single_class_remap() at load time.
        "v24_blue_synth":"models/sack_seg_v24_blue_synth_best.pt",
        # EXPERIMENTAL - ONE class (blue_sack), rendered carriers composited onto REAL ch3 background plates
        # (2026-09-16, epoch 5 = real-val peak 0.116). Near-zero false alarms on real footage but also near-zero
        # recall: confident only on its own composites, silent on real carriers (max conf 0.045). Watch-only;
        # expect it to show almost nothing unless the slider is at 0.01-0.05. Class 0 remapped to blue_sack.
        "v25_blue_composite":"models/sack_seg_v25_blue_composite_ep5.pt",
        # EXPERIMENTAL - COMPOSITE-trained, ONE class (blue_sack): blue_carriers_v004 (13 carry styles incl. trolleys)
        # rendered in Isaac and composited onto REAL ch3 plates (2026-09-17, run sack-seg-v26-blue-bc4, epoch3.pt =
        # val peak). Real val AP50 0.139, 32/129 blue found @0.10, stacked sacks 2/50. Watch-only; trolleys untested.
        "v26_composite_blue":"models/sack_seg_v26_composite_blue_ep4.pt",
        # EXPERIMENTAL - SYNTHETIC-trained v28 "shortcut eradication", ONE class (blue_sack): N04/S03 stacks with randomised
        # outfits + paired mannequin-only negatives, Poisson seam band, post-paste degradation, 10k composites on real ch3
        # plates (2026-09-19, run sack-seg-v28-s0, best.pt = epoch 36 by synthetic split). Real val AP50 0.040, stacked 4/50,
        # singles 0/79, 0 false alarms. Stacks only; singles/trolleys/hands untrained.
        "v28_synth_blue":"models/sack_seg_v28_synth_blue_ep36.pt",
        # EXPERIMENTAL - 100% SYNTHETIC, ONE class-agnostic 'sack' (no seam colour). Test S: full Isaac v006 replica-room renders,
        # EVERY sack labelled (2026-09-23, 500 frames, COCO init, epoch 10). Best synthetic-only model: 315/413 real sacks @0.25.
        # Fires on stored piles too (they are labelled sacks in its training). Shown as magenta 'sack' (display id 6). Watch-only.
        "TestS_allsack_synth":"runs/diag-fullscene-v001-sall/weights/pilot_epoch10.pt",
        # EXPERIMENTAL - 100% SYNTHETIC, class-agnostic 'sack'. Hybrid v1: Test S frames with people/room repainted by FLUX.1-Canny,
        # rendered sack pixels kept (2026-09-29, 112 frames, 5 epochs, seed 0). 227/413 real @0.25; not reliably better than plain
        # renders across seeds. Magenta 'sack'. Watch-only.
        "hybridv1_allsack_synth":"runs/hybrid-v1-pilot5-H/weights/pilot_epoch5.pt",
        # EXPERIMENTAL - 100% SYNTHETIC, class-agnostic 'sack', CARRIED-ONLY labels (stored/floor/truck sacks = background) on the
        # hybrid v1 frames (FLUX people/room, rendered sacks; 2026-09-30, 112 frames, 150 carried sacks, 5 epochs, seed 0 = best of 3).
        # 172/413 real @0.25, ~0 detections on stored piles; other seeds 23 and 155 (unstable). Magenta 'sack'. Watch-only.
        "hybridv1_carried_synth":"runs/hybrid-v1-carried-H-s0/weights/pilot_epoch5.pt"}

def single_class_remap(m):
    """A one-class checkpoint reports class 0. Map it to that class's id in NAMES so the platform names/colours it right."""
    try:names=m.names
    except Exception:return m
    if isinstance(names,dict) and len(names)==1:
        n0=list(names.values())[0];tgt=6 if n0=="sack" else NAME2ID.get(n0)   # 'sack' = class-agnostic -> display-only id 6
        if tgt is not None and tgt!=0:
            orig=m.predict
            def predict(*a,**k):
                res=orig(*a,**k)
                for r in res:
                    b=getattr(r,"boxes",None)
                    if b is not None and len(b):
                        d=b.data.clone();d[:,-1]=tgt;r.update(boxes=d)
                return res
            m.predict=predict
    return m
# The live dataset is NOT a fixed name: every commit produces a new "datasets/sack_seg_vN"
# directory (see commit() in app.py), and newly corrected frames must always merge into
# whichever one is CURRENTLY the latest - never back into an older version someone already
# moved past. So this is resolved from disk on every call, not cached or hardcoded; a commit
# needs no extra bookkeeping to "advance" it, because the next call just sees the new highest N.
_DATASET_RE=re.compile(r"^sack_seg_v(\d+)$")
def _highest_version_n():
    best_n=-1
    for d in (PROJ/"datasets").glob("sack_seg_v*"):
        m=_DATASET_RE.match(d.name)
        if d.is_dir() and m: best_n=max(best_n,int(m.group(1)))
    return best_n

def dataset_rel():
    """'datasets/sack_seg_vN' for the highest N that exists, falling back to v18 (the last
    dataset that existed before this became dynamic) if somehow none match."""
    n=_highest_version_n()
    return f"datasets/sack_seg_v{n}" if n>=0 else "datasets/sack_seg_v18"

def next_dataset_name():
    """The name a NEW dataset version (from a commit or a clone) must use: always one past
    the highest N that exists ANYWHERE, regardless of which existing version is the base.
    Building on an older version (e.g. re-basing new labels onto v13 while v18 already
    exists) must never collide with and silently overwrite a newer version that already
    exists - so this does NOT simply add 1 to the chosen base's own number."""
    n=_highest_version_n()
    return f"sack_seg_v{n+1}" if n>=0 else "sack_seg_v1"

def jload(p, d):
    p=Path(p)
    if not p.exists(): return d
    try: return json.loads(p.read_text())
    except Exception: return d
_jsave_ctr=iter(range(2**63))
def jsave(p,o):
    """Atomic write: a kill/crash mid-write leaves the OLD file intact, never
    a truncated or empty one. (state/sources.json was lost to exactly this -
    a non-atomic write interrupted by a server restart while a scan was
    actively saving a hit - this replaces the write path that allowed it.)
    The tmp filename is unique per call (pid+thread+counter): concurrent requests
    (e.g. "reject all" firing many POSTs at once) used to share one tmp filename and
    race on os.replace - whichever thread's os.replace lost the race hit
    FileNotFoundError (the other thread had already renamed the shared tmp file away),
    which killed that request with no HTTP response at all ("nothing happens" in the UI)."""
    p=Path(p)
    tmp=p.with_suffix(f"{p.suffix}.tmp.{os.getpid()}.{threading.get_ident()}.{next(_jsave_ctr)}")
    with STATE_LOCK:
        tmp.write_text(json.dumps(o,indent=1))
        os.replace(tmp,p)

# ---------- step 1: sources ----------
SRC_F=ST/"sources.json"
def sources(): return jload(SRC_F,[])
def add_source(rec):
    s=sources()
    rec["id"]=time.strftime("%Y%m%d_%H%M%S")+f"_{len(s)}"
    rec["added"]=time.strftime("%Y-%m-%d %H:%M")
    s.insert(0,rec); jsave(SRC_F,s); return rec
def del_source(sid):
    jsave(SRC_F,[x for x in sources() if x["id"]!=sid])

def build_playback_url(base, dt):
    """Insert or replace the starttime on a playback URL."""
    if not dt: return base
    t=dt.replace("-","_").replace("T","_").replace(":","_").replace(" ","_")
    if "starttime=" in base:
        return re.sub(r"starttime=[^&]*", "starttime="+t, base)
    sep="&" if "?" in base else "?"
    return f"{base}{sep}starttime={t}"

# ---------- step 3: correction queue ----------
def _load_frame_items(want):
    """Shared loader: every captured frame with detections, filtered by `want(fid)`.
    Used both for the active correction queue and for the History archive - same
    frames on disk, two different visibility rules."""
    hid=set(jload(ST/"hidden_events.json",[]))
    FR=ROOT/"frames"; FR.mkdir(exist_ok=True)
    items=[]
    for d in sorted(CAP.iterdir()):
        f=d/"event.json"
        if not f.exists(): continue
        e=jload(f,None)
        if not e or e["id"] in hid: continue
        for m in e["frames_meta"]:
            if not m["dets"]: continue
            fid=f"{e['id']}#{m['i']:02d}"
            if not want(fid): continue
            src=d/f"{m['i']:02d}_raw.jpg"
            if not src.exists(): continue
            dst=FR/f"{e['id']}_{m['i']:02d}.jpg"
            if not dst.exists(): shutil.copy(src,dst)
            im=cv2.imread(str(dst))
            if im is None: continue
            h,w=im.shape[:2]
            items.append(dict(id=fid,img=dst.name,W=w,H=h,event=e["id"],frame=m["i"],
                              t=m["t"],model=e.get("model","?"),conf=e.get("conf",0),
                              source=e.get("source",""),tag=e.get("tag",""),
                              dets=[dict(n=k+1,cls=x["cls"],name=x["name"],conf=x["conf"],
                                         poly=x["poly"]) for k,x in enumerate(m["dets"])]))
    items.sort(key=lambda x:(x["event"],x["frame"]))
    return items

def scan_queue():
    """Active correction queue: everything NOT yet finalized (committed) and NOT
    archived to History. This is the only thing that changed by adding History -
    archived_frames.json hides a frame from here the same way finalized.json
    already did."""
    fin=set(jload(ST/"finalized.json",[]))
    arc=set(jload(ST/"archived_frames.json",[]))
    items=_load_frame_items(lambda fid: fid not in fin and fid not in arc)
    jsave(ST/"queue.json",items)
    return items

# ---------- History: frames the user is done with (committed, or manually archived) ----------
def archive_frames(fids, action="archived", **extra):
    """Move frames out of the active Correct/Review queue into History. Non-destructive:
    corrections.json keeps whatever was judged, so an archived (not committed) frame can
    still be restored and finished later. `action` distinguishes a real dataset commit
    from a plain "clean this off my screen" archive - only the latter is restorable."""
    fids=[f for f in fids if f]
    if not fids: return
    arc=set(jload(ST/"archived_frames.json",[]))
    arc.update(fids); jsave(ST/"archived_frames.json",sorted(arc))
    hist=jload(ST/"history.json",[])
    at=time.strftime("%Y-%m-%d %H:%M")
    for fid in fids:
        hist.append(dict(fid=fid, action=action, at=at, **extra))
    jsave(ST/"history.json",hist)

def restore_frame(fid):
    """Undo a plain archive (not a commit - those are permanent). Logs a 'restored'
    entry so the History timeline still shows what happened, but the frame itself
    reappears in the Correct tab."""
    arc=set(jload(ST/"archived_frames.json",[]))
    if fid not in arc: return
    arc.discard(fid); jsave(ST/"archived_frames.json",sorted(arc))
    hist=jload(ST/"history.json",[])
    hist.append(dict(fid=fid, action="restored", at=time.strftime("%Y-%m-%d %H:%M")))
    jsave(ST/"history.json",hist)

def history_items():
    """Everything currently in History (finalized OR archived), newest action first,
    each item carrying its own history log entries (archived/committed/restored)."""
    fin=set(jload(ST/"finalized.json",[]))
    arc=set(jload(ST/"archived_frames.json",[]))
    shown=fin|arc
    items={i["id"]:i for i in _load_frame_items(lambda fid: fid in shown)}
    hist=jload(ST/"history.json",[])
    by_fid={}
    for h in hist: by_fid.setdefault(h["fid"],[]).append(h)
    added=jload(ST/"added_to.json",{})
    out=[]
    for fid,it in items.items():
        it=dict(it); it["log"]=by_fid.get(fid,[])
        it["committed"]=fid in fin
        it["added"]=added.get(fid)
        it["restorable"]=(fid in arc) and (fid not in fin)
        out.append(it)
    def last_at(it): return (it["log"][-1]["at"] if it["log"] else "")
    out.sort(key=last_at, reverse=True)
    return out

# ---------- "review it later": hide a frame from the default not-judged view without
# archiving it - the user still intends to come back to it soon. ----------
def set_deferred(fids, deferred=True):
    cur=set(jload(ST/"deferred_frames.json",[]))
    fids=[f for f in fids if f]
    (cur.update if deferred else cur.difference_update)(fids)
    jsave(ST/"deferred_frames.json",sorted(cur))
    return sorted(cur)

# ---------- step 4: commit ----------
def pending():
    """Corrections not yet committed, split into confirmations and changes."""
    C=jload(ST/"corrections.json",{})
    IT={i["id"]:i for i in jload(ST/"queue.json",[])}
    chg=[]; conf=[]
    for k,v in C.items():
        fid,n=k.rsplit("|",1); n=int(n)
        it=IT.get(fid)
        if not it: continue
        d=next((x for x in it["dets"] if x["n"]==n),None)
        if not d: continue
        rec=dict(key=k,fid=fid,n=n,event=it["event"],frame=it["frame"],was=d["name"],
                 now=v,conf=d["conf"],img=it["img"],W=it["W"],H=it["H"],poly=d["poly"],
                 cls=d["cls"],tag=it.get("tag",""))
        (conf if d["name"]==v else chg).append(rec)
    return chg,conf

def commit_counts():
    """What would be added to the dataset, per class. Mirrors commit()'s rule
    in app.py: a frame only counts if it has a REAL correction, not just a
    confirmation that the model was already right."""
    C=jload(ST/"corrections.json",{})
    rej=set(jload(ST/"rejected.json",[]))
    excl=set(jload(ST/"excluded_frames.json",[]))
    IT={i["id"]:i for i in jload(ST/"queue.json",[])}
    touched=set()
    for k,v in C.items():
        fid,n=k.rsplit("|",1)
        it=IT.get(fid)
        if not it or k in rej: continue
        d=next((x for x in it["dets"] if x["n"]==int(n)),None)
        if d and v!=d["name"]: touched.add(fid)
    touched=sorted(touched-excl)
    per={}; frames=0; neg=0; dele=0; excluded=len(excl)
    for fid in touched:
        it=IT[fid]; n=0
        for d in it["dets"]:
            k=f"{fid}|{d['n']}"; v=C.get(k)
            if v and k in rej: v=None
            if v in ("delete","bad_mask"): dele+=1; continue
            cid=NAME2ID.get(v,d["cls"]) if v else d["cls"]
            per[cid]=per.get(cid,0)+1; n+=1
        frames+=1
        if n==0: neg+=1
    return dict(frames=frames,negatives=neg,deleted=dele,
                per_class={NAMES[k]:v for k,v in sorted(per.items())},
                total=sum(per.values()), excluded_frames=excluded)

def _split_stats(d,split):
    c={}; neg=0; n=0
    for p in (d/f"labels/{split}").glob("*.txt"):
        n+=1
        ls=[l for l in p.read_text().splitlines() if l.strip()]
        if not ls: neg+=1
        for l in ls: c[int(l.split()[0])]=c.get(int(l.split()[0]),0)+1
    return dict(images=n,negatives=neg,total=sum(c.values()),
                per_class={NAMES[k]:v for k,v in sorted(c.items())})

def dataset_state(name=None):
    """Stats for one dataset version - the latest by default, or a specific
    'sack_seg_vN' if `name` is given (used when the user is looking at an older
    version's numbers, e.g. while choosing which one to merge new labels into)."""
    ds=f"datasets/{name}" if name else dataset_rel(); d=PROJ/ds
    out=dict(name=ds,exists=d.exists())
    if not d.exists(): return out
    for split in ("train","val"):
        out[split]=_split_stats(d,split)
    real={"blue_sack":155,"other_sack_yellow":85,"red_sack":9,"green_sack":4,
          "other_sack_white":0,"other_sack_red_grey":0}
    t=sum(real.values()); tr=out["train"]["total"] or 1
    out["balance"]={k:dict(train_pct=round(100*out["train"]["per_class"].get(k,0)/tr,1),
                           real_pct=round(100*v/t,1)) for k,v in real.items()}
    return out

def delete_dataset(name):
    """Permanently delete one 'datasets/sack_seg_vN' version. Verified safe with respect to
    every OTHER version: every image in every version is a symlink resolved (via
    os.path.realpath, same as clone_dataset/commit) to its ultimate real file OUTSIDE the
    versioned dataset tree entirely (e.g. sack_seg_v7final_finetune, motion/full_1s) - no
    sack_seg_vN directory's images physically live inside another one - and labels are
    independent per-version copies, never shared. What IS lost for good: this version's own
    label snapshot (its point-in-time corrections) and its place in the version history.
    `name` must match the strict sack_seg_vN pattern - this is the only thing standing
    between an HTTP request body and shutil.rmtree, so no other path is ever reachable here."""
    if not _DATASET_RE.match(name or ""):
        return dict(ok=False,error=f"refusing: not a dataset version name: {name!r}")
    d=PROJ/"datasets"/name
    if not d.is_dir():
        return dict(ok=False,error=f"not found: {name}")
    n_versions=sum(1 for x in (PROJ/"datasets").glob("sack_seg_v*")
                   if _DATASET_RE.match(x.name) and x.is_dir())
    if n_versions<=1:
        return dict(ok=False,error="cannot delete the only remaining dataset version")
    was_latest=(name==dataset_rel().rsplit("/",1)[-1])
    shutil.rmtree(d)
    return dict(ok=True,deleted=name,was_latest=was_latest,new_latest=dataset_rel().rsplit("/",1)[-1])

def clone_dataset(base=None):
    """Create a new dataset version that is an exact copy of `base` (default: latest) - no
    correction/commit flow, no new labels, just a clean version-bump to branch off from. The
    name is always core.next_dataset_name() (highest-anywhere + 1), the same rule commit()
    uses, so cloning an OLDER version can never collide with a newer one that already exists.
    Images are symlinked (never copied - avoids duplicating gigabytes of JPEGs across
    versions) resolved to their real underlying file, exactly like commit()'s link() helper,
    so symlink chains never grow across repeated clones. Labels are copied since those are
    the part meant to diverge afterward."""
    base_rel=f"datasets/{base}" if base else dataset_rel()
    src=PROJ/base_rel
    if not src.is_dir():
        return dict(ok=False,error=f"base dataset not found: {base_rel}")
    nxt=next_dataset_name()
    out=PROJ/f"datasets/{nxt}"
    if out.exists():
        return dict(ok=False,error=f"{nxt} already exists")
    n_img=0
    for split in ("train","val"):
        (out/f"images/{split}").mkdir(parents=True,exist_ok=True)
        (out/f"labels/{split}").mkdir(parents=True,exist_ok=True)
        for lp in (src/f"labels/{split}").glob("*.txt"):
            ip=next((src/f"images/{split}"/(lp.stem+e) for e in (".jpg",".png")
                     if (src/f"images/{split}"/(lp.stem+e)).exists()),None)
            if ip is None: continue
            (out/f"images/{split}"/ip.name).symlink_to(Path(os.path.realpath(ip)))
            shutil.copy(lp,out/f"labels/{split}"/lp.name)
            n_img+=1
    (out/"data.yaml").write_text(f"""path: {out.resolve()}
train: images/train
val: images/val
nc: 6
names:
"""+"".join(f"  {k}: {v}\n" for k,v in NAMES.items()))
    return dict(ok=True,dataset=nxt,base=Path(base_rel).name,images=n_img)

def dataset_versions():
    """Every 'datasets/sack_seg_vN' that exists, oldest to newest, each with train/val stats
    and a per-class delta versus the PREVIOUS version - i.e. what that version's commit
    actually added. Powers the History view and the "which version do I merge into" picker,
    so the user can see what changed at each step instead of only the current snapshot."""
    dirs=[]
    for d in (PROJ/"datasets").glob("sack_seg_v*"):
        m=_DATASET_RE.match(d.name)
        if d.is_dir() and m: dirs.append((int(m.group(1)),d))
    dirs.sort()
    latest=dataset_rel().rsplit("/",1)[-1]
    out=[]; prev=None
    for n,d in dirs:
        rec=dict(name=d.name,n=n,train=_split_stats(d,"train"),val=_split_stats(d,"val"))
        if prev is None:
            rec["images_added"]=None; rec["delta_from_prev"]=None
        else:
            rec["images_added"]=rec["train"]["images"]-prev["train"]["images"]
            allk=set(rec["train"]["per_class"])|set(prev["train"]["per_class"])
            rec["delta_from_prev"]={k:rec["train"]["per_class"].get(k,0)-prev["train"]["per_class"].get(k,0)
                                    for k in allk if rec["train"]["per_class"].get(k,0)!=prev["train"]["per_class"].get(k,0)}
        rec["is_latest"]=(d.name==latest)
        out.append(rec); prev=rec
    out.reverse()  # newest first
    return out

# colour FAMILY each class belongs to, by side-seam hue - the same mapping the
# label audit used. HSV can only ever report a family (it cannot tell red_sack
# from other_sack_red_grey - those differ by body brightness, not hue), and it
# cannot positively confirm "no colour" (other_sack_white), only fail to find one.
FAM={"red_sack":"red","green_sack":"green","blue_sack":"blue",
    "other_sack_yellow":"tan","other_sack_white":"none","other_sack_red_grey":"red"}
FAM2CLASS={"red":["red_sack","other_sack_red_grey"],"green":["green_sack"],
          "blue":["blue_sack"],"tan":["other_sack_yellow"]}

def hue_bucket(h):
    """Degrees (0-360) -> colour family. Ported from cosmos/hsv3.py - do not
    retune independently, it was fitted against 2,699 human-verified instances."""
    if h is None: return None
    if h>=332 or h<20: return 'red'
    if h<52:  return 'tan'
    if h<200: return 'green'
    if h<280: return 'blue'
    return 'red'

# ---------- duplicate-frame protection ----------
def _image_hash(path):
    import hashlib
    return hashlib.md5(Path(path).read_bytes()).hexdigest()

HASH_F=ST/"committed_hashes.json"
def load_hash_index():
    """Exact-content hashes of every image already IN a committed dataset.
    Built once from the current base dataset, then grown as commits add
    frames - so re-committing (or re-capturing) the same moment twice never
    inserts the same picture into the dataset a second time. Uses an exact
    byte hash, not a perceptual one: two DIFFERENT sacks that merely look
    similar must never be treated as duplicates."""
    idx=jload(HASH_F, None)
    if idx is not None: return set(idx)
    hashes=set()
    src=PROJ/dataset_rel()
    for split in ("train","val"):
        d=src/f"images/{split}"
        if not d.exists(): continue
        for ip in d.iterdir():
            if ip.suffix.lower() in (".jpg",".jpeg",".png"):
                try: hashes.add(_image_hash(ip))
                except Exception: pass
    jsave(HASH_F, sorted(hashes))
    return hashes

def save_hash_index(hashes):
    jsave(HASH_F, sorted(hashes))

# ---------- pipeline status for Saved moments ----------
def _events_by_source():
    out={}
    for d in sorted(CAP.iterdir()):
        f=d/"event.json"
        if not f.exists(): continue
        e=jload(f,None)
        if not e: continue
        sid=e.get("source","")
        if sid: out.setdefault(sid,[]).append(e)
    return out

def source_status(sid, events_by_source=None):
    """Where one Saved moment currently sits:
    not_captured -> captured -> correcting -> ready -> added / duplicate.
    Traces via event.json's "source" field, set when a capture (manual, in
    step 2, or one-click autocapture from step 1) originated from this moment."""
    if events_by_source is None: events_by_source=_events_by_source()
    events=events_by_source.get(sid, [])
    if not events:
        return dict(stage="not_captured", label="not captured yet")
    fids=[]
    for e in events:
        for m in e.get("frames_meta",[]):
            if m.get("dets"): fids.append(f"{e['id']}#{m['i']:02d}")
    if not fids:
        return dict(stage="captured_empty", label="captured — model found nothing there")
    added=jload(ST/"added_to.json",{})
    corr=jload(ST/"corrections.json",{})
    done=[f for f in fids if f in added]
    if done:
        dsets={added[f]["dataset"] for f in done if added[f].get("dataset")}
        if dsets:
            ds=sorted(dsets)[-1]
            return dict(stage="added", label=f"added to {ds}", dataset=ds)
        return dict(stage="duplicate", label="already in the dataset (duplicate, skipped)")
    total=0; judged=0
    for e in events:
        for m in e.get("frames_meta",[]):
            for k in range(len(m.get("dets",[]))):
                total+=1
                if f"{e['id']}#{m['i']:02d}|{k+1}" in corr: judged+=1
    if judged==0:
        return dict(stage="captured", label=f"captured, {total} detection(s) — ready to correct")
    if judged<total:
        return dict(stage="correcting", label=f"in correction — {judged}/{total} judged")
    return dict(stage="ready", label=f"corrected, {judged}/{total} judged — ready to review & add")

def sources_with_status():
    s=sources(); ev=_events_by_source()
    for x in s: x["status"]=source_status(x["id"], ev)
    return s


# ---------------- Datasets tab: catalog, run<->dataset mapping, frame preview ----------------
_CAT={"sig":None,"data":None}
_SYNTH_RE=re.compile(r"synth|accept",re.I)

def _ds_splits(d):
    """Splits that actually contain images: ['train','val'] style, or ['all'] for a flat images/ dir."""
    out=[]
    for s in ("train","val"):
        sd=d/"images"/s
        if sd.is_dir() and any(True for _ in sd.iterdir()): out.append(s)
    if not out and (d/"images").is_dir() and any(p.is_file() for p in (d/"images").iterdir()): out=["all"]
    return out
def _ds_img_dir(d,split): return d/"images" if split=="all" else d/"images"/split
def _ds_lab_dir(d,split): return d/"labels" if split=="all" else d/"labels"/split
_IMG_EXT={".jpg",".jpeg",".png"}
def _ds_images(d,split):
    return sorted(p for p in _ds_img_dir(d,split).iterdir() if p.suffix.lower() in _IMG_EXT)
def _ds_split_stats(d,split):
    c={}; neg=0; n=0
    ld=_ds_lab_dir(d,split)
    if ld.is_dir():
        for p in ld.glob("*.txt"):
            n+=1
            ls=[l for l in p.read_text().splitlines() if l.strip()]
            if not ls: neg+=1
            for l in ls:
                k=int(float(l.split()[0])); c[k]=c.get(k,0)+1
    imgs=len(_ds_images(d,split))
    return dict(images=imgs,labels=n,negatives=neg,total=sum(c.values()),
                per_class={NAMES.get(k,str(k)):v for k,v in sorted(c.items())})

def _yaml_scalar(txt,key):
    m=re.search(rf"^{key}:\s*(.+)$",txt,re.M)
    return m.group(1).strip() if m else None

def _runs_index():
    """Every runs/sack-seg-* with args.yaml: dataset it trained on, base weights, epochs, best real-val mask mAP50."""
    out=[]
    for r in sorted((PROJ/"runs").glob("sack-seg-*")):
        a=r/"args.yaml"
        if not a.is_file(): continue
        txt=a.read_text()
        data=_yaml_scalar(txt,"data") or ""; base=_yaml_scalar(txt,"model") or ""
        m=re.search(r"datasets/([^/]+)/",data)
        rec=dict(run=r.name,dataset=m.group(1) if m else None,base=os.path.basename(base),trained_at=None,
                 epochs_planned=_yaml_scalar(txt,"epochs"),epochs=0,best_map50=None,best_epoch=None,
                 lr0=_yaml_scalar(txt,"lr0"),patience=_yaml_scalar(txt,"patience"))
        rc=r/"results.csv"
        if rc.is_file():
            rec["trained_at"]=time.strftime("%Y-%m-%d %H:%M",time.localtime(rc.stat().st_mtime))
            try:
                import csv
                rows=list(csv.DictReader(open(rc)))
                if rows:
                    k=[x for x in rows[0] if "mAP50(M)" in x][0]
                    rec["epochs"]=len(rows)
                    b=max(rows,key=lambda x: float(x[k]))
                    rec["best_map50"]=round(float(b[k]),4); rec["best_epoch"]=int(float(b["epoch"]))
            except Exception: pass
        out.append(rec)
    return out

def _bench_index():
    """tag -> (MAE, exact%) from the newest eval/count_bench_v*.txt sweep-best table."""
    files=sorted((PROJ/"eval").glob("count_bench_v*.txt"))
    if not files: return {}
    d={}; seen_hdr=False
    for line in files[-1].read_text().splitlines():
        if line.startswith("model "): 
            if seen_hdr: break
            seen_hdr=True; continue
        if seen_hdr and line.strip():
            q=line.split()
            if len(q)>=4:
                try: d[q[0]]=(float(q[2]),float(q[3].rstrip("%")))
                except ValueError: pass
    return d

def _run_bench(run,bench):
    x=run.replace("sack-seg-","").replace("-","_")
    for tag in (f"{x}_hd",x,f"{x}_best_hd"):
        if tag in bench: return dict(tag=tag,mae=bench[tag][0],exact=bench[tag][1])
    return None

def _run_platform_name(run):
    x=run.replace("sack-seg-","").replace("-","_")
    for name,w in MODELS.items():
        if os.path.basename(w)==f"sack_seg_{x}_best.pt": return name
    return None

def dataset_catalog():
    """Every dataset under datasets/ with counts, notes and the runs/models trained on it. Cached
    on a signature of directory mtimes so the tab stays cheap to open."""
    dsroot=PROJ/"datasets"
    dirs=[d for d in sorted(dsroot.iterdir()) if d.is_dir() and (d/"images").is_dir()]
    sig=tuple((d.name,int(d.stat().st_mtime),int((d/"labels").stat().st_mtime) if (d/"labels").exists() else 0) for d in dirs)
    sig+=tuple((r.name,int((r/"results.csv").stat().st_mtime)) for r in (PROJ/"runs").glob("sack-seg-*") if (r/"results.csv").is_file())
    if _CAT["sig"]==sig and _CAT["data"] is not None: return _CAT["data"]
    runs=_runs_index(); bench=_bench_index()
    items=[]
    for d in dirs:
        try:
            splits=_ds_splits(d)
            rec=dict(name=d.name,kind="synthetic" if _SYNTH_RE.search(d.name) else "real",
                     splits=splits,modified=time.strftime("%Y-%m-%d %H:%M",time.localtime(d.stat().st_mtime)),
                     notes="",val_from=None,stats={})
            for s in splits: rec["stats"][s]=_ds_split_stats(d,s)
            y=d/"data.yaml"
            if y.is_file():
                txt=y.read_text()
                rec["notes"]=" ".join(l.lstrip("# ").strip() for l in txt.splitlines() if l.startswith("#"))
                v=_yaml_scalar(txt,"val") or ""
                # only an EXTERNAL val split counts (absolute path into another dataset); a set's own
                # images/val is the normal case and not reported
                m=re.search(r"datasets/([^/]+)/",v) if v else None
                if m and m.group(1)!=d.name: rec["val_from"]=m.group(1)
            rec["runs"]=[dict(r,platform_model=_run_platform_name(r["run"]),bench=_run_bench(r["run"],bench))
                         for r in runs if r["dataset"]==d.name]
            items.append(rec)
        except Exception as e:
            items.append(dict(name=d.name,kind="?",splits=[],stats={},runs=[],notes=f"could not read: {e}"))
    # real versioned sets newest first, then everything else newest first
    def key(x):
        m=_DATASET_RE.match(x["name"]); return (0,-int(m.group(1))) if m else (1,x["name"])
    items.sort(key=key)
    _CAT.update(sig=sig,data=dict(items=items,models=MODELS))
    return _CAT["data"]

def dataset_frames(name,split,page=0,per=24):
    """One page of a dataset split: image path (for /dsimg) plus its polygons in NORMALISED coords."""
    d=PROJ/"datasets"/name
    if "/" in name or ".." in name or not d.is_dir(): return dict(error="no such dataset",items=[],total=0,pages=0)
    if split not in _ds_splits(d): return dict(error="no such split",items=[],total=0,pages=0)
    imgs=_ds_images(d,split); total=len(imgs); per=max(1,min(96,int(per))); pages=max(1,-(-total//per))
    page=max(0,min(pages-1,int(page)))
    ld=_ds_lab_dir(d,split); items=[]
    for ip in imgs[page*per:(page+1)*per]:
        labs=[]; lp=ld/(ip.stem+".txt")
        if lp.is_file():
            for l in lp.read_text().splitlines():
                q=l.split()
                if len(q)<7: continue
                v=[float(x) for x in q[1:]]
                labs.append(dict(cls=int(float(q[0])),poly=[[v[i],v[i+1]] for i in range(0,len(v)-1,2)]))
        items.append(dict(file=ip.name,img=f"/dsimg/{name}/{split}/{ip.name}",labels=labs))
    return dict(items=items,total=total,page=page,pages=pages,per=per,split=split,name=name)

def dataset_image_path(name,split,fname):
    """Safe path for /dsimg: rejects traversal, returns None if not a file."""
    if any(("/" in x or ".." in x) for x in (name,split,fname)): return None
    d=PROJ/"datasets"/name
    p=_ds_img_dir(d,split)/fname
    return p if p.is_file() and p.suffix.lower() in _IMG_EXT else None
