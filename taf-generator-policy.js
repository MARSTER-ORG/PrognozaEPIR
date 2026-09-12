'use strict';
(()=>{
  if(!/\/taf\.html$/i.test(location.pathname))return;

  const FT=3.28084,KT=1.94384,NSC_FT=5000;
  const VRB_SHARE=.75,VRB_LOW=2,VRB_OTHER_MAX=10,CAVOK_SHARE=.75;
  const $=id=>document.getElementById(id),fin=Number.isFinite;
  let applying=false,recentCache=null,archivePatched=false;

  function monthTime(code,ref,minutes=false){
    if(!/^\d{4,6}$/.test(String(code||'')))return NaN;
    const s=String(code),d=+s.slice(0,2),h=+s.slice(2,4),mi=minutes?+s.slice(4,6):0,R=new Date(ref),a=[];
    for(let dm=-1;dm<=1;dm++)a.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,d,h,mi));
    return a.sort((x,y)=>Math.abs(x-ref)-Math.abs(y-ref))[0];
  }
  function tafTimes(raw){
    const i=String(raw).match(/\b(\d{6})Z\b/),v=String(raw).match(/\b(\d{4})\/(\d{4})\b/);
    if(!i||!v)return null;
    const issue=monthTime(i[1],Date.now(),true),start=monthTime(v[1],issue);let end=monthTime(v[2],start+6*3600e3);
    if(end<=start)end=monthTime(v[2],start+18*3600e3);
    return{issue,start,end};
  }
  function obsTime(x,ref=Date.now()){
    if(!x)return NaN;
    for(const k of ['obs_time','message_time','time','issue_time','timestamp']){
      const t=Date.parse(x[k]||'');if(fin(t))return t;
    }
    const raw=String(x.raw||x.canonical_raw||''),m=raw.match(/\b(\d{6})Z\b/);
    return m?monthTime(m[1],ref,true):NaN;
  }
  function obsRows(r){
    const out=[];
    for(const k of ['metar','speci','aviation'])if(Array.isArray(r?.[k]))out.push(...r[k]);
    return out.filter(x=>/\bEPIR\b/.test(String(x?.raw||x?.canonical_raw||'')));
  }
  function uniqueObsRows(r){
    const seen=new Set(),out=[];
    for(const x of obsRows(r)){
      const raw=String(x?.canonical_raw||x?.raw||'').replace(/\s+/g,' ').trim(),t=obsTime(x),key=String(x?.message_id||`${t}|${raw}`);
      if(seen.has(key))continue;seen.add(key);out.push(x);
    }
    return out;
  }
  function newestObs(items){
    return items.filter(Boolean).sort((a,b)=>(obsTime(b)||0)-(obsTime(a)||0))[0]||null;
  }

  function patchArchive(){
    if(archivePatched)return true;
    const A=window.PrognozaEPIRMessageArchive;if(!A)return false;
    const oLatest=typeof A.latest==='function'?A.latest.bind(A):null;
    const oRecent=typeof A.recent==='function'?A.recent.bind(A):null;
    const oGet=typeof A.getLatest==='function'?A.getLatest.bind(A):null;
    if(!oLatest||!oRecent||!oGet)return false;
    const W=Object.create(A);
    W.recent=async force=>{const r=await oRecent(force);recentCache=r;return r};
    W.latest=async force=>{
      const [l,r]=await Promise.all([oLatest(force),oRecent(force)]);recentCache=r;
      const best=newestObs([l?.aviation,l?.metar,...obsRows(r)]);
      return{...(l||{}),aviation:best||l?.aviation||l?.metar||null,metar:best||l?.metar||l?.aviation||null,synop:null};
    };
    W.getLatest=async(type,station,force)=>{
      const T=String(type||'').toUpperCase(),S=String(station||'').toUpperCase();
      if(T==='SYNOP')return null;
      if(T==='AVIATION'&&S==='EPIR'){
        const [g,l,r]=await Promise.all([oGet(type,station,force),oLatest(force),oRecent(force)]);recentCache=r;
        return newestObs([g,l?.aviation,l?.metar,...obsRows(r)])||g||null;
      }
      return oGet(type,station,force);
    };
    try{Object.defineProperty(W,'__tafPolicyV6',{value:true});window.PrognozaEPIRMessageArchive=W;archivePatched=true;return true}catch(_){return false}
  }

  function disableSynopUi(){
    for(const h of document.querySelectorAll('h2')){
      if(!/^SYNOP\s+12342/.test(h.textContent||''))continue;
      h.textContent='SYNOP 12342 — wyłączony';
      const sec=h.closest('section');if(sec){const pre=sec.querySelector('pre');if(pre)pre.textContent='Wyłączony z analizy — brak bieżącego, niezawodnego źródła.';const meta=sec.querySelector('.note');if(meta)meta.textContent='SYNOP nie wpływa na generator TAF.'}
    }
    const s=$('sources');if(s){for(const x of [...s.children])if(/^SYNOP\b/.test(x.textContent||''))x.remove();if(!s.querySelector('[data-synop-off]')){const x=document.createElement('span');x.className='pill warn';x.dataset.synopOff='1';x.textContent='SYNOP wyłączony';s.appendChild(x)}}
  }

  function parseCloud(t){const m=String(t||'').match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);return m?{raw:m[0],amount:m[1],ft:+m[2]*100,type:m[3]||''}:null}
  function amountMin(c){return c==='FEW'?1:c==='SCT'?3:c==='BKN'?5:c==='OVC'?8:0}
  function selectCloudTokens(tokens){
    const p=tokens.map(parseCloud).filter(Boolean).filter(c=>c.type||c.ft<NSC_FT),ord=p.filter(c=>!c.type).sort((a,b)=>a.ft-b.ft),conv=p.filter(c=>c.type).sort((a,b)=>a.ft-b.ft),out=[];
    if(ord[0])out.push(ord[0]);
    if(ord.length>1){const x=ord.slice(1).find(c=>amountMin(c.amount)>2);if(x)out.push(x)}
    if(ord.length>1){const used=new Set(out.map(c=>c.raw)),x=ord.filter(c=>!used.has(c.raw)).find(c=>amountMin(c.amount)>4);if(x)out.push(x)}
    for(const c of conv)if(!out.some(x=>x.raw===c.raw))out.push(c);
    return out.sort((a,b)=>a.ft-b.ft).map(c=>c.raw);
  }
  function isWx(t){return /^(?:FG|FZFG|BR|HZ|RA|DZ|SN|SG|PL|GR|GS|SHRA|SHSN|SHGR|SHGS|TS|TSRA|TSGR|TSGS|FZRA|FZDZ|MIFG|BCFG|PRFG|SQ)$/.test(String(t||'').replace(/^[-+]/,''))}
  function noWxText(s){const x=String(s||'').trim();return !x||x==='—'||x==='-'||x==='NSW'}
  function significantClouds(tokens){return tokens.map(parseCloud).filter(Boolean).filter(c=>c.type||c.ft<NSC_FT)}

  // Zwykłe chmury >=5000 ft nie blokują CAVOK/NSC. Jeżeli po ich odrzuceniu
  // nie zostaje chmura operacyjnie istotna, 9999 + brak WX daje CAVOK,
  // natomiast widzialność <9999 (albo obecne WX) daje jawne NSC.
  function normalizeCloudLine(line){
    let t=String(line||'').replace(/=$/,'').trim().split(/\s+/),clouds=t.filter(x=>parseCloud(x)),hadCloud=clouds.length>0,hadNsc=t.includes('NSC'),hadCavok=t.includes('CAVOK');
    if(clouds.length){const sel=selectCloudTokens(clouds);t=t.filter(x=>!parseCloud(x)).concat(sel)}
    const now=t.map(parseCloud).filter(Boolean),op=now.some(c=>c.type||c.ft<NSC_FT),wx=t.some(isWx),vis=t.find(x=>/^\d{4}$/.test(x));
    if(op){t=t.filter(x=>x!=='NSC'&&x!=='CAVOK');return t.join(' ').replace(/\s+/g,' ').trim()}
    if(hadCavok&&!wx){t=t.filter(x=>x!=='9999'&&x!=='NSC'&&x!=='CAVOK');t.push('CAVOK');return t.join(' ').replace(/\s+/g,' ').trim()}
    if(vis==='9999'&&!wx){t=t.filter(x=>x!=='9999'&&x!=='NSC'&&x!=='CAVOK');t.push('CAVOK');return t.join(' ').replace(/\s+/g,' ').trim()}
    if(vis||hadCloud||hadNsc||hadCavok){t=t.filter(x=>x!=='CAVOK'&&x!=='NSC');t.push('NSC')}
    return t.join(' ').replace(/\s+/g,' ').trim();
  }

  function getSeries(times){const w=$('engine')?.contentWindow;if(!w)return[];try{const d=w.eval(`consensus.map(z=>({t:z.t,WS:z.WS,WD:z.WD,G:z.G,count:z.count}))`);return Array.isArray(d)?d.filter(z=>fin(z?.t)&&z.t>=times.start&&z.t<times.end):[]}catch(_){return[]}}
  function encodedSpeed(z){const raw=+z?.WS*KT;if(!fin(raw))return NaN;let n=Math.max(0,Math.round(raw));if(n<1)return 0;if(n%2)n++;return n}
  function renderedWindSpeeds(){const out=[];for(const tr of document.querySelectorAll('#hours tr')){const txt=tr.children?.[1]?.textContent||'',m=txt.match(/\b(?:VRB|\d{3})(\d{2,3})(?:G(?:P99|\d{2,3}))?KT\b/);if(m)out.push(+m[1])}return out.filter(fin)}
  function dominantVrb02(series){
    const rendered=renderedWindSpeeds(),fallback=(series||[]).map(encodedSpeed).filter(fin),speeds=rendered.length>=8?rendered:fallback;
    if(speeds.length<8)return null;
    const low=speeds.filter(v=>v<=VRB_LOW).length,share=low/speeds.length,max=Math.max(...speeds);
    if(share<VRB_SHARE||max>VRB_OTHER_MAX)return null;
    return{share,count:low,total:speeds.length,max,source:rendered.length>=8?'table':'engine'};
  }
  function replaceBaseWind(line,token){const re=/\b(?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT\b/;return re.test(line)?line.replace(re,token):line}
  function suppressLowWindChanges(lines,use){
    if(!use)return lines;const out=[lines[0]];
    for(let i=1;i<lines.length;i++){
      const line=lines[i],m=line.match(/^(BECMG\s+\d{4}\/\d{4}\s+)((?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT)(?:\s+(.*))?$/);
      if(!m){out.push(line);continue}const sp=+(m[2].match(/(?:VRB|\d{3})(\d{2,3})/)||[])[1];if(!fin(sp)||sp>=10){out.push(line);continue}const rest=(m[3]||'').trim();if(rest)out.push((m[1]+rest).replace(/\s+/g,' ').trim());
    }
    return out;
  }

  function forecastHourState(tr){
    const c=tr?.children;if(!c||c.length<5)return null;
    const vis=String(c[2]?.textContent||'').trim(),wx=String(c[3]?.textContent||'').trim(),cloudText=String(c[4]?.textContent||'').trim(),clouds=cloudText.split(/\s+/).map(parseCloud).filter(Boolean),sig=clouds.filter(x=>x.type||x.ft<NSC_FT);
    const vis9999=/\b9999\b/.test(vis),clearWx=noWxText(wx),cavok=vis9999&&clearWx&&sig.length===0;
    const weakFewOnly=sig.length>0&&sig.every(x=>!x.type&&x.amount==='FEW'&&x.ft>=3000&&x.ft<NSC_FT);
    return{vis,wx,cloudText,clouds,sig,cavok,weakFewOnly};
  }
  function forecastCavokEvidence(){
    const states=[...document.querySelectorAll('#hours tr')].map(forecastHourState).filter(Boolean).slice(0,12);
    if(states.length<8)return null;
    const clear=states.filter(x=>x.cavok).length,share=clear/states.length,early=states.slice(0,3),earlyClear=early.filter(x=>x.cavok).length,earlyWeak=early.filter(x=>x.weakFewOnly).length;
    return{samples:states.length,clear,share,earlyClear,earlyWeak,supports:share>=CAVOK_SHARE};
  }
  function obsCavokCompatible(x){
    if(!x)return false;
    const raw=String(x.raw||x.canonical_raw||''),tokens=raw.replace(/=$/,'').split(/\s+/),vis=fin(+x.visibility_m)?+x.visibility_m:(/\bCAVOK\b/.test(raw)||/\b9999\b/.test(raw)?10000:NaN);
    if(!(vis>=10000))return false;
    const structuredWx=String(x.weather||'').trim();if(structuredWx&&!noWxText(structuredWx))return false;
    if(tokens.some(isWx))return false;
    let clouds=[];
    if(Array.isArray(x.clouds)&&x.clouds.length){clouds=x.clouds.map(c=>({ft:fin(+c.base_ft_agl)?+c.base_ft_agl:fin(+c.base_m_agl)?+c.base_m_agl*FT:NaN,type:String(c.type||c.cloud_type||'').toUpperCase()})).filter(c=>fin(c.ft))}
    else clouds=tokens.map(parseCloud).filter(Boolean).map(c=>({ft:c.ft,type:c.type}));
    return !clouds.some(c=>c.type==='CB'||c.type==='TCU'||c.ft<NSC_FT);
  }
  function recentClearEvidence(times){
    const rows=uniqueObsRows(recentCache).map(x=>({x,t:obsTime(x,times.start)})).filter(q=>fin(q.t)&&q.t<=times.start&&q.t>=times.start-6*3600e3).sort((a,b)=>b.t-a.t).slice(0,8);
    if(rows.length<3)return null;
    const clear=rows.filter(q=>obsCavokCompatible(q.x)),latestAge=(times.start-rows[0].t)/3600e3,share=clear.length/rows.length;
    if(latestAge>4||clear.length<3||share<.75)return null;
    return{samples:rows.length,clear:clear.length,share,latestAge};
  }

  // Jeżeli 12-godzinna prognoza ma dominujący reżim CAVOK (>=75%), a baza
  // różni się od niego wyłącznie słabym FEW 3000-4900 ft, ten pojedynczy sygnał
  // może zostać odrzucony, gdy początek prognozy lub bieżące METAR-y go nie wspierają.
  function applyObservedCloudEvidence(line,evidence,forecast){
    let t=String(line).split(/\s+/),vis=t.find(x=>/^\d{4}$/.test(x)),wx=t.some(isWx),clouds=t.map(parseCloud).filter(Boolean),sig=clouds.filter(c=>c.type||c.ft<NSC_FT);
    if(t.includes('CAVOK')||vis!=='9999'||wx||!forecast?.supports)return line;
    const weakFewOnly=sig.length>0&&sig.every(c=>!c.type&&c.amount==='FEW'&&c.ft>=3000&&c.ft<NSC_FT),startSupported=forecast.earlyClear>=2||!!evidence;
    if(!weakFewOnly||!startSupported)return line;
    t=t.filter(x=>!parseCloud(x)&&x!=='9999'&&x!=='NSC'&&x!=='CAVOK');t.push('CAVOK');
    return t.join(' ').replace(/\s+/g,' ').trim();
  }

  function mark(vrb,clear,forecast){
    disableSynopUi();const s=$('sources');if(s){
      let w=s.querySelector('[data-taf-vrb02]');if(!w){w=document.createElement('span');w.dataset.tafVrb02='1';s.appendChild(w)}w.className='pill '+(vrb?'ok':'');w.textContent=vrb?`VRB02 ${Math.round(vrb.share*100)}% ✓`:'VRB02 —';
      let c=s.querySelector('[data-metar-cloud-anchor]');if(!c){c=document.createElement('span');c.dataset.metarCloudAnchor='1';s.appendChild(c)}c.className='pill '+(clear?'ok':'');c.textContent=clear?`METAR CAVOK ${Math.round(clear.share*100)}% ✓`:'METAR CAVOK —';
      let f=s.querySelector('[data-forecast-cavok]');if(!f){f=document.createElement('span');f.dataset.forecastCavok='1';s.appendChild(f)}f.className='pill '+(forecast?.supports?'ok':'');f.textContent=forecast?`Prognoza CAVOK ${Math.round(forecast.share*100)}%${forecast.supports?' ✓':''}`:'Prognoza CAVOK —';
    }
    const b=$('reasons');if(b){
      b.querySelectorAll('[data-taf-policy-reason]').forEach(x=>x.remove());let ul=b.querySelector('ul');if(!ul){ul=document.createElement('ul');b.appendChild(ul)}
      if(vrb){const li=document.createElement('li');li.dataset.tafPolicyReason='vrb';li.textContent=`VRB02KT: ${vrb.count}/${vrb.total} godzin (${Math.round(vrb.share*100)}%) ma końcową prędkość <=02KT; maksymalna pozostała wartość ${vrb.max}KT.`;ul.appendChild(li)}
      if(forecast){const li=document.createElement('li');li.dataset.tafPolicyReason='forecastcavok';li.textContent=`CAVOK/NSC: ${forecast.clear}/${forecast.samples} godzin prognozy (${Math.round(forecast.share*100)}%) spełnia jednocześnie VIS 9999, brak znaczącego WX i brak chmur operacyjnie istotnych poniżej 5000 ft/CB/TCU.`;ul.appendChild(li)}
      if(clear){const li=document.createElement('li');li.dataset.tafPolicyReason='cloudobs';li.textContent=`METAR: ${clear.clear}/${clear.samples} ostatnich unikalnych obserwacji (${Math.round(clear.share*100)}%) meteorologicznie spełnia przesłanki CAVOK; akceptowane są także chmury wyłącznie >=5000 ft.`;ul.appendChild(li)}
    }
  }

  function reconcile(){
    if(applying)return;patchArchive();disableSynopUi();const el=$('taf'),cur=el?.textContent?.trim()||'';if(!/^TAF\s+(?:AMD\s+|COR\s+)?EPIR\b/.test(cur))return;
    const times=tafTimes(cur);if(!times)return;const series=getSeries(times),vrb=dominantVrb02(series),clear=recentClearEvidence(times),forecast=forecastCavokEvidence();
    let lines=cur.split(/\n+/).map(x=>x.trim().replace(/=$/, '')).filter(Boolean);if(!lines.length)return;
    lines[0]=normalizeCloudLine(lines[0]);if(vrb)lines[0]=replaceBaseWind(lines[0],'VRB02KT');lines[0]=applyObservedCloudEvidence(lines[0],clear,forecast);lines=suppressLowWindChanges(lines,vrb);
    const next=lines.join('\n')+'=';mark(vrb,clear,forecast);
    if(next!==cur){applying=true;el.textContent=next;applying=false}
  }

  function scheduleBurst(){[0,80,250,600,1200,2500].forEach(ms=>setTimeout(reconcile,ms))}
  function installCopyGuard(){const b=$('copy');if(!b||b.dataset.tafFinalCopy)return;b.dataset.tafFinalCopy='1';b.addEventListener('click',async e=>{const current=$('taf')?.textContent?.trim()||'';if(!/^TAF\s/.test(current))return;e.preventDefault();e.stopImmediatePropagation();reconcile();try{await navigator.clipboard.writeText($('taf')?.textContent?.trim()||current)}catch(_){}b.textContent='Skopiowano';setTimeout(()=>b.textContent='Kopiuj TAF',1200)},true)}
  function install(){
    patchArchive();disableSynopUi();installCopyGuard();
    const taf=$('taf'),hours=$('hours'),sources=$('sources');if(taf)new MutationObserver(scheduleBurst).observe(taf,{childList:true,characterData:true,subtree:true});if(hours)new MutationObserver(scheduleBurst).observe(hours,{childList:true,subtree:true});if(sources)new MutationObserver(()=>setTimeout(disableSynopUi,0)).observe(sources,{childList:true,subtree:true});
    const gen=$('gen');if(gen)gen.addEventListener('click',()=>{patchArchive();scheduleBurst()},true);
    scheduleBurst();setInterval(reconcile,1500);
  }
  window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({reconcile,dominantVrb02,recentClearEvidence,forecastCavokEvidence,patchArchive});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
