'use strict';
(() => {
  const VERSION='TAF Verification v2.0';
  const BLOCKED_SKILL_KEY='prognozaepir-taf-skill-v1';
  const CENTRAL_RAW_BASE='https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages/';
  const VIS_BANDS=[800,1500,3000,5000];
  const CEIL_BANDS=[200,300,500,1000,1500];
  const PARAMS=['wind','vis','ceiling','wx'];
  const LABELS={wind:'Wiatr',vis:'Widzialność',ceiling:'Pułap',wx:'Pogoda'};
  const $=id=>document.getElementById(id);
  const finite=Number.isFinite;
  const pad=(n,w=2)=>String(n).padStart(w,'0');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const circ=(a,b)=>{let d=Math.abs((a||0)-(b||0))%360;return d>180?360-d:d};
  const kt=ms=>finite(ms)?ms*1.943844:null;
  const ft=m=>finite(m)?m*3.28084:null;
  const pct=(n,d)=>d?Math.round(100*n/d):null;

  // TAF history is verification-only. Do not allow the old inline verifier to
  // persist a "skill" object that could later be mistaken for learning data.
  try{localStorage.removeItem(BLOCKED_SKILL_KEY)}catch(_){ }
  try{
    const proto=Object.getPrototypeOf(localStorage);
    if(proto&&!proto.__tafVerificationLearningBlocked){
      const nativeSet=proto.setItem;
      Object.defineProperty(proto,'__tafVerificationLearningBlocked',{value:true,configurable:false});
      proto.setItem=function(k,v){if(String(k)===BLOCKED_SKILL_KEY)return;return nativeSet.call(this,k,v)};
    }
  }catch(_){ }

  function utcDate(ms){
    const d=new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  }
  function dayStart(day){
    const m=String(day||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m?Date.UTC(+m[1],+m[2]-1,+m[3]):NaN;
  }
  function shiftDay(day,delta){const t=dayStart(day);return finite(t)?utcDate(t+delta*864e5):day}
  function fmtHm(ms){return finite(ms)?new Date(ms).toISOString().slice(11,16):'—'}
  function fmtDayHm(ms){return finite(ms)?new Date(ms).toISOString().slice(5,16).replace('T',' '):'—'}
  function cycleLabel(p){
    if(!p)return'—';
    return `${fmtHm(p.vs)}–${fmtHm(p.ve)} UTC`;
  }
  function resolve(code,ref=Date.now(),minutes=false){
    if(!/^\d{4,6}$/.test(code))return null;
    const day=+code.slice(0,2),hour=+code.slice(2,4),minute=minutes?+code.slice(4,6):0,r=new Date(ref);
    let best=null,delta=Infinity;
    for(let dm=-1;dm<=1;dm++){
      const t=Date.UTC(r.getUTCFullYear(),r.getUTCMonth()+dm,day,hour,minute),d=Math.abs(t-ref);
      if(d<delta){delta=d;best=t}
    }
    return best;
  }
  function band(v,arr,missingTop=false){
    if(!finite(v))return missingTop?arr.length:null;
    for(let i=0;i<arr.length;i++)if(v<arr[i])return i;
    return arr.length;
  }
  function wxFamily(raw){
    const s=' '+String(raw||'').toUpperCase()+' ';
    if(/\bTS(?:RA|SN|GR|GS)?\b/.test(s))return'TS';
    if(/\b(?:FZRA|FZDZ|FZFG)\b/.test(s))return'FZ';
    if(/\b(?:SN|SHSN|RASN|SNRA)\b/.test(s))return'SN';
    if(/\bMIFG\b/.test(s))return'MIFG';
    if(/\bFG\b/.test(s))return'FG';
    if(/\bBR\b/.test(s))return'BR';
    if(/\b(?:SHRA|RA|DZ)\b/.test(s))return'RA';
    if(/\b(?:GR|GS|SQ)\b/.test(s))return'OTHER';
    return'NONE';
  }
  function part(txt){
    const s=String(txt||'').replace(/\s+/g,' ').trim();
    const w=s.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(P99|\d{2,3}))?KT\b/);
    const vm=s.match(/\b(9999|\d{4})\b/);
    const clouds=[...s.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]||''}));
    const cavok=/\bCAVOK\b/.test(s),nsc=/\bNSC\b/.test(s),nsw=/\bNSW\b/.test(s);
    const wx=(s.match(/\b(?:\+|-)?(?:MIFG|FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)\b/g)||[]).join(' ');
    const out={};
    if(w){out.windDir=w[1]==='VRB'?null:+w[1];out.vrb=w[1]==='VRB';out.windKt=+w[2];out.gustKt=w[3]?w[3]==='P99'?100:+w[3]:null}
    if(cavok){out.vis=10000;out.clouds=[];out.wx='';out.wxFamily='NONE';out.cavok=true}
    else{
      if(vm)out.vis=vm[1]==='9999'?10000:+vm[1];
      if(wx){out.wx=wx;out.wxFamily=wxFamily(wx)}else if(nsw){out.wx='';out.wxFamily='NONE';out.nsw=true}
      if(clouds.length)out.clouds=clouds;else if(nsc){out.clouds=[];out.nsc=true}
    }
    out.ceilingFt=(out.clouds||[]).filter(c=>c.cover==='BKN'||c.cover==='OVC').sort((a,b)=>a.ft-b.ft)[0]?.ft??null;
    return out;
  }
  function merge(a,b){const o={...(a||{})};for(const k of Object.keys(b||{}))o[k]=b[k];return o}
  function parseTaf(raw,ref=Date.now()){
    const t=String(raw||'').replace(/\s+/g,' ').trim();
    const im=t.match(/\b(\d{6})Z\b/),vm=t.match(/\b(\d{4})\/(\d{4})\b/);if(!im||!vm)return null;
    const issue=resolve(im[1],ref,true),vs=resolve(vm[1],issue,false);let ve=resolve(vm[2],vs+6*3600e3,false);if(ve<=vs)ve=resolve(vm[2],vs+18*3600e3,false);
    const start=vm.index+vm[0].length,re=/(FM\d{6}|BECMG\s+\d{4}\/\d{4}|(?:PROB30(?:\s+TEMPO)?|TEMPO)\s+\d{4}\/\d{4})/g,marks=[];let m;
    re.lastIndex=start;while((m=re.exec(t)))marks.push({i:m.index,token:m[0],end:re.lastIndex});
    const base=part(t.slice(start,marks.length?marks[0].i:t.length)),events=[];
    for(let i=0;i<marks.length;i++){
      const a=marks[i],body=t.slice(a.end,i+1<marks.length?marks[i+1].i:t.length),state=part(body),ev={token:a.token,state};
      if(a.token.startsWith('FM')){ev.kind='FM';ev.s=resolve(a.token.slice(2),issue,true);ev.e=ve}
      else{
        const q=a.token.match(/(\d{4})\/(\d{4})/);ev.s=resolve(q[1],issue,false);ev.e=resolve(q[2],ev.s+3*3600e3,false);if(ev.e<=ev.s)ev.e=resolve(q[2],ev.s+12*3600e3,false);
        ev.kind=a.token.startsWith('BECMG')?'BECMG':a.token.startsWith('PROB30 TEMPO')?'PROB30 TEMPO':a.token.startsWith('PROB30')?'PROB30':'TEMPO';
      }
      events.push(ev);
    }
    return{raw:t,issue,vs,ve,base,events};
  }
  function statesAt(p,t){
    let st={...p.base},transition=null,alts=[];
    for(const e of p.events){
      if(e.kind==='FM'&&t>=e.s)st={...e.state};
      else if(e.kind==='BECMG'){
        if(t>=e.e)st=merge(st,e.state);
        else if(t>=e.s&&t<e.e)transition=merge(st,e.state);
      }
    }
    for(const e of p.events)if((e.kind==='TEMPO'||e.kind.startsWith('PROB30'))&&t>=e.s&&t<e.e)alts.push({kind:e.kind,state:merge(st,e.state)});
    if(transition)alts.unshift({kind:'BECMG transition',state:transition});
    return{base:st,alts};
  }
  function metarState(o){
    const raw=String(o?.raw||'');
    const wm=raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/),vm=raw.match(/\b(9999|\d{4})\b/);
    const clouds=[...raw.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})/g)].map(m=>({cover:m[1],ft:+m[2]*100}));
    const vis=finite(o?.visibility_m)?o.visibility_m:(vm?(vm[1]==='9999'?10000:+vm[1]):(/\bCAVOK\b/.test(raw)?10000:null));
    const ceil=finite(o?.ceiling_m_agl)?ft(o.ceiling_m_agl):(clouds.filter(c=>c.cover==='BKN'||c.cover==='OVC').sort((a,b)=>a.ft-b.ft)[0]?.ft??null);
    return{t:Date.parse(o?.obs_time||0),windDir:finite(o?.wind_direction_deg)?o.wind_direction_deg:(wm&&wm[1]!=='VRB'?+wm[1]:null),windKt:finite(o?.wind_speed_ms)?kt(o.wind_speed_ms):(wm?+wm[2]:null),gustKt:finite(o?.wind_gust_ms)?kt(o.wind_gust_ms):(wm&&wm[3]?+wm[3]:null),vis,ceilingFt:ceil,wxFamily:wxFamily(raw),raw};
  }
  function componentHits(f,o){
    const out={};
    if(finite(f.windKt)&&finite(o.windKt)){
      const speed=Math.abs(f.windKt-o.windKt)<10;
      const dir=(!finite(f.windDir)||!finite(o.windDir)||(f.windKt<10&&o.windKt<10))?true:circ(f.windDir,o.windDir)<60;
      let gust=true;
      if((f.windKt>=15||o.windKt>=15)&&(finite(f.gustKt)||finite(o.gustKt)))gust=Math.abs((f.gustKt??f.windKt)-(o.gustKt??o.windKt))<10;
      out.wind=speed&&dir&&gust;
      out.speedErr=Math.abs(f.windKt-o.windKt);
      out.dirErr=finite(f.windDir)&&finite(o.windDir)?circ(f.windDir,o.windDir):null;
    }
    if(finite(o.vis)&&finite(f.vis))out.vis=band(o.vis,VIS_BANDS)===band(f.vis,VIS_BANDS);
    if(f.ceilingFt!==undefined&&o.ceilingFt!==undefined)out.ceiling=band(o.ceilingFt,CEIL_BANDS,true)===band(f.ceilingFt,CEIL_BANDS,true);
    out.wx=(f.wxFamily??'NONE')===(o.wxFamily??'NONE');
    return out;
  }
  function bestCoverage(states,o){
    const base=componentHits(states.base,o),result={...base,covered:{},matchedState:states.base};
    for(const [k,v] of Object.entries(base)){
      if(!PARAMS.includes(k)||v)continue;
      for(const alt of states.alts){
        const h=componentHits(alt.state,o);
        if(h[k]){result[k]=true;result.covered[k]=alt.kind;break}
      }
    }
    return result;
  }
  function datesBetween(a,b){
    const out=[];let t=Date.UTC(new Date(a).getUTCFullYear(),new Date(a).getUTCMonth(),new Date(a).getUTCDate());
    const e=Date.UTC(new Date(b).getUTCFullYear(),new Date(b).getUTCMonth(),new Date(b).getUTCDate());
    for(;t<=e;t+=864e5)out.push(utcDate(t));
    return out;
  }
  async function fetchJsonl(urls){
    for(const u of urls){
      try{
        const r=await fetch(u,{cache:'no-store'});if(!r.ok)continue;
        const txt=await r.text();
        const arr=txt.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch(_){return null}}).filter(Boolean);
        if(arr.length)return arr;
      }catch(_){ }
    }
    return[];
  }
  function centralDayUrls(kind,day){
    const [y,m,d]=day.split('-');
    return [
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`,
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${Date.now()}`
    ];
  }
  function centralDayUrls(kind,day){
    const [y,m,d]=day.split('-');
    return [
      `data/messages/${kind}/${y}/${m}/${d}.jsonl?_=${Date.now()}`,
      `${CENTRAL_RAW_BASE}${kind}/${y}/${m}/${d}.jsonl?raw=${Date.now()}`
    ];
  }
  async function fetchMetarDay(day){
    const [metar,speci]=await Promise.all([
      fetchJsonl(centralDayUrls('metar',day)),
      fetchJsonl(centralDayUrls('speci',day))
    ]);
    return [...metar,...speci];
  }
  async function fetchTafIssueDay(day){
    return fetchJsonl(centralDayUrls('taf',day));
  }
  async function observationsFor(p){
    const chunks=await Promise.all(datesBetween(p.vs,p.ve).map(fetchMetarDay)),map=new Map();
    for(const o of chunks.flat()){
      const t=Date.parse(o.obs_time||0);
      if(t>=p.vs&&t<p.ve)map.set(o.obs_time,o);
    }
    return[...map.values()].sort((a,b)=>Date.parse(a.obs_time)-Date.parse(b.obs_time));
  }
  function normalizeRecord(r){
    if(!r||r.station!=='EPIR'||String(r.type||'').toUpperCase()!=='TAF'||!r.raw)return null;
    const ref=Date.parse(r.issue_time||r.message_time||0)||Date.now();
    const p=parseTaf(r.raw,ref);if(!p)return null;
    const issue=Date.parse(r.issue_time||0),vs=Date.parse(r.valid_start||0),ve=Date.parse(r.valid_end||0);
    if(finite(issue))p.issue=issue;if(finite(vs))p.vs=vs;if(finite(ve))p.ve=ve;
    return{raw:r.raw,source:r.source||'archiwum EPIR',source_url:r.source_url||'',issue_time:r.issue_time||null,valid_start:r.valid_start||null,valid_end:r.valid_end||null,record:r,p};
  }
  async function tafsForValidityDay(day){
    const target=dayStart(day),end=target+864e5;
    const issueDays=[shiftDay(day,-1),day];
    const chunks=await Promise.all(issueDays.map(fetchTafIssueDay));
    const entries=chunks.flat().map(normalizeRecord).filter(Boolean).filter(e=>e.p.ve>target&&e.p.vs<end);
    const seen=new Set(),unique=[];
    for(const e of entries.sort((a,b)=>a.p.issue-b.p.issue)){
      const key=e.raw.replace(/\s+/g,' ').trim();
      if(seen.has(key))continue;seen.add(key);unique.push(e);
    }
    return unique.sort((a,b)=>a.p.vs-b.p.vs||a.p.issue-b.p.issue);
  }
  function forecastText(f){
    const wind=finite(f.windKt)?`${finite(f.windDir)?pad(Math.round(f.windDir),3):'VRB'}${pad(Math.round(f.windKt),2)}${finite(f.gustKt)?'G'+pad(Math.round(f.gustKt),2):''}KT`:'—';
    const vis=finite(f.vis)?(f.vis>=10000?'≥10 km':`${Math.round(f.vis)} m`):'—';
    const ceil=finite(f.ceilingFt)?`${Math.round(f.ceilingFt)} ft`:'brak BKN/OVC';
    const wx=f.wxFamily??'NONE';
    return `${wind} · VIS ${vis} · pułap ${ceil} · WX ${wx}`;
  }
  function observedText(o){
    const wind=finite(o.windKt)?`${finite(o.windDir)?pad(Math.round(o.windDir),3):'VRB'}${pad(Math.round(o.windKt),2)}${finite(o.gustKt)?'G'+pad(Math.round(o.gustKt),2):''}KT`:'—';
    const vis=finite(o.vis)?(o.vis>=10000?'≥10 km':`${Math.round(o.vis)} m`):'—';
    const ceil=finite(o.ceilingFt)?`${Math.round(o.ceilingFt)} ft`:'brak BKN/OVC';
    return `${wind} · VIS ${vis} · pułap ${ceil} · WX ${o.wxFamily??'NONE'}`;
  }
  function groupSummary(p,obs){
    const out=[];
    for(const e of p.events){
      const relevant=obs.filter(o=>o.t>=e.s&&o.t<(e.e||p.ve));
      if(!relevant.length){out.push({kind:e.kind,token:e.token,status:'brak METAR w okresie',ok:null});continue}
      if(e.kind==='FM'||e.kind==='BECMG'){
        let good=0,total=0;
        for(const o of relevant){
          const h=componentHits(statesAt(p,o.t).base,o);
          for(const k of PARAMS)if(typeof h[k]==='boolean'){total++;if(h[k])good++}
        }
        out.push({kind:e.kind,token:e.token,status:total?`${pct(good,total)}% zgodności po zmianie`:'brak danych',ok:total?good/total>=.75:null});
      }else{
        let observed=false;
        for(const o of relevant){
          const base=statesAt(p,o.t).base,alt=merge(base,e.state),h=componentHits(alt,o);
          const keys=[];
          if(finite(e.state.windKt))keys.push('wind');
          if(finite(e.state.vis))keys.push('vis');
          if(Object.prototype.hasOwnProperty.call(e.state,'ceilingFt'))keys.push('ceiling');
          if(Object.prototype.hasOwnProperty.call(e.state,'wxFamily'))keys.push('wx');
          const used=keys.length?keys:PARAMS.filter(k=>typeof h[k]==='boolean');
          if(used.length&&used.every(k=>h[k]===true)){observed=true;break}
        }
        const prob=e.kind.startsWith('PROB30');
        out.push({kind:e.kind,token:e.token,status:observed?'warunki grupy zaobserwowano':prob?'warunków grupy nie zaobserwowano':'grupy nie potwierdzono',ok:prob?null:observed});
      }
    }
    return out;
  }
  async function evaluateEntry(entry){
    const p=entry.p;const obs=(await observationsFor(p)).map(metarState).filter(x=>finite(x.t));
    const counts=Object.fromEntries(PARAMS.map(k=>[k,[0,0]])),covered=Object.fromEntries(PARAMS.map(k=>[k,0]));
    let se=0,seN=0,de=0,deN=0;const misses=[];
    for(const o of obs){
      const states=statesAt(p,o.t),h=bestCoverage(states,o),bad=[];
      for(const k of PARAMS){
        if(typeof h[k]==='boolean'){
          counts[k][1]++;if(h[k])counts[k][0]++;else bad.push(k);
          if(h.covered[k])covered[k]++;
        }
      }
      if(finite(h.speedErr)){se+=h.speedErr;seN++}if(finite(h.dirErr)){de+=h.dirErr;deN++}
      if(bad.length)misses.push({t:o.t,bad,forecast:states.base,observed:o,covered:h.covered});
    }
    const rates=Object.fromEntries(PARAMS.map(k=>[k,pct(counts[k][0],counts[k][1])]));
    const valid=Object.values(rates).filter(finite),overall=valid.length?Math.round(valid.reduce((a,b)=>a+b,0)/valid.length):null;
    return{entry,p,obs:obs.length,expected:Math.round((p.ve-p.vs)/1800e3),counts,rates,covered,overall,speedMae:seN?se/seN:null,dirMae:deN?de/deN:null,misses,groups:groupSummary(p,obs),final:Date.now()>=p.ve+30*60e3};
  }
  function aggregate(results){
    const counts=Object.fromEntries(PARAMS.map(k=>[k,[0,0]]));
    for(const x of results)for(const k of PARAMS){counts[k][0]+=x.counts[k][0];counts[k][1]+=x.counts[k][1]}
    const rates=Object.fromEntries(PARAMS.map(k=>[k,pct(counts[k][0],counts[k][1])]));
    const vals=Object.values(rates).filter(finite),overall=vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):null;
    return{counts,rates,overall};
  }
  function scoreClass(v){return !finite(v)?'':v>=85?'ok':v>=70?'warn':'bad'}
  function metricCard(label,value,sub=''){
    return `<div style="border:1px solid var(--b);border-radius:7px;padding:7px 9px;min-width:118px;background:var(--s2)"><div class="note">${esc(label)}</div><div class="${scoreClass(value)}" style="font-size:18px;font-weight:700;margin-top:2px">${finite(value)?value+'%':'—'}</div>${sub?`<div class="note">${esc(sub)}</div>`:''}</div>`;
  }
  function installPanel(){
    const old=$('tafVerification');if(old)old.style.display='none';
    if($('tafVerificationV2'))return;
    const grid=document.querySelector('.grid');if(!grid)return;
    const s=document.createElement('section');s.className='card w12';s.id='tafVerificationV2';
    s.innerHTML=`<h2>Sprawdzalność TAF — raport dobowy</h2>
      <div class="note"><b>Wyłącznie weryfikacja.</b> Historyczne TAF-y EPIR nie są przekazywane do Cloud Learning, silnika modeli ani generatora nowej depeszy.</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <button id="tafDayPrev" title="Poprzedni dzień">← dzień</button>
        <input id="tafVerifyDay" type="date" style="border:1px solid var(--b);background:var(--s);color:var(--fg);border-radius:7px;padding:7px 9px;font-size:11px">
        <button id="tafDayNext" title="Następny dzień">dzień →</button>
        <button id="tafDayToday">Dzisiaj UTC</button>
        <button id="tafDayRefresh" class="primary">Policz sprawdzalność</button>
        <span id="tafDayBusy" class="note"></span>
      </div>
      <div id="tafDaySummary" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:9px"></div>
      <div id="tafDayMeta" class="note" style="margin-top:7px"></div>
      <div class="scroll" style="margin-top:8px"><table style="min-width:980px"><thead><tr><th>Cykl / wydanie</th><th>Źródło</th><th>METAR</th><th>Wynik</th><th>Wiatr</th><th>VIS</th><th>Pułap</th><th>WX</th><th>Status</th></tr></thead><tbody id="tafDayRows"><tr><td colspan="9">Wybierz dzień i kliknij „Policz sprawdzalność”.</td></tr></tbody></table></div>
      <div id="tafDayDetails" style="margin-top:8px"></div>
      <div class="note" style="margin-top:8px">Kryteria: wiatr — prędkość &lt;10 kt różnicy i kierunek &lt;60° przy istotnym wietrze; VIS — zgodność przedziału 800/1500/3000/5000 m; pułap — zgodność przedziału 200/300/500/1000/1500 ft; WX — zgodność głównej rodziny zjawiska. TEMPO/PROB30 może pokryć obserwowane odchylenie. PROB30 nie jest oceniane jako „trafione/nietrafione” na podstawie jednego przypadku.</div>`;
    grid.appendChild(s);
    const input=$('tafVerifyDay');input.max=utcDate(Date.now());input.value=utcDate(Date.now());
    $('tafDayPrev').onclick=()=>{input.value=shiftDay(input.value,-1);refreshDay()};
    $('tafDayNext').onclick=()=>{const n=shiftDay(input.value,1),today=utcDate(Date.now());input.value=n>today?today:n;refreshDay()};
    $('tafDayToday').onclick=()=>{input.value=utcDate(Date.now());refreshDay()};
    $('tafDayRefresh').onclick=refreshDay;
    input.onchange=refreshDay;
  }
  function renderDetails(results){
    const host=$('tafDayDetails');
    host.innerHTML=results.map((x,i)=>{
      const missRows=x.misses.slice(0,80).map(m=>`<tr><td>${fmtDayHm(m.t)}</td><td>${m.bad.map(k=>LABELS[k]).join(', ')}</td><td>${esc(forecastText(m.forecast))}</td><td>${esc(observedText(m.observed))}</td></tr>`).join('');
      const groupRows=x.groups.map(g=>`<tr><td>${esc(g.kind)}</td><td>${esc(g.token)}</td><td class="${g.ok===true?'ok':g.ok===false?'bad':''}">${esc(g.status)}</td></tr>`).join('');
      return `<details ${i===0?'open':''} style="border:1px solid var(--b);border-radius:7px;padding:7px;margin-top:6px"><summary><b>${esc(cycleLabel(x.p))}</b> · wynik ${finite(x.overall)?x.overall+'%':'—'} · wydano ${fmtDayHm(x.p.issue)} UTC</summary>
        <pre style="margin-top:7px">${esc(x.entry.raw)}</pre>
        <div class="note" style="margin-top:5px">Źródło: ${esc(x.entry.source)} · METAR ${x.obs}/${x.expected} · średni błąd wiatru ${finite(x.speedMae)?x.speedMae.toFixed(1)+' kt':'—'}${finite(x.dirMae)?' / '+Math.round(x.dirMae)+'°':''}</div>
        <h2 style="margin-top:9px">Grupy zmian</h2><div class="scroll"><table style="min-width:620px"><thead><tr><th>Typ</th><th>Grupa</th><th>Weryfikacja</th></tr></thead><tbody>${groupRows||'<tr><td colspan="3">Brak grup zmian.</td></tr>'}</tbody></table></div>
        <h2 style="margin-top:9px">Największe rozbieżności METAR</h2><div class="scroll"><table style="min-width:850px"><thead><tr><th>UTC</th><th>Parametr</th><th>Prognoza bazowa</th><th>Zaobserwowano</th></tr></thead><tbody>${missRows||'<tr><td colspan="4" class="ok">Brak rozbieżności według przyjętych progów.</td></tr>'}</tbody></table></div>
      </details>`;
    }).join('');
  }
  let tafVerifyBusy=false;async function refreshDay(silent=false){
    silent=silent===true;if(tafVerifyBusy)return;installPanel();const day=$('tafVerifyDay')?.value;if(!day)return;tafVerifyBusy=true;
    if(!silent){$('tafDayBusy').textContent='Ładowanie archiwum TAF i METAR…';$('tafDayRows').innerHTML='<tr><td colspan="9">Liczenie…</td></tr>';$('tafDayDetails').innerHTML='';}
    try{
      const [entries,dayMetars]=await Promise.all([tafsForValidityDay(day),fetchMetarDay(day)]);
      if(!entries.length){
        $('tafDaySummary').innerHTML=metricCard('TAF-y dla dnia',NaN,'brak archiwalnych depesz');
        $('tafDayMeta').textContent=`${day} UTC · brak TAF EPIR w archiwum dla cykli rozpoczynających ważność tego dnia. Archiwum jest budowane od momentu uruchomienia kolektora.`;
        $('tafDayRows').innerHTML='<tr><td colspan="9">Brak zarchiwizowanych TAF EPIR dla wybranego dnia.</td></tr>';
        return;
      }
      const results=[];for(const e of entries){try{const r=await evaluateEntry(e);if(r)results.push(r)}catch(_){ }}
      const agg=aggregate(results),comparisons=results.reduce((s,x)=>s+x.obs,0),complete=results.filter(x=>x.final).length;
      $('tafDaySummary').innerHTML=metricCard('Sprawdzalność ogólna',agg.overall,`${results.length} TAF`)+PARAMS.map(k=>metricCard(LABELS[k],agg.rates[k])).join('');
      $('tafDayMeta').textContent=`${day} UTC · TAF-y: ${results.length} · zakończone: ${complete}/${results.length} · METAR-y w samej dobie: ${dayMetars.length} · porównania TAF↔METAR: ${comparisons}. Cykl 00–12 może pochodzić z TAF wydanego o 23 UTC dnia poprzedniego.`;
      $('tafDayRows').innerHTML=results.map(x=>{
        const r=x.rates,st=x.final?'KOŃCOWY':'W TOKU',cov=Object.values(x.covered).reduce((a,b)=>a+b,0);
        return `<tr><td><b>${esc(cycleLabel(x.p))}</b><br><span class="note">wyd. ${fmtDayHm(x.p.issue)}${/\bAMD\b/.test(x.entry.raw)?' AMD':''}${/\bCOR\b/.test(x.entry.raw)?' COR':''}</span></td><td>${esc(x.entry.source)}</td><td>${x.obs}/${x.expected}</td><td class="${scoreClass(x.overall)}"><b>${finite(x.overall)?x.overall+'%':'—'}</b>${cov?`<br><span class="note">${cov} trafień przez grupy zmian</span>`:''}</td><td>${finite(r.wind)?r.wind+'%':'—'}</td><td>${finite(r.vis)?r.vis+'%':'—'}</td><td>${finite(r.ceiling)?r.ceiling+'%':'—'}</td><td>${finite(r.wx)?r.wx+'%':'—'}</td><td class="${x.final?'ok':'warn'}">${st}</td></tr>`;
      }).join('')||'<tr><td colspan="9">Brak danych do oceny.</td></tr>';
      renderDetails(results);
    }catch(e){
      $('tafDayMeta').textContent='Błąd weryfikacji: '+(e?.message||String(e));
      $('tafDayRows').innerHTML='<tr><td colspan="9" class="bad">Nie udało się policzyć raportu.</td></tr>';
    }finally{tafVerifyBusy=false;$('tafDayBusy').textContent=VERSION+' · auto 60 s · dane TAF tylko do weryfikacji'}
  }
  function start(){installPanel();refreshDay();setInterval(()=>{if(!document.hidden&&$('tafVerifyDay')?.value===utcDate(Date.now()))refreshDay(true)},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('tafVerifyDay')?.value===utcDate(Date.now()))refreshDay(true)})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
