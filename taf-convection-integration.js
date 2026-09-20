'use strict';
(function(root,factory){
  const api=factory(root||{});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root&&root.document){root.PrognozaEPIRTAFConvection=api;api.install();}
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';

  const HOUR=3600000, FT=3.2808398950131;
  const CACHE_KEY='prognozaepir.convection.nowcast.v1';
  const MAX_NOWCAST_AGE=30*60*1000;
  const NEIGHBORS={
    EPBY:{lat:53.0968,lon:17.9777},
    EPPW:{lat:52.3792,lon:17.8539},
    EPKS:{lat:52.3317,lon:16.9664}
  };
  const EPIR={lat:52.828611,lon:18.330278};
  const finite=Number.isFinite;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number(v)||0));
  const asProb=v=>!finite(Number(v))?0:(Number(v)>1?clamp(Number(v)/100):clamp(Number(v)));
  const pad=(n,w=2)=>String(Math.max(0,Math.round(n))).padStart(w,'0');
  let snapshot=null,neighborRows={},refreshPromise=null,installed=false;

  function monthCandidate(day,hour,minute,refMs){
    const ref=new Date(refMs),out=[];
    for(const dm of[-1,0,1]){
      const d=new Date(Date.UTC(ref.getUTCFullYear(),ref.getUTCMonth()+dm,day,hour===24?0:hour,minute||0));
      if(d.getUTCDate()!==day)continue;
      out.push(d.getTime()+(hour===24?24*HOUR:0));
    }
    return out.sort((a,b)=>Math.abs(a-refMs)-Math.abs(b-refMs))[0]??NaN;
  }
  function resolveDDHH(code,refMs){const m=String(code||'').match(/^(\d{2})(\d{2})$/);if(!m||+m[2]>24)return NaN;return monthCandidate(+m[1],+m[2],0,refMs);}
  function resolveFM(code,refMs){const m=String(code||'').match(/^(\d{2})(\d{2})(\d{2})$/);if(!m)return NaN;return monthCandidate(+m[1],+m[2],+m[3],refMs);}
  function issueTime(raw,ref=Date.now()){const m=String(raw||'').match(/\b(\d{2})(\d{2})(\d{2})Z\b/);return m?monthCandidate(+m[1],+m[2],+m[3],ref):NaN;}
  function resolveEnd(code,from,issue){let t=resolveDDHH(code,issue);if(finite(t)&&t<=from)t=resolveDDHH(code,from+36*HOUR);return t;}
  function convectiveType(text){
    const s=String(text||'').toUpperCase();
    if(/\b(?:FEW|SCT|BKN|OVC)\d{3}CB\b/.test(s))return'CB';
    if(/\b(?:FEW|SCT|BKN|OVC)\d{3}TCU\b/.test(s))return'TCU';
    return null;
  }
  function neighborSegments(raw){
    raw=String(raw||'').replace(/\s+/g,' ').trim();
    if(!raw||/\bNIL\b/.test(raw))return[];
    const issue=issueTime(raw),vm=raw.match(/\b(\d{4})\/(\d{4})\b/);if(!finite(issue)||!vm)return[];
    const validFrom=resolveDDHH(vm[1],issue),validTo=resolveEnd(vm[2],validFrom,issue);if(!finite(validFrom)||!finite(validTo))return[];
    const re=/\b(FM(\d{6})|BECMG\s+(\d{4})\/(\d{4})|TEMPO\s+(\d{4})\/(\d{4})|PROB(30|40)(?:\s+TEMPO)?\s+(\d{4})\/(\d{4}))\b/g;
    const marks=[];let m;while((m=re.exec(raw)))marks.push({i:m.index,end:re.lastIndex,fm:m[2],becA:m[3],becB:m[4],tmpA:m[5],tmpB:m[6],prob:m[7],prA:m[8],prB:m[9]});
    const persistent=marks.filter(x=>x.fm||x.becA),out=[];
    const bodyStart=vm.index+vm[0].length,first=marks[0]?.i??raw.length,baseType=convectiveType(raw.slice(bodyStart,first));
    const firstPersistent=persistent[0];
    const firstPersistentStart=firstPersistent?(firstPersistent.fm?resolveFM(firstPersistent.fm,issue):resolveEnd(firstPersistent.becB,resolveDDHH(firstPersistent.becA,issue),issue)):validTo;
    if(baseType&&finite(firstPersistentStart)&&firstPersistentStart>validFrom)out.push({from:validFrom,to:firstPersistentStart,factor:1,kind:'BASE',type:baseType});
    for(let i=0;i<marks.length;i++){
      const x=marks[i],body=raw.slice(x.end,marks[i+1]?.i??raw.length),type=convectiveType(body);if(!type)continue;
      let from,to,factor=1,kind='';
      if(x.fm){from=resolveFM(x.fm,issue);kind='FM';const nxt=persistent.find(y=>y.i>x.i);to=nxt?(nxt.fm?resolveFM(nxt.fm,issue):resolveEnd(nxt.becB,resolveDDHH(nxt.becA,issue),issue)):validTo;}
      else if(x.becA){const a=resolveDDHH(x.becA,issue);from=resolveEnd(x.becB,a,issue);kind='BECMG';const nxt=persistent.find(y=>y.i>x.i);to=nxt?(nxt.fm?resolveFM(nxt.fm,issue):resolveEnd(nxt.becB,resolveDDHH(nxt.becA,issue),issue)):validTo;}
      else if(x.tmpA){from=resolveDDHH(x.tmpA,issue);to=resolveEnd(x.tmpB,from,issue);factor=.60;kind='TEMPO';}
      else if(x.prob){from=resolveDDHH(x.prA,issue);to=resolveEnd(x.prB,from,issue);factor=+x.prob===40?.40:.30;kind=`PROB${x.prob}`;}
      if(finite(from)&&finite(to)&&to>from)out.push({from,to,factor,kind,type});
    }
    return out;
  }
  function geo(a,b){
    const rad=x=>x*Math.PI/180,p1=rad(a.lat),p2=rad(b.lat),dl=rad(b.lon-a.lon),dp=rad(b.lat-a.lat);
    const q=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
  }
  function supportAt(t,rows=neighborRows){
    const hits=[];
    for(const[id,meta]of Object.entries(NEIGHBORS)){
      const raw=String(rows?.[id]?.raw||rows?.[id]?.canonical_raw||rows?.[id]?.raw_text||'');if(!raw)continue;
      const seg=neighborSegments(raw).find(x=>t>=x.from&&t<x.to);if(!seg)continue;
      const km=geo(EPIR,meta),distance=Math.exp(-km/220),typeFactor=seg.type==='CB'?1:.72;
      const tcu=Math.min(.55,.34*distance*seg.factor*typeFactor),cb=Math.min(.50,.30*distance*seg.factor*(seg.type==='CB'?1:.28));
      if(tcu>.01)hits.push({station:id,type:seg.type,kind:seg.kind,km,tcu,cb});
    }
    const combine=(key)=>Math.min(.65,1-hits.reduce((p,x)=>p*(1-(x[key]||0)),1));
    return{tcu:combine('tcu'),cb:combine('cb'),hits:hits.sort((a,b)=>b.tcu-a.tcu)};
  }
  function boost(local,support){
    local=asProb(local);support=clamp(support,0,.65);
    if(local<=0)return 0;
    return clamp(local+local*(1-local)*support*.35);
  }
  function freshNowcast(x,now=Date.now()){
    if(!x||(!finite(Number(x.tcuProbability))&&!finite(Number(x.cbProbability))))return false;
    const t=Date.parse(x.updatedAt||'');return finite(t)&&t<=now+5*60000&&now-t<=MAX_NOWCAST_AGE;
  }
  function readCache(){
    const candidates=[root.PrognozaEPIRConvectionNowcast];
    try{candidates.push(JSON.parse(root.localStorage?.getItem(CACHE_KEY)||'null'));}catch(_){}
    return candidates.find(x=>freshNowcast(x))||null;
  }
  function sampleNowcast(x,t){
    if(!freshNowcast(x))return null;
    const base=Date.parse(x.updatedAt),lead=(t-base)/60000;if(lead<-20||lead>215)return null;
    if(lead<=20)return{tcu:asProb(x.tcuProbability),cb:asProb(x.cbProbability),leadMin:lead,horizonMin:0};
    const hs=Array.isArray(x.horizons)?x.horizons:[];let best=null,bd=Infinity;
    for(const h of hs){const hm=Number(h.h),d=Math.abs(hm-lead);if(finite(hm)&&d<bd){best=h;bd=d;}}
    if(!best||bd>38)return null;
    return{tcu:asProb(best.tcu),cb:asProb(best.cb),leadMin:lead,horizonMin:Number(best.h)};
  }
  function estimateBaseFt(row){
    if(finite(Number(row?.convectiveBaseFt))&&Number(row.convectiveBaseFt)>0)return clamp(Number(row.convectiveBaseFt),500,15000);
    const profile=(Array.isArray(row?.profile)?row.profile:[]).filter(q=>finite(Number(q?.agl))&&finite(Number(q?.cc))).sort((a,b)=>a.agl-b.agl);
    const q=profile.find(q=>Number(q.agl)>=150&&Number(q.agl)<=3500&&Number(q.cc)>=25);if(q)return clamp(Number(q.agl)*FT,500,15000);
    if(finite(Number(row?.lowH))&&Number(row.lowH)>0)return clamp(Number(row.lowH)*FT,500,15000);
    return 2000;
  }
  function convectiveCloud(row,type){return{cover:'FEW',ft:estimateBaseFt(row),type,okta:2};}
  function enrichRows(rows,x=snapshot,neighbors=neighborRows){
    return (rows||[]).map(row=>{
      const local=sampleNowcast(x,+row.t),support=supportAt(+row.t,neighbors),o={...row};
      const localTcu=local?.tcu||0,localCb=local?.cb||0;
      o.tcuRiskLocal=localTcu;o.cbRiskLocal=localCb;
      o.neighborConvectiveSupport=support.tcu;o.neighborCbSupport=support.cb;
      o.neighborConvectiveStations=support.hits.map(h=>h.station);
      o.tcuRisk=boost(localTcu,support.tcu);o.cbRisk=boost(localCb,support.cb);
      o.convectionNowcastHorizonMin=local?.horizonMin??null;
      if(o.cbRisk>=.50||o.tcuRisk>=.50){
        const type=o.cbRisk>=.50?'CB':'TCU',cloud=convectiveCloud(o,type),clouds=Array.isArray(o.clouds)?o.clouds.map(c=>({...c})):[];
        if(!clouds.some(c=>String(c.type||'').toUpperCase()===type))clouds.push(cloud);
        o.clouds=clouds;
      }
      return o;
    });
  }
  function fmtPeriod(t){const d=new Date(t);return pad(d.getUTCDate())+pad(d.getUTCHours());}
  function twoHourWindow(t,start,end){let s=Math.max(start,t-HOUR),e=Math.min(end,t+HOUR);if(e-s<2*HOUR){if(s===start)e=Math.min(end,s+2*HOUR);else if(e===end)s=Math.max(start,e-2*HOUR);}return{s,e};}
  function hasConvectiveToken(text){return/\b(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)\b/.test(String(text||''));}
  function convectiveSupplement(result,rows,input,validator){
    if(!result?.taf||!Array.isArray(rows)||!finite(+input?.start)||!finite(+input?.end))return result;
    const taf=String(result.taf),groups=(taf.match(/\b(?:BECMG|TEMPO|FM\d{6}|PROB30(?:\s+TEMPO)?)\b/g)||[]).length;
    if(groups>=5)return result;
    const prob30Tempo=(taf.match(/\bPROB30\s+TEMPO\b/g)||[]).length;if(prob30Tempo>=1)return result;
    const qualifying=rows.filter(r=>Math.max(asProb(r.cbRisk),asProb(r.tcuRisk))>=.30&&Math.max(asProb(r.cbRisk),asProb(r.tcuRisk))<.50);
    if(!qualifying.length)return result;
    const peak=qualifying.sort((a,b)=>Math.max(asProb(b.cbRisk),asProb(b.tcuRisk))-Math.max(asProb(a.cbRisk),asProb(a.tcuRisk)))[0];
    const type=asProb(peak.cbRisk)>=.30?'CB':'TCU',risk=type==='CB'?asProb(peak.cbRisk):asProb(peak.tcuRisk);
    const w=twoHourWindow(+peak.t,+input.start,+input.end),ft=estimateBaseFt(peak),cloud=`FEW${pad(Math.floor(ft/100),3)}${type}`;
    const nearby=(result.groups||[]).some(g=>hasConvectiveToken(g.text)&&(+peak.t)>=g.s-HOUR&&(+peak.t)<=g.e+HOUR);if(nearby)return result;
    const storm=asProb(peak.storm),precip=Math.max(asProb(peak.wet),asProb(peak.precipRisk),Number(peak.RR||0)>=.05?.30:0);
    let wx='';if(storm>=.30&&type==='CB')wx=precip>=.30?'TSRA':'TS';else if(precip>=.30)wx='SHRA';
    const payload=[wx,cloud].filter(Boolean).join(' '),text=`PROB30 TEMPO ${fmtPeriod(w.s)}/${fmtPeriod(w.e)} ${payload}`;
    const outTaf=taf.replace(/=\s*$/,`\n${text}=`),check=validator(outTaf,{issue:+input.issue,start:+input.start,end:+input.end,msaFt:input.msaFt});
    if(!check?.ok)return result;
    return{...result,taf:outTaf,groups:[...(result.groups||[]),{kind:'PROB30 TEMPO',s:w.s,e:w.e,fields:['clouds',...(wx?['weather']:[])],payload,probability:risk,text}],checks:{...(result.checks||{}),...check,noProb40:!outTaf.includes('PROB40'),noVV:!/\bVV/.test(outTaf),max5:true},diagnostics:{...(result.diagnostics||{}),reasons:[...(result.diagnostics?.reasons||[]),`${text}: TCu/Cb nowcast ${Math.round(risk*100)}%; TAF sąsiadów użyty wyłącznie jako dodatnie potwierdzenie.`]}};
  }
  function annotateResult(result,rows){
    if(!result)return result;
    const byTime=new Map(rows.map(r=>[+r.t,r]));
    const hourly=(result.hourly||[]).map(h=>{const r=byTime.get(+h.t)||h.sourceRow||{},p={...(h.prob||{}),tcu:asProb(r.tcuRisk),cb:asProb(r.cbRisk)};return{...h,prob:p,sourceRow:r};});
    return{...result,hourly,diagnostics:{...(result.diagnostics||{}),convectionPolicy:'dedicated TCu/Cb nowcast 0–3h; neighbor TAF positive-only corroboration; TCU/CB never creates TS without independent thunder signal'}};
  }
  async function refreshNeighbors(force=true){
    const A=root.PrognozaEPIRMessageArchive;if(!A?.getLatest)return neighborRows;
    const rows={};await Promise.all(Object.keys(NEIGHBORS).map(async id=>{try{const x=await A.getLatest('TAF',id,force);if(x)rows[id]=x;}catch(_){}}));neighborRows=rows;return rows;
  }
  async function waitForNowcast(){
    snapshot=readCache();if(snapshot)return snapshot;
    if(!root.document)return null;
    const old=root.document.getElementById('tafConvectionBridgeFrame');if(old)old.remove();
    const f=root.document.createElement('iframe');f.id='tafConvectionBridgeFrame';f.tabIndex=-1;f.setAttribute('aria-hidden','true');f.style.cssText='position:absolute;width:1px;height:1px;left:-10000px;top:-10000px;border:0;visibility:hidden';f.src='radar.html?taf-convection-bridge=1&v='+Date.now();root.document.body.appendChild(f);
    const deadline=Date.now()+24000;
    while(Date.now()<deadline){
      try{
        const w=f.contentWindow,radar=w?.PrognozaEPIRRadarNowcast,x=w?.PrognozaEPIRConvectionNowcast;
        const rt=Date.parse(radar?.updatedAt||''),xt=Date.parse(x?.updatedAt||'');
        const radarReady=radar&&!radar.error&&finite(Number(radar.frameEnd))&&finite(rt);
        if(radarReady&&freshNowcast(x)&&finite(xt)&&xt>=rt-5000){snapshot=x;try{root.localStorage?.setItem(CACHE_KEY,JSON.stringify(x));}catch(_){}break;}
      }catch(_){}
      await new Promise(r=>setTimeout(r,300));
    }
    if(!snapshot)snapshot=readCache();
    f.remove();return snapshot;
  }
  async function refresh(){
    if(refreshPromise)return refreshPromise;
    refreshPromise=Promise.allSettled([refreshNeighbors(true),waitForNowcast()]).then(()=>({snapshot,neighborRows})).finally(()=>{refreshPromise=null;});
    return refreshPromise;
  }
  function updateUi(result){
    if(!root.document||!result)return;
    setTimeout(()=>{
      const badge=root.document.getElementById('badge');if(badge)badge.textContent=badge.textContent.replace('2.4.2','2.4.3');
      const src=root.document.getElementById('sources');if(src&&!src.querySelector('[data-source="tcu-cb"]')){
        const loaded=(result.hourly||[]).some(h=>h.sourceRow?.convectionNowcastHorizonMin!==null&&h.sourceRow?.convectionNowcastHorizonMin!==undefined),stations=[...new Set((result.hourly||[]).flatMap(h=>h.sourceRow?.neighborConvectiveStations||[]))];
        src.insertAdjacentHTML('beforeend',`<span class="pill ${loaded?'ok':'warn'}" data-source="tcu-cb">TCu/Cb ${loaded?'✓':'—'}${stations.length?' · TAF '+stations.join('/'):''}</span>`);
      }
      const conf=root.document.getElementById('conf');if(conf&&!/TCu\/Cb 0–3 h/.test(conf.textContent))conf.textContent+=' TCu/Cb 0–3 h jest oddzielone od TS; TAF sąsiadów działa tylko jako dodatnie potwierdzenie.';
      const head=[...root.document.querySelectorAll('#hours')][0]?.closest('table')?.querySelector('thead th:nth-child(7)');if(head)head.textContent='Opad / TS / TCu / Cb';
      [...root.document.querySelectorAll('#hours tr')].forEach((tr,i)=>{const h=result.hourly?.[i],cell=tr.children?.[6];if(!h||!cell)return;const t=Math.round((h.prob?.tcu||0)*100),c=Math.round((h.prob?.cb||0)*100);if(!cell.querySelector('.conv-prob-taf'))cell.insertAdjacentHTML('beforeend',`<span class="conv-prob-taf"><br>TCu ${t}% · Cb ${c}%</span>`);});
    },0);
  }
  function wrapEngine(base){
    if(!base?.createEngine||base.__TAF_CONVECTION_WRAPPED__)return base;
    const wrapped={...base,__TAF_CONVECTION_WRAPPED__:true,
      ready:async()=>{if(typeof base.ready==='function')await base.ready();await refresh();return true;},
      createEngine(options={}){
        const engine=base.createEngine(options);
        return Object.freeze({...engine,generate(input={}){
          const rows=enrichRows(input.rows||[]),r0=engine.generate({...input,rows}),r1=convectiveSupplement(r0,rows,input,(taf,meta)=>engine.validate(taf,meta)),r2=annotateResult(r1,rows);updateUi(r2);return r2;
        }});
      }
    };
    return Object.freeze(wrapped);
  }
  function install(){
    if(installed)return;installed=true;
    const base=root.PrognozaEPIRTAFEngine;if(base?.createEngine)root.PrognozaEPIRTAFEngine=wrapEngine(base);
    const fix=()=>{const b=root.document?.getElementById('badge');if(b)b.textContent=b.textContent.replace('2.4.2','2.4.3');};
    if(root.MutationObserver&&root.document){new root.MutationObserver(fix).observe(root.document.documentElement,{subtree:true,childList:true,characterData:true});fix();}
  }
  return Object.freeze({version:'1.0.0',CACHE_KEY,neighborSegments,supportAt,boost,freshNowcast,sampleNowcast,estimateBaseFt,enrichRows,convectiveSupplement,refresh,install,_setSnapshot:x=>{snapshot=x;},_setNeighborRows:x=>{neighborRows=x||{};}});
});
