'use strict';
(() => {
  const SUPABASE_API = 'https://qozgntzeormujmqzkkmd.supabase.co/functions/v1/message-archive';
  // Public anon key: intentionally browser-visible; it grants no service-role privileges.
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvemdudHplb3JtdWptcXpra21kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMjY1ODksImV4cCI6MjEwNDkwMjU4OX0.EV0cw-wlG8cQnFumLwsucxFfURHzlRRZdcusCZow-1o';
  const SUPABASE_ENABLED = window.PROGNOZAEPIR_SUPABASE_DISABLED !== true;
  const GITHUB_ROOT = 'https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages';
  const STATIC_ROOT = 'data/messages';
  const RAILWAY_ROOT = 'https://central-ingestor-production.up.railway.app/data/messages';
  const CUSTOM_ROOT = window.PROGNOZAEPIR_ARCHIVE_ROOT ? String(window.PROGNOZAEPIR_ARCHIVE_ROOT).replace(/\/+$/,'') : '';
  const PRIMARY_ROOT = SUPABASE_ENABLED ? SUPABASE_API : (CUSTOM_ROOT || RAILWAY_ROOT);
  const TTL_MS = 30_000;
  const DAY_MS = 86_400_000;
  const cache = new Map();
  const nativeFetch = window.fetch.bind(window);
  const norm = value => String(value || '').toUpperCase();

  function fallbackRoots(){ return [...new Set([CUSTOM_ROOT, RAILWAY_ROOT, GITHUB_ROOT, STATIC_ROOT].filter(Boolean))]; }

  async function supabaseRequest(params, force=false){
    if(!SUPABASE_ENABLED) throw new Error('Supabase MessageArchive disabled');
    const q = new URLSearchParams();
    for(const [k,v] of Object.entries(params || {})) if(v !== undefined && v !== null && v !== '') q.set(k,String(v));
    const key = `sb:${q.toString()}`;
    const now = Date.now(), hit = cache.get(key);
    if(!force && hit && now-hit.at<TTL_MS) return hit.value;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),6000);
    try{
      const response = await nativeFetch(`${SUPABASE_API}?${q.toString()}`,{
        cache:'no-store', signal:controller.signal,
        headers:{'Accept':'application/json','Authorization':`Bearer ${SUPABASE_ANON}`,'apikey':SUPABASE_ANON}
      });
      if(!response.ok){ const e=new Error(`Supabase MessageArchive HTTP ${response.status}`); e.status=response.status; throw e; }
      const value = await response.json();
      if(!value?.ok) throw new Error(value?.error || 'Supabase MessageArchive invalid response');
      cache.set(key,{at:now,value,source:SUPABASE_API});
      return value;
    } finally { clearTimeout(timer); }
  }

  async function fetchFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await nativeFetch(`${root}/${name}?v=${now}`, {cache:'no-store',signal:controller.signal,headers:{'Accept':'application/json'}});
      if(!response.ok){ const error=new Error(`MessageArchive ${name}: HTTP ${response.status}`); error.status=response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async function fetchTextFrom(root, name, now){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await nativeFetch(`${root}/${name}?v=${now}`, {cache:'no-store',signal:controller.signal,headers:{'Accept':'application/x-ndjson,text/plain,*/*'}});
      if(!response.ok){ const error=new Error(`MessageArchive ${name}: HTTP ${response.status}`); error.status=response.status; throw error; }
      return await response.text();
    } finally { clearTimeout(timer); }
  }

  async function fallbackArchiveText(clean, force=false){
    const key=`fallback-text:${clean}`, now=Date.now(), hit=cache.get(key);
    if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;
    const errors=[]; let allNotFound=true;
    for(const root of fallbackRoots()){
      try{ const value=await fetchTextFrom(root,clean,now); cache.set(key,{at:now,value,source:root}); return value; }
      catch(error){ if(error?.status!==404)allNotFound=false;errors.push({root,error}); }
    }
    const error=new Error(`MessageArchive ${clean}: Railway/GitHub/static archive unavailable`); error.status=allNotFound?404:0; error.cause=errors; throw error;
  }

  async function fallbackJson(name, force=false){
    const key=`fallback-json:${name}`, now=Date.now(), hit=cache.get(key);
    if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;
    const errors=[];
    for(const root of fallbackRoots()){
      try{ const value=await fetchFrom(root,name,now); cache.set(key,{at:now,value,source:root}); return value; }
      catch(error){errors.push({root,error});}
    }
    const error=new Error(`MessageArchive ${name}: Railway/GitHub/static archive unavailable`);error.cause=errors;throw error;
  }

  function daySpec(name){
    const m=String(name||'').match(/^(metar|speci|taf|synop)\/(\d{4})\/(\d{2})\/(\d{2})\.jsonl$/i);
    return m?{type:m[1].toUpperCase(),date:`${m[2]}-${m[3]}-${m[4]}`}:null;
  }

  async function fetchArchiveText(name, force=false){
    const clean=String(name||'').replace(/^\/+/, '');
    if(!clean||clean.includes('..')||!/^[A-Za-z0-9._/-]+$/.test(clean))throw new Error('MessageArchive: invalid archive path');
    const key=`text:${clean}`,now=Date.now(),hit=cache.get(key);
    if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;
    const spec=daySpec(clean);
    if(spec){
      try{
        const result=await supabaseRequest({op:'day',type:spec.type,date:spec.date,limit:5000},force);
        const text=(result.rows||[]).map(row=>JSON.stringify(row)).join('\n')+((result.rows||[]).length?'\n':'');
        cache.set(key,{at:now,value:text,source:SUPABASE_API});
        return text;
      }catch(error){ console.warn(`MessageArchive Supabase day ${clean}:`,error); }
    }
    const value=await fallbackArchiveText(clean,force); cache.set(key,{at:now,value,source:cache.get(`fallback-text:${clean}`)?.source||RAILWAY_ROOT}); return value;
  }

  function rowTime(row){
    if(!row)return-Infinity;
    for(const key of ['message_time','obs_time','issue_time','time','timestamp']){const t=Date.parse(row[key]||'');if(Number.isFinite(t))return t;}
    return-Infinity;
  }
  function dedupeSort(rows){
    const seen=new Set(),out=[];
    for(const row of rows||[]){if(!row)continue;const key=String(row.message_id||`${norm(row.type)}|${norm(row.station)}|${row.canonical_raw||row.raw||''}`);if(seen.has(key))continue;seen.add(key);out.push(row);}
    out.sort((a,b)=>rowTime(a)-rowTime(b));return out;
  }
  function newest(rows){return dedupeSort(rows).slice(-1)[0]||null;}
  function mergeRows(...groups){return dedupeSort(groups.flatMap(x=>Array.isArray(x)?x:[]));}

  function dayPath(type,offset=0){
    const d=new Date(Date.now()-offset*DAY_MS),y=String(d.getUTCFullYear()).padStart(4,'0'),m=String(d.getUTCMonth()+1).padStart(2,'0'),day=String(d.getUTCDate()).padStart(2,'0');
    return `${String(type).toLowerCase()}/${y}/${m}/${day}.jsonl`;
  }
  function parseJsonl(text,type,station=''){
    const t=norm(type),s=norm(station),rows=[];
    for(const line of String(text||'').split(/\r?\n/)){if(!line.trim())continue;try{const row=JSON.parse(line),rt=norm(row?.type||row?.report_type);if(rt&&rt!==t)continue;if(s&&norm(row?.station)!==s)continue;rows.push(row);}catch(error){console.warn('MessageArchive: invalid JSONL row',error);}}
    return rows;
  }
  async function fallbackRows(type,station='',force=false,days=1){
    const t=norm(type),s=norm(station);if(!['METAR','SPECI','TAF','SYNOP'].includes(t))return[];const out=[];
    for(let offset=0;offset<Math.max(1,days);offset++){const path=dayPath(t,offset);try{out.push(...parseJsonl(await fallbackArchiveText(path,force),t,s));}catch(error){if(error?.status!==404)throw error;}}
    return dedupeSort(out);
  }
  async function fallbackLatest(type,station='',force=false){
    const t=norm(type),s=norm(station);
    if(t==='AVIATION'){const[m,sp]=await Promise.all([fallbackLatest('METAR',s||'EPIR',force),fallbackLatest('SPECI',s||'EPIR',force)]);return newest([m,sp]);}
    let rows=await fallbackRows(t,s,force,1);if(rows.length)return rows[rows.length-1];rows=await fallbackRows(t,s,force,2);return rows[rows.length-1]||null;
  }

  function strictLatest(payload,type,station){
    const t=norm(type),s=norm(station);let row=null;
    if(t==='METAR')row=payload?.metar_only||payload?.metar||null;else if(t==='SPECI')row=payload?.speci||null;else if(t==='SYNOP')row=payload?.synop||null;else if(t==='TAF')row=s?payload?.taf_by_station?.[s]||null:payload?.taf||null;else if(t==='AVIATION')row=payload?.aviation||payload?.metar||null;
    if(!row)return null;return!s||norm(row.station)===s?row:null;
  }
  function strictRecent(payload,type,station,limit){
    const t=norm(type),s=norm(station);let rows=[];
    if(t==='METAR')rows=payload?.metar_only||payload?.metar||[];else if(t==='SPECI')rows=payload?.speci||[];else if(t==='SYNOP')rows=payload?.synop||[];else if(t==='TAF')rows=payload?.taf||[];else if(t==='AVIATION')rows=payload?.aviation||payload?.metar||[];
    if(!Array.isArray(rows))rows=[];if(s)rows=rows.filter(row=>norm(row?.station)===s);const n=Number(limit);if(Number.isFinite(n)&&n>0)rows=rows.slice(-n);return rows;
  }

  async function latest(force=false){
    try{
      const r=await supabaseRequest({op:'latest'},force),out=r.data||{};
      cache.set('latest.json',{at:Date.now(),value:out,source:SUPABASE_API});return out;
    }catch(error){console.warn('MessageArchive Supabase latest:',error);}
    const basePromise=fallbackJson('latest.json',force).catch(()=>({}));
    const[base,metar,speci,taf,synop]=await Promise.all([basePromise,fallbackLatest('METAR','EPIR',force).catch(()=>null),fallbackLatest('SPECI','EPIR',force).catch(()=>null),fallbackLatest('TAF','EPIR',force).catch(()=>null),fallbackLatest('SYNOP','12342',force).catch(()=>null)]);
    const out={...(base||{})};if(metar){out.metar=metar;out.metar_only=metar;}if(speci)out.speci=speci;const aviation=newest([out.aviation,metar,speci]);if(aviation)out.aviation=aviation;if(taf){out.taf=taf;out.taf_by_station={...(out.taf_by_station||{}),EPIR:taf};}if(synop)out.synop=synop;return out;
  }

  async function recent(force=false){
    try{
      const types=[['METAR','EPIR'],['SPECI','EPIR'],['TAF','EPIR'],['SYNOP','12342']];
      const rs=await Promise.all(types.map(([type,station])=>supabaseRequest({op:'recent',type,station,limit:500},force)));
      const metar=rs[0].rows||[],speci=rs[1].rows||[],taf=rs[2].rows||[],synop=rs[3].rows||[];
      const out={schema:'prognozaepir-message-archive-recent-v1',metar_only:metar,metar,speci,aviation:mergeRows(metar,speci),taf,synop};
      cache.set('recent.json',{at:Date.now(),value:out,source:SUPABASE_API});return out;
    }catch(error){console.warn('MessageArchive Supabase recent:',error);}
    const basePromise=fallbackJson('recent.json',force).catch(()=>({}));
    const[base,metar,speci,taf,synop]=await Promise.all([basePromise,fallbackRows('METAR','EPIR',force,2).catch(()=>[]),fallbackRows('SPECI','EPIR',force,2).catch(()=>[]),fallbackRows('TAF','EPIR',force,2).catch(()=>[]),fallbackRows('SYNOP','12342',force,2).catch(()=>[])]);
    const out={...(base||{})};out.metar_only=mergeRows(out.metar_only,metar);out.metar=mergeRows(out.metar,metar);out.speci=mergeRows(out.speci,speci);out.aviation=mergeRows(out.aviation,metar,speci);out.taf=mergeRows(out.taf,taf);out.synop=mergeRows(out.synop,synop);return out;
  }

  async function status(force=false){
    try{const r=await supabaseRequest({op:'status'},force),out=r.status||{};cache.set('status.json',{at:Date.now(),value:out,source:SUPABASE_API});return out;}
    catch(error){console.warn('MessageArchive Supabase status:',error);return fallbackJson('status.json',force);}
  }

  async function getLatest(type,station='',force=false){
    const t=norm(type),s=norm(station);
    if(t==='AVIATION'){
      try{const[m,sp]=await Promise.all([getLatest('METAR',s||'EPIR',force),getLatest('SPECI',s||'EPIR',force)]);return newest([m,sp]);}catch(_){}
    }else{
      try{const r=await supabaseRequest({op:'latest',type:t,station:s},force);return r.row||null;}catch(error){console.warn(`MessageArchive Supabase latest ${t}:`,error);}
    }
    try{const direct=await fallbackLatest(t,s,force);if(direct)return direct;}catch(error){console.warn(`MessageArchive fallback latest ${t}:`,error);}
    return strictLatest(await fallbackJson('latest.json',force),t,s);
  }

  async function getRecent(type,station='',limit=0,force=false){
    const t=norm(type),s=norm(station),n=Number(limit);
    if(t==='AVIATION'){
      try{const[m,sp]=await Promise.all([getRecent('METAR',s||'EPIR',limit,force),getRecent('SPECI',s||'EPIR',limit,force)]);const rows=mergeRows(m,sp);return Number.isFinite(n)&&n>0?rows.slice(-n):rows;}catch(_){}
    }else{
      try{const r=await supabaseRequest({op:'recent',type:t,station:s,limit:Number.isFinite(n)&&n>0?n:500},force);return r.rows||[];}catch(error){console.warn(`MessageArchive Supabase recent ${t}:`,error);}
    }
    try{let rows=await fallbackRows(t,s,force,2);if(rows.length)return Number.isFinite(n)&&n>0?rows.slice(-n):rows;}catch(error){console.warn(`MessageArchive fallback recent ${t}:`,error);}
    return strictRecent(await fallbackJson('recent.json',force),t,s,limit);
  }

  async function getRange(type,station='',from='',to='',limit=5000,force=false){
    const t=norm(type),s=norm(station),n=Math.max(1,Math.min(5000,Number(limit)||5000));
    try{const r=await supabaseRequest({op:'range',type:t,station:s,from,to,limit:n},force);return r.rows||[];}
    catch(error){console.warn(`MessageArchive Supabase range ${t}:`,error);throw error;}
  }

  async function fetchJson(name,force=false){
    const clean=String(name||'').replace(/^\/+/, '');
    if(clean==='latest.json')return latest(force);if(clean==='recent.json')return recent(force);if(clean==='status.json')return status(force);return fallbackJson(clean,force);
  }

  const api=Object.freeze({
    root:PRIMARY_ROOT,liveRoot:PRIMARY_ROOT,supabaseRoot:SUPABASE_API,railwayRoot:RAILWAY_ROOT,githubRoot:GITHUB_ROOT,fallbackRoot:STATIC_ROOT,staticFallbackRoot:STATIC_ROOT,
    latest,recent,status,getLatest,getRecent,getRange,fetchText:fetchArchiveText,fetchJson,
    sourceFor(name){return cache.get(name)?.source||cache.get(`text:${name}`)?.source||cache.get(`fallback-json:${name}`)?.source||cache.get(`fallback-text:${name}`)?.source||null;},
    clear(){cache.clear();}
  });
  window.PrognozaEPIRMessageArchive=api;

  const legacyArchiveRequest=input=>{
    try{
      const raw=typeof input==='string'?input:input?.url,u=new URL(raw,location.href);
      if(u.origin!==location.origin)return null;
      let m=u.pathname.match(/\/data\/messages\/(latest|recent|status)\.json$/i);
      if(m)return{kind:'json',name:`${m[1].toLowerCase()}.json`};
      m=u.pathname.match(/\/data\/messages\/((?:metar|speci|taf|synop)\/\d{4}\/\d{2}\/\d{2}\.jsonl)$/i);
      if(m)return{kind:'text',name:m[1]};
      return null;
    }catch(_){return null;}
  };
  window.fetch=async function(input,init){
    const req=legacyArchiveRequest(input);if(!req)return nativeFetch(input,init);
    try{
      if(req.kind==='text'){
        const body=await fetchArchiveText(req.name,true);
        return new Response(body,{status:200,headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store, max-age=0','X-PrognozaEPIR-Source':'Supabase-primary-MessageArchive'}});
      }
      const body=req.name==='latest.json'?await latest(true):req.name==='recent.json'?await recent(true):await status(true);
      return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, max-age=0','X-PrognozaEPIR-Source':'Supabase-primary-MessageArchive'}});
    }catch(error){console.warn(`MessageArchive legacy bridge ${req.name}:`,error);return nativeFetch(input,init);}
  };

  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));

  if(/\/taf\.html$/i.test(location.pathname)){
    const tafArchiveSignature=payload=>[payload?.aviation?.message_id||payload?.metar?.message_id||'',payload?.speci?.message_id||'',payload?.taf_by_station?.EPIR?.message_id||payload?.taf?.message_id||'',payload?.taf_by_station?.EPBY?.message_id||'',payload?.taf_by_station?.EPPW?.message_id||'',payload?.taf_by_station?.EPKS?.message_id||''].join('|');
    let lastTafArchiveSignature=null;
    const triggerTafGenerator=()=>{if(document.visibilityState==='hidden')return false;const button=document.getElementById('gen'),badge=document.getElementById('badge');if(!button||typeof button.click!=='function')return false;if(String(badge?.textContent||'').toUpperCase().includes('ŁADOWANIE'))return false;button.click();return true;};
    const checkTafArchiveFreshness=async(initial=false)=>{try{const payload=await latest(true),signature=tafArchiveSignature(payload);if(lastTafArchiveSignature===null){lastTafArchiveSignature=signature;if(initial)triggerTafGenerator();return;}if(signature!==lastTafArchiveSignature&&triggerTafGenerator())lastTafArchiveSignature=signature;}catch(error){console.warn('TAF archive freshness watcher:',error);}};
    window.addEventListener('load',()=>{setTimeout(()=>checkTafArchiveFreshness(true),250);setInterval(()=>{if(document.visibilityState!=='hidden')checkTafArchiveFreshness(false);},60_000);},{once:true});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')checkTafArchiveFreshness(false);});
  }
})();
