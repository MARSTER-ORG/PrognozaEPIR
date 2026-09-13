'use strict';
const fs=require('fs');
const vm=require('vm');
const assert=require('assert');

(async()=>{
  let nativeCalls=0,latestCalls=0,recentCalls=0;
  const window={
    fetch:async()=>{nativeCalls++;return new Response(JSON.stringify({native:true}),{status:200,headers:{'Content-Type':'application/json'}})},
    PrognozaEPIRMessageArchive:{
      latest:async force=>{assert.strictEqual(force,true);latestCalls++;return {source:'live',kind:'latest'}},
      recent:async force=>{assert.strictEqual(force,true);recentCalls++;return {source:'live',kind:'recent'}}
    }
  };
  const context={window,location:{href:'https://example.test/index.html',origin:'https://example.test'},URL,Response,Request,Headers,console};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('message-archive-fetch-bridge.js','utf8'),context,{filename:'message-archive-fetch-bridge.js'});

  const latest=await window.fetch('data/messages/latest.json?v=1');
  assert.deepStrictEqual(await latest.json(),{source:'live',kind:'latest'});
  assert.strictEqual(latest.headers.get('X-PrognozaEPIR-Archive'),'MessageArchive-live-first');

  const recent=await window.fetch('/data/messages/recent.json?x=1');
  assert.deepStrictEqual(await recent.json(),{source:'live',kind:'recent'});

  const other=await window.fetch('https://example.test/data/other.json');
  assert.deepStrictEqual(await other.json(),{native:true});

  const foreign=await window.fetch('https://other.test/data/messages/latest.json');
  assert.deepStrictEqual(await foreign.json(),{native:true});

  assert.strictEqual(latestCalls,1);
  assert.strictEqual(recentCalls,1);
  assert.strictEqual(nativeCalls,2);
  console.log('message-archive-fetch-bridge: OK');
})().catch(err=>{console.error(err);process.exit(1)});
