'use strict';
(() => {
  if (typeof PLACE === 'undefined') return;

  const MODEL = 'dmi_harmonie_arome_europe';
  const HOUR = 3600e3;
  const VARS = [
    'temperature_2m','dew_point_2m','relative_humidity_2m','surface_temperature',
    'wind_speed_10m','cloud_cover','cloud_cover_low','shortwave_radiation','is_day',
    'temperature_50m','temperature_100m','precipitation'
  ];
  let series = [];
  let latestObs = null;
  let busy = false;

  const finite = Number.isFinite;
  const num = v => finite(Number(v)) ? Number(v) : null;
  const clip = (v,a,b) => Math.max(a,Math.min(b,v));
  const mean = a => { const x=a.filter(finite); return x.length?x.reduce((s,v)=>s+v,0)/x.length:null; };
  const interp = (x,a,b,ya,yb) => x<=a?ya:x>=b?yb:ya+(yb-ya)*(x-a)/(b-a);
  const pw = (v,pts,below=null,above=null) => {
    if(!finite(v)) return null;
    if(v<=pts[0][0]) return below===null?pts[0][1]:below;
    for(let i=1;i<pts.length;i++) if(v<=pts[i][0]) return interp(v,pts[i-1][0],pts[i][0],pts[i-1][1],pts[i][1]);
    return above===null?pts[pts.length-1][1]:above;
  };
  function weighted(parts){
    let s=0,w=0;
    for(const p of parts){if(finite(p.v)){s+=p.v*p.w;w+=p.w;}}
    return w?s/w:null;
  }
  function parseUtc(s){return Date.parse(String(s).endsWith('Z')?s:s+'Z');}
  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }
  function riskText(s){
    if(!finite(s))return 'brak danych';
    if(s>=80)return 'bardzo wysokie';
    if(s>=60)return 'wysokie';
    if(s>=40)return 'umiarkowane';
    if(s>=20)return 'małe';
    return 'bardzo małe';
  }
  function riskCss(s){return s>=75?'fog-risk-vhigh':s>=60?'fog-risk-high':s>=40?'fog-risk-mid':'fog-risk-low';}

  // Shallow fog is a surface-layer problem. Visibility at 2 m may remain 9999,
  // therefore visibility itself is deliberately NOT a predictor here.
  function surfaceSaturation(Td,Tskin){
    if(!finite(Td)||!finite(Tskin))return null;
    const x=Td-Tskin;
    return pw(x,[[-3,0],[-2,.12],[-1,.35],[-.5,.60],[0,.85],[.5,1]],0,1);
  }
  function airSaturation(T,Td){
    if(!finite(T)||!finite(Td))return null;
    const d=T-Td;
    return pw(d,[[.2,1],[.5,.92],[1,.78],[1.5,.60],[2.5,.32],[4,.08]],1,0);
  }
  function shallowWind(u){
    if(!finite(u))return null;
    return pw(u,[[0,.55],[.3,.82],[.8,1],[1.8,.95],[2.8,.70],[4,.35],[6,0]],.55,0);
  }
  function inversion(T,T50,T100){
    if(!finite(T))return null;
    const inv=mean([finite(T50)?T50-T:null,finite(T100)?T100-T:null]);
    if(!finite(inv))return null;
    return pw(inv,[[-1,.05],[0,.30],[.4,.55],[.8,.75],[1.5,.93],[2.5,1]],.05,1);
  }
  function skyScore(tcc,low){
    const vals=[];
    if(finite(tcc))vals.push(clip(1-tcc/100,0,1));
    if(finite(low))vals.push(clip(1-low/100,0,1));
    return mean(vals);
  }
  function coolingScore(now,prev){
    if(!finite(now)||!finite(prev))return null;
    const d=now-prev;
    return pw(d,[[-3,1],[-2,.95],[-1,.78],[-.4,.55],[0,.30],[.5,.10]],1,0);
  }
  function moistureScore(p12){
    if(!finite(p12))return null;
    return pw(p12,[[0,.30],[.2,.50],[1,.72],[2,.88],[4,1]],.30,1);
  }
  function darknessScore(isDay,sw){
    if(isDay===0)return 1;
    if(finite(sw))return pw(sw,[[0,.85],[30,.65],[100,.40],[250,.18],[500,.05]],.85,.05);
    return isDay===1?.25:null;
  }

  function obsHasMifg(m){
    const s=((m?.weather||'')+' '+(m?.raw||'')).toUpperCase();
    return /(^|\s)MIFG(?=\s|$|=)/.test(s);
  }
  function obsAgeHours(m){
    const t=Date.parse(m?.obs_time||'');
    return finite(t)?Math.max(0,(Date.now()-t)/HOUR):Infinity;
  }

  async function fetchObs(){
    try{
      const r=await fetch('data/observations/latest.json?v='+Date.now(),{cache:'no-store'});
      const j=await r.json();
      latestObs=j?.metar||null;
    }catch(_){latestObs=null;}
  }

  async function fetchModel(){
    const q=new URLSearchParams({
      latitude:String(PLACE.lat),longitude:String(PLACE.lon),hourly:VARS.join(','),
      models:MODEL,timezone:'UTC',forecast_hours:'24',past_hours:'12',wind_speed_unit:'ms'
    });
    const r=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{cache:'no-store'});
    const j=await r.json().catch(()=>null);
    if(!r.ok||!j?.hourly?.time)throw new Error(j?.reason||j?.message||('DMI HTTP '+r.status));
    const h=j.hourly;
    const rows=(h.time||[]).map((s,i)=>({
      t:parseUtc(s),T:num(h.temperature_2m?.[i]),Td:num(h.dew_point_2m?.[i]),RH:num(h.relative_humidity_2m?.[i]),
      Tskin:num(h.surface_temperature?.[i]),T50:num(h.temperature_50m?.[i]),T100:num(h.temperature_100m?.[i]),
      WS:num(h.wind_speed_10m?.[i]),TCC:num(h.cloud_cover?.[i]),LOW:num(h.cloud_cover_low?.[i]),
      SW:num(h.shortwave_radiation?.[i]),isDay:num(h.is_day?.[i]),RR:num(h.precipitation?.[i])
    })).filter(x=>finite(x.t)).sort((a,b)=>a.t-b.t);

    function nearest(t){
      let best=null,bd=Infinity;
      for(const x of rows){const d=Math.abs(x.t-t);if(d<bd){bd=d;best=x;}}
      return bd<=75*60e3?best:null;
    }
    function precip12(t){
      let s=0,n=0;
      for(const x of rows){if(x.t<=t&&x.t>t-12*HOUR&&finite(x.RR)){s+=Math.max(0,x.RR);n++;}}
      return n?s:null;
    }

    const now=Date.now();
    const mifgNow=obsHasMifg(latestObs)&&obsAgeHours(latestObs)<=2;
    series=rows.filter(x=>x.t>=now-HOUR&&x.t<=now+18*HOUR).map(x=>{
      const p3=nearest(x.t-3*HOUR);
      const ss=surfaceSaturation(x.Td,x.Tskin);
      const as=airSaturation(x.T,x.Td);
      const wind=shallowWind(x.WS);
      const inv=inversion(x.T,x.T50,x.T100);
      const sky=skyScore(x.TCC,x.LOW);
      const cool=coolingScore(x.Tskin,p3?.Tskin);
      const moist=moistureScore(precip12(x.t));
      const dark=darknessScore(x.isDay,x.SW);
      let score=weighted([
        {v:ss,w:.30},{v:wind,w:.17},{v:inv,w:.16},{v:as,w:.12},
        {v:sky,w:.09},{v:cool,w:.09},{v:moist,w:.04},{v:dark,w:.03}
      ]);
      score=finite(score)?score*100:null;
      if(mifgNow&&finite(score)){
        const lead=Math.max(0,(x.t-now)/HOUR);
        const obsWeight=.35*Math.exp(-lead/2.5);
        score=(1-obsWeight)*score+obsWeight*100;
      }
      return {...x,score,components:{surfaceSat:ss,airSat:as,wind,inv,sky,cool,moist,dark}};
    });
  }

  function render(){
    const summary=document.getElementById('fogSummary');
    if(!summary||!series.length)return;
    document.getElementById('mifgCard')?.remove();
    const now=Date.now();
    const current=series.reduce((a,b)=>Math.abs(b.t-now)<Math.abs(a.t-now)?b:a,series[0]);
    const future=series.filter(x=>x.t>=now-HOUR&&x.t<=now+12*HOUR);
    const peak=future.reduce((a,b)=>!a||(b.score??-1)>(a.score??-1)?b:a,null)||current;
    const obs=obsHasMifg(latestObs)&&obsAgeHours(latestObs)<=2;
    const card=document.createElement('div');
    card.id='mifgCard';card.className='fog-card '+riskCss(current.score);
    card.innerHTML=`<small>MIFG &lt;2 m — shallow fog</small><strong>${finite(current.score)?Math.round(current.score):'—'}/100</strong>`+
      `<em>${riskText(current.score)} · szczyt ${finite(peak.score)?Math.round(peak.score):'—'}/100 ${localHour(peak.t)}${obs?' · MIFG OBS':''}</em>`;
    summary.appendChild(card);

    const note=document.getElementById('fogDataNote');
    if(note&&!document.getElementById('mifgNote')){
      const n=document.createElement('div');n.id='mifgNote';n.className='fog-data-note';
      n.innerHTML='<b>MIFG:</b> osobny score płytkiej mgły &lt;2 m; nie korzysta z VIS jako głównego predyktora. Kluczowe są Tskin↔Td, wiatr, inwersja 50/100 m, wychładzanie radiacyjne i wilgotność podłoża.';
      note.insertAdjacentElement('afterend',n);
    }
  }

  async function refresh(){
    if(busy)return;busy=true;
    try{await Promise.all([fetchObs(),fetchModel()]);render();}
    catch(e){console.warn('EPIR MIFG engine:',e);}
    finally{busy=false;}
  }

  window.PrognozaEPIRMIFG={getSeries:()=>series.slice(),refresh};
  refresh();
  setInterval(refresh,30*60e3);
  setInterval(render,90*1000);
})();
