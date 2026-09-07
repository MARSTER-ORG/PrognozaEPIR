from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old_error = "const msg=j?.error||j?.reason||j?.message||('HTTP '+r.status);"
new_error = "const msg=j?.reason||j?.message||(typeof j?.error==='string'?j.error:('HTTP '+r.status));"
if old_error in s:
    s = s.replace(old_error, new_error, 1)

old_req = """async function req(model,prof=false){
  const vars=prof?profileVarsFor(model):SURFACE;
  const q=new URLSearchParams({latitude:PLACE.lat,longitude:PLACE.lon,hourly:vars.join(','),models:model.id,timezone:'UTC',forecast_days:'6',wind_speed_unit:'ms'});
  return await fetchJSON('https://api.open-meteo.com/v1/forecast?'+q,prof?16000:12000)
}"""
new_req = """async function reqVars(model,vars,timeoutMs){
  const q=new URLSearchParams({latitude:PLACE.lat,longitude:PLACE.lon,hourly:vars.join(','),models:model.id,timezone:'UTC',forecast_days:'6',wind_speed_unit:'ms'});
  return await fetchJSON('https://api.open-meteo.com/v1/forecast?'+q,timeoutMs)
}
async function req(model,prof=false){
  let vars=(prof?profileVarsFor(model):SURFACE).filter(v=>!(model.surfaceExclude||[]).includes(v));
  if(prof)return await reqVars(model,vars,16000);
  let last=null;
  for(let attempt=0;attempt<5&&vars.length;attempt++){
    try{return await reqVars(model,vars,12000)}catch(e){
      last=e;
      const msg=String(e?.message||e||'');
      const bad=vars.find(v=>msg.includes(v));
      if(!bad)break;
      vars=vars.filter(v=>v!==bad);
    }
  }
  const safe=['temperature_2m','relative_humidity_2m','precipitation','wind_speed_10m','wind_direction_10m'].filter(v=>!(model.surfaceExclude||[]).includes(v));
  try{return await reqVars(model,safe,12000)}catch(e){throw last||e}
}"""
if old_req not in s and 'async function reqVars(model,vars,timeoutMs)' not in s:
    raise SystemExit('req() source block not found')
if old_req in s:
    s = s.replace(old_req, new_req, 1)

old_load = """async function load(){setBadge('ŁADOWANIE','');failures=[];datasets.clear();demo=false;try{const res=await Promise.allSettled(MODELS.map(fetchModel));res.forEach((r,i)=>{const m=MODELS[i];if(r.status==='fulfilled')datasets.set(m.id,r.value);else failures.push(m.name+': '+(r.reason?.message||r.reason))});if(datasets.size<3){setBadge('BRAK DANYCH','');$('errors').style.display='block';$('errors').textContent='Nie udało się pobrać wystarczającej liczby modeli z Open-Meteo. Spróbuj ponownie za chwilę.';return}compute();populateView();render()}catch(e){setBadge('BŁĄD','');$('errors').style.display='block';$('errors').textContent='Błąd programu: '+(e?.message||e);console.error(e)}}"""
new_load = """async function load(){setBadge('ŁADOWANIE','');failures=[];datasets.clear();demo=false;populateView();try{const res=await Promise.allSettled(MODELS.map(fetchModel));res.forEach((r,i)=>{const m=MODELS[i];if(r.status==='fulfilled')datasets.set(m.id,r.value);else failures.push(m.name+': '+(r.reason?.message||r.reason))});populateView();if(!datasets.size){setBadge('BRAK DANYCH','');$('errors').style.display='block';$('errors').textContent='Nie udało się pobrać żadnego modelu z Open-Meteo. Spróbuj ponownie za chwilę.';return}compute();render()}catch(e){populateView();setBadge('BŁĄD','');$('errors').style.display='block';$('errors').textContent='Błąd programu: '+(e?.message||e);console.error(e)}}"""
if old_load not in s and 'demo=false;populateView();try{' not in s:
    raise SystemExit('load() source block not found')
if old_load in s:
    s = s.replace(old_load, new_load, 1)

p.write_text(s, encoding='utf-8')
