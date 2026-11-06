'use strict';
/* EPIR-only, held-out historical correction of SURFACE cloud amount.
 * Never adjust pressure-level profile or any aviation ceiling/FG logic.
 * Without an explicitly validated coefficient return raw values unchanged.
 */
(function(root){
  const HOUR=3600000;
  const URL='data/learning/consensus-cloud-calibration.json';
  let calibration=null, loadPromise=null, error=null;
  function finite(x){return typeof x==='number'&&Number.isFinite(x);}
  function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
  function leadBucket(targetMs,nowMs){
    const h=(targetMs-nowMs)/HOUR;
    if(!finite(h)||h<0||h>120)return null;
    return h<3?'0-3h':h<6?'3-6h':h<12?'6-12h':h<24?'12-24h':h<48?'24-48h':'48-120h';
  }
  function apply({totalPct=null,midPct=null,targetMs=null,nowMs=Date.now()}={}){
    const bucket=leadBucket(Number(targetMs),Number(nowMs));
    const hour=finite(targetMs)?new Date(targetMs).getUTCHours():null;
    const phase=hour===null?null:(hour<6||hour>=18?'night':'day');
    function field(name,raw){
      const pct=finite(raw)?clamp(raw,0,100):null;
      const rows=calibration?.lead_buckets?.[bucket]?.[name];
      let row=null;
      if(rows){
        if(name==='total'&&phase&&rows[phase]?.active)row=rows[phase];
        else if(rows.all?.active)row=rows.all;
      }
      const shift=Number(row?.shift_okta);
      const use=!!row?.active&&finite(shift)&&shift!==0&&pct!==null;
      const okta=use?clamp(Math.floor(pct/12.5+shift+.5),0,8):pct===null?null:clamp(Math.round(pct/12.5),0,8);
      return {raw_pct:pct,corrected_pct:use?okta*12.5:pct,okta,applied:use,shift_okta:use?shift:0};
    }
    return {bucket,phase,total:field('total',totalPct),mid:field('mid',midPct),generated_at:calibration?.generated_at||null};
  }
  async function load(){
    if(loadPromise)return loadPromise;
    loadPromise=(async()=>{
      try{
        const response=await root.fetch(URL+'?v='+Date.now(),{cache:'no-store'});
        if(!response.ok)throw Error('HTTP '+response.status);
        const data=await response.json();
        if(data?.schema!=='prognozaepir-consensus-cloud-calibration-v1'||data?.station!=='EPIR')throw Error('unsupported calibration schema');
        calibration=data;error=null;
      }catch(e){calibration=null;error=String(e?.message||e);}
      return calibration;
    })();
    return loadPromise;
  }
  const api={load,apply,leadBucket,
    get state(){return {loaded:!!calibration,error,generated_at:calibration?.generated_at||null};},
    // A testing hook cannot mutate the production model and is only exposed in Node.
    ...(typeof module!=='undefined'&&module.exports?{setCalibrationForTest:x=>{calibration=x;}}:{})
  };
  root.PrognozaEPIRCloudCalibration=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
