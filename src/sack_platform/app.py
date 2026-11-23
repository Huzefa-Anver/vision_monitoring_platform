"""Sack labelling platform - one server, four steps."""
import json, os, sys, shutil, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import core as C, capture as CAPMOD, preview as PV, scan as SCAN, recorder as REC, evalset as EV, benchmark as BM, availability as AV
import rtsp_serve as RS, recplay as RP, media as MD
from config import STATIC_DIR, PORT
import numpy as np

ROOT=C.ROOT            # data dir (frames/, crops/, out_labels/)
CAPMOD.start_worker()
PV.start_worker()

def html():
    return (STATIC_DIR/"ui.html").read_text()

class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _j(self,o,code=200):
        b=json.dumps(o,separators=(",",":")).encode()
        gz=len(b)>16384 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            import gzip; b=gzip.compress(b,compresslevel=5)
        self.send_response(code); self.send_header("Content-Type","application/json")
        if gz: self.send_header("Content-Encoding","gzip")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _img(self,p):
        p=Path(p)
        if not p.exists(): return self.send_error(404)
        d=p.read_bytes()
        et='"%x-%x"'%(p.stat().st_mtime_ns,len(d))
        if self.headers.get("If-None-Match")==et:
            self.send_response(304); self.send_header("ETag",et); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type","image/jpeg")
        self.send_header("ETag",et); self.send_header("Cache-Control","private, max-age=600")
        self.send_header("Content-Length",str(len(d))); self.end_headers(); self.wfile.write(d)

    def _static(self,data,ctype):
        """Page + script: always revalidated (ETag) so a browser never mixes an old ui.js with a new page."""
        import hashlib
        et='"%s"'%hashlib.md5(data).hexdigest()[:16]
        if self.headers.get("If-None-Match")==et:
            self.send_response(304); self.send_header("ETag",et); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type",ctype)
        self.send_header("Cache-Control","no-cache"); self.send_header("ETag",et)
        self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        path,_,qs=self.path.partition("?")
        from urllib.parse import parse_qs
        Q={k:v[0] for k,v in parse_qs(qs).items()}
        if path=="/stream":
            self.send_response(200)
            self.send_header("Content-Type","multipart/x-mixed-replace; boundary=fr"); self.end_headers()
            try:
                while True:
                    with CAPMOD.LOCK: f=CAPMOD.S["frame"]
                    if f:
                        self.wfile.write(b"--fr\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(f)}\r\n\r\n".encode())
                        self.wfile.write(f); self.wfile.write(b"\r\n")
                    time.sleep(0.08)
            except Exception: return
        if path=="/ui.js":
            return self._static((STATIC_DIR/"ui.js").read_bytes(),"application/javascript")
        if path.startswith("/img/"): return self._img(ROOT/"frames"/path[5:])
        if path.startswith("/scanimg/"): return self._img(SCAN.EVID_DIR/path[9:])
        if path.startswith("/crop/"):
            f=ROOT/"crops"/path[6:]
            if not f.exists(): render_crop(path[6:].replace(".jpg",""))
            return self._img(f)
        if path=="/preview":
            self.send_response(200)
            self.send_header("Content-Type","multipart/x-mixed-replace; boundary=fr"); self.end_headers()
            try:
                while True:
                    with PV.LOCK: f=PV.P["frame"]
                    if f:
                        self.wfile.write(b"--fr\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(f)}\r\n\r\n".encode())
                        self.wfile.write(f); self.wfile.write(b"\r\n")
                    time.sleep(0.06)
            except Exception: return
        if path=="/api/preview":
            with PV.LOCK:
                d=dict(dt=PV.P["dt"],err=PV.P["err"],run=PV.P["run"],
                       fps=PV.P["fps"],speed=PV.P["speed"],base=PV.P["base"])
            d["url"]=PV.current_url()
            return self._j(d)
        if path=="/api/sources": return self._j(C.sources_with_status())
        if path=="/api/live":
            with CAPMOD.LOCK:
                s=dict(fps=CAPMOD.S["fps"],n=CAPMOD.S["n"],counts=CAPMOD.S["counts"],
                       err=CAPMOD.S["err"],run=CAPMOD.S["run"],buf=len(CAPMOD.BUF),
                       buf_n=CAPMOD.S["buf_n"],buf_fps=CAPMOD.S["buf_fps"],
                       model=CAPMOD.S["model"],conf=CAPMOD.S["conf"],tag=CAPMOD.S["tag"])
            s["events"]=len(list(C.CAP.glob("*/event.json")))
            return self._j(s)
        if path=="/api/queue":
            q=C.scan_queue()
            return self._j(dict(items=q,corrections=C.jload(C.ST/"corrections.json",{}),
                                excluded=C.jload(C.ST/"excluded_frames.json",[]),
                                deferred=C.jload(C.ST/"deferred_frames.json",[])))
        if path=="/api/history":
            return self._j(dict(items=C.history_items()))
        # ---- Datasets tab ----
        if path=="/api/datasets": return self._j(C.dataset_catalog())
        if path=="/api/datasets/frames":
            return self._j(C.dataset_frames(Q.get("name",""),Q.get("split","train"),
                                            int(Q.get("page",0)),int(Q.get("per",24))))
        if path.startswith("/dsimg/"):
            parts=path[7:].split("/")
            f=C.dataset_image_path(*parts) if len(parts)==3 else None
            if f is None: return self.send_error(404)
            d=f.read_bytes(); ct="image/png" if f.suffix.lower()==".png" else "image/jpeg"
            self.send_response(200); self.send_header("Content-Type",ct)
            self.send_header("Cache-Control","max-age=3600")
            self.send_header("Content-Length",str(len(d))); self.end_headers(); self.wfile.write(d); return
        if path=="/api/review":
            chg,conf=C.pending()
            return self._j(dict(changes=chg,confirms=conf,
                                rejected=C.jload(C.ST/"rejected.json",[]),
                                counts=C.commit_counts()))
        if path=="/api/dataset": return self._j(C.dataset_state(Q.get("name")))
        if path=="/api/dataset/versions":
            return self._j(dict(versions=C.dataset_versions(),latest=C.dataset_rel().rsplit("/",1)[-1]))
        # ---- Eval events tab ----
        if path=="/api/eval/events": return self._j(EV.events())
        if path=="/api/eval/sessions": return self._j(EV.sessions())
        if path=="/api/eval/sources": return self._j(EV.rtsp_sources())
        if path=="/api/bench/status": return self._j(BM.status())
        if path=="/api/bench/results": return self._j(BM.results())
        if path.startswith("/benchfile/"):
            f=BM.file_path(*path[11:].split("/"))
            if f is None: return self.send_error(404)
            return self._img(f)
        if path.startswith("/evalfile/") or path.startswith("/evalsess/"):
            kind="events" if path.startswith("/evalfile/") else "sessions"
            parts=path[10:].split("/")
            f=EV.file_path(*parts,kind=kind) if len(parts)>=3 else None
            if f is None: return self.send_error(404)
            ct={".jpg":"image/jpeg",".png":"image/png",".mp4":"video/mp4"}.get(f.suffix.lower(),"application/octet-stream")
            size=f.stat().st_size; rng=self.headers.get("Range")
            if rng and rng.startswith("bytes="):          # browsers seek in videos with Range requests
                a,_,b=rng[6:].partition("-"); a=int(a or 0); b=int(b) if b else size-1; b=min(b,size-1)
                self.send_response(206); self.send_header("Content-Range",f"bytes {a}-{b}/{size}")
            else:
                a,b=0,size-1; self.send_response(200)
            self.send_header("Content-Type",ct); self.send_header("Accept-Ranges","bytes")
            self.send_header("Cache-Control","private, max-age=600")
            self.send_header("Content-Length",str(b-a+1)); self.end_headers()
            try:
                with open(f,"rb") as fh:
                    fh.seek(a); left=b-a+1
                    while left>0:
                        chunk=fh.read(min(1<<20,left))
                        if not chunk: break
                        self.wfile.write(chunk); left-=len(chunk)
            except Exception: pass
            return
        if path=="/api/avail/status": return self._j(AV.status())
        if path=="/api/avail/links": return self._j(AV.links())
        if path=="/api/avail/teststreams": return self._j(AV.test_streams())
        if path=="/api/rtsp/status": return self._j(RS.status())
        if path=="/api/rtsp/auth": return self._j(RS.auth(full=True))
        if path=="/api/rtsp/videos": return self._j(RS.videos())
        if path=="/api/rtsp/logs": return self._j(RS.logs())
        if path=="/api/rec/status": return self._j(REC.status())
        if path=="/api/rec/sessions": return self._j(REC.sessions())
        if path.startswith("/rec/"):          # download, or ?play=1 for the in-page player (seekable, not a download)
            parts=path[5:].split("/")
            f=REC.file_path(*parts) if len(parts)==2 else None
            if f is None: return self.send_error(404)
            RP.send_file(self,f,"video/mp4" if f.suffix==".mp4" else "text/plain",None if Q.get("play")=="1" else f"{parts[0]}_{f.name}")
            return
        if path.startswith("/recplay/"):      # the same video converted to H.264 on the fly from ?t= seconds
            parts=path[9:].split("/")
            f=REC.file_path(*parts) if len(parts)==2 else None
            if f is None or f.suffix!=".mp4": return self.send_error(404)
            try: t=float(Q.get("t",0)); w=int(Q.get("w",1280))
            except ValueError: return self.send_error(400)
            RP.send_converted(self,f,t,w); return
        if path=="/api/raw/videos": return self._j(MD.videos())
        if path=="/api/raw/frames": return self._j(MD.frame_sets())
        if path=="/api/raw/frames/list": return self._j(MD.set_list(Q.get("id","")))
        if path=="/api/raw/job": return self._j(MD.job())
        if path=="/raw/frame":               # one image of a frame set; ?w=240 for a small thumbnail
            i=int(Q.get("i","0")) if Q.get("i","0").isdigit() else 0
            if Q.get("w","").isdigit():
                try: b=MD.thumb(Q.get("id",""),i,int(Q["w"]))
                except Exception: b=None
                if b is None: return self.send_error(404)
                self.send_response(200); self.send_header("Content-Type","image/jpeg"); self.send_header("Content-Length",str(len(b)))
                self.send_header("Cache-Control","private, max-age=600"); self.end_headers(); self.wfile.write(b); return
            f=MD.set_file(Q.get("id",""),i)
            if f is None: return self.send_error(404)
            RP.send_file(self,f,"image/png" if f.suffix.lower()==".png" else "image/jpeg"); return
        if path=="/api/rtsp/hold": RS.hold(self,Q.get("g",""),Q.get("p","")); return   # trigger of an on-connect sync group
        if path=="/api/rtsp/clip": return self._j(RS.clip_for(Q.get("s","")))
        if path.startswith("/rtclip/"):          # the clip a stream plays (preview in the page); ?conv=1&t=&w= converted
            f=RS.clip_path(path[8:])
            if f is None: return self.send_error(404)
            if Q.get("conv")=="1":
                try: t=float(Q.get("t",0)); w=int(Q.get("w",1280))
                except ValueError: return self.send_error(400)
                RP.send_converted(self,f,t,w); return
            RP.send_file(self,f,"video/mp4"); return
        if path=="/api/rtsp/probe":
            f=RS.resolve(Q.get("f",""))
            return self._j(RP.probe(f) if f else dict(ok=False,error="not found"))
        if path=="/rsvid":                    # tab 12 picker: a serve-able video, original (?play=1) or converted (?conv=1&t=&w=)
            f=RS.resolve(Q.get("f",""))
            if f is None: return self.send_error(404)
            if Q.get("conv")=="1":
                try: t=float(Q.get("t",0)); w=int(Q.get("w",1280))
                except ValueError: return self.send_error(400)
                RP.send_converted(self,f,t,w); return
            RP.send_file(self,f,"video/mp4"); return
        if path=="/api/rec/probe":
            f=REC.file_path(Q.get("session",""),Q.get("file",""))
            return self._j(RP.probe(f) if f else dict(ok=False,error="not found"))
        if path=="/api/gpu/status":
            st=CAPMOD.status(); st["scan"]=SCAN.model_status()
            st["models"]=sorted(C.MODELS)
            gpu_mb=0
            try:
                import torch
                if torch.cuda.is_available(): gpu_mb=round(torch.cuda.memory_allocated()/2**20)
            except Exception: pass
            st["gpu_mb"]=gpu_mb
            return self._j(st)
        if path=="/api/scan/status": return self._j(SCAN.status())
        if path=="/scan_stream":
            self.send_response(200)
            self.send_header("Content-Type","multipart/x-mixed-replace; boundary=fr"); self.end_headers()
            try:
                while True:
                    f=SCAN.latest_jpeg()
                    if f:
                        self.wfile.write(b"--fr\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(f)}\r\n\r\n".encode())
                        self.wfile.write(f); self.wfile.write(b"\r\n")
                    time.sleep(0.08)
            except Exception: return
        return self._static(html().encode(),"text/html; charset=utf-8")

    def do_POST(self):
        if self.path.startswith("/api/raw/upload?"):   # raw body, streamed to disk (not JSON)
            from urllib.parse import parse_qs
            Q={k:v[0] for k,v in parse_qs(self.path.partition("?")[2]).items()}
            return self._j(MD.upload(self,Q))
        n=int(self.headers.get("Content-Length",0))
        if n>64*2**20:                      # JSON requests are small; never read a big body into memory (2026-11-12: a 15 GB
            self.send_response(413); self.send_header("Connection","close"); self.end_headers()   # upload to an old build OOM-killed the server)
            self.close_connection=True; return
        req=json.loads(self.rfile.read(n).decode() or "{}")
        p=self.path
        if p=="/api/eval/approve_frame":
            return self._j(EV.approve_event_frame(req.get("key",""),req.get("file",""),req.get("decision",""),req.get("type"),req.get("review")))
        if p=="/api/eval/finish": return self._j(EV.finish_session(req.get("key","")))
        if p=="/api/bench/judge": return self._j(BM.judge(req.get("tag",""),req.get("id",""),req.get("verdict","")))
        if p=="/api/eval/options": return self._j(dict(errors=EV.ERRORS,situations=EV.SITUATIONS))
        if p=="/api/bench/run": return self._j(BM.run(req.get("model",""),req.get("conf",0.25)))
        if p=="/api/eval/decide":
            return self._j(EV.decide(req.get("key",""),req.get("id",""),req.get("decision",""),req.get("note",""),req.get("type"),req.get("review")))
        if p=="/api/rec/start": return self._j(REC.start(req.get("cams"),req.get("fps"),req.get("width")))
        if p=="/api/rec/stop": return self._j(REC.stop())
        if p=="/api/avail/start": return self._j(AV.start(req.get("url"),req.get("start"),req.get("end"),req.get("step",60),req.get("recheck",False)))
        if p=="/api/avail/saved": return self._j(AV.saved(req.get("url"),req.get("key")))
        if p=="/api/avail/stop": return self._j(AV.stop())
        if p=="/api/avail/delete": return self._j(AV.delete(req.get("key"),req.get("t")))
        if p=="/api/rtsp/save": return self._j(RS.save(req.get("streams")))
        if p=="/api/rtsp/restart": return self._j(RS.restart())
        if p=="/api/rtsp/stop": return self._j(RS.stop())
        if p=="/api/rtsp/pause": return self._j(RS.pause())
        if p=="/api/rtsp/public": return self._j(RS.set_public(req.get("host"),req.get("port")))
        if p=="/api/rtsp/auth": return self._j(RS.set_auth(req.get("user"),req.get("pass")))
        if p=="/api/rtsp/restart_group": return self._j(RS.restart_group(str(req.get("group") or "")))
        if p=="/api/rtsp/resume": return self._j(RS.resume())
        if p=="/api/avail/fullurl": return self._j(AV.full_url(req.get("key"),req.get("start",""),req.get("end")))
        if p=="/api/raw/make_video":
            return self._j(MD.make_video(req.get("sets"),req.get("name"),req.get("mode","hold"),req.get("hold_s",1),req.get("fps",5),req.get("order","name")))
        if p=="/api/raw/auto_streams":
            return self._j(MD.auto_streams(req.get("sets"),req.get("mode","hold"),req.get("hold_s",1),req.get("fps",5),bool(req.get("together")),req.get("group","")))
        if p=="/api/raw/rename_set": return self._j(MD.rename_set(req.get("old"),req.get("new")))
        if p=="/api/raw/new_set": return self._j(MD.new_set(req.get("name")))
        if p=="/api/raw/finish_set": return self._j(MD.finish_set(req.get("name")))
        if p=="/api/raw/delete": return self._j(MD.delete(req.get("kind"),req.get("id")))
        if p=="/api/rec/delete": return self._j(REC.delete(req.get("session"),req.get("file")))
        if p=="/api/rec/rename":
            sid,f=req.get("session"),req.get("file")
            used=[u for u in RS.uses(sid,f) if u["enabled"]]
            if used and not req.get("force"):
                w=sum(u["viewers"] for u in used)
                return self._j(dict(ok=False,confirm=f"Serve RTSP stream(s) {', '.join(u['name'] for u in used)} play this file; they will be switched to the new name"
                                    +(f" and restarted ({w} viewer(s) watching now are disconnected)" if w else "")+". Continue?"))
            r=REC.rename(sid,f,req.get("new"))
            if r.get("ok") and r["old"]!=r["new"]: r["streams"]=RS.rename_refs(sid,r["old"],r["new"])
            return self._j(r)
        if p=="/api/preview/open":
            PV.open_at(req.get("url",""),req.get("datetime",""))
            return self._j(dict(ok=True))
        if p=="/api/preview/seek":
            return self._j(dict(dt=PV.seek(int(req.get("seconds",0)))))
        if p=="/api/preview/speed":
            with PV.LOCK: PV.P["speed"]=max(1,int(req.get("speed",1)))
            return self._j(dict(ok=True))
        if p=="/api/preview/stop":
            PV.stop(); return self._j(dict(ok=True))
        if p=="/api/source/add":
            url=C.build_playback_url(req.get("url","").strip(), req.get("datetime",""))
            return self._j(C.add_source(dict(url=url, base=req.get("url","").strip(),
                datetime=req.get("datetime",""), tag=req.get("tag",""), note=req.get("note",""))))
        if p=="/api/source/del":
            C.del_source(req.get("id","")); return self._j(dict(ok=True))
        if p=="/api/live/start":
            with CAPMOD.LOCK:
                CAPMOD.S.update(url=req.get("url","").strip(),model=req.get("model","v21"),
                    conf=float(req.get("conf",0.35)),buf_n=int(req.get("buf_n",10)),
                    buf_fps=float(req.get("buf_fps",1.0)),tag=req.get("tag",""),
                    source_id=req.get("source_id",""),run=True,err="")
            return self._j(dict(ok=True))
        if p=="/api/live/stop":
            with CAPMOD.LOCK: CAPMOD.S["run"]=False
            time.sleep(0.6)
            gpu=CAPMOD.unload()   # clears capture.py's two caches (live-watch + autocapture)
            SCAN.unload()          # and scan.py's own - "free GPU" should mean all of it
            return self._j(dict(gpu_free_mib=gpu))
        if p=="/api/gpu/load":
            ctx=req.get("context",""); name=req.get("model","")
            if name not in C.MODELS: return self._j(dict(ok=False,error="unknown model"))
            try:
                if ctx=="live": CAPMOD.preload(name)
                elif ctx=="auto": CAPMOD.preload_auto(name)
                elif ctx=="scan": SCAN.preload(name)
                else: return self._j(dict(ok=False,error="unknown context"))
            except Exception as e:
                return self._j(dict(ok=False,error=f"{type(e).__name__}: {e}"))
            return self._j(dict(ok=True))
        if p=="/api/gpu/unload":
            ctx=req.get("context",""); name=req.get("model","")
            if ctx=="live": ok=CAPMOD.unload_one(name)
            elif ctx=="auto": ok=CAPMOD.unload_one_auto(name)
            elif ctx=="scan": ok=SCAN.unload_one(name)
            else: return self._j(dict(ok=False,error="unknown context"))
            return self._j(dict(ok=ok))
        if p=="/api/live/set":
            with CAPMOD.LOCK:
                for k in ("model","tag"):
                    if k in req: CAPMOD.S[k]=req[k]
                if "conf" in req: CAPMOD.S["conf"]=float(req["conf"])
                if "buf_n" in req: CAPMOD.S["buf_n"]=int(req["buf_n"])
                if "buf_fps" in req: CAPMOD.S["buf_fps"]=float(req["buf_fps"])
            return self._j(dict(ok=True))
        if p=="/api/live/capture":
            return self._j(CAPMOD.save_burst(req.get("note","")))
        if p=="/api/source/autocapture":
            src=next((x for x in C.sources() if x["id"]==req.get("id","")), None)
            if not src:
                return self._j(dict(ok=False, error="source not found"))
            return self._j(CAPMOD.autocapture(src.get("base") or src["url"], src.get("datetime",""),
                req.get("model","v21"), float(req.get("conf",0.35)),
                tag=src.get("tag",""), note=f"auto-captured from saved moment: {src.get('note','')}",
                source_id=src["id"]))
        # Every handler below does jload -> mutate -> jsave on shared state files. Bulk UI
        # actions ("reject all", "keep all", a frame-filter bulk action) fire many of these
        # concurrently via Promise.all; without the whole read-modify-write held under one
        # lock, two requests can race between their jload and jsave and silently lose one
        # update (jsave's own lock only protects the final write, not the read+mutate before
        # it). STATE_LOCK is an RLock so it nests safely with the lock jsave takes internally.
        if p in ("/api/correct","/api/correct/bulk","/api/frame/exclude","/api/frame/defer",
                 "/api/frame/defer/bulk","/api/frame/archive","/api/frame/archive/bulk",
                 "/api/reject","/api/commit","/api/dataset/clone","/api/dataset/delete"):
            with C.STATE_LOCK:
                if p=="/api/dataset/clone":
                    # a version-number bump with no new labels - separate from commit() (which
                    # requires an actual correction) so "just give me a fresh v19 to branch off"
                    # doesn't need to fake a correction first. Same next_dataset_name() safety
                    # rule as commit(): the new number is always highest-anywhere + 1.
                    return self._j(C.clone_dataset(req.get("base") or None))
                if p=="/api/dataset/delete":
                    # irreversible - core.delete_dataset only accepts the strict sack_seg_vN
                    # pattern (no path traversal possible) and refuses to delete the last
                    # remaining version. The UI requires typing the exact name before this fires.
                    return self._j(C.delete_dataset(req.get("name","")))
                if p=="/api/correct":
                    cur=C.jload(C.ST/"corrections.json",{})
                    k=req["key"]; v=req.get("value","")
                    if v: cur[k]=v
                    else: cur.pop(k,None)
                    C.jsave(C.ST/"corrections.json",cur)
                    return self._j(dict(ok=True,n=len(cur)))
                if p=="/api/correct/bulk":
                    # either {keys:[...], value:"x"} - same value for every key (bulk re-class)
                    # or {pairs:[{key,value},...]} - a different value per key (bulk confirm-as-shown,
                    # where each detection keeps its own predicted class)
                    cur=C.jload(C.ST/"corrections.json",{})
                    n=0
                    if "pairs" in req:
                        for pr in req["pairs"]:
                            k=pr["key"]; v=pr.get("value","")
                            if v: cur[k]=v
                            else: cur.pop(k,None)
                            n+=1
                    else:
                        v=req.get("value","")
                        for k in req.get("keys",[]):
                            if v: cur[k]=v
                            else: cur.pop(k,None)
                            n+=1
                    C.jsave(C.ST/"corrections.json",cur)
                    return self._j(dict(ok=True,n=len(cur),applied=n))
                if p=="/api/frame/exclude":
                    # whole-frame exclusion: for when the model MISSED a sack entirely (no
                    # polygon to correct) - committing the frame anyway would silently
                    # teach "that region is not a sack", reinforcing the exact miss.
                    # Reversible: toggled off the same way, and the capture/evidence stays
                    # on disk either way - this only controls what commit() writes.
                    cur=set(C.jload(C.ST/"excluded_frames.json",[]))
                    fid=req["fid"]
                    cur.discard(fid) if req.get("include") else cur.add(fid)
                    C.jsave(C.ST/"excluded_frames.json",sorted(cur))
                    return self._j(dict(ok=True,excluded=sorted(cur)))
                if p=="/api/frame/defer":
                    # "review it later" - hides a frame from the default not-judged view without
                    # archiving it; still fully live in the Correct tab under its own filter.
                    return self._j(dict(ok=True,deferred=C.set_deferred([req["fid"]],req.get("defer",True))))
                if p=="/api/frame/defer/bulk":
                    return self._j(dict(ok=True,deferred=C.set_deferred(req.get("fids",[]),req.get("defer",True))))
                if p=="/api/frame/archive":
                    # manual "move to History" without committing - for frames not worth pursuing.
                    # Reversible (unlike a real commit): restore puts it straight back in Correct.
                    if req.get("archive",True):
                        C.archive_frames([req["fid"]],action="archived")
                    else:
                        C.restore_frame(req["fid"])
                    return self._j(dict(ok=True))
                if p=="/api/frame/archive/bulk":
                    C.archive_frames(req.get("fids",[]),action="archived")
                    return self._j(dict(ok=True))
                if p=="/api/reject":
                    cur=set(C.jload(C.ST/"rejected.json",[]))
                    k=req["key"]
                    cur.discard(k) if req.get("undo") else cur.add(k)
                    C.jsave(C.ST/"rejected.json",sorted(cur))
                    return self._j(dict(ok=True,counts=C.commit_counts()))
                if p=="/api/commit":
                    return self._j(commit(req.get("target") or None))
        if p=="/api/scan/start":
            return self._j(SCAN.start(req.get("url",""), req.get("duration_min",60),
                req.get("classes",[]), req.get("model","v21"),
                float(req.get("conf",0.35)), int(req.get("speed",8)),
                req.get("signal","model"), int(req.get("min_hits",2))))
        if p=="/api/scan/stop":
            SCAN.stop(); return self._j(dict(ok=True))
        self.send_response(404); self.end_headers()

def render_crop(safekey):
    """Zoomed crop of one judged polygon - outline only, generous margin."""
    import cv2
    (ROOT/"crops").mkdir(exist_ok=True)
    chg,conf=C.pending()
    for r in chg+conf:
        if r["key"].replace("|","_").replace("#","_")!=safekey: continue
        im=cv2.imread(str(ROOT/"frames"/r["img"]))
        if im is None: return
        pts=np.array(r["poly"],np.int32); h,w=im.shape[:2]
        pad=int(0.9*max(pts[:,0].max()-pts[:,0].min(),pts[:,1].max()-pts[:,1].min()))+70
        x1,y1=max(0,pts[:,0].min()-pad),max(0,pts[:,1].min()-pad)
        x2,y2=min(w,pts[:,0].max()+pad),min(h,pts[:,1].max()+pad)
        cr=im[y1:y2,x1:x2].copy(); p2=pts.copy(); p2[:,0]-=x1; p2[:,1]-=y1
        col=(80,80,255) if r["now"]=="delete" else ((90,255,120) if r["was"]!=r["now"] else (255,190,60))
        cv2.polylines(cr,[p2],True,col,3)
        s=460/max(cr.shape[:2])
        cr=cv2.resize(cr,None,fx=s,fy=s,interpolation=cv2.INTER_CUBIC)
        cv2.imwrite(str(ROOT/"crops"/f"{safekey}.jpg"),cr,[cv2.IMWRITE_JPEG_QUALITY,92])
        return

def commit(target=None):
    """Write corrected frames DIRECTLY into an EXISTING dataset version - grows it in
    place, no new version is created. `target` is a dataset name (e.g. 'sack_seg_v20');
    default is whichever version is currently latest. Separate from cloning
    (core.clone_dataset / /api/dataset/clone), which makes an unmodified copy under a new
    version number with no labels involved - use that FIRST if you want a safety snapshot
    before adding, since this call mutates `target` itself."""
    import cv2
    target_rel=f"datasets/{target}" if target else C.dataset_rel()
    out=C.PROJ/target_rel
    if not out.is_dir():
        return dict(ok=False,error=f"target dataset not found: {target_rel}")
    Cj=C.jload(C.ST/"corrections.json",{})
    rej=set(C.jload(C.ST/"rejected.json",[]))
    excl=set(C.jload(C.ST/"excluded_frames.json",[]))
    IT={i["id"]:i for i in C.jload(C.ST/"queue.json",[])}
    # only frames with a REAL correction (the model's class was actually wrong)
    # are worth adding - a frame where everything was just confirmed correct
    # (now == the model's original call) has no new information, and adding it
    # anyway would duplicate a case the model already handles into training data
    touched=set()
    for k,v in Cj.items():
        fid,n=k.rsplit("|",1)
        it=IT.get(fid)
        if not it or k in rej: continue
        d=next((x for x in it["dets"] if x["n"]==int(n)),None)
        if d and v!=d["name"]: touched.add(fid)
    touched=sorted(touched-excl)
    if not touched: return dict(ok=False,error="nothing to commit - no frame has an actual correction (confirming the model was right doesn't count)")
    LAB=ROOT/"out_labels"; LAB.mkdir(exist_ok=True)
    for f in LAB.glob("*.txt"): f.unlink()
    fid_counts={}     # fid -> {cid: n}, tallied into `per` only for frames that survive dedup below
    for fid in touched:
        it=IT[fid]; lines=[]; counts={}
        for d in it["dets"]:
            k=f"{fid}|{d['n']}"; v=Cj.get(k)
            if v and k in rej: v=None
            if v in ("delete","bad_mask"): continue
            cid=C.NAME2ID.get(v,d["cls"]) if v else d["cls"]
            p=np.array(d["poly"],float); p[:,0]/=it["W"]; p[:,1]/=it["H"]; p=np.clip(p,0,1)
            lines.append(f"{cid} "+" ".join(f"{x:.6f}" for x in p.ravel()))
            counts[cid]=counts.get(cid,0)+1
        (LAB/f"{fid.replace('#','_')}.txt").write_text("\n".join(lines)+("\n" if lines else ""))
        fid_counts[fid]=counts
    (out/"images/train").mkdir(parents=True,exist_ok=True)
    (out/"labels/train").mkdir(parents=True,exist_ok=True)
    def link(s,d):
        s=Path(os.path.realpath(s))
        if d.exists() or d.is_symlink(): d.unlink()
        d.symlink_to(s)
    # never insert a picture that's already in the dataset - exact-content hash,
    # so a moment that was captured/committed before (or captured twice, e.g.
    # an overlapping scan re-finding the same frame) is skipped, not duplicated.
    # per-class / frame counts are tallied HERE, from what actually got written,
    # not from the earlier label pass - a skipped duplicate must not be counted
    # as "added".
    hashes=C.load_hash_index()
    per={}; added=0; dup=0; frames=0; neg=0
    dup_fids=[]
    stem2fid={fid.replace("#","_"):fid for fid in touched}
    for lp in LAB.glob("*.txt"):
        orig_fid=stem2fid.get(lp.stem, lp.stem)
        ip=ROOT/"frames"/f"{lp.stem}.jpg"
        if not ip.exists(): continue
        h=C._image_hash(ip)
        if h in hashes:
            dup+=1; dup_fids.append(orig_fid); continue
        nm=f"live_{lp.stem}"
        link(ip,out/"images/train"/f"{nm}.jpg")
        shutil.copy(lp,out/"labels/train"/f"{nm}.txt"); added+=1
        hashes.add(h)
        frames+=1
        counts=fid_counts.get(orig_fid,{})
        if not counts: neg+=1
        for cid,n in counts.items(): per[cid]=per.get(cid,0)+n
    C.save_hash_index(hashes)
    if not (out/"data.yaml").exists():
        (out/"data.yaml").write_text(f"""path: {out.resolve()}
train: images/train
val: images/val
nc: 6
names:
"""+"".join(f"  {k}: {v}\n" for k,v in C.NAMES.items()))
    tname=out.name
    # duplicates are still marked finalized (don't keep re-offering them for
    # correction) but are NOT recorded as "added to <dataset>" for status display
    fin=set(C.jload(C.ST/"finalized.json",[])) | set(touched)
    C.jsave(C.ST/"finalized.json",sorted(fin))
    added_map=C.jload(C.ST/"added_to.json",{})
    for fid in touched:
        if fid in dup_fids:
            added_map[fid]=dict(dataset=None, duplicate=True, at=time.strftime("%Y-%m-%d %H:%M"))
        else:
            added_map[fid]=dict(dataset=tname, duplicate=False, at=time.strftime("%Y-%m-%d %H:%M"))
    C.jsave(C.ST/"added_to.json",added_map)
    # move every committed frame to History (see core.archive_frames) - this is what makes
    # "review and add" clear the Correct/Review tabs instead of leaving finished frames
    # mixed in with new ones.
    for fid in touched:
        info=added_map[fid]
        C.archive_frames([fid],action="committed",dataset=info["dataset"],duplicate=info["duplicate"])
    C.jsave(C.ST/"corrections.json",{})
    C.jsave(C.ST/"rejected.json",[])
    return dict(ok=True,dataset=tname,frames_added=added,duplicates_skipped=dup,negatives=neg,
                per_class={C.NAMES[k]:v for k,v in sorted(per.items())},
                total=sum(per.values()))

class Srv(ThreadingHTTPServer):
    request_queue_size=256; daemon_threads=True; allow_reuse_address=True
if __name__=="__main__":
    port=PORT
    def _warm():   # build the slow caches once in the background so the first click is fast
        for fn in (C.dataset_catalog, C.scan_queue, C.history_items):
            try: fn()
            except Exception as e: print("warm-up", fn.__name__, e, flush=True)
    import threading; threading.Thread(target=_warm, daemon=True).start()
    n=RS.reap_orphans()
    if n: print(f"stopped {n} Serve RTSP group player(s) left by an earlier run",flush=True)
    print(f"sack labelling platform on 0.0.0.0:{port}",flush=True)
    Srv(("0.0.0.0",port),H).serve_forever()
