'use strict';
(()=>{
  if(typeof window==='undefined'||typeof document==='undefined'||window.__EPIR_FOG_244_CONTEXT__)return;
  window.__EPIR_FOG_244_CONTEXT__=true;

  const VERSION='2.4.4-context2';
  const HOUR=3600e3;
  const ACTIVE=60;
  const STATIONS=['EPIR','EPBY','EPPW','EPKS'];
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const mean=a=>{const q=(a||[]).filter(finite);return q.length?q.reduce((s,v)=>s+v,0)/q.length:null;};
  const rawOf=x=>String(x?.canonical_raw||x?.raw||x?.message||x?.text||'').replace(/\s+/g,' ').trim();
  const rowTime=x=>{for(const k of ['obs_time','message_time','issue_time','time','timestamp']){const t=Date.parse(x?.[k]||'');if(finite(t))return t;}return NaN;};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const utc=t=>{try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t))+' UTC';}catch(_){return new Date(t).toISOString().slice(5,16).replace('T',' ')+' UTC';}};

  let tafs={};
  let observations=[];
  let contextByTime=new Map();
  let adjusted=[];
  let busy=null;
  let lastSig='';
  let status={updated:null,error:null,tafStations:0,obsCount:0};

  function phen(raw){
    const s=String(raw||'').toUpperCase();
    return {
      fg:/(^|\s)[+-]?FG(?=\s|=|$)/.test(s)||/(^|\s)[+-]?FZFG(?=\s|=|$)/.test(s),
      fzfg:/(^|\s)[+-]?FZFG(?=\s|=|$)/.test(s),
      br:/(^|\s)[+-]?BR(?=\s|=|$)/.test(s),
      mifg:/(^|\s)MIFG(?=\s|=|$)/.test(s)
    };
  }

  function dayHourToMs(day,hour,minute,ref){
    const R=new Date(ref||Date.now()),c=[];
    for(let dm=-1;dm<=1;dm++)c.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,day,hour,minute||0));
    return c.sort((a,b)=>Math.abs(a-(ref||Date.now()))-Math.abs(b-(ref||Date.now())))[0];
  }
  function rangeMs(token,ref){
    const m=String(token||'').match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);if(!m)return null;
    let a=dayHourToMs(+m[1],+m[2],0,ref),b=dayHourToMs(+m[3],+m[4],0,a+12*HOUR);
    if(b<=a)b+=31*24*HOUR;
    return [a,b];
  }
  function issueMs(raw,ref){const m=String(raw||'').match(/\b(\d{2})(\d{2})(\d{2})Z\b/);return m?dayHourToMs(+m[1],+m[2],+m[3],ref):ref||Date.now();}
  function tafSegments(row){
    const raw=rawOf(row).toUpperCase();if(!raw)return[];
    const issue=issueMs(raw,rowTime(row)||Date.now());
    const vm=raw.match(/\b(\d{4}\/\d{4})\b/),valid=vm?rangeMs(vm[1],issue):null;
    if(!valid)return[];
    const [v0,v1]=valid;
    const tokens=[];
    const re=/(FM\d{6}|TEMPO\s+\d{4}\/\d{4}|BECMG\s+\d{4}\/\d{4}|PROB(?:30|40)(?:\s+TEMPO)?\s+\d{4}\/\d{4})/g;
    let m;while((m=re.exec(raw)))tokens.push({i:m.index,text:m[0]});
    const first=tokens[0]?.i??raw.length;
    const baseText=raw.slice(vm.index+vm[0].length,first);
    const out=[{from:v0,to:v1,kind:'BASE',weight:1,text:baseText,...phen(baseText)}];
    for(let i=0;i<tokens.length;i++){
      const t=tokens[i],end=tokens[i+1]?.i??raw.length,body=raw.slice(t.i,end),head=t.text;
      if(head.startsWith('FM')){
        const q=head.match(/FM(\d{2})(\d{2})(\d{2})/);if(!q)continue;
        const from=dayHourToMs(+q[1],+q[2],+q[3],issue);out.push({from,to:v1,kind:'FM',weight:1,text:body,...phen(body)});
      }else{
        const q=head.match(/(\d{4}\/\d{4})/),r=q?rangeMs(q[1],issue):null;if(!r)continue;
        const prob=head.includes('PROB30')?.45:head.includes('PROB40')?.58:head.startsWith('TEMPO')?.62:head.startsWith('BECMG')?.78:.6;
        out.push({from:r[0],to:r[1],kind:head.split(/\s+/)[0],weight:prob,text:body,...phen(body)});
      }
    }
    return out;
  }
  function tafSignalAt(t){
    let epir=0,neighbors=0,fz=0,negative=0,detail=[];
    for(const st of STATIONS){
      const row=tafs[st];if(!row)continue;
      const seg=tafSegments(row).filter(s=>t>=s.from&&t<s.to);
      if(!seg.length)continue;
      const fg=Math.max(0,...seg.filter(s=>s.fg).map(s=>s.weight));
      const br=Math.max(0,...seg.filter(s=>s.br).map(s=>s.weight));
      const mi=Math.max(0,...seg.filter(s=>s.mifg).map(s=>s.weight));
      const fr=Math.max(0,...seg.filter(s=>s.fzfg).map(s=>s.weight));
      const clear=Math.max(0,...seg.filter(s=>!s.fg&&!s.br&&!s.mifg&&/(?:^|\s)(?:9999|CAVOK)(?:\s|$)/.test(s.text)).map(s=>s.weight));
      const local=Math.max(fg,br*.65,mi*.55);
      if(st==='EPIR')epir=Math.max(epir,local);else neighbors=Math.max(neighbors,local);
      fz=Math.max(fz,fr*(st==='EPIR'?1:.45));
      if(clear>0)negative=Math.max(negative,clear*(st==='EPIR'?1:.35));
      if(local>0)detail.push(`${st}:${fg?'FG':br?'BR':'MIFG'}`);
    }
    return {epir,neighbors,fz,negative,detail};
  }

  function obsMetrics(r){
    const raw=rawOf(r).toUpperCase(),p=phen(raw);
    const T=num(r?.temperature_c),Td=num(r?.dew_point_c),rh=num(r?.relative_humidity_pct),vis=num(r?.visibility_m),ceil=num(r?.ceiling_m_agl),wind=num(r?.wind_speed_ms)??(finite(num(r?.wind_speed_kt))?num(r.wind_speed_kt)/1.94384:null);
    return {t:rowTime(r),T,Td,rh,vis,ceil,wind,spread:finite(T)&&finite(Td)?T-Td:null,...p};
  }
  function slope(rows,key,hours){
    const a=rows.filter(x=>finite(x.t)&&finite(x[key])).sort((x,y)=>x.t-y.t);if(a.length<2)return null;
    const last=a.at(-1),cut=last.t-hours*HOUR,b=a.find(x=>x.t>=cut)??a[0],dt=(last.t-b.t)/HOUR;
    return dt>0?(last[key]-b[key])/dt:null;
  }
  function obsTrend(){
    const a=observations.map(obsMetrics).filter(x=>finite(x.t)).sort((x,y)=>x.t-y.t),last=a.at(-1);if(!last)return {support:0,quality:0,last:null};
    const age=(Date.now()-last.t)/HOUR;
    const sSpread=slope(a,'spread',3),sRh=slope(a,'rh',3),sVis=slope(a,'vis',3),sCeil=slope(a,'ceil',3),sWind=slope(a,'wind',3);
    let support=0;
    if(finite(sSpread))support+=clamp(-sSpread/0.8,-1,1)*.30;
    if(finite(sRh))support+=clamp(sRh/4,-1,1)*.18;
    if(finite(sVis))support+=clamp(-sVis/2200,-1,1)*.22;
    if(finite(sCeil))support+=clamp(-sCeil/220,-1,1)*.10;
    if(finite(sWind))support+=clamp(-sWind/1.2,-1,1)*.06;
    if(last.fg||last.fzfg)support+=.55;else if(last.br)support+=.28;else if(last.mifg)support+=.22;
    if(finite(last.vis)&&last.vis>=8000&&!last.fg&&!last.br&&!last.mifg)support-=.35;
    if(finite(last.spread)&&last.spread>=3)support-=.20;
    support=clamp(support,-1,1);
    const quality=clamp((a.length/6)*Math.exp(-Math.max(0,age)/4));
    return {support,quality,last,spreadPerH:sSpread,rhPerH:sRh,visPerH:sVis,ceilingPerH:sCeil,windPerH:sWind,count:a.length,age};
  }

  function baseSeries(){const a=window.PrognozaEPIRFog244?.getSeries?.()||window.PrognozaEPIRFogVNextSeries||[];return Array.isArray(a)?a:[];}
  function coreScore(r){return num(r?.scoreCore244)??num(r?.score);}
  function typeText(row){
    const p=String(row?.type?.text||row?.vnextProbability?.mechanism1||'').toUpperCase();
    if(p==='RAD')return 'radiacyjna';if(p==='ADV')return 'adwekcyjna';if(p==='CBL')return 'Stratus → mgła';if(p==='PCP')return 'opadowa / parowania';return p||'—';
  }
  function freezeFlag(row,ctx){
    const T=num(row?.integrated244?.input?.T),Ts=num(row?.integrated244?.input?.Ts),score=num(row?.score)??coreScore(row);
    const thermal=finite(T)&&T<=0.2||finite(Ts)&&Ts<=0;
    const taf=ctx?.taf?.fz>=.45;
    return {value:score>=ACTIVE&&(thermal||taf),reason:taf?'TAF FZFG':thermal?`T ${finite(T)?T.toFixed(1):'—'}°C / Ts ${finite(Ts)?Ts.toFixed(1):'—'}°C`:'brak sygnału ujemnej temperatury'};
  }
  function adjustedRow(row,trend){
    const t=num(row?.t),lead=finite(t)?Math.max(0,(t-Date.now())/HOUR):99,taf=tafSignalAt(t),base=coreScore(row);
    if(!finite(base))return row;
    const decayObs=Math.exp(-lead/5.5),decayTaf=.35+.65*Math.exp(-lead/30);
    const trendAdj=12*trend.support*trend.quality*decayObs;
    const tafSupport=.68*taf.epir+.32*taf.neighbors-.22*(taf.negative||0);
    let tafAdj=7*tafSupport*decayTaf;
    if(base<42)tafAdj=Math.min(tafAdj,2);
    let score=clamp(base+trendAdj+tafAdj,0,100);
    if(base<45&&score>=ACTIVE)score=Math.min(score,ACTIVE-1);
    const ctx={trendAdj,tafAdj,taf,trendSupport:trend.support,trendQuality:trend.quality,lead};
    return {...row,scoreCore244:base,score,context244:ctx,freezingFog:freezeFlag({...row,scoreCore244:base,score},ctx),fogEngineSource:'fog-2.4.4-context'};
  }
  function adjustAux(series,kind,trend){
    return (series||[]).map(r=>{
      const t=num(r?.t),lead=finite(t)?Math.max(0,(t-Date.now())/HOUR):99,taf=tafSignalAt(t),base=num(r?.score);if(!finite(base))return r;
      const tafTarget=kind==='br'?(taf.epir*.45+taf.neighbors*.20):kind==='mifg'?(taf.epir*.25+taf.neighbors*.12):0;
      const obsFactor=kind==='br'?(trend.last?.br?.35:0):kind==='mifg'?(trend.last?.mifg?.40:0):0;
      let score=base+5*tafTarget*(.4+.6*Math.exp(-lead/30))+100*obsFactor*Math.exp(-lead/3.2);
      if(trend.last&&finite(trend.last.vis)&&trend.last.vis>=8000&&!trend.last.br&&!trend.last.mifg)score-=6*trend.quality*Math.exp(-lead/4);
      return {...r,score:clamp(score,0,100),scoreCore244:base,context244:{taf,trendSupport:trend.support}};
    });
  }

  function publish(trend){
    const base=baseSeries();if(!base.length)return false;
    const core=base.map(r=>r?.context244?{...r,score:num(r.scoreCore244)??num(r.score),context244:undefined}:r);
    adjusted=core.map(r=>adjustedRow(r,trend));
    const oldBr=window.PrognozaEPIRFog244?.getBRSeries?.()||window.PrognozaEPIRBRSeries||[];
    const oldMi=window.PrognozaEPIRFog244?.getMIFGSeries?.()||window.PrognozaEPIRMIFG?.getSeries?.()||[];
    const br=adjustAux(oldBr,'br',trend),mi=adjustAux(oldMi,'mifg',trend);
    window.PrognozaEPIRFogSeries=adjusted;
    window.PrognozaEPIRFogVNextSeries=adjusted;
    window.PrognozaEPIRFogRenderSeries=adjusted;
    window.PrognozaEPIRBRSeries=br;
    if(window.PrognozaEPIRMIFG)window.PrognozaEPIRMIFG={...window.PrognozaEPIRMIFG,getSeries:()=>mi.slice()};
    contextByTime=new Map(adjusted.map(r=>[num(r.t),r.context244]));
    if(window.PrognozaEPIRFog244){window.PrognozaEPIRFog244.getContext=()=>({version:VERSION,status:{...status},trend,tafs:{...tafs}});window.PrognozaEPIRFog244.getAdjustedSeries=()=>adjusted.slice();}
    try{dispatchEvent(new CustomEvent('prognozaepir:fog-context-updated',{detail:{version:VERSION,count:adjusted.length}}));}catch(_){}
    return true;
  }

  function best(series,hours){const now=Date.now(),from=now-30*60e3,to=now+hours*HOUR;return (series||[]).filter(r=>finite(num(r?.t))&&r.t>=from&&r.t<=to&&finite(num(r?.score))).reduce((a,b)=>!a||b.score>a.score?b:a,null);}
  function riskText(s){return !finite(s)?'BRAK DANYCH':s<ACTIVE?'NIE':s<80?'PRAWDOPODOBNA':'BARDZO PRAWDOPODOBNA';}
  function css(s){return s>=80?'fogctx-vh':s>=ACTIVE?'fogctx-hi':'';}
  function visText(v){v=num(v);return finite(v)?(v>=10000?(v/1000).toFixed(1)+' km':Math.round(v)+' m'):'—';}
  function targetCard(label,r,target){
    const extra=target==='FG'?` · VIS ${visText(r?.visGuidance?.point||r?.visProposed||r?.vis)}`:target==='BR'?` · VIS ${visText(r?.visibility)}`:'';
    return `<div class="fogctx-card ${css(num(r?.score))}"><small>${label}</small><strong>${riskText(num(r?.score))}</strong><em>${finite(num(r?.score))?Math.round(r.score)+'/100':'—'}${r?.t?' · '+utc(r.t):''}${extra}</em></div>`;
  }
  function render(){
    if(!/\/fog\.html$/i.test(location.pathname))return;
    const fg=adjusted.length?adjusted:baseSeries(),br=window.PrognozaEPIRBRSeries||[],mi=window.PrognozaEPIRMIFG?.getSeries?.()||[];if(!fg.length)return;
    let st=document.getElementById('fogctxcss');if(!st){st=document.createElement('style');st.id='fogctxcss';st.textContent='.fogctx{margin-top:8px;border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:10px}.fogctx-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.fogctx-card{background:var(--soft);border-left:3px solid var(--blueText);padding:7px}.fogctx-card small,.fogctx-card em{display:block;color:var(--muted);font-size:8px;font-style:normal}.fogctx-card strong{display:block;font-size:12px}.fogctx-hi{border-left-color:#d86c2f}.fogctx-vh{border-left-color:#d0503f}.fogctx-note{margin-top:7px;padding:6px;background:var(--soft);border:1px solid var(--border);border-radius:5px;font-size:9px;color:var(--muted)}@media(max-width:700px){.fogctx-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}';document.head.appendChild(st);}
    const old=document.getElementById('fogEngine244');if(old)old.style.display='none';
    let h=document.getElementById('fogEngine244Context');if(!h){h=document.createElement('section');h.id='fogEngine244Context';(document.getElementById('fogStandaloneMount')||document.body).appendChild(h);}h.className='fogctx';
    const f1=best(fg,1),f24=best(fg,24),f48=best(fg,48),b1=best(br,1),b24=best(br,24),b48=best(br,48),m1=best(mi,1),m24=best(mi,24),m48=best(mi,48),peak=f48||f24||f1;
    const fr=peak?freezeFlag(peak,peak.context244):{value:false,reason:'—'},trend=obsTrend();
    const tctx=peak?.context244?.taf,tafText=tctx?.detail?.length?tctx.detail.join(' · '):'brak aktywnego sygnału FG/BR/MIFG w TAF';
    h.innerHTML=`<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:7px;margin-bottom:8px"><b style="color:var(--blueText)">EPIR FOG ENGINE 2.4.4</b><span style="color:var(--muted);font-size:9px">FG / BR / MIFG osobno · max 1 h / 24 h / 48 h</span></div><div class="fogctx-grid">
      ${targetCard('FG max 1 h',f1,'FG')}${targetCard('FG max 24 h',f24,'FG')}${targetCard('FG max 48 h',f48,'FG')}
      ${targetCard('BR max 1 h',b1,'BR')}${targetCard('BR max 24 h',b24,'BR')}${targetCard('BR max 48 h',b48,'BR')}
      ${targetCard('MIFG max 1 h',m1,'MIFG')}${targetCard('MIFG max 24 h',m24,'MIFG')}${targetCard('MIFG max 48 h',m48,'MIFG')}
      <div class="fogctx-card"><small>Rodzaj mgły w maksimum FG</small><strong>${esc(typeText(peak))}</strong><em>${peak?.t?utc(peak.t):'—'} · mechanizm 1/2: ${esc(peak?.vnextProbability?.mechanism1||'—')} / ${esc(peak?.vnextProbability?.mechanism2||'—')}</em></div>
      <div class="fogctx-card ${fr.value?'fogctx-hi':''}"><small>Czy marznąca (FZFG)</small><strong>${fr.value?'TAK':'NIE'}</strong><em>${esc(fr.reason)}</em></div>
      <div class="fogctx-card"><small>Tempo zmian EPIR</small><strong>${trend.support>0.18?'w stronę mgły':trend.support<-.18?'od mgły':'stabilnie'}</strong><em>Δ(T−Td) ${finite(trend.spreadPerH)?trend.spreadPerH.toFixed(2)+'°C/h':'—'} · ΔRH ${finite(trend.rhPerH)?trend.rhPerH.toFixed(1)+'%/h':'—'} · ΔVIS ${finite(trend.visPerH)?Math.round(trend.visPerH)+' m/h':'—'}</em></div>
      <div class="fogctx-card"><small>TAF EPIR + zapasowe</small><strong>${tafText==='brak aktywnego sygnału FG/BR/MIFG w TAF'?'brak sygnału': 'sygnał pomocniczy'}</strong><em>${esc(tafText)}</em></div>
      <div class="fogctx-card"><small>Aktualne warunki EPIR</small><strong>${trend.last?visText(trend.last.vis):'BRAK'}</strong><em>${trend.last?`T/Td ${finite(trend.last.T)?trend.last.T.toFixed(1):'—'}/${finite(trend.last.Td)?trend.last.Td.toFixed(1):'—'}°C · RH ${finite(trend.last.rh)?Math.round(trend.last.rh):'—'}% · wiatr ${finite(trend.last.wind)?trend.last.wind.toFixed(1):'—'} m/s`:'brak świeżej obserwacji'}</em></div>
    </div><div class="fogctx-note"><b>TAF i obserwacje są kontekstem, nie zastępują fizyki.</b> TAF EPIR ma większą wagę niż TAF EPBY/EPPW/EPKS; lotniska zapasowe tylko potwierdzają szerszy sygnał synoptyczny. Trend z ostatnich obserwacji wykorzystuje zmianę T−Td, RH, widzialności, pułapu i wiatru. Dodatni kontekst nie może sam podnieść słabego sygnału fizycznego ponad próg 60/100.</div>`;
  }

  async function loadContext(){
    const A=window.PrognozaEPIRMessageArchive;
    if(!A){status.error='MessageArchive niedostępne';return;}
    const jobs=[A.getRecent?.('AVIATION','EPIR',16,true),...STATIONS.map(s=>A.getLatest?.('TAF',s,true))];
    const rs=await Promise.allSettled(jobs);
    observations=rs[0].status==='fulfilled'?(rs[0].value||[]):[];
    STATIONS.forEach((s,i)=>{tafs[s]=rs[i+1].status==='fulfilled'?rs[i+1].value:null;});
    status={updated:Date.now(),error:null,tafStations:STATIONS.filter(s=>tafs[s]).length,obsCount:observations.length};
  }
  async function refresh(force=false){
    if(busy)return busy;
    busy=(async()=>{if(force||!status.updated||Date.now()-status.updated>5*60e3)await loadContext();const trend=obsTrend();publish(trend);render();return adjusted.slice();})().catch(e=>{status.error=String(e?.message||e);return adjusted.slice();}).finally(()=>{busy=null;});
    return busy;
  }
  function schedule(){
    const sig=(window.PrognozaEPIRFogVNextSeries||[]).map(r=>`${r?.t}:${Math.round(num(r?.score)||0)}:${r?.fogEngineSource||''}`).join('|');
    if(!sig||sig===lastSig)return;lastSig=sig;setTimeout(()=>refresh(false),0);
  }

  addEventListener('prognozaepir:fog-vnext-updated',e=>{if(e?.detail?.version===VERSION)return;schedule();});
  addEventListener('prognozaepir:fog-context-updated',render);
  setTimeout(()=>refresh(true),1200);
  setInterval(()=>refresh(true),15*60e3);
  window.PrognozaEPIRFog244Context={VERSION,refresh,getStatus:()=>({...status}),getTrend:obsTrend,getTAFs:()=>({...tafs}),getSeries:()=>adjusted.slice()};
})();