'use strict';
/* Only the eight user-selected precipitation details appear in the info card
 * and the matching desktop hover. This is a presentation-only change.
 */
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(!root||!root.document)return;
  root.PrognozaEPIRPrecipCompactInfo=api;
  if(root.__epirPrecipCompactInfoInstalled||typeof showSectionInfo!=='function')return;
  root.__epirPrecipCompactInfoInstalled=true;
  const previous=showSectionInfo;
  showSectionInfo=function(z,panelId){
    const result=previous.apply(this,arguments);
    if(panelId!=='prec'||!z)return result;
    const box=root.document.getElementById('sectionInfo');
    const holder=box?.querySelector('.section-values');
    if(!holder)return result;
    // Earlier modules append their diagnostic details. Replace only the
    // precipitation card after those hooks, preserving all calculations.
    const cells=api.rows(z).map(([label,value])=>{
      const cell=root.document.createElement('div');
      const small=root.document.createElement('small');
      const strong=root.document.createElement('strong');
      cell.className='section-value';
      small.textContent=label;
      strong.textContent=value;
      cell.append(small,strong);
      return cell;
    });
    holder.replaceChildren(...cells);
    box.querySelector('.section-help')?.remove();
    return result;
  };
})(typeof globalThis!=='undefined'?globalThis:null,function(){
  const finite=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
  const fmt=(v,d)=>finite(v)?Number(v).toFixed(d):'—';
  function rows(z){
    if(!z)return [];
    const wx=z.precipType,e=z.precipEvidence;
    const out=[
      ['Opad',fmt(z.RR,2)+' mm/h'],
      ['Wilgotność',fmt(z.RH,0)+'%'],
      ['Modele z opadem',fmt(z.wet,0)+'%'],
      ['Próg opadu','≥ 0.1 mm/h'],
      ['Rodzaj',wx?.label||'Nie stwierdzono / brak danych o rodzaju'],
      ['Kod orientacyjny',wx?.code?
        wx.code+(wx.temporalAdjusted||wx.intelligenceAdjusted?'*':''):'—']
    ];
    if(wx?.alternatives)out.push(['Inne warianty',wx.alternatives]);
    if(e?.convectionAvailable)out.push(['TCu / Cb (wskaźnik NWP)',
      'TCu '+(e.tcu??'—')+'% · Cb '+(e.cb??'—')+'% · TS '+(e.ts??'—')+'%']);
    return out;
  }
  return Object.freeze({rows});
});
