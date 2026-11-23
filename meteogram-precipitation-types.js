'use strict';
/* PrognozaEPIR: precipitation phase and character; model-coded weather takes priority. */
(function(root){
const api=(function createPrecipApi(){
  const TYPES=Object.freeze({
    DZ:{code:'DZ',label:'Mżawka',color:'#52b69a',kind:'drizzle'},
    FZDZ:{code:'FZDZ',label:'Mżawka marznąca',color:'#a855f7',kind:'freezing'},
    RA:{code:'RA',label:'Deszcz',color:'#16a34a',kind:'rain'},
    FZRA:{code:'FZRA',label:'Deszcz marznący',color:'#9333ea',kind:'freezing'},
    SN:{code:'SN',label:'Śnieg',color:'#3b82f6',kind:'snow'},
    SG:{code:'SG',label:'Śnieg ziarnisty',color:'#7dd3fc',kind:'snow'},
    RASN:{code:'RASN',label:'Deszcz ze śniegiem',color:'#a78bfa',kind:'mixed'},
    PL:{code:'PL',label:'Ziarna lodowe',color:'#a855f7',kind:'pellets'},
    SHRA:{code:'SHRA',label:'Przelotny deszcz',color:'#f59e0b',kind:'showerRain'},
    SHRASN:{code:'SHRASN',label:'Przelotny deszcz ze śniegiem',color:'#c084fc',kind:'mixed'},
    SHSN:{code:'SHSN',label:'Przelotny śnieg',color:'#06b6d4',kind:'showerSnow'},
    SHGS:{code:'SHGS',label:'Przelotne krupy śnieżne lub drobny grad',color:'#e879f9',kind:'hail'},
    SHGR:{code:'SHGR',label:'Przelotny grad',color:'#dc2626',kind:'hail'},
    TS:{code:'TS',label:'Burza — faza opadu nieznana',color:'#e11d48',kind:'thunder'},
    TSRA:{code:'TSRA',label:'Burza z deszczem',color:'#ef4444',kind:'thunder'},
    TSSN:{code:'TSSN',label:'Burza ze śniegiem',color:'#fb7185',kind:'thunder'},
    TSGR:{code:'TSGR',label:'Burza z gradem (bez danych o wielkości)',color:'#b91c1c',kind:'hail'},
    PCP:{code:'PCP',label:'Opad — rodzaj nieokreślony',color:'#64748b',kind:'unknown'},
    VAR:{code:'VAR',label:'Różne rodzaje opadu — rozbieżność modeli',color:'#64748b',kind:'unknown'}
  });
  const num=x=>x===null||x===undefined||x===''||!Number.isFinite(Number(x))?null:Number(x);
  const make=(key,source)=>({...TYPES[key],source});
  function classify(row){
    if(!row||typeof row!=='object')return null;
    const c=num(row.weather_code??row.code);
    const code=c!==null&&Number.isInteger(c)?c:null;
    const rain=num(row.rain),snow=num(row.snowfall),showers=num(row.showers),total=num(row.precipitation??row.RR);
    const liquid=rain!==null&&rain>=0.02,solid=snow!==null&&snow>=0.02;
    const both=liquid&&solid;
    const convective=showers!==null&&showers>=0.1;
    if(code===96||code===99)return make('TSGR','WMO '+code);
    if(code===95){
      if(solid&&!liquid)return make('TSSN','WMO 95 + snowfall');
      if(liquid||convective)return make('TSRA','WMO 95 + rain/showers');
      return make('TS','WMO 95');
    }
    if(code===89||code===90)return make('SHGR','WMO '+code);
    if(code===87||code===88)return make('SHGS','WMO '+code);
    if(code===56||code===57)return make('FZDZ','WMO '+code);
    if(code===66||code===67)return make('FZRA','WMO '+code);
    if(code===79)return make('PL','WMO 79');
    if(code===68||code===69)return make('RASN','WMO '+code);
    if(code===83||code===84)return make('SHRASN','WMO '+code);
    if(code===77)return make('SG','WMO 77');
    if(both&&([80,81,82,85,86].includes(code)||convective))
      return make('SHRASN','rain + snowfall + showers');
    if(both&&([61,63,65,71,73,75].includes(code)||code===null))
      return make('RASN','rain + snowfall');
    if([51,53,55].includes(code))return make('DZ','WMO '+code);
    if([61,63,65].includes(code))return make('RA','WMO '+code);
    if([71,73,75].includes(code))return make('SN','WMO '+code);
    if([80,81,82].includes(code))return make('SHRA','WMO '+code);
    if([85,86].includes(code))return make('SHSN','WMO '+code);
    if(solid)return make(convective?'SHSN':'SN','snowfall'+(convective?' + showers':''));
    if(convective)return make('SHRA','showers');
    if(liquid)return make('RA','rain');
    if(total!==null&&total>=0.1)return make('PCP','precipitation');
    return null;
  }
  const PHASE_FAMILY=Object.freeze({
    DZ:'rain',RA:'rain',SHRA:'rain',TSRA:'rain',
    SN:'snow',SG:'snow',SHSN:'snow',TSSN:'snow',
    RASN:'mixed',SHRASN:'mixed',
    FZDZ:'freezing',FZRA:'freezing',
    PL:'pellets',SHGS:'hail',SHGR:'hail',TSGR:'hail',
    TS:'unknown',PCP:'unknown'
  });
  const SHOWERS=new Set(['SHRA','SHSN','SHRASN','SHGS','SHGR']);
  const THUNDER=new Set(['TS','TSRA','TSSN','TSGR']);
  function familyOf(wx){return PHASE_FAMILY[wx?.code]||'unknown';}
  function aggregate(models){
    const votes=(Array.isArray(models)?models:[]).map(m=>{
      const w=num(m?.w);
      return{w:w!==null&&w>0?w:0,wx:classify(m)};
    }).filter(m=>m.w>0);
    const total=votes.reduce((s,m)=>s+m.w,0);
    const wetVotes=votes.filter(m=>m.wx);
    const wetWeight=wetVotes.reduce((s,m)=>s+m.w,0);
    if(!wetWeight||!total)return null;
    const byCode=new Map(),byPhase=new Map(),byCodeModels=new Map();
    for(const m of wetVotes){
      byCode.set(m.wx.code,(byCode.get(m.wx.code)||0)+m.w);
      byCodeModels.set(m.wx.code,(byCodeModels.get(m.wx.code)||0)+1);
      const phase=familyOf(m.wx);
      byPhase.set(phase,(byPhase.get(phase)||0)+m.w);
    }
    const codes=[...byCode].sort((a,b)=>b[1]-a[1]);
    const phases=[...byPhase].sort((a,b)=>b[1]-a[1]);
    const [phase,phaseWeight]=phases[0];
    const [code,winningWeight]=codes[0];
    const phaseShare=phaseWeight/wetWeight, runnerShare=(phases[1]?.[1]||0)/wetWeight;
    const rainShare=(byPhase.get('rain')||0)/wetWeight,snowShare=(byPhase.get('snow')||0)/wetWeight;
    const mixedDisagreement=rainShare>=.33&&snowShare>=.33;
    // First settle precipitation phase, not the exact WMO code. RA and SHRA
    // both support liquid precipitation but disagree about its character.
    // Different members forecasting RA and SN must NEVER create RASN.
    const phaseUnresolved=phase==='unknown'||mixedDisagreement||
      phaseShare<.65||phaseShare-runnerShare<.25;
    const withinPhase=codes.filter(([c])=>PHASE_FAMILY[c]===phase);
    const [phaseCode,phaseCodeWeight]=withinPhase[0]||[code,winningWeight];
    const subtypeShare=phaseCodeWeight/Math.max(1e-9,phaseWeight);
    // Rare hail/freezing/pellet events need at least two independent models
    // unless this is explicitly a single-model display outside aggregate().
    const rare=new Set(['hail','freezing','pellets']);
    const phaseModels=wetVotes.filter(m=>familyOf(m.wx)===phase).length;
    const cautiousRare=rare.has(phase)&&(phaseShare<.75||phaseModels<2);
    let result=phase==='unknown'&&phases.length===1?
      {...TYPES[phaseCode],source:'konsensus modeli — rodzaj nieznany'}:
      (phaseUnresolved||cautiousRare)?make('VAR','konsensus modeli'):
      {...TYPES[phaseCode],source:'konsensus modeli'};
    if(mixedDisagreement)result.label='Deszcz lub śnieg — modele niezgodne (nie RASN)';
    else if(cautiousRare)result.label='Możliwy opad '+(phase==='hail'?'gradu/krup':phase==='freezing'?'marznący':'lodowy')+' — niewystarczające potwierdzenie';
    else if(phaseUnresolved&&!(phase==='unknown'&&phases.length===1))
      result.label='Rodzaj opadu — niejednoznaczna faza w modelach';
    const kinds=new Map();
    for(const m of wetVotes){
      if(familyOf(m.wx)!==phase)continue;
      const c=m.wx.code;
      const kind=THUNDER.has(c)?'burzowy':SHOWERS.has(c)?'przelotny':
        c==='PCP'||c==='TS'?'nieznany':'nieprzelotny';
      kinds.set(kind,(kinds.get(kind)||0)+m.w);
    }
    const kindRanks=[...kinds].sort((a,b)=>b[1]-a[1]);
    const character=kindRanks[0]?.[0]||'nieznany';
    const characterPct=Math.round((kindRanks[0]?.[1]||0)/Math.max(1e-9,phaseWeight)*100);
    if(!phaseUnresolved&&!cautiousRare&&characterPct<65){
      // Keep the hydrometeor phase but do not assert unverified shower/TS character.
      result.label=(phase==='rain'?'Deszcz':phase==='snow'?'Śnieg':
        phase==='mixed'?'Deszcz ze śniegiem':result.label)+' — charakter niepewny';
      if(phase==='rain')result={...result,code:'RA',color:TYPES.RA.color,kind:TYPES.RA.kind};
      if(phase==='snow')result={...result,code:'SN',color:TYPES.SN.color,kind:TYPES.SN.kind};
      if(phase==='mixed')result={...result,code:'RASN',color:TYPES.RASN.color,kind:TYPES.RASN.kind};
    }
    const alt=codes.filter(([c,w])=>c!==phaseCode&&w/wetWeight>=.12).slice(0,3)
      .map(([c,w])=>c+' '+Math.round(w/wetWeight*100)+'%');
    return {...result,agreementPct:Math.round(phaseCodeWeight/wetWeight*100),
      phaseAgreementPct:Math.round(phaseShare*100),characterAgreementPct:characterPct,
      phaseFamily:phase,character:characterPct>=65?character:'niepewny',
      supportPct:Math.round(wetWeight/total*100),modelCount:votes.length,
      wetModelCount:wetVotes.length,alternatives:alt.join(', '),
      // Diagnostic-only consensus detail. Shares sum to 100 over *wet model
      // weights*. They do not claim independent calibrated probabilities.
      codeSharesPct:Object.fromEntries([...byCode].map(([k,w])=>[k,Math.round(w/wetWeight*1000)/10])),
      codeModelCounts:Object.fromEntries(byCodeModels),
      hailSupportPct:Math.round(wetVotes.filter(v=>v.wx.kind==='hail').reduce((s,m)=>s+m.w,0)/total*100)};
  }
  function colorFor(row){return row?.precipType?.color||TYPES.PCP.color;}
  function tooltipRows(row){
    const wx=row?.precipType;
    if(!wx)return [['Rodzaj opadu','Nie stwierdzono / brak danych o rodzaju']];
    const vals=[['Rodzaj',wx.label],['Kod orientacyjny',wx.code]];
    if(wx.intelligenceAdjusted)vals.push(['Kod źródłowy modeli',wx.intelligenceOriginalCode+' (sugerowano '+wx.code+')']);
    if(wx.modelCount)vals.push(
      ['Zgodność fazy opadu',wx.phaseAgreementPct+'% wag modeli wskazujących opad'],
      ['Zgodność charakteru',wx.characterAgreementPct+'% ('+wx.character+')'],
      [(wx.temporalAdjusted||wx.intelligenceAdjusted)?'Zgodność kodu przed korektą':'Zgodność kodu szczegółowego',wx.agreementPct+'%'],
      ['Modele wskazujące rodzaj opadu',wx.supportPct+'% wag ('+wx.wetModelCount+'/'+wx.modelCount+')']);
    if(wx.alternatives)vals.push(['Inne warianty',wx.alternatives]);
    if(wx.hailSupportPct>0&&wx.kind!=='hail')vals.push(['Sygnał gradu w modelach',wx.hailSupportPct+'%']);
    vals.push(['Podstawa klasyfikacji',wx.source]);
    return vals;
  }
  return Object.freeze({TYPES,classify,aggregate,colorFor,tooltipRows});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(root)(function installPrecipApi(root,api){
  root.PrognozaEPIRPrecipitation=api;
  if(!root.document||typeof dataVisible!=='function'||typeof draw!=='function')return;
  if(root.__epirPrecipitationTypesInstalled)return;
  root.__epirPrecipitationTypesInstalled=true;
  function vote(model,t){
    const ds=datasets.get(model.id);
    if(!ds)return null;
    const r=sample(ds,t);
    if(!r)return null;
    const valid=[r.precipitation,r.weather_code,r.rain,r.showers,r.snowfall]
      .some(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v)));
    if(!valid)return null;
    const adaptive=root.PrognozaEPIRAdaptiveWeights;
    const f=Number(adaptive?.factor?.(model.id,t))||1;
    return{...r,w:model.w*f,model,row:r};
  }
  const originalDataVisible=dataVisible;
  dataVisible=function(){
    const data=originalDataVisible.apply(this,arguments);
    if(!Array.isArray(data))return data;
    for(const z of data){
      if(!z||!Number.isFinite(z.t))continue;
      if(selected==='consensus'){
        const votes=MODELS.map(m=>vote(m,z.t)).filter(Boolean);
        const adaptive=root.PrognozaEPIRAdaptiveWeights;
        const context=adaptive?.contextForItems?.(votes.map(v=>({model:v.model,row:v.row,w:v.w,t:z.t})),z.t);
        for(const v of votes){
          const f=Number(adaptive?.relativeFactor?.(v.model.id,z.t,'precipitation',context));
          if(Number.isFinite(f)&&f>0)v.w*=f;
          // Independent phase/character factors are applied only after a
          // separate, explicitly approved production activation. Shadow
          // candidates must NEVER change operational forecasts.
          const phaseVote=api.classify(v);
          const learned=Number(root.PrognozaEPIRPrecipitationLearning?.factor?.(
            v.model.id,z.t,phaseVote));
          if(Number.isFinite(learned)&&learned>0)v.w*=Math.max(.8,Math.min(1.2,learned));
        }
        z.precipType=api.aggregate(votes);
      }else{
        const model=MODELS.find(m=>m.id===selected);
        const v=model&&vote(model,z.t);
        z.precipType=v?api.classify(v):null;
      }
    }
    return data;
  };
  const oldInfo=showSectionInfo;
  showSectionInfo=function(z,panelId){
    const value=oldInfo.apply(this,arguments);
    if(panelId!=='prec'&&panelId!=='probstorm')return value;
    const holder=root.document.querySelector('#sectionInfo .section-values');
    if(!holder)return value;
    for(const [key,val] of api.tooltipRows(z)){
      const item=root.document.createElement('div');
      item.className='section-value';
      const small=root.document.createElement('small'),strong=root.document.createElement('strong');
      small.textContent=key;strong.textContent=val;
      item.append(small,strong);holder.appendChild(item);
    }
    return value;
  };
  function markers(){
    const m=cv._meta;
    if(!m||!Array.isArray(m.data)||m.t1<=m.t0)return;
    const p=m.panelYs?.find(v=>v.id==='prec'&&v.h>0);
    if(!p)return;
    const spacing=(m.x1-m.x0)/Math.max(1,m.data.length-1);
    let lastLabelRight=-Infinity,lastCode='';
    ctx.save();ctx.beginPath();ctx.rect(m.x0,p.y,m.x1-m.x0,p.h);ctx.clip();
    for(const z of m.data){
      const wx=z.precipType;
      if(!wx||!Number.isFinite(z.t))continue;
      const x=m.x0+(z.t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
      if(!Number.isFinite(x))continue;
      ctx.fillStyle=wx.color;
      const w=Math.max(3,Math.min(12,spacing*.76));
      ctx.fillRect(x-w/2,p.y+3,w,5);
      if(spacing<20)continue;
      const label=wx.code+((wx.temporalAdjusted||wx.intelligenceAdjusted)?'*':'');
      ctx.font='bold 9px Arial';
      const width=ctx.measureText(label).width+8;
      if(x-width/2<=lastLabelRight+3||x+width/2>=m.x1)continue;
      if(label===lastCode&&Math.round((z.t-m.t0)/3600000)%3!==0)continue;
      const top=p.y+9;
      ctx.fillStyle=(typeof activeTheme==='function'&&activeTheme()==='dark')?'#101720':'#fff';
      ctx.fillRect(x-width/2,top,width,13);
      ctx.fillStyle=wx.color;
      ctx.font='bold 9px Arial';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(label,x,top+7);
      lastLabelRight=x+width/2;lastCode=label;
    }
    ctx.restore();
  }
  const oldDraw=draw;
  draw=function(){const out=oldDraw.apply(this,arguments);markers();return out;};
  if(root.requestAnimationFrame)root.requestAnimationFrame(()=>{
    if(typeof cv!=='undefined'&&cv._meta?.data?.length)draw();
  });
})(root,api);
})(typeof globalThis!=='undefined'?globalThis:null);
