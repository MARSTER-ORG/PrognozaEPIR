// Run: node tests/icm-auto-fetch-controlled.test.mjs /path/to/user-provided-ICM-chart.webp
// One live HTTP GET to a local test server. It does NOT request meteo.pl.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {downloadAuthorizedImage} from '../supabase/functions/icm-vision-probe/authorized-source.mjs';

const path=process.argv[2];
if(!path)throw Error('Supply path to a locally authorized image (.webp)');
const original=await readFile(path);
if(original.length<100||original.subarray(0,4).toString()!=='RIFF'||original.subarray(8,12).toString()!=='WEBP')
 throw Error('Expected a real WebP image');
let requests=0;
const server=createServer((req,res)=>{
 requests++;
 if(req.url!=='/fixture.webp'||req.headers.authorization!=='Bearer test-token'){
  res.writeHead(403);res.end();return;
 }
 res.writeHead(200,{'content-type':'image/webp','content-length':original.length});
 res.end(original);
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
try {
 const config={approved:'true',url:'https://api.meteo.pl/authorized/fixture.webp',token:'test-token'};
 const localUrl='http://127.0.0.1:'+server.address().port+'/fixture.webp';
 const controlledFetch=async (url,options)=>{
  assert.equal(url,config.url);
  assert.equal(options.redirect,'error');
  return fetch(localUrl,options);
 };
 const extracted=await downloadAuthorizedImage(config,controlledFetch);
 assert.equal(extracted.mimeType,'image/webp');
 assert.equal(extracted.data.length,original.length);
 assert.equal(createHash('sha256').update(extracted.data).digest('hex'),
   createHash('sha256').update(original).digest('hex'));
 assert.equal(requests,1);
 await assert.rejects(downloadAuthorizedImage({...config,approved:'false'},controlledFetch),/icm_license_not_confirmed/);
 await assert.rejects(downloadAuthorizedImage({...config,url:'https://www.meteo.pl/um/x.webp'},controlledFetch),/icm_api_host_not_allowlisted/);
 assert.equal(requests,1);
 console.log(JSON.stringify({result:'PASS',source:'local controlled HTTP server',httpGets:requests,
  bytes:extracted.data.length,sha256Match:true,icmWebsiteContacted:false,geminiInvoked:false}));
} finally { server.close();await once(server,'close'); }
