'use strict';

(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFHybridTuning=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VERSION='3.0.0';
  const KT=1.9438444924406,FT=3.2808398950131,HOUR=3600000;
  const CAVOK_BASE_FT=1500*FT,NSC_BASE_FT=5000;
  const VIS_THRESHOLDS=[800,1500,3000,5000],CEIL_THRESHOLDS=[200,300,500,1000,1500];
  const finite=Number.isFinite,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const DEFAULTS=Object.freeze({
    consensusPrimary:true,
    weakRrMmH:.30,
    weakSignalRrMmH:.05,
    temporalProbability:.30,
    strongModelShare:.75,
    minModelsForSpike:4,
    advectionConfirmWeight:.15,
    wetSignalPct:40,
    visibilityThresholds:VIS_THRESHOLDS,
    strictInstruction:true,
    dominantClear:Object.freeze({enabled:true,startHourFrom:18,startHourTo:5,minShare:.75,fewSctMinFt:4000,ordinaryCloudLimitFt:5000,advisoryOnly:true})
  });
  const cfgOf=x=>({...DEFAULTS,...(x||{}),dominantClear:{...DEFAULTS.dominantClear,...(x?.dominantClear||{})}});
  const p2=n=>String(Math.max(0,Math.round(n))).padStart(2,'0');
  const p3=n=>String(Math.max(0,Math.round(n))).padStart(3,'0');
  const p4=n=>String(Math.max(0,Math.round(n))).padStart(4,'0');
  const circ=(a,b)=>{let d=Math.abs((a||0)-(b||0))%360;return d>180?360-d:d;};
  const band=(v,cuts)=>{if(!finite(v))return cuts.length;for(let i=0;i<cuts.length;i++)if(v<cuts[i])return i;return cuts.length;};
  const visBand=(v,cuts=VIS_THRESHOLDS)=>band(v,cuts);
  const ceilBand=v=>band(v,CEIL_THRESHOLDS);
  const amountMin=c=>c==='FEW'?1:c==='SCT'?3:c==='BKN'?5:c==='OVC'?8:0;
  const cover=o=>o<=0?null:o<=2?'FEW':o<=4?'SCT':o<=7?'BKN':'OVC';
  const modelId=(m,i)=>String(m?.sourceModelId||m?.id||m?.model||m?.name||`model_${i+1}`);

  function wmoPrecipInfo(code){
    const c=+code,ts=[95,96,99].includes(c),frozen=[56,57,66,67].includes(c),snow=[71,73,75,77,85,86].includes(c),shower=[80,81,82,85,86].includes(c);
    const precip=[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(c);
    let intensity='none';
    if([51,56,61,66,71,80,85].includes(c))intensity='weak';
    else if([53,57,63,73,81].includes(c))intensity='moderate';
    else if([55,65,67,75,82,86].includes(c))intensity='heavy';
    else if(precip)intensity='moderate';
    return{precip,ts,frozen,snow,shower,intensity,ordinary:precip&&!ts&&!frozen};
  }
  function share(members,pred){
    let yes=0,all=0,count=0;
    for(const m of members||[]){const w=finite(+m?.w)&&+m.w>0?+m.w:1;all+=w;if(pred(m)){yes+=w;count++;}}
    return{share:all?yes/all:0,count,total:(members||[]).length};
  }
  function rowEvidence(row,cfg=DEFAULTS){
    const mv=Array.isArray(row?.mv)?row.mv:[];
    const ordinary=share(mv,m=>wmoPrecipInfo(m?.code).ordinary);
    const moderate=share(mv,m=>{const q=wmoPrecipInfo(m?.code);return q.ordinary&&(q.intensity==='moderate'||q.intensity==='heavy');});
    const frozen=share(mv,m=>wmoPrecipInfo(m?.code).frozen),ts=share(mv,m=>wmoPrecipInfo(m?.code).ts),shower=share(mv,m=>wmoPrecipInfo(m?.code).shower);
    const rr=finite(+row?.RR)?Math.max(0,+row.RR):0,wet=finite(+row?.wet)?clamp(+row.wet,0,100):0;
    const advection=(row?.upstream||[]).some(q=>{
      const w=finite(+q?.score)?+q.score:0,wx=String(q?.state?.wx||q?.same?.state?.wx||q?.same?.wx||'').toUpperCase();
      return w>=cfg.advectionConfirmWeight&&/\b(?:RA|DZ|SN|SHRA|SHSN|RASN|SNRA|FZRA|FZDZ|TSRA|TS)\b/.test(wx);
    });
    return{ordinaryShare:ordinary.share,ordinaryCount:ordinary.count,modelCount:ordinary.total,moderateShare:moderate.share,frozenShare:frozen.share,tsShare:ts.share,showerShare:shower.share,rr,wet,advection};
  }

  function cloudLayersFromRow(row){
    const out=[];
    for(const [ok,h] of [['oktaL','lowH'],['oktaM','midH'],['oktaH','highH']]){
      const o=+row?.[ok],m=+row?.[h];if(o>0&&finite(m))out.push({okta:clamp(Math.round(o),1,8),ft:m*FT,type:''});
    }
    if(Array.isArray(row?.clouds))for(const c of row.clouds){
      const ft=finite(+c?.ft)?+c.ft:finite(+c?.m)?+c.m*FT:null,cv=String(c?.cover||c?.amount||'').toUpperCase();
      const ok=amountMin(cv)||clamp(Math.round(+c?.okta||0),0,8);
      if(finite(ft)&&ok>0)out.push({okta:ok,ft,type:/^(CB|TCU)$/.test(String(c?.type||'').toUpperCase())?String(c.type).toUpperCase():''});
    }
    return out.sort((a,b)=>a.ft-b.ft);
  }
  function clearCloudCandidate(row,cfg=DEFAULTS){
    const dc=cfg.dominantClear||DEFAULTS.dominantClear,layers=cloudLayersFromRow(row);
    for(const c of layers){
      if(c.type)return false;
      if(c.okta<=4){if(c.ft<dc.fewSctMinFt)return false;}
      else if(c.ft<dc.ordinaryCloudLimitFt)return false;
    }
    const tsShare=share(row?.mv||[],m=>wmoPrecipInfo(m?.code).ts).share;
    if((finite(+row?.storm)&&+row.storm>=30)||tsShare>=.30)return false;
    return true;
  }
  function dominantClearPlan(rows,start,cfg=DEFAULTS){
    const dc=cfg.dominantClear||DEFAULTS.dominantClear;if(!dc.enabled||!finite(+start))return null;
    const hour=new Date(+start).getUTCHours(),windowOk=hour>=dc.startHourFrom||hour<=dc.startHourTo;if(!windowOk)return null;
    const a=(rows||[]).filter(r=>finite(+r?.t));if(a.length<8)return null;
    const count=a.filter(r=>clearCloudCandidate(r,cfg)).length,ratio=count/a.length;
    return ratio>dc.minShare?{count,total:a.length,share:ratio,startHour:hour,advisoryOnly:true}:null;
  }

  function significantConsensusChange(a,b){
    if(!a||!b)return false;
    if(visBand(+a.VIS)!==visBand(+b.VIS))return true;
    const ac=finite(+a.ceiling)?+a.ceiling*FT:null,bc=finite(+b.ceiling)?+b.ceiling*FT:null;
    if(ceilBand(ac)!==ceilBand(bc))return true;
    const aws=finite(+a.WS)?+a.WS*KT:0,bws=finite(+b.WS)?+b.WS*KT:0;
    if(Math.abs(aws-bws)>=10)return true;
    if(finite(+a.WD)&&finite(+b.WD)&&circ(+a.WD,+b.WD)>=60&&(aws>=10||bws>=10))return true;
    const al=finite(+a.lowH)&&+a.lowH*FT<1500&&+a.oktaL>=5,bl=finite(+b.lowH)&&+b.lowH*FT<1500&&+b.oktaL>=5;
    return al!==bl;
  }
  function tuneRows(rows,extra){
    const cfg=cfgOf(extra),out=(rows||[]).map(r=>({...r,mv:Array.isArray(r?.mv)?r.mv.map(m=>({...m})):[]})),ev=out.map(r=>rowEvidence(r,cfg));
    for(let i=0;i<out.length;i++){
      const row=out[i],e=ev[i],p=ev[i-1],n=ev[i+1];
      const temporal=!!((p&&(p.ordinaryShare>=cfg.temporalProbability||p.rr>=cfg.weakSignalRrMmH||p.wet>=cfg.wetSignalPct))||(n&&(n.ordinaryShare>=cfg.temporalProbability||n.rr>=cfg.weakSignalRrMmH||n.wet>=cfg.wetSignalPct)));
      const strongModels=e.ordinaryShare>=cfg.strongModelShare&&e.ordinaryCount>=cfg.minModelsForSpike;
      const otherChange=significantConsensusChange(row,out[i-1])||significantConsensusChange(row,out[i+1]);
      const lowVis=finite(+row.VIS)&&+row.VIS<5000,protectedEvent=e.frozenShare>=cfg.temporalProbability||e.tsShare>=cfg.temporalProbability;
      const moderateOrHeavy=e.rr>=cfg.weakRrMmH||e.moderateShare>=cfg.temporalProbability;
      const weakSignal=e.ordinaryShare>=cfg.temporalProbability||e.rr>=cfg.weakSignalRrMmH||e.wet>=cfg.wetSignalPct;
      const allowWeakInChange=protectedEvent||moderateOrHeavy||lowVis||otherChange;
      row.__hybridTuning={...e,temporal,strongModels,otherChange,lowVis,protectedEvent,moderateOrHeavy,weakSignal,allowWeakInChange,suppressWeak:weakSignal&&!allowWeakInChange};
      row.mv=row.mv.map((m,j)=>{
        const x={...m},src=modelId(m,j);x.sourceModelId=src;x.id=`CONSENSUS::${src}`;x.model=x.id;
        if(cfg.consensusPrimary){
          if(finite(+row.WS))x.ws=+row.WS;if(finite(+row.WD))x.wd=+row.WD;
          if(finite(+row.G))x.g=+row.G;else if(finite(+row.WS))x.g=+row.WS;
          if(finite(+row.VIS))x.vis=+row.VIS;if(finite(+row.ceiling))x.ceil=+row.ceiling;
        }
        return x;
      });
    }
    return out;
  }

  function cloudThresholds(msaFt){return{cavok:Math.max(CAVOK_BASE_FT,finite(+msaFt)?+msaFt:0),nsc:Math.max(NSC_BASE_FT,finite(+msaFt)?+msaFt:0)};}
  function hourClouds(h){
    if(Array.isArray(h?.clouds)&&h.clouds.length)return h.clouds.map(c=>({cover:String(c.cover||cover(c.okta)||'').toUpperCase(),okta:amountMin(String(c.cover||'').toUpperCase())||+c.okta||0,ft:+c.ft,type:String(c.type||'').toUpperCase()})).filter(c=>finite(c.ft)&&c.okta>0);
    return cloudLayersFromRow(h?.sourceRow||{});
  }
  function hasConvectiveCloud(h){return hourClouds(h).some(c=>c.type==='CB'||c.type==='TCU');}
  function encodedWxForHour(h){
    const p=h?.prob||{},e=h?.sourceRow?.__hybridTuning||rowEvidence(h?.sourceRow||{});
    if((p.ts||0)>=.5)return (h?.RR||0)>=.1?'TSRA':'TS';
    if((p.frozen||0)>=.5)return'FZRA';
    if((p.fog||0)>=.5&&+h.visM<=900)return'FG';
    if((p.fog||0)>=.3&&+h.visM<=5000)return'BR';
    if((p.snow||0)>=.5)return (h?.RR||0)>=.3?'SN':'-SN';
    if((p.precip||0)>=.5){const sh=(e?.showerShare||0)>=.5,code=sh?'SHRA':'RA';return (h?.RR||0)>=.3?code:'-'+code;}
    if(finite(+h?.visM)&&+h.visM>=1000&&+h.visM<=5000&&finite(+h?.RH)&&+h.RH>=88)return'BR';
    return'';
  }
  function strictCavokEligible(h,msaFt){
    if(!h||!finite(+h.visM)||+h.visM<10000||encodedWxForHour(h)||hasConvectiveCloud(h))return false;
    const lim=cloudThresholds(msaFt).cavok;return !hourClouds(h).some(c=>!c.type&&c.ft<lim);
  }
  function strictNscEligible(h,msaFt){
    if(!h||hasConvectiveCloud(h))return false;const lim=cloudThresholds(msaFt).nsc;return !hourClouds(h).some(c=>!c.type&&c.ft<lim);
  }
  function selectedClouds(h,msaFt){
    const lim=cloudThresholds(msaFt).nsc,src=hourClouds(h).filter(c=>c.type||c.ft<lim).sort((a,b)=>a.ft-b.ft);
    const convRaw=src.filter(c=>c.type),ordinaryRaw=src.filter(c=>!c.type);let cumulative=0;
    const ordinary=ordinaryRaw.map(c=>{cumulative=Math.max(cumulative,clamp(Math.round(c.okta||amountMin(c.cover)),1,8));return{...c,okta:cumulative,cover:cover(cumulative)};});
    const out=[];if(ordinary[0])out.push(ordinary[0]);
    if(ordinary.length>1){const x=ordinary.slice(1).find(c=>c.okta>2);if(x)out.push(x);}
    if(ordinary.length>1){const used=new Set(out),x=ordinary.find(c=>!used.has(c)&&c.okta>4);if(x)out.push(x);}
    const byBase=new Map();for(const c of convRaw){const k=Math.round(c.ft),a=byBase.get(k)||[];a.push(c);byBase.set(k,a);}
    for(const a of byBase.values()){
      const cb=a.find(c=>c.type==='CB'),tcu=a.find(c=>c.type==='TCU');
      if(cb&&tcu){const ok=clamp((cb.okta||amountMin(cb.cover))+(tcu.okta||amountMin(tcu.cover)),1,8);out.push({...cb,okta:ok,cover:cover(ok),type:'CB'});}else for(const c of a)out.push(c);
    }
    return out.sort((a,b)=>a.ft-b.ft);
  }
  function encodeCloudsStrict(h,msaFt){const a=selectedClouds(h,msaFt);if(!a.length)return'NSC';return a.map(c=>`${c.cover||cover(c.okta)}${p3(Math.min(999,Math.round(c.ft/100)))}${c.type||''}`).join(' ');}
  function encodedVis(v){if(!finite(+v)||+v>=10000)return'9999';if(+v<800)return p4(clamp(Math.round(+v/50)*50,0,750));if(+v<5000)return p4(clamp(Math.round(+v/100)*100,800,4900));return p4(clamp(Math.round(+v/1000)*1000,5000,9000));}
  function windFromHour(h){
    const raw=finite(+h?.windKt)?Math.max(0,+h.windKt):0;if(raw<1)return'00000KT';
    const speed=Math.round(raw),variable=speed<3&&(!finite(+h?.windDir)||(+h?.dirSpreadDeg||0)>=60),d=variable?'VRB':p3(((Math.round((+h.windDir||0)/10)*10)%360)||360);
    let s=d+(speed>=100?'P99':p2(speed));const g=finite(+h?.gustKt)?Math.round(+h.gustKt):null;if(finite(g)&&g-speed>=10)s+='G'+(g>=100?'P99':p2(g));return s+'KT';
  }
  function encodeStateStrict(h,msaFt){
    const wind=windFromHour(h),wx=encodedWxForHour(h);if(strictCavokEligible(h,msaFt))return`${wind} CAVOK`;
    const parts=[wind,encodedVis(h?.visM)];if(wx)parts.push(wx);parts.push(strictNscEligible(h,msaFt)?'NSC':encodeCloudsStrict(h,msaFt));return parts.filter(Boolean).join(' ');
  }

  function visibilityNeedsGroup(prev,target,cfg=DEFAULTS){const a=+prev?.visM,b=+target?.visM;if(!finite(a)||!finite(b))return false;return visBand(a,cfg.visibilityThresholds)!==visBand(b,cfg.visibilityThresholds);}
  function windNeedsGroup(a,b){
    const as=+a?.windKt||0,bs=+b?.windKt||0;if(finite(+a?.windDir)&&finite(+b?.windDir)&&circ(+a.windDir,+b.windDir)>=60&&(as>=10||bs>=10))return true;if(Math.abs(bs-as)>=10)return true;
    const ag=finite(+a?.gustKt)&&+a.gustKt-as>=10,bg=finite(+b?.gustKt)&&+b.gustKt-bs>=10;return ag!==bg&&(as>=15||bs>=15);
  }
  function lowBkn(h){return hourClouds(h).some(c=>(c.cover==='BKN'||c.cover==='OVC'||c.okta>=5)&&c.ft<1500);}
  function ceilingNeedsGroup(a,b){const ac=finite(+a?.ceilingFt)?+a.ceilingFt:null,bc=finite(+b?.ceilingFt)?+b.ceilingFt:null;if(finite(ac)&&finite(bc)&&ceilBand(ac)!==ceilBand(bc))return true;return lowBkn(a)!==lowBkn(b);}
  function convectiveNeedsGroup(a,b){const ap=(a?.prob?.ts||0)>=.5||hasConvectiveCloud(a),bp=(b?.prob?.ts||0)>=.5||hasConvectiveCloud(b);return ap!==bp;}
  function significantWeatherToken(h){
    const wx=encodedWxForHour(h),e=h?.sourceRow?.__hybridTuning||{};if(/^(?:FZ|TS)/.test(wx))return wx;
    if((e.moderateOrHeavy||(+h?.RR||0)>=.3)&&/^(?:\+|-)?(?:RA|SN|SHRA|SHSN)$/.test(wx))return wx.replace(/^-/,'');return'';
  }
  function weatherNeedsGroup(a,b){const aw=significantWeatherToken(a),bw=significantWeatherToken(b);return aw!==bw&&(!!aw||!!bw);}
  function significantFields(a,b,cfg=DEFAULTS){const f=[];if(windNeedsGroup(a,b))f.push('wind');if(visibilityNeedsGroup(a,b,cfg))f.push('visibility');if(weatherNeedsGroup(a,b))f.push('weather');if(ceilingNeedsGroup(a,b))f.push('ceiling');if(convectiveNeedsGroup(a,b))f.push('convective');return[...new Set(f)];}
  const groupHours=(r,g)=>(r.hourly||[]).filter(h=>h.t>=g.start&&h.t<g.end);
  const previousHour=(r,g)=>{const a=(r.hourly||[]).filter(h=>h.t<g.start);return a[a.length-1]||r.base?.state||r.hourly?.[0]||null;};
  const targetHour=(r,g)=>{const a=groupHours(r,g);return a[a.length-1]||(r.hourly||[]).find(h=>h.t>=g.end)||null;};
  function weakPrecipAllowedInChange(h,fields=[]){const e=h?.sourceRow?.__hybridTuning||{};if(e.protectedEvent||e.moderateOrHeavy)return true;if(finite(+h?.visM)&&+h.visM<5000)return true;return fields.some(x=>!['weather','visibility'].includes(x));}
  function strictPrecipImpact(result,g){const hs=groupHours(result,g);if(!hs.length)return false;const fields=Array.isArray(g.fields)?g.fields:[];return hs.some(h=>weakPrecipAllowedInChange(h,fields));}

  function payloadForChange(prev,target,fields,msaFt,{temporary=false}={}){
    const out=[],set=new Set(fields||[]),wx=encodedWxForHour(target),prevWx=encodedWxForHour(prev);
    if(set.has('wind'))out.push(windFromHour(target));
    const significantMet=set.has('weather')||set.has('ceiling')||set.has('convective'),prevCavok=strictCavokEligible(prev,msaFt),targetCavok=strictCavokEligible(target,msaFt);
    if(targetCavok&&(set.has('visibility')||significantMet)){out.push('CAVOK');return out.join(' ');}
    if(set.has('visibility'))out.push(encodedVis(target?.visM));
    else if(temporary&&significantMet&&prevCavok&&finite(+target?.visM)&&+target.visM<10000)out.push(encodedVis(target.visM));
    if(set.has('weather')||set.has('convective')){
      if(wx){const weak=/^-(?:RA|SN|SHRA|SHSN|DZ)$/.test(wx);if(!weak||weakPrecipAllowedInChange(target,fields))out.push(wx);}
      else if(prevWx&&!/^-(?:RA|SN|SHRA|SHSN|DZ)$/.test(prevWx))out.push('NSW');
    }
    if(set.has('ceiling')||set.has('convective'))out.push(encodeCloudsStrict(target,msaFt));
    return[...new Set(out)].join(' ');
  }
  function selectiveBecmgPayload(result,g,planOrCfg,cfgMaybe){const cfg=cfgMaybe||planOrCfg||DEFAULTS,prev=previousHour(result,g),target=targetHour(result,g),fields=significantFields(prev,target,cfg);return{payload:payloadForChange(prev,target,fields,result?.diagnostics?.msaFt,{temporary:false}),fields,visNeeded:fields.includes('visibility')};}

  function ddhh(t){const d=new Date(t);return p2(d.getUTCDate())+p2(d.getUTCHours());}
  function ddhhmm(t){const d=new Date(t);return ddhh(t)+p2(d.getUTCMinutes());}
  function ddhhEnd(t){const d=new Date(t);if(d.getUTCHours()===0&&d.getUTCMinutes()===0){const q=new Date(t-1);return p2(q.getUTCDate())+'24';}return ddhh(t);}
  function rebuildTaf(r){let t=`TAF ${r.station} ${ddhhmm(r.issue)}Z ${ddhh(r.start)}/${ddhhEnd(r.end)} ${r.base.text}`;for(const g of r.groups||[]){if(g.kind==='FM')t+=`\nFM${ddhhmm(g.start)} ${g.payload}`;else t+=`\n${g.kind} ${ddhh(g.start)}/${ddhhEnd(g.end)} ${g.payload}`;}return t+'=';}
  function overlap(a,b){return a.start<b.end&&b.start<a.end;}
  function groupDuplicate(a,b){return a.kind===b.kind&&overlap(a,b)&&String(a.payload)===String(b.payload);}

  function persistentGroups(result,cfg,msaFt,suppressed){
    const out=[],segs=Array.isArray(result.segments)?result.segments:[],hours=result.hourly||[];if(segs.length<2)return out;
    for(let si=1;si<segs.length;si++){
      const prevSeg=segs[si-1],s=segs[si],prev=prevSeg.state||hours[Math.max(0,s.i-1)],target=s.state||hours[s.i],fields=significantFields(prev,target,cfg);
      if(!fields.length){suppressed.push({kind:'BECMG',reason:'no-instruction-threshold',start:hours[s.i]?.t});continue;}
      if(fields.includes('weather')&&/^-(?:RA|SN|SHRA|SHSN|DZ)$/.test(encodedWxForHour(target))&&!weakPrecipAllowedInChange(target,fields)){const keep=fields.filter(x=>x!=='weather');fields.splice(0,fields.length,...keep);}
      if(!fields.length){suppressed.push({kind:'BECMG',reason:'weak-precip-no-trigger',start:hours[s.i]?.t});continue;}
      const onset=hours[s.i]?.t??target.t,stepPrev=hours[Math.max(0,s.i-1)],stepNow=hours[s.i],stepFields=significantFields(stepPrev,stepNow,cfg),abrupt=stepFields.length>=3;
      if(abrupt){const fmTime=Math.max(result.start,onset-HOUR/2),payload=encodeStateStrict(target,msaFt);out.push({kind:'FM',start:fmTime,end:result.end,payload,fields});}
      else{const start=Math.max(result.start,onset-HOUR),end=Math.min(result.end,onset+HOUR),payload=payloadForChange(prev,target,fields,msaFt);if(payload)out.push({kind:'BECMG',start,end,payload,fields});else suppressed.push({kind:'BECMG',reason:'empty-after-instruction-filter',start,end});}
    }
    return out;
  }

  function visibilityThresholdGroups(result,cfg,msaFt,existing,suppressed){
    const hours=result.hourly||[],out=[],cuts=cfg.visibilityThresholds||VIS_THRESHOLDS;
    let i=1;
    while(i<hours.length){
      const prevBand=visBand(+hours[i-1]?.visM,cuts),curBand=visBand(+hours[i]?.visM,cuts);
      if(prevBand===curBand){i++;continue;}
      let j=i+1;while(j<hours.length&&visBand(+hours[j]?.visM,cuts)===curBand)j++;
      const transitionT=hours[i].t,already=existing.concat(out).some(g=>(g.fields||[]).includes('visibility')&&g.start<=transitionT+HOUR&&g.end>=transitionT-HOUR);
      if(already){i=j;continue;}
      const fields=significantFields(hours[i-1],hours[i],cfg);
      if(!fields.includes('visibility')){i=j;continue;}
      const returnsImmediately=j===i+1&&j<hours.length&&visBand(+hours[j]?.visM,cuts)===prevBand;
      if(returnsImmediately){
        const payload=payloadForChange(hours[i-1],hours[i],fields,msaFt,{temporary:true});
        if(payload)out.push({kind:'TEMPO',start:transitionT,end:Math.min(result.end,transitionT+HOUR),payload,fields,event:'visibility'});
        else suppressed.push({kind:'TEMPO',reason:'visibility-threshold-empty',start:transitionT,end:Math.min(result.end,transitionT+HOUR)});
        i=j+1;continue;
      }
      const abrupt=fields.length>=3;
      if(abrupt){
        const fmTime=Math.max(result.start,transitionT-HOUR/2),payload=encodeStateStrict(hours[i],msaFt);
        out.push({kind:'FM',start:fmTime,end:result.end,payload,fields});
      }else{
        const start=Math.max(result.start,transitionT-HOUR),end=Math.min(result.end,transitionT+HOUR),payload=payloadForChange(hours[i-1],hours[i],fields,msaFt);
        if(payload)out.push({kind:'BECMG',start,end,payload,fields});
      }
      i=j;
    }
    return out;
  }

  function temporaryGroups(result,cfg,msaFt,existing,suppressed){
    const hours=result.hourly||[],out=[];
    const eventKey=h=>{const p=h?.prob||{},e=h?.sourceRow?.__hybridTuning||{};if((p.ts||0)>=.5)return'ts';if((p.frozen||0)>=.5)return'frozen';if((e.showerShare||0)>=.5&&(p.precip||0)>=.5)return'shower';if((e.moderateOrHeavy||(+h?.RR||0)>=.3)&&(p.precip||0)>=.5)return'precip';return'';};
    let i=0;while(i<hours.length){
      const key=eventKey(hours[i]);if(!key){i++;continue;}let j=i+1;while(j<hours.length&&eventKey(hours[j])===key)j++;
      const start=hours[i].t,end=Math.min(result.end,hours[j-1].t+HOUR),covered=existing.some(g=>overlap(g,{start,end})&&(g.fields||[]).some(f=>f==='weather'||f==='convective'));
      if(!covered){
        const h=hours.slice(i,j).sort((a,b)=>Math.max(b.prob?.ts||0,b.prob?.frozen||0,b.prob?.precip||0)-Math.max(a.prob?.ts||0,a.prob?.frozen||0,a.prob?.precip||0))[0],prev=hours[Math.max(0,i-1)],fields=key==='ts'||key==='shower'?['weather','convective']:['weather'];
        if(key==='precip'&&/^-(?:RA|SN|SHRA|SHSN)$/.test(encodedWxForHour(h))&&!weakPrecipAllowedInChange(h,fields))suppressed.push({kind:'TEMPO',reason:'weak-precip-no-trigger',start,end});
        else{const payload=payloadForChange(prev,h,fields,msaFt,{temporary:true});if(payload)out.push({kind:'TEMPO',start,end,payload,fields,event:key});}
      }
      i=j;
    }
    return out;
  }

  function probabilisticGroups(result,cfg,msaFt,existing,suppressed){
    const out=[];
    for(const original of result.groups||[]){
      if(original.kind!=='PROB30'&&original.kind!=='PROB30 TEMPO')continue;const hs=groupHours(result,original);if(!hs.length)continue;
      const score=h=>Math.max(h.prob?.ts||0,h.prob?.frozen||0,h.prob?.precip||0,h.prob?.fog||0,h.prob?.lowCeiling||0),h=hs.reduce((best,x)=>!best||score(x)>score(best)?x:best,null),prev=previousHour(result,original);
      let fields=[],event=original.event||'';if(event==='ts')fields=['weather','convective'];else if(event==='fog')fields=['visibility','weather'];else if(event==='lowCeiling')fields=['ceiling'];else if(event==='precip')fields=['weather'];
      if(fields.includes('visibility')&&!visibilityNeedsGroup(prev,h,cfg))fields=fields.filter(x=>x!=='visibility');
      if(event==='precip'){
        const wx=encodedWxForHour(h),weak=/^-(?:RA|SN|SHRA|SHSN|DZ)$/.test(wx);
        if(weak&&!weakPrecipAllowedInChange(h,fields)){suppressed.push({...original,reason:'prob30-weak-precip-no-significant-impact'});continue;}
        if(!significantWeatherToken(h)&&!fields.some(x=>x!=='weather')){suppressed.push({...original,reason:'prob30-non-significant-weather'});continue;}
      }
      if(!fields.length){suppressed.push({...original,reason:'prob30-no-instruction-threshold'});continue;}
      const kind=(event==='ts'||event==='precip')?'PROB30 TEMPO':'PROB30',payload=payloadForChange(prev,h,fields,msaFt,{temporary:true});if(!payload){suppressed.push({...original,reason:'prob30-empty-after-filter'});continue;}
      const g={...original,kind,payload,fields};if(!existing.some(x=>groupDuplicate(x,g)))out.push(g);
    }
    return out;
  }

  function postprocessResult(result,ctx={}){
    if(!result||!Array.isArray(result.hourly))return result;
    const cfg=cfgOf(ctx.config),rows=ctx.rows||result.hourly.map(h=>h.sourceRow).filter(Boolean),msaFt=finite(+ctx.msaFt)?+ctx.msaFt:finite(+result?.diagnostics?.msaFt)?+result.diagnostics.msaFt:null;
    const advisoryPlan=dominantClearPlan(rows,result.start,cfg),suppressed=[],base=result.base?.state||result.hourly[0];if(base){result.base=result.base||{};result.base.state=base;result.base.text=encodeStateStrict(base,msaFt);}
    let groups=persistentGroups(result,cfg,msaFt,suppressed);groups.push(...visibilityThresholdGroups(result,cfg,msaFt,groups,suppressed));groups.push(...temporaryGroups(result,cfg,msaFt,groups,suppressed));groups.push(...probabilisticGroups(result,cfg,msaFt,groups,suppressed));
    groups=groups.filter((g,i,a)=>g.payload&&!a.slice(0,i).some(x=>groupDuplicate(x,g))).sort((a,b)=>a.start-b.start||(a.kind==='FM'?-2:a.kind==='BECMG'?-1:1));
    if(groups.length>5){const priority=g=>g.kind==='FM'?100:g.kind==='BECMG'?90:/TS|FZ/.test(g.payload)?85:g.kind==='TEMPO'?70:g.kind==='PROB30 TEMPO'?60:50;groups=groups.map((g,i)=>({g,i,p:priority(g)})).sort((a,b)=>b.p-a.p||a.i-b.i).slice(0,5).map(x=>x.g).sort((a,b)=>a.start-b.start);}
    result.groups=groups;result.taf=rebuildTaf(result);result.checks={...(result.checks||{}),noProb40:!/\bPROB40\b/.test(result.taf),noVV:!/\bVV\d{3}\b/.test(result.taf),max5:groups.length<=5};
    const baseVersion=result.version;result.baseEngineVersion=baseVersion;result.version=`${baseVersion}+H${VERSION}`;result.diagnostics=result.diagnostics||{};result.diagnostics.consensusPrimary=true;result.diagnostics.dominantClear=advisoryPlan;
    result.diagnostics.instructionLock={version:VERSION,visibilityBands:VIS_THRESHOLDS,cavokBaseFt:CAVOK_BASE_FT,nscBaseFt:NSC_BASE_FT,msaFt,suppressedGroups:suppressed.length,suppressed:suppressed.map(x=>({kind:x.kind,reason:x.reason,start:x.start,end:x.end}))};
    if(Array.isArray(result.diagnostics.layers))result.diagnostics.layers.push({id:'S',name:'TAF-11.2023-instruction-lock',status:'ok',suppressedGroups:suppressed.length});
    if(Array.isArray(result.diagnostics.reasons)){
      result.diagnostics.reasons.push('Instrukcja TAF 11.2023: widzialność tworzy grupę zmian tylko po przejściu progu 800/1500/3000/5000 m; 9999↔5000–9000 nie jest samodzielnym kryterium.');
      if(advisoryPlan)result.diagnostics.reasons.push(`Reguła 18–05 UTC ${advisoryPlan.count}/${advisoryPlan.total} h pozostaje wyłącznie wskazówką analityczną; nie może wymusić CAVOK wbrew 3.8.10.`);
      if(!finite(+msaFt))result.diagnostics.reasons.push('MSA nie jest skonfigurowana: CAVOK/NSC sprawdzane względem 1500 m / 5000 ft; pełna kontrola wymaga najwyższej MSA EPIR.');
    }
    result.tuning={version:VERSION,consensusPrimary:true,instructionLocked:true,dominantClearAdvisory:advisoryPlan,suppressedGroups:suppressed.length,groupsAfter:groups.length};return result;
  }

  function wrapApi(core,options={}){
    if(!core?.createEngine)throw Error('Brak bazowego Hybrid TAF Engine');const cfg=cfgOf(options);
    return Object.freeze({...core,ENGINE_VERSION:`${core.ENGINE_VERSION}+H${VERSION}`,BASE_ENGINE_VERSION:core.ENGINE_VERSION,TUNING_VERSION:VERSION,
      createEngine(engineOptions={}){
        const ec={...(engineOptions.config||{}),dominantVrb02:{...((engineOptions.config||{}).dominantVrb02||{}),enabled:false}},inner=core.createEngine({...engineOptions,config:ec});
        return{generate(input){const tuned=tuneRows(input?.rows||[],cfg),r=inner.generate({...input,rows:tuned});return postprocessResult(r,{rows:tuned,config:cfg,msaFt:input?.msaFt});},learn:o=>inner.learn(o),getLearningState:()=>inner.getLearningState(),getLearningSummary:()=>inner.getLearningSummary(),importLearningState:s=>inner.importLearningState(s),resetLearning:()=>inner.resetLearning()};
      }
    });
  }

  return Object.freeze({VERSION,DEFAULTS,wmoPrecipInfo,rowEvidence,significantConsensusChange,clearCloudCandidate,dominantClearPlan,tuneRows,visibilityNeedsGroup,strictPrecipImpact,strictCavokEligible,strictNscEligible,selectedClouds,encodeStateStrict,significantFields,visibilityThresholdGroups,selectiveBecmgPayload,postprocessResult,wrapApi});
});

(()=>{
  if(typeof window==='undefined'||typeof location==='undefined')return;
  if(!/\/taf\.html$/i.test(location.pathname)||window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__)return;window.__PROGNOZA_EPIR_TAF_HYBRID_BOOT__=true;
  const loadScript=src=>new Promise((resolve,reject)=>{const key=src.split('?')[0],e=[...document.scripts].find(s=>s.src&&s.src.includes(key));if(e){if(e.dataset.loaded==='1'||(key.includes('taf-hybrid-engine')&&window.PrognozaEPIRTAFHybridEngine))return resolve();e.addEventListener('load',resolve,{once:true});e.addEventListener('error',()=>reject(Error('Nie udało się załadować '+src)),{once:true});return;}const s=document.createElement('script');s.src=src;s.async=false;s.dataset.tafHybrid='1';s.onload=()=>{s.dataset.loaded='1';resolve();};s.onerror=()=>reject(Error('Nie udało się załadować '+src));(document.head||document.documentElement).appendChild(s);});
  (async()=>{try{
    if(!window.PrognozaEPIRTAFHybridEngine)await loadScript('taf-hybrid-engine.js?v=20260913-instruction-v4');
    window.PrognozaEPIRTAFHybridEngine=window.PrognozaEPIRTAFHybridTuning.wrapApi(window.PrognozaEPIRTAFHybridEngine);
    await loadScript('taf-hybrid-adapter.js?v=20260913-instruction-v4');
    window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({mode:'hybrid-instruction-locked',version:window.PrognozaEPIRTAFHybridEngine?.ENGINE_VERSION||null,tuning:window.PrognozaEPIRTAFHybridTuning.VERSION});
  }catch(e){console.error('[TAF Hybrid bootstrap]',e);const b=document.getElementById('badge'),st=document.getElementById('st');if(b){b.textContent='BŁĄD HYBRID';b.className='badge bad';}if(st)st.textContent=e.message;}})();
})();