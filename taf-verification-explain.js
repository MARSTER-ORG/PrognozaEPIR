'use strict';
(() => {
  const ID='tafScoreExplanation';
  const pct=s=>{const m=String(s||'').match(/(-?\d+(?:[.,]\d+)?)\s*%/);return m?Number(m[1].replace(',','.')):null};
  const finite=Number.isFinite;
  const round1=x=>Math.round(x*10)/10;

  function cardMap(){
    const host=document.getElementById('tafDaySummary');
    const out={};
    if(!host)return out;
    for(const card of [...host.children]){
      const d=card.querySelectorAll(':scope > div');
      if(d.length<2)continue;
      const label=(d[0].textContent||'').trim();
      const value=pct(d[1].textContent);
      if(label&&finite(value))out[label]=value;
    }
    return out;
  }

  function ensureBox(){
    const summary=document.getElementById('tafDaySummary');
    if(!summary)return null;
    let box=document.getElementById(ID);
    if(!box){
      box=document.createElement('div');
      box.id=ID;
      box.className='note';
      box.style.cssText='margin-top:7px;border:1px solid var(--b);border-radius:7px;padding:8px 9px;line-height:1.45;background:var(--s2)';
      summary.insertAdjacentElement('afterend',box);
    }
    return box;
  }

  function explainDaily(){
    const box=ensureBox();if(!box)return;
    const m=cardMap(),overall=m['Sprawdzalność ogólna'];
    const vals=[m['Wiatr'],m['Widzialność'],m['Pułap'],m['Pogoda']].filter(finite);
    if(!finite(overall)||!vals.length){if(box.textContent)box.textContent='';return}
    const base=Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
    const penalty=round1(Math.max(0,base-overall));
    const parts=[];
    if(finite(m['Wiatr']))parts.push(`Wiatr ${m['Wiatr']}%`);
    if(finite(m['Widzialność']))parts.push(`VIS ${m['Widzialność']}%`);
    if(finite(m['Pułap']))parts.push(`Pułap ${m['Pułap']}%`);
    if(finite(m['Pogoda']))parts.push(`WX ${m['Pogoda']}%`);
    const meta=(document.getElementById('tafDayMeta')?.textContent||'').trim();
    const mm=meta.match(/zakończone:\s*(\d+)\/(\d+)/i);
    const progress=mm&&mm[1]!==mm[2]?` Raport jest bieżący: zakończone ${mm[1]}/${mm[2]} TAF; pozostałe TAF-y W TOKU również wpływają na aktualny wynik.`:'';
    const html=`<b>Skąd bierze się wynik:</b> średnia bazowa z głównych elementów (${parts.join(' + ')}) = <b>${base}%</b>. Następnie odejmowana jest kara za niepotwierdzone elementy grup zmian = <b>−${penalty} pkt</b>. Wynik ogólny: <b>${base}% − ${penalty} = ${overall}%</b>.${progress}`;
    if(box.innerHTML!==html)box.innerHTML=html;
  }

  function explainRows(){
    const body=document.getElementById('tafDayRows');if(!body)return;
    for(const tr of [...body.querySelectorAll('tr')]){
      const td=tr.querySelectorAll('td');if(td.length<9)continue;
      const result=pct(td[3].textContent),vals=[pct(td[4].textContent),pct(td[5].textContent),pct(td[6].textContent),pct(td[7].textContent)].filter(finite);
      if(!finite(result)||!vals.length)continue;
      const base=Math.round(vals.reduce((a,b)=>a+b,0)/vals.length),penalty=round1(Math.max(0,base-result));
      let note=td[3].querySelector('.taf-score-breakdown');
      if(!note){note=document.createElement('div');note.className='note taf-score-breakdown';note.style.marginTop='2px';td[3].appendChild(note)}
      const text=penalty>0?`bazowo ${base}% − kara grup ${penalty} pkt`:`bazowo ${base}% · bez kary grup`;
      if(note.textContent!==text)note.textContent=text;
    }
  }

  function update(){try{explainDaily();explainRows()}catch(_){ }}
  const obs=new MutationObserver(()=>queueMicrotask(update));
  function start(){
    update();
    obs.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();