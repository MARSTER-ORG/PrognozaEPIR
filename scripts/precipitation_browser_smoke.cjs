'use strict';
// Local deterministic integration test of the built Pages artifact.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),base=process.env.PAGE_URL||'http://127.0.0.1:8765/';
const fixture=JSON.parse(fs.readFileSync(path.join(root,'data/runtime/models-latest.json')));
fixture.generated_at=new Date().toISOString();
for(const m of Object.values(fixture.models)){
 m.hourly.time=m.hourly.time.map((_,i)=>new Date(Math.floor(Date.now()/3600000)*3600000+i*3600000).toISOString().slice(0,16));
 m.hourly.precipitation=m.hourly.time.map(()=>.2);
 m.hourly.weather_code=m.hourly.time.map((_,i)=>[61,51,80,73,83,66,95][i%7]);
}
async function main(){
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const results=[];
 try{
  for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
   const page=await browser.newPage({viewport,isMobile:name==='mobile',hasTouch:name==='mobile'});const errors=[],missing=[];
   page.on('pageerror',e=>errors.push(e.message));
   page.on('response',r=>{if(new URL(r.url()).origin===new URL(base).origin&&r.status()>=400&&/\.(js|css|html|png)(\?|$)/.test(r.url()))missing.push(r.url());});
   // Fixtures preserve the full real model schema; block external services.
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin===new URL(base).origin)return route.continue();
    if(u.hostname==='raw.githubusercontent.com'){
     const rel=u.pathname.split('/main/')[1];const f=rel&&path.join(root,rel);
     if(rel==='data/runtime/models-latest.json')return route.fulfill({json:fixture});
     if(f&&fs.existsSync(f))return route.fulfill({path:f,contentType:'application/json'});
    }
    if(u.hostname==='api.open-meteo.com'){
     const snapshot=fixture;
     const m=snapshot.models[u.searchParams.get('models')]||Object.values(snapshot.models)[0];
     return route.fulfill({json:{...m,latitude:52.828611,longitude:18.330278}});
    }
    return route.fulfill({json:{},status:200});
   });
   await page.goto(base,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>typeof consensus!=='undefined'&&consensus.length>100&&
    window.__epirPrecipContinuityInstalled&&window.__epirPrecipIntelligenceInstalled,null,{timeout:30000});
   for(const h of [48,72,120]){
    await page.getByRole('button',{name:h+' h',exact:true}).click();
    const stats=await page.evaluate(()=>({rows:cv._meta.data.length,horizon,types:cv._meta.data.filter(z=>z.precipType).length,
     panel:cv._meta.panelYs.find(p=>p.id==='prec'),canvas:document.querySelector('canvas').getBoundingClientRect().toJSON()}));
    assert.equal(stats.horizon,h);assert.ok(stats.rows>=h-1);
    assert.ok(stats.panel.h>0&&stats.canvas.width>0);
    // Use actual DOM/canvas event coordinates for desktop and mobile taps.
    await page.locator('canvas').scrollIntoViewIfNeeded();
    // Coordinates can change after scroll, so compute them again.
    const target=await page.evaluate(()=>{const m=cv._meta,p=m.panelYs.find(p=>p.id==='prec'),r=cv.getBoundingClientRect();return{x:r.left+(m.x0+40)*r.width/m.W,y:r.top+(p.y+p.h*.5)*r.height/m.H};});
    if(name==='mobile')await page.touchscreen.tap(target.x,target.y);else await page.mouse.click(target.x,target.y);
    await page.waitForFunction(()=>document.querySelector('#sectionInfo')?.textContent.includes('Kod orientacyjny'));
    const info=await page.locator('#sectionInfo').innerText();
    assert.ok(!info.includes('undefined')&&!info.includes('NaN'));
    const perf=await page.evaluate(()=>{const a=performance.now();for(let k=0;k<15;k++)dataVisible();return(performance.now()-a)/15;});
    assert.ok(perf<500,'120h diagnostics must not block the UI for half a second');
    results.push({view:name,horizon:h,rows:stats.rows,diagnosticMeanMs:+perf.toFixed(2),tooltip:true});
   }
   // Missing profile/humidity and hazard input regressions through real APIs.
   const safety=await page.evaluate(()=>{
    const a=window.PrognozaEPIRPrecipIntelligence,t=window.PrognozaEPIRPrecipitation;
    const rows=cv._meta.data.slice(0,3).map(z=>({...z,profile:[],RH:null,precipType:{...t.TYPES.FZRA}}));
    a.refine(rows,t,Date.now());return rows.every(z=>z.precipType.code==='FZRA'&&!z.precipIntelligence);
   });
   assert.ok(safety);assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
   await page.close();
  }
  console.log(JSON.stringify({passed:true,fixtures:true,results},null,2));
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
