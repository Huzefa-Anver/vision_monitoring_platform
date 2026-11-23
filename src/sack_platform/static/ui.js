/* tab 7 raw media + tab 12 address (declared first: show() can run during load) */
let RSAUTH={set:false,user:"",pass:"",public_host:"",public_port:8554},DSTAB="lab",RSADDR="rtsp://"+location.hostname+":8554/",RS_PEND=null,RV=[],RVF="all",RF=[],RFG="all",RFSEL=[],MVT=null;
try{DSTAB=localStorage.getItem("dsTab")||"lab";}catch(e){}
const CLS=[[2,"blue_sack","blue","#0a8cff"],[3,"other_sack_yellow","yellow","#ffd700"],
           [4,"other_sack_white","white","#f0f0f0"],[0,"red_sack","red_sack","#dc3c3c"],
           [1,"green_sack","green","#3cc83c"],[5,"other_sack_red_grey","red_grey","#be9696"]];
const COLOR={0:"#dc3c3c",1:"#3cc83c",2:"#0a8cff",3:"#ffd700",4:"#f0f0f0",5:"#be9696",6:"#ff00ff"};
const TABS=[["s1","1","Find recordings"],["s2","2","Watch & capture"],
            ["s3","3","Correct"],["s3r","4","Review later"],
            ["s4","5","Review & add"],["s5","6","History"],["s6","7","Datasets"],["s7","8","Record RTSP"],
            ["s8","9","Eval events"],["s9","10","Benchmark"],["s10","11","NVR recordings"],["s11","12","Serve RTSP"]];
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
function show(id){TAB=id;try{localStorage.setItem("tab",id);}catch(e){} nav();
  // close video streams of tabs that are not visible (they never end on their own and keep the page "loading")
  if(id!=="s1"){const im=el("pvImg"); if(im) im.removeAttribute("src");}
  if(id!=="s2"){const im=el("liveImg"); if(im) im.removeAttribute("src");}
  if(id==="s1"){loadSources();pvPoll();} if(id==="s2")livePoll(); if(id==="s3")loadQueue(); if(id==="s4"){loadReview();loadDataset();}
  if(id==="s3r")loadReviewLater();
  if(id==="s5")loadHistory();
  if(id==="s6"){loadDatasets();dsTab(DSTAB);}
  if(id==="s7"){recInit();recPoll();recLoadSessions();}
  if(id==="s8")evalLoad();
  if(id==="s9")benchLoad();
  if(id==="s10")avInit();
  if(id==="s11")rsInit(); else clearTimeout(RST);}

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
  el("scanModelSel").innerHTML=["v30A","v21","v20","v28_synth_blue","v26_composite_blue","v25_blue_composite","v24_blue_synth","v22_synth","v20_synth","v18","v13","v11_neg119","v10_NONEG"].map(m=>
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
    const im=el("pvImg");   // open the endless preview stream only while something plays
    if(im){ if(p.run&&!im.getAttribute("src")) im.src="/preview?t="+Date.now();
            else if(!p.run&&im.getAttribute("src")) im.removeAttribute("src"); }
    if(p.run) PVTIMER=setTimeout(pvPoll,900);  // idle/stopped -> no further requests
  });
}

/* ---------- 2 capture ---------- */
function modelBtns(){el("modelBtns").innerHTML=["v30A","v21","v20","v28_synth_blue","v26_composite_blue","v25_blue_composite","v24_blue_synth","v22_synth","v20_synth","v18","v13","v11_neg119","v10_NONEG"].map(m=>
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
  if(s.run && TAB==="s2"){ if(im && !im.getAttribute("src")) liveImgReconnect(); }
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
      <td><b>${x.name}</b><div style="font-size:11.5px;color:var(--dim)">${x.modified}</div>${dsUpPill(x)}
        <button style="padding:1px 8px;font-size:12px;margin-top:4px" title="make a video from this dataset's images, to serve as RTSP" onclick="event.stopPropagation();dsToRtsp('${x.name}')">&#9654; make RTSP video</button></td>
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
      <div style="margin-top:6px">${x.files.map(f=>`<span style="margin-right:18px;white-space:nowrap"><a href="/rec/${x.session}/${f.name}" style="color:var(--accent)">${f.name}</a>${recSrcIcon(recSrc(x,f.name))}${f.name.endsWith(".mp4")?` <button style="padding:1px 8px;font-size:12px" title="watch here without downloading" onclick="rpOpen('${x.session}','${f.name}')">&#9654; play</button>`:""}
        <span class=hint style="margin:0 4px">${recFmtB(f.bytes)}</span>${x.active||!f.name.endsWith(".mp4")?"":`<button style="padding:1px 7px;font-size:12px" title="rename this video (the new name shows everywhere, also in Serve RTSP)" onclick="recRename('${x.session}','${f.name}')">&#9998; rename</button> `}${x.active?"":`<button style="padding:1px 7px;font-size:12px" title="delete this file" onclick="recDelete('${x.session}','${f.name}')">&times;</button>`}</span>`).join("")}</div></div>`).join("")
      :'<div class=empty>No recordings yet.</div>';});}

function recDelete(session,file){
  if(!confirm(file?`Delete ${file} from session ${session}?\nThis cannot be undone.`:`Delete the whole session ${session} and all its videos?\nThis cannot be undone.`))return;
  post("/api/rec/delete",{session,file}).then(r=>{if(!r.ok)alert(r.error);recLoadSessions();});}

function recSrc(x,file){const l=(x.links||[]).find(l=>(l.files||[]).includes(file))||(x.links||[]).find(l=>file.startsWith(l.name+"_part"));return l?l.url:"";}
function recSrcIcon(u){return u?` <span title="recorded from:\n${recEsc(u)}" style="cursor:help;display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;background:var(--line);color:var(--ink);font-size:11px;font-weight:700">i</span>`:"";}
function recRename(session,file,nw,force){
  if(nw===undefined){nw=prompt(`New name for ${file} (session ${session}).\nLetters, digits, _ and - only; .mp4 is added.`,file.replace(/\.mp4$/,""));if(nw===null)return;nw=nw.trim();}
  post("/api/rec/rename",{session,file,new:nw,force:!!force}).then(r=>{
    if(r.confirm){if(confirm(r.confirm))recRename(session,file,nw,true);return;}
    if(!r.ok){alert(r.error||"rename failed");return;}
    const st=r.streams||{};if(st.changed&&st.changed.length)alert(`Renamed to ${r.new}.\nServe RTSP stream(s) ${st.changed.join(", ")} now use the new name`+(st.applied===false?` but could not be applied yet:\n${(st.errors||[]).join("\n")}`:"."));
    recLoadSessions();if(typeof RSV!=="undefined"&&RSV.length)rsVideos(true);});}

function recReuse(sid){const x=REC_SESS.find(z=>z.session===sid); if(!x)return;
  if(x.links.some(l=>l.url.includes("***@"))&&!confirm("This older session only has masked links (password shown as ***). Load them anyway and type the password in?"))return;
  REC_CAMS=x.links.map(l=>({name:l.name,url:l.url})); el("recFps").value=(x.fps&&x.fps!=="original")?x.fps:""; recSetWidth(x.width); recSave(); recRender(); window.scrollTo(0,0);}


/* ---------- 9 eval events (read-only list of verified eval events) ---------- */
function evalEsc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function evalCopy(btn,txt){navigator.clipboard?.writeText(txt).then(()=>{btn.textContent="copied";setTimeout(()=>btn.textContent="copy link",1500);},
  ()=>prompt("Copy this link:",txt));}
let EVAL_V21=true, EVAL_SESS=[], EVAL_CF="real", PANELS={};
const ERR_LBL={not_detected:"sack(s) not detected",merged:"several sacks merged into one outline",double_count:"one sack detected twice (counted as 2)",duplicate:"duplicate / split outlines on one sack",
  wrong_class:"wrong class (seam colour)",fp_person:"false positive on a person (body, arm, clothing)",fp_background:"false positive on background (stock, floor, logo/text)",
  bad_outline:"outline badly shaped (part of sack / spills over)",low_confidence:"sack detected but very low confidence",other:"other (see note)"};
const SIT_LBL={multi_sack:"multi-sack stack",single_sack:"single sack",bright_doorway:"bright doorway",partly_hidden:"partly hidden",frame_edge:"frame edge",
  overlapping_carriers:"two carriers overlapping",far_small:"far / small",coloured_clothing:"coloured clothing next to the sack"};
function guessErrors(t){t=(t||"").toLowerCase();const g=new Set();
  if(/not detected|missing|miss\b|missed|only \d outline|one outline|weak .*outline \(miss/.test(t))g.add("not_detected");
  if(/merged|one outline over|drawn as one/.test(t))g.add("merged");
  if(/duplicate|tangled|overlapping|outlines on a|split/.test(t))g.add("duplicate");
  if(/count (\d+) > (\d+)|outlines on (\d+) sacks|on a ~?\d-stack|counted as 2|detected twice/.test(t))g.add("double_count");
  if(/wrong label|wrong class|class /.test(t)&&/class/.test(t))g.add("wrong_class");
  if(/body|arm|person|child|clothing/.test(t)&&/false positive|outline .* on the|extra/.test(t))g.add("fp_person");
  if(/logo|stored pile|stock|background|floor/.test(t)&&/false positive|outline/.test(t))g.add("fp_background");
  if(/only part|covers only|badly|wrong-shaped/.test(t))g.add("bad_outline");
  if(/low confidence|weak 0\.[0-3]/.test(t))g.add("low_confidence");
  return g;}
function guessSits(t,tags){t=(t||"").toLowerCase();const g=new Set();(tags||[]).forEach(x=>{if(x==="multi_sack")g.add("multi_sack");if(x==="single_sack")g.add("single_sack");});
  if(/stack|sacks/.test(t))g.add("multi_sack"); if(/single|shoulder carry/.test(t)&&!/stack/.test(t))g.add("single_sack");
  if(/doorway|backlit|bright/.test(t))g.add("bright_doorway"); if(/behind|hidden|pillar/.test(t))g.add("partly_hidden");
  if(/edge/.test(t))g.add("frame_edge"); if(/two carriers|overlapping carriers|child behind/.test(t))g.add("overlapping_carriers");
  if(/far|small/.test(t))g.add("far_small"); if(/red shirt|red-shirt|clothing/.test(t))g.add("coloured_clothing"); return g;}
function bPanel(uid,info){PANELS[uid]=info;const ge=guessErrors(info.text),gs=guessSits(info.text,info.tags);
  return `<div id="bp_${uid}" style="display:none;border:1px dashed #888;border-radius:6px;padding:8px;margin-top:8px">
    <b>What is wrong with v21?</b> <span class=hint style="margin:0">(pre-ticked from the rules and my check &mdash; please confirm)</span>
    <div style="columns:2;margin:4px 0">${Object.entries(ERR_LBL).map(([k,l])=>`<label style="display:block;margin:2px 0"><input type=checkbox name=err value=${k} ${ge.has(k)?"checked":""}> ${l}</label>`).join("")}</div>
    <b>Situation</b>
    <div style="columns:2;margin:4px 0">${Object.entries(SIT_LBL).map(([k,l])=>`<label style="display:block;margin:2px 0"><input type=checkbox name=sit value=${k} ${gs.has(k)?"checked":""}> ${l}</label>`).join("")}</div>
    <div class=row><label style="margin:0">sacks really there</label><input name=tc type=number min=0 max=20 style="width:70px">
      <span class=hint style="margin:0">v21 drew ${info.v21n??"?"}</span></div>
    <input name=note placeholder="note (optional)" style="width:100%;margin-top:6px">
    <div class=row style="margin-top:6px"><button class=pri onclick="submitB('${uid}')">save as B (needs labels)</button>
      <button onclick="document.getElementById('bp_${uid}').style.display='none'">cancel</button></div></div>`;}
function openB(uid){const d=document.getElementById("bp_"+uid); d.style.display=d.style.display==="none"?"":"none";}
function submitB(uid){const d=document.getElementById("bp_"+uid),inf=PANELS[uid];
  const review={errors:[...d.querySelectorAll("input[name=err]:checked")].map(x=>x.value),situations:[...d.querySelectorAll("input[name=sit]:checked")].map(x=>x.value),
    true_count:d.querySelector("input[name=tc]").value,note:d.querySelector("input[name=note]").value};
  if(!review.errors.length)return alert("Tick at least one 'what is wrong' box.");
  if(inf.kind==="cand")evalDecide(inf.key,inf.id,"accept","B",review); else evalApprove(inf.key,inf.file,"accept","B",review);}
function bStatus(t,rv){if(t==="A")return `<span class=pill style="background:#1d5a2e">A &middot; v21 correct &rarr; labelled</span>`;
  if(t==="B")return `<span class=pill style="background:#6a4a00">B &middot; needs labels</span> <span class=hint style="margin:0">${((rv||{}).errors||[]).map(e=>ERR_LBL[e]||e).join(", ")}${(rv||{}).true_count!=null?` &middot; really ${rv.true_count} sacks`:""}</span>`;return "";}
function evalFilt(v){EVAL_CF=v;evalRenderCands();}
function evalApprove(key,file,decision,type,review){post("/api/eval/approve_frame",{key,file,decision,type,review}).then(r=>{if(!r.ok)return alert(r.error);evalLoad();});}
function evalFinish(key){if(!confirm("Delete this session's recorder clip? Accepted frames are already saved; undecided or rejected frames can no longer be cut afterwards."))return;
  post("/api/eval/finish",{key}).then(r=>{if(!r.ok)return alert(r.error);alert(`clip deleted, ${r.freed_mb} MB freed`);evalLoad();});}
function evalSources(){get("/api/eval/sources").then(d=>{const rs=d.sources||[];
  el("evalSources").innerHTML=rs.length?`<table><tr><th>source</th><th>channel</th><th>screen time</th><th>contains</th><th>approved frames</th><th>RTSP playback link</th></tr>`+
   rs.map(r=>`<tr><td>${evalEsc(r.id)}</td><td>${r.channel??""}</td><td>${evalEsc(r.window)}</td><td>${evalEsc(r.contains)}</td><td>${r.approved_frames}</td>
     <td><code style="word-break:break-all;font-size:11px">${evalEsc(r.rtsp)}</code> <button onclick='evalCopy(this,${JSON.stringify(r.rtsp||"")})'>copy link</button></td></tr>`).join("")+`</table>`
   :`<div class=empty>none yet</div>`;});}
function evalToggleV21(cb){EVAL_V21=cb.checked;evalLoad();}
function evalDecide(key,id,decision,type,review){post("/api/eval/decide",{key,id,decision,type,review}).then(r=>{if(!r.ok)return alert(r.error);
  const s=EVAL_SESS.find(x=>x.key===key); if(s)s.decisions=r.decisions; evalRenderCands();});}
function evalRenderCands(){
  el("evalCands").innerHTML=EVAL_SESS.length?EVAL_SESS.map(s=>{
    const base=`/evalsess/${s.key}/`, dec=s.decisions||{};
    const nAcc=Object.values(dec).filter(x=>x.decision==="accept").length, nRej=Object.values(dec).filter(x=>x.decision==="reject").length;
    const VC={real:"#3cc83c",borderline:"#ffd700",skip:"#888",control:"#0a8cff"};
    const cnt=v=>(s.candidates||[]).filter(c=>c.claude_verdict===v).length;
    const filt=`<div class=row style="margin-top:8px">show: ${["real","borderline","control","skip","all"].map(v=>
      `<button class="${EVAL_CF===v?'pri':''}" onclick="evalFilt('${v}')">${v}${v==="all"?"":` (${cnt(v)})`}</button>`).join("")}</div>`;
    const cards=(s.candidates||[]).filter(c=>EVAL_CF==="all"||c.claude_verdict===EVAL_CF).map(c=>{const st=(dec[c.id]||{}).decision, uid=("c_"+s.session+"_"+c.id).replace(/[^a-zA-Z0-9_]/g,"_");
      const border=st==="accept"?"2px solid #3cc83c":st==="reject"?"2px solid #dc3c3c":"1px solid #444";
      const dets=(c.dets||[]).filter(x=>!x.static).map(x=>`${x.cls} ${x.conf.toFixed(2)}`).join(", ")||"none";
      return `<div style="border:${border};border-radius:6px;padding:8px">
        <div class=row><b>${c.id}</b><span class=pill>${c.kind}</span><span class=hint style="margin:0">${evalEsc(c.screen_time)} &middot; track ${c.track}</span></div>
        <a href="${base}${c.full}" target=_blank title="full frame with v21 outlines"><img loading=lazy src="${base}${c.crop}" style="width:100%;border-radius:4px;margin-top:6px"></a>
        <div class=hint style="margin:4px 0">left: frame &middot; right: v21 prediction (grey = stored stock)</div>
        ${c.claude_verdict?`<div style="margin:4px 0"><span class=pill style="background:${VC[c.claude_verdict]||'#444'};color:#000">my check: ${c.claude_verdict}</span>
          ${evalEsc(c.claude_note||"")}</div>`:""}
        <div class=hint style="margin:2px 0">rules fired:</div>
        <ul style="margin:0 0 6px 18px;padding:0">${(c.reasons||[]).map(r=>`<li class=hint style="margin:0">${evalEsc(r)}</li>`).join("")}</ul>
        <div class=hint style="margin:0 0 6px">v21 on moving sacks: ${evalEsc(dets)}${c.summary?` &middot; carrier: ${c.summary.count_clear_max} sacks seen clearly, ${evalEsc(c.summary.majority_class)}`:""}</div>
        ${st==="accept"?`<div class=row>${bStatus(dec[c.id].type,dec[c.id].review)}<button onclick="evalDecide('${s.key}','${c.id}','clear')">undo</button></div>`
         :st==="reject"?`<div class=row><span class=pill style="background:#5a1d1d">rejected</span><button onclick="evalDecide('${s.key}','${c.id}','clear')">undo</button></div>`
         :`<div class=row><button class=pri onclick="evalDecide('${s.key}','${c.id}','accept','A')">accept A: v21 correct &rarr; label</button>
            <button style="background:#6a4a00" onclick="openB('${uid}')">accept B: v21 wrong &rarr; needs labels</button>
            <button class=dan onclick="evalDecide('${s.key}','${c.id}','reject')">reject</button></div>
            ${bPanel(uid,{kind:"cand",key:s.key,id:c.id,text:(c.claude_note||"")+" "+(c.reasons||[]).join(" "),tags:s.tags,v21n:(c.dets||[]).filter(x=>!x.static&&x.conf>=0.25).length})}`}</div>`;}).join("");
    return `<div class=card><div class=row><h2 style="margin:0">Candidates &middot; ${evalEsc(s.session)}</h2>
        <span class=pill>${(s.candidates||[]).length} candidates &middot; ${nAcc} accepted &middot; ${nRej} rejected</span></div>
      <div class=hint>Clip ${evalEsc(s.clip)} &middot; starts ${evalEsc(s.clip_start)} (screen time) &middot; scanned at ${s.fps} fps &middot;
      ${s.frames} frames &middot; ${s.tracks} carrier tracks. Rules only nominate frames &mdash; you decide.
      Accepting cuts the native frame from the clip into the benchmark.</div>
      <div class=row style="margin-top:6px">${s.clip_deleted?`<span class=pill>clip deleted</span>`
        :`<button class=dan onclick='evalFinish(${JSON.stringify(s.key)})'>finish session (delete the recorder clip)</button>`}</div>
      ${s.contains?`<div style="margin-top:6px"><b>contains:</b> ${evalEsc(s.contains)}</div>`:""}${filt}
      <div class=grid style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr));margin-top:10px">${cards}</div></div>`;}).join("")
    :`<div class=card><div class=empty>No scanned sessions yet.</div></div>`;}
let BENCH_APPROVED={};
function evalLoad(){
  get("/api/bench/results").then(d=>{BENCH_APPROVED={};(d.frames||[]).forEach(f=>BENCH_APPROVED[f.id]=f);});
  evalSources();
  get("/api/eval/sessions").then(d=>{EVAL_SESS=d.sessions||[];evalRenderCands();});
  get("/api/eval/events").then(d=>{
    const evs=d.events||[], res=(d.reserved&&d.reserved.entries)||[];
    el("evalReserved").innerHTML=res.length?`<table><tr><th>source</th><th>date</th><th>reserved</th><th>events</th></tr>`+
      res.map(r=>`<tr><td>${evalEsc(r.source)}</td><td>${evalEsc(r.date)}</td><td>${evalEsc(r.reserved)}</td><td>${evalEsc((r.events||[]).join(", "))}</td></tr>`).join("")+`</table>`
      :`<div class=empty>No reserved dates yet.</div>`;
    el("evalCount").textContent=`${evs.length} event${evs.length===1?"":"s"}, ${evs.reduce((a,e)=>a+(e.frames||[]).length,0)} frames`;
    el("evalList").innerHTML=evs.length?evs.map(e=>{
      const base=`/evalfile/${e.key}/`;
      const fr=(e.frames||[]).map((f,fi)=>{const v21=EVAL_V21&&f.preview_v21, uid=("e_"+e.id+"_"+fi);
        const pv=(f.v21||[]).map(x=>`${x.cls} ${x.conf.toFixed(2)}`).join(", ")||"no detection";
        return `<figure style="margin:0"><a href="${base}${f.file}" target=_blank title="open full resolution (no overlay)">
          <img loading=lazy src="${base}${v21?f.preview_v21:(f.preview||f.file)}" style="width:100%;border-radius:4px"></a>
          <figcaption class=hint style="margin:2px 0 0">${evalEsc((f.screen_time||"").slice(11,19))} &middot; ${evalEsc(f.note)}
          ${EVAL_V21?`<br>v21: ${evalEsc(pv)}`:""}</figcaption>
          <div class=row style="margin-top:4px">${f.benchmark?`${bStatus(f.benchmark,(BENCH_APPROVED[e.id+"__"+f.file.split("/").pop().replace(/\.png$/,"")]||{}).review)}
            <button onclick='evalApprove(${JSON.stringify(e.key)},${JSON.stringify(f.file)},"reject")'>remove</button>`
            :`<button class=pri onclick='evalApprove(${JSON.stringify(e.key)},${JSON.stringify(f.file)},"accept","A")'>A: v21 correct</button>
              <button style="background:#6a4a00" onclick="openB('${uid}')">B: v21 wrong</button>`}</div>
          ${f.benchmark?"":bPanel(uid,{kind:"event",key:e.key,file:f.file,text:(f.note||"")+" "+(e.v21_issue||""),tags:e.tags,v21n:(f.v21||[]).filter(x=>x.conf>=0.25).length})}</figure>`;}).join("");
      return `<div class=card>
        <div class=row><h2 style="margin:0">${evalEsc(e.id)} &middot; ch${e.channel} &middot; ${evalEsc(e.screen_start)} &rarr; ${evalEsc((e.screen_end||"").slice(11))}</h2>
          <span class=pill>${evalEsc(e.labels_status||"")}</span></div>
        ${e.contains?`<div style="margin:6px 0"><b>contains:</b> ${evalEsc(e.contains)}</div>`:""}
        <div class=hint style="margin:6px 0">${evalEsc(e.description)}</div>
        <table>
          <tr><td>classes</td><td>${evalEsc((e.classes||[]).join(", "))}</td></tr>
          <tr><td>tags</td><td>${evalEsc((e.tags||[]).join(", "))}</td></tr>
          <tr><td>v21 problem</td><td>${evalEsc(e.v21_issue)}</td></tr>
          <tr><td>screen time</td><td>${evalEsc(e.screen_start)} &rarr; ${evalEsc(e.screen_end)} (recorder clock)</td></tr>
          <tr><td>real PKT</td><td>${evalEsc(e.real_pkt_start)} &rarr; ${evalEsc(e.real_pkt_end)}</td></tr>
          <tr><td>RTSP playback</td><td><code style="word-break:break-all">${evalEsc(e.rtsp)}</code>
              <button style="margin-left:8px" onclick='evalCopy(this,${JSON.stringify(e.rtsp||"")})'>copy link</button></td></tr>
          <tr><td>verified</td><td>${evalEsc(e.verified_by_user)} &middot; set ${evalEsc(e.set)}</td></tr>
        </table>
        ${e.preview_clip?`<video src="${base}${e.preview_clip}" controls preload=metadata style="width:100%;max-width:900px;margin-top:10px;border-radius:4px"></video>
          <div class=hint>Preview clip (H.264, 1280 wide). ${e.clip_deleted?"Original recorder clip deleted after the frames were saved (sha256 kept in event.json).":`Original recorder clip: <a href="${base}${e.clip}" download>${evalEsc(e.clip)}</a> (HEVC, 3200&times;1800).`}</div>`:""}
        <div class=grid style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));margin-top:10px">${fr}</div>
      </div>`;}).join(""):`<div class=card><div class=empty>No eval events yet.</div></div>`;
  });}

/* ---------- 10 benchmark: run models on approved frames, score against labels ---------- */
let BENCH=null, BENCH_T=null, BENCH_SEL=null;
function benchPct(x){return x==null?"&ndash;":(100*x).toFixed(1)+"%";}
function benchLoad(){get("/api/bench/results").then(d=>{BENCH=d;
  if(!el("benchModel").options.length) el("benchModel").innerHTML=d.models.map(m=>`<option ${m==="v21"?"selected":""}>${m}</option>`).join("");
  const fr=d.frames||[], c=d.counts||{};
  el("benchFrames").textContent=`${fr.length} approved frames: ${c.A||0} type A (labelled) · ${c.B||0} type B (needs labels)`;
  const be=Object.entries(d.b_errors||{}).sort((x,y)=>y[1]-x[1]);
  el("benchBErr").innerHTML=be.length?`<table><tr><th>what v21 got wrong (type B frames)</th><th>frames</th></tr>`+be.map(([k,n])=>`<tr><td>${ERR_LBL[k]||k}</td><td>${n}</td></tr>`).join("")+`</table>`
    :`<div class=empty>No type B frames yet.</div>`;
  const runs=d.runs||[];
  el("benchTable").innerHTML=runs.length?`<table><tr><th>model</th><th>conf</th><th colspan=7 style="text-align:center;border-bottom:1px solid #555">A &middot; labelled frames (scored)</th>
    <th colspan=4 style="text-align:center;border-bottom:1px solid #555">B &middot; needs labels (your review)</th><th>run at</th><th></th></tr>
    <tr><th></th><th></th><th>frames</th><th>sacks</th><th>found</th><th>recall</th><th>class ok</th><th>false alarms</th><th>precision</th>
    <th>fixed</th><th>partly</th><th>not fixed</th><th>unreviewed</th><th></th><th></th></tr>`+runs.map(r=>{const s=r.summary,b=r.b||{};
    return `<tr><td><b>${evalEsc(s.model)}</b></td><td>${s.conf}</td><td>${s.labelled_frames}</td><td>${s.gt}</td><td>${s.found}</td><td>${benchPct(s.recall)}</td>
      <td>${benchPct(s.class_accuracy)}</td><td>${s.false_alarms}</td><td>${benchPct(s.precision)}</td>
      <td>${b.fixed??0}</td><td>${b.partly??0}</td><td>${b.not_fixed??0}</td><td>${b.unreviewed??0}</td><td>${evalEsc(s.at)}</td>
      <td><button onclick="BENCH_SEL='${r.tag}';benchRenderFrames()">view</button></td></tr>`;}).join("")+`</table>
    <div class=hint>A is labelled from v21's own correct outlines, so v21 scores ~100% there by construction &mdash; A checks that a new model doesn't break
    what works; B (v21's mistakes) is the real test. Never add the two together.</div>`
    :`<div class=empty>No runs yet. Pick a model and press run.</div>`;
  benchRenderFrames();});}
function benchJudge(tag,id,verdict){post("/api/bench/judge",{tag,id,verdict}).then(r=>{if(!r.ok)return alert(r.error);
  const run=(BENCH?.runs||[]).find(x=>x.tag===tag); if(run)run.judgements=r.judgements; benchLoad();});}
function benchRenderFrames(){const r=(BENCH?.runs||[]).find(x=>x.tag===BENCH_SEL); if(!r){el("benchView").innerHTML="";return;}
  const s=r.summary, tags=Object.entries(s.by_tag||{}), J=r.judgements||{};
  const A=r.frames.filter(f=>f.type!=="B"), B=r.frames.filter(f=>f.type==="B");
  const fig=f=>`<a href="/benchfile/${f.overlay}" target=_blank><img loading=lazy src="/benchfile/${f.overlay}" style="width:100%;border-radius:4px"></a>`;
  el("benchView").innerHTML=`<div class=card><h2>${evalEsc(r.tag)} &middot; B frames (v21's mistakes) &mdash; did this model fix them?</h2>
    <div class=grid style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr))">${B.map(f=>{const v=(J[f.id]||{}).verdict,rv=f.review||{};
      return `<figure style="margin:0;border:${v==="fixed"?"2px solid #3cc83c":v==="not_fixed"?"2px solid #dc3c3c":v==="partly"?"2px solid #ffd700":"1px solid #444"};border-radius:6px;padding:6px">${fig(f)}
      <figcaption class=hint>${evalEsc(f.id)} &middot; this model drew ${f.n_pred}${rv.true_count!=null?` &middot; really ${rv.true_count} sacks`:""}<br>
      v21 was wrong: ${(rv.errors||[]).map(e=>ERR_LBL[e]||e).join(", ")}${rv.note?` &middot; ${evalEsc(rv.note)}`:""}</figcaption>
      <div class=row><button onclick="benchJudge('${r.tag}','${f.id}','fixed')">fixed</button><button onclick="benchJudge('${r.tag}','${f.id}','partly')">partly</button>
      <button onclick="benchJudge('${r.tag}','${f.id}','not_fixed')">not fixed</button>${v?`<button onclick="benchJudge('${r.tag}','${f.id}','clear')">clear</button>`:""}</div></figure>`;}).join("")||`<div class=empty>No B frames.</div>`}</div></div>
   <div class=card><h2>${evalEsc(r.tag)} &middot; A frames (labelled, scored)</h2>
    ${tags.length?`<table><tr><th>situation</th><th>labelled sacks</th><th>found</th><th>recall</th><th>class correct</th><th>false alarms</th></tr>`+
      tags.map(([t,b])=>`<tr><td>${evalEsc(SIT_LBL[t]||t)}</td><td>${b.gt}</td><td>${b.found}</td><td>${benchPct(b.gt?b.found/b.gt:null)}</td><td>${b.class_correct}</td><td>${b.false_alarms}</td></tr>`).join("")+`</table>`:""}
    <div class=grid style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr));margin-top:10px">${A.map(f=>`<figure style="margin:0">${fig(f)}
      <figcaption class=hint>${evalEsc(f.id)} &middot; ${f.n_pred} predictions${f.score?` &middot; found ${f.score.found}/${f.score.gt}, class ok ${f.score.class_correct}, false alarms ${f.score.false_alarms}`:" &middot; not labelled"}</figcaption></figure>`).join("")||`<div class=empty>No A frames.</div>`}</div></div>`;}
function benchRun(){post("/api/bench/run",{model:el("benchModel").value,conf:parseFloat(el("benchConf").value)||0.25}).then(r=>{if(!r.ok)return alert(r.error);benchPoll();});}
function benchPoll(){clearTimeout(BENCH_T);get("/api/bench/status").then(s=>{
  el("benchStatus").textContent=s.run?`running ${s.model}: ${s.done}/${s.total}`:(s.err?`error: ${s.err}`:"idle");
  if(s.run&&TAB==="s9")BENCH_T=setTimeout(benchPoll,1500); else benchLoad();});}

/* ---------- start-up: must stay LAST so every let/const above (e.g. REC_CAMS) is initialised ---------- */
{const h=location.hash.slice(1); if(TABS.some(t=>t[0]===h)) TAB=h;}   // e.g. /#s7 opens the Record tab
nav(); modelBtns(); loadSources(); loadDataset(); gpuPoll(); show(TAB);

// start the status polls once the DOM exists (safe whether the script is in <head> or at the end of <body>)
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>{pvPoll();livePoll();}); else {pvPoll();livePoll();}

// ---- 11 Recordings: probe a playback link hour by hour ----
var AVT=null;
function tsLoad(){get("/api/avail/teststreams").then(d=>{el("tsLive").textContent=d.live?"server running":"server not running";
  el("tsList").innerHTML=d.streams.map(t=>`<div style="margin:4px 0">${avSnip(t.url)} <b>${t.length}</b> <span class=hint>${t.note}</span></div>`).join("");});}
function avInit(){
  const d=new Date(),p=n=>String(n).padStart(2,"0"),day=`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  if(!el("avStart").value)el("avStart").value=day+"T00:00"; if(!el("avEnd").value)el("avEnd").value=day+"T23:00";
  avLinks();avPoll();}
var AVVIEW=null;
// one found range as a card, same look as the result rows: thumbnail, time, status, copy box, view link
function avRangeCard(a,b,end,key,img){
  return `<div class=card style="display:flex;gap:12px;align-items:center;padding:8px;margin:6px 0">
    ${img?`<img src="data:image/jpeg;base64,${img}" style="width:240px;border-radius:4px">`:`<div style="width:240px;height:135px;display:flex;align-items:center;justify-content:center;background:var(--line);border-radius:4px;color:var(--dim)">video</div>`}
    <div><div style="font-size:17px"><b>${a===b?a:a+" → "+b}</b></div>
    <div style="color:var(--good);font-weight:600">video available</div>
    <div>${avSnip("&starttime="+avFmt(a)+"&endtime="+avFmt(end))}</div>
    <div style="margin-top:4px"><button style="padding:3px 10px" onclick='avView(this,${JSON.stringify(a)},${JSON.stringify(end)}${key?","+JSON.stringify(key):""})'>view link</button><div class=avFull></div></div>
    <div style="color:var(--dim);font-size:13px">end time = next step after the last hour with video (approximate)</div></div></div>`;}
function avLinks(){get("/api/avail/links").then(d=>{el("avLinks").innerHTML=d.links.length?d.links.map(l=>
  `<div class=card style="padding:8px;margin:0 0 8px 0"><button onclick='avShowSaved(${JSON.stringify(l.key)})'>${l.key.replace(/</g,"&lt;")} <span class=pill>${l.yes} of ${l.n} with video, ${l.first} → ${l.last}</span></button>
   <button style="padding:3px 10px;color:var(--bad)" onclick='avDelete(${JSON.stringify(l.key)})'>delete</button>
   <div style="margin-top:6px">${(l.ranges||[]).length?(l.ranges||[]).map(r=>avRangeCard(r.a,r.b,r.end,l.key,r.img)).join(""):"<span class=hint>No video found at the times checked, so nothing to copy yet.</span>"}</div></div>`).join(""):"<span class=hint>Nothing saved yet.</span>";});}
function avShowSaved(key){post("/api/avail/saved",{key}).then(d=>{AVVIEW=d;avRender({rows:d.rows,total:d.rows.length,run:false,err:"",key:d.key});});}
function avStart(force){post("/api/avail/start",{url:el("avUrl").value,start:el("avStart").value,end:el("avEnd").value,step:+el("avStep").value,recheck:!!force||el("avRecheck").checked})
  .then(r=>{if(!r.ok){el("avStatus").textContent=r.error;return;} el("avStatus").textContent=`checking ${r.total} times`+(r.capped?" (capped at 200)":""); avPoll();});}
// full playback link for one time, built from the link in the box (it holds the password; saved results never do)
function avFullUrl(t){let u=(el("avUrl").value||"").trim()||(AVVIEW&&AVVIEW.key)||"";
  u=u.replace(/([?&])(starttime|endtime)=[^&]*&?/g,"$1").replace(/[?&]$/,"");
  return u?u+(u.includes("?")?"&":"?")+"starttime="+avFmt(t):"";}
function avView(btn,t,end,key){const box=btn.parentElement.querySelector(".avFull");if(box.innerHTML){box.innerHTML="";return;}
  post("/api/avail/fullurl",{key:key||window.__AVKEY,start:t,end:end||null}).then(r=>{box.innerHTML=r.ok?avSnip(r.url):`<div class=hint>${r.error}</div>`;});}
function avRecheckOne(t){const v=t.replace(" ","T");
  post("/api/avail/start",{url:el("avUrl").value,start:v,end:v,step:60,recheck:true}).then(r=>{if(!r.ok){el("avStatus").textContent=r.error;return;}AVVIEW=null;el("avStatus").textContent="rechecking "+t;avPoll();});}
function avDelete(key,t){if(!confirm(t?`Delete the saved result for ${t}?`:`Delete all saved results for\n${key}?`))return;
  post("/api/avail/delete",{key,t:t||null}).then(r=>{if(!r.ok){alert(r.error);return;}avLinks();
    if(t&&AVVIEW)avShowSaved(key);else if(!t&&window.__AVKEY===key){AVVIEW=null;el("avList").innerHTML="";el("avRanges").innerHTML="";}});}
function avStop(){post("/api/avail/stop").then(avPoll);}
function avRanges(rows){const out=[];let cur=null;
  rows.forEach(r=>{if(r.status==="yes"){if(!cur)cur=[r.t,r.t];else cur[1]=r.t;}else if(cur){out.push(cur);cur=null;}}); if(cur)out.push(cur);
  return out;}
// RTSP time strings: "2026-11-10 08:00" -> "2026_11_10_08_00_00" (the playback link's starttime / endtime format)
function avFmt(t){return t.replace(/[-: ]/g,"_")+"_00";}
function avStepMs(rows){let m=Infinity;for(let i=1;i<rows.length;i++){const d=new Date(rows[i].t.replace(" ","T"))-new Date(rows[i-1].t.replace(" ","T"));if(d>0&&d<m)m=d;}return isFinite(m)?m:3600000;}
function avPlus(t,ms){const d=new Date(new Date(t.replace(" ","T")).getTime()+ms),p=n=>String(n).padStart(2,"0");return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;}
function avCopy(btn,text){
  const done=()=>{const o=btn.textContent;btn.textContent="copied";setTimeout(()=>btn.textContent=o,1200);};
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(done).catch(()=>avCopyOld(text,done));}else avCopyOld(text,done);}
function avCopyOld(text,done){const t=document.createElement("textarea");t.value=text;document.body.appendChild(t);t.select();try{document.execCommand("copy");done();}catch(e){}t.remove();}
function avSnip(text){return `<span style="display:inline-flex;gap:4px;align-items:center;margin:3px 6px 3px 0"><input readonly value="${text}" onclick="this.select()" style="width:${Math.max(18,text.length*0.62)}em;font-family:monospace;font-size:13px;padding:3px 6px"><button style="padding:3px 8px" onclick='avCopy(this,${JSON.stringify(text)})'>copy</button></span>`;}
function avPoll(){clearTimeout(AVT);get("/api/avail/status").then(s=>{
  if(!s.run&&AVVIEW){AVT=setTimeout(avPoll,5000);return;}
  if(s.run)AVVIEW=null;
  if(!s.run&&s.total&&s.finished!==window.__AVFIN){window.__AVFIN=s.finished;avLinks();}
  avRender(s);
  if(s.run||TAB==="s10")AVT=setTimeout(avPoll,s.run?2000:5000);}).catch(()=>{AVT=setTimeout(avPoll,5000);});}
function avRender(s){{
  const n=s.rows.length,yes=s.rows.filter(r=>r.status==="yes").length;
  window.__AVKEY=s.key||s.base||window.__AVKEY;
  el("avStatus").textContent=s.err?s.err:(s.run?`checking ${n} / ${s.total}`:(s.total?(s.key?`saved: ${yes} of ${n} times have video`:`done: ${yes} of ${n} times have video`):"idle"));
  const rg=avRanges(s.rows),st=avStepMs(s.rows);
  el("avRanges").innerHTML=s.total?(rg.length?"<b>Video found at</b> (append to the playback link, or use view link for the full link):"+rg.map(([a,b])=>avRangeCard(a,b,avPlus(b,st),null,(s.rows.find(r=>r.t===a)||{}).img)).join(""):"<b>No video found yet</b>"):"";
  el("avList").innerHTML=s.rows.map(r=>`<div class=card style="display:flex;gap:12px;align-items:center;padding:8px">
    ${r.img?`<img src="data:image/jpeg;base64,${r.img}" style="width:240px;border-radius:4px">`:`<div style="width:240px;height:135px;display:flex;align-items:center;justify-content:center;background:var(--line);border-radius:4px;color:var(--dim)">no video</div>`}
    <div><div style="font-size:17px"><b>${r.t}</b></div>
    <div style="color:${r.status==="yes"?"var(--good)":"var(--bad)"};font-weight:600">${r.status==="yes"?"video available":(r.status==="auth"?"login refused":"no video")}</div>
    ${r.status==="yes"?`<div>${avSnip("&starttime="+avFmt(r.t))}</div>`:""}
    <div style="margin-top:4px"><button style="padding:3px 10px" onclick='avRecheckOne(${JSON.stringify(r.t)})'>recheck</button>
      <button style="padding:3px 10px" onclick='avView(this,${JSON.stringify(r.t)})'>view link</button>${r.saved?`<button style="padding:3px 10px;color:var(--bad)" onclick='avDelete(window.__AVKEY,${JSON.stringify(r.t)})'>delete</button>`:""}<div class=avFull></div></div>
    <div style="color:var(--dim);font-size:13px">${r.note||""}${r.checked_at?`<br>checked ${r.checked_at.replace("T"," ")}${r.saved?" (saved result)":""}`:""}</div></div></div>`).join("");
}}


// ---- 12 Serve videos as RTSP (rtsp_serve.py) ----
var RST=null, RSV=[], RSS=[], RSO="", RSSTAT={};
const RS_START=[["on_connect","Start from the beginning when someone connects"],["always","Always playing, like a live camera"]];
const RS_END=[["stop","Stop"],["loop","Loop back to the start"],["freeze_stop","Freeze on the last frame, then stop"],["freeze_loop","Freeze on the last frame, then loop"]];
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function rsDur(s){if(s==null)return "?";s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+" h ":"")+(m?m+" min ":"")+(h?"":x+" s");}
function rsInfo(f){return RSV.find(v=>v.file===f)||{};}
function rsInit(){rsAuthLoad().catch(()=>{});rsVideos(false).then(()=>get("/api/rtsp/status").then(d=>{RSS=d.streams.map(s=>{const o={...s};["url","state","viewers"].forEach(k=>delete o[k]);return o;});
  RSO=JSON.stringify(RSS);rsStatus(d);rsRender();rsPoll();
  if(RS_PEND){const f=RS_PEND;RS_PEND=null;if(!rsInfo(f).file){alert("That video is not in the Serve RTSP list yet; press reload videos.");return;}
    el("rsAddFile").value=f;rsAdd();el("rsMsg").innerHTML='<span style="color:var(--warn)">New stream added at the bottom: set it up and press Save and apply.</span>';
    setTimeout(()=>el("rsList").lastElementChild&&el("rsList").lastElementChild.scrollIntoView({behavior:"smooth",block:"center"}),100);}}));}
function rsVideos(again){el("rsVids").textContent="reading videos ...";return get("/api/rtsp/videos").then(d=>{RSV=d.videos||[];el("rsDir").textContent=d.dir;
  el("rsAddFile").innerHTML=rsOpts(null);
  el("rsVids").innerHTML=d.error?esc(d.error):`<table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="text-align:left;color:var(--dim)"><th>video</th><th>from</th><th>length</th><th>size</th><th>codec</th><th>picture</th><th>key frame every</th><th>used by</th></tr>`+
   RSV.map(v=>{const used=RSS.filter(s=>s.file===v.file).map(s=>esc(s.name)).join(", ");return `<tr style="border-top:1px solid var(--line)"><td>${esc(v.label||v.file)}${v.source==="recording"?recSrcIcon(v.rtsp):""}</td><td>${v.source==="recording"?"recorded (tab 8)":v.source==="raw"?"uploaded / made (tab 7)":"video folder"}</td><td>${rsDur(v.duration_s)}</td><td>${v.size_mb} MB</td><td>${esc(v.codec||"?")}</td><td>${v.width||"?"}x${v.height||"?"} ${v.fps||"?"} fps</td><td>${v.keyframe_gap_s!=null?v.keyframe_gap_s+" s":"?"}${v.keyframe_gap_s>5?' <span style="color:var(--warn)">(slow to start unless re-encoded)</span>':""}</td><td>${used||'<span style="color:var(--dim)">-</span>'}</td></tr>`;}).join("")+"</table>";
  if(again&&RSS.length)rsRender();});}
// stream link; a stream that ticks "password" carries user:password (shown masked, copied in full); pub = the public address
function rsUrl(s,mask,pub){const base=pub?`rtsp://${RSAUTH.public_host}:${RSAUTH.public_port}/`:RSADDR;if(!s.auth_on||!RSAUTH.set)return base+s.name;const e=encodeURIComponent;
  return base.replace("rtsp://",`rtsp://${e(RSAUTH.user)}:${mask?"\u2022\u2022\u2022\u2022":e(RSAUTH.pass)}@`)+s.name;}
function rsSnip(s){return rsSnip1(s,false)+(s.public&&RSAUTH.public_host?`<span class=hint style="margin:0 4px 0 0">public:</span>`+rsSnip1(s,true):"");}
function rsSnip1(s,pub){const full=rsUrl(s,false,pub),shown=rsUrl(s,true,pub);
  return `<span style="display:inline-flex;gap:4px;align-items:center;margin:3px 6px 3px 0"><input readonly value="${esc(shown)}" onclick="this.select()" style="width:${Math.max(18,shown.length*0.62)}em;font-family:monospace;font-size:13px;padding:3px 6px"><button style="padding:3px 8px" onclick='avCopy(this,${JSON.stringify(full).replace(/'/g,"&#39;")})'>copy</button></span>`;}
function rsAuthLoad(){return get("/api/rtsp/auth").then(a=>{RSAUTH=a;el("rsAuU").value=a.user||"";el("rsAuP").value="";
  el("rsAuMsg").innerHTML=a.set?`<span style="color:var(--good,#3fb950)">set: user <b>${esc(a.user)}</b></span>`:"not set";
  el("rsPbH").value=a.public_host||"";el("rsPbP").value=a.public_port||8554;
  el("rsPbMsg").innerHTML=a.public_host?`public links use rtsp://${esc(a.public_host)}:${a.public_port}/`:"not set";rsRender();});}
function rsAuthSave(){const u=el("rsAuU").value.trim(),p=el("rsAuP").value;
  if(!u&&!confirm("Remove the viewer login? (refused while a stream has password ticked)"))return;
  if(u&&!p&&!RSAUTH.set){alert("Type a password.");return;}
  post("/api/rtsp/auth",{user:u,pass:p}).then(r=>{if(!r.ok){el("rsAuMsg").innerHTML=`<span style="color:var(--bad)">${esc(r.error||"not saved")}</span>`;return;}rsAuthLoad();
    el("rsMsg").innerHTML="login saved; streams with password ticked use it now";})
   .catch(()=>{el("rsAuMsg").innerHTML=`<span style="color:var(--bad)">not saved: the platform has not been restarted since this setting was added</span>`;});}
function rsPubSave(){const h=el("rsPbH").value.trim(),p=+el("rsPbP").value||8554;
  post("/api/rtsp/public",{host:h,port:p}).then(r=>{if(!r.ok){el("rsPbMsg").innerHTML=`<span style="color:var(--bad)">${esc(r.error||"not saved")}</span>`;return;}rsAuthLoad();})
   .catch(()=>{el("rsPbMsg").innerHTML=`<span style="color:var(--bad)">not saved: the platform has not been restarted since this setting was added</span>`;});}
function rsAuthTick(i,k,on){const s=RSS[i];
  if(k==="auth_on"&&on&&!RSAUTH.set){alert("Set the viewer login (user + password) at the top first.");rsRender();return;}
  if(k==="public"&&on&&!s.auth_on){alert("Tick password first: a public stream must need the password.");rsRender();return;}
  if(k==="public"&&on&&!RSAUTH.public_host){alert("Type the public address at the top first.");rsRender();return;}
  s[k]=on;if(k==="auth_on"&&!on)s.public=false;rsRender();}
function rsStatus(d){RSSTAT={};if(d.auth&&(d.auth.set!==RSAUTH.set||d.auth.user!==RSAUTH.user||d.auth.public_host!==RSAUTH.public_host||d.auth.public_port!==RSAUTH.public_port))rsAuthLoad();(d.streams||[]).forEach(s=>RSSTAT[s.name]=s);const v=d.server||{};
  if(v.address&&v.address!==RSADDR){RSADDR=v.address;el("rsAddr").textContent=RSADDR;rsRender();}
  el("rsSrv").innerHTML=!v.running?"server stopped":!v.layout_ok?"running, old hand-made setup: press Restart server to use these settings":`running · <b>${d.viewers}</b> viewer${d.viewers===1?"":"s"}`;
  el("rsSrv").style.color=!v.running?"var(--bad)":!v.layout_ok?"var(--warn)":"";
  if(d.paused&&v.running){el("rsSrv").innerHTML="PAUSED · no stream is served (settings kept)";el("rsSrv").style.color="var(--warn)";}
  el("rsPauseBtn").innerHTML=d.paused?"&#9654; Resume all streams":"&#9208; Pause all streams";el("rsPauseBtn").dataset.p=d.paused?"1":"";
  const c=d.clips||{};el("rsSrv").innerHTML+=c.running?`<br><span style="color:var(--warn)">cutting exact loop clips: ${c.done} of ${c.total} done${c.cur?" · now "+esc(c.cur):""} (streams switch over when finished)</span>`:
    c.err?`<br><span style="color:var(--bad)">${esc(c.err)}</span>`:"";
  RSS.forEach((s,i)=>{const x=el("rsState"+i);if(x)x.innerHTML=rsPill(s);});}
function rsPill(s){const x=RSSTAT[s.name];if(!x)return '<span class=pill>not saved yet</span>';
  const c=x.state==="playing"?"var(--good)":x.state==="off"?"var(--dim)":x.state==="ended"||x.state==="not loaded"?"var(--warn)":"";
  return `<span class=pill style="color:${c}">${esc(x.state)}${x.state==="playing"?` · <b>${x.viewers}</b> viewer${x.viewers===1?"":"s"}`:""}</span>`;}
function rsPoll(){clearTimeout(RST);if(TAB!=="s11")return;get("/api/rtsp/status").then(d=>{rsStatus(d);RST=setTimeout(rsPoll,5000);}).catch(()=>{RST=setTimeout(rsPoll,8000);});}
function rsDirty(){el("rsDirty").style.display=JSON.stringify(RSS)===RSO?"none":"";}
function rsSet(i,k,v){const s=RSS[i];s[k]=v;if(k==="end"&&v!=="stop")s.reencode=true;rsRender();}
function rsRadio(i,k,opts){return opts.map(([v,l])=>`<label style="display:inline-flex;gap:5px;align-items:center;margin:0 14px 0 0;color:var(--ink);font-size:13.5px"><input type=radio style="width:auto" name="rs${k}${i}" ${RSS[i][k]===v?"checked":""} onchange="rsSet(${i},'${k}','${v}')">${l}</label>`).join("");}
function rsOpts(sel){const g=(src,t)=>{const L=RSV.filter(v=>(v.source||"folder")===src);return L.length?`<optgroup label="${t}">`+L.map(x=>`<option value="${esc(x.file)}" ${x.file===sel?"selected":""}>${esc(x.label||x.file)} (${rsDur(x.duration_s)})</option>`).join("")+"</optgroup>":"";};
  return g("folder","video folder")+g("recording","recorded in tab 8")+g("raw","uploaded / made in tab 7");}
function rsLen(s){if((s.parts||[]).length)return s.parts.reduce((t,p)=>t+p[1]-p[0],0);const d=rsInfo(s.file).duration_s||0,e=s.end_s>s.skip_s?s.end_s:d;return e?e-s.skip_s:null;}
function rsPartsHtml(i){const s=RSS[i],P=s.parts||[];if(!P.length)return "";const b='style="padding:1px 7px;font-size:12px"';
  return `<div style="margin-top:6px"><b>Plays these ${P.length} part(s) in this order</b> <span class=pill>total ${rsDur(rsLen(s))}</span> <button style="padding:1px 9px;font-size:12px;font-weight:700" title="watch the joined clip exactly as the RTSP stream sends it (saved settings)" onclick="rsPlayClip(${i})">&#9654; play the joined clip</button> ${P.length>1?`<button ${b} title="play the parts in the opposite order (last part first)" onclick="rsPartsReverse(${i})">&#8645; reverse order</button> `:""}<button ${b} onclick="rsPartsClear(${i})">clear parts</button>`+
   P.map(([a,z,bk],k)=>`<div class=row style="gap:6px;margin-top:3px"><span class=pill style="min-width:2.2em;text-align:center">${k+1}</span><code>${bk?`${rpFmt(z)} &larr; ${rpFmt(a)}`:`${rpFmt(a)} &rarr; ${rpFmt(z)}`}</code><span class=hint style="margin:0">${rsDur(z-a)}${bk?' · <b style="color:var(--warn)">backwards</b>':""}</span>
     <button ${b} class="${bk?"on":""}" title="play this part backwards (in reverse)" onclick="rsPartBack(${i},${k})">&#10226; backwards</button>
     <button ${b} title="earlier" ${k?"":"disabled"} onclick="rsPartMove(${i},${k},-1)">&#9650;</button><button ${b} title="later" ${k<P.length-1?"":"disabled"} onclick="rsPartMove(${i},${k},1)">&#9660;</button>
     <button ${b} title="show this part in the player" onclick="rsPartShow(${i},${k})">&#9654;</button><button ${b} class=dan title="remove this part" onclick="rsPartDel(${i},${k})">&#10005;</button></div>`).join("")+"</div>";}
function rsPartsRefresh(i){rsRender();if(RP&&RP.pick===i&&el("rpParts"))el("rpParts").innerHTML=rsPartsHtml(i);}
function rsPartAdd(i){const s=RSS[i];if(!s)return;const a=s.skip_s||0,z=s.end_s||(RP&&RP.dur)||0;
  if(!(z>a+0.5)){alert("Mark the part first: press start here, then end here (at least 0.5 s later).");return;}
  s.parts=(s.parts||[]).concat([[Math.round(a*10)/10,Math.round(z*10)/10]]);s.end_s=0;rpRange();rsPartsRefresh(i);}
function rsPartMove(i,k,d){const P=RSS[i].parts;[P[k],P[k+d]]=[P[k+d],P[k]];rsPartsRefresh(i);}
function rsPartDel(i,k){RSS[i].parts.splice(k,1);rsPartsRefresh(i);}
function rsPartBack(i,k){const p=RSS[i].parts[k];if(p.length>2)p.length=2;else p.push(1);rsPartsRefresh(i);}
function rsPartsReverse(i){RSS[i].parts.reverse();rsPartsRefresh(i);}
function rsPartsClear(i){if(!confirm("Remove all parts of this stream? It then plays from start at / play until again."))return;RSS[i].parts=[];rsPartsRefresh(i);}
function rsPartShow(i,k){const [a]=RSS[i].parts[k];if(RP&&RP.pick===i&&el("rpBox").style.display!=="none")rpSeek(a);else{RSS[i].skip_s=a;rsPick(i);}}
function rsCopyGroup(i){const s=RSS[i],G=rsGroup(s).filter(x=>x!==s);if(!G.length)return;
  const d=m=>(m.offset_s||0)-(s.offset_s||0),cl=x=>Math.max(0,Math.round(x*10)/10);
  if(!confirm(`Copy the settings of ${s.name} to ${G.map(x=>x.name).join(", ")}?\nThey get the same `+((s.parts||[]).length?`${s.parts.length} part(s)`:`start / play-until`)+
    `, starts, at the end, freeze and start-over settings`+(G.some(m=>d(m))?", shifted by each camera's time offset":"")+`.\nTheir own video, name, note and offset stay. Nothing changes on the server until Save and apply.`))return;
  G.forEach(m=>{const o=d(m);m.parts=(s.parts||[]).map(([a,z,bk])=>[cl(a+o),cl(z+o)].concat(bk?[1]:[]));m.skip_s=cl((s.skip_s||0)+o);m.end_s=s.end_s?cl(s.end_s+o):0;
    ["start","end","freeze_s","idle_close_s","reencode","wait_longest"].forEach(k=>m[k]=s[k]);});rsRender();}
// freeze time as typed: "90", "30s", "30 min", "1h 30m 20s", "1:30:00", "5:00" -> seconds (NaN if not understood)
function rsParseDur(x){x=String(x).trim().toLowerCase();if(!x)return NaN;
  if(/^\d+(\.\d+)?(:\d{1,2}(\.\d+)?){1,2}$/.test(x))return x.split(":").map(Number).reduce((a,b)=>a*60+b,0);
  if(/^\d+(\.\d+)?$/.test(x))return +x;
  const re=/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;let m,t=0,used="";
  while((m=re.exec(x))){t+=(+m[1])*({h:3600,m:60,s:1})[m[2][0]];used+=m[0];}
  return used.replace(/\s/g,"").length===x.replace(/[\s,]|and/g,"").length?t:NaN;}
function rsFzTxt(v){v=+v||0;const h=Math.floor(v/3600),m=Math.floor(v%3600/60),s=Math.round((v%60)*10)/10;
  return [h?h+"h":"",m?m+"m":"",s||(!h&&!m)?s+"s":""].filter(Boolean).join(" ");}
function rsFzSet(i,inp){const s=RSS[i],w=rsGroup(s).length>=2&&rsGroup(s)[0].wait_longest,v=rsParseDur(inp.value),lo=w?0:1;
  if(isNaN(v)||v<lo||v>86400){alert(`Freeze time not understood or out of range: "${inp.value}".\nUse e.g. 30s, 30 min, 1h 30m, 1:30:00 (${lo} s to 24 h).`);inp.value=rsFzTxt(s.freeze_s);return;}
  rsSet(i,"freeze_s",Math.round(v*1000)/1000);}
function rsWait(i,on){rsGroup(RSS[i]).forEach(m=>{m.wait_longest=on;if(on&&m.end.startsWith("freeze"))m.freeze_s=0;});rsRender();}
// group with "shorter streams wait for the longest": [{name, len, freeze}] as the server will play it (same rule as wait_plan)
function rsWaitPlan(G){const Ls=G.map(m=>rsLen(m)||0),top=Math.max(...Ls),ex=G[0].end.startsWith("freeze")?(+G[0].freeze_s||0):0;
  return G.map((m,k)=>({name:m.name,len:Ls[k],freeze:Math.round((top-Ls[k]+ex)*10)/10}));}
function rsGroup(s){return s.enabled&&s.group?RSS.filter(x=>x.enabled&&x.group===s.group):[];}
function rsSameLen(i){const s=RSS[i],a=rsGroup(s)[0];if(!a||a===s)return;const L=rsLen(a);if(L==null)return;s.end_s=Math.round((s.skip_s+L)*10)/10;rsRender();}
function rsRender(){
  el("rsList").innerHTML=RSS.map((s,i)=>{const v=rsInfo(s.file),url=rsUrl(s),fz=s.end.startsWith("freeze"),lp=s.end.endsWith("loop");
   const warn=[];
   if(!v.file)warn.push("this video was not found (renamed, deleted, or its session is still recording)");
   if(s.end!=="stop")warn.push("loop and freeze always re-encode");
   if(v.keyframe_gap_s>5&&!s.reencode)warn.push(`this video has a key frame only every ${v.keyframe_gap_s} s, so players may wait that long for the first picture: tick re-encode`);
   if(v.keyframe_gap_s>2.5&&lp&&s.skip_s>0)warn.push(`in loop modes the skip lands on the key frame before it, up to ${v.keyframe_gap_s} s early`);
   const G=rsGroup(s),lead=G[0],wait=G.length>=2&&!!lead.wait_longest;
   if(G.length>=2){if(lead!==s&&s.start!==lead.start)warn.push(`sync group ${s.group}: use the same "Starts" choice as ${lead.name}`);
     if(lead!==s&&lead.end!==s.end)warn.push(`sync group ${s.group}: use the same "At the end" choice as ${lead.name}`);
     if(lead!==s&&!wait&&rsLen(lead)!=null&&rsLen(s)!=null&&Math.abs(rsLen(lead)-rsLen(s))>0.05)warn.push(`sync group ${s.group}: plays ${rsLen(s).toFixed(1)} s but ${lead.name} plays ${rsLen(lead).toFixed(1)} s; they must be the same length (button "same length as ${lead.name}", or tick "shorter streams freeze until the longest finishes")`);
     if(wait&&lead!==s&&s.end.startsWith("freeze")&&lead.end.startsWith("freeze")&&(+s.freeze_s||0)!==(+lead.freeze_s||0))warn.push(`sync group ${s.group}: use the same extra freeze as ${lead.name} (${lead.freeze_s} s)`);
     if(wait&&rsLen(s)==null)warn.push("the length of this stream is unknown, so the group cannot wait for it");}
   else if(s.group&&s.enabled)warn.push(`sync group ${s.group}: no other switched-on stream has this group name yet`);
   if(s.end_s&&s.end_s<s.skip_s+1)warn.push("play until must be at least 1 s after the start");
   if(v.duration_s&&s.end_s>v.duration_s+0.5)warn.push(`play until is past the end of the video (${rpFmt(v.duration_s)})`);
   if(s.start==="always"&&s.end==="stop")warn.push("always playing + stop: after the last frame the stream stays off until the server restarts");
   const plan=(G.length>=2?`In sync group ${s.group} with ${G.filter(x=>x!==s).map(x=>x.name).join(", ")}: they start together`+(lead.start==="on_connect"?` (a viewer on any of them starts all of them from the start; they stop when none of them has had a viewer for ${Math.max(...G.map(x=>x.idle_close_s))} s). `:". "):"")+((s.parts||[]).length?`plays ${s.parts.length} part(s) one after another (${rsDur(rsLen(s))} in all)`+(lp?", then again from part 1":", then the stream ends")+
     (s.start==="on_connect"?`. A new viewer after ${s.idle_close_s} s with nobody watching starts it over.`:". Viewers join wherever it is.")+"\u0000":"")+(s.skip_s>0?`starts at ${rpFmt(s.skip_s)}, `:"starts at 0:00:00, ")+(s.end_s>s.skip_s?`plays until ${rpFmt(s.end_s)} (${rsDur(s.end_s-s.skip_s)})`:v.duration_s?`plays to the end ${rpFmt(v.duration_s)} (${rsDur(v.duration_s-s.skip_s)})`:"plays to the end")+
     (fz?`, holds the last frame ${rsDur(s.freeze_s)}`:"")+(lp?", then again from the start point":", then the stream ends")+
     (s.start==="on_connect"?`. A new viewer after ${s.idle_close_s} s with nobody watching starts it over.`:". Viewers join wherever it is.");
   let wplan="";
   if(wait){const P=rsWaitPlan(G),me=P.find(x=>x.name===s.name),top=Math.max(...P.map(x=>x.len)),longest=P.find(x=>x.len===top).name,lp2=lead.end.endsWith("loop");
     const extra=lead.end.startsWith("freeze")?(+lead.freeze_s||0):0;
     wplan=`Group ${s.group} cycle: ${rsDur(top+extra)}${lp2?", then all restart together":", then all end"}. `+P.map(x=>`${x.name} plays ${rsDur(x.len)}`+(x.freeze>0?`, then freezes ${rsDur(x.freeze)}`+(x.len<top?` (until ${longest} finishes`+(extra?` + ${rsDur(extra)} for all)`:")"):""):"")).join("; ")+".";}
   return `<div style="border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:8px 0;${s.enabled?"":"opacity:.55"}">
    <div class=row>
     <label style="margin:0;display:flex;gap:5px;align-items:center;color:var(--ink)"><input type=checkbox style="width:auto" ${s.enabled?"checked":""} onchange="rsSet(${i},'enabled',this.checked)">on</label>
     <input value="${esc(s.name)}" style="width:15em;font-weight:600" onchange="rsSet(${i},'name',this.value.trim())" title="stream name = last part of the URL">
     ${rsSnip(s)} <span id="rsState${i}">${rsPill(s)}</span>
     <button class=dan style="margin-left:auto;padding:4px 10px" onclick="rsDel(${i})">remove</button></div>
    <div class=row style="margin-top:6px">
     <label style="margin:0;display:flex;gap:5px;align-items:center;color:var(--ink)" title="viewers need the user name + password set at the top"><input type=checkbox style="width:auto" ${s.auth_on?"checked":""} onchange="rsAuthTick(${i},'auth_on',this.checked)">&#128274; password${RSAUTH.set?` (user ${esc(RSAUTH.user)})`:" (set the login at the top first)"}</label>
     <label style="margin:0;display:flex;gap:5px;align-items:center;color:var(--ink)" title="viewers from the internet may watch, with the password; the router must forward the port"><input type=checkbox style="width:auto" ${s.public?"checked":""} ${s.auth_on?"":"disabled"} onchange="rsAuthTick(${i},'public',this.checked)">&#127760; public${RSAUTH.public_host?` (${esc(RSAUTH.public_host)}:${RSAUTH.public_port})`:" (set the public address at the top first)"}</label>
     <span class=hint style="margin:0">${s.public?"anyone on the internet with the password":s.auth_on?"local network, password needed":"local network, no password"}</span></div>
    <div class=row style="margin-top:6px">
     <label style="margin:0">video</label><select style="width:auto;max-width:360px" onchange="rsSet(${i},'file',this.value)">${(v.file?"":`<option selected>${esc(s.file)} (missing)</option>`)+rsOpts(s.file)}</select>
     <label style="margin:0" title="streams with the same group name are played by one player: they start, loop and freeze at exactly the same moment">sync group</label><input value="${esc(s.group||"")}" placeholder="none" style="width:7em" onchange="rsSet(${i},'group',this.value.trim().replace(/[^A-Za-z0-9_-]/g,''))">
     ${G.length>=2&&lead!==s?`<button onclick="rsSameLen(${i})" title="keep this stream's start and set its end so it plays as long as ${esc(lead.name)}">same length as ${esc(lead.name)}</button>`:""}
     <input value="${esc(s.note)}" placeholder="note" style="flex:1;min-width:200px" onchange="rsSet(${i},'note',this.value)"></div>
    <div style="margin-top:8px"><span class=hint style="margin-right:10px">Starts:</span>${rsRadio(i,"start",RS_START)}</div>
    <div style="margin-top:4px"><span class=hint style="margin-right:10px">At the end:</span>${rsRadio(i,"end",RS_END)}</div>
    <div class=row style="margin-top:6px">
     ${fz?`<label style="margin:0" ${wait?'title="every stream of the group holds its last frame this long after the longest one finishes; 0 = restart right away"':""}>${wait?"extra freeze for all at the end":"freeze for"}</label><input value="${rsFzTxt(s.freeze_s)}" style="width:8em" title="how long to hold the last frame: e.g. 30s, 30 min, 1h 30m, 1:30:00 (up to 24 h)" onchange="rsFzSet(${i},this)"><span class=hint style="margin:0">(${rsDur(s.freeze_s)})</span>`:""}
     <button onclick="rsPick(${i})" ${v.file?"":"disabled"} title="open the video, play it, and mark where the stream starts and ends">&#9654; pick start / end</button>
     ${(s.parts||[]).length?`<span class=hint style="margin:0">several parts (below)</span>`:`<label style="margin:0">start at</label><input type=number min=0 step=0.1 value="${s.skip_s}" style="width:7em" onchange="rsSet(${i},'skip_s',+this.value)"><label style="margin:0">s</label>
     <label style="margin:0">play until</label><input type=number min=0 step=0.1 value="${s.end_s||0}" style="width:7em" onchange="rsSet(${i},'end_s',+this.value)" title="0 = to the end of the video"><label style="margin:0">s <span class=hint style="margin:0">(0 = to the end)</span></label>`}
     <label style="margin:0;display:flex;gap:5px;align-items:center;color:var(--ink)" title="H.264 with a key frame every second; about half a CPU core per 1080p stream"><input type=checkbox style="width:auto" ${s.reencode?"checked":""} ${s.end!=="stop"?"disabled":""} onchange="rsSet(${i},'reencode',this.checked)">re-encode (key frame every 1 s)</label>
     ${s.start==="on_connect"?`<label style="margin:0">start over after nobody watched for</label><input type=number min=5 max=3600 value="${s.idle_close_s}" style="width:5em" onchange="rsSet(${i},'idle_close_s',+this.value)"><label style="margin:0">s</label>`:""}</div>
    ${rsPartsHtml(i)}
    ${G.length>=2?`<div class=row style="margin-top:6px"><label style="margin:0" title="how many seconds this camera's video is AHEAD (+) or behind (-) the others for the same real moment; copy to group shifts the times by the difference">time offset</label>
     <input type=number step=0.1 value="${s.offset_s||0}" style="width:6em" onchange="rsSet(${i},'offset_s',+this.value)"><label style="margin:0">s</label>
     <button onclick="rsCopyGroup(${i})" title="give the other streams of this sync group exactly these parts and play settings">copy these settings to group ${esc(s.group)}</button>
     <button onclick="rsRestartGroup('${esc(s.group)}')" title="start every stream of this group again from its first frame, at the same moment">&#10226; restart group ${esc(s.group)} from the first frame</button>
     <label style="margin:0;display:flex;gap:5px;align-items:center;color:var(--ink)" title="streams of this group may play different lengths: each shorter one holds its last frame until the longest one has finished, then all of them restart (or end) together. Set for the whole group."><input type=checkbox style="width:auto" ${wait?"checked":""} onchange="rsWait(${i},this.checked)">shorter streams freeze until the longest finishes</label></div>
     ${wait?`<div class=hint style="margin:4px 0 0;color:var(--ink)">${esc(wplan)}</div>`:""}`:""}
    <div class=hint style="margin:6px 0 0">${esc(plan.split("\u0000")[0])}${warn.length?`<br><span style="color:var(--warn)">${warn.map(esc).join("<br>")}</span>`:""}</div>
   </div>`;}).join("")||'<div class=hint>No streams. Add one below.</div>';
  rsDirty();}
function rsAdd(){const f=el("rsAddFile").value;if(!f)return;let n=f.split("/").pop().replace(/\.[^.]+$/,"").replace(/[^A-Za-z0-9_\-]/g,"_").slice(0,60),k=n,j=2;
  while(RSS.some(s=>s.name===k))k=n+"_"+(j++);
  RSS.push({name:k,file:f,enabled:true,start:"on_connect",end:"stop",freeze_s:60,skip_s:0,end_s:0,group:"",parts:[],offset_s:0,reencode:(rsInfo(f).keyframe_gap_s||0)>5,idle_close_s:15,note:"",wait_longest:false,auth_on:false,public:false});rsRender();}
function rsDel(i){const s=RSS[i],x=RSSTAT[s.name];if(!confirm(`Remove stream ${s.name}?`+(x&&x.viewers?`\n${x.viewers} viewer(s) are watching it now.`:"")+"\nThe video file is not touched. Press Save and apply afterwards."))return;RSS.splice(i,1);rsRender();}
function rsSave(){const old={};JSON.parse(RSO||"[]").forEach(s=>old[s.name]=JSON.stringify(s));
  const hit=Object.values(RSSTAT).filter(x=>x.viewers&&old[x.name]!==JSON.stringify(RSS.find(s=>s.name===x.name)||null));
  if(hit.length&&!confirm("These streams change and are being watched now; their viewers will be disconnected:\n"+hit.map(x=>`${x.name} (${x.viewers})`).join("\n")+"\nContinue?"))return;
  el("rsMsg").textContent="saving ...";post("/api/rtsp/save",{streams:RSS}).then(r=>{
   if(!r.ok){el("rsMsg").innerHTML='<span style="color:var(--bad)">not saved: '+r.errors.map(esc).join("; ")+"</span>";return;}
   RSO=JSON.stringify(RSS);rsDirty();el("rsMsg").innerHTML=r.note?`<span style="color:var(--warn)">${esc(r.note)}</span>`:"saved and applied";rsPoll();});}
function rsRestart(){if(JSON.stringify(RSS)!==RSO&&!confirm("You have unsaved changes; the server restarts with the last saved settings. Continue?"))return;
  get("/api/rtsp/status").then(d=>{if(!confirm(`Restart the RTSP server? Every stream stops for a few seconds`+(d.viewers?` and ${d.viewers} viewer(s) are disconnected`:"")+"."))return;
   el("rsMsg").textContent="restarting ...";post("/api/rtsp/restart",{}).then(r=>{el("rsMsg").innerHTML=r.ok?"server restarted":'<span style="color:var(--bad)">'+(r.errors||[]).map(esc).join("; ")+"</span>";rsPoll();});});}
function rsStop(){get("/api/rtsp/status").then(d=>{if(!confirm("Stop the RTSP server? All streams go off"+(d.viewers?` and ${d.viewers} viewer(s) are disconnected`:"")+". Restart server brings them back."))return;
  post("/api/rtsp/stop",{}).then(r=>{el("rsMsg").innerHTML=r.ok?"server stopped":'<span style="color:var(--bad)">'+(r.errors||[]).map(esc).join("; ")+"</span>";rsPoll();});});}
function rsRestartGroup(g){const G=RSS.filter(x=>x.enabled&&x.group===g);
  if(RSO!==JSON.stringify(RSS)&&!confirm("You have unsaved changes. The restart uses the SAVED settings. Restart anyway?"))return;
  if(!confirm(`Restart sync group ${g} (${G.map(x=>x.name).join(", ")}) from the first frame, all together?\nViewers are disconnected for a moment; players that reconnect by themselves come back on the first frame.`))return;
  const bad=m=>{el("rsMsg").innerHTML=`<span style="color:var(--bad)">${esc(m)}</span>`;alert(m);};
  fetch("/api/rtsp/restart_group",{method:"POST",body:JSON.stringify({group:g})}).then(x=>{
    if(x.status===404)throw new Error("The platform has not been restarted since this button was added, so it cannot restart groups yet.");
    return x.json();}).then(r=>{if(r.ok){el("rsMsg").innerHTML=esc(r.note);alert(r.note);}else bad(r.error);rsPoll();}).catch(e=>bad("Group restart failed: "+e.message));}
function rsPause(){const res=el("rsPauseBtn").dataset.p==="1";
  get("/api/rtsp/status").then(d=>{
    if(!res&&!confirm("Pause all streams? Every stream stops"+(d.viewers?` and ${d.viewers} viewer(s) are disconnected`:"")+", which frees their CPU and memory.\nYour settings stay; Resume all streams brings them back."))return;
    el("rsMsg").textContent=res?"resuming ...":"pausing ...";
    post(res?"/api/rtsp/resume":"/api/rtsp/pause",{}).then(r=>{el("rsMsg").innerHTML=!r.ok?'<span style="color:var(--bad)">'+(r.errors||[]).map(esc).join("; ")+"</span>":
      res?(r.note?`<span style="color:var(--warn)">${esc(r.note)}</span>`:"resumed: streams are served again"):"paused: no stream is served, resources freed";rsPoll();});});}
function rsLogs(){const b=el("rsLog");if(b.style.display!=="none"){b.style.display="none";return;}get("/api/rtsp/logs").then(d=>{b.textContent=d.text||"(empty)";b.style.display="";b.scrollTop=b.scrollHeight;});}


// ---- player for recorded videos (tab 8): the file itself, or converted to H.264 when the browser cannot play HEVC ----
var RP={sid:"",file:"",conv:false,off:0,dur:null,T:null};
function rpFmt(s){s=Math.max(0,Math.round(s));return Math.floor(s/3600)+":"+String(Math.floor(s%3600/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");}
function rpOpen(sid,file){const e=encodeURIComponent;
  rpStart({title:sid+" / "+file,probe:`/api/rec/probe?session=${e(sid)}&file=${e(file)}`,direct:`/rec/${sid}/${file}?play=1`,
           convUrl:(t,w)=>`/recplay/${sid}/${file}?t=${t}&w=${w}`,dl:`/rec/${sid}/${file}`});}
function rsPick(i){const s=RSS[i],f=encodeURIComponent(s.file);
  rpStart({title:"stream "+s.name+": "+(rsInfo(s.file).label||s.file),probe:`/api/rtsp/probe?f=${f}`,direct:`/rsvid?f=${f}&play=1`,
           convUrl:(t,w)=>`/rsvid?f=${f}&conv=1&t=${t}&w=${w}`,dl:null,pick:i,t0:s.skip_s||0});}
function rpStart(o){RP={...o,conv:false,off:0,dur:o.dur||null,T:null,drag:false};el("rpBox").style.display="";el("rpName").textContent=o.title;
  el("rpDl").style.display=o.dl?"":"none";if(o.dl)el("rpDl").href=o.dl;el("rpInfo").textContent="";
  el("rpPick").style.display=o.pick!=null?"":"none";rpRange();if(o.pick!=null)el("rpParts").innerHTML=rsPartsHtml(o.pick);
  get(o.probe).then(d=>{if(d.ok){RP.dur=d.duration_s;
    el("rpInfo").textContent=`${d.codec||"?"} ${d.width||"?"}x${d.height||"?"} · ${d.duration_s!=null?rpFmt(d.duration_s):"length unknown (still recording)"}`;
    if(/hevc|h265/i.test(d.codec||"")){rpConvert(o.t0||0);return;}}
   rpDirect(o.t0||0);});}
function rpDirect(t0){const v=el("rpVid");v.controls=true;v.onclick=null;RP.conv=false;RP.off=0;el("rpConv").style.display="none";el("rpMode").textContent="original file";el("rpSwitch").textContent="picture missing? play a converted copy";
  v.onerror=()=>rpConvert(rpNow());
  v.onloadedmetadata=()=>{if(!v.videoWidth){rpConvert(t0||0);return;}if(t0)v.currentTime=t0;};
  setTimeout(()=>{if(!RP.conv&&el("rpBox").style.display!=="none"&&(v.readyState<2||!v.videoWidth))rpConvert(t0||0);},6000);
  v.src=RP.direct;clearInterval(RP.T);RP.T=setInterval(rpTick,500);}
function rpTick(){el("rpAbs").textContent="at "+rpFmt(rpNow())+(RP.dur?" of "+rpFmt(RP.dur):"");if(RP.pick!=null)rpRange();
  if(RP.conv){const v=el("rpVid"),b=el("rpBar"),now=rpNow(),tot=RP.dur||Math.max(60,Math.ceil(now+60));   // own bar: the browser only
    el("rpPP").innerHTML=v.paused?"&#9654;":"&#9208;";                                                     // knows the converted part so far
    if(!RP.drag){b.max=Math.ceil(tot);b.value=Math.floor(now);el("rpT").textContent=rpFmt(now)+" / "+(RP.dur?rpFmt(RP.dur):"?");}}}
function rpPP(){const v=el("rpVid");if(v.paused)v.play().catch(()=>{});else v.pause();rpTick();}
function rpRange(){if(RP.pick==null||!RSS[RP.pick])return;const s=RSS[RP.pick];
  el("rpRange").textContent=`marked ${rpFmt(s.skip_s||0)} → ${s.end_s?rpFmt(s.end_s):"end of video"} · now at ${rpFmt(rpNow())}`+((s.parts||[]).length?` · ${s.parts.length} part(s) added`:"");}
function rpSeek(t){if(RP.conv)rpLoad(t);else el("rpVid").currentTime=t;}
function rpMark(k){const s=RSS[RP.pick];if(!s)return;const t=Math.round(rpNow()*10)/10;
  const st=s.skip_s||0;
  if(k==="end_s"&&Math.abs(t-st)<0.5){alert(`Start (${rpFmt(st)}) and end must be at least 0.5 s apart.`);return;}
  if(k==="end_s"&&t<st){                   // end before start = play that range backwards: it becomes a backwards part
    s.parts=(s.parts||[]).concat([[t,st,1]]);s.end_s=0;rpRange();rsPartsRefresh(RP.pick);
    el("rpRange").textContent+=` · added a BACKWARDS part ${rpFmt(st)} → ${rpFmt(t)}`;return;}
  if(k==="skip_s"&&s.end_s&&t>s.end_s-1){if(!confirm(`This is after the current end (${rpFmt(s.end_s)}). Set the start here and play to the end of the video?`))return;s.end_s=0;}
  s[k]=t;rpRange();rsRender();}
function rpMarkClear(){const s=RSS[RP.pick];if(!s)return;s.end_s=0;rpRange();rsRender();}
function rpConvert(t){if(RP.conv&&RP.conv_url)return;RP.conv=true;el("rpConv").style.display="";el("rpMode").textContent="converted copy (H.264)";
  el("rpSwitch").textContent="try the original file instead";const v=el("rpVid");v.controls=false;v.onclick=rpPP;rpLoad(t||0);}
function rpLoad(t){const v=el("rpVid");if(RP.dur)t=Math.min(t,Math.max(0,RP.dur-5));RP.off=Math.max(0,t);v.onerror=null;v.onloadedmetadata=null;
  v.src=RP.conv_url=RP.convUrl(RP.off.toFixed(1),el("rpW").value);v.play().catch(()=>{});
  clearInterval(RP.T);RP.T=setInterval(rpTick,500);rpTick();}
function rpNow(){return RP.off+(el("rpVid").currentTime||0);}
function rpJump(d){rpLoad(rpNow()+d);}
function rpGo(){const p=el("rpAt").value.trim().split(":").map(Number);if(p.some(isNaN))return;let s=0;p.forEach(x=>s=s*60+x);rpLoad(s);}
function rpSwitch(){const t=rpNow();if(RP.conv)rpDirect(t);else rpConvert(t);}
function rpClose(){const v=el("rpVid");v.controls=true;v.onclick=null;v.pause();v.removeAttribute("src");v.load();clearInterval(RP.T);el("rpBox").style.display="none";}


/* ---------- 7 datasets: raw videos + raw frames (media.py) ---------- */
function dsTab(t){DSTAB=t;try{localStorage.setItem("dsTab",t);}catch(e){}
  [["lab","dsLab","dsTabLab"],["v","dsRawV","dsTabV"],["f","dsRawF","dsTabF"]].forEach(([k,d,b])=>{el(d).style.display=k===t?"":"none";el(b).className=k===t?"on":"";});
  if(t==="v")rvLoad(); if(t==="f")rfLoad(false);}
function rsUse(f){RS_PEND=f;show("s11");}
function dsUpPill(x){const u=x.upload;if(!u)return "";const L=u.leak||{},bad=(L.n_benchmark||0)+(L.n_reserved_day||0);
  return `<div><span class=pill title="${esc(u.rule||"")}">uploaded ${esc((u.created||"").slice(0,10))}</span>`+
    (bad?` <span class=pill style="color:var(--bad)" title="${esc((L.benchmark_md5||[]).concat(L.reserved_day||[]).slice(0,20).join(", "))}">&#9888; ${L.n_benchmark||0} benchmark + ${L.n_reserved_day||0} reserved-day frames: never train on it</span>`:"")+
    ` <button class=dan style="padding:1px 7px;font-size:11.5px" onclick="event.stopPropagation();rawDel('dataset','${esc(x.name)}')">delete</button></div>`;}
function dsToRtsp(name){RFG="labelled datasets";el("rfQ").value=name;RFSEL=[];dsTab("f");
  const go=()=>{const ss=RF.filter(x=>x.id.startsWith("ds/"+name+"/"));const v=ss.find(x=>x.id.endsWith("/val"));RFSEL=(v?[v]:ss).map(x=>x.id);
    el("mvName").value=(name+"_"+(v?"val":"all")).replace(/[^A-Za-z0-9_-]/g,"_").slice(0,80);rfDraw();};
  RF.length?go():rfLoad(false).then(go);}
function rawDel(kind,id){if(!confirm(`Delete ${id}?\nThis removes the files from disk and cannot be undone.`))return;
  post("/api/raw/delete",{kind,id}).then(r=>{if(!r.ok){alert(r.error);return;}if(kind==="dataset")loadDatasets();else if(kind==="video")rvLoad();else rfLoad(true);});}
function upXhr(url,file,msg,label){return new Promise(res=>{const x=new XMLHttpRequest();x.open("POST",url);
  x.upload.onprogress=e=>{if(e.lengthComputable)el(msg).textContent=`${label}: ${(e.loaded/e.total*100).toFixed(0)}% of ${recFmtB(e.total)}`;};
  x.onload=()=>{let r;try{r=JSON.parse(x.responseText);}catch(e){r={ok:false,error:"server answered "+x.status};}res(r);};
  x.onerror=()=>res({ok:false,error:"connection lost"});x.send(file);});}
/* raw videos */
const RV_FROM={folder:"video folder",recording:"recorded (tab 8)",raw:"uploaded / made here"};
function rvLoad(){el("rvSumm").textContent="reading ...";return get("/api/raw/videos").then(d=>{RV=d.videos||[];rvDraw();});}
function rvDraw(){el("rvFilt").innerHTML=[["all","all"],["folder","video folder"],["recording","recorded"],["raw","uploaded / made"]].map(([k,l])=>
    `<button class="${RVF===k?'on':''}" onclick="RVF='${k}';rvDraw()">${l} (${k==="all"?RV.length:RV.filter(v=>v.source===k).length})</button>`).join(" ");
  const L=RV.filter(v=>RVF==="all"||v.source===RVF);el("rvSumm").textContent=`${L.length} video(s) · ${(L.reduce((a,v)=>a+(v.size_mb||0),0)/1024).toFixed(1)} GB`;
  el("rvTbl").innerHTML=`<tr><th>video</th><th>from</th><th>length</th><th class=num>size</th><th>picture</th><th>key frame every</th><th>info</th><th>Serve RTSP streams</th><th></th></tr>`+
   L.map(v=>{const m=v.meta||{},lk=m.leak||{},bad=(lk.n_benchmark||0)+(lk.n_reserved_day||0);
    const info=m.kind==="made from frames"?`made from ${m.frames} frames (${(m.sets||[]).length} set(s)), ${m.mode==="rate"?m.fps+" frames/s":m.hold_s+" s per frame"}, ${esc(m.created||"")}`:
      m.kind==="uploaded"?`uploaded ${esc(m.created||"")}${m.original_name?" as "+esc(m.original_name):""}`:"";
    return `<tr style="border-top:1px solid var(--line)"><td><b>${esc(v.label||v.file)}</b></td><td>${RV_FROM[v.source]||v.source}</td><td>${rsDur(v.duration_s)}</td>
     <td class=num>${v.size_mb} MB</td><td>${esc(v.codec||"?")} ${v.width||"?"}x${v.height||"?"} ${v.fps||"?"} fps</td><td>${v.keyframe_gap_s!=null?v.keyframe_gap_s+" s":"?"}</td>
     <td style="font-size:12.5px;color:var(--dim);max-width:340px">${info}${bad?`<div style="color:var(--bad)">&#9888; contains ${lk.n_benchmark||0} benchmark + ${lk.n_reserved_day||0} reserved-day frames: never train on frames captured from it</div>`:""}</td>
     <td>${(v.streams||[]).map(esc).join(", ")||'<span style="color:var(--dim)">-</span>'}</td>
     <td style="white-space:nowrap"><button style="padding:2px 9px;font-size:12px" onclick="rvPlay('${esc(v.file)}')">&#9654; play</button>
      <button style="padding:2px 9px;font-size:12px" onclick="rsUse('${esc(v.file)}')">use in Serve RTSP</button>
      ${v.source==="raw"?`<button class=dan style="padding:2px 9px;font-size:12px" onclick="rawDel('video','${esc(v.file)}')">delete</button>`:""}</td></tr>`;}).join("")+
   (L.length?"":'<tr><td colspan=9 class=empty>No videos.</td></tr>');}
function rvPlay(file){const f=encodeURIComponent(file),v=RV.find(x=>x.file===file)||{};
  rpStart({title:v.label||file,probe:`/api/rtsp/probe?f=${f}`,direct:`/rsvid?f=${f}&play=1`,convUrl:(t,w)=>`/rsvid?f=${f}&conv=1&t=${t}&w=${w}`,dl:null});}
async function upVideos(){const fs=[...el("upVidFile").files];if(!fs.length){alert("Choose video file(s) first.");return;}
  for(const [i,f] of fs.entries()){const r=await upXhr(`/api/raw/upload?kind=video&file=${encodeURIComponent(f.name)}`,f,"upVidMsg",`${i+1}/${fs.length} ${f.name}`);
    if(!r.ok){el("upVidMsg").innerHTML=`<span style="color:var(--bad)">${esc(f.name)}: ${esc(r.error)}</span>`;return;}}
  el("upVidMsg").textContent=`uploaded ${fs.length} video(s)`;el("upVidFile").value="";RVF="raw";rvLoad();}
/* raw frames */
function rfLoad(again){el("rfSumm").textContent="reading ...";return get("/api/raw/frames").then(d=>{RF=d.sets||[];rfDraw();});}
function rfDraw(){const G=["uploaded","capture events","saved frames","labelled datasets"],q=(el("rfQ").value||"").toLowerCase();
  el("rfFilt").innerHTML=[["all","all"],...G.map(g=>[g,g])].map(([k,l])=>`<button class="${RFG===k?'on':''}" onclick="RFG='${k}';rfDraw()">${l} (${k==="all"?RF.length:RF.filter(x=>x.group===k).length})</button>`).join(" ");
  const L=RF.filter(x=>(RFG==="all"||x.group===RFG)&&(!q||x.label.toLowerCase().includes(q)));
  el("rfSumm").textContent=`${L.length} set(s) · ${L.reduce((a,x)=>a+x.count,0)} frames`;
  el("rfTbl").innerHTML=`<tr><th><input type=checkbox style="width:auto" title="tick all shown" onchange="rfAll(this.checked)"></th><th>first frame</th><th>set</th><th>kind</th><th class=num>frames</th><th>picture</th><th>date</th><th></th></tr>`+
   L.slice(0,400).map(x=>{const on=RFSEL.includes(x.id),m=x.meta||{},lk=m.leak||{},bad=(lk.n_benchmark||0)+(lk.n_reserved_day||0);
    return `<tr style="border-top:1px solid var(--line);${on?"background:#1d2530":""}"><td><input type=checkbox style="width:auto" ${on?"checked":""} onchange="rfTick('${esc(x.id)}',this.checked)"></td>
     <td><img loading=lazy src="/raw/frame?id=${encodeURIComponent(x.id)}&i=0&w=160" style="height:54px;border-radius:4px;cursor:zoom-in" onclick="rfView('${esc(x.id)}')"></td>
     <td><b>${esc(x.label)}</b>${on?` <span class=pill>#${RFSEL.indexOf(x.id)+1}</span>`:""}${bad?`<div style="color:var(--bad);font-size:12px">&#9888; ${lk.n_benchmark||0} benchmark + ${lk.n_reserved_day||0} reserved-day frames</div>`:""}</td>
     <td>${esc(x.group)}</td><td class=num>${x.count}</td><td>${esc(x.picture)}</td><td>${esc(x.date)}</td>
     <td style="white-space:nowrap"><button style="padding:2px 9px;font-size:12px" onclick="rfView('${esc(x.id)}')">view</button>
      ${x.group==="uploaded"?`<button style="padding:2px 9px;font-size:12px" title="rename this uploaded set" onclick="rfRename('${esc(x.id)}')">&#9998; rename</button> <button class=dan style="padding:2px 9px;font-size:12px" onclick="rawDel('frames','${esc(x.id)}')">delete</button>`:""}</td></tr>`;}).join("")+
   (L.length>400?`<tr><td colspan=8 class=hint>showing the first 400; use search to narrow</td></tr>`:"")+(L.length?"":'<tr><td colspan=8 class=empty>No frame sets.</td></tr>');
  mvEst();}
function rfTick(id,on){RFSEL=RFSEL.filter(x=>x!==id);if(on)RFSEL.push(id);rfDraw();}
function rfAll(on){const q=(el("rfQ").value||"").toLowerCase();RF.filter(x=>(RFG==="all"||x.group===RFG)&&(!q||x.label.toLowerCase().includes(q))).slice(0,400).forEach(x=>{RFSEL=RFSEL.filter(y=>y!==x.id);if(on)RFSEL.push(x.id);});rfDraw();}
function rfView(id){const x=RF.find(y=>y.id===id)||{};el("rfPv").style.display="";el("rfPvName").textContent=x.label||id;
  get(`/api/raw/frames/list?id=${encodeURIComponent(id)}`).then(d=>{const fs=d.files||[];el("rfPvN").textContent=fs.length+" frames"+(fs.length>300?" (first 300 shown)":"");
    el("rfPvGrid").innerHTML=fs.slice(0,300).map((f,i)=>`<div><a href="/raw/frame?id=${encodeURIComponent(id)}&i=${i}" target=_blank><img loading=lazy src="/raw/frame?id=${encodeURIComponent(id)}&i=${i}&w=320" style="width:100%;border-radius:6px"></a><div class=hint style="margin:2px 0 0;font-size:11px">${esc(f)}</div></div>`).join("");
    el("rfPv").scrollIntoView({behavior:"smooth"});});}
function mvClear(){RFSEL=[];rfDraw();}
function mvMode(){return (document.querySelector('input[name=mvMode]:checked')||{}).value||"hold";}
function mvEst(){const n=RFSEL.reduce((a,id)=>a+((RF.find(x=>x.id===id)||{}).count||0),0);el("mvBox").style.display=RFSEL.length?"":"none";if(!RFSEL.length)return;
  el("mvCount").textContent=`${RFSEL.length} set(s), ${n} frames`;
  if(!el("mvName").value){const f=RF.find(x=>x.id===RFSEL[0]);el("mvName").value=((f?f.label:"frames")+(RFSEL.length>1?`_and_${RFSEL.length-1}_more`:"")).replace(/[^A-Za-z0-9_-]+/g,"_").slice(0,80);}
  const sec=mvMode()==="rate"?n/Math.max(0.1,+el("mvFps").value||5):n*Math.max(0.04,+el("mvHold").value||1);
  el("mvEst").textContent=`video length about ${rsDur(sec)}; pictures of other sizes get black bars to fit the most common size`;}
function mvMake(){const name=el("mvName").value.trim();el("mvMsg").textContent="starting ...";
  post("/api/raw/make_video",{sets:RFSEL,name,mode:mvMode(),hold_s:+el("mvHold").value,fps:+el("mvFps").value,order:el("mvOrder").value}).then(r=>{
   if(!r.ok){el("mvMsg").innerHTML=`<span style="color:var(--bad)">${esc(r.error)}</span>`;return;}mvPoll(r.name);});}
function mvPoll(name){clearTimeout(MVT);get("/api/raw/job").then(j=>{
  if(j.running){el("mvMsg").textContent=`making ${name}.mp4 from ${j.frames} frames: ${j.pct.toFixed(0)}%`;MVT=setTimeout(()=>mvPoll(name),1000);return;}
  if(j.err){el("mvMsg").innerHTML=`<span style="color:var(--bad)">${esc(j.err)}</span>`;return;}
  el("mvMsg").innerHTML=`done: <b>raw / ${esc(j.done)}</b> <button onclick="rsUse('raw/${esc(j.done)}')">use in Serve RTSP</button> <button onclick="RVF='raw';dsTab('v')">show in Raw videos</button>`;
  el("mvName").value="";});}
async function upFrames(){const fs=[...el("upFrFile").files],name=el("upFrName").value.trim();if(!fs.length){alert("Choose images or a .zip first.");return;}
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(name)){alert("Give the set a name: letters, digits, _ and - only.");return;}
  let r;
  if(fs.length===1&&/\.zip$/i.test(fs[0].name)){r=await upXhr(`/api/raw/upload?kind=frames_zip&name=${encodeURIComponent(name)}&file=${encodeURIComponent(fs[0].name)}`,fs[0],"upFrMsg",fs[0].name);
    if(!r.ok){el("upFrMsg").innerHTML=`<span style="color:var(--bad)">${esc(r.error)}</span>`;return;}
    const sets=r.sets||[],folders=sets.filter(x=>x.folder);
    el("upFrFile").value="";RFG="uploaded";rfLoad(true);
    const lk=r.leak||{},warn=(lk.n_benchmark||lk.n_reserved_day)?` <span style="color:var(--bad)">&#9888; ${lk.n_benchmark} benchmark + ${lk.n_reserved_day} reserved-day frames</span>`:"";
    el("upFrMsg").innerHTML=`uploaded ${sets.length} frame set(s), ${r.frames} frames: ${sets.map(x=>`<b>${esc(x.set)}</b> (${x.frames})`).join(", ")}${warn}`;
    if(folders.length&&el("upAuto").checked){const m=el("upMode").value,v=+el("upVal").value;
      autoStreams(sets.map(x=>x.id),m,v,el("upTogether").checked&&sets.length>1,name,"upFrMsg");}
    return;}
  else{r=await post("/api/raw/new_set",{name});if(!r.ok){el("upFrMsg").innerHTML=`<span style="color:var(--bad)">${esc(r.error)}</span>`;return;}
    for(const [i,f] of fs.entries()){const u=await upXhr(`/api/raw/upload?kind=frame&set=${encodeURIComponent(name)}&file=${encodeURIComponent(f.name)}`,f,"upFrMsg",`${i+1}/${fs.length}`);
      if(!u.ok){el("upFrMsg").innerHTML=`<span style="color:var(--bad)">${esc(f.name)}: ${esc(u.error)} (the ${i} uploaded before it are kept)</span>`;break;}}
    r=await post("/api/raw/finish_set",{name});}
  const L=r.leak||{},bad=(L.n_benchmark||0)+(L.n_reserved_day||0);
  el("upFrMsg").innerHTML=`uploaded set <b>${esc(name)}</b>: ${r.frames||0} frames`+(bad?` <span style="color:var(--bad)">&#9888; ${L.n_benchmark} benchmark + ${L.n_reserved_day} reserved-day frames</span>`:"");
  el("upFrFile").value="";RFG="uploaded";rfLoad(true);}
async function upDataset(){const f=el("upDsFile").files[0],name=el("upDsName").value.trim();if(!f){alert("Choose a .zip first.");return;}
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(name)){alert("Give the dataset a name: letters, digits, _ and - only.");return;}
  const r=await upXhr(`/api/raw/upload?kind=dataset_zip&name=${encodeURIComponent(name)}&file=${encodeURIComponent(f.name)}`,f,"upDsMsg",f.name);
  if(!r.ok){el("upDsMsg").innerHTML=`<span style="color:var(--bad)">${esc(r.error)}</span>`;return;}
  const L=r.leak||{},bad=(L.n_benchmark||0)+(L.n_reserved_day||0);
  el("upDsMsg").innerHTML=`saved as <b>${esc(r.dataset)}</b>: ${r.counts.images} images, ${r.counts.labels} label files`+(bad?` <span style="color:var(--bad)">&#9888; ${L.n_benchmark} benchmark + ${L.n_reserved_day} reserved-day frames: never train on it</span>`:" · no benchmark frames found");
  el("upDsFile").value="";loadDatasets();}

function autoStreams(ids,mode,val,together,group,msg){
  post("/api/raw/auto_streams",{sets:ids,mode,hold_s:val,fps:val,together,group}).then(r=>{
    if(!r.ok){el(msg).innerHTML+=`<br><span style="color:var(--bad)">making the streams: ${esc(r.error)}</span>`;return;}
    const tr=Object.entries(r.trimmed||{});
    el(msg).innerHTML+=`<br>making ${r.videos.length} video(s) → streams ${r.streams.map(esc).join(", ")}`+(together?` in sync group <b>${esc(group)}</b>`:"")+
      (tr.length?`<br><span style="color:var(--warn)">to keep them the same length, the longer folders lose their last frames: ${tr.map(([k,n])=>`${esc(k)} −${n}`).join(", ")}</span>`:"")+`<br><span id=${msg}Job></span>`;
    autoPoll(msg+"Job");});}
function autoPoll(id){clearTimeout(MVT);get("/api/raw/job").then(j=>{const e=el(id);if(!e)return;
  if(j.running){e.textContent=`${j.step||"working"} ${j.pct?j.pct.toFixed(0)+"%":""}`;MVT=setTimeout(()=>autoPoll(id),1000);return;}
  if(j.err){e.innerHTML=`<span style="color:var(--bad)">${esc(j.err)}</span>`;return;}
  e.innerHTML=`<b>done.</b> Streams in Serve RTSP: ${(j.streams||[]).map(s=>`<code>${esc(s.url)}</code>`).join(" ")}`+(j.note?`<br><span style="color:var(--warn)">${esc(j.note)}</span>`:"")+
    ` <button onclick="show('s11')">open Serve RTSP</button>`;});}
function mvAuto(){if(!RFSEL.length)return;const m=mvMode(),v=m==="rate"?+el("mvFps").value:+el("mvHold").value,tog=el("mvTogether").checked&&RFSEL.length>1;
  const g=(el("mvName").value.trim()||"cams").replace(/[^A-Za-z0-9_-]/g,"_").slice(0,32);el("mvMsg").innerHTML="";autoStreams(RFSEL,m,v,tog,g,"mvMsg");}

function rfRename(id){const old=id.slice(3),nw=prompt(`New name for frame set ${old}\n(letters, digits, _ and -)`,old);if(nw===null||nw.trim()===old)return;
  post("/api/raw/rename_set",{old,new:nw.trim()}).then(r=>{if(!r.ok){alert(r.error);return;}
    RFSEL=RFSEL.map(x=>x===id?r.id:x);rfLoad(true);});}

function rsPlayClip(i){const s=RSS[i],saved=JSON.parse(RSO||"[]").find(x=>x.name===s.name);
  if(!saved||JSON.stringify(saved)!==JSON.stringify(s)){alert("This stream has unsaved changes. Press Save and apply first; the clip is made from the saved settings.");return;}
  get(`/api/rtsp/clip?s=${encodeURIComponent(s.name)}`).then(r=>{if(!r.ok){alert(r.error);return;}const f=encodeURIComponent(r.file);
    rpStart({title:`stream ${s.name}: joined clip (${rsDur(r.seconds)}), exactly what the RTSP stream plays`,probe:`/api/rtsp/probe?f=__none__`,dur:r.seconds,
      direct:`/rtclip/${f}`,convUrl:(t,w)=>`/rtclip/${f}?conv=1&t=${t}&w=${w}`,dl:null});});}
