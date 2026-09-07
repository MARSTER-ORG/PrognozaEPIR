'use strict';
(() => {
  const VERSION='TAF Verification v1.0';
  const HISTORY_KEY='prognozaepir-generated-tafs-v1';
  const SKILL_KEY='prognozaepir-taf-skill-v1';
  const RAW_BASE='https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/observations/metar/';
  const VIS_BANDS=[800,1500,3000,5000];
  const CEIL_BANDS=[200,300,500,1000,1500];
  const $=id=>document.getElementById(id);
  const finite=Number.isFinite;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad=(n,w=2)=>String(n).padStart(w,'0');
  const circ=(a,b)=>{let d=Math.abs((a||0)-(b||0))%360;return d>180?360-d:d};
  const kt=ms=>finite(ms)?ms*1.943844:null;
  const ft=m=>finite(m)?m*3.28084:null;

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
    const wx=(s.match(/\b(?:\+|-)?(?:FZFG|FG|BR|HZ|TSRA|TSGR|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)\b/g)||[]).join(' ');
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
  function parseTaf(raw){
    const t=String(raw||'').replace(/\s+/g,' ').trim();
    const im=t.match(/\b(\d{6})Z\b/),vm=t.match(/\b(\d{4})\/(\d{4})\b/);if(!im||!vm)return null;
    const issue=resolve(im[1],Date.now(),true),vs=resolve(vm[1],issue,false);let ve=resolve(vm[2],vs+6*3600e3,false);if(ve<=vs)ve=resolve(vm[2],vs+18*3600e3,false);
    const start=vm.index+vm[0].length,re=/(FM\d{6}|BECMG\s+\d{4}\/\d{4}|(?:PROB30(?:\s+TEMPO)?|TEMPO)\s+\d{4}\/\d{4})/g,marks=[];let m;
    re.lastIndex=start;while((m=re.exec(t)))marks.push({i:m.index,token:m[0],end:re.lastIndex});
    const base=part(t.slice(start,marks.length?marks[0].i:t.length)),events=[];
    for(let i=0;i<marks.length;i++){
      const a=marks[i],body=t.slice(a.end,i+1<marks.length?marks[i+1].i:t.length),state=part(body),ev={token:a.token,state};
      if(a.token.startsWith('FM')){ev.kind='FM';ev.s=resolve(a.token.slice(2),issue,true);ev.e=ve}
      else{const q=a.token.match(/(\d{4})\/(\d{4})/);ev.s=resolve(q[1],issue,false);ev.e=resolve(q[2],ev.s+3*3600e3,false);if(ev.e<=ev.s)ev.e=resolve(q[2],ev.s+12*3600e3,false);ev.kind=a.token.startsWith('BECMG')?'BECMG':a.token.startsWith('PROB30 TEMPO')?'PROB30 TEMPO':a.token.startsWith('PROB30')?'PROB30':'TEMPO'}
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
    let vis=finite(o?.visibility_m)?o.visibility_m:(vm?(vm[1]==='9999'?10000:+vm[1]):(/\bCAVOK\b/.test(raw)?10000:null));
    let ceil=finite(o?.ceiling_m_agl)?ft(o.ceiling_m_agl):(clouds.filter(c=>c.cover==='BKN'||c.cover==='OVC').sort((a,b)=>a.ft-b.ft)[0]?.ft??null);
    return{t:Date.parse(o?.obs_time||0),windDir:finite(o?.wind_direction_deg)?o.wind_direction_deg:(wm&&wm[1]!=='VRB'?+wm[1]:null),windKt:finite(o?.wind_speed_ms)?kt(o.wind_speed_ms):(wm?+wm[2]:null),gustKt:finite(o?.wind_gust_ms)?kt(o.wind_gust_ms):(wm&&wm[3]?+wm[3]:null),vis,ceilingFt:ceil,wxFamily:wxFamily(raw),raw};
  }
  function componentHits(f,o){
    const out={};
    if(finite(f.windKt)&&finite(o.windKt)){
      const speed=Math.abs(f.windKt-o.windKt)<10;
      const dir=(!finite(f.windDir)||!finite(o.windDir)||(f.windKt<10&&o.windKt<10))?true:circ(f.windDir,o.windDir)<60;
      let gust=true;if((f.windKt>=15||o.windKt>=15)&&(finite(f.gustKt)||finite(o.gustKt)))gust=Math.abs((f.gustKt??f.windKt)-(o.gustKt??o.windKt))<10;
      out.wind=speed&&dir&&gust;
      out.speedErr=Math.abs(f.windKt-o.windKt);out.dirErr=finite(f.windDir)&&finite(o.windDir)?circ(f.windDir,o.windDir):null;
    }
    if(finite(o.vis)&&finite(f.vis))out.vis=band(o.vis,VIS_BANDS)===band(f.vis,VIS_BANDS);
    if(f.ceilingFt!==undefined&&o.ceilingFt!==undefined)out.ceiling=band(o.ceilingFt,CEIL_BANDS,true)===band(f.ceilingFt,CEIL_BANDS,true);
    const ff=f.wxFamily??'NONE',of=o.wxFamily??'NONE';out.wx=ff===of;
    return out;
  }
  function bestCoverage(states,o){
    const base=componentHits(states.base,o),result={...base,covered:{}};
    for(const [k,v] of Object.entries(base)){
      if(!['wind','vis','ceiling','wx'].includes(k)||v)continue;
      for(const alt of states.alts){const h=componentHits(alt.state,o);if(h[k]){result[k]=true;result.covered[k]=alt.kind;break}}
    }
    return result;
  }
  function utcDate(ms){const d=new Date(ms);return`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`}
  function datesBetween(a,b){const out=[];let t=Date.UTC(new Date(a).getUTCFullYear(),new Date(a).getUTCMonth(),new Date(a).getUTCDate());const e=Date.UTC(new Date(b).getUTCFullYear(),new Date(b).getUTCMonth(),new Date(b).getUTCDate());for(;t<=e;t+=864e5)out.push(utcDate(t));return out}
  async function fetchDay(day){
    const urls=[`data/observations/metar/${day}.jsonl?_=${Date.now()}`,`${RAW_BASE}${day}.jsonl?raw=${Date.now()}`];
    for(const u of urls){try{const r=await fetch(u,{cache:'no-store'});if(!r.ok)continue;const txt=await r.text();const arr=txt.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch(_){return null}}).filter(Boolean);if(arr.length)return arr}catch(_){}}
    return[];
  }
  async function observationsFor(p){
    const chunks=await Promise.all(datesBetween(p.vs,p.ve).map(fetchDay)),map=new Map();
    for(const o of chunks.flat()){const t=Date.parse(o.obs_time||0);if(t>=p.vs&&t<p.ve)map.set(o.obs_time,o)}
    return[...map.values()].sort((a,b)=>Date.parse(a.obs_time)-Date.parse(b.obs_time));
  }
  function loadHistory(){try{const x=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(x)?x:[]}catch(_){return[]}}
  function saveHistory(a){try{localStorage.setItem(HISTORY_KEY,JSON.stringify(a.slice(-120)))}catch(_){}}
  function remember(raw){
    const p=parseTaf(raw);if(!p||!/^TAF\s+EPIR\b/.test(p.raw))return;
    const a=loadHistory(),key=`${p.issue}|${p.vs}|${p.raw}`;if(a.some(x=>x.key===key))return;
    a.push({key,raw:p.raw,generated_at:new Date().toISOString(),issue:p.issue,valid_start:p.vs,valid_end:p.ve});saveHistory(a);
  }
  function pct(n,d){return d?Math.round(100*n/d):null}
  async function evaluateEntry(entry){
    const p=parseTaf(entry.raw);if(!p)return null;const obs=(await observationsFor(p)).map(metarState).filter(x=>finite(x.t));
    const counts={wind:[0,0],vis:[0,0],ceiling:[0,0],wx:[0,0]},covered={wind:0,vis:0,ceiling:0,wx:0};let se=0,seN=0,de=0,deN=0;
    for(const o of obs){const h=bestCoverage(statesAt(p,o.t),o);for(const k of Object.keys(counts)){if(typeof h[k]==='boolean'){counts[k][1]++;if(h[k])counts[k][0]++;if(h.covered[k])covered[k]++}}if(finite(h.speedErr)){se+=h.speedErr;seN++}if(finite(h.dirErr)){de+=h.dirErr;deN++}}
    const rates=Object.fromEntries(Object.entries(counts).map(([k,[n,d]])=>[k,pct(n,d)]));const valid=Object.values(rates).filter(finite),overall=valid.length?Math.round(valid.reduce((a,b)=>a+b,0)/valid.length):null;
    return{entry,p,obs:obs.length,expected:Math.round((p.ve-p.vs)/1800e3),rates,covered,overall,speedMae:seN?se/seN:null,dirMae:deN?de/deN:null,final:Date.now()>=p.ve+30*60e3};
  }
  function panel(){
    if($('tafVerification'))return;
    const grid=document.querySelector('.grid');if(!grid)return;
    const s=document.createElement('section');s.className='card w12';s.id='tafVerification';s.innerHTML=`<h2>Sprawdzalność generatora TAF</h2><div id="tafVerifySummary" class="note">Od tej wersji każdy wygenerowany TAF jest zapisywany w tej przeglądarce i po zakończeniu ważności porównywany z archiwalnymi METAR EPIR.</div><div class="scroll" style="margin-top:7px"><table style="min-width:900px"><thead><tr><th>TAF / ważność</th><th>METAR</th><th>Wynik</th><th>Wiatr</th><th>VIS</th><th>Pułap</th><th>Pogoda</th><th>Błąd wiatru</th><th>Status</th></tr></thead><tbody id="tafVerifyRows"><tr><td colspan="9">Brak zakończonych TAF do oceny.</td></tr></tbody></table></div><div id="tafVerifyNote" class="note" style="margin-top:6px"></div>`;grid.appendChild(s);
  }
  async function refresh(){
    panel();const a=loadHistory();if(!a.length){$('tafVerifyNote').textContent=`${VERSION} · Historia zacznie się od pierwszej depeszy wygenerowanej po wdrożeniu tej funkcji.`;return}
    const selected=a.slice(-20).reverse(),results=[];for(const e of selected){try{results.push(await evaluateEntry(e))}catch(_){results.push(null)}}
    const good=results.filter(Boolean),finals=good.filter(x=>x.final&&x.obs>0),agg=finals.length?Math.round(finals.reduce((s,x)=>s+(x.overall??0),0)/finals.filter(x=>finite(x.overall)).length):null;
    if(finite(agg)){try{localStorage.setItem(SKILL_KEY,JSON.stringify({version:VERSION,updated_at:new Date().toISOString(),completed:finals.length,overall_pct:agg,parameters:Object.fromEntries(['wind','vis','ceiling','wx'].map(k=>{const v=finals.map(x=>x.rates[k]).filter(finite);return[k,v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):null]}))}))}catch(_){}}
    $('tafVerifySummary').textContent=finals.length?`Zakończone TAF: ${finals.length} · średnia sprawdzalność ${finite(agg)?agg+'%':'—'}. Wynik liczony według istotnych progów TAF; TEMPO/PROB30 może pokryć obserwowane odchylenie.`:'Brak zakończonego okresu. Dla bieżącego TAF pokazywana jest ocena częściowa, jeśli są już METAR-y.';
    $('tafVerifyRows').innerHTML=good.map(x=>{const r=x.rates,c=x.covered,cov=Object.values(c).reduce((a,b)=>a+b,0),st=x.final?'KOŃCOWY':'W TOKU';return`<tr><td><b>${new Date(x.p.issue).toISOString().slice(5,16).replace('T',' ')}</b><br>${new Date(x.p.vs).toISOString().slice(5,16).replace('T',' ')}–${new Date(x.p.ve).toISOString().slice(5,16).replace('T',' ')}</td><td>${x.obs}/${x.expected}</td><td><b>${finite(x.overall)?x.overall+'%':'—'}</b>${cov?`<br><span class="note">${cov} trafień przez TEMPO/PROB30/BECMG</span>`:''}</td><td>${finite(r.wind)?r.wind+'%':'—'}</td><td>${finite(r.vis)?r.vis+'%':'—'}</td><td>${finite(r.ceiling)?r.ceiling+'%':'—'}</td><td>${finite(r.wx)?r.wx+'%':'—'}</td><td>${finite(x.speedMae)?x.speedMae.toFixed(1)+' kt':'—'}${finite(x.dirMae)?` / ${Math.round(x.dirMae)}°`:''}</td><td class="${x.final?'ok':'warn'}">${st}</td></tr>`}).join('')||'<tr><td colspan="9">Brak danych do oceny.</td></tr>';
    $('tafVerifyNote').textContent=`Ocena: wiatr — różnica prędkości <10 kt, kierunku <60° gdy wiatr jest istotny; VIS — ten sam przedział 800/1500/3000/5000 m; pułap — ten sam przedział 200/300/500/1000/1500 ft; pogoda — zgodność głównej rodziny zjawiska. Dane: dzienne archiwa METAR EPIR.`;
  }
  function watch(){
    panel();const el=$('taf');if(!el)return;let last='';const take=()=>{const raw=el.textContent.trim();if(raw===last||!/^TAF\s+EPIR\b/.test(raw))return;last=raw;remember(raw);refresh()};new MutationObserver(take).observe(el,{childList:true,subtree:true,characterData:true});take();refresh();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch,{once:true});else watch();
})();
