'use strict';

// Experimental aviation hazard diagnostics for EPIR -------------------------
// Icing: FIP/CIP-inspired proxy using sub-freezing cloud, humidity, vertical
// motion, precipitation and convective enhancement. Turbulence: GTG-inspired
// proxy using vertical vector shear, Richardson-style stability, vertical
// motion, wind speed and convection. These are diagnostic probabilities, not
// official FIP/GTG products and not aircraft-specific severity forecasts.
(() => {
  if (window.__PrognozaEPIRAviationHazardsV1) return;
  window.__PrognozaEPIRAviationHazardsV1 = true;

  const EPIR = {lat:52.8275, lon:18.3175};
  const LEVELS = [1000,975,950,925,900,850,800,750,700,650,600,550,500,450,400,350,300,275,250,200];
  const RAW = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/runtime/models-latest.json';
  const API = 'https://api.github.com/repos/MARSTER-ORG/PrognozaEPIR/contents/data/runtime/models-latest.json?ref=main';
  const SAME = new URL('data/runtime/models-latest.json', location.href).href;
  const HOUR = 3600000;
  const $ = id => document.getElementById(id);
  const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,Number(v)||0));
  const num = v => (v !== null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
  let snapshot = null;
  let loadPromise = null;
  let renderTimer = 0;

  function parseTime(t){
    const s=String(t||'');
    const ms=Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s)?s:s+'Z');
    return Number.isFinite(ms)?ms:null;
  }
  function fmtUtc(ms){
    if(!Number.isFinite(ms))return'—';
    const d=new Date(ms),dd=String(d.getUTCDate()).padStart(2,'0'),mm=String(d.getUTCMonth()+1).padStart(2,'0'),hh=String(d.getUTCHours()).padStart(2,'0');
    return `${dd}.${mm} ${hh}:00 UTC`;
  }
  function fmtHeight(lo,hi){
    if(!Number.isFinite(lo)&&!Number.isFinite(hi))return'—';
    if(!Number.isFinite(lo))lo=hi;if(!Number.isFinite(hi))hi=lo;
    lo=Math.max(0,lo);hi=Math.max(lo,hi);
    const round30=m=>Math.round(m/30)*30;
    const mlo=round30(lo),mhi=Math.max(mlo,round30(hi));
    const ft=m=>Math.round((m*3.28084)/10)*10;
    const flo=ft(mlo),fhi=ft(mhi);
    return mlo===mhi?`${mlo} m / ${flo} ft AMSL`:`${mlo}–${mhi} m / ${flo}–${fhi} ft AMSL`;
  }
  function riskClass(p){return p>=75?'high':p>=50?'mid':'low';}
  function icingIntensity(s,p){if(p<20)return'brak / małe';if(s>=.72)return'intensywne';if(s>=.46)return'umiarkowane';return'słabe';}
  function turbIntensity(s,p){if(p<20)return'brak / mała';if(s>=.72)return'silna';if(s>=.46)return'umiarkowana';return'słaba';}
  function weightedMean(rows,key){
    let sw=0,sv=0;for(const r of rows){const v=num(r[key]);if(v===null)continue;const w=Math.max(.01,num(r.w)||.05);sw+=w;sv+=w*v;}return sw?sv/sw:null;
  }
  function decodeGithub(j){
    if(!j?.content)return null;
    const raw=atob(String(j.content).replace(/\s/g,''));
    const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  }
  async function fetchJson(url,timeout=7000){
    const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),timeout);
    try{const r=await fetch(url,{cache:'no-store',signal:ctl.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(tm);}
  }
  function validSnapshot(j){return j?.schema==='prognozaepir-model-snapshot-v1'&&Object.keys(j?.models||{}).length>=3;}
  async function loadSnapshot(force=false){
    if(snapshot&&!force)return snapshot;if(loadPromise&&!force)return loadPromise;
    loadPromise=(async()=>{
      const sources=[
        async()=>fetchJson(SAME+'?_='+Date.now(),3500),
        async()=>decodeGithub(await fetchJson(API+'&_='+Date.now(),6000)),
        async()=>fetchJson(RAW+'?_='+Date.now(),6000)
      ];
      for(const get of sources){try{const j=await get();if(validSnapshot(j)){snapshot=j;return j;}}catch(_){}}
      return null;
    })();
    const out=await loadPromise;loadPromise=null;return out;
  }

  function ensureStyle(){
    if($('aviationHazardStyle'))return;
    const st=document.createElement('style');st.id='aviationHazardStyle';st.textContent=`
      .avh-wrap{padding:9px 10px;font-size:10px;line-height:1.4}.avh-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
      .avh-tile{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:64px}.avh-tile small{display:block;color:var(--muted);font-size:8.5px;margin-bottom:3px}.avh-tile b{display:block;font-size:14px;line-height:1.16}.avh-tile span{display:block;color:var(--muted);font-size:8px;margin-top:3px}
      .avh-low{border-color:#27a844!important;box-shadow:inset 0 0 0 1px rgba(39,168,68,.15)}.avh-mid{border-color:#f59f00!important;box-shadow:inset 0 0 0 1px rgba(245,159,0,.18)}.avh-high{border-color:#e03131!important;box-shadow:inset 0 0 0 1px rgba(224,49,49,.20)}
      .avh-windows{margin-top:7px;display:grid;gap:5px}.avh-window{display:grid;grid-template-columns:120px 85px 115px 1fr;gap:6px;align-items:center;background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--blue2);border-radius:7px;padding:6px}.avh-window b{font-size:10px}.avh-window span{font-size:8.5px;color:var(--muted)}
      .avh-note{margin-top:7px;border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:7px;color:var(--muted);font-size:8.5px}.avh-note strong{color:var(--ink)}
      .avh-actions{margin-top:7px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.avh-actions button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:6px 8px;font-size:9px;font-weight:700}.avh-source{color:var(--muted);font-size:8px}
      @media(max-width:700px){.avh-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.avh-window{grid-template-columns:1fr 80px}.avh-window .avh-height{grid-column:1/-1}}
    `;document.head.appendChild(st);
  }
  function card(id,title,kind){
    let c=$(id);if(c)return c;
    const left=document.querySelector('.layout > div:first-child');if(!left)return null;
    c=document.createElement('section');c.id=id;c.className='card';c.style.marginTop='8px';
    c.innerHTML=`<h2>${title}</h2><div class="avh-wrap"><div class="avh-grid">
      <div class="avh-tile" id="${kind}NowTile"><small>Najbliższa godzina</small><b id="${kind}Now">—</b><span id="${kind}NowSub">prawdopodobieństwo</span></div>
      <div class="avh-tile" id="${kind}PeakTile"><small>Maksimum 24 h</small><b id="${kind}Peak">—</b><span id="${kind}PeakSub">—</span></div>
      <div class="avh-tile"><small>Intensywność</small><b id="${kind}Intensity">—</b><span id="${kind}IntensitySub">dla maksimum ryzyka</span></div>
      <div class="avh-tile"><small>Warstwa wysokości</small><b id="${kind}Height">—</b><span>AMSL · modelowy profil pionowy</span></div>
    </div><div class="avh-windows" id="${kind}Windows"><div class="avh-window"><span>Ładowanie profilu NWP…</span></div></div>
    <div class="avh-note" id="${kind}Note"></div><div class="avh-actions"><button type="button" id="${kind}Refresh">Odśwież profil</button><span class="avh-source" id="${kind}Source">—</span></div></div>`;
    const anchor=kind==='ice'?$('convectionNowcastCard'):$('icingHazardCard');
    if(anchor&&anchor.parentElement===left)anchor.insertAdjacentElement('afterend',c);else left.appendChild(c);
    $(kind+'Refresh')?.addEventListener('click',()=>refresh(true));
    return c;
  }
  function ensureCards(){
    ensureStyle();
    card('icingHazardCard','Oblodzenie · prawdopodobieństwo / intensywność / wysokość','ice');
    card('turbulenceHazardCard','Turbulencja · prawdopodobieństwo / intensywność / wysokość','turb');
  }

  function modelConv(h,i,leadHours){
    const cape=Math.max(0,num(h.cape?.[i])||0),li=num(h.lifted_index?.[i]),cin=Math.abs(num(h.convective_inhibition?.[i])||150),code=Math.round(num(h.weather_code?.[i])??-1),rain=Math.max(0,num(h.precipitation?.[i])||0);
    let c=.36*clamp(cape/1600)+.18*(li===null?0:clamp((-li)/6))+.12*clamp((160-cin)/160)+.08*clamp(rain/5);
    if([95,96,99].includes(code))c=Math.max(c,.90);else if([80,81,82].includes(code))c=Math.max(c,.35);
    const live=window.PrognozaEPIRConvectionNowcast;
    if(live&&leadHours<=3.25){
      let tcu=num(live.tcuProbability)||0,cb=num(live.cbProbability)||0;
      if(leadHours>.25&&Array.isArray(live.horizons)&&live.horizons.length){
        const target=leadHours*60;let best=null,bd=Infinity;
        for(const x of live.horizons){const d=Math.abs((num(x.h)||0)-target);if(d<bd){best=x;bd=d;}}
        if(best){tcu=num(best.tcu)??tcu;cb=num(best.cb)??cb;}
      }
      const l=clamp(Math.max(.72*tcu,cb)/100);
      c=Math.max(c,l);
    }
    return clamp(c);
  }
  function tempIcingScore(t){
    if(!Number.isFinite(t)||t>1||t<-30)return 0;
    if(t>0)return 1-t;
    if(t>=-12)return 1;
    if(t>=-18)return 1-(Math.abs(t)-12)*.045;
    if(t>=-25)return .73-(Math.abs(t)-18)*.075;
    return Math.max(0,.205-(Math.abs(t)-25)*.041);
  }
  function pressureRows(model,timeIndex,leadHours){
    const h=model.hourly||{},rows=[];
    for(const p of LEVELS){
      const z=num(h[`geopotential_height_${p}hPa`]?.[timeIndex]);
      const t=num(h[`temperature_${p}hPa`]?.[timeIndex]);
      const rh=num(h[`relative_humidity_${p}hPa`]?.[timeIndex]);
      const cc=num(h[`cloud_cover_${p}hPa`]?.[timeIndex]);
      const ws=num(h[`wind_speed_${p}hPa`]?.[timeIndex]);
      const wd=num(h[`wind_direction_${p}hPa`]?.[timeIndex]);
      const vv=num(h[`vertical_velocity_${p}hPa`]?.[timeIndex]);
      if(z===null||z<0||z>13000)continue;
      rows.push({p,z,t,rh,cc,ws,wd,vv});
    }
    rows.sort((a,b)=>a.z-b.z);
    const conv=modelConv(h,timeIndex,leadHours),precip=Math.max(0,num(h.precipitation?.[timeIndex])||0),freeze=num(h.freezing_level_height?.[timeIndex]);
    return{rows,conv,precip,freeze};
  }
  function icingModel(model,i,leadHours){
    const {rows,conv,precip,freeze}=pressureRows(model,i,leadHours),out=[];
    for(const r of rows){
      if(r.t===null)continue;
      const ts=tempIcingScore(r.t);if(ts<=0)continue;
      const rhS=r.rh===null?0:clamp((r.rh-70)/28),ccS=r.cc===null?0:clamp((r.cc-20)/75);
      const moist=Math.max(rhS*.82,ccS*.88,.58*rhS+.42*ccS);
      if(moist<.08)continue;
      const vvS=r.vv===null?0:clamp(Math.abs(r.vv)/.55),prS=clamp(precip/3);
      const inConvCloud=conv*clamp(Math.max(moist,.35));
      let prob=ts*(.08+.60*moist+.08*prS+.07*vvS+.31*inConvCloud);
      if(freeze!==null&&r.z<freeze-600)prob*=.55;
      prob=clamp(prob);
      const sev=clamp(ts*(.44*moist+.12*prS+.10*vvS+.43*inConvCloud));
      out.push({...r,prob:prob*100,sev});
    }
    return out;
  }
  function uv(ws,dir){if(ws===null||dir===null)return null;const a=dir*Math.PI/180;return{u:-ws*Math.sin(a),v:-ws*Math.cos(a)};}
  function turbulenceModel(model,i,leadHours){
    const {rows,conv}=pressureRows(model,i,leadHours),out=[];
    for(let k=0;k<rows.length-1;k++){
      const a=rows[k],b=rows[k+1],dz=b.z-a.z;if(dz<150||dz>2600)continue;
      const va=uv(a.ws,a.wd),vb=uv(b.ws,b.wd);if(!va||!vb||a.t===null||b.t===null)continue;
      const dv=Math.hypot(vb.u-va.u,vb.v-va.v),shear=dv/dz;
      const thA=(a.t+273.15)*Math.pow(1000/a.p,.286),thB=(b.t+273.15)*Math.pow(1000/b.p,.286),th=(thA+thB)/2;
      const n2=9.80665/Math.max(180,th)*(thB-thA)/dz;
      const ri=shear>1e-5?n2/(shear*shear):99;
      const shS=clamp((shear-.0025)/.0135),riS=n2<=0?1:clamp((.50-ri)/.50),vvS=clamp(Math.max(Math.abs(a.vv||0),Math.abs(b.vv||0))/.8),windS=clamp((Math.max(a.ws||0,b.ws||0)-18)/35);
      const convCloud=Math.max(clamp((a.cc||0)/100),clamp((b.cc||0)/100),.35)*conv;
      const prob=clamp(.34*shS+.24*riS+.08*vvS+.07*windS+.48*convCloud)*100;
      const sev=clamp(.38*shS+.25*riS+.08*vvS+.08*windS+.46*convCloud);
      out.push({p:(a.p+b.p)/2,z:(a.z+b.z)/2,zlo:a.z,zhi:b.z,prob,sev,shear,ri});
    }
    return out;
  }
  function modelTimeIndex(model,targetMs){
    const times=model?.hourly?.time||[];let best=-1,bd=Infinity;
    for(let i=0;i<times.length;i++){const ms=parseTime(times[i]);if(ms===null)continue;const d=Math.abs(ms-targetMs);if(d<bd){bd=d;best=i;}}
    return bd<=35*60000?best:-1;
  }
  function pressureBand(levels,maxRow){
    if(!maxRow||!levels.length)return{lo:null,hi:null};
    const threshold=Math.max(25,maxRow.prob*.58),sorted=levels.slice().sort((a,b)=>a.z-b.z),idx=sorted.indexOf(maxRow);let lo=idx,hi=idx;
    while(lo>0&&sorted[lo-1].prob>=threshold&&sorted[lo].z-sorted[lo-1].z<1900)lo--;
    while(hi<sorted.length-1&&sorted[hi+1].prob>=threshold&&sorted[hi+1].z-sorted[hi].z<1900)hi++;
    return{lo:sorted[lo].zlo??sorted[lo].z,hi:sorted[hi].zhi??sorted[hi].z};
  }
  function ensembleAt(snap,targetMs,kind){
    const byP=new Map(),perModel=[];const lead=Math.max(0,(targetMs-Date.now())/HOUR);
    for(const [id,m] of Object.entries(snap.models||{})){
      const i=modelTimeIndex(m,targetMs);if(i<0)continue;const w=Math.max(.01,num(m.base_weight)||.05),levels=kind==='ice'?icingModel(m,i,lead):turbulenceModel(m,i,lead);
      if(!levels.length)continue;perModel.push({id,w,levels});
      for(const r of levels){const key=Math.round(r.p);if(!byP.has(key))byP.set(key,[]);byP.get(key).push({...r,w,model:id});}
    }
    const levels=[];
    for(const [p,items] of byP){
      const prob=weightedMean(items,'prob'),sev=weightedMean(items,'sev'),z=weightedMean(items,'z');if(prob===null||z===null)continue;
      const zlo=weightedMean(items,'zlo'),zhi=weightedMean(items,'zhi'),support=items.filter(x=>x.prob>=30).length;
      levels.push({p,z,prob,sev:sev||0,zlo:zlo??z,zhi:zhi??z,support,available:items.length});
    }
    levels.sort((a,b)=>a.z-b.z);if(!levels.length)return null;
    const max=levels.reduce((a,b)=>!a||b.prob>a.prob?b:a,null),band=pressureBand(levels,max);
    const availableModels=perModel.length,supportModels=perModel.filter(m=>m.levels.some(r=>Math.abs(r.z-max.z)<1700&&r.prob>=30)).length;
    return{time:targetMs,prob:max.prob,sev:max.sev,band,level:max,levels,availableModels,supportModels};
  }
  function timeline(snap,kind){
    const times=new Set(),now=Date.now(),end=now+24*HOUR;
    for(const m of Object.values(snap.models||{}))for(const t of (m?.hourly?.time||[])){const ms=parseTime(t);if(ms!==null&&ms>=now-30*60000&&ms<=end)times.add(ms);}
    return [...times].sort((a,b)=>a-b).map(ms=>ensembleAt(snap,ms,kind)).filter(Boolean);
  }
  function windows(rows){
    const active=rows.filter(r=>r.prob>=30),out=[];if(!active.length)return out;let cur=null;
    for(const r of active){
      if(!cur||r.time-cur.end>1.6*HOUR){cur={start:r.time,end:r.time,peak:r};out.push(cur);}else{cur.end=r.time;if(r.prob>cur.peak.prob)cur.peak=r;}
    }
    return out.slice(0,4);
  }
  function setRisk(el,p){const host=$(el);if(!host)return;host.classList.remove('avh-low','avh-mid','avh-high');host.classList.add('avh-'+riskClass(p));}
  function renderKind(kind,rows,source){
    const now=rows[0]||null,peak=rows.reduce((a,b)=>!a||b.prob>a.prob?b:a,null),ws=windows(rows),isIce=kind==='ice';
    if(!peak){$(kind+'Windows').innerHTML='<div class="avh-window"><span>Brak wystarczającego profilu pionowego w aktualnym snapshotcie.</span></div>';return;}
    $(kind+'Now').textContent=now?Math.round(now.prob)+'%':'—';$(kind+'NowSub').textContent=now?`${isIce?icingIntensity(now.sev,now.prob):turbIntensity(now.sev,now.prob)} · ${fmtHeight(now.band.lo,now.band.hi)}`:'—';
    $(kind+'Peak').textContent=Math.round(peak.prob)+'%';$(kind+'PeakSub').textContent=fmtUtc(peak.time);
    $(kind+'Intensity').textContent=isIce?icingIntensity(peak.sev,peak.prob):turbIntensity(peak.sev,peak.prob);$(kind+'IntensitySub').textContent=`modele zgodne ${peak.supportModels}/${peak.availableModels}`;
    $(kind+'Height').textContent=fmtHeight(peak.band.lo,peak.band.hi);setRisk(kind+'NowTile',now?.prob||0);setRisk(kind+'PeakTile',peak.prob);
    if(ws.length){
      $(kind+'Windows').innerHTML=ws.map(w=>{const p=w.peak,cls=riskClass(p.prob),intensity=isIce?icingIntensity(p.sev,p.prob):turbIntensity(p.sev,p.prob),end=w.end>w.start?` → ${fmtUtc(w.end)}`:'';return `<div class="avh-window avh-${cls}"><b>${fmtUtc(w.start)}${end}</b><b>${Math.round(p.prob)}%</b><span>${intensity}</span><span class="avh-height">${fmtHeight(p.band.lo,p.band.hi)} · zgodność ${p.supportModels}/${p.availableModels}</span></div>`;}).join('');
    }else $(kind+'Windows').innerHTML='<div class="avh-window avh-low"><b>Najbliższe 24 h</b><span>brak warstwy z prawdopodobieństwem ≥30%</span></div>';
    $(kind+'Source').textContent=`NWP ensemble · ${source}`;
  }
  function renderNotes(){
    const conv=window.PrognozaEPIRConvectionNowcast,cp=conv?Math.round(Math.max(num(conv.tcuProbability)||0,num(conv.cbProbability)||0)):null;
    $('iceNote').innerHTML='<strong>Metoda:</strong> warstwa chmurowa/wilgotna + temperatura poniżej 0°C (największa waga 0…−15°C) + opad + ruch pionowy + poziom 0°C. TCu/Cb daje silne dodatnie wzmocnienie w warstwie przechłodzonej. Bez bezpośredniego LWC/SLD intensywność jest wskaźnikiem, nie oficjalnym FIP.'+(cp!==null?` Aktualny sygnał TCu/Cb: <strong>${cp}%</strong>.`:'');
    $('turbNote').innerHTML='<strong>Metoda:</strong> pionowe ścinanie wektora wiatru + stabilność/Richardson proxy + ruch pionowy + silny wiatr + składnik konwekcyjny. Przy TCu/Cb składnik konwekcyjny ma dużą wagę. To diagnostyka GTG-inspirowana; nie jest wyliczeniem EDR ani oficjalnym GTG.';
  }
  function expose(ice,turb){
    window.PrognozaEPIRAviationHazards={updatedAt:new Date().toISOString(),location:EPIR,icing:ice,turbulence:turb,experimental:true};
    window.dispatchEvent(new CustomEvent('prognozaepir:aviation-hazards-updated',{detail:window.PrognozaEPIRAviationHazards}));
  }
  async function refresh(force=false){
    ensureCards();
    if(force){snapshot=null;loadPromise=null;}
    $('iceWindows').innerHTML='<div class="avh-window"><span>Aktualizuję profil pionowy…</span></div>';
    $('turbWindows').innerHTML='<div class="avh-window"><span>Aktualizuję profil pionowy…</span></div>';
    const snap=await loadSnapshot(force);
    if(!snap){for(const k of['ice','turb']){$(k+'Windows').innerHTML='<div class="avh-window"><span>Nie udało się pobrać snapshotu modeli.</span></div>';$(k+'Source').textContent='brak danych';}return;}
    const ice=timeline(snap,'ice'),turb=timeline(snap,'turb'),src=`${Object.keys(snap.models||{}).length} modeli · ${String(snap.generated_at||'').replace('T',' ').slice(0,16)} UTC`;
    renderKind('ice',ice,src);renderKind('turb',turb,src);renderNotes();expose(ice,turb);
  }
  function schedule(ms=250){clearTimeout(renderTimer);renderTimer=setTimeout(()=>refresh(false),ms);}
  ensureCards();schedule(900);
  window.addEventListener('prognozaepir:convection-nowcast-updated',()=>schedule(150));
  for(const id of['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>schedule(1200));
  setInterval(()=>{if(!document.hidden)refresh(true);},15*60*1000);
})();
