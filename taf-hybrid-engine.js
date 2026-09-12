/* PrognozaEPIR — Hybrid TAF Engine
 * Seven-layer deterministic/adaptive engine:
 * 1) robust multimodel guidance, 2) local MOS, 3) advection,
 * 4) regime detection, 5) persistence-aware segmentation,
 * 6) TAF instruction encoder, 7) verification/learning.
 *
 * The engine does not self-modify code. Learning is bounded, versioned and
 * limited to statistical model bias/reliability, so a single event cannot
 * destabilise operational rules.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PrognozaEPIRTAFHybridEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENGINE_VERSION = '1.0.0';
  const SCHEMA_VERSION = 1;
  const KT_PER_MS = 1.9438444924406;
  const FT_PER_M = 3.2808398950131;
  const HOUR = 3600000;
  const VIS_BANDS = [800, 1500, 3000, 5000];
  const CEIL_BANDS_FT = [200, 300, 500, 1000, 1500];
  const WX = Object.freeze({NONE:'NONE', BR:'BR', FG:'FG', MIFG:'MIFG', RA:'RA', SN:'SN', FZ:'FZ', TS:'TS', OTHER:'OTHER'});
  const REGIME = Object.freeze({CLEAR:'CLEAR', FOG:'FOG', LOW_CEILING:'LOW_CEILING', PRECIP:'PRECIP', CONVECTIVE:'CONVECTIVE', WINDY:'WINDY', TRANSITIONAL:'TRANSITIONAL'});
  const STORAGE_KEY = 'prognozaepir.tafHybrid.learning.v1';

  const DEFAULT_CONFIG = Object.freeze({
    station: 'EPIR',
    msaFt: null,
    nscBaseFt: 5000,
    minHours: 8,
    maxChangeGroups: 5,
    validityHours: 12,
    strictValidity: true,
    applyObservationAnchor: true,
    modelWeightMinFactor: 0.35,
    modelWeightMaxFactor: 2.25,
    learningAlpha: 0.08,
    biasAlpha: 0.06,
    learningWarmup: 18,
    segmentPenalty: 1.35,
    minPersistentHours: 2,
    becmgWindowHours: 2,
    prob30Min: 0.30,
    prob30Max: 0.50,
    deterministicEventProbability: 0.50,
    cavokVisM: 10000,
    dominantVrb02: Object.freeze({enabled:true, minSamples:8, lowKt:2, share:0.75, maxOtherKt:10}),
    advection: Object.freeze({maxBlend:0.35, timeSigmaH:1.75}),
    scales: Object.freeze({windKt:8, windDirDeg:60, visM:3000, ceilingFt:1200, gustKt:10})
  });

  const finite = Number.isFinite;
  const clamp = (x,a,b) => Math.max(a, Math.min(b, x));
  const lerp = (a,b,t) => a + (b-a)*t;
  const rad = d => d*Math.PI/180;
  const deg = r => (r*180/Math.PI+360)%360;
  const circDiff = (a,b) => { let d=Math.abs((a||0)-(b||0))%360; return d>180?360-d:d; };
  const pad = (n,w=2) => String(Math.max(0, Math.round(n))).padStart(w,'0');
  const deepClone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const band = (v, cuts, missingTop=true) => {
    if (!finite(v)) return missingTop ? cuts.length : null;
    for (let i=0;i<cuts.length;i++) if (v<cuts[i]) return i;
    return cuts.length;
  };
  const hourBucket = h => h<=2?'00-02':h<=5?'03-05':h<=8?'06-08':'09-12';
  const evenKt = v => { let n=Math.max(0,Math.round(v||0)); return n%2?n+1:n; };
  const coverFromOkta = o => o<=0?null:o<=2?'FEW':o<=4?'SCT':o<=7?'BKN':'OVC';
  const amountMin = c => c==='FEW'?1:c==='SCT'?3:c==='BKN'?5:c==='OVC'?8:0;

  function mergeConfig(base, extra) {
    const out = {...base, ...(extra||{})};
    out.dominantVrb02 = {...base.dominantVrb02, ...(extra?.dominantVrb02||{})};
    out.advection = {...base.advection, ...(extra?.advection||{})};
    out.scales = {...base.scales, ...(extra?.scales||{})};
    return out;
  }

  function weightedMedian(items) {
    const a = items.filter(x=>finite(x.v)&&finite(x.w)&&x.w>0).sort((x,y)=>x.v-y.v);
    if (!a.length) return null;
    const total = a.reduce((s,x)=>s+x.w,0); let acc=0;
    for (const x of a) { acc += x.w; if (acc >= total/2) return x.v; }
    return a[a.length-1].v;
  }

  function weightedMean(items) {
    let sw=0,s=0;
    for (const x of items) if (finite(x.v)&&finite(x.w)&&x.w>0) { sw+=x.w; s+=x.v*x.w; }
    return sw?s/sw:null;
  }

  function robustWeighted(items) {
    const clean = items.filter(x=>finite(x.v)&&finite(x.w)&&x.w>0);
    if (!clean.length) return {value:null,mad:null,n:0};
    const med = weightedMedian(clean);
    const mad = weightedMedian(clean.map(x=>({v:Math.abs(x.v-med),w:x.w}))) ?? 0;
    const lim = Math.max(mad*3, 1e-9);
    const kept = mad>0 ? clean.filter(x=>Math.abs(x.v-med)<=lim) : clean;
    return {value:weightedMean(kept), mad, n:kept.length};
  }

  function circularMean(items) {
    let u=0,v=0,sw=0;
    for (const x of items) {
      if (!finite(x.v)||!finite(x.w)||x.w<=0) continue;
      const q=rad(x.v); u+=Math.sin(q)*x.w; v+=Math.cos(q)*x.w; sw+=x.w;
    }
    if (!sw || (Math.abs(u)<1e-9&&Math.abs(v)<1e-9)) return {value:null,spread:180,n:0};
    const dir=deg(Math.atan2(u,v)); let spread=0,n=0;
    for (const x of items) if (finite(x.v)&&finite(x.w)&&x.w>0) { spread+=circDiff(x.v,dir)*x.w; n++; }
    return {value:dir, spread:spread/sw, n};
  }

  function safeStorage(custom) {
    if (custom && typeof custom.get==='function' && typeof custom.set==='function') return custom;
    return {
      get(key) { try { return typeof localStorage!=='undefined' ? localStorage.getItem(key) : null; } catch (_) { return null; } },
      set(key,val) { try { if (typeof localStorage!=='undefined') localStorage.setItem(key,val); } catch (_) { } }
    };
  }

  class LearningStore {
    constructor(config, storage) {
      this.config=config;
      this.storage=safeStorage(storage);
      this.state=this._load();
    }
    _empty(){return{schema:SCHEMA_VERSION,engine:ENGINE_VERSION,updatedAt:null,cells:{},pending:[],seen:[]};}
    _load(){
      try {
        const raw=this.storage.get(STORAGE_KEY); if(!raw)return this._empty();
        const x=JSON.parse(raw); if(x?.schema!==SCHEMA_VERSION||typeof x.cells!=='object')return this._empty();
        x.pending=Array.isArray(x.pending)?x.pending:[]; x.seen=Array.isArray(x.seen)?x.seen:[]; return x;
      } catch (_) { return this._empty(); }
    }
    _save(){this.state.updatedAt=new Date().toISOString();this.state.pending=this.state.pending.slice(-60);this.state.seen=this.state.seen.slice(-1200);this.storage.set(STORAGE_KEY,JSON.stringify(this.state));}
    key(model, variable, horizonH){return`${String(model||'unknown')}|${variable}|${hourBucket(Math.max(0,horizonH||0))}`;}
    cell(model, variable, horizonH){
      const k=this.key(model,variable,horizonH);
      return this.state.cells[k] || (this.state.cells[k]={n:0,mae:null,bias:0,brier:null,hits:0,misses:0,falseAlarms:0,correctNegatives:0});
    }
    correction(model, variable, horizonH){const c=this.state.cells[this.key(model,variable,horizonH)];return c&&finite(c.bias)?c.bias:0;}
    factor(model, variable, horizonH, scale){
      const c=this.state.cells[this.key(model,variable,horizonH)];
      if(!c||!c.n)return 1;
      const warm=clamp(c.n/this.config.learningWarmup,0,1);
      let rel=1;
      if(finite(c.mae)) rel=Math.exp(-c.mae/Math.max(1e-6,scale));
      if(finite(c.brier)) rel*=Math.exp(-2*c.brier);
      const target=clamp(0.55+1.45*rel,this.config.modelWeightMinFactor,this.config.modelWeightMaxFactor);
      return lerp(1,target,warm);
    }
    recordContinuous(model, variable, horizonH, forecast, observed, circular=false){
      if(!finite(forecast)||!finite(observed))return;
      const c=this.cell(model,variable,horizonH), a=this.config.learningAlpha, ba=this.config.biasAlpha;
      const err=circular?circDiff(forecast,observed):Math.abs(forecast-observed);
      c.mae=finite(c.mae)?lerp(c.mae,err,a):err;
      if(!circular){const residual=observed-forecast;c.bias=finite(c.bias)?lerp(c.bias,residual,ba):residual;}
      c.n++;
    }
    recordEvent(model, event, horizonH, probability, occurred){
      if(!finite(probability))return;
      const c=this.cell(model,`event:${event}`,horizonH), p=clamp(probability,0,1), o=occurred?1:0, b=(p-o)*(p-o), a=this.config.learningAlpha;
      c.brier=finite(c.brier)?lerp(c.brier,b,a):b; c.n++;
      const predicted=p>=0.5;
      if(predicted&&occurred)c.hits++; else if(predicted&&!occurred)c.falseAlarms++; else if(!predicted&&occurred)c.misses++; else c.correctNegatives++;
    }
    summary(){
      const out={cells:Object.keys(this.state.cells).length,updatedAt:this.state.updatedAt,models:{}};
      for(const [key,c] of Object.entries(this.state.cells)){
        const [model,variable,bucket]=key.split('|'),m=out.models[model]||(out.models[model]={});
        const pod=(c.hits+c.misses)>0?c.hits/(c.hits+c.misses):null,far=(c.hits+c.falseAlarms)>0?c.falseAlarms/(c.hits+c.falseAlarms):null;
        m[`${variable}|${bucket}`]={n:c.n,mae:c.mae,bias:c.bias,brier:c.brier,pod,far};
      }
      return out;
    }
    addPending(record){if(!record?.id)return;this.state.pending=this.state.pending.filter(x=>x.id!==record.id);this.state.pending.push(record);this._save();}
    export(){return deepClone(this.state);}
    import(state){if(state?.schema!==SCHEMA_VERSION||typeof state.cells!=='object')throw Error('Nieprawidłowy stan uczenia');this.state=deepClone(state);this._save();}
    reset(){this.state=this._empty();this._save();}
  }

  function modelId(m,i){return String(m?.id||m?.model||m?.name||`model_${i+1}`);}
  function wmoEvents(code){
    const c=+code;
    return {
      fog: c===45||c===48,
      precip: (c>=51&&c<=67)||(c>=71&&c<=86),
      snow: (c>=71&&c<=77)||(c>=85&&c<=86),
      frozen: c===56||c===57||c===66||c===67,
      ts: c>=95&&c<=99
    };
  }

  function parseObservation(o) {
    if(!o)return null;
    const raw=String(o.raw||o.canonical_raw||'').toUpperCase();
    const wm=raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/), vm=raw.match(/\b(9999|\d{4})\b/);
    const clouds=[...raw.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map(m=>({cover:m[1],ft:+m[2]*100,type:m[3]||''}));
    const ceilingFt=clouds.filter(c=>c.cover==='BKN'||c.cover==='OVC').sort((a,b)=>a.ft-b.ft)[0]?.ft ?? (finite(o.ceiling_m_agl)?o.ceiling_m_agl*FT_PER_M:null);
    const vis=finite(o.visibility_m)?o.visibility_m:(vm?(vm[1]==='9999'?10000:+vm[1]):(/\bCAVOK\b/.test(raw)?10000:null));
    const wx = /\bTS(?:RA|SN|GR|GS)?\b/.test(raw)?WX.TS:/\b(?:FZRA|FZDZ|FZFG)\b/.test(raw)?WX.FZ:/\bMIFG\b/.test(raw)?WX.MIFG:/\bFG\b/.test(raw)?WX.FG:/\bBR\b/.test(raw)?WX.BR:/\b(?:SN|SHSN|RASN|SNRA)\b/.test(raw)?WX.SN:/\b(?:RA|DZ|SHRA)\b/.test(raw)?WX.RA:WX.NONE;
    const t=Date.parse(o.obs_time||o.message_time||o.time||o.timestamp||'');
    return {
      t:finite(t)?t:null,
      windKt:finite(o.wind_speed_ms)?o.wind_speed_ms*KT_PER_MS:(wm?+wm[2]:null),
      windDir:finite(o.wind_direction_deg)?o.wind_direction_deg:(wm&&wm[1]!=='VRB'?+wm[1]:null),
      gustKt:finite(o.wind_gust_ms)?o.wind_gust_ms*KT_PER_MS:(wm&&wm[3]?+wm[3]:null),
      visM:vis, ceilingFt, wx, raw
    };
  }

  function significantCloudThreshold(config){return Math.max(config.nscBaseFt, finite(config.msaFt)?config.msaFt:0);}

  function rowCloudLayers(row) {
    const out=[];
    for(const [ok,h] of [['oktaL','lowH'],['oktaM','midH'],['oktaH','highH']]) {
      const o=+row?.[ok],m=+row?.[h]; if(o>0&&finite(m))out.push({okta:clamp(Math.round(o),1,8),cover:coverFromOkta(o),ft:m*FT_PER_M,type:''});
    }
    if(Array.isArray(row?.clouds)) for(const c of row.clouds){
      const ft=finite(c.ft)?c.ft:finite(c.m)?c.m*FT_PER_M:finite(c.base_ft)?c.base_ft:null;
      const cover=String(c.cover||c.amount||'').toUpperCase();
      if(finite(ft)&&['FEW','SCT','BKN','OVC'].includes(cover))out.push({cover,okta:amountMin(cover),ft,type:String(c.type||'').toUpperCase()});
    }
    return out.sort((a,b)=>a.ft-b.ft);
  }

  function memberForecast(m,i,row,horizonH,learning,config) {
    const id=modelId(m,i), prior=finite(m?.w)&&m.w>0?m.w:1;
    const wsRaw=finite(m?.ws)?m.ws*KT_PER_MS:null, gustRaw=finite(m?.g)?m.g*KT_PER_MS:null, visRaw=finite(m?.vis)?m.vis:null, ceilRaw=finite(m?.ceil)?m.ceil*FT_PER_M:null;
    const corr=(variable,value,scale,bounded) => {
      if(!finite(value))return null;
      const v=value+learning.correction(id,variable,horizonH), f=learning.factor(id,variable,horizonH,scale);
      return {v:bounded?clamp(v,bounded[0],bounded[1]):v,w:prior*f,id,raw:value};
    };
    const ev=wmoEvents(m?.code);
    return {
      id, prior,
      ws:corr('windKt',wsRaw,config.scales.windKt,[0,150]),
      wd:finite(m?.wd)?{v:m.wd,w:prior*learning.factor(id,'windDirDeg',horizonH,config.scales.windDirDeg),id,raw:m.wd}:null,
      gust:corr('gustKt',gustRaw,config.scales.gustKt,[0,180]),
      vis:corr('visM',visRaw,config.scales.visM,[0,50000]),
      ceil:corr('ceilingFt',ceilRaw,config.scales.ceilingFt,[0,60000]),
      events:ev,
      code:m?.code
    };
  }

  function eventProbability(members, event, learning, horizonH, config) {
    let s=0,sw=0;
    for(const m of members){
      if(!m.events)continue;
      const p=m.events[event]?1:0;
      const f=learning.factor(m.id,`event:${event}`,horizonH,0.5), w=m.prior*f;
      s+=p*w;sw+=w;
    }
    return sw?s/sw:0;
  }

  function applyAdvection(hour, row, config) {
    const src=Array.isArray(row?.upstream)?row.upstream:[];
    let best=null;
    for(const q of src) if(q&&finite(q.score)&&q.score>0&&(!best||q.score>best.score))best=q;
    if(!best)return hour;
    const w=clamp(best.score,0,config.advection.maxBlend), s=best.state||best.same?.state||best.same||null;
    if(!s)return hour;
    if(finite(s.vis)) hour.visM=lerp(hour.visM??s.vis,s.vis,w);
    const ceiling=(s.clouds||[]).filter(c=>c.cover==='BKN'||c.cover==='OVC').sort((a,b)=>a.ft-b.ft)[0]?.ft;
    if(finite(ceiling))hour.ceilingFt=lerp(hour.ceilingFt??ceiling,ceiling,w);
    const raw=String(s.wx||'').toUpperCase();
    if(/\b(?:FG|FZFG|MIFG|BR)\b/.test(raw)){hour.prob.fog=clamp(hour.prob.fog+w*(1-hour.prob.fog),0,1);hour.prob.lowVis=clamp(hour.prob.lowVis+w*(1-hour.prob.lowVis),0,1);}
    if(/\bTS/.test(raw))hour.prob.ts=clamp(hour.prob.ts+w*(1-hour.prob.ts),0,1);
    if(/\b(?:RA|DZ|SN|SHRA|SHSN)\b/.test(raw))hour.prob.precip=clamp(hour.prob.precip+w*(1-hour.prob.precip),0,1);
    hour.advection={station:best.id||best.station||null,weight:w,lagH:best.lag??null};
    return hour;
  }

  function buildGuidance(rows, start, learning, config) {
    const out=[];
    for(let i=0;i<rows.length;i++){
      const row=rows[i], t=+row.t, h=Math.max(0,(t-start)/HOUR), rawMembers=Array.isArray(row.mv)?row.mv:[], members=rawMembers.map((m,j)=>memberForecast(m,j,row,h,learning,config));
      const ws=robustWeighted(members.map(m=>m.ws).filter(Boolean)), gust=robustWeighted(members.map(m=>m.gust).filter(Boolean)), vis=robustWeighted(members.map(m=>m.vis).filter(Boolean)), ceil=robustWeighted(members.map(m=>m.ceil).filter(Boolean));
      const dir=circularMean(members.map(m=>m.wd).filter(Boolean).map(x=>({...x,w:x.w*Math.max(1,ws.value||1)})));
      const fallbackWs=finite(row.WS)?row.WS*KT_PER_MS:null, fallbackG=finite(row.G)?row.G*KT_PER_MS:fallbackWs, fallbackVis=finite(row.VIS)?row.VIS:null, fallbackCeil=finite(row.ceiling)?row.ceiling*FT_PER_M:null;
      const blendToAnchored = rawMembers.length>=2 ? 0.82 : 0.45;
      const windKt=finite(ws.value)&&finite(fallbackWs)?lerp(fallbackWs,ws.value,blendToAnchored):(ws.value??fallbackWs);
      const gustKt=finite(gust.value)&&finite(fallbackG)?Math.max(windKt||0,lerp(fallbackG,gust.value,blendToAnchored)):(gust.value??fallbackG);
      const windDir=finite(dir.value)?dir.value:(finite(row.WD)?row.WD:null);
      const visM=finite(vis.value)&&finite(fallbackVis)?lerp(fallbackVis,vis.value,blendToAnchored):(vis.value??fallbackVis);
      const ceilingFt=finite(ceil.value)&&finite(fallbackCeil)?lerp(fallbackCeil,ceil.value,blendToAnchored):(ceil.value??fallbackCeil);
      let fog=eventProbability(members,'fog',learning,h,config), ts=eventProbability(members,'ts',learning,h,config), precip=eventProbability(members,'precip',learning,h,config), snow=eventProbability(members,'snow',learning,h,config), frozen=eventProbability(members,'frozen',learning,h,config);
      if(finite(row.fogRisk))fog=Math.max(fog,clamp(row.fogRisk/100,0,1));
      if(finite(row.mifgRisk))fog=Math.max(fog,clamp(row.mifgRisk/100,0,1)*0.8);
      if(finite(row.storm))ts=Math.max(ts,clamp(row.storm/100,0,1));
      if(finite(row.wet))precip=Math.max(precip,clamp(row.wet/100,0,1)*0.75);
      const lowVisModel=members.reduce((s,m)=>s+(m.vis&&m.vis.v<5000?m.vis.w:0),0), visWeight=members.reduce((s,m)=>s+(m.vis?m.vis.w:0),0);
      const lowCeilModel=members.reduce((s,m)=>s+(m.ceil&&m.ceil.v<1500?m.ceil.w:0),0), ceilWeight=members.reduce((s,m)=>s+(m.ceil?m.ceil.w:0),0);
      const hour={
        t,horizonH:h,windKt,gustKt,windDir,dirSpreadDeg:finite(row.dirSpread)?row.dirSpread:(dir.spread||0),speedMadKt:ws.mad||0,
        visM,ceilingFt,clouds:rowCloudLayers(row),
        T:row.T,Td:row.Td,RH:row.RH,RR:row.RR,
        prob:{fog,ts,precip,snow,frozen,lowVis:visWeight?lowVisModel/visWeight:(visM<5000?1:0),lowCeiling:ceilWeight?lowCeilModel/ceilWeight:(ceilingFt<1500?1:0)},
        members:members.map(m=>({id:m.id,prior:m.prior,wsKt:m.ws?.raw??null,wd:m.wd?.raw??null,gustKt:m.gust?.raw??null,visM:m.vis?.raw??null,ceilingFt:m.ceil?.raw??null,events:m.events})),
        sourceRow:row, modelCount:members.length
      };
      applyAdvection(hour,row,config);
      out.push(hour);
    }
    return out;
  }

  function anchorToObservation(hours, observation, start, config) {
    if(!config.applyObservationAnchor)return hours;
    const o=parseObservation(observation);if(!o||!finite(o.t))return hours;
    const ageAtStart=Math.max(0,(start-o.t)/HOUR);if(ageAtStart>6)return hours;
    const freshness=Math.exp(-ageAtStart/3);
    for(const h of hours){
      const lead=Math.max(0,(h.t-o.t)/HOUR),w=0.78*Math.exp(-lead/4.5)*freshness;
      if(w<0.02)continue;
      if(finite(o.windKt)&&finite(h.windKt)){
        const fr=finite(o.windDir)&&finite(h.windDir);
        if(fr){
          const a=rad(h.windDir),b=rad(o.windDir),hu=-h.windKt*Math.sin(a),hv=-h.windKt*Math.cos(a),ou=-o.windKt*Math.sin(b),ov=-o.windKt*Math.cos(b),u=lerp(hu,ou,w),v=lerp(hv,ov,w);
          h.windKt=Math.hypot(u,v);h.windDir=deg(Math.atan2(-u,-v));
        }else h.windKt=lerp(h.windKt,o.windKt,w);
      }
      if(finite(o.gustKt)&&finite(h.gustKt))h.gustKt=Math.max(h.windKt||0,lerp(h.gustKt,o.gustKt,w));
      if(finite(o.visM)&&finite(h.visM))h.visM=clamp(lerp(h.visM,o.visM,w),0,50000);
      if(finite(o.ceilingFt)&&finite(h.ceilingFt))h.ceilingFt=clamp(lerp(h.ceilingFt,o.ceilingFt,w),0,60000);
      h.observationAnchor=Math.round(w*100);
    }
    return hours;
  }

  function chooseWx(hour, config, probabilistic=false) {
    const p=hour.prob||{}, threshold=probabilistic?config.prob30Min:config.deterministicEventProbability;
    if((p.ts||0)>=threshold)return WX.TS;
    if((p.frozen||0)>=threshold)return WX.FZ;
    if((p.fog||0)>=threshold){if(hour.visM<=1000)return WX.FG;if(finite(hour.sourceRow?.mifgRisk)&&hour.sourceRow.mifgRisk>=70)return WX.MIFG;if(hour.visM<=5000)return WX.BR;}
    if((p.snow||0)>=threshold)return WX.SN;
    if((p.precip||0)>=threshold)return WX.RA;
    if(hour.visM>=1000&&hour.visM<=5000&&finite(hour.RH)&&hour.RH>=88)return WX.BR;
    return WX.NONE;
  }

  function hasConvective(hour, config) {return chooseWx(hour,config)===WX.TS || (hour.prob?.ts||0)>=config.deterministicEventProbability;}
  function significantClouds(hour, config) {
    const threshold=significantCloudThreshold(config);
    return (hour.clouds||[]).filter(c=>c.type==='CB'||c.type==='TCU'||c.ft<threshold);
  }
  function cavokEligible(hour, config) {
    return finite(hour.visM)&&hour.visM>=config.cavokVisM&&chooseWx(hour,config)===WX.NONE&&!hasConvective(hour,config)&&significantClouds(hour,config).length===0;
  }

  function classifyRegime(hour, config) {
    const wx=chooseWx(hour,config), uncertain=Math.max(hour.prob?.fog||0,hour.prob?.ts||0,hour.prob?.precip||0,hour.prob?.lowVis||0,hour.prob?.lowCeiling||0);
    if(wx===WX.TS)return REGIME.CONVECTIVE;
    if((hour.prob?.fog||0)>=0.5&&(hour.visM||10000)<5000)return REGIME.FOG;
    if(finite(hour.ceilingFt)&&hour.ceilingFt<1500&&(hour.prob?.lowCeiling||0)>=0.45)return REGIME.LOW_CEILING;
    if(wx===WX.RA||wx===WX.SN||wx===WX.FZ)return REGIME.PRECIP;
    if((hour.windKt||0)>=15||((hour.gustKt||0)-(hour.windKt||0)>=10))return REGIME.WINDY;
    if(cavokEligible(hour,config))return REGIME.CLEAR;
    if(uncertain>=0.3&&uncertain<0.5)return REGIME.TRANSITIONAL;
    return REGIME.CLEAR;
  }

  function addRegimes(hours, config) {for(const h of hours)h.regime=classifyRegime(h,config);return hours;}

  function wxFamily(w){return w===WX.FG||w===WX.MIFG||w===WX.BR?'VISWX':w===WX.RA||w===WX.SN||w===WX.FZ?'PRECIP':w===WX.TS?'TS':'NONE';}
  function lowBkn(hour){return (hour.clouds||[]).some(c=>(c.cover==='BKN'||c.cover==='OVC')&&c.ft<1500);}
  function gustSignificant(hour){return finite(hour.gustKt)&&finite(hour.windKt)&&hour.gustKt-hour.windKt>=10;}

  function significantDiff(a,b,config){
    const f=[];
    const as=a.windKt||0, bs=b.windKt||0;
    if((finite(a.windDir)&&finite(b.windDir)&&circDiff(a.windDir,b.windDir)>=60&&(as>=10||bs>=10))||Math.abs(bs-as)>=10||(gustSignificant(a)!==gustSignificant(b)&&(as>=15||bs>=15)))f.push('wind');
    if(band(a.visM,VIS_BANDS)!==band(b.visM,VIS_BANDS))f.push('visibility');
    if(band(a.ceilingFt,CEIL_BANDS_FT)!==band(b.ceilingFt,CEIL_BANDS_FT)||lowBkn(a)!==lowBkn(b))f.push('ceiling');
    const aw=chooseWx(a,config),bw=chooseWx(b,config); if(wxFamily(aw)!==wxFamily(bw)||(aw!==bw&&(aw!==WX.NONE||bw!==WX.NONE)))f.push('weather');
    if(hasConvective(a,config)!==hasConvective(b,config))f.push('convective');
    return [...new Set(f)];
  }

  function stateDistance(a,b,config){
    let c=0;
    c+=Math.min(2,Math.abs((a.windKt||0)-(b.windKt||0))/8);
    if(finite(a.windDir)&&finite(b.windDir)&&Math.max(a.windKt||0,b.windKt||0)>=10)c+=Math.min(1.5,circDiff(a.windDir,b.windDir)/60);
    c+=Math.min(2,Math.abs(band(a.visM,VIS_BANDS)-band(b.visM,VIS_BANDS))*1.2);
    c+=Math.min(2,Math.abs(band(a.ceilingFt,CEIL_BANDS_FT)-band(b.ceilingFt,CEIL_BANDS_FT))*1.1);
    if(wxFamily(chooseWx(a,config))!==wxFamily(chooseWx(b,config)))c+=1.5;
    if(a.regime!==b.regime)c+=0.5;
    return c;
  }

  function medoid(hours, i, j, config){
    let best=i,bc=Infinity;
    for(let k=i;k<j;k++){
      let c=0;
      for(let n=i;n<j;n++)c+=stateDistance(hours[k],hours[n],config)*(n===i?1.15:1);
      if(c<bc){bc=c;best=k;}
    }
    return{index:best,cost:bc/(j-i)};
  }

  function dynamicSegments(hours, config){
    const n=hours.length, penalty=config.segmentPenalty, dp=Array(n+1).fill(Infinity), prev=Array(n+1).fill(-1), reps=Array(n+1).fill(null);dp[0]=-penalty;
    for(let j=1;j<=n;j++){
      for(let i=0;i<j;i++){
        const len=j-i; if(i>0&&len<config.minPersistentHours&&j<n)continue;
        const m=medoid(hours,i,j,config), cost=dp[i]+m.cost+penalty;
        if(cost<dp[j]){dp[j]=cost;prev[j]=i;reps[j]=m.index;}
      }
    }
    const out=[];let j=n;
    while(j>0&&prev[j]>=0){const i=prev[j];out.push({i,j,rep:reps[j],state:hours[reps[j]]});j=i;}
    out.reverse();
    const merged=[];
    for(const s of out){
      const last=merged[merged.length-1];
      if(last&&!significantDiff(last.state,s.state,config).length){last.j=s.j;last.rep=medoid(hours,last.i,last.j,config).index;last.state=hours[last.rep];}
      else merged.push({...s});
    }
    return merged;
  }

  function dominantVrbPlan(hours, config){
    const c=config.dominantVrb02;if(!c?.enabled)return null;
    const a=hours.map(h=>evenKt(h.windKt)).filter(finite);if(a.length<c.minSamples)return null;
    const low=a.filter(v=>v<=c.lowKt).length,share=low/a.length,max=Math.max(...a);
    // Literal calm has priority over the project VRB02 heuristic.
    if(max===0)return null;
    return share>=c.share&&max<=c.maxOtherKt?{count:low,total:a.length,share,max}:null;
  }

  function encodeWind(hour, config, forceVrb02=false){
    if(forceVrb02)return'VRB02KT';
    const raw=finite(hour.windKt)?hour.windKt:0, speed=evenKt(raw); if(raw<1)return'00000KT';
    const variable=speed<3&&(hour.dirSpreadDeg>=60||!finite(hour.windDir));
    const d=variable?'VRB':pad(((Math.round((hour.windDir||0)/10)*10)%360)||360,3);
    let s=d+pad(Math.min(98,speed),2);
    const g=evenKt(hour.gustKt); if(finite(hour.gustKt)&&g-speed>=10)s+='G'+(g>99?'P99':pad(g,2));
    return s+'KT';
  }

  function encodeVisibility(v){
    if(!finite(v)||v>=10000)return'9999';
    if(v<800)return pad(clamp(Math.round(v/50)*50,0,750),4);
    if(v<5000)return pad(clamp(Math.round(v/100)*100,800,4900),4);
    return pad(clamp(Math.round(v/1000)*1000,5000,9000),4);
  }

  function convectiveLayer(hour, config){
    if(!hasConvective(hour,config)&&!((hour.prob?.ts||0)>=config.deterministicEventProbability))return null;
    const ft=finite(hour.ceilingFt)&&hour.ceilingFt>300?hour.ceilingFt:(hour.clouds?.find(c=>c.ft>=1000&&c.ft<=10000)?.ft||1500);
    return{cover:'FEW',okta:2,ft,type:'CB',inferred:true};
  }

  function selectCloudLayers(hour, config){
    const threshold=significantCloudThreshold(config), ordinary=(hour.clouds||[]).filter(c=>!c.type&&c.ft<threshold).sort((a,b)=>a.ft-b.ft), conv=(hour.clouds||[]).filter(c=>(c.type==='CB'||c.type==='TCU')).sort((a,b)=>a.ft-b.ft), out=[];
    if(ordinary[0])out.push(ordinary[0]);
    if(ordinary.length>1){const x=ordinary.slice(1).find(c=>amountMin(c.cover)>2);if(x)out.push(x);}
    if(ordinary.length>1){const used=new Set(out),x=ordinary.find(c=>!used.has(c)&&amountMin(c.cover)>4);if(x)out.push(x);}
    let inferred=null;if(hasConvective(hour,config)&&!conv.length)inferred=convectiveLayer(hour,config);
    for(const c of conv)if(!out.includes(c))out.push(c);if(inferred)out.push(inferred);
    out.sort((a,b)=>a.ft-b.ft);
    return out;
  }

  function encodeClouds(hour, config){
    const selected=selectCloudLayers(hour,config);if(!selected.length)return'NSC';
    return selected.map(c=>`${c.cover}${pad(Math.min(999,Math.round(c.ft/100)),3)}${c.type||''}`).join(' ');
  }

  function encodeWx(hour, config){
    const w=chooseWx(hour,config);
    if(w===WX.NONE)return'';
    if(w===WX.TS)return (hour.RR||0)>=0.1?'TSRA':'TS';
    if(w===WX.FZ)return hour.visM<=1000?'FZFG':'FZRA';
    if(w===WX.FG)return'FG';
    if(w===WX.MIFG)return'MIFG';
    if(w===WX.BR)return'BR';
    if(w===WX.SN)return (hour.RR||0)>=0.3?'SN':'-SN';
    if(w===WX.RA)return (hour.RR||0)>=0.3?'RA':'-RA';
    return'';
  }

  function encodeState(hour, config, opts={}){
    const wind=encodeWind(hour,config,!!opts.forceVrb02), wx=encodeWx(hour,config);
    if(cavokEligible(hour,config))return`${wind} CAVOK`;
    const vis=encodeVisibility(hour.visM),cloud=encodeClouds(hour,config),parts=[wind,vis];
    if(wx)parts.push(wx);else if(opts.previous&&encodeWx(opts.previous,config)&&opts.changeGroup)parts.push('NSW');
    parts.push(cloud);return parts.filter(Boolean).join(' ');
  }

  function ddhh(t){const d=new Date(t);return pad(d.getUTCDate())+pad(d.getUTCHours());}
  function ddhhmm(t){const d=new Date(t);return ddhh(t)+pad(d.getUTCMinutes());}
  function ddhhEnd(t){const d=new Date(t);if(d.getUTCHours()===0&&d.getUTCMinutes()===0){const q=new Date(t-1);return pad(q.getUTCDate())+'24';}return ddhh(t);}

  function changeGroups(hours, segments, config, vrbPlan){
    const groups=[], reasons=[];let prev=segments[0]?.state||hours[0];
    for(let si=1;si<segments.length&&groups.length<config.maxChangeGroups;si++){
      const s=segments[si], cur=s.state, fields=significantDiff(prev,cur,config);if(!fields.length){prev=cur;continue;}
      const onset=hours[s.i].t, half=config.becmgWindowHours*HOUR/2, start=Math.max(hours[0].t,onset-half), end=Math.min(hours[hours.length-1].t+HOUR,onset+half);
      const p=encodeState(cur,config,{previous:prev,changeGroup:true});
      groups.push({kind:'BECMG',start,end,payload:p,fields,confidence:segmentConfidence(hours,s)});
      reasons.push(`BECMG ${ddhh(start)}/${ddhhEnd(end)}: trwała zmiana ${fields.join(', ')} utrzymuje się w segmencie ${s.j-s.i} h.`);
      prev=cur;
    }
    if(groups.length<config.maxChangeGroups){
      const candidates=[];
      for(let i=0;i<hours.length;i++){
        const h=hours[i], evs=[['ts',h.prob.ts],['fog',h.prob.fog],['precip',h.prob.precip],['lowCeiling',h.prob.lowCeiling]];
        const best=evs.filter(x=>finite(x[1])&&x[1]>=config.prob30Min&&x[1]<config.prob30Max).sort((a,b)=>b[1]-a[1])[0];
        if(!best)continue;
        let payload='';
        if(best[0]==='ts')payload=`4000 TSRA FEW${pad(Math.min(999,Math.round((h.ceilingFt||1500)/100)),3)}CB`;
        else if(best[0]==='fog')payload=`${encodeVisibility(Math.min(h.visM||5000,3000))} ${h.visM<=1000?'FG':'BR'}`;
        else if(best[0]==='precip')payload=`${encodeVisibility(h.visM)} -RA`;
        else if(best[0]==='lowCeiling')payload=`BKN${pad(Math.min(999,Math.round((h.ceilingFt||1200)/100)),3)}`;
        candidates.push({i,event:best[0],p:best[1],payload});
      }
      const used=new Set();
      for(let ci=0;ci<candidates.length&&groups.length<config.maxChangeGroups;ci++){
        if(used.has(ci))continue;const c=candidates[ci];let j=ci, endI=c.i;
        while(j+1<candidates.length&&candidates[j+1].event===c.event&&candidates[j+1].i===endI+1){j++;endI=candidates[j].i;used.add(j);}
        const start=hours[c.i].t,end=Math.min(hours[hours.length-1].t+HOUR,hours[endI].t+HOUR),peak=Math.max(...candidates.slice(ci,j+1).map(x=>x.p));
        groups.push({kind:'PROB30',start,end,payload:c.payload,event:c.event,probability:peak});
        reasons.push(`PROB30 ${ddhh(start)}/${ddhhEnd(end)}: ${c.event} ma skalibrowane prawdopodobieństwo ${Math.round(peak*100)}%.`);
      }
    }
    groups.sort((a,b)=>a.start-b.start||((a.kind==='BECMG')?-1:1));
    return{groups:groups.slice(0,config.maxChangeGroups),reasons};
  }

  function segmentConfidence(hours,s){
    const a=hours.slice(s.i,s.j);if(!a.length)return 0;
    const models=a.reduce((x,h)=>x+Math.min(1,h.modelCount/4),0)/a.length, spread=a.reduce((x,h)=>x+clamp(1-(h.speedMadKt||0)/8,0,1),0)/a.length;
    return Math.round(100*(0.55*models+0.45*spread));
  }

  function overallConfidence(hours,segments){
    if(!hours.length)return 0;
    const model=hours.reduce((s,h)=>s+Math.min(1,h.modelCount/4),0)/hours.length, wind=hours.reduce((s,h)=>s+clamp(1-(h.speedMadKt||0)/8,0,1),0)/hours.length;
    const stability=clamp(1-(segments.length-1)/5,0.35,1);
    return Math.round(100*(0.45*model+0.35*wind+0.20*stability));
  }

  function forecastId(station,issue,start){return`${station}:${issue}:${start}:${ENGINE_VERSION}`;}

  function makePending(station,issue,start,end,hours){
    return{id:forecastId(station,issue,start),station,issue,start,end,createdAt:Date.now(),hours:hours.map(h=>({t:h.t,horizonH:h.horizonH,members:h.members}))};
  }

  function observationKey(o){return`${o.t}|${o.raw||''}`.slice(0,400);}

  function learnPending(learning, observations){
    const parsed=(observations||[]).map(parseObservation).filter(o=>o&&finite(o.t)),seen=new Set(learning.state.seen),remaining=[];let updates=0;
    for(const f of learning.state.pending){
      for(const oh of f.hours||[]){
        const obs=parsed.reduce((best,o)=>Math.abs(o.t-oh.t)<=45*60000&&(!best||Math.abs(o.t-oh.t)<Math.abs(best.t-oh.t))?o:best,null);if(!obs)continue;
        const ok=`${f.id}|${oh.t}|${observationKey(obs)}`;if(seen.has(ok))continue;
        for(const m of oh.members||[]){
          if(finite(m.wsKt)&&finite(obs.windKt))learning.recordContinuous(m.id,'windKt',oh.horizonH,m.wsKt,obs.windKt,false);
          if(finite(m.wd)&&finite(obs.windDir)&&Math.max(m.wsKt||0,obs.windKt||0)>=5)learning.recordContinuous(m.id,'windDirDeg',oh.horizonH,m.wd,obs.windDir,true);
          if(finite(m.gustKt)&&finite(obs.gustKt))learning.recordContinuous(m.id,'gustKt',oh.horizonH,m.gustKt,obs.gustKt,false);
          if(finite(m.visM)&&finite(obs.visM))learning.recordContinuous(m.id,'visM',oh.horizonH,m.visM,obs.visM,false);
          if(finite(m.ceilingFt)&&finite(obs.ceilingFt))learning.recordContinuous(m.id,'ceilingFt',oh.horizonH,m.ceilingFt,obs.ceilingFt,false);
          const ev=m.events||{};
          learning.recordEvent(m.id,'fog',oh.horizonH,ev.fog?1:0,[WX.FG,WX.MIFG,WX.BR,WX.FZ].includes(obs.wx));
          learning.recordEvent(m.id,'ts',oh.horizonH,ev.ts?1:0,obs.wx===WX.TS);
          learning.recordEvent(m.id,'precip',oh.horizonH,ev.precip?1:0,[WX.RA,WX.SN,WX.FZ,WX.TS].includes(obs.wx));
          learning.recordEvent(m.id,'lowVis',oh.horizonH,finite(m.visM)&&m.visM<5000?1:0,finite(obs.visM)&&obs.visM<5000);
          learning.recordEvent(m.id,'lowCeiling',oh.horizonH,finite(m.ceilingFt)&&m.ceilingFt<1500?1:0,finite(obs.ceilingFt)?obs.ceilingFt<1500:false);
        }
        seen.add(ok);updates++;
      }
      if(Date.now()<f.end+6*HOUR)remaining.push(f);
    }
    learning.state.pending=remaining;learning.state.seen=[...seen].slice(-1200);if(updates)learning._save();
    return updates;
  }

  function validateInput(input,config){
    if(!input||!Array.isArray(input.rows))throw Error('Brak godzinowych danych wejściowych');
    const start=+input.start,end=+input.end,issue=+input.issue;
    if(!finite(start)||!finite(end)||end<=start)throw Error('Nieprawidłowy okres ważności TAF');
    if(config.strictValidity&&Math.abs((end-start)/HOUR-config.validityHours)>0.01)throw Error(`Okres ważności musi mieć ${config.validityHours} h`);
    const rows=input.rows.filter(r=>finite(+r.t)&&+r.t>=start&&+r.t<end).sort((a,b)=>a.t-b.t);
    if(rows.length<config.minHours)throw Error(`Niepełny okres: ${rows.length} h, wymagane minimum ${config.minHours}`);
    return{rows,start,end,issue:finite(issue)?issue:start-HOUR};
  }

  class HybridTAFEngine {
    constructor(options={}){
      this.config=mergeConfig(DEFAULT_CONFIG,options.config||options);
      this.learning=new LearningStore(this.config,options.storage);
    }
    generate(input){
      const cfg=mergeConfig(this.config,{msaFt:finite(input?.msaFt)?input.msaFt:this.config.msaFt}), v=validateInput(input,cfg), station=String(input.station||cfg.station||'EPIR').toUpperCase();
      if(Array.isArray(input.observations)&&input.observations.length)learnPending(this.learning,input.observations);
      const rawHours=buildGuidance(v.rows,v.start,this.learning,cfg);
      if(!input.rowsAlreadyAnchored)anchorToObservation(rawHours,input.observation,v.start,cfg);
      const hours=addRegimes(rawHours,cfg),segments=dynamicSegments(hours,cfg),vrb=dominantVrbPlan(hours,cfg);
      const base=segments[0]?.state||hours[0],baseText=encodeState(base,cfg,{forceVrb02:!!vrb}),cg=changeGroups(hours,segments,cfg,vrb);
      let taf=`TAF ${station} ${ddhhmm(v.issue)}Z ${ddhh(v.start)}/${ddhhEnd(v.end)} ${baseText}`;
      for(const g of cg.groups)taf+=`\n${g.kind} ${ddhh(g.start)}/${ddhhEnd(g.end)} ${g.payload}`;
      taf+='=';
      const checks={noProb40:!taf.includes('PROB40'),noVV:!/(^|\s)VV\d{3}\b/.test(taf),max5:cg.groups.length<=cfg.maxChangeGroups,periodHours:Math.round((v.end-v.start)/HOUR)};
      const diagnostics={
        version:ENGINE_VERSION,schema:SCHEMA_VERSION,
        layers:[
          {id:1,name:'robust-multimodel',status:'ok',samples:hours.length,models:Math.max(...hours.map(h=>h.modelCount),0)},
          {id:2,name:'local-mos-observation-anchor',status:'ok',learningCells:Object.keys(this.learning.state.cells).length,anchoredHours:hours.filter(h=>h.observationAnchor).length},
          {id:3,name:'advection',status:hours.some(h=>h.advection)?'active':'no-signal',hours:hours.filter(h=>h.advection).length},
          {id:4,name:'regime-detection',status:'ok',regimes:[...new Set(hours.map(h=>h.regime))]},
          {id:5,name:'dynamic-segmentation',status:'ok',segments:segments.length},
          {id:6,name:'taf-encoder',status:Object.values(checks).every(x=>x===true||typeof x==='number')?'ok':'warning',checks},
          {id:7,name:'verification-learning',status:'ready',pending:this.learning.state.pending.length}
        ],
        vrb02:vrb,
        cloudThresholdFt:significantCloudThreshold(cfg),
        msaFt:finite(cfg.msaFt)?cfg.msaFt:null,
        msaMode:finite(cfg.msaFt)?'explicit':'5000ft-fallback',
        reasons:cg.reasons
      };
      const result={ok:true,version:ENGINE_VERSION,station,issue:v.issue,start:v.start,end:v.end,taf,base:{state:base,text:baseText},groups:cg.groups,hourly:hours,segments,confidence:overallConfidence(hours,segments),checks,diagnostics,learning:this.learning.summary()};
      if(input.record!==false)this.learning.addPending(makePending(station,v.issue,v.start,v.end,hours));
      return result;
    }
    learn(observations){return learnPending(this.learning,observations);}
    getLearningState(){return this.learning.export();}
    getLearningSummary(){return this.learning.summary();}
    importLearningState(state){this.learning.import(state);return this.getLearningState();}
    resetLearning(){this.learning.reset();return this.getLearningState();}
  }

  function createEngine(options){return new HybridTAFEngine(options||{});}

  return Object.freeze({
    ENGINE_VERSION,SCHEMA_VERSION,DEFAULT_CONFIG,HybridTAFEngine,createEngine,
    utilities:Object.freeze({weightedMedian,robustWeighted,circularMean,parseObservation,significantDiff,encodeVisibility,coverFromOkta,band})
  });
});
