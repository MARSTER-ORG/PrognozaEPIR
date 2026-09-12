/* PrognozaEPIR neighboring TAF context.
 * Positive-only, upwind and time-matched signal from EPBY/EPPW/EPKS.
 * It reads the central GitHub MessageArchive snapshot only; it never acquires TAFs itself.
 */
'use strict';
(() => {
  const EPIR={lat:52.7989,lon:18.2639};
  const META={
    EPBY:{name:'Bydgoszcz',lat:53.0968,lon:17.9777},
    EPPW:{name:'Powidz',lat:52.3792,lon:17.8539},
    EPKS:{name:'Krzesiny',lat:52.3317,lon:16.9664}
  };
  const HOUR=36e5,MAX_WEIGHT=.12;
  let snapshot=null,lastLoaded=0;
  const finite=Number.isFinite,rad=x=>x*Math.PI/180,deg=x=>(x*180/Math.PI+360)%360;
  const blend=(a,b,w)=>finite(a)&&finite(b)?a*(1-w)+b*w:(finite(a)?a:b);
  function circular(a,b){let x=Math.abs((a||0)-(b||0))%360;return x>180?360-x:x}
  function geo(a,b){
    const p1=rad(a.lat),p2=rad(b.lat),dl=rad(b.lon-a.lon),dp=rad(b.lat-a.lat);
    const q=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    const km=6371*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q));
    const y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    return{km,bearing:deg(Math.atan2(y,x))};
  }
  function monthCandidate(day,hour,minute,refMs){
    const ref=new Date(refMs),out=[];
    for(const dm of [-1,0,1]){
      if(hour===24){
        const b=new Date(Date.UTC(ref.getUTCFullYear(),ref.getUTCMonth()+dm,day,0,minute||0));
        if(b.getUTCDate()===day)out.push(b.getTime()+24*HOUR);
      }else{
        const d=new Date(Date.UTC(ref.getUTCFullYear(),ref.getUTCMonth()+dm,day,hour,minute||0));
        if(d.getUTCDate()===day)out.push(d.getTime());
      }
    }
    return out.sort((a,b)=>Math.abs(a-refMs)-Math.abs(b-refMs))[0]??NaN;
  }
  function resolveDDHH(code,refMs){
    const m=String(code||'').match(/^(\d{2})(\d{2})$/);if(!m)return NaN;
    const h=+m[2];if(h>24)return NaN;return monthCandidate(+m[1],h,0,refMs);
  }
  function resolveFM(code,refMs){
    const m=String(code||'').match(/^(\d{2})(\d{2})(\d{2})$/);if(!m)return NaN;
    return monthCandidate(+m[1],+m[2],+m[3],refMs);
  }
  function issueTime(raw){
    const m=String(raw||'').match(/\b(\d{2})(\d{2})(\d{2})Z\b/);if(!m)return NaN;
    return monthCandidate(+m[1],+m[2],+m[3],Date.now());
  }
  function resolveEnd(code,from,issue){
    let t=resolveDDHH(code,issue);if(finite(t)&&t<=from)t=resolveDDHH(code,from+36*HOUR);return t;
  }
  function hazard(text){
    const s=String(text||'').toUpperCase();let phenomenon=null,risk=0;
    if(/\bFZFG\b/.test(s)){phenomenon='FZFG';risk=100}
    else if(/\bMIFG\b/.test(s)){phenomenon='MIFG';risk=72}
    else if(/\bFG\b/.test(s)){phenomenon='FG';risk=95}
    else if(/\bBR\b/.test(s)){phenomenon='BR';risk=55}
    let visibilityM=null;
    for(const m of s.matchAll(/(?:^|\s)(\d{4})(?=\s|$)/g)){
      const v=+m[1];if(v===9999||v<50||v>9998)continue;
      visibilityM=visibilityM===null?v:Math.min(visibilityM,v);
    }
    if(finite(visibilityM)){
      const vr=visibilityM<1000?92:visibilityM<3000?72:visibilityM<5000?58:38;
      if(vr>risk){risk=vr;phenomenon=phenomenon||'VIS'}
    }
    return risk>0?{phenomenon,risk,visibilityM}:null;
  }
  function segments(raw){
    raw=String(raw||'').replace(/\s+/g,' ').trim();
    if(!raw||/\bNIL\b/.test(raw))return[];
    const issue=issueTime(raw),vm=raw.match(/\b(\d{4})\/(\d{4})\b/);if(!finite(issue)||!vm)return[];
    const validFrom=resolveDDHH(vm[1],issue),validTo=resolveEnd(vm[2],validFrom,issue);if(!finite(validFrom)||!finite(validTo))return[];
    const re=/\b(FM(\d{6})|BECMG\s+(\d{4})\/(\d{4})|TEMPO\s+(\d{4})\/(\d{4})|PROB(30|40)(?:\s+TEMPO)?\s+(\d{4})\/(\d{4}))\b/g;
    const marks=[];let m;while((m=re.exec(raw)))marks.push({i:m.index,end:re.lastIndex,fm:m[2],becA:m[3],becB:m[4],tmpA:m[5],tmpB:m[6],prob:m[7],prA:m[8],prB:m[9]});
    const out=[],bodyStart=vm.index+vm[0].length,first=marks[0]?.i??raw.length;
    const baseHaz=hazard(raw.slice(bodyStart,first));if(baseHaz)out.push({from:validFrom,to:validTo,factor:1,kind:'BASE',hazard:baseHaz});
    const persistent=marks.filter(x=>x.fm||x.becA);
    for(let i=0;i<marks.length;i++){
      const x=marks[i],body=raw.slice(x.end,marks[i+1]?.i??raw.length),h=hazard(body);if(!h)continue;
      let from,to,factor=1,kind='';
      if(x.fm){from=resolveFM(x.fm,issue);kind='FM';const nxt=persistent.find(y=>y.i>x.i);to=nxt?(nxt.fm?resolveFM(nxt.fm,issue):resolveDDHH(nxt.becA,issue)):validTo}
      else if(x.becA){from=resolveEnd(x.becB,resolveDDHH(x.becA,issue),issue);kind='BECMG';const nxt=persistent.find(y=>y.i>x.i);to=nxt?(nxt.fm?resolveFM(nxt.fm,issue):resolveDDHH(nxt.becA,issue)):validTo}
      else if(x.tmpA){from=resolveDDHH(x.tmpA,issue);to=resolveEnd(x.tmpB,from,issue);factor=.60;kind='TEMPO'}
      else if(x.prob){from=resolveDDHH(x.prA,issue);to=resolveEnd(x.prB,from,issue);factor=+x.prob===40?.40:.30;kind=`PROB${x.prob}`}
      if(finite(from)&&finite(to)&&to>from)out.push({from,to,factor,kind,hazard:h});
    }
    return out;
  }
  async function refresh(force=false){
    if(!force&&snapshot&&Date.now()-lastLoaded<60e3)return snapshot;
    const A=window.PrognozaEPIRMessageArchive;if(!A?.fetchText)throw new Error('MessageArchive niedostępne dla TAF sąsiadów');
    const text=await A.fetchText('taf-neighbors.json',force),value=JSON.parse(text);
    if(!value?.stations)throw new Error('Nieprawidłowy snapshot TAF sąsiadów');
    snapshot=value;lastLoaded=Date.now();return snapshot;
  }
  function fogContext(z){
    if(!snapshot?.stations||!finite(z?.t)||!finite(z?.WD)||!finite(z?.WS))return null;
    const out=[];
    for(const [station,meta] of Object.entries(META)){
      const row=snapshot.stations[station];if(!row?.raw)continue;
      const g=geo(EPIR,meta),angle=circular(z.WD,g.bearing);if(angle>=95)continue;
      let directional=Math.max(0,Math.cos(rad(angle)));directional*=directional;
      const lag=Math.max(.5,Math.min(8,g.km/Math.max(12,z.WS*3.6))),sourceTime=z.t-lag*HOUR;
      for(const seg of segments(row.raw)){
        if(sourceTime<seg.from||sourceTime>=seg.to)continue;
        const strength=directional*Math.exp(-g.km/190)*seg.factor,weight=Math.min(MAX_WEIGHT,MAX_WEIGHT*strength);
        if(weight<.012)continue;
        out.push({station,raw:row.raw,source:row.source||null,km:g.km,bearing:g.bearing,angle,lag,sourceTime,kind:seg.kind,phenomenon:seg.hazard.phenomenon,risk:seg.hazard.risk,visibilityM:seg.hazard.visibilityM,weight,score:strength*seg.hazard.risk});
      }
    }
    return out.sort((a,b)=>b.score-a.score)[0]||null;
  }
  function applySeries(series){
    if(!Array.isArray(series)||!series.length)return series;
    return series.map(z=>{
      const c=fogContext(z);if(!c)return z;const o={...z};
      if(finite(c.visibilityM)&&c.visibilityM<10000&&finite(o.VIS))o.VIS=blend(o.VIS,c.visibilityM,c.weight);
      o.neighborTafStation=c.station;o.neighborTafPhenomenon=c.phenomenon;o.neighborTafRisk=Math.round(c.risk);
      o.neighborTafWeightPct=Math.round(c.weight*100);o.neighborTafLagH=Number(c.lag.toFixed(1));o.neighborTafGroup=c.kind;o.neighborTafRaw=c.raw;
      return o;
    });
  }
  window.PrognozaEPIRNeighborTafContext={refresh,fogContext,applySeries,latest:()=>snapshot,version:'1.0.0'};
})();
