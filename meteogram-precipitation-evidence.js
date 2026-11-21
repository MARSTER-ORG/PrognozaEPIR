'use strict';
/* POLRAD and convection are supporting evidence, NEVER direct hydrometeor classification. */
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(!root||!root.document)return;
  root.PrognozaEPIRPrecipEvidence=api;
  if(root.__epirPrecipEvidenceInstalled||typeof dataVisible!=='function'||typeof draw!=='function')return;
  root.__epirPrecipEvidenceInstalled=true;

  const previousData=dataVisible;
  dataVisible=function(){
    const rows=previousData.apply(this,arguments);
    if(!Array.isArray(rows))return rows;
    const now=Date.now();
    let store=null;try{store=root.localStorage;}catch(_){}
    const evidence=api.read(store,now);
    for(const z of rows)if(z&&Number.isFinite(z.t))z.precipEvidence=api.evaluate(z,evidence,now);
    return rows;
  };
  const previousInfo=showSectionInfo;
  showSectionInfo=function(z,id){
    const result=previousInfo.apply(this,arguments);
    if(!z||!['prec','probstorm'].includes(id))return result;
    const node=root.document.querySelector('#sectionInfo .section-values');
    if(!node)return result;
    for(const [k,v] of api.tooltipRows(z)){
      const cell=root.document.createElement('div'),label=root.document.createElement('small'),value=root.document.createElement('strong');
      cell.className='section-value';label.textContent=k;value.textContent=v;cell.append(label,value);node.appendChild(cell);
    }
    return result;
  };
  const previousDraw=draw;
  draw=function(){
    const result=previousDraw.apply(this,arguments),m=cv._meta;
    const p=m?.panelYs?.find(x=>x?.id==='prec'&&x.h>0);
    if(!p||!Array.isArray(m.data)||m.t1<=m.t0)return result;
    ctx.save();ctx.beginPath();ctx.rect(m.x0,p.y,m.x1-m.x0,p.h);ctx.clip();
    for(const z of m.data){
      const type=z.precipEvidence?.marker;
      if(!type||!Number.isFinite(z.t))continue;
      const x=m.x0+(z.t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
      if(x<m.x0+5||x>m.x1-5)continue;
      ctx.save();ctx.translate(x,p.y+26);
      ctx.fillStyle=type==='radar'?'#0891b2':'#ea580c';
      ctx.strokeStyle=typeof activeTheme==='function'&&activeTheme()==='dark'?'#0b1320':'#fff';
      ctx.lineWidth=1.2;ctx.beginPath();
      ctx.moveTo(0,-4);ctx.lineTo(4,0);ctx.lineTo(0,4);ctx.lineTo(-4,0);ctx.closePath();ctx.fill();ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    return result;
  };
  root.addEventListener?.('storage',e=>{if(api.KEYS.includes(e.key)&&cv?._meta?.data?.length)draw();});
})(typeof window!=='undefined'?window:null,function(){
  const HOUR=3600000,MINUTE=60000;
  const KEYS=Object.freeze(['prognozaepir.taf.radar-evidence.v1','prognozaepir.convection12h.v1']);
  const num=x=>x===null||x===undefined||x===''||!Number.isFinite(Number(x))?null:Number(x);
  const ms=x=>typeof x==='number'?(x>1e9&&x<1e11?x*1000:x):Date.parse(String(x||''));
  function epir(p){
    const lat=num(p?.lat),lon=num(p?.lon);
    return lat!==null&&lon!==null&&Math.abs(lat-52.828611)<0.012&&Math.abs(lon-18.330278)<0.018;
  }
  function fresh(o,now,age){
    if(!o||!epir(o.point))return false;
    const t=ms(o.updatedAt);
    return Number.isFinite(t)&&t<=now&&now-t>=0&&now-t<=age;
  }
  function get(store,key){try{return JSON.parse(store?.getItem(key)||'null');}catch(_){return null;}}
  function read(store,now=Date.now()){
    const r=get(store,KEYS[0]),c=get(store,KEYS[1]),age=now-ms(r?.frameEnd);
    const radar=fresh(r,now,45*MINUTE)&&Number.isFinite(age)&&age>=0&&age<=45*MINUTE&&
      num(r.confidence)!==null&&num(r.confidence)>=55&&['cmax','sri'].includes(r.sourceProduct)&&
      num(r.models?.support)!==null&&num(r.models?.support)>=1?r:null;
    return {radar,convection:fresh(c,now,2*HOUR)&&Array.isArray(c.rows)?c:null};
  }
  function closest(f,t){
    let best=null,dist=Infinity;
    for(const row of f?.rows||[]){
      const d=Math.abs(ms(row?.time)-t);
      if(Number.isFinite(d)&&d<dist){dist=d;best=row;}
    }
    return dist<=35*MINUTE?best:null;
  }
  function prediction(r,t,now){
    if(!r||t<now-15*MINUTE||t>now+3*HOUR)return null;
    // Advection leads in the POLRAD snapshot are relative to the LAST RADAR FRAME,
    // not to the clock time when a user opens the meteogram.
    const frameTime=ms(r.frameEnd);
    if(!Number.isFinite(frameTime)||t>frameTime+3*HOUR)return null;
    const lead=Math.max(0,(t-frameTime)/MINUTE);
    let best=null,dist=Infinity;
    for(const [key,v] of Object.entries(r.predictions||{})){
      const n=num(v),at=Number(key),d=Math.abs(at-lead);
      if(n!==null&&Number.isFinite(at)&&at>=0&&at<=180&&d<dist){dist=d;best={at,value:n};}
    }
    if(!best||dist>35)return null;
    return {...best,echo:best.value>=(r.sourceProduct==='sri'?.1:27)};
  }
  function evaluate(row,snapshot,now=Date.now()){
    if(!row||!Number.isFinite(row.t))return null;
    const lead=(row.t-now)/HOUR;
    const r=lead>=-0.75&&lead<=12.5?closest(snapshot?.convection,row.t):null;
    const tcu=num(r?.tcuProbability),cb=num(r?.cbProbability),ts=num(r?.tsProbability);
    const models=num(r?.modelCount)||0,agreement=num(r?.modelAgreement);
    const active=models>=2&&agreement!==null&&agreement>=55&&
      ((cb!==null&&cb>=60)||(ts!==null&&ts>=55));
    const radar=snapshot?.radar,forecast=prediction(radar,row.t,now),echo=forecast?.echo===true;
    const type=row.precipType?.code||'';
    const kinds=['RA','DZ','SN','SG','RASN','PCP','SHRA','SHSN','SHRASN','TSRA','TSSN','TS'];
    const corroborated=active&&echo&&kinds.includes(type);
    let desc='';
    if(corroborated&&['RA','DZ','SN','SG','RASN','PCP'].includes(type))
      desc='Możliwy opad przelotny (wsparcie NWP i adwekcji POLRAD)';
    else if(corroborated)desc='Radar wspiera modelowe zjawisko konwekcyjne';
    else if(active)desc='Możliwa konwekcja; bez pełnego wsparcia radarowego';
    else if(echo)desc='Prognozowane echo radarowe; rodzaj opadu niepotwierdzony';
    return {
      marker:corroborated?'radar':active?'convection':null,
      description:desc,convectiveNwp:active,radarForecastEcho:echo,
      radarAvailable:!!radar,convectionAvailable:!!r,cb,ts,tcu,models,agreement,
      radarSource:radar?.sourceProduct?.toUpperCase()||null,
      radarAgeMin:radar?Math.round((now-ms(radar.frameEnd))/MINUTE):null,
      radarConfidence:num(radar?.confidence),radarLeadMin:forecast?.at??null,
      radarValue:forecast?.value??null
    };
  }
  function tooltipRows(z){
    const e=z?.precipEvidence;if(!e)return [];
    const out=[];
    if(e.description)out.push(['Konwekcja / radar',e.description]);
    if(e.convectionAvailable&&e.models>=2){
      out.push(['Prognoza NWP','Cb '+(e.cb??'—')+'% · TS '+(e.ts??'—')+'%']);
      out.push(['Zgodność modeli',e.agreement+'% · '+e.models+' modele']);
    }
    if(e.radarForecastEcho){
      const val=e.radarSource==='CMAX'?Math.round(e.radarValue)+' dBZ':e.radarValue.toFixed(1)+' mm/h';
      out.push(['POLRAD — prognoza ruchu',e.radarSource+' · +'+e.radarLeadMin+' min · '+val]);
      out.push(['Wiek klatki / pewność ruchu',e.radarAgeMin+' min · '+Math.round(e.radarConfidence)+'/100']);
    } else if(e.radarAvailable)
      out.push(['POLRAD','Dane radarowe dostępne, brak potwierdzenia w tej godzinie']);
    if(out.length)out.push(['Interpretacja','Informacja wspomagająca; nie potwierdza gradu, CB ani fazy opadu']);
    return out;
  }
  return Object.freeze({KEYS,read,evaluate,tooltipRows,prediction,epir});
});
