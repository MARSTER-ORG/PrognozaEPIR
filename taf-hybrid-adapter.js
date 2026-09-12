'use strict';
(() => {
  if (!/\/taf\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_TAF_HYBRID_ADAPTER__) return;
  window.__PROGNOZA_EPIR_TAF_HYBRID_ADAPTER__ = true;

  const HOUR = 3600000;
  const KT = 1.9438444924406;
  const FT = 3.2808398950131;
  const ISS = [5, 11, 17, 23];
  const EPIR = {lat:52.83, lon:18.33};
  const NSTA = {
    EPBY:{name:'Bydgoszcz',lat:53.0968,lon:17.9777},
    EPPW:{name:'Powidz',lat:52.3792,lon:17.8539},
    EPKS:{name:'Krzesiny',lat:52.3317,lon:16.9664}
  };
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const pad = (n,w=2) => String(Math.max(0,Math.round(n))).padStart(w,'0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rad = x => x*Math.PI/180;
  const deg = x => (x*180/Math.PI+360)%360;
  const circ = (a,b) => { let d=Math.abs((a||0)-(b||0))%360; return d>180?360-d:d; };
  let activeTaf = '';
  let engine = null;

  function fu(t){const d=new Date(t);return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth()+1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;}
  function monthTime(code,ref,minutes=false){
    const s=String(code||''); if(!/^\d{4,6}$/.test(s)) return NaN;
    const day=+s.slice(0,2),h=+s.slice(2,4),m=minutes?+s.slice(4,6):0,R=new Date(ref),cand=[];
    for(let dm=-1;dm<=1;dm++) cand.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,day,h,m));
    cand.sort((a,b)=>Math.abs(a-ref)-Math.abs(b-ref)); return cand[0];
  }
  function itemTime(x,ref=Date.now()){
    if(!x) return NaN;
    for(const k of ['obs_time','message_time','issue_time','time','timestamp']){const t=Date.parse(x[k]||'');if(finite(t))return t;}
    const m=String(x.raw||x.canonical_raw||'').match(/\b(\d{6})Z\b/); return m?monthTime(m[1],ref,true):NaN;
  }
  function rawOf(x){return String(x?.raw||x?.canonical_raw||'').trim();}
  function newest(a){return a.filter(Boolean).sort((x,y)=>(itemTime(y)||0)-(itemTime(x)||0))[0]||null;}
  function obsRows(recent){
    const out=[]; for(const k of ['metar','speci','aviation']) if(Array.isArray(recent?.[k])) out.push(...recent[k]);
    const seen=new Set(); return out.filter(x=>/\bEPIR\b/.test(rawOf(x))).filter(x=>{const key=x?.message_id||`${itemTime(x)}|${rawOf(x)}`;if(seen.has(key))return false;seen.add(key);return true;});
  }
  function cycles(now=Date.now()){
    const s=new Date(now-12*HOUR);s.setUTCMinutes(0,0,0);const a=[];
    for(let i=0;i<48;i++){const t=s.getTime()+i*HOUR;if(ISS.includes(new Date(t).getUTCHours()))a.push({issue:t,start:t+HOUR,end:t+13*HOUR});}
    return a.filter(x=>x.issue>=now-6*HOUR&&x.issue<=now+24*HOUR);
  }
  function selectedCycle(){
    const a=cycles(), n=+$('cycle')?.value; if(a[n])return a[n];
    const now=Date.now(); return a.reduce((best,x)=>!best||Math.abs(x.issue-now)<Math.abs(best.issue-now)?x:best,null);
  }
  function geo(a,b){
    const p1=rad(a.lat),p2=rad(b.lat),dl=rad(b.lon-a.lon),dp=rad(b.lat-a.lat),q=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    const km=6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q)),y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    return {km,bearing:deg(Math.atan2(y,x))};
  }

  function tafPart(txt){
    const t=String(txt||'').toUpperCase(), wind=t.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(P99|\d{2,3}))?KT\b/),vis=t.match(/\b(9999|\d{4})\b/);
    const clouds=[...t.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]||''}));
    const wx=(t.match(/\b(?:\+|-)?(?:MIFG|FZFG|FG|BR|HZ|TSRA|TSGR|TSGS|TS|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|RA|DZ|SN|GR|GS|SQ)\b/g)||[]).join(' ');
    const out={wx,clouds};
    if(wind){out.windDir=wind[1]==='VRB'?null:+wind[1];out.windKt=+wind[2];out.gustKt=wind[3]?(wind[3]==='P99'?100:+wind[3]):null;}
    if(/\bCAVOK\b/.test(t)){out.vis=10000;out.clouds=[];out.wx='';out.cavok=true;} else if(vis) out.vis=vis[1]==='9999'?10000:+vis[1];
    if(/\bNSC\b/.test(t)) out.clouds=[];
    return out;
  }
  function parseTaf(raw){
    const text=String(raw||'').replace(/\s+/g,' ').trim(),im=text.match(/\b(\d{6})Z\b/),vm=text.match(/\b(\d{4})\/(\d{4})\b/);if(!im||!vm)return null;
    const issue=monthTime(im[1],Date.now(),true),vs=monthTime(vm[1],issue);let ve=monthTime(vm[2],vs+6*HOUR);if(ve<=vs)ve=monthTime(vm[2],vs+18*HOUR);
    const start=vm.index+vm[0].length,re=/(FM\d{6}|BECMG\s+\d{4}\/\d{4}|(?:PROB(?:30|40)(?:\s+TEMPO)?|TEMPO)\s+\d{4}\/\d{4})/g,marks=[];let m;re.lastIndex=start;while((m=re.exec(text)))marks.push({i:m.index,token:m[0],end:re.lastIndex});
    const base=tafPart(text.slice(start,marks.length?marks[0].i:text.length)),events=[];
    for(let i=0;i<marks.length;i++){
      const q=marks[i],body=text.slice(q.end,i+1<marks.length?marks[i+1].i:text.length),ev={token:q.token,state:tafPart(body)};
      if(q.token.startsWith('FM')){ev.kind='FM';ev.s=monthTime(q.token.slice(2),issue,true);ev.e=ve;}
      else {const r=q.token.match(/(\d{4})\/(\d{4})/);ev.s=monthTime(r[1],issue);ev.e=monthTime(r[2],ev.s+3*HOUR);if(ev.e<=ev.s)ev.e=monthTime(r[2],ev.s+12*HOUR);ev.kind=q.token.startsWith('BECMG')?'BECMG':q.token.startsWith('TEMPO')?'TEMPO':'PROB';}
      events.push(ev);
    }
    return {raw:text,issue,vs,ve,base,events};
  }
  function mergeState(a,b){return {...(a||{}),...(b||{})};}
  function tafAt(p,t){
    if(!p||t<p.vs||t>=p.ve)return null;let s={...p.base};
    for(const e of p.events){if(e.kind==='FM'&&t>=e.s)s={...e.state};else if(e.kind==='BECMG'&&t>=e.e)s=mergeState(s,e.state);}
    return s;
  }
  function attachUpstream(rows,neighborParsed){
    for(const row of rows){row.upstream=[];if(!finite(row.WD))continue;
      for(const [id,p] of Object.entries(neighborParsed)){
        const g=geo(EPIR,NSTA[id]),ang=circ(row.WD,g.bearing);let score=Math.max(0,Math.cos(rad(Math.min(90,ang))));score=score*score*Math.exp(-g.km/150);const kt=finite(row.WS)?row.WS*KT:0;if(kt<4)score*=0.35;if(score<0.05)continue;
        const kmh=Math.max(12,kt*1.852),lag=Math.max(0.75,Math.min(6,g.km/kmh)),state=tafAt(p,row.t-lag*HOUR);if(state)row.upstream.push({id,station:id,score,lag,state});
      }
      row.upstream.sort((a,b)=>b.score-a.score);
    }
    return rows;
  }

  async function loadArchive(){
    const A=window.PrognozaEPIRMessageArchive;if(!A)throw Error('MessageArchive niedostępne');
    const req=[A.latest(true),A.recent(true),A.getLatest('AVIATION','EPIR',true),...Object.keys(NSTA).map(id=>A.getLatest('TAF',id,true).catch(()=>null))];
    const v=await Promise.allSettled(req),latest=v[0].status==='fulfilled'?(v[0].value||{}):{},recent=v[1].status==='fulfilled'?v[1].value:null,history=obsRows(recent);
    const observation=newest([v[2].status==='fulfilled'?v[2].value:null,latest.aviation,latest.metar,...history]);
    const neighborRaw={},neighborParsed={};Object.keys(NSTA).forEach((id,i)=>{const x=newest([v[i+3]?.status==='fulfilled'?v[i+3].value:null,latest?.taf_by_station?.[id]]);if(x){neighborRaw[id]=x;const p=parseTaf(rawOf(x));if(p)neighborParsed[id]=p;}});
    const currentTaf=latest?.taf_by_station?.EPIR||latest?.taf||null;
    return {latest,recent,history,observation,neighborRaw,neighborParsed,currentTaf};
  }

  async function meteogramRows(period){
    const f=$('engine'),w=f?.contentWindow;if(!w)throw Error('Brak silnika meteogramu');const deadline=Date.now()+25000;
    while(Date.now()<deadline){try{if(w.eval('typeof consensus!=="undefined"?consensus.length:0')>10)break;}catch(_){}await new Promise(r=>setTimeout(r,300));}
    let data;
    try{
      data=w.eval(`consensus.map(z=>({t:z.t,T:z.T,Td:z.Td,RH:z.RH,RR:z.RR,VIS:z.VIS,WS:z.WS,WD:z.WD,G:z.G,ceiling:z.ceiling,lowH:z.lowH,midH:z.midH,highH:z.highH,oktaL:z.oktaL,oktaM:z.oktaM,oktaH:z.oktaH,wet:z.wet,storm:z.storm,count:z.count,dirSpread:z.dirSpread,mv:MODELS.map((m,i)=>{const ds=datasets.get(m.id),r=ds?sample(ds,z.t):null;if(!r)return null;const p=profile([{row:r,w:1,elevation:ds.elevation}],Number.isFinite(ds.elevation)?ds.elevation:90);return{id:m.id||m.name||('model_'+(i+1)),model:m.id||m.name||('model_'+(i+1)),w:m.w,vis:r.visibility,ceil:ceiling(p),code:r.weather_code,ws:r.wind_speed_10m,wd:r.wind_direction_10m,g:r.wind_gusts_10m}}).filter(Boolean)}))`);
    }catch(e){throw Error('Silnik meteogramu nie udostępnił danych: '+e.message);}
    let fog=[];try{fog=w.PrognozaEPIRFogSeries||[];}catch(_){}
    let mifg=[];try{if(w.PrognozaEPIRMIFG?.refresh)await w.PrognozaEPIRMIFG.refresh();const until=Date.now()+4000;do{mifg=w.PrognozaEPIRMIFG?.getSeries?.()||[];if(mifg.length)break;await new Promise(r=>setTimeout(r,200));}while(Date.now()<until);}catch(_){}
    return (Array.isArray(data)?data:[]).filter(z=>finite(z.t)&&z.t>=period.start&&z.t<period.end).map(z=>{
      const q=fog.find(x=>Math.abs((x.t||x.time||0)-z.t)<1800000),m=mifg.find(x=>Math.abs((x.t||x.time||0)-z.t)<1800000);
      return {...z,fogRisk:Math.max(0,q?.risk||q?.probability||0),mifgRisk:finite(m?.score)?m.score:null};
    });
  }

  function msaFt(){
    const global=+window.PrognozaEPIRTAFConfig?.msaFt;if(finite(global)&&global>0)return global;
    try{const v=+localStorage.getItem('prognozaepir.taf.msaFt');if(finite(v)&&v>0)return v;}catch(_){}
    return null;
  }
  function windText(h,force=false){
    if(force)return'VRB02KT';const raw=finite(h.windKt)?h.windKt:0;if(raw<1)return'00000KT';let s=Math.max(0,Math.round(raw));if(s%2)s++;const vrb=s<3&&(h.dirSpreadDeg>=60||!finite(h.windDir)),d=vrb?'VRB':pad(((Math.round((h.windDir||0)/10)*10)%360)||360,3);let out=d+pad(Math.min(s,98));let g=Math.max(0,Math.round(h.gustKt||0));if(g%2)g++;if(finite(h.gustKt)&&g-s>=10)out+='G'+(g>99?'P99':pad(g));return out+'KT';
  }
  function visText(v){if(!finite(v)||v>=10000)return'9999';if(v<800)return pad(Math.max(0,Math.min(750,Math.round(v/50)*50)),4);if(v<5000)return pad(Math.max(800,Math.min(4900,Math.round(v/100)*100)),4);return pad(Math.min(9000,Math.round(v/1000)*1000),4);}
  function cloudText(h){const a=(h.clouds||[]).slice().sort((x,y)=>x.ft-y.ft);if(!a.length)return'NSC';return a.slice(0,4).map(c=>`${c.cover}${pad(Math.min(999,Math.round(c.ft/100)),3)}${c.type||''}`).join(' ');}
  function wxText(h){const p=h.prob||{};if(p.ts>=0.5)return p.precip>=0.35?'TSRA':'TS';if(p.frozen>=0.5)return'FZRA';if(p.fog>=0.5&&h.visM<=1000)return h.T<=0?'FZFG':'FG';if(p.precip>=0.5)return p.snow>=0.5?'SN':'RA';if(p.fog>=0.3&&h.visM<=5000)return'BR';return'';}
  function upstreamText(h){const a=h.advection;if(!a)return'—';return `${a.station||'TAF'} ${Math.round((a.weight||0)*100)}% · -${Number(a.lagH||0).toFixed(1)}h`;}
  function renderNeighbors(data,rows){
    const host=$('neighborTafs'),sum=$('neighborSummary');if(!host||!sum)return;const first=rows[0]?.upstream||[];
    sum.textContent=first.length?`Najsilniejszy sygnał adwekcyjny dla początku okresu: ${first[0].id}, opóźnienie około ${first[0].lag.toFixed(1)} h. TAF stacji sąsiednich jest miękkim sygnałem wejściowym silnika hybrydowego.`:'Brak wystarczająco silnego sygnału adwekcyjnego z EPBY / EPPW / EPKS.';
    host.innerHTML=Object.keys(NSTA).map(id=>{const g=geo(EPIR,NSTA[id]),q=first.find(x=>x.id===id),x=data.neighborRaw[id];return `<tr><td><b>${id}</b> ${esc(NSTA[id].name)}</td><td>${Math.round(g.bearing)}°</td><td>${Math.round(g.km)} km</td><td>${q?`${Math.round(q.score*100)}% · opóźnienie ${q.lag.toFixed(1)} h`:'brak istotnego napływu'}</td><td><pre style="max-width:650px">${esc(rawOf(x)||'brak danych')}</pre></td></tr>`;}).join('');
  }
  function renderResult(result,data,inputRows){
    activeTaf=result.taf;window.PrognozaEPIRTAFHybridResult=result;window.PrognozaEPIRTAFCurrentGenerated=result.taf;
    if($('taf'))$('taf').textContent=result.taf;
    if($('metar'))$('metar').textContent=rawOf(data.observation)||'Brak METAR/SPECI';
    if($('metarMeta')&&data.observation)$('metarMeta').textContent=`${data.observation.source||data.observation.sources?.[0]?.name||'ARCHIWUM'} · ${fu(itemTime(data.observation))} · najnowszy METAR/SPECI`;
    if($('synop'))$('synop').textContent='Wyłączony z analizy TAF';if($('synopMeta'))$('synopMeta').textContent='SYNOP nie wpływa na silnik hybrydowy.';
    const reasons=result.diagnostics?.reasons||[];if($('reasons'))$('reasons').innerHTML=reasons.length?'<ul>'+reasons.map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>':'Brak istotnych progów wymagających grup zmian.';
    if($('checks'))$('checks').innerHTML=[['PROB40',result.checks.noProb40],['VV',result.checks.noVV],['≤ 5 grup zmian',result.checks.max5],['Okres ważności 12 h',result.checks.periodHours===12]].map(x=>`<li class="${x[1]?'ok':'bad'}">${x[0]}: ${x[1]?'OK':'BŁĄD'}</li>`).join('');
    if($('hours'))$('hours').innerHTML=result.hourly.map(h=>`<tr><td>${pad(new Date(h.t).getUTCHours())}:00 UTC</td><td>${windText(h,!!result.diagnostics?.vrb02)}</td><td>${visText(h.visM)}</td><td>${wxText(h)||'—'}</td><td>${cloudText(h)}</td><td>${finite(h.ceilingFt)?Math.round(h.ceilingFt)+' ft':'—'}</td><td>${Math.round((h.prob?.precip||0)*100)}% / TS ${Math.round((h.prob?.ts||0)*100)}%</td><td>FG ${Math.round((h.prob?.fog||0)*100)}% · LOW VIS ${Math.round((h.prob?.lowVis||0)*100)}%</td><td>${upstreamText(h)}</td></tr>`).join('');
    if($('sources'))$('sources').innerHTML=`<span class="pill ${data.observation?'ok':'bad'}">METAR/SPECI ${data.observation?'✓':'×'}</span><span class="pill warn">SYNOP wyłączony</span><span class="pill ok">Hybrid Engine v${esc(result.version)} ✓</span><span class="pill ok">multimodel ${Math.max(...result.hourly.map(h=>h.modelCount||0),0)} ✓</span><span class="pill ${result.hourly.some(h=>h.advection)?'ok':'warn'}">adwekcja ${result.hourly.some(h=>h.advection)?'✓':'—'}</span><span class="pill ok">MOS/uczenie ${esc(result.learning?.cells??0)} komórek</span><span class="pill ok">TAF Rules ✓</span>`;
    const d=result.diagnostics,v=d?.vrb02,msa=d?.msaMode==='explicit'?`${Math.round(d.msaFt)} ft`:'fallback 5000 ft';if($('conf'))$('conf').textContent=`HYBRID v${result.version}: pewność ${result.confidence}%. Warstwy: ${d.layers.map(x=>`${x.id}:${x.status}`).join(' · ')}. MSA: ${msa}.${v?` VRB02: ${v.count}/${v.total} h ≤02KT (${Math.round(v.share*100)}%), max ${v.max}KT.`:''} Uczenie: ${result.learning?.cells||0} komórek statystycznych.`;
    if($('badge')){$('badge').textContent='HYBRID GOTOWY';$('badge').className='badge ok';}if($('st'))$('st').textContent=fu(Date.now()).slice(6);
    renderNeighbors(data,inputRows);
  }

  async function generate(){
    const c=selectedCycle();if(!c)throw Error('Nie udało się ustalić cyklu TAF');
    if($('badge')){$('badge').textContent='HYBRID — LICZENIE';$('badge').className='badge';}if($('st'))$('st').textContent='archiwum / modele / MOS';if($('taf'))$('taf').textContent='Silnik hybrydowy: odczyt danych i budowa 12 h…';
    const [data,rows0]=await Promise.all([loadArchive(),meteogramRows(c)]);if(rows0.length<8)throw Error(`Niepełny okres: ${rows0.length} h`);
    const rows=attachUpstream(rows0,data.neighborParsed);
    const api=window.PrognozaEPIRTAFHybridEngine;if(!api?.createEngine)throw Error('taf-hybrid-engine.js nie został załadowany');if(!engine)engine=api.createEngine({config:{station:'EPIR'}});
    const result=engine.generate({station:'EPIR',issue:c.issue,start:c.start,end:c.end,rows,observation:data.observation,observations:data.history,msaFt:msaFt(),rowsAlreadyAnchored:false,record:true});
    renderResult(result,data,rows);return result;
  }
  async function guardedGenerate(){try{return await generate();}catch(e){if($('badge')){$('badge').textContent='BŁĄD HYBRID';$('badge').className='badge bad';}if($('st'))$('st').textContent=e.message;if($('taf'))$('taf').textContent='Nie udało się wygenerować projektu TAF: '+e.message;console.error('[TAF Hybrid]',e);return null;}}

  function install(){
    const gen=$('gen'),copy=$('copy');if(!gen)return false;
    gen.onclick=guardedGenerate;gen.dataset.hybridEngine='1';gen.title='Generuj przez taf-hybrid-engine.js';
    if(copy)copy.onclick=async()=>{if(!activeTaf)return;try{await navigator.clipboard.writeText(activeTaf);}catch(_){}copy.textContent='Skopiowano';setTimeout(()=>copy.textContent='Kopiuj TAF',1200);};
    const sub=document.querySelector('.brand .sub');if(sub)sub.textContent='GENERATOR TAF v0.3.0 · HYBRID';
    if($('badge')){$('badge').textContent='HYBRID GOTOWY DO ODŚWIEŻENIA';$('badge').className='badge';}
    if($('st'))$('st').textContent='kliknij Odśwież i generuj';
    return true;
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
