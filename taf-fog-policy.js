'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFFogPolicy=api;
  if(root&&root.document)installTaf244Ui(root,api);

  function installTaf244Ui(win,policy){
    try{
      if(!/\/taf\.html$/i.test(win.location?.pathname||''))return;
      const H=3600000,ACTIVE=60,finite=Number.isFinite;
      const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
      const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const pad=n=>String(Math.max(0,Math.round(n))).padStart(2,'0');
      const fmt=t=>{if(!finite(+t))return'—';const d=new Date(+t);return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth()+1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;};
      const proc={RAD:'radiacyjna',ADV:'adwekcyjna',CBL:'stratus → mgła',PCP:'opadowa'};
      let summarySig='',lastHourlyResult=null;

      try{win.localStorage?.setItem(policy.MODE_KEY,'vnext');}catch(_){}
      win.PrognozaEPIRFogSelectedMode='vnext';

      function frame(){return win.document.getElementById('engine')?.contentWindow||null;}
      function nearest(series,t,max=40*60000){let best=null,bd=Infinity;for(const x of series||[]){const q=num(x?.t??x?.time);if(!finite(q))continue;const d=Math.abs(q-t);if(d<bd){bd=d;best=x;}}return bd<=max?best:null;}
      function getBundle(){
        try{
          const w=frame();if(!w)return null;
          const fg=Array.isArray(w.PrognozaEPIRFogSeries)?w.PrognozaEPIRFogSeries:[];
          const br=Array.isArray(w.PrognozaEPIRBRSeries)?w.PrognozaEPIRBRSeries:[];
          const mifg=w.PrognozaEPIRMIFG?.getSeries?.()||[];
          const ok=fg.length>10&&br.length>10&&mifg.length>10&&fg.some(x=>String(x?.fogEngineVersion||x?.engineVersion||'').includes('2.4.4')||String(x?.fogEngineSource||'').includes('2.4.4'));
          return ok?{w,fg,br,mifg}:null;
        }catch(_){return null;}
      }
      function context(bundle,t){
        const f=nearest(bundle.fg,t),m=nearest(bundle.mifg,t);
        const vis=num(f?.visGuidance?.point)??num(f?.visProposed)??num(f?.vis)??num(f?.visibility);
        const temp=num(f?.integrated244?.input?.T)??num(f?.T)??num(m?.T);
        const primary=f?.type?.primary||f?.vnextProbability?.mechanism1||f?.type?.text||null;
        const fgScore=num(f?.score);
        return {f,m,vis,temp,primary,fgScore};
      }
      function score(row){const s=num(row?.score);return finite(s)?Math.round(s):null;}
      function maxRow(series,start,hours){
        const end=start+hours*H;
        return (series||[]).filter(x=>{const t=num(x?.t??x?.time);return finite(t)&&t>=start&&t<=end&&finite(num(x?.score));}).reduce((a,b)=>!a||num(b.score)>num(a.score)?b:a,null);
      }
      function nearestNow(series,now=Date.now()){
        let best=null,bd=Infinity;for(const x of series||[]){const t=num(x?.t??x?.time);if(!finite(t)||!finite(num(x?.score)))continue;const d=Math.abs(t-now);if(d<bd){bd=d;best=x;}}
        return best;
      }
      function fzfg(bundle,t){
        const c=context(bundle,t);return finite(c.fgScore)&&c.fgScore>=ACTIVE&&finite(c.vis)&&c.vis<1000&&finite(c.temp)&&c.temp<=0;
      }
      function cell(bundle,row,kind){
        if(!row)return'<span class="muted">—</span>';
        const t=num(row?.t??row?.time),s=score(row),c=context(bundle,t),vis=num(row?.visibility)??c.vis;
        const type=c.primary?`${esc(c.primary)} · ${esc(proc[c.primary]||String(c.primary))}`:'—';
        const temp=finite(c.temp)?`${c.temp>=0?'+':''}${c.temp.toFixed(1)}°C`:'—';
        const freeze=fzfg(bundle,t)?'TAK':'NIE';
        return `<b>${s===null?'—':s+'/100'}</b><div class="muted" style="font-size:11px;line-height:1.35;margin-top:3px">${fmt(t)}<br>VIS ${finite(vis)?Math.round(vis)+' m':'—'} · ${type}<br>T2m ${temp} · FZFG ${freeze}</div>`;
      }
      function ensureUi(){
        const mode=win.document.getElementById('tafFogModeSwitch');
        if(mode&&!mode.dataset.fog244){
          mode.dataset.fog244='1';
          mode.innerHTML='<div class="fog-mode-copy"><b>Silnik mgły używany przez TAF: EPIR FOG 2.4.4</b><span>Generator korzysta z tych samych serii FG, BR i MIFG co strona EPIR FOG. Tryb LEGACY jest wyłączony dla TAF, aby wartości nie rozjeżdżały się między modułami.</span></div><div class="fog-mode-state">AKTYWNY: EPIR FOG 2.4.4</div>';
        }
        const hours=win.document.getElementById('hours'),table=hours?.closest('table');
        if(table){
          const tr=table.querySelector('thead tr');
          if(tr&&!tr.dataset.fog244){
            tr.dataset.fog244='1';
            tr.innerHTML='<th>Czas UTC</th><th>Wiatr</th><th>Widzialność TAF</th><th>Zjawiska</th><th>Chmury (m AGL)</th><th>Pułap BKN/OVC (m AGL)</th><th>Opad / TS</th><th>FG</th><th>BR</th><th>MIFG</th><th>VIS FOG</th><th>Typ / FZFG</th>';
          }
        }
        if(!win.document.getElementById('fog244Summary')){
          const hourCard=hours?.closest('section.card');
          if(hourCard){
            const sec=win.document.createElement('section');sec.className='card';sec.id='fog244Summary';sec.style.marginTop='12px';
            sec.innerHTML='<h2>EPIR FOG 2.4.4 — osobne maksimum FG / BR / MIFG</h2><div class="muted" style="margin-bottom:8px;font-size:12px">Wartości 1:1 z tego samego silnika mgieł. Próg aktywności: 60/100. VIS i FZFG są pokazane diagnostycznie; formalne kodowanie TAF nadal przechodzi reguły instrukcji.</div><div class="tablewrap"><table><thead><tr><th>Zjawisko</th><th>Najbliższa godzina</th><th>MAX 24 h</th><th>MAX 48 h</th></tr></thead><tbody id="fog244SummaryBody"><tr><td colspan="4">Oczekiwanie na EPIR FOG 2.4.4…</td></tr></tbody></table></div>';
            hourCard.parentNode.insertBefore(sec,hourCard);
          }
        }
      }
      function renderSummary(){
        ensureUi();const b=getBundle(),host=win.document.getElementById('fog244SummaryBody');if(!b||!host)return;
        const now=Date.now(),sets=[['FG',b.fg],['BR',b.br],['MIFG',b.mifg]],parts=[];
        for(const [kind,series] of sets){const near=nearestNow(series,now),start=num(near?.t??near?.time)??now,m24=maxRow(series,start,24),m48=maxRow(series,start,48);parts.push({kind,near,m24,m48});}
        const sig=parts.map(x=>[x.kind,num(x.near?.t),score(x.near),num(x.m24?.t),score(x.m24),num(x.m48?.t),score(x.m48)].join(':')).join('|');
        if(sig===summarySig)return;summarySig=sig;
        host.innerHTML=parts.map(x=>`<tr><td><b>${x.kind}</b></td><td>${cell(b,x.near,x.kind)}</td><td>${cell(b,x.m24,x.kind)}</td><td>${cell(b,x.m48,x.kind)}</td></tr>`).join('');
      }
      function renderHourly(){
        ensureUi();const result=win.PrognozaEPIRTAFResultV24,b=getBundle(),host=win.document.getElementById('hours');
        if(!result?.hourly?.length||!b||!host||result===lastHourlyResult)return;
        const trs=[...host.children];if(trs.length!==result.hourly.length)return;
        result.hourly.forEach((h,i)=>{
          const tr=trs[i];if(!tr)return;while(tr.children.length>7)tr.removeChild(tr.lastElementChild);
          const t=+h.t,f=nearest(b.fg,t),br=nearest(b.br,t),m=nearest(b.mifg,t),c=context(b,t),fgs=score(f),brs=score(br),ms=score(m),freeze=fzfg(b,t)?'TAK':'NIE',type=c.primary?`${c.primary} · ${proc[c.primary]||c.primary}`:'—';
          const vals=[fgs===null?'—':fgs+'/100',brs===null?'—':brs+'/100',ms===null?'—':ms+'/100',finite(c.vis)?Math.round(c.vis)+' m':'—',`${type} · FZFG ${freeze}`];
          vals.forEach((v,j)=>{const td=win.document.createElement('td');td.textContent=v;if(j<3&&parseInt(v,10)>=ACTIVE)td.style.fontWeight='700';tr.appendChild(td);});
        });
        lastHourlyResult=result;renderSummary();
      }
      function start(){
        ensureUi();renderSummary();renderHourly();
        const host=win.document.getElementById('hours');if(host){const mo=new MutationObserver(()=>{lastHourlyResult=null;setTimeout(renderHourly,0);});mo.observe(host,{childList:true});}
        setInterval(()=>{renderSummary();renderHourly();},2500);
      }
      if(win.document.readyState==='loading')win.document.addEventListener('DOMContentLoaded',start,{once:true});else start();
    }catch(e){console.warn('[TAF Fog 2.4.4 UI]',e);}
  }
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  // BUILD is retained for the existing strict TAF startup contract. The 2.4.4
  // synchronization revision is carried by the per-commit cache-busting URL.
  const BUILD='20260920-fg-vis-gate';
  const MODE_KEY='prognozaepir-fog-engine-mode';
  const finite=Number.isFinite;
  const num=v=>v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;
  const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));

  function normalizeMode(value){
    const s=String(value||'').toLowerCase();
    return s.includes('vnext')||s.includes('2.4.4')?'vnext':'legacy';
  }

  function selectedMode(win){
    try{
      const live=String(win?.PrognozaEPIRFogEngineMode||win?.PrognozaEPIRFogSelectedMode||'').toLowerCase();
      if(live.includes('vnext')||live.includes('2.4.4'))return'vnext';
      const stored=win?.localStorage?.getItem(MODE_KEY);
      if(stored==='vnext'||stored==='legacy')return stored;
      return 'vnext';
    }catch(_){return'vnext';}
  }

  function operationalScoreForTaf(score,mode){
    const s=num(score);if(!finite(s))return null;
    const x=clamp(s);
    if(normalizeMode(mode)==='vnext'||x<50||x>=80)return x;
    return 60+(x-50)*(20/30);
  }

  function activeVisibility(f,mode){
    if(!f)return null;
    if(normalizeMode(mode)==='vnext')return num(f?.visGuidance?.point)??num(f?.visProposed)??num(f?.vis)??num(f?.visibility);
    return num(f?.vis)??num(f?.visibility);
  }

  function thresholdRisk(f,threshold,mode){
    if(!f)return null;
    if(normalizeMode(mode)==='vnext')return num(f?.visGuidance?.['p'+threshold])??num(f?.['visProb'+threshold])??num(f?.['vis'+threshold]);
    return num(f?.['vis'+threshold]);
  }

  function mechanismType(f,mode){
    if(!f)return null;
    if(normalizeMode(mode)==='vnext'){
      const a=f?.vnextProbability?.mechanism1||f?.mechanism1||f?.vnext?.mechanism1||f?.type?.primary||null;
      const b=f?.vnextProbability?.mechanism2||f?.mechanism2||f?.vnext?.mechanism2||f?.type?.secondary||null;
      return a?(b?`${a}/${b}`:String(a)):(f?.type?.text||f?.type||null);
    }
    return f?.type?.text||f?.type||null;
  }

  function normalizeFogHour(f,forcedMode){
    if(!f)return null;
    const mode=normalizeMode(forcedMode||f.fogEngineMode||f.fogEngineSource);
    const rawScore=num(f.score)??0;
    const mappedScore=operationalScoreForTaf(rawScore,mode)??0;
    const vis1000=thresholdRisk(f,1000,mode),vis1500=thresholdRisk(f,1500,mode),vis500=thresholdRisk(f,500,mode),vis200=thresholdRisk(f,200,mode);
    const vis=activeVisibility(f,mode);
    const integrated244=mode==='vnext'&&(String(f?.fogEngineVersion||'').includes('2.4.4')||String(f?.fogEngineSource||'').includes('2.4.4')||finite(num(f?._br244?.score)));
    const brRawScore=num(f?._br244?.score);
    const mifgRawScore=num(f?._mifg244?.score);

    // EPIR FOG 2.4.4 risk is kept intact. The visibility checks below are only
    // the formal TAF weather-code eligibility gate; they no longer redefine the
    // displayed FG/BR/MIFG probabilities.
    const fgVisibilitySupported=finite(vis)?vis<1000:(finite(vis1000)&&vis1000>=50);
    const brVisibilitySupported=finite(vis)&&vis>=1000&&vis<=5000;
    const fgOperationalScore=fgVisibilitySupported?mappedScore:0;
    const brOperationalScore=finite(brRawScore)
      ? (brVisibilitySupported?clamp(brRawScore):0)
      : (brVisibilitySupported?mappedScore:null);
    const fogAltVisM=finite(vis)
      ? (vis<1000?Math.max(100,Math.min(900,vis)):null)
      : (finite(vis1000)&&vis1000>=50?(finite(vis500)&&vis500>=50?500:800):null);

    return {
      mode,rawScore,engineFogScore:mappedScore,
      // For 2.4.4 the generic fog channel is disabled in the TAF kernel so it
      // cannot overwrite the dedicated FG and BR targets. Dedicated fields below
      // are authoritative. Legacy keeps its historical generic channel.
      fogScore:integrated244?0:mappedScore,
      fgOperationalScore,brOperationalScore,brRawScore,mifgRawScore,
      fgVisibilitySupported,brVisibilitySupported,
      vis,vis1500,vis1000,vis500,vis200,fogAltVisM,
      confidence:mode==='vnext'?(num(f?.visGuidance?.confidence)??num(f?.visConfidence)??num(f?.confidence)):num(f?.confidence),
      type:mechanismType(f,mode),
      source:f.fogEngineSource||f.fogEngineMode||mode,
      fallback:Boolean(f.fogEngineFallback)
    };
  }

  function cloneSeries(series){
    return (Array.isArray(series)?series:[]).map(x=>({...x,models:Array.isArray(x?.models)?x.models.map(m=>({...m})):x?.models}));
  }

  function nearest(series,t,max=40*60000){let best=null,bd=Infinity;for(const x of series||[]){const q=num(x?.t??x?.time);if(!finite(q))continue;const d=Math.abs(q-t);if(d<bd){bd=d;best=x;}}return bd<=max?best:null;}
  function merge244(win,series){
    const br=Array.isArray(win?.PrognozaEPIRBRSeries)?win.PrognozaEPIRBRSeries:[];
    let mifg=[];try{mifg=win?.PrognozaEPIRMIFG?.getSeries?.()||win?.PrognozaEPIRMIFGSeries||[];}catch(_){}
    return cloneSeries(series).map(x=>{const t=num(x?.t??x?.time),b=finite(t)?nearest(br,t):null,m=finite(t)?nearest(mifg,t):null;return{...x,_br244:b?_cloneSmall(b):null,_mifg244:m?_cloneSmall(m):null};});
  }
  function _cloneSmall(x){return x?{...x}:null;}

  function recoverLegacySeries(series){
    return cloneSeries(series).map(x=>{
      const legacyScore=num(x?.fogScoreLegacy);
      if(!finite(legacyScore))return x;
      return {...x,score:legacyScore,fogEngineMode:'legacy',fogEngineSource:'legacy-recovered',fogEngineFallback:false};
    }).filter(x=>normalizeMode(x?.fogEngineMode||x?.fogEngineSource)!=='vnext');
  }

  function seriesForMode(win,mode){
    const m=normalizeMode(mode||selectedMode(win));
    if(m==='vnext'){
      const v=win?.PrognozaEPIRFogVNextSeries;
      if(Array.isArray(v)&&v.length)return merge244(win,v);
      const active=win?.PrognozaEPIRFogSeries;
      if(Array.isArray(active)&&active.length&&active.some(x=>normalizeMode(x?.fogEngineMode||x?.fogEngineSource)==='vnext'))return merge244(win,active);
      return [];
    }
    const legacy=win?.PrognozaEPIRFogLegacySeries;
    if(Array.isArray(legacy)&&legacy.length)return cloneSeries(legacy);
    const active=win?.PrognozaEPIRFogSeries;
    if(Array.isArray(active)&&active.length&&!active.some(x=>normalizeMode(x?.fogEngineMode||x?.fogEngineSource)==='vnext'))return cloneSeries(active);
    if(Array.isArray(active)&&active.some(x=>finite(num(x?.fogScoreLegacy))))return recoverLegacySeries(active);
    return [];
  }

  return Object.freeze({BUILD,MODE_KEY,normalizeMode,selectedMode,operationalScoreForTaf,activeVisibility,thresholdRisk,mechanismType,normalizeFogHour,seriesForMode,cloneSeries,recoverLegacySeries});
});
