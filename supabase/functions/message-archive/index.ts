import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
  'cache-control': 'no-store',
};
const TYPES = new Set(['METAR','SPECI','TAF','SYNOP']);
const FLAGS: Record<string,string> = {FG:'has_fg',BR:'has_br',MIFG:'has_mifg',TS:'has_ts',RA:'has_ra',SN:'has_sn',CB:'has_cb',TCU:'has_tcu',VV:'has_vv'};
const SELECT = 'id,message_type,station_code,observed_at,issued_at,valid_from,valid_to,archive_time,raw_text,normalized_text,source_ref,payload,ingested_at,visibility_m,wind_direction_deg,wind_speed_kt,gust_kt,temperature_c,qnh_hpa,ceiling_ft,weather_codes,has_fg,has_br,has_mifg,has_ts,has_ra,has_sn,has_cb,has_tcu,has_vv';

function json(body: unknown, status=200){return new Response(JSON.stringify(body),{status,headers:{...CORS,'content-type':'application/json; charset=utf-8'}})}
function iso(v:unknown){if(!v)return null;const t=Date.parse(String(v));return Number.isFinite(t)?new Date(t).toISOString().replace('.000Z','Z'):null}
function projectRow(r:any){const p=(r.payload&&typeof r.payload==='object')?r.payload:{};const type=String(r.message_type||p.type||'').toUpperCase(),station=String(r.station_code||p.station||'').toUpperCase(),time=r.archive_time||r.observed_at||r.issued_at||r.ingested_at;return {...p,schema:p.schema||'prognozaepir-message-v1',message_id:p.message_id||String(r.id),type,station,message_time:p.message_time||iso(time),obs_time:p.obs_time||(type==='TAF'?undefined:iso(r.observed_at||time)),issue_time:p.issue_time||(type==='TAF'?iso(r.issued_at||time):undefined),valid_from:p.valid_from||iso(r.valid_from),valid_to:p.valid_to||iso(r.valid_to),raw:p.raw||r.raw_text,canonical_raw:p.canonical_raw||r.normalized_text||r.raw_text,source:p.source||null,source_ref:p.source_ref||r.source_ref||null,archive_time:iso(time),visibility_m:p.visibility_m??r.visibility_m??null,wind_direction_deg:p.wind_direction_deg??r.wind_direction_deg??null,wind_speed_kt:p.wind_speed_kt??r.wind_speed_kt??(Number.isFinite(Number(p.wind_speed_ms))?Number(p.wind_speed_ms)*1.9438444924406:null),gust_kt:p.wind_gust_kt??r.gust_kt??(Number.isFinite(Number(p.wind_gust_ms))?Number(p.wind_gust_ms)*1.9438444924406:null),temperature_c:p.temperature_c??r.temperature_c??null,pressure_hpa:p.pressure_hpa??r.qnh_hpa??null,ceiling_ft:p.ceiling_ft_agl??r.ceiling_ft??null,weather_codes:r.weather_codes||[]}}
function normalizeType(v:string|null){const t=String(v||'').toUpperCase();return TYPES.has(t)?t:''}
function normalizeTypes(v:string|null,fallback=''){return [...new Set(String(v||fallback||'').split(',').map(x=>normalizeType(x.trim())).filter(Boolean))]}
function clampInt(v:string|null,def:number,max:number){if(v===null||String(v).trim()==='')return def;const n=Number(v);return Number.isFinite(n)&&n>=0?Math.min(max,Math.floor(n)):def}
function finite(v:string|null){if(v===null||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}
function literalPattern(v:string){return v.replace(/[\\%_]/g,ch=>`\\${ch}`)}
function searchTokens(v:string|null){const s=String(v||'').trim().slice(0,160);return s?s.split(/\s*\+\s*|\s+/).map(x=>x.trim()).filter(Boolean).slice(0,10):[]}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  if(req.method!=='GET')return json({ok:false,error:'method not allowed'},405);
  try{
    const url=new URL(req.url),op=String(url.searchParams.get('op')||'latest').toLowerCase(),type=normalizeType(url.searchParams.get('type')),station=String(url.searchParams.get('station')||'').trim().toUpperCase().slice(0,16),limit=Math.max(1,clampInt(url.searchParams.get('limit'),200,5000));
    const supabaseUrl=Deno.env.get('SUPABASE_URL'),serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');if(!supabaseUrl||!serviceKey)throw new Error('service environment unavailable');
    const db=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}}),base=()=>db.from('messages').select(SELECT);
    const filtered=(q:any)=>{if(type)q=q.eq('message_type',type);if(station)q=q.eq('station_code',station);return q};

    if(op==='latest'){
      if(type){const {data,error}=await filtered(base()).order('archive_time',{ascending:false,nullsFirst:false}).limit(1);if(error)throw error;return json({ok:true,row:data?.[0]?projectRow(data[0]):null})}
      const wanted=[['METAR','EPIR'],['SPECI','EPIR'],['TAF','EPIR'],['SYNOP','12342'],['TAF','EPBY'],['TAF','EPKS'],['TAF','EPPW']];
      const pairs=await Promise.all(wanted.map(async([t,s])=>{const {data,error}=await base().eq('message_type',t).eq('station_code',s).order('archive_time',{ascending:false,nullsFirst:false}).limit(1);if(error)throw error;return [t,s,data?.[0]?projectRow(data[0]):null] as const}));
      const out:any={schema:'prognozaepir-message-archive-api-v3',updated_at:new Date().toISOString().replace('.000Z','Z'),taf_by_station:{}};for(const[t,s,r]of pairs){if(!r)continue;if(t==='METAR'){out.metar=r;out.metar_only=r}else if(t==='SPECI')out.speci=r;else if(t==='SYNOP')out.synop=r;else if(t==='TAF'){out.taf_by_station[s]=r;if(s==='EPIR')out.taf=r}}const aviation=[out.metar,out.speci].filter(Boolean).sort((a:any,b:any)=>Date.parse(a.message_time||0)-Date.parse(b.message_time||0)).pop();if(aviation)out.aviation=aviation;return json({ok:true,data:out});
    }

    if(op==='recent'||op==='range'||op==='day'){
      let q:any=filtered(base()),from=url.searchParams.get('from'),to=url.searchParams.get('to');if(op==='day'){const day=url.searchParams.get('date');if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day||'')))return json({ok:false,error:'invalid date'},400);from=`${day}T00:00:00Z`;to=`${day}T23:59:59.999Z`}if(op==='recent'&&!from)from=new Date(Date.now()-72*3600e3).toISOString();if(from)q=q.gte('archive_time',from);if(to)q=q.lte('archive_time',to);q=q.order('archive_time',{ascending:true,nullsFirst:false}).limit(limit);const {data,error}=await q;if(error)throw error;return json({ok:true,rows:(data||[]).map(projectRow)});
    }

    if(op==='search'){
      const types=normalizeTypes(url.searchParams.get('types'),url.searchParams.get('type')||''),offset=clampInt(url.searchParams.get('offset'),0,1000000);let q:any=db.from('messages').select(SELECT,{count:'exact'});if(types.length===1)q=q.eq('message_type',types[0]);else if(types.length>1)q=q.in('message_type',types);if(station)q=q.eq('station_code',station);const from=url.searchParams.get('from'),to=url.searchParams.get('to');if(from)q=q.gte('archive_time',from);if(to)q=q.lte('archive_time',to);for(const token of searchTokens(url.searchParams.get('text')))q=q.ilike('normalized_text',`%${literalPattern(token.toUpperCase())}%`);
      const numeric:[string,string,string][]=[['visibility_min','visibility_m','gte'],['visibility_max','visibility_m','lte'],['ceiling_min_ft','ceiling_ft','gte'],['ceiling_max_ft','ceiling_ft','lte'],['wind_speed_min_kt','wind_speed_kt','gte'],['wind_speed_max_kt','wind_speed_kt','lte'],['gust_min_kt','gust_kt','gte'],['gust_max_kt','gust_kt','lte'],['temp_min_c','temperature_c','gte'],['temp_max_c','temperature_c','lte'],['qnh_min','qnh_hpa','gte'],['qnh_max','qnh_hpa','lte']];for(const[param,column,operator]of numeric){const value=finite(url.searchParams.get(param));if(value!==null)q=(q as any)[operator](column,value)}const df=finite(url.searchParams.get('wind_dir_from')),dt=finite(url.searchParams.get('wind_dir_to'));if(df!==null&&dt!==null){if(df<=dt)q=q.gte('wind_direction_deg',df).lte('wind_direction_deg',dt);else q=q.or(`wind_direction_deg.gte.${df},wind_direction_deg.lte.${dt}`)}else if(df!==null)q=q.gte('wind_direction_deg',df);else if(dt!==null)q=q.lte('wind_direction_deg',dt);const flags=String(url.searchParams.get('flags')||'').toUpperCase().split(',').map(x=>x.trim()).filter(Boolean);for(const flag of [...new Set(flags)]){const col=FLAGS[flag];if(col)q=q.eq(col,true)}const ascending=String(url.searchParams.get('sort')||'desc').toLowerCase()==='asc';q=q.order('archive_time',{ascending,nullsFirst:false}).range(offset,offset+limit-1);const {data,error,count}=await q;if(error)throw error;return json({ok:true,schema:'prognozaepir-message-archive-search-v3',rows:(data||[]).map(projectRow),count:count||0,offset,limit});
    }

    if(op==='stations'){const {data,error}=await db.from('stations').select('icao,wmo,name,active').eq('active',true).order('icao',{ascending:true});if(error)throw error;return json({ok:true,stations:(data||[]).map((r:any)=>({code:String(r.icao||r.wmo||'').toUpperCase(),icao:r.icao||null,wmo:r.wmo||null,name:r.name||''})).filter((r:any)=>r.code)})}
    if(op==='status'){const {count,error}=await db.from('messages').select('*',{count:'exact',head:true});if(error)throw error;const latest:any={};for(const t of ['METAR','SPECI','TAF','SYNOP']){const {data,error:e}=await db.from('messages').select('archive_time,station_code').eq('message_type',t).order('archive_time',{ascending:false,nullsFirst:false}).limit(1);if(e)throw e;latest[t.toLowerCase()]=data?.[0]?.archive_time||null}return json({ok:true,status:{schema:'prognozaepir-supabase-status-v3',count:count||0,latest,checked_at:new Date().toISOString().replace('.000Z','Z')}})}
    return json({ok:false,error:'unsupported op'},400);
  }catch(error){console.error('message-archive error',error);return json({ok:false,error:error instanceof Error?error.message:String(error)},500)}
});