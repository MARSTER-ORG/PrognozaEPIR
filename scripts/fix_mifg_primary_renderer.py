from pathlib import Path
import re

p = Path('mifg-engine.js')
s = p.read_text(encoding='utf-8')

pattern = re.compile(r"  function render\(\)\{\n.*?\n  \}\n\n  async function doRefresh\(\)\{", re.S)
if not pattern.search(s):
    raise SystemExit('primary MIFG render() block not found')

replacement = r"""  function operationalText(score){
    if(!finite(score))return 'BRAK DANYCH';
    if(score<40)return 'NIE';
    if(score<60)return 'MOŻLIWE';
    if(score<80)return 'PRAWDOPODOBNE';
    return 'BARDZO PRAWDOPODOBNE';
  }

  function render(){
    const summary=document.getElementById('fogSummary');
    if(!summary||!series.length)return;
    document.getElementById('mifgCard')?.remove();
    for(const oldCard of [...summary.children]){
      const small=oldCard.querySelector?.('small');
      if(small&&/\bMIFG\b/i.test(small.textContent||''))oldCard.remove();
    }
    const now=Date.now();
    const current=series.reduce((a,b)=>Math.abs(b.t-now)<Math.abs(a.t-now)?b:a,series[0]);
    const future=series.filter(x=>x.t>=now-HOUR&&x.t<=now+12*HOUR);
    const peak=future.reduce((a,b)=>!a||(b.score??-1)>(a.score??-1)?b:a,null)||current;
    const obs=obsHasMifg(latestObs)&&obsAgeHours(latestObs)<=2;
    const card=document.createElement('div');
    card.id='mifgCard';
    card.className='fog-card '+(current.score>=80?'fog-risk-vhigh':current.score>=60?'fog-risk-high':current.score>=40?'fog-risk-mid':'');
    const currentDetail=current.score>=40
      ?Math.round(current.score)+'/100'
      :'wynik <40/100 pominięty';
    const peakDetail=peak.score>=40
      ?' · maks. 12 h '+Math.round(peak.score)+'/100 '+localHour(peak.t)
      :' · brak sygnału ≥40 w 12 h';
    card.innerHTML='<small>MIFG</small><strong>'+operationalText(current.score)+'</strong>'+
      '<em>'+currentDetail+peakDetail+(obs?' · MIFG OBS':'')+'</em>';
    summary.appendChild(card);

    const note=document.getElementById('fogDataNote');
    let n=document.getElementById('mifgNote');
    if(note&&!n){
      n=document.createElement('div');n.id='mifgNote';n.className='fog-data-note';
      note.insertAdjacentElement('afterend',n);
    }
    if(n){
      const fallback=engineStatus.source.includes('fallback')?' · fallback multimodel aktywny':'';
      n.innerHTML='<b>MIFG:</b> osobny score płytkiej mgły &lt;2 m; VIS nie jest głównym predyktorem. Kluczowe są nasycenie przy powierzchni, wiatr, inwersja, wychładzanie i wilgotność podłoża'+fallback+'.';
    }
  }

  async function doRefresh(){"""

s2 = pattern.sub(replacement, s, count=1)
if s2 == s:
    raise SystemExit('patch produced no change')
p.write_text(s2, encoding='utf-8')
