'use strict';
(() => {
  const SUPABASE_API='https://qozgntzeormujmqzkkmd.supabase.co/functions/v1/message-archive';
  const SUPABASE_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvemdudHplb3JtdWptcXpra21kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMjY1ODksImV4cCI6MjEwNDkwMjU4OX0.EV0cw-wlG8cQnFumLwsucxFfURHzlRRZdcusCZow-1o';
  const SUPABASE_ENABLED=window.PROGNOZAEPIR_SUPABASE_DISABLED!==true;
  const GITHUB_ROOT='https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages';
  const STATIC_ROOT='data/messages';
  const RAILWAY_ROOT='https://central-ingestor-production.up.railway.app/data/messages';
  const CUSTOM_ROOT=window.PROGNOZAEPIR_ARCHIVE_ROOT?String(window.PROGNOZAEPIR_ARCHIVE_ROOT).replace(/\/+$/,''):'';
  const PRIMARY_ROOT=SUPABASE_ENABLED?SUPABASE_API:(CUSTOM_ROOT||RAILWAY_ROOT);
  const TTL_MS=30_000,DAY_MS=86_400_000,cache=new Map(),nativeFetch=window.fetch.bind(window);
  const norm=v=>String(v||'').toUpperCase();
  const allowedTypes=new Set(['METAR','SPECI','TAF','SYNOP']);
  const fallbackRoots=()=>[...new Set([CUSTOM_ROOT,RAILWAY_ROOT,GITHUB_ROOT,STATIC_ROOT].filter(Boolean))];

  async function supabaseRequest(params={},force=false){
    if(!SUPABASE_ENABLED)throw new Error('Supabase MessageArchive disabled');
    const q=new URLSearchParams();
    Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')q.set(k,Array.isArray(v)?v.join(','):String(v))});
    const key=`sb:${q}`,now=Date.now(),hit=cache.get(key);if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);
    try{
      const response=await nativeFetch(`${SUPABASE_API}?${q}`,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:`Bearer ${SUPABASE_ANON}`,apikey:SUPABASE_ANON}});
      if(!response.ok){const e=new Error(`Supabase MessageArchive HTTP ${response.status}`);e.status=response.status;throw e}
      const value=await response.json();if(!value?.ok)throw new Error(value?.error||'Supabase MessageArchive invalid response');cache.set(key,{at:now,value,source:SUPABASE_API});return value;
    }finally{clearTimeout(timer)}
  }
  async function fetchFallback(root,name,asText){const c=new AbortController(),timer=setTimeout(()=>c.abort(),8_000);try{const r=await nativeFetch(`${root}/${name}?v=${Date.now()}`,{cache:'no-store',signal:c.signal,headers:{Accept:asText?'application/x-ndjson,text/plain,*/*':'application/json'}});if(!r.ok){const e=new Error(`MessageArchive ${name}: HTTP ${r.status}`);e.status=r.status;throw e}return asText?r.text():r.json()}finally{clearTimeout(timer)}}
  async function fallback(name,asText,force=false){const key=`fallback:${asText?'t':'j'}:${name}`,now=Date.now(),hit=cache.get(key);if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;const errors=[];for(const root of fallbackRoots()){try{const value=await fetchFallback(root,name,asText);cache.set(key,{at:now,value,source:root});return value}catch(error){errors.push({root,error})}}const e=new Error(`MessageArchive ${name}: źródła zapasowe niedostępne`);e.cause=errors;throw e}
  function daySpec(name){const m=String(name||'').match(/^(metar|speci|taf|synop)\/(\d{4})\/(\d{2})\/(\d{2})\.jsonl$/i);return m?{type:m[1].toUpperCase(),date:`${m[2]}-${m[3]}-${m[4]}`}:null}
  function rowTime(row){for(const k of ['archive_time','message_time','obs_time','issue_time','time','timestamp']){const t=Date.parse(row?.[k]||'');if(Number.isFinite(t))return t}return-Infinity}
  function dedupeSort(rows){const seen=new Set(),out=[];for(const row of rows||[]){if(!row)continue;const key=String(row.message_id||`${norm(row.type)}|${norm(row.station)}|${row.canonical_raw||row.raw||''}`);if(seen.has(key))continue;seen.add(key);out.push(row)}out.sort((a,b)=>rowTime(a)-rowTime(b));return out}
  const newest=rows=>dedupeSort(rows).slice(-1)[0]||null;
  const mergeRows=(...groups)=>dedupeSort(groups.flatMap(x=>Array.isArray(x)?x:[]));
  function dayPath(type,offset=0){const d=new Date(Date.now()-offset*DAY_MS);return `${String(type).toLowerCase()}/${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}.jsonl`}
  function parseJsonl(text,type,station=''){const t=norm(type),s=norm(station),rows=[];for(const line of String(text||'').split(/\r?\n/)){if(!line.trim())continue;try{const r=JSON.parse(line),rt=norm(r?.type||r?.report_type);if(rt&&rt!==t)continue;if(s&&norm(r?.station)!==s)continue;rows.push(r)}catch(_){}}return rows}
  async function fallbackRows(type,station='',force=false,days=2){const t=norm(type);if(!allowedTypes.has(t))return[];const out=[];for(let i=0;i<days;i++){try{out.push(...parseJsonl(await fallback(dayPath(t,i),true,force),t,station))}catch(e){if(e?.status!==404&&i===0)console.warn('MessageArchive fallback:',e)}}return dedupeSort(out)}

  async function fetchText(name,force=false){const clean=String(name||'').replace(/^\/+/, '');if(!clean||clean.includes('..')||!/^[A-Za-z0-9._/-]+$/.test(clean))throw new Error('MessageArchive: invalid archive path');const spec=daySpec(clean);if(spec&&SUPABASE_ENABLED){try{const r=await supabaseRequest({op:'day',type:spec.type,date:spec.date,limit:5000},force);return (r.rows||[]).map(x=>JSON.stringify(x)).join('\n')+((r.rows||[]).length?'\n':'')}catch(e){console.warn('MessageArchive Supabase day:',e)}}return fallback(clean,true,force)}
  async function latest(force=false){try{return (await supabaseRequest({op:'latest'},force)).data||{}}catch(e){console.warn('MessageArchive Supabase latest:',e);return fallback('latest.json',false,force)}}
  async function recent(force=false){try{const defs=[['METAR','EPIR'],['SPECI','EPIR'],['TAF','EPIR'],['SYNOP','12342']],rs=await Promise.all(defs.map(([type,station])=>supabaseRequest({op:'recent',type,station,limit:500},force)));const metar=rs[0].rows||[],speci=rs[1].rows||[];return{schema:'prognozaepir-message-archive-recent-v2',metar_only:metar,metar,speci,aviation:mergeRows(metar,speci),taf:rs[2].rows||[],synop:rs[3].rows||[]}}catch(e){console.warn('MessageArchive Supabase recent:',e);return fallback('recent.json',false,force)}}
  async function status(force=false){try{return (await supabaseRequest({op:'status'},force)).status||{}}catch(e){console.warn('MessageArchive Supabase status:',e);return fallback('status.json',false,force)}}
  async function getLatest(type,station='',force=false){const t=norm(type),s=norm(station);if(t==='AVIATION'){const[m,sp]=await Promise.all([getLatest('METAR',s||'EPIR',force),getLatest('SPECI',s||'EPIR',force)]);return newest([m,sp])}try{return (await supabaseRequest({op:'latest',type:t,station:s},force)).row||null}catch(e){console.warn(`MessageArchive latest ${t}:`,e);return newest(await fallbackRows(t,s,force,2))}}
  async function getRecent(type,station='',limit=0,force=false){const t=norm(type),s=norm(station),n=Math.max(0,Number(limit)||0);if(t==='AVIATION'){const[m,sp]=await Promise.all([getRecent('METAR',s||'EPIR',n,force),getRecent('SPECI',s||'EPIR',n,force)]),r=mergeRows(m,sp);return n?r.slice(-n):r}try{return (await supabaseRequest({op:'recent',type:t,station:s,limit:n||500},force)).rows||[]}catch(e){console.warn(`MessageArchive recent ${t}:`,e);const r=await fallbackRows(t,s,force,2);return n?r.slice(-n):r}}
  async function getRange(type,station='',from='',to='',limit=5000,force=false){const t=norm(type);return (await supabaseRequest({op:'range',type:t,station:norm(station),from,to,limit:Math.max(1,Math.min(5000,Number(limit)||5000))},force)).rows||[]}
  async function search(filters={},force=false){const params={op:'search',...filters};if(Array.isArray(params.types))params.types=params.types.map(norm).filter(t=>allowedTypes.has(t));if(params.type)params.type=norm(params.type);if(params.station)params.station=norm(params.station);return supabaseRequest(params,force)}
  async function stations(force=false){return (await supabaseRequest({op:'stations'},force)).stations||[]}
  async function fetchJson(name,force=false){const clean=String(name||'').replace(/^\/+/, '');if(clean==='latest.json')return latest(force);if(clean==='recent.json')return recent(force);if(clean==='status.json')return status(force);return fallback(clean,false,force)}

  const api=Object.freeze({root:PRIMARY_ROOT,liveRoot:PRIMARY_ROOT,supabaseRoot:SUPABASE_API,railwayRoot:RAILWAY_ROOT,githubRoot:GITHUB_ROOT,fallbackRoot:STATIC_ROOT,staticFallbackRoot:STATIC_ROOT,latest,recent,status,getLatest,getRecent,getRange,search,stations,fetchText,fetchJson,sourceFor(name){return cache.get(name)?.source||cache.get(`fallback:t:${name}`)?.source||cache.get(`fallback:j:${name}`)?.source||null},clear(){cache.clear()}});
  window.PrognozaEPIRMessageArchive=api;

  const legacy=input=>{try{const raw=typeof input==='string'?input:input?.url,u=new URL(raw,location.href);if(u.origin!==location.origin)return null;let m=u.pathname.match(/\/data\/messages\/(latest|recent|status)\.json$/i);if(m)return{kind:'json',name:`${m[1].toLowerCase()}.json`};m=u.pathname.match(/\/data\/messages\/((?:metar|speci|taf|synop)\/\d{4}\/\d{2}\/\d{2}\.jsonl)$/i);return m?{kind:'text',name:m[1]}:null}catch(_){return null}};
  window.fetch=async function(input,init){const req=legacy(input);if(!req)return nativeFetch(input,init);try{if(req.kind==='text')return new Response(await fetchText(req.name,true),{status:200,headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Source':'Supabase-primary-MessageArchive'}});const body=req.name==='latest.json'?await latest(true):req.name==='recent.json'?await recent(true):await status(true);return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Source':'Supabase-primary-MessageArchive'}})}catch(e){console.warn(`MessageArchive legacy bridge ${req.name}:`,e);return nativeFetch(input,init)}};

  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));
  if(/\/taf\.html$/i.test(location.pathname)){
    const sig=p=>[p?.aviation?.message_id||p?.metar?.message_id||'',p?.speci?.message_id||'',p?.taf_by_station?.EPIR?.message_id||p?.taf?.message_id||'',p?.taf_by_station?.EPBY?.message_id||'',p?.taf_by_station?.EPPW?.message_id||'',p?.taf_by_station?.EPKS?.message_id||''].join('|');let last=null;
    const trigger=()=>{if(document.visibilityState==='hidden')return false;const b=document.getElementById('gen'),badge=document.getElementById('badge');if(!b||typeof b.click!=='function'||String(badge?.textContent||'').toUpperCase().includes('ŁADOWANIE'))return false;b.click();return true};
    const check=async(initial=false)=>{try{const p=await latest(true),s=sig(p);if(last===null){last=s;if(initial)trigger();return}if(s!==last&&trigger())last=s}catch(e){console.warn('TAF archive freshness watcher:',e)}};
    window.addEventListener('load',()=>{setTimeout(()=>check(true),250);setInterval(()=>{if(document.visibilityState!=='hidden')check(false)},60_000)},{once:true});document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')check(false)});
  }
})();