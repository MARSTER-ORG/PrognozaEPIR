'use strict';
(()=>{
  if(!/\/taf\.html$/i.test(location.pathname))return;
  const FT=3.28084,KT=1.94384,NSC=5000,MAX_M=NSC/FT,DOM=.50,VRB_SHARE=.75,VRB_LOW=2,VRB_OTHER_MAX=10;
  const $=id=>document.getElementById(id),fin=Number.isFinite,clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),pad=(v,n=2)=>String(Math.round(v)).padStart(n,'0');
  let applying=false,queued=false,lastOutput='';

  function amountCode(o){o=clamp(Math.round(o),0,8);return o<=0?null:o<=2?'FEW':o<=4?'SCT':o<=7?'BKN':'OVC'}
  function amountMin(c){return c==='FEW'?1:c==='SCT'?3:c==='BKN'?5:c==='OVC'?8:0}
  function parseCloud(t){const m=String(t||'').match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);return m?{raw:m[0],amount:m[1],ft:+m[2]*100,type:m[3]||''}:null}
  function parseWind(t){const m=String(t||'').match(/^(VRB|\d{3})(\d{2,3})(?:G(P99|\d{2,3}))?KT$/);return m?{vrb:m[1]==='VRB',dir:m[1]==='VRB'?null:+m[1],speed:+m[2],gust:m[3]?(m[3]==='P99'?100:+m[3]):null}:null}

  function monthTime(code,ref,minutes=false){if(!/^\d{4,6}$/.test(String(code||'')))return NaN;const s=String(code),d=+s.slice(0,2),h=+s.slice(2,4),mi=minutes?+s.slice(4,6):0,R=new Date(ref),a=[];for(let dm=-1;dm<=1;dm++)a.push(Date.UTC(R.getUTCFullYear(),R.getUTCMonth()+dm,d,h,mi));return a.sort((x,y)=>Math.abs(x-ref)-Math.abs(y-ref))[0]}
  function tafTimes(raw){const i=String(raw).match(/\b(\d{6})Z\b/),v=String(raw).match(/\b(\d{4})\/(\d{4})\b/);if(!i||!v)return null;const issue=monthTime(i[1],Date.now(),true),start=monthTime(v[1],issue);let end=monthTime(v[2],start+6*3600e3);if(end<=start)end=monthTime(v[2],start+18*3600e3);return{issue,start,end}}
  function getSeries(times){const w=$('engine')?.contentWindow;if(!w)return[];try{const d=w.eval(`consensus.map(z=>({t:z.t,WS:z.WS,WD:z.WD,G:z.G,count:z.count,ceiling:z.ceiling,lowH:z.lowH,midH:z.midH,highH:z.highH,oktaL:z.oktaL,oktaM:z.oktaM,oktaH:z.oktaH}))`);return Array.isArray(d)?d.filter(z=>fin(z?.t)&&z.t>=times.start&&z.t<times.end):[]}catch(_){return[]}}

  function band(ft){for(let i=0,p=[200,300,500,1000,1500];i<p.length;i++)if(ft<p[i])return i;return 5}
  function rowState(z){const l=[[z?.oktaL,z?.lowH],[z?.oktaM,z?.midH],[z?.oktaH,z?.highH]].map(([o,h])=>({o:+o,h:+h})).filter(x=>fin(x.o)&&x.o>0&&fin(x.h));const b=l.filter(x=>x.o>=5).sort((a,b)=>a.h-b.h)[0],cf=b?b.h*FT:(fin(+z?.ceiling)?+z.ceiling*FT:NaN);return{cf,low:l.some(x=>x.o>=5&&x.h*FT<1500)}}
  function firstCloudChange(s){if(!s.length)return Infinity;const b=rowState(s[0]);for(let i=1;i<s.length;i++){const a=rowState(s[i]);if(band(b.cf)===band(a.cf)&&b.low===a.low)continue;const n=i+1<s.length?rowState(s[i+1]):a;if(band(b.cf)!==band(n.cf)||b.low!==n.low)return s[i].t}return Infinity}

  function baseCloudReps(series){
    const scope=series.filter(z=>z.t<firstCloudChange(series));if(!scope.length)return[];
    const hw=scope.map(z=>fin(+z.count)?clamp(+z.count/8,.75,1.25):1),tw=hw.reduce((a,b)=>a+b,0)||1,s=[];
    scope.forEach((z,i)=>[[z.oktaL,z.lowH],[z.oktaM,z.midH],[z.oktaH,z.highH]].forEach(([o,h])=>{o=+o;h=+h;if(fin(o)&&o>0&&fin(h)&&h>=0&&h<MAX_M)s.push({o:clamp(o,0,8),h,i,w:hw[i]})}));
    if(!s.length)return[];s.sort((a,b)=>a.h-b.h);const cs=[];
    for(const x of s){let c=null,d=Infinity;for(const q of cs){const z=Math.abs(x.h-q.h);if(z<350&&z<d){c=q;d=z}}if(!c){c={a:[],h:x.h};cs.push(c)}c.a.push(x);const den=c.a.reduce((u,v)=>u+v.w*Math.max(1,v.o),0)||1;c.h=c.a.reduce((u,v)=>u+v.h*v.w*Math.max(1,v.o),0)/den}
    const reps=cs.map(c=>{const by=new Map();for(const x of c.a){const p=by.get(x.i);if(!p||x.o>p.o)by.set(x.i,x)}let cover=0,pres=0,hn=0,hd=0;scope.forEach((_,i)=>{const x=by.get(i),w=hw[i];if(!x)return;cover+=x.o*w;pres+=w;hn+=x.h*w*Math.max(1,x.o);hd+=w*Math.max(1,x.o)});const avg=cover/tw,presence=pres/tw,h=hd?hn/hd:NaN,code=amountCode(avg);if(!code||presence<=DOM||!fin(h))return null;const q=clamp(Math.round(h*FT/100),1,49);return{code,avgOkta:avg,presence,h,ft:q*100,token:code+pad(q,3)}}).filter(Boolean).sort((a,b)=>a.h-b.h);
    const out=[];if(reps[0])out.push(reps[0]);for(let i=1;i<reps.length&&out.length<3;i++){const need=out.length===1?2:4;if(reps[i].avgOkta>need)out.push(reps[i])}return out;
  }

  function selectCloudTokens(tokens){const p=tokens.map(parseCloud).filter(Boolean).filter(c=>c.type||c.ft<NSC),ord=p.filter(c=>!c.type).sort((a,b)=>a.ft-b.ft),conv=p.filter(c=>c.type).sort((a,b)=>a.ft-b.ft),out=[];if(ord[0])out.push(ord[0]);if(ord.length>1){const x=ord.slice(1).find(c=>amountMin(c.amount)>2);if(x)out.push(x)}if(ord.length>1){const used=new Set(out.map(c=>c.raw)),x=ord.filter(c=>!used.has(c.raw)).find(c=>amountMin(c.amount)>4);if(x)out.push(x)}for(const c of conv)if(!out.some(x=>x.raw===c.raw))out.push(c);return out.sort((a,b)=>a.ft-b.ft).map(c=>c.raw)}
  function isWx(t){return /^(?:FG|FZFG|BR|HZ|RA|DZ|SN|SHRA|SHSN|TS|TSRA|FZRA|FZDZ|MIFG|BCFG|PRFG)$/.test(String(t||'').replace(/^[-+]/,''))}
  function normalizeCloudLine(line,reps,isBase){let t=String(line||'').replace(/=$/,'').trim().split(/\s+/),cloud=t.filter(x=>parseCloud(x)),conv=cloud.filter(x=>parseCloud(x)?.type);if(isBase&&Array.isArray(reps)){t=t.filter(x=>!parseCloud(x)||parseCloud(x)?.type).filter(x=>x!=='NSC');const sel=selectCloudTokens([...reps.map(r=>r.token),...conv]);t=t.filter(x=>!parseCloud(x)).concat(sel)}else if(cloud.length){const sel=selectCloudTokens(cloud);t=t.filter(x=>!parseCloud(x)).concat(sel)}const now=t.filter(x=>parseCloud(x)),ord=now.map(parseCloud).filter(c=>c&&!c.type&&c.ft<NSC),cnv=now.map(parseCloud).filter(c=>c?.type),wx=t.some(isWx),vis=t.find(x=>/^\d{4}$/.test(x)),v9999=!vis||vis==='9999';if(now.length)t=t.filter(x=>x!=='NSC');if(t.includes('CAVOK')&&now.length){t=t.filter(x=>x!=='CAVOK');if(!t.some(x=>/^\d{4}$/.test(x)))t.push('9999')}if(isBase&&!ord.length&&!cnv.length){t=t.filter(x=>x!=='NSC'&&x!=='CAVOK');if(!wx&&v9999){t=t.filter(x=>x!=='9999');t.push('CAVOK')}else t.push('NSC')}const non=t.filter(x=>!parseCloud(x)),fc=selectCloudTokens(t.filter(x=>parseCloud(x)));return[...non,...fc].filter((x,i,a)=>x&&a.indexOf(x)===i).join(' ').replace(/\s+/g,' ').trim()}

  function encodedSpeed(z){const raw=+z?.WS*KT;if(!fin(raw))return NaN;let n=Math.max(0,Math.round(raw));if(n<1)return 0;if(n%2)n++;return n}
  function dominantVrb02(series){const speeds=series.map(encodedSpeed).filter(fin);if(speeds.length<8)return null;const low=speeds.filter(v=>v<=VRB_LOW).length,share=low/speeds.length,max=Math.max(...speeds);if(share<VRB_SHARE||max>VRB_OTHER_MAX)return null;return{share,count:low,total:speeds.length,max}}
  function replaceBaseWind(line,token){const re=/\b(?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT\b/;return re.test(line)?line.replace(re,token):line}
  function suppressLowWindChanges(lines,use){if(!use)return lines;const out=[lines[0]];for(let i=1;i<lines.length;i++){const m=lines[i].match(/^BECMG\s+\d{4}\/\d{4}\s+((?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT)$/);if(m){const w=parseWind(m[1]);if(w&&w.speed<10)continue}out.push(lines[i])}return out}

  function normalize(raw,series){const lines=String(raw||'').split(/\n+/).map(x=>x.trim().replace(/=$/,'')).filter(Boolean);if(!lines.length)return{text:raw,reps:[],vrb:null};const reps=baseCloudReps(series);lines[0]=normalizeCloudLine(lines[0],reps,true);for(let i=1;i<lines.length;i++)lines[i]=normalizeCloudLine(lines[i],null,false);const vrb=dominantVrb02(series);if(vrb)lines[0]=replaceBaseWind(lines[0],'VRB02KT');return{text:suppressLowWindChanges(lines,vrb).join('\n')+'=',reps,vrb}}

  function mark(reps,vrb){const s=$('sources');if(s){let c=s.querySelector('[data-taf-cloud-387]');if(!c){c=document.createElement('span');c.className='pill ok';c.dataset.tafCloud387='1';s.appendChild(c)}c.textContent='Chmury 3.8.7 ✓';let w=s.querySelector('[data-taf-vrb02]');if(!w){w=document.createElement('span');w.dataset.tafVrb02='1';s.appendChild(w)}w.className='pill '+(vrb?'ok':'');w.textContent=vrb?'VRB02 <=02KT / 75% ✓':'VRB02 —'}const b=$('reasons');if(!b)return;b.querySelectorAll('[data-taf-policy-reason]').forEach(x=>x.remove());let ul=b.querySelector('ul');if(!ul){ul=document.createElement('ul');b.appendChild(ul)}if(reps.length){const li=document.createElement('li');li.dataset.tafPolicyReason='cloud';li.textContent=`Chmury: 3.8.7 po sortowaniu wg podstawy — 1. warstwa dowolna, 2. >2/8, 3. >4/8; zwykłe chmury >=5000 ft pominięto.`;ul.appendChild(li)}if(vrb){const li=document.createElement('li');li.dataset.tafPolicyReason='vrb';li.textContent=`VRB02KT: ${vrb.count}/${vrb.total} godzin (${Math.round(vrb.share*100)}%) ma prędkość <=02KT. Kierunek modeli jest przy tej prędkości ignorowany; pozostałe wartości nie przekraczają ${vrb.max}KT.`;ul.appendChild(li)}}

  function apply(){if(applying)return;const el=$('taf'),cur=el?.textContent?.trim()||'';if(!/^TAF\s+(?:AMD\s+|COR\s+)?EPIR\b/.test(cur)||cur===lastOutput)return;const times=tafTimes(cur);if(!times)return;const series=getSeries(times);if(!series.length)return;const r=normalize(cur,series);mark(r.reps,r.vrb);if(!r.text||r.text===cur){lastOutput=cur;return}applying=true;el.textContent=r.text;lastOutput=r.text;applying=false}
  function schedule(){if(queued)return;queued=true;setTimeout(()=>{queued=false;apply()},40)}
  function install(){const el=$('taf');if(!el)return;new MutationObserver(schedule).observe(el,{childList:true,characterData:true,subtree:true});schedule()}
  window.PrognozaEPIRTAFGeneratorPolicy=Object.freeze({normalize,selectCloudTokens,dominantVrb02});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();