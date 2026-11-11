'use strict';
// Current TAF is not "latest ingested TAF": it must be valid at the time of the lookup.
// UTC only, including legal 24:00 end and month/year boundaries.
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PrognozaEPIRTAFValidity=api;
})(typeof window!=='undefined'?window:null,function(){
  const H=3600000,D=24*H;
  const rawOf=o=>String(typeof o==='string'?o:(o?.raw||o?.canonical_raw||'')).replace(/\s+/g,' ').trim().toUpperCase();
  const parseDate=o=>{
    for(const k of ['issue_time','issued_at','taf_issue_time']){
      const x=Date.parse(o?.[k]||'');
      if(Number.isFinite(x))return x;
    }
    return null;
  };
  function validity(input,reference=Date.now()){
    const raw=rawOf(input);
    const match=raw.match(/\bTAF\s+(?:(?:AMD|COR)\s+)?([A-Z]{4})\s+(\d{2})(\d{2})(\d{2})Z\s+(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
    if(!match)return null;
    const [,station,issueDay,issueHour,issueMinute,startDay,startHour,endDay,endHour]=match;
    if(+issueDay<1||+issueDay>31||+issueHour>23||+issueMinute>59||+startDay<1||+startDay>31||+startHour>23||+endDay<1||+endDay>31||+endHour>24)return null;
    const now=Number(reference);
    if(!Number.isFinite(now))return null;
    const d=new Date(now),year=d.getUTCFullYear(),month=d.getUTCMonth();
    const candidate=(dd,hh,mm=0)=>[-2,-1,0,1,2].map(delta=>Date.UTC(year,month+delta,+dd,+hh,+mm))
      .filter(t=>{const x=new Date(t);return (+hh===24?x.getUTCHours()===0:x.getUTCHours()===+hh);});
    const metadataIssue=parseDate(input);
    const issue=metadataIssue??candidate(issueDay,issueHour,issueMinute).sort((a,b)=>Math.abs(a-now)-Math.abs(b-now))[0];
    const start=candidate(startDay,startHour).filter(t=>t>=issue-6*H&&t<=issue+48*H)
      .sort((a,b)=>Math.abs(a-(issue+H))-Math.abs(b-(issue+H)))[0];
    if(!Number.isFinite(start))return null;
    const end=candidate(endDay,endHour).filter(t=>t>start&&t<=start+48*H)
      .sort((a,b)=>Math.abs(a-(start+12*H))-Math.abs(b-(start+12*H)))[0];
    if(!Number.isFinite(end))return null;
    return {station,issue,start,end,active:issue<=now+10*60000&&now>=start&&now<end,raw};
  }
  function current(input,reference=Date.now(),station=''){
    const info=validity(input,reference);
    if(!info||!info.active)return null;
    if(station&&info.station!==String(station).toUpperCase())return null;
    return input;
  }
  return Object.freeze({rawOf,validity,current});
});
