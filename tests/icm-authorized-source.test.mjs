import assert from 'node:assert/strict';
import {configuredSource,downloadAuthorizedImage} from '../supabase/functions/icm-vision-probe/authorized-source.mjs';
const authorized={approved:'true',url:'https://api.meteo.pl/authorized/meteogram.png',token:'fixture-token'};
assert.equal(configuredSource(authorized).hostname,'api.meteo.pl');
assert.throws(()=>configuredSource({...authorized,approved:'false'}),/license/);
assert.throws(()=>configuredSource({...authorized,url:'https://app.meteo.pl/chart.png'}),/allowlisted/);
assert.throws(()=>configuredSource({...authorized,url:'http://api.meteo.pl/chart.png'}),/invalid_provider_url/);
assert.throws(()=>configuredSource({...authorized,url:'https://127.0.0.1/private'}),/allowlisted/);
assert.throws(()=>configuredSource({...authorized,token:''}),/token_missing/);
const bytes=new Uint8Array(150);bytes.set([137,80,78,71,13,10,26,10]);
let calls=0;
const mocked=async (url,opts)=>{
 calls++;assert.equal(url,authorized.url);assert.equal(opts.redirect,'error');assert.equal(opts.headers.authorization,'Bearer fixture-token');
 return new Response(bytes,{headers:{'content-type':'image/png'}});
};
const ok=await downloadAuthorizedImage(authorized,mocked);
assert.equal(ok.data.length,150);assert.equal(calls,1);
await assert.rejects(downloadAuthorizedImage(authorized,async()=>new Response('<html></html>',{headers:{'content-type':'text/html'}})),/non_image/);
console.log('Authorized ICM image fetch adapter: 8 checks PASS (mocked, no network)');
