const CLS=[[2,"blue_sack","blue","#0a8cff"],[3,"other_sack_yellow","yellow","#ffd700"],
           [4,"other_sack_white","white","#f0f0f0"],[0,"red_sack","red_sack","#dc3c3c"],
           [1,"green_sack","green","#3cc83c"],[5,"other_sack_red_grey","red_grey","#be9696"]];
const COLOR={0:"#dc3c3c",1:"#3cc83c",2:"#0a8cff",3:"#ffd700",4:"#f0f0f0",5:"#be9696",6:"#ff00ff"};
const TABS=[["s1","1","Find recordings"],["s2","2","Watch & capture"],
            ["s3","3","Correct"],["s3r","4","Review later"],
            ["s4","5","Review & add"],["s5","6","History"],["s6","7","Datasets"],["s7","8","Record RTSP"]];
let TAB=localStorage.getItem("tab")||"s1";
let MODEL="v21", QUEUE=[], CORR={}, QPG=0, QFILT="all", SEL={}, REVIEW=null;

function el(id){return document.getElementById(id);}
function post(p,b){return fetch(p,{method:"POST",body:JSON.stringify(b||{})}).then(r=>r.json());}
function get(p){return fetch(p).then(r=>r.json());}

function nav(){
  el("nav").innerHTML=TABS.map(([id,n,label])=>
    `<button class="${TAB===id?'on':''}" onclick="show('${id}')"><span class=step>${n}</span>${label}</button>`).join("");
  TABS.forEach(([id])=>el(id).className=(TAB===id?"on":""));
}
function show(id){TAB=id;localStorage.setItem("tab",id);nav();
  if(id==="s1"){loadSources();pvPoll();} if(id==="s2")livePoll(); if(id==="s3")loadQueue(); if(id==="s4"){loadReview();loadDataset();}
  if(id==="s3r")loadReviewLater();
  if(id==="s5")loadHistory();
  if(id==="s6")loadDatasets();
  if(id==="s7"){recInit();recPoll();recLoadSessions();}}

/* ---------- 1 scout the recording ---------- */
function pvOpen(){const u=el("pvUrl").value.trim(); if(!u){alert("URL required");return;}
  if(u.includes("/cam/realmonitor"))
    alert("That is the LIVE stream (realmonitor) - it ignores starttime.\nUse /cam/playback for recordings.");
  post("/api/preview/open",{url:u}).then(()=>{const im=el("pvImg"); if(im) im.src="/preview?t="+Date.now(); pvPoll();});}
function pvStop(){post("/api/preview/stop").then(()=>{const im=el("pvImg"); if(im) im.src="";
  if(PVTIMER){clearTimeout(PVTIMER);PVTIMER=null;} el("pvSt").textContent="idle"; el("pvSt").className="pill"; el("pvFps").textContent="0.0";});}
function pvSeek(sec){post("/api/preview/seek",{seconds:sec});}
function pvSpeed(x){post("/api/preview/speed",{speed:x});
  [1,4,10].forEach(n=>{const b=el("sp"+n); if(b) b.className=(n===x?"on":"");});}
function addSource(){
  get("/api/preview").then(p=>{
    if(!p.url){alert("open a recording first");return;}
    post("/api/source/add",{url:p.url,datetime:p.dt,
      tag:el("srcTag").value,note:el("srcNote").value})
     .then(()=>{el("srcTag").value="";el("srcNote").value="";loadSources();});});}
const STAGE_CLASS={not_captured:"",captured_empty:"",captured:"warn",
  correcting:"warn",ready:"warn",added:"ok",duplicate:""};
const SRCSTAGES=[["all","all"],["not_captured","not captured"],["captured","captured"],
  ["correcting","in correction"],["ready","ready to add"],["added","added"],
  ["duplicate","duplicate"],["captured_empty","nothing found"]];
let SRCFILT="all";
function setSrcFilt(f){SRCFILT=f;drawSources();}
function srcPool(s){ if(SRCFILT==="all")return s;
  return s.filter(x=>(x.status&&x.status.stage)===SRCFILT); }
function loadSources(){get("/api/sources").then(s=>{window.__SRC=s;drawSources();});}
function drawSources(){
  const s=window.__SRC||[];
  const cnt={}; s.forEach(x=>{const st=(x.status&&x.status.stage)||"not_captured";cnt[st]=(cnt[st]||0)+1;});
  el("srcFilters").innerHTML=SRCSTAGES.map(([id,label])=>
    `<button class="${SRCFILT===id?'on':''} ${cnt[id]?'':'dim'}" onclick="setSrcFilt('${id}')">
      ${label}${id==="all"?` (${s.length})`:` (${cnt[id]||0})`}</button>`).join(" ");
  const pool=srcPool(s);
  el("srcList").innerHTML = pool.length? pool.map(x=>{
    const st=x.status||{stage:"not_captured",label:"not captured yet"};
    return `
    <div class=srcrow style="${x.frames&&x.frames.length?'align-items:flex-start':''}">
      <span class=tag>${x.tag||"untagged"}</span>
      <div style="flex:1"><div style="font-size:13px">${(x.datetime||"live").replace("T"," ")}
        <span class="pill ${STAGE_CLASS[st.stage]||''}" style="margin-left:6px">${st.label}</span>
        ${x.note?("&mdash; "+x.note):""}</div>
        <div class=u>${x.url}</div>
        ${x.frames&&x.frames.length?`<div class=row style="margin-top:6px;flex-wrap:wrap">
          ${x.frames.map(f=>`<img src="/scanimg/${f}" style="height:110px;border-radius:6px;border:1px solid var(--line)">`).join("")}
        </div>`:""}</div>
      <button onclick="reopen('${x.id}')">reopen here</button>
      <button class=pri onclick="useSource('${x.id}')">run model on it &rarr;</button>
      <button class=pri onclick="autocap('${x.id}',this)">capture for correction &rarr;</button>
      <button class=dan onclick="delSource('${x.id}')">remove</button>
    </div>`;}).join("")
    : (s.length? `<div class=empty>Nothing in this filter.</div>`
               : `<div class=empty>Nothing saved yet. Open a recording above, scrub to a moment worth keeping,
       then tag it.</div>`);
}
function reopen(id){const s=(window.__SRC||[]).find(x=>x.id===id); if(!s)return;
  el("pvUrl").value=s.url;
  post("/api/preview/open",{url:s.url}).then(()=>{const im=el("pvImg"); if(im) im.src="/preview?t="+Date.now(); pvPoll();
    el("pvUrl").scrollIntoView({behavior:"smooth",block:"center"});
    el("pvUrl").style.outline="2px solid #4a9eff";
    setTimeout(()=>{el("pvUrl").style.outline="";},1500);
  });}
function delSource(id){post("/api/source/del",{id}).then(loadSources);}
function useSource(id){const s=(window.__SRC||[]).find(x=>x.id===id); if(!s)return;
  el("liveUrl").value=s.url; window.__TAG=s.tag||""; window.__SID=id; show("s2");}
function autocap(id,btn){
  const t=btn.textContent; btn.textContent="capturing..."; btn.disabled=true;
  post("/api/source/autocapture",{id,model:MODEL,conf:0.35}).then(d=>{
    btn.disabled=false;
    if(!d.ok){btn.textContent=t; alert("could not capture: "+(d.error||"unknown error")); return;}
    btn.textContent=`${d.frames} frames, ${d.detections} detections ✓`;
    loadSources();
    setTimeout(()=>{
      if(confirm(`Captured ${d.frames} frames (${d.detections} detections). Go to step 3 to correct them now?`))
        show("s3");
      else btn.textContent=t;
    },300);
  });
}
/* ---------- 1b auto-find with the model ---------- */
let SCANSEL={0:true,1:true,2:true,3:true,4:true,5:true}, SCANMODEL="v21", SCANPOLL=null;
let SCANSIG="model";
const SCANSIGOPTS=[
  ["model","model only","The real detector's own class call, at the confidence below. Fastest, and what actually runs in production."],
  ["hsv","hsv only","Seam-colour check on the same box the model draws, using the validated hsv3 algorithm - not an independent scan (blind whole-frame colour search was tried and threw 25+ false hits per frame off wall stacks). Can only name a colour FAMILY: a “red” vote may be red_sack or other_sack_red_grey, and it can never confirm other_sack_white (no colour to find)."],
  ["either","model OR hsv","Counts a hit if either signal names one of your selected classes. Casts a wider net - more candidates, more of them wrong."],
  ["disagree","model vs hsv disagreement","Flags detections where the model's class and the hsv vote on that SAME box give different colour families - e.g. model says blue_sack but the seam reads red. This is exactly the kind of conflict the manual label audit looked for, found automatically. hsv abstaining (can't tell) is never treated as disagreement."]];
function scanToggle(){
  const on=el("scanOn").checked;
  el("scanPanel").style.display=on?"block":"none";
  if(on){scanClsBtns();scanModelBtns();scanSigBtns();
    if(!SCANPOLL) SCANPOLL=setInterval(scanPoll,900);
  } else if(SCANPOLL){clearInterval(SCANPOLL);SCANPOLL=null;}
}
function scanClsBtns(){
  el("scanCls").innerHTML=CLS.map(([id,full,lab,c])=>
    `<button class="${SCANSEL[id]?'on':''}" style="margin-left:4px"
      onclick="scanSel(${id})"><span class=sw style="background:${c}"></span>${lab}</button>`).join("");
}
function scanSel(id){SCANSEL[id]=!SCANSEL[id];scanClsBtns();}
function scanModelBtns(){
  el("scanModelSel").innerHTML=["v21","v20","TestS_allsack_synth","hybridv1_allsack_synth","hybridv1_carried_synth","v28_synth_blue","v26_composite_blue","v25_blue_composite","v24_blue_synth","v22_synth","v20_synth","v18","v13","v11_neg119","v10_NONEG"].map(m=>
    `<button class="${SCANMODEL===m?'on':''}" onclick="scanSetModel('${m}')">${m}</button>`).join(" ");
}
function scanSetModel(m){SCANMODEL=m;scanModelBtns();}
function scanSigBtns(){
  el("scanSignal").innerHTML=SCANSIGOPTS.map(([id,lab])=>
    `<button class="${SCANSIG===id?'on':''}" style="margin-left:4px"
      onclick="scanSetSig('${id}')">${lab}</button>`).join("");
  scanSigHint();
}
function scanSetSig(id){SCANSIG=id;scanSigBtns();}
function scanSigHint(){
  const o=SCANSIGOPTS.find(x=>x[0]===SCANSIG);
  el("scanSignalHint").textContent=o?o[2]:"";
}
function scanStart(){
  const classes=CLS.filter(([id])=>SCANSEL[id]).map(([,full])=>full);
  if(!classes.length){alert("pick at least one class");return;}
  const u=el("pvUrl").value.trim();
  post("/api/scan/start",{url:u,duration_min:+el("scanDur").value,classes,
    model:SCANMODEL,conf:+el("scanConf").value,speed:+el("scanSpeed").value,signal:SCANSIG,
    min_hits:+el("scanMinHits").value})
   .then(d=>{ if(!d.ok){el("scanErr").textContent=d.error||"could not start";}
              else {el("scanErr").textContent="";SCANLASTN=0;el("scanFound").textContent="";scanShowStream(true);} });
}
function scanStop(){post("/api/scan/stop").then(()=>scanShowStream(false));}
function scanShowStream(on){
  const img=el("scanImg");
  img.style.display=on?"block":"none";
  img.src=on?("/scan_stream?t="+Date.now()):"";
}
let SCANLASTN=0;
function scanPoll(){
  get("/api/scan/status").then(s=>{
    el("scanSt").textContent=s.err?"error":(s.run?"scanning "+s.cur:(s.done?"done":"idle"));
    el("scanSt").className="pill"+(s.err?" bad":(s.run?" on":""));
    el("scanPct").textContent=s.run?s.pct+"%":"";
    el("scanHits").textContent=s.hits?s.hits+" raw hits, "+s.found.length+" moment(s) saved"+
      (s.dropped?", "+s.dropped+" dropped as single-frame noise":""):"";
    el("scanErr").textContent=s.err||"";
    if(!s.run) scanShowStream(false);
    if(s.found && s.found.length){
      if(s.found.length!==SCANLASTN && TAB==="s1") loadSources();
      SCANLASTN=s.found.length;
      el("scanFound").innerHTML="<b>found:</b> "+s.found.slice(0,8).map(f=>
        `${f.label} (${f.start.slice(11)}&ndash;${f.end.slice(11)}, ${f.n}x)`).join(" &middot; ");
    }
  });
}

// Preview status poll: self-scheduling, and ONLY while a recording is actually playing.
// (Was an unconditional 0.9 s setInterval that kept hitting /api/preview after Stop.)
let PVTIMER=null;
function pvPoll(){
  if(PVTIMER){clearTimeout(PVTIMER);PVTIMER=null;}
  if(TAB!=="s1")return;                      // resumed by show('s1')
  get("/api/preview").then(p=>{
    el("pvNow").textContent=(p.dt||"—").replace("T"," ");
    el("pvFps").textContent=p.fps.toFixed(1);
    el("pvSt").textContent=p.err||(p.run?"playing":"idle");
    el("pvSt").className="pill"+(p.err?" bad":"");
    if(el("pvUrlNow")) el("pvUrlNow").textContent=p.url||"";
    if(p.run) PVTIMER=setTimeout(pvPoll,900);  // idle/stopped -> no further requests
  });
}

/* ---------- 2 capture ---------- */
function modelBtns(){el("modelBtns").innerHTML=["v21","v20","TestS_allsack_synth","hybridv1_allsack_synth","hybridv1_carried_synth","v28_synth_blue","v26_composite_blue","v25_blue_composite","v24_blue_synth","v22_synth","v20_synth","v18","v13","v11_neg119","v10_NONEG"].map(m=>
  `<button class="${MODEL===m?'on':''}" onclick="setModel('${m}')">${m}</button>`).join(" ");}
function setModel(m){MODEL=m;modelBtns();post("/api/live/set",{model:m});}
// The annotated live view is a persistent multipart/x-mixed-replace connection opened by
// <img id=liveImg>'s src - it does NOT survive a server restart (the browser never retries
// on its own), and detection stats keep updating fine via the separate /api/live JSON poll
// even while the image itself is frozen or blank, which made a dead stream connection easy
// to miss. Reconnect explicitly on start, drop it on stop, and self-heal on error or if
// livePoll ever finds it running with no connection open - no manual page reload needed.
function liveImgReconnect(){const im=el("liveImg"); if(im) im.src="/stream?t="+Date.now();}
function liveImgDisconnect(){const im=el("liveImg"); if(im) im.removeAttribute("src");}
function wireLiveImg(){
  const im=el("liveImg"); if(!im||im.dataset.wired)return; im.dataset.wired="1";
  im.onerror=()=>{ im.removeAttribute("src"); };  // next livePoll tick reconnects if still running
}
function liveStart(){post("/api/live/start",{url:el("liveUrl").value,model:MODEL,
  conf:+el("conf").value,buf_n:+el("bufN").value,buf_fps:+el("bufFps").value,
  tag:window.__TAG||"",source_id:window.__SID||""}).then(()=>{liveImgReconnect(); livePoll();});}
function liveStop(){el("liveSt").textContent="stopping...";
  post("/api/live/stop").then(d=>{el("liveSt").textContent="stopped, "+d.gpu_free_mib+" MiB free";
    liveImgDisconnect();});}
function liveSet(o){post("/api/live/set",o);}
function capture(){const b=event.target,t=b.textContent;b.textContent="saving...";
  post("/api/live/capture",{}).then(d=>{b.textContent=t;
    el("capLog").insertAdjacentHTML("afterbegin",`<div>${d.id} &mdash; ${d.frames} frames</div>`);});}
let LIVETIMER=null;
function livePoll(){ if(LIVETIMER){clearTimeout(LIVETIMER);LIVETIMER=null;}
  if(TAB!=="s2")return;                      // resumed by show('s2')
  wireLiveImg();
  get("/api/live").then(s=>{
  el("fps").textContent=s.fps.toFixed(1); el("nCar").textContent=s.n;
  el("bufN2").textContent=s.buf; el("nEv").textContent=s.events;
  el("bufDesc").textContent=`${s.buf_n} frames at ${s.buf_fps} fps`;
  if(s.run||s.err){el("liveSt").textContent=s.err||"live";
    el("liveSt").className="pill"+(s.err?" bad":"");}
  const im=el("liveImg");
  if(s.run){ if(im && !im.getAttribute("src")) liveImgReconnect(); }
  else if(im && im.getAttribute("src")){ liveImgDisconnect(); }
  el("clsCounts").innerHTML=CLS.map(([id,full,lab,c])=>
    `<span class=pill><span class=sw style="background:${c}"></span>${lab} <b>${s.counts[lab]||0}</b></span>`).join("");
  if(s.run) LIVETIMER=setTimeout(livePoll,800);   // idle/stopped -> no further requests
});}

/* ---------- 3 correct ---------- */
let EXCL=new Set();
let DEFER=new Set();
function loadQueue(){get("/api/queue").then(d=>{QUEUE=d.items;CORR=d.corrections;
  EXCL=new Set(d.excluded||[]);DEFER=new Set(d.deferred||[]);QPG=0;drawQueue();});}
function toggleExclude(fid){
  const now=EXCL.has(fid);
  if(!now && !confirm("Exclude this whole frame from the dataset? Use this when the model MISSED "+
    "a sack entirely (no polygon to correct) - committing it as-is would silently teach the model "+
    "that missed region is NOT a sack. The capture stays on disk; this only keeps it out of commit."))
    return;
  post("/api/frame/exclude",{fid,include:now}).then(()=>{
    if(now)EXCL.delete(fid); else EXCL.add(fid);
    drawQueue();
  });
}
function toggleDefer(fid){
  const now=DEFER.has(fid);
  post("/api/frame/defer",{fid,defer:!now}).then(()=>{
    if(now)DEFER.delete(fid); else DEFER.add(fid);
    drawQueue();
  });
}
function archiveFrame(fid){
  if(!confirm("Move this frame to History? It won't be added to the dataset and drops out of "+
    "the Correct tab - use this for a frame that isn't worth pursuing. Anything already judged "+
    "on it is kept, and you can restore it from History any time."))return;
  post("/api/frame/archive",{fid,archive:true}).then(()=>{
    QUEUE=QUEUE.filter(i=>i.id!==fid); DEFER.delete(fid); EXCL.delete(fid); drawQueue();
  });
}
function qpool(){
  // Frames parked in "review later" are invisible to every filter here, no exceptions -
  // they only ever show in the dedicated Review Later tab. Without this, a deferred frame
  // could still surface under "all" (or any class filter) and look like it "came back".
  const base=QUEUE.filter(i=>!DEFER.has(i.id));
  if(QFILT==="all")return base;
  if(QFILT==="todo")return base.filter(i=>!EXCL.has(i.id)&&i.dets.some(d=>!CORR[i.id+"|"+d.n]));
  if(QFILT==="excluded")return base.filter(i=>EXCL.has(i.id));
  return base.filter(i=>i.dets.some(d=>d.name===QFILT));}
function setQF(f){QFILT=f;QPG=0;drawQueue();}
function drawQueue(){
  const pool=qpool(), PER=3, NP=Math.max(1,Math.ceil(pool.length/PER));
  if(QPG>=NP)QPG=NP-1;
  const base=QUEUE.filter(i=>!DEFER.has(i.id));
  const cnt={}; base.forEach(i=>i.dets.forEach(d=>cnt[d.name]=(cnt[d.name]||0)+1));
  const nExcl=base.filter(i=>EXCL.has(i.id)).length;
  el("qFilters").innerHTML=[`<button class="${QFILT==='all'?'on':''}" onclick="setQF('all')">all</button>`,
    `<button class="${QFILT==='todo'?'on':''}" onclick="setQF('todo')">not yet judged</button>`,
    `<button class="dan ${QFILT==='excluded'?'on':''} ${nExcl?'':'dim'}" onclick="setQF('excluded')">excluded (${nExcl})</button>`]
    .concat(Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a]).map(k=>
      `<button class="${QFILT===k?'on':''}" onclick="setQF('${k}')">${k} (${cnt[k]})</button>`)).join(" ");
  let done=0; base.forEach(i=>i.dets.forEach(d=>{if(CORR[i.id+"|"+d.n])done++;}));
  const tot=base.reduce((a,i)=>a+i.dets.length,0);
  const nDefer=QUEUE.filter(i=>DEFER.has(i.id)).length;
  el("qSumm").innerHTML=`<b>${done}</b>/${tot} polygons judged &mdash; showing ${pool.length} frames`+
    (nDefer?` &mdash; <b>${nDefer}</b> parked in <a href="javascript:show('s3r')">Review later</a>`:"");
  const items=pool.slice(QPG*PER,(QPG+1)*PER);
  el("qList").innerHTML= items.length? items.map(it=>{
    const exd=EXCL.has(it.id);
    return `
    <div class="card${exd?' excluded':''}">
      <div class=row><b>${it.event}</b><span class=pill>frame ${it.frame} &nbsp; ${it.t}</span>
        ${it.tag?`<span class=tag>${it.tag}</span>`:""}
        <span class=pill id="rm_${it.id}"></span>
        <span style="margin-left:auto;display:flex;gap:6px">
        <button onclick="toggleDefer('${it.id}')">review later</button>
        <button class="${exd?'dan on':''}" onclick="toggleExclude('${it.id}')">
          ${exd?"excluded — won't be added (click to include)":"exclude this frame (missed detection)"}</button>
        <button onclick="archiveFrame('${it.id}')">move to history</button>
        </span>
      </div>
      ${exd?`<div class="hint" style="color:var(--bad);margin:6px 0">This frame will NOT be added on
        commit, no matter what is judged below - marked because the model missed a sack in it.</div>`:""}
      <canvas id="c_${it.id}" width="1150" height="${Math.round(it.H*1150/it.W)}"></canvas>
      <div class=row id="lg_${it.id}" style="margin-top:8px"></div>
      <div id="pk_${it.id}"></div>
    </div>`;}).join("") : `<div class=empty>Nothing here. Capture some frames in step 2.</div>`;
  items.forEach(paint); items.forEach(legend); counter();
  const nav=`<button onclick="qgo(-1)">&larr; prev</button>
    <span class=pill>page ${QPG+1}/${NP}</span>
    <button onclick="qgo(1)">next &rarr;</button>
    <span class=pill style="color:var(--dim)">keys: &larr;/&rarr; or P/N</span>`;
  el("qNav").innerHTML=nav;
  drawBulk(pool);
}
/* bulk-correct the WHOLE filtered set at once, not just the current page */
function bulkKeys(pool){
  const keys=[];
  pool.filter(it=>!EXCL.has(it.id)).forEach(it=>it.dets.forEach(d=>keys.push([it,d])));
  return keys;
}
function drawBulk(pool){
  const pairs=bulkKeys(pool);
  // frame-level bulk actions (defer/archive) use every frame in the filter, even excluded
  // ones - they're independent of exclude/judgement state, unlike the detection-level actions.
  const frameHtml = pool.length ? `<div class=opts style="margin-top:${pairs.length?'8px':'0'}">
    <button onclick="bulkDefer(true)">review later &mdash; all ${pool.length} frame(s) in this filter</button>
    <button onclick="bulkArchive()">move all ${pool.length} frame(s) in this filter to history</button>
  </div>` : "";
  if(!pairs.length){
    el("qBulk").innerHTML = frameHtml ? `<div class=card style="background:#11161c">
      <div style="font-size:13px;color:var(--dim);margin-bottom:8px">frame actions apply to all
        <b>${pool.length}</b> frame(s) in the CURRENT FILTER, across every page.</div>${frameHtml}</div>` : "";
    return;
  }
  const unjudged=pairs.filter(([it,d])=>!CORR[it.id+"|"+d.n]).length;
  let html=`<div class=card style="background:#11161c">
    <div style="font-size:13px;color:var(--dim);margin-bottom:8px">
      bulk actions apply to all <b>${pairs.length}</b> detections in the CURRENT FILTER
      (${unjudged?unjudged+" not yet judged":"all already judged"}), across every page &mdash;
      not just what's on screen.</div>
    <div class=opts>
      <button class=pri onclick="bulkConfirm()">confirm all ${pairs.length} as shown (model was right)</button>`;
  if(QFILT!=="all" && QFILT!=="todo"){
    html+=CLS.map(([id,full,lab,c])=>`<button onclick="bulkSet('${full}')">
        <span class=sw style="background:${c}"></span>bulk &rarr; ${lab}</button>`).join("")+
      `<button class=dan onclick="bulkSet('delete')">bulk &rarr; not a sack, delete</button>
       <button class=dan onclick="bulkSet('bad_mask')">bulk &rarr; bad outline</button>`;
  }
  html+=`<button onclick="bulkSet('')">clear all judgements in this filter</button>
    </div>${frameHtml}</div>`;
  el("qBulk").innerHTML=html;
}
function bulkDefer(defer){
  const fids=qpool().map(i=>i.id);
  if(!fids.length)return;
  const msg=defer?`Mark all ${fids.length} frame(s) in this filter as "review later"?`
                 :`Bring all ${fids.length} frame(s) back from "review later"?`;
  if(!confirm(msg))return;
  post("/api/frame/defer/bulk",{fids,defer}).then(()=>{
    fids.forEach(f=>defer?DEFER.add(f):DEFER.delete(f)); drawQueue();
  });
}
function bulkArchive(){
  const fids=qpool().map(i=>i.id);
  if(!fids.length)return;
  if(!confirm(`Move all ${fids.length} frame(s) in this filter to History? They won't be added `+
    `to the dataset. Anything already judged is kept, and you can restore from History any time.`))return;
  post("/api/frame/archive/bulk",{fids}).then(()=>{
    const s=new Set(fids); QUEUE=QUEUE.filter(i=>!s.has(i.id)); drawQueue();
  });
}

/* ---------- 4 review later: parked frames, view-only until you say "correct this now" ----------
   Deliberately NOT the interactive canvas from the Correct tab - clicking here would edit
   nothing (no picker div, no selection state), and reusing that machinery risked colliding
   with tab 3's own canvases if a frame ever rendered in both places at once. This is a plain
   read-only preview (image + detection outlines) so there's exactly one place a frame's
   correction UI ever lives. */
function loadReviewLater(){get("/api/queue").then(d=>{QUEUE=d.items;CORR=d.corrections;
  EXCL=new Set(d.excluded||[]);DEFER=new Set(d.deferred||[]);drawReviewLater();});}
function reviewLaterPool(){return QUEUE.filter(i=>DEFER.has(i.id));}
function paintPreview(it){
  const cv=el("rc_"+it.id); if(!cv)return; const ctx=cv.getContext("2d"), s=cv.width/it.W;
  const img=new Image();
  img.onload=()=>{ctx.drawImage(img,0,0,cv.width,cv.height);
    it.dets.forEach(d=>{
      ctx.lineWidth=3; ctx.strokeStyle=COLOR[d.cls];
      ctx.beginPath();
      d.poly.forEach((p,k)=>k?ctx.lineTo(p[0]*s,p[1]*s):ctx.moveTo(p[0]*s,p[1]*s));
      ctx.closePath(); ctx.stroke();});};
  img.src="/img/"+it.img;
}
function drawReviewLater(){
  const pool=reviewLaterPool();
  el("rlSumm").innerHTML=pool.length
    ? `<b>${pool.length}</b> frame(s) parked for later`+
      `<button class=pri style="margin-left:12px" onclick="bulkCorrectNowFromReviewLater()">`+
      `correct all ${pool.length} now &rarr; move to "not yet judged"</button>`
    : `nothing parked right now`;
  el("rlList").innerHTML = pool.length ?
    `<div class=grid style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">`+
    pool.map(it=>`<div class=card>
      <div class=row><b>${it.event}</b><span class=pill>frame ${it.frame} &nbsp; ${it.t}</span>
        ${it.tag?`<span class=tag>${it.tag}</span>`:""}</div>
      <canvas id="rc_${it.id}" width="420" height="${Math.round(it.H*420/it.W)}"
        style="width:100%;border-radius:8px;margin:6px 0"></canvas>
      <div style="font-size:12.5px;color:var(--dim)">${it.dets.map(d=>`${d.name} ${d.conf}`).join(", ")}</div>
      <button class=pri style="margin-top:8px;width:100%" onclick="correctNowFromReviewLater('${it.id}')">
        correct this now &rarr; not yet judged</button>
    </div>`).join("")+`</div>`
    : `<div class=empty>Nothing parked. Frames you mark "review later" in the Correct tab show up here.</div>`;
  pool.forEach(paintPreview);
}
function correctNowFromReviewLater(fid){
  post("/api/frame/defer",{fid,defer:false}).then(()=>{
    DEFER.delete(fid); drawReviewLater();
    QFILT="todo"; show("s3");   // land straight on it in "not yet judged"
  });
}
function bulkCorrectNowFromReviewLater(){
  const fids=reviewLaterPool().map(i=>i.id);
  if(!fids.length)return;
  if(!confirm(`Move all ${fids.length} parked frame(s) back to "not yet judged" now?`))return;
  post("/api/frame/defer/bulk",{fids,defer:false}).then(()=>{
    fids.forEach(f=>DEFER.delete(f)); drawReviewLater();
    QFILT="todo"; show("s3");
  });
}

function bulkConfirm(){
  const pool=qpool(); const pairs=bulkKeys(pool)
    .map(([it,d])=>({key:it.id+"|"+d.n,value:d.name}));
  if(!pairs.length)return;
  if(!confirm(`Confirm all ${pairs.length} detections in this filter as correct (each keeps its own predicted class)?`))return;
  post("/api/correct/bulk",{pairs}).then(()=>{pairs.forEach(p=>CORR[p.key]=p.value);drawQueue();});
}
function bulkSet(v){
  const pool=qpool(); const keys=bulkKeys(pool).map(([it,d])=>it.id+"|"+d.n);
  if(!keys.length)return;
  const label=v?("to "+v):"(clear)";
  if(!confirm(`Apply "${label}" to all ${keys.length} detections in this filter?`))return;
  post("/api/correct/bulk",{keys,value:v}).then(()=>{
    keys.forEach(k=>{if(v)CORR[k]=v; else delete CORR[k];});
    drawQueue();
  });
}
function qgo(d){const NP=Math.max(1,Math.ceil(qpool().length/3));
  QPG=Math.max(0,Math.min(NP-1,QPG+d));SEL={};drawQueue();window.scrollTo(0,0);}
// Keyboard paging: -> / N for next page, <- / P for previous - works in the Correct tab
// (frame-by-frame correction, where this saves a lot of mouse trips) and History. Ignored
// while typing in any input/textarea/select so it never hijacks a URL, tag, or number field.
document.addEventListener("keydown",e=>{
  const t=e.target, tag=(t.tagName||"").toLowerCase();
  if(tag==="input"||tag==="textarea"||tag==="select"||t.isContentEditable)return;
  const fwd=e.key==="ArrowRight"||e.key==="n"||e.key==="N";
  const back=e.key==="ArrowLeft"||e.key==="p"||e.key==="P";
  if(!fwd&&!back)return;
  if(TAB==="s3"){e.preventDefault();qgo(fwd?1:-1);}
  else if(TAB==="s5"){e.preventDefault();hgo(fwd?1:-1);}
});
function paint(it){
  const cv=el("c_"+it.id); if(!cv)return; const ctx=cv.getContext("2d"), s=cv.width/it.W;
  const img=new Image();
  img.onload=()=>{ctx.drawImage(img,0,0,cv.width,cv.height);
    it.dets.forEach(d=>{const v=CORR[it.id+"|"+d.n], sel=SEL[it.id]===d.n;
      ctx.lineWidth=sel?6:4;
      ctx.strokeStyle=v==="delete"?"#ff4d4d":(v?"#4cff8f":COLOR[d.cls]);
      ctx.setLineDash(v==="delete"?[9,6]:[]);
      ctx.beginPath();
      d.poly.forEach((p,k)=>k?ctx.lineTo(p[0]*s,p[1]*s):ctx.moveTo(p[0]*s,p[1]*s));
      ctx.closePath();ctx.stroke();ctx.setLineDash([]);
      const x=Math.min(...d.poly.map(p=>p[0]))*s, y=Math.min(...d.poly.map(p=>p[1]))*s;
      const lab=v?`${d.n}  ${d.name} → ${v==="delete"?"DELETE":v}`:`${d.n}`;
      ctx.font="bold 15px system-ui"; const w=ctx.measureText(lab).width+14;
      ctx.fillStyle=ctx.strokeStyle; ctx.fillRect(x,y-24,v?w:26,24);
      ctx.fillStyle="#000"; ctx.fillText(lab,x+7,y-7);});};
  img.src="/img/"+it.img;
  cv.onclick=e=>{const r=cv.getBoundingClientRect();
    const px=(e.clientX-r.left)*(cv.width/r.width)/s, py=(e.clientY-r.top)*(cv.height/r.height)/s;
    // a "double detection" (two polygons on the same real sack) means more than one
    // detection can contain the same click point. Collect ALL of them in drawing order,
    // and if the click lands in the same spot again while one of them is already selected,
    // step to the NEXT one underneath instead of always landing back on the topmost/last -
    // otherwise there was no way to reach the other polygon at all when they overlap.
    const cand=it.dets.filter(d=>inside(px,py,d.poly)).map(d=>d.n);
    let hit=null;
    if(cand.length){
      const i=cand.indexOf(SEL[it.id]);
      hit = i===-1 ? cand[cand.length-1] : cand[(i+1)%cand.length];
    } else {
      let best=1e18; it.dets.forEach(d=>{
        const cx=d.poly.reduce((a,p)=>a+p[0],0)/d.poly.length,
              cy=d.poly.reduce((a,p)=>a+p[1],0)/d.poly.length;
        const dd=(cx-px)**2+(cy-py)**2; if(dd<best){best=dd;hit=d.n;}});
    }
    selectDet(it.id,hit);};
}
function selectDet(fid,n){SEL[fid]=n; const it=QUEUE.find(x=>x.id===fid); if(!it)return;
  picker(it); paint(it); legend(it);}
function inside(x,y,poly){let c=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))c=!c;}
  return c;}
function legend(it){const e=el("lg_"+it.id); if(!e)return;
  e.innerHTML=it.dets.map(d=>{const v=CORR[it.id+"|"+d.n], sel=SEL[it.id]===d.n;
    // clickable: for two overlapping "double detection" polygons on the same real sack,
    // clicking the outline on the canvas can only ever reach one of them - these pills give
    // an unambiguous way to pick exactly which detection to delete vs. correct.
    return `<span class="pill" style="cursor:pointer;${sel?'outline:2px solid #4cff8f;outline-offset:1px':''}"
      onclick="selectDet('${it.id}',${d.n})"><span class=sw style="background:${COLOR[d.cls]}"></span>
      <b>${d.n}</b> ${d.name} ${d.conf}${v?` → <b class=ok>${v==="delete"?"DELETE":v}</b>`:""}</span>`;}).join("");}
function counter(){QUEUE.forEach(i=>{const e=el("rm_"+i.id); if(!e)return;
  const left=i.dets.filter(d=>!CORR[i.id+"|"+d.n]).length;
  e.innerHTML=left?`${i.dets.length} detections, <b>${left}</b> left`
                  :`${i.dets.length} detections &mdash; <b class=ok>all judged</b>`;});}
function picker(it){const n=SEL[it.id], d=it.dets.find(x=>x.n===n); if(!d)return;
  const k=it.id+"|"+n, v=CORR[k]||"";
  el("pk_"+it.id).innerHTML=`<div class=card style="margin:10px 0 0;background:#11161c">
    <div style="font-size:13.5px;color:var(--warn);margin-bottom:8px">
      polygon ${n} &mdash; model says <b>${d.name}</b> (${d.conf}). What is it really?</div>
    <div class=opts>
      ${CLS.map(([id,full,lab,c])=>`<button class="${v===full?'on':''}"
        onclick="setCorr('${it.id}',${n},'${full}')"><span class=sw style="background:${c}"></span>${lab}</button>`).join("")}
      <button class="dan ${v==='delete'?'on':''}" onclick="setCorr('${it.id}',${n},'delete')">not a sack &mdash; delete</button>
      <button class="dan ${v==='bad_mask'?'on':''}" onclick="setCorr('${it.id}',${n},'bad_mask')">bad outline</button>
      <button onclick="setCorr('${it.id}',${n},'')">clear</button>
    </div></div>`;}
function setCorr(fid,n,v){const k=fid+"|"+n;
  if(v)CORR[k]=v; else delete CORR[k];
  const it=QUEUE.find(x=>x.id===fid);
  picker(it);paint(it);legend(it);counter();
  post("/api/correct",{key:k,value:v});}

/* ---------- 4 review + commit ---------- */
/* ---------- 5 history: frames you're done with (committed, or manually archived) ---------- */
let HIST=[], HPG=0, HFILT="all";
function loadHistory(){get("/api/history").then(d=>{HIST=d.items;HPG=0;drawHistory();});}
function hpool(){
  if(HFILT==="committed")return HIST.filter(i=>i.committed);
  if(HFILT==="archived")return HIST.filter(i=>i.restorable);
  return HIST;
}
function setHF(f){HFILT=f;HPG=0;drawHistory();}
function restoreFromHistory(fid){
  post("/api/frame/archive",{fid,archive:false}).then(()=>{
    HIST=HIST.filter(i=>i.id!==fid); drawHistory();
  });
}
function drawHistory(){
  const pool=hpool(), PER=6, NP=Math.max(1,Math.ceil(pool.length/PER));
  if(HPG>=NP)HPG=NP-1;
  const nCommitted=HIST.filter(i=>i.committed).length, nArchived=HIST.filter(i=>i.restorable).length;
  el("hFilters").innerHTML=[
    `<button class="${HFILT==='all'?'on':''}" onclick="setHF('all')">all (${HIST.length})</button>`,
    `<button class="${HFILT==='committed'?'on':''}" onclick="setHF('committed')">added to dataset (${nCommitted})</button>`,
    `<button class="${HFILT==='archived'?'on':''}" onclick="setHF('archived')">archived, not added (${nArchived})</button>`,
  ].join(" ");
  const items=pool.slice(HPG*PER,(HPG+1)*PER);
  el("hList").innerHTML = items.length ? `<div class=grid style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">` + items.map(it=>{
    const last=it.log[it.log.length-1]||{};
    const badge = it.committed
      ? (it.added && it.added.duplicate
          ? `<span class="pill">duplicate — already in dataset, skipped</span>`
          : `<span class="pill ok">added to ${it.added?it.added.dataset:'dataset'}</span>`)
      : `<span class="pill warn">archived (not added)</span>`;
    return `<div class=card>
      <div class=row><b>${it.event}</b><span class=pill>frame ${it.frame}</span></div>
      <img src="/img/${it.img}" style="width:100%;border-radius:8px;margin:6px 0">
      <div class=row>${badge}<span class=pill style="margin-left:auto">${last.at||""}</span></div>
      ${it.restorable?`<button style="margin-top:8px" onclick="restoreFromHistory('${it.id}')">restore to Correct tab</button>`:""}
    </div>`;}).join("") + `</div>`
    : `<div class=empty>Nothing here yet. Frames land here once you add them to the dataset (step 4), or move one to history from the Correct tab.</div>`;
  el("hNav").innerHTML = `<button onclick="hgo(-1)">&larr; prev</button>
    <span class=pill>page ${HPG+1}/${NP}</span>
    <button onclick="hgo(1)">next &rarr;</button>
    <span class=pill style="color:var(--dim)">keys: &larr;/&rarr; or P/N</span>`;
}
function hgo(d){const NP=Math.max(1,Math.ceil(hpool().length/6));HPG=Math.max(0,Math.min(NP-1,HPG+d));drawHistory();window.scrollTo(0,0);}

function loadReview(){get("/api/review").then(d=>{REVIEW=d;drawReview();});}
function drawReview(){
  const d=REVIEW; if(!d)return;
  const all=d.changes.concat(d.confirms), rej=new Set(d.rejected);
  d.counts && drawCommit(d.counts);
  el("revSumm").innerHTML=`<b>${d.changes.length}</b> changed, <b>${d.confirms.length}</b> confirmed,
    <b>${d.rejected.length}</b> rejected`;
  const grp={}; all.forEach(r=>{const k=r.was+" → "+r.now;(grp[k]=grp[k]||[]).push(r);});
  el("revList").innerHTML=Object.keys(grp).sort((a,b)=>grp[b].length-grp[a].length).map(k=>{
    const rows=grp[k], a=k.split(" → ")[0], b=k.split(" → ")[1], same=(a===b);
    return `<div class=card><h2>${same?`confirmed correct: <b>${a}</b>`:
      `<b>${a}</b> → <b class=ok>${b}</b>`} <span class=pill>${rows.length}</span>
      <button onclick="rejGroup('${k}',1)">reject all</button>
      <button onclick="rejGroup('${k}',0)">keep all</button></h2>
      <div class=flex>${rows.map(r=>`
        <div class="crop ${rej.has(r.key)?'bad':'ok'}">
          <img loading=lazy src="/crop/${r.key.replace(/[|#]/g,'_')}.jpg">
          <div style="font-size:12px;color:var(--dim);margin-top:5px">${r.event.slice(9)} f${r.frame} &nbsp; ${r.conf}</div>
          <div class=opts>
            <button class="${rej.has(r.key)?'':'on'}" onclick="rej('${r.key}',1)">keep</button>
            <button class="dan ${rej.has(r.key)?'on':''}" onclick="rej('${r.key}',0)">reject</button>
          </div></div>`).join("")}</div></div>`;}).join("")
    || `<div class=empty>Nothing judged yet. Correct some detections in step 3.</div>`;
}
function rej(key,keep){post("/api/reject",{key,undo:!!keep}).then(d=>{loadReview();});}
function rejGroup(k,doRej){const all=REVIEW.changes.concat(REVIEW.confirms)
  .filter(r=>(r.was+" → "+r.now)===k);
  Promise.all(all.map(r=>post("/api/reject",{key:r.key,undo:!doRej}))).then(loadReview);}
function drawCommit(c){
  el("commitTbl").innerHTML=`<tr><th>class</th><th class=num>instances to add</th></tr>`+
    Object.entries(c.per_class).map(([k,v])=>`<tr><td>${k}</td><td class=num>${v}</td></tr>`).join("")+
    `<tr><th>total</th><th class=num>${c.total}</th></tr>
     <tr><td>frames</td><td class=num>${c.frames}</td></tr>
     <tr><td>of which empty (hard negatives)</td><td class=num>${c.negatives}</td></tr>
     <tr><td>detections deleted</td><td class=num>${c.deleted}</td></tr>
     ${c.excluded_frames?`<tr><td>frames excluded (missed detections)</td><td class=num>${c.excluded_frames}</td></tr>`:""}`;}
let DSVERSIONS=[], SELECTED_DS=null;
function commit(){
  const target=SELECTED_DS||LATEST_DS;
  if(!confirm(`Add these labels directly into ${target}? This changes ${target} itself, in `+
    `place - no new version is created. Clone it first (in Dataset version history) if you `+
    `want to keep an unmodified copy.`))return;
  post("/api/commit",{target:SELECTED_DS}).then(d=>{
    el("commitMsg").innerHTML= d.ok
      ? `<b class=ok>Added to ${d.dataset}</b> &mdash; ${d.frames_added} frames,
         ${d.total} instances (${d.negatives} negatives).<br>
         ${Object.entries(d.per_class).map(([k,v])=>k+" +"+v).join(", ")}`
      : `<b class=bad>${d.error}</b>`;
    loadReview(); loadDataset(); loadQueue();});}

/* ---------- dataset table + version history / dataset-to-add-into picker ---------- */
function loadDataset(){
  loadDatasetVersions();
  get("/api/dataset"+(SELECTED_DS?"?name="+SELECTED_DS:"")).then(drawDataset);
}
function pickBase(name){SELECTED_DS=(name===LATEST_DS?null:name);
  drawVersionPicker(); get("/api/dataset"+(SELECTED_DS?"?name="+SELECTED_DS:"")).then(drawDataset);}
let LATEST_DS=null;
function loadDatasetVersions(){get("/api/dataset/versions").then(d=>{
  DSVERSIONS=d.versions; LATEST_DS=d.latest; drawVersionPicker(); drawVersionHistory();});}
function drawVersionPicker(){
  const box=el("commitBasePick"); if(!box)return;
  box.innerHTML=`<div class=hint style="margin-bottom:6px">add labels to (selecting also
    changes what "Viewing" below shows):</div>`+
    DSVERSIONS.map(v=>`<button class="${(SELECTED_DS?SELECTED_DS===v.name:v.is_latest)?'on':''}"
      onclick="pickBase('${v.name}')">${v.name}${v.is_latest?' (latest)':''}
      &nbsp;<span class=pill>${v.train.total} inst.</span></button>`).join(" ");
}
function drawDataset(d){
  if(!d.exists){el("dsTbl").innerHTML="<tr><td>dataset not found</td></tr>";return;}
  el("dsName").textContent=d.name+" — new labels will be added here";
  if(el("dsPill")) el("dsPill").innerHTML=`${d.name} &mdash; <b>${d.train.total}</b> instances`;
  const rows=Object.keys(d.train.per_class).map(k=>{
    const b=d.balance[k]||{}; const r=b.real_pct!==undefined
      ? (b.train_pct/Math.max(0.1,b.real_pct)).toFixed(1)+"x" : "";
    const cls=b.real_pct===undefined?"":(b.train_pct>2*b.real_pct?"warn":(b.train_pct<0.5*b.real_pct?"bad":"ok"));
    return `<tr><td>${k}</td><td class=num>${d.train.per_class[k]||0}</td>
      <td class=num>${d.val.per_class[k]||0}</td>
      <td class=num>${b.train_pct!==undefined?b.train_pct+"%":""}</td>
      <td class=num>${b.real_pct!==undefined?b.real_pct+"%":""}</td>
      <td class="num ${cls}">${r}</td></tr>`;}).join("");
  el("dsTbl").innerHTML=`<tr><th>class</th><th class=num>train</th><th class=num>val</th>
    <th class=num>train %</th><th class=num>real %</th><th class=num>ratio</th></tr>${rows}
    <tr><th>total</th><th class=num>${d.train.total}</th><th class=num>${d.val.total}</th>
    <th colspan=3></th></tr>
    <tr><td>images</td><td class=num>${d.train.images}</td><td class=num>${d.val.images}</td>
    <td colspan=3 style="color:var(--dim);font-size:12px">${d.train.negatives} hard negatives</td></tr>`;
}
function drawVersionHistory(){
  const box=el("dsVersions"); if(!box)return;
  box.innerHTML=DSVERSIONS.map(v=>{
    const delta=v.delta_from_prev;
    const deltaHtml = delta===null ? `<span class=pill>first version</span>`
      : Object.keys(delta).length
        ? Object.entries(delta).map(([k,n])=>`<span class=pill>${k} ${n>0?'+':''}${n}</span>`).join(" ")
        : `<span class=pill>no change</span>`;
    return `<div class=row style="padding:8px 0;border-bottom:1px solid var(--bd)">
      <b>${v.name}</b>${v.is_latest?'<span class="pill ok">latest</span>':''}
      <span class=pill>${v.train.images} train / ${v.val.images} val images</span>
      <span class=pill>${v.train.total} instances</span>
      ${v.images_added!==null?`<span class=pill>${v.images_added>=0?'+':''}${v.images_added} images vs prev</span>`:""}
      <span style="margin-left:auto">${deltaHtml}</span>
      <button style="margin-left:8px" onclick="cloneDataset('${v.name}')">clone as new version</button>
      <button class=dan style="margin-left:6px" onclick="deleteDataset('${v.name}',${v.is_latest})">delete</button>
    </div>`;}).join("") || `<div class=empty>No dataset versions found.</div>`;
}
function cloneDataset(name){
  if(!confirm(`Create a new dataset version that is an exact copy of ${name} - no new labels, `+
    `just a clean version to branch off from? ${name} itself is not modified.`))return;
  post("/api/dataset/clone",{base:name}).then(d=>{
    if(!d.ok){alert(d.error);return;}
    alert(`Created ${d.dataset} (${d.images} images, cloned from ${d.base}).`);
    loadDataset();
  });
}
function deleteDataset(name,isLatest){
  const warn=isLatest?`\n\nThis is currently the LATEST version - after deleting, whichever `+
    `version is next-highest becomes the new default for adding labels.`:"";
  const typed=prompt(`This permanently deletes ${name}. Its images are just links to files `+
    `kept elsewhere (those are untouched), but ${name}'s own label corrections and its place `+
    `in the history are gone for good - this cannot be undone.${warn}\n\n`+
    `Type "${name}" to confirm:`);
  if(typed===null)return;
  if(typed!==name){alert("Name didn't match - nothing deleted.");return;}
  post("/api/dataset/delete",{name}).then(d=>{
    if(!d.ok){alert(d.error);return;}
    if(SELECTED_DS===name)SELECTED_DS=null;
    loadDataset();
  });
}

/* ---------- GPU model status (header pill + panel) ---------- */
const GPUCTX=[["live","live-watch (step 2)"],["scan","scan (step 1)"],["auto","capture for correction"]];
let GPUOPEN=false, GPULAST=null;
function gpuTogglePanel(){GPUOPEN=!GPUOPEN;el("gpuPanel").style.display=GPUOPEN?"block":"none";if(GPUOPEN)gpuPoll();}
let GPUTIMER=null;
function gpuPoll(){
  if(GPUTIMER){clearTimeout(GPUTIMER);GPUTIMER=null;}
  get("/api/gpu/status").then(s=>{
    if(GPUOPEN) GPUTIMER=setTimeout(gpuPoll,4000);
    GPULAST=s;
    const nLoaded=new Set([...s.live,...s.auto,...s.scan]).size;
    el("gpuPill").textContent=`GPU: ${nLoaded?nLoaded+" model(s) loaded, ":"nothing loaded, "}${s.gpu_mb} MB`;
    if(GPUOPEN) gpuDraw(s);
  });
}
function gpuDraw(s){
  el("gpuRows").innerHTML=GPUCTX.map(([ctx,label])=>{
    const loaded=s[ctx]||[];
    const notLoaded=s.models.filter(m=>!loaded.includes(m));
    return `<div class=row style="margin-bottom:8px;align-items:center">
      <span style="width:190px;color:var(--dim);font-size:12.5px">${label}</span>
      ${loaded.length?loaded.map(m=>`<span class=pill>${m}
        <button class=dan style="padding:2px 7px;margin-left:5px;font-size:11px"
          onclick="gpuUnload('${ctx}','${m}')">unload</button></span>`).join(" ")
        :`<span class="pill" style="color:var(--dim)">not loaded</span>`}
      ${notLoaded.length?`<select id="gpuSel_${ctx}" style="margin-left:8px">
          ${notLoaded.map(m=>`<option value="${m}">${m}</option>`).join("")}
        </select>
        <button class=pri style="padding:5px 10px" onclick="gpuLoad('${ctx}')">load</button>`:""}
    </div>`;}).join("");
}
function gpuLoad(ctx){
  const sel=el("gpuSel_"+ctx); if(!sel)return;
  const model=sel.value, btn=event.target, t=btn.textContent;
  btn.textContent="loading..."; btn.disabled=true;
  post("/api/gpu/load",{context:ctx,model}).then(d=>{
    btn.disabled=false; btn.textContent=t;
    if(!d.ok) alert("could not load: "+(d.error||"unknown error"));
    gpuPoll();
  });
}
function gpuUnload(ctx,model){
  post("/api/gpu/unload",{context:ctx,model}).then(gpuPoll);
}
// GPU status is refreshed on events (load/unload, start/stop, tab switch) and every 4 s ONLY while the panel is open.


/* ---------- 7 datasets: every dataset on disk, which model trained on it, labelled-frame scroller ---------- */
let DSFROM="", DSTO="", DSQUICK="", DSSORT="version";
let DSCAT=[], DSKIND="all", DSSEL=null, DSSPLIT=null, DSPAGE=0, DSPAGES=1, DSLOADING=false, DSOBS=null, DSW=440;
const SHORTN={red_sack:"red",green_sack:"green",blue_sack:"blue",other_sack_yellow:"yellow",
              other_sack_white:"white",other_sack_red_grey:"red_grey"};
const CLSID={red_sack:0,green_sack:1,blue_sack:2,other_sack_yellow:3,other_sack_white:4,other_sack_red_grey:5};
function loadDatasets(){get("/api/datasets").then(d=>{DSCAT=d.items;drawDatasets();});}
function setDsKind(k){DSKIND=k;drawDatasets();}
function dsPills(pc){return Object.entries(pc||{}).map(([k,v])=>
  `<span class=pill style="padding:1px 7px"><span class=sw style="background:${COLOR[CLSID[k]]}"></span>${SHORTN[k]||k} <b>${v}</b></span>`).join(" ");}
function dsRunPills(runs){
  if(!runs||!runs.length) return `<span style="color:var(--dim)">none</span>`;
  return runs.map(r=>{
    const map=r.best_map50==null?"":` mAP50 <b>${r.best_map50.toFixed(3)}</b>`;
    const bench=r.bench?` &middot; bench MAE <b>${r.bench.mae.toFixed(2)}</b> / ${r.bench.exact.toFixed(0)}%`:"";
    // one name per model: the name this app uses (v21, v22_synth, ...) is the primary label
    // everywhere; the run folder is shown small so it can still be found on disk
    const name=r.platform_model?`<b>${r.platform_model}</b>`:`<b>${r.run}</b>`;
    const folder=r.platform_model?`<span style="font:11px monospace;color:var(--dim)">${r.run}</span>`:"";
    const when=r.trained_at?`<span style="font-size:11px;color:var(--dim)">${r.trained_at.slice(0,10)}</span>`:"";
    return `<div class=row style="gap:6px;margin:2px 0"><span class=pill title="base ${r.base}, ${r.epochs} epoch(s), run folder runs/${r.run}">${name} &middot; ${r.epochs} ep${map}${bench}</span>${folder}${when}</div>`;
  }).join("");
}
function dsDay(off){const d=new Date(); d.setDate(d.getDate()+off); return d.toISOString().slice(0,10);}
function dsSetQuick(q){DSQUICK=q; if(q==="today"){DSFROM=dsDay(0);DSTO="";} else if(q==="7d"){DSFROM=dsDay(-7);DSTO="";} else if(q==="30d"){DSFROM=dsDay(-30);DSTO="";} else {DSFROM="";DSTO="";}
  el("dsFrom").value=DSFROM; el("dsTo").value=DSTO; drawDatasets();}
function dsDateChange(){DSQUICK=""; DSFROM=el("dsFrom").value; DSTO=el("dsTo").value; drawDatasets();}
function dsDateClear(){dsSetQuick("");}
function dsSetSort(s){DSSORT=s; drawDatasets();}
function drawDatasets(){
  el("dsQuick").innerHTML=[["","any time"],["today","today"],["7d","last 7 days"],["30d","last 30 days"]]
    .map(([q,l])=>`<button class="${DSQUICK===q&&!(q===""&&(DSFROM||DSTO))?'on':''}" style="padding:5px 10px" onclick="dsSetQuick('${q}')">${l}</button>`).join(" ");
  el("dsSort").innerHTML=[["version","version"],["date","newest first"]]
    .map(([k,l])=>`<button class="${DSSORT===k?'on':''}" style="padding:5px 10px" onclick="dsSetSort('${k}')">${l}</button>`).join(" ");
  let pool=DSCAT.filter(x=>DSKIND==="all"||x.kind===DSKIND);
  // date filter on the set's last-modified day (a real version's date is its last commit into it)
  if(DSFROM) pool=pool.filter(x=>x.modified.slice(0,10)>=DSFROM);
  if(DSTO)   pool=pool.filter(x=>x.modified.slice(0,10)<=DSTO);
  if(DSSORT==="date") pool=[...pool].sort((a,b)=>b.modified.localeCompare(a.modified));
  const nReal=DSCAT.filter(x=>x.kind==="real").length, nSyn=DSCAT.filter(x=>x.kind==="synthetic").length;
  el("dsKindFilters").innerHTML=[["all",`all (${DSCAT.length})`],["real",`real (${nReal})`],["synthetic",`synthetic (${nSyn})`]]
    .map(([k,l])=>`<button class="${DSKIND===k?'on':''}" onclick="setDsKind('${k}')">${l}</button>`).join(" ");
  const trained=new Set(DSCAT.flatMap(x=>x.runs.map(r=>r.run)));
  el("dsCatSumm").textContent=`${pool.length} of ${DSCAT.length} shown · ${trained.size} training run(s) mapped`;
  el("dsCatTbl").innerHTML=`<tr><th>dataset</th><th>kind</th><th class=num>train</th><th class=num>val</th>
      <th>labelled sacks (train)</th><th>trained on it</th><th>notes</th></tr>`+pool.map(x=>{
    const tr=x.stats.train||x.stats.all||{}, va=x.stats.val||{};
    const val=x.val_from?`<span class=pill title="this set has no val split; runs on it were scored on ${x.val_from}/val">scored on ${x.val_from}</span>`:(va.images||"&mdash;");
    const sel=DSSEL===x.name?"background:#1d2530":"";
    return `<tr style="cursor:pointer;${sel}" onclick="dsOpen('${x.name}')">
      <td><b>${x.name}</b><div style="font-size:11.5px;color:var(--dim)">${x.modified}</div></td>
      <td><span class=pill style="${x.kind==='synthetic'?'color:#ffb86b':''}">${x.kind}</span></td>
      <td class=num>${tr.images||0}${tr.negatives?`<div style="font-size:11px;color:var(--dim)">${tr.negatives} empty</div>`:""}</td>
      <td class=num>${val}</td>
      <td>${dsPills(tr.per_class)}${tr.total?`<div style="font-size:11.5px;color:var(--dim);margin-top:3px">${tr.total} total</div>`:""}</td>
      <td>${dsRunPills(x.runs)}</td>
      <td style="max-width:360px;font-size:12.5px;color:var(--dim)">${x.notes||""}</td></tr>`;}).join("")
    +(pool.length?"":`<tr><td colspan=7 class=empty style="border:0">No dataset matches this filter.</td></tr>`);
}
function dsOpen(name,split){
  const x=DSCAT.find(d=>d.name===name); if(!x)return;
  DSSEL=name; DSSPLIT=(split&&x.splits.includes(split))?split:(x.splits.includes("train")?"train":x.splits[0]);
  DSPAGE=0; DSPAGES=1; DSLOADING=false;
  drawDatasets();
  el("dsPreview").style.display="block";
  el("dsPvName").textContent=name;
  el("dsPvSplits").innerHTML=x.splits.map(s=>`<button class="${DSSPLIT===s?'on':''}" onclick="dsOpen('${name}','${s}')">${s} (${(x.stats[s]||{}).images||0})</button>`).join(" ");
  el("dsPvNotes").textContent=x.notes||"";
  el("dsPvRuns").innerHTML=x.runs.length?"trained on this set: "+dsRunPills(x.runs):"no training run used this set";
  el("dsFrames").innerHTML=""; el("dsSentinel").textContent="loading…"; el("dsSentinel").style.display="block";
  if(!DSOBS){DSOBS=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting))dsMore();},{rootMargin:"600px"});}
  DSOBS.observe(el("dsSentinel"));
  el("dsPreview").scrollIntoView({behavior:"smooth",block:"start"});
  dsMore();
}
function dsClose(){el("dsPreview").style.display="none"; if(DSOBS)DSOBS.unobserve(el("dsSentinel")); DSSEL=null; drawDatasets();}
function dsResize(w){DSW=w; el("dsFrames").style.gridTemplateColumns=`repeat(auto-fill,minmax(${w}px,1fr))`;}
function dsMore(){
  if(DSLOADING||!DSSEL||DSPAGE>=DSPAGES)return;
  DSLOADING=true; const name=DSSEL, split=DSSPLIT, page=DSPAGE;
  get(`/api/datasets/frames?name=${encodeURIComponent(name)}&split=${split}&page=${page}&per=24`).then(d=>{
    if(name!==DSSEL||split!==DSSPLIT){DSLOADING=false;return;}   // user switched while loading
    DSPAGES=d.pages; DSPAGE=page+1; DSLOADING=false;
    el("dsPvCount").textContent=`${d.total} frames · showing ${Math.min(d.total,DSPAGE*d.per)}`;
    const frag=document.createDocumentFragment();
    d.items.forEach((it,i)=>{
      const idx=page*d.per+i;
      const card=document.createElement("div"); card.className="card"; card.style.padding="8px";
      card.innerHTML=`<canvas id="dscv_${idx}" style="width:100%;cursor:zoom-in"></canvas>
        <div class=row style="margin-top:6px;font-size:12px;color:var(--dim)"><span style="font:11px monospace">${it.file}</span>
        <span style="margin-left:auto">${it.labels.length?it.labels.map(l=>`<span class=sw style="background:${COLOR[l.cls]}"></span>`).join(""):"no sacks"}</span></div>`;
      frag.appendChild(card);
      const cv=card.querySelector("canvas");
      cv.onclick=()=>dsBigShow(it);
      dsPaint(cv,it,1.0);
    });
    el("dsFrames").appendChild(frag);
    if(DSPAGE>=DSPAGES){el("dsSentinel").textContent=`all ${d.total} frames shown`;}
  }).catch(()=>{DSLOADING=false;});
}
function dsPaint(cv,it,scale){
  const img=new Image();
  img.onload=()=>{
    const s=Math.min(1,(scale*960)/img.naturalWidth);   // cap the canvas backing size, keep the aspect
    cv.width=Math.round(img.naturalWidth*s); cv.height=Math.round(img.naturalHeight*s);
    const ctx=cv.getContext("2d"); ctx.drawImage(img,0,0,cv.width,cv.height);
    it.labels.forEach(l=>{
      ctx.lineWidth=Math.max(2,Math.round(3*s*1.5)); ctx.strokeStyle=COLOR[l.cls]||"#fff";
      ctx.beginPath();
      l.poly.forEach((p,k)=>{const x=p[0]*cv.width,y=p[1]*cv.height; k?ctx.lineTo(x,y):ctx.moveTo(x,y);});
      ctx.closePath(); ctx.stroke();
      const x=Math.min(...l.poly.map(p=>p[0]))*cv.width, y=Math.min(...l.poly.map(p=>p[1]))*cv.height;
      const lab=SHORTN[(Object.keys(CLSID).find(k=>CLSID[k]===l.cls))]||String(l.cls);
      ctx.font=`bold ${Math.max(11,Math.round(14*s*1.4))}px system-ui`; const w=ctx.measureText(lab).width+10, h=Math.max(15,Math.round(19*s*1.4));
      ctx.fillStyle=ctx.strokeStyle; ctx.fillRect(x,Math.max(0,y-h),w,h);
      ctx.fillStyle="#000"; ctx.fillText(lab,x+5,Math.max(h-5,y-5));
    });
  };
  img.src=it.img;
}
function dsBigShow(it){
  el("dsBig").style.display="block";
  el("dsBigName").textContent=`${DSSEL} / ${DSSPLIT} / ${it.file}`;
  el("dsBigLabs").innerHTML=it.labels.length?it.labels.map(l=>`<span class=pill><span class=sw style="background:${COLOR[l.cls]}"></span>${SHORTN[Object.keys(CLSID).find(k=>CLSID[k]===l.cls)]||l.cls}</span>`).join(" "):`<span class=pill>no sacks</span>`;
  dsPaint(el("dsBigCv"),it,2.0);
}

nav(); modelBtns(); loadSources(); loadDataset(); gpuPoll(); show(TAB);

// start the status polls once the DOM exists (safe whether the script is in <head> or at the end of <body>)
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>{pvPoll();livePoll();}); else {pvPoll();livePoll();}

// After start/stop actions refresh the status once; the pollers then continue only while something runs.
for (const [name, extra] of [["liveStart", livePoll], ["liveStop", livePoll], ["scanStart", null], ["scanStop", null]]) {
  if (typeof window[name] === "function") {
    const orig = window[name];
    window[name] = function () { const r = orig.apply(this, arguments); setTimeout(() => { if (extra) extra(); gpuPoll(); }, 700); return r; };
  }
}


/* ---------- 8 record RTSP ---------- */
// Camera rows are kept in this browser (localStorage) so the links don't have to be retyped.
// They may contain passwords: they stay in this browser and are sent to the server only when recording starts.
let REC_CAMS=null, REC_T=null;
function recSave(){try{localStorage.setItem("recCams",JSON.stringify(REC_CAMS));localStorage.setItem("recFps",el("recFps").value);
  localStorage.setItem("recSize",el("recSize").value);localStorage.setItem("recSizeCustom",el("recSizeCustom").value);}catch(e){}}
function recWidth(){const v=el("recSize").value;return v==="custom"?el("recSizeCustom").value:v;}
function recSetWidth(w){w=(w&&w!=="original")?String(w):"";
  const opt=[...el("recSize").options].some(o=>o.value===w);
  el("recSize").value=opt?w:"custom"; el("recSizeCustom").value=opt?"":w;
  el("recSizeCustom").style.display=el("recSize").value==="custom"?"":"none";}
function recInit(){
  if(REC_CAMS===null){try{REC_CAMS=JSON.parse(localStorage.getItem("recCams")||"null");}catch(e){}
    if(!Array.isArray(REC_CAMS)||!REC_CAMS.length)REC_CAMS=[{name:"cam1",url:""}];
    try{el("recFps").value=localStorage.getItem("recFps")||"";el("recSize").value=localStorage.getItem("recSize")||"";
      el("recSizeCustom").value=localStorage.getItem("recSizeCustom")||"";
      el("recSizeCustom").style.display=el("recSize").value==="custom"?"":"none";}catch(e){}}
  recRender();}
function recEsc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function recRender(){
  el("recCams").innerHTML=REC_CAMS.map((c,i)=>`<div class=row style="margin-bottom:6px">
     <input style="width:160px" placeholder="camera name" value="${recEsc(c.name)}" oninput="REC_CAMS[${i}].name=this.value;recSave()">
     <input style="flex:1;min-width:300px;width:auto" placeholder="rtsp://user:pass@host:554/..." value="${recEsc(c.url)}" oninput="REC_CAMS[${i}].url=this.value;recSave()">
     <button onclick="recDel(${i})" title="remove">&times;</button></div>`).join("");}
function recAdd(){REC_CAMS.push({name:"cam"+(REC_CAMS.length+1),url:""});recSave();recRender();}
function recDel(i){REC_CAMS.splice(i,1);if(!REC_CAMS.length)REC_CAMS=[{name:"cam1",url:""}];recSave();recRender();}
function recStart(){recSave();
  const cams=REC_CAMS.filter(c=>c.url.trim());
  if(!cams.length){alert("Add at least one RTSP link");return;}
  el("recMsg").textContent="starting...";
  if(el("recSize").value==="custom"&&!el("recSizeCustom").value){alert("Type a custom width or choose another frame size");return;}
  post("/api/rec/start",{cams,fps:el("recFps").value,width:recWidth()}).then(r=>{
    el("recMsg").textContent=r.ok?("recording into session "+r.session):("not started: "+r.error);recPoll();});}
function recStop(){el("recMsg").textContent="stopping - finalising files...";
  post("/api/rec/stop",{}).then(r=>{
    el("recMsg").textContent=r.ok?(`stopped - ${r.files.length} file(s) saved in session ${r.session}`):r.error;
    recPoll();recLoadSessions();});}
function recFmtB(b){return b>=1<<30?(b/(1<<30)).toFixed(2)+" GB":b>=1<<20?(b/(1<<20)).toFixed(1)+" MB":(b/1024).toFixed(0)+" KB";}
function recFmtT(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+":":"")+String(m).padStart(2,"0")+":"+String(x).padStart(2,"0");}
function recPoll(){clearTimeout(REC_T);
  get("/api/rec/status").then(s=>{
    el("recPill").innerHTML=s.running?`<b class=bad>&#9679; REC</b> ${recFmtT(s.elapsed_s)} &middot; ${s.cams.length} camera(s) &middot; fps ${s.fps||"original"} &middot; size ${s.width?s.width+" wide":"original"}`
      :(s.ffmpeg?"idle":"<b class=bad>ffmpeg not found on server</b>");
    el("recStartBtn").disabled=s.running; el("recStopBtn").disabled=!s.running;
    el("recLiveCard").style.display=s.running?"block":"none";
    if(s.running)el("recLiveTbl").innerHTML="<tr><th>camera</th><th>state</th><th>parts</th><th>reconnects</th><th class=num>size</th><th>last message</th></tr>"+
      s.cams.map(c=>`<tr><td><b>${recEsc(c.name)}</b><div class=hint style="margin:0;font-family:monospace">${recEsc(c.url)}</div></td>
        <td class="${c.state==="recording"?"ok":c.state==="failed"?"bad":"warn"}">${c.state}</td><td>${c.parts}</td><td>${c.reconnects}</td>
        <td class=num>${recFmtB(c.bytes)}</td><td class=hint style="margin:0;font-size:12px">${recEsc(c.last_log)}</td></tr>`).join("");
    if(s.running&&TAB==="s7")REC_T=setTimeout(recPoll,2000);});}
let REC_SESS=[];
function recLoadSessions(){
  get("/api/rec/sessions").then(L=>{REC_SESS=L;
    el("recSessions").innerHTML=L.length?L.map(x=>`<div class=srcrow style="display:block">
      <div class=row><b>${x.session}</b>${x.active?'<span class="pill bad">recording</span>':""}
        <span class=pill>${x.started||""}${x.stopped?" &rarr; "+x.stopped.slice(11):""}</span>
        <span class=pill>fps ${x.fps||"?"}</span><span class=pill>size ${x.width&&x.width!=="original"?x.width+" wide":"original"}</span><span class=pill>${x.files.length} file(s) &middot; ${recFmtB(x.bytes)}</span>
        ${x.active?"":`<button class=dan style="margin-left:auto;padding:5px 12px" onclick="recDelete('${x.session}')">delete session</button>`}</div>
      <div style="margin-top:6px">${(x.links||[]).map(l=>`<div class=row style="gap:6px;margin-top:3px"><b style="min-width:70px">${recEsc(l.name)}</b>
        <code style="font-size:12px;color:var(--dim);word-break:break-all;user-select:all;flex:1">${recEsc(l.url)}</code></div>`).join("")}
        ${(x.links||[]).length?`<button style="margin-top:6px;padding:4px 10px;font-size:12px" onclick='recReuse(${JSON.stringify(x.session)})'>use these links again</button>`:""}</div>
      ${Object.entries(x.errors||{}).map(([c,e])=>`<div class=bad style="font-size:12.5px;margin-top:6px"><b>${recEsc(c)}</b>: ${recEsc(e)}</div>`).join("")}
      <div style="margin-top:6px">${x.files.map(f=>`<span style="margin-right:18px;white-space:nowrap"><a href="/rec/${x.session}/${f.name}" style="color:var(--accent)">${f.name}</a>
        <span class=hint style="margin:0 4px">${recFmtB(f.bytes)}</span>${x.active?"":`<button style="padding:1px 7px;font-size:12px" title="delete this file" onclick="recDelete('${x.session}','${f.name}')">&times;</button>`}</span>`).join("")}</div></div>`).join("")
      :'<div class=empty>No recordings yet.</div>';});}

function recDelete(session,file){
  if(!confirm(file?`Delete ${file} from session ${session}?\nThis cannot be undone.`:`Delete the whole session ${session} and all its videos?\nThis cannot be undone.`))return;
  post("/api/rec/delete",{session,file}).then(r=>{if(!r.ok)alert(r.error);recLoadSessions();});}

function recReuse(sid){const x=REC_SESS.find(z=>z.session===sid); if(!x)return;
  if(x.links.some(l=>l.url.includes("***@"))&&!confirm("This older session only has masked links (password shown as ***). Load them anyway and type the password in?"))return;
  REC_CAMS=x.links.map(l=>({name:l.name,url:l.url})); el("recFps").value=(x.fps&&x.fps!=="original")?x.fps:""; recSetWidth(x.width); recSave(); recRender(); window.scrollTo(0,0);}
