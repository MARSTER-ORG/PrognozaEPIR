'use strict';
(() => {
  if(!/\/taf\.html$/i.test(location.pathname) || window.__PROGNOZA_EPIR_TAF_POLRAD_NOWCAST__)return;
  window.__PROGNOZA_EPIR_TAF_POLRAD_NOWCAST__=true;

  const Core=window.PrognozaEPIRPolradNowcastCore;
  if(!Core){console.error('[TAF POLRAD] brak polrad-nowcast-core.js');return;}

  const EPIR={lat:52.828611,lon:18.330278,name:'EPIR'};
  const LIST_URL='https://meteo.imgw.pl/api/radars/v1/list/cmax';
  const FRAME_COUNT=10;
  const REFRESH_MS=4*60000;
  const IMAGE_TIMEOUT_MS=9000;
  let running=null,lastStarted=0;

  const finite=Number.isFinite;
  const normalizeUrl=u=>String(u||'').replace(/^http:\/\//i,'https://');

  async function fetchFrames(){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),9000);
    try{
      const r=await fetch(LIST_URL,{cache:'no-store',signal:ctl.signal,headers:{Accept:'application/json'}});
      if(!r.ok)throw Error('POLRAD CMAX HTTP '+r.status);
      const j=await r.json(),rows=j?.cmax?.list||Object.values(j||{}).find(v=>Array.isArray(v?.list))?.list;
      if(!Array.isArray(rows)||rows.length<3)throw Error('POLRAD CMAX: brak historii klatek');
      const uniq=new Map();
      for(const f of rows){const t=Number(f?.date);if(f?.url&&finite(t))uniq.set(t,{date:t,url:normalizeUrl(f.url)});}
      return [...uniq.values()].sort((a,b)=>a.date-b.date).slice(-FRAME_COUNT);
    }finally{clearTimeout(timer);}
  }

  function loadRaster(frame){
    return new Promise((resolve,reject)=>{
      const img=new Image();img.crossOrigin='anonymous';img.decoding='async';
      let done=false;
      const finish=(ok,value)=>{if(done)return;done=true;clearTimeout(timer);img.onload=null;img.onerror=null;ok?resolve(value):reject(value);};
      const timer=setTimeout(()=>finish(false,Error('POLRAD: timeout obrazu')),IMAGE_TIMEOUT_MS);
      img.onload=()=>{
        try{
          const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
          const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(img,0,0);
          const rgba=x.getImageData(0,0,c.width,c.height).data;
          finish(true,{time:Number(frame.date),width:c.width,height:c.height,rgba,url:frame.url});
        }catch(e){finish(false,Error('POLRAD: obraz CMAX nie pozwala na analizę pikselową ('+(e?.message||e)+')'));}
      };
      img.onerror=()=>finish(false,Error('POLRAD: błąd obrazu CMAX'));
      img.src=frame.url+(frame.url.includes('?')?'&':'?')+'_tafpolrad='+frame.date;
    });
  }

  async function loadRasters(frames){
    const out=[];
    // Small batches avoid opening ten full CMAX images at once on a phone.
    for(let i=0;i<frames.length;i+=3){
      const batch=await Promise.allSettled(frames.slice(i,i+3).map(loadRaster));
      for(const x of batch)if(x.status==='fulfilled')out.push(x.value);
    }
    if(out.length<3)throw Error(`POLRAD: tylko ${out.length} poprawnych klatek CMAX`);
    return out.sort((a,b)=>a.time-b.time);
  }

  function publish(value){
    window.PrognozaEPIRTAFRadarNowcast=value;
    window.dispatchEvent(new CustomEvent('prognozaepir:taf-polrad-nowcast-updated',{detail:value}));
    return value;
  }

  async function refresh(force=false){
    if(running)return running;
    const current=window.PrognozaEPIRTAFRadarNowcast;
    if(!force&&current&&!current.error&&Date.now()-lastStarted<REFRESH_MS)return current;
    lastStarted=Date.now();
    running=(async()=>{
      try{
        const frames=await fetchFrames(),rasters=await loadRasters(frames);
        const result=Core.analyzeHistory(rasters,EPIR,Date.now());
        result.source='IMGW-PIB POLRAD CMAX';
        result.station='EPIR';
        return publish(result);
      }catch(e){
        console.error('[TAF POLRAD]',e);
        return publish({version:Core.VERSION,updatedAt:new Date().toISOString(),station:'EPIR',point:EPIR,error:String(e?.message||e),stale:true,confidence:0});
      }finally{running=null;}
    })();
    return running;
  }

  function describe(nowcast,meta){
    if(!nowcast||nowcast.error)return null;
    const max=finite(Number(nowcast.maximum?.value))?Math.round(nowcast.maximum.value):null;
    const near=nowcast.nearestConvective;
    const eta=finite(Number(nowcast.etaMin))?Math.round(nowcast.etaMin):null;
    const conf=Math.round(Number(nowcast.confidence)||0);
    const changed=Number(meta?.changedRows)||0;
    if(changed<=0)return null;
    const parts=[`POLRAD CMAX: radarowy nowcast konwekcyjny skorygował TS w ${changed} h (0–3 h)`];
    if(max!==null)parts.push(`maks. ${max} dBZ`);
    if(near&&finite(Number(near.distance)))parts.push(`najbliższe ≥40 dBZ ${Math.round(near.distance)} km ${Core.compass16(near.bearing)}`);
    if(eta!==null)parts.push(`ETA podejścia ~${eta} min`);
    parts.push(`pewność wektora ${conf}%`);
    parts.push('sam radar nie podnosi TS do ≥50% bez dodatkowego sygnału modelowego');
    return parts.join(' · ')+'.';
  }

  function wrapEngineApi(){
    const api=window.PrognozaEPIRTAFEngine;
    if(!api?.createEngine||api.__polradNowcastWrapped)return false;
    const wrapped={...api,
      __polradNowcastWrapped:true,
      createEngine(options={}){
        const engine=api.createEngine(options);
        return Object.freeze({...engine,
          generate(input={}){
            const nowcast=window.PrognozaEPIRTAFRadarNowcast;
            const enhanced=nowcast&&!nowcast.error&&!nowcast.stale?Core.enhanceInput(input,nowcast):{...input,rows:(input.rows||[]).map(r=>({...r})),polradNowcastMeta:{error:nowcast?.error||null,stale:!!nowcast?.stale,changedRows:0}};
            const result=engine.generate(enhanced),meta=enhanced.polradNowcastMeta||{};
            const reason=describe(nowcast,meta),reasons=[...(result?.diagnostics?.reasons||[])];
            if(reason)reasons.push(reason);
            return {...result,
              diagnostics:{...result.diagnostics,reasons,polradNowcast:{source:nowcast?.source||'IMGW-PIB POLRAD CMAX',available:!!nowcast&&!nowcast.error,stale:!!nowcast?.stale,error:nowcast?.error||null,changedRows:meta.changedRows||0,maxRadarSupport:meta.maxRadarSupport||0,frameEnd:meta.frameEnd||null,ageMin:meta.ageMin??nowcast?.ageMin??null,confidence:meta.confidence??nowcast?.confidence??0,etaMin:meta.etaMin??nowcast?.etaMin??null}},
              radarNowcast:nowcast&&!nowcast.error?{...nowcast,predictions:{...(nowcast.predictions||{})}}:{error:nowcast?.error||'brak danych POLRAD'}
            };
          }
        });
      },
      helpers:Object.freeze({...api.helpers,polradNowcastEnhanceInput:Core.enhanceInput,polradRadarStormSupport:Core.radarStormSupport})
    };
    window.PrognozaEPIRTAFEngine=Object.freeze(wrapped);
    return true;
  }

  const ready=refresh(true);
  window.PrognozaEPIRTAFPolradNowcast=Object.freeze({version:Core.VERSION,refresh,get:()=>window.PrognozaEPIRTAFRadarNowcast||null,ready,wrapEngineApi});

  // Normally loaded after v2.4.3. Poll briefly as a defensive fallback if a
  // cached page evaluates scripts in a different order.
  if(!wrapEngineApi()){
    let tries=0;const timer=setInterval(()=>{tries++;if(wrapEngineApi()||tries>80)clearInterval(timer);},50);
  }
})();
