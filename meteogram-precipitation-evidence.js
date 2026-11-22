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
    if(!z||!['prec','probstorm','storm'].includes(id))return result;
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
      ctx.fillStyle=type==='radar'?'#0891b2':type==='tcu'?'#f59e0b':type==='mismatch'?'#dc2626':type==='cu'?'#64748b':'#ea580c';
      ctx.strokeStyle=typeof activeTheme==='function'&&activeTheme()==='dark'?'#0b1320':'#fff';
      ctx.lineWidth=1.2;ctx.beginPath();
      ctx.moveTo(0,-4);ctx.lineTo(4,0);ctx.lineTo(0,4);ctx.lineTo(-4,0);ctx.closePath();ctx.fill();ctx.stroke();
      if(type==='cu'&&typeof ctx.fillText==='function'&&
         (m.x1-m.x0)/Math.max(1,m.data.length-1)>25){
        ctx.font='bold 8px Arial';ctx.textAlign='center';ctx.fillText('Cu?',0,14);
      }
      ctx.restore();
    }
    ctx.restore();
    // Dedicated convection panel: actual NWP TCu/Cb estimates from the
    // independently refreshed 12-hour engine. No dots when coverage is poor,
    // outside 12 hours, or below the diagnostic 30% display threshold.
    const cloudPanel=m.panelYs?.find(x=>['storm','probstorm'].includes(x.id)&&x.h>0);
    if(cloudPanel&&typeof ctx.arc==='function'){
      const y=v=>cloudPanel.y+cloudPanel.h-7-
        Math.max(0,Math.min(100,v))*(cloudPanel.h-14)/100;
      ctx.save();ctx.beginPath();ctx.rect(m.x0,cloudPanel.y,m.x1-m.x0,cloudPanel.h);ctx.clip();
      for(const z of m.data){
        const ev=z?.precipEvidence;
        if(!ev?.cloudReliable||!Number.isFinite(z.t))continue;
        const x=m.x0+(z.t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
        if(x<m.x0+6||x>m.x1-6)continue;
        for(const [kind,v,dx,col] of [
          ['TCu',ev.tcu,-3,'#d97706'],['Cb',ev.cb,3,'#dc2626']
        ]){
          if(v===null||v<30)continue;
          ctx.beginPath();ctx.arc(x+dx,y(v),3.3,0,Math.PI*2);
          ctx.fillStyle=col;ctx.fill();
        }
      }
      ctx.restore();
    }
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
  const SHOWERS=new Set(['SHRA','SHSN','SHRASN','SHGS','SHGR','TSRA','TSSN','TSGR']);
  const THUNDER=new Set(['TSRA','TSSN','TSGR']);
  function showerCloud(row,conv){
    const code=row?.precipType?.temporalOriginalCode||row?.precipType?.code||'';
    if(!SHOWERS.has(code))return {status:'not_applicable',showery:false,sourceCode:code};
    if(!conv)return {status:'no_forecast',showery:true,sourceCode:code,
      explanation:'Prognoza TCu/Cb dostępna tylko dla najbliższych 12 godzin; brak danych nie oznacza braku chmur konwekcyjnych'};
    const tcu=num(conv.tcuProbability),cb=num(conv.cbProbability);
    const models=num(conv.modelCount)||0,agree=num(conv.modelAgreement)||0;
    const thermal=num(conv.thermodynamicInputs);
    const showerCount=num(conv.modelShowerCount),showerPct=num(conv.modelShowerSupport);
    if(models<2||agree<55||thermal===null||thermal<2||tcu===null||cb===null)
      return {status:'insufficient',showery:true,sourceCode:code,
        explanation:'Za mało niezależnych danych termodynamicznych i kodów pogodowych, aby porównać SH z TCu/Cb'};
    if(THUNDER.has(code)){
      if(cb>=45)return {status:'compatible',showery:true,sourceCode:code,
        explanation:'Model burzy wspierany przez podwyższony wskaźnik Cb'};
      return {status:'divergent',showery:true,sourceCode:code,
        explanation:'Kod burzowy w meteogramie przy niskim wskaźniku Cb — rozbieżność modeli wymagająca sprawdzenia'};
    }
    if(tcu>=40||cb>=40)return {status:'compatible',showery:true,sourceCode:code,
      explanation:'Opad przelotny z sygnałem rozwiniętych chmur konwekcyjnych; nie jest to potwierdzenie obserwacji TCu/Cb'};
    if(showerCount!==null&&showerCount>=2&&showerPct!==null&&showerPct>=50)
      return {status:'cu_possible',showery:true,sourceCode:code,
        explanation:'Co najmniej dwa modele prognozują opad przelotny, ale wskaźniki TCu/Cb są niskie. Możliwy opad z Cu; TCu/Cb niepotwierdzone'};
    if(showerCount!==null&&showerCount===0)
      return {status:'divergent',showery:true,sourceCode:code,
        explanation:'Konsensus wskazuje SH, lecz żaden model silnika TCu/Cb nie wskazuje opadu przelotnego i wskaźniki głębokiej konwekcji są niskie'};
    return {status:'cu_possible',showery:true,sourceCode:code,
      explanation:'Opad przelotny wskazuje pochodzenie konwekcyjne, ale nie przesądza o obecności TCu ani Cb; możliwy Cu'};
  }
  function evaluate(row,snapshot,now=Date.now()){
    if(!row||!Number.isFinite(row.t))return null;
    const lead=(row.t-now)/HOUR;
    const r=lead>=-0.75&&lead<=12.5?closest(snapshot?.convection,row.t):null;
    const tcu=num(r?.tcuProbability),cb=num(r?.cbProbability),ts=num(r?.tsProbability);
    const models=num(r?.modelCount)||0,agreement=num(r?.modelAgreement);
    const thermodynamicInputs=num(r?.thermodynamicInputs);
    const cloudReliable=!!r&&models>=2&&agreement!==null&&agreement>=55&&
      thermodynamicInputs!==null&&thermodynamicInputs>=2;
    const active=models>=2&&agreement!==null&&agreement>=55&&
      ((cb!==null&&cb>=60)||(ts!==null&&ts>=55));
    const tcuNwp=cloudReliable&&tcu!==null&&tcu>=40;
    const radar=snapshot?.radar,forecast=prediction(radar,row.t,now),echo=forecast?.echo===true;
    const type=row.precipType?.temporalOriginalCode||row.precipType?.code||'';
    const consistency=showerCloud(row,r);
    const kinds=['RA','DZ','SN','SG','RASN','PCP','SHRA','SHSN','SHRASN','TSRA','TSSN','TS'];
    const corroborated=active&&echo&&kinds.includes(type);
    let desc='';
    if(corroborated&&['RA','DZ','SN','SG','RASN','PCP'].includes(type))
      desc='Możliwy opad przelotny (wsparcie NWP i adwekcji POLRAD)';
    else if(corroborated)desc='Radar wspiera modelowe zjawisko konwekcyjne';
    else if(active)desc='Możliwa głęboka konwekcja; bez pełnego wsparcia radarowego';
    else if(tcuNwp)desc='Modelowe prawdopodobieństwo TCu podwyższone; Cb i burza nie muszą wystąpić';
    else if(echo)desc='Prognozowane echo radarowe; rodzaj opadu niepotwierdzony';
    // A shower is evidence of a convective precipitation mechanism, not
    // observational proof of a TCu/CB cloud or a thunderstorm.
    const marker=corroborated?'radar':active?'convection':tcuNwp?'tcu':
      consistency.status==='cu_possible'?'cu':
      consistency.status==='divergent'?'mismatch':null;
    return {
      marker,description:desc,convectiveNwp:active||tcuNwp,deepConvectiveNwp:active,
      tcuModelSignal:tcuNwp,radarForecastEcho:echo,
      radarAvailable:!!radar,convectionAvailable:!!r,cb,ts,tcu,models,agreement,
      thermodynamicInputs,cloudReliable,
      showerModelSupport:num(r?.modelShowerSupport),
      showerModelCount:num(r?.modelShowerCount),
      showerCloudStatus:consistency.status,
      showerCloudExplanation:consistency.explanation||null,
      showerCloudSource:consistency.sourceCode,
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
    if(e.convectionAvailable){
      out.push(['TCu / Cb (wskaźnik NWP)',
        'TCu '+(e.tcu??'—')+'% · Cb '+(e.cb??'—')+'% · TS '+(e.ts??'—')+'%']);
      if(e.models>=2)out.push(['Zgodność modeli konwekcji',
        (e.agreement??'—')+'% · '+e.models+' modele']);
      if(e.showerModelSupport!==null)
        out.push(['Modele wskazujące opad przelotny',
          e.showerModelSupport+'% ('+(e.showerModelCount??'—')+'/'+e.models+')']);
      if(!e.cloudReliable)
        out.push(['Jakość wskaźnika TCu/Cb',
          'Dane modelowe niepełne; brak podstaw do potwierdzenia braku rozwoju pionowego']);
    }
    if(e.showerCloudExplanation)
      out.push(['Spójność SH z TCu/Cb',e.showerCloudExplanation]);
    if(e.radarForecastEcho){
      const val=e.radarSource==='CMAX'?Math.round(e.radarValue)+' dBZ':e.radarValue.toFixed(1)+' mm/h';
      out.push(['POLRAD — prognoza ruchu',e.radarSource+' · +'+e.radarLeadMin+' min · '+val]);
      out.push(['Wiek klatki / pewność ruchu',e.radarAgeMin+' min · '+Math.round(e.radarConfidence)+'/100']);
    }else if(e.radarAvailable)
      out.push(['POLRAD','Dane radarowe dostępne, brak potwierdzenia w tej godzinie']);
    if(out.length)out.push(['Interpretacja','TCu/Cb są szacunkami modelowymi, nie obserwacjami. SH oznacza konwekcję Cu lub Cb; brak automatycznej zmiany TAF']);
    return out;
  }
  return Object.freeze({KEYS,read,evaluate,tooltipRows,prediction,epir,showerCloud});
});
