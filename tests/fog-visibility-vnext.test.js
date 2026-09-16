'use strict';
const assert=require('assert');
const V=require('../fog-visibility-vnext.js');

const strong=V.evaluate({
  score:86,vis:650,vis1500:92,vis1000:84,vis500:55,vis200:20,sat:96,confidence:.8,dmiFog:88,lead:5,
  models:[{VIS:400},{VIS:550},{VIS:700},{VIS:900},{VIS:1200}]
},{score:86,saturation:96,directFog:88,leadHours:5,phase:'mature'});
assert(Number.isFinite(strong.point));
assert(strong.point<1000);
assert(strong.low<=strong.point&&strong.point<=strong.high);
assert(strong.p1500>=strong.p1000&&strong.p1000>=strong.p500&&strong.p500>=strong.p200);
assert(strong.confidence>.5);

const weak=V.evaluate({
  score:32,vis:9000,vis1500:5,vis1000:2,vis500:1,vis200:0,sat:45,confidence:.75,lead:8,
  models:[{VIS:7000},{VIS:8500},{VIS:9000},{VIS:10000},{VIS:12000}]
},{score:32,saturation:45,leadHours:8,phase:'pre-onset'});
assert(weak.point>=7000);
assert(weak.p1000<25);

const fallback=V.evaluate({score:68,vis:1200,vis1000:45,sat:90,confidence:.4,models:[]},{score:68,saturation:90,leadHours:10});
assert(Number.isFinite(fallback.point));
assert(Number.isFinite(fallback.low)&&Number.isFinite(fallback.high));

const tight=V.evaluate({score:70,vis:850,confidence:.7,models:[{VIS:700},{VIS:800},{VIS:900},{VIS:950},{VIS:1000}]},{score:70,saturation:92,leadHours:6});
const wide=V.evaluate({score:70,vis:850,confidence:.7,models:[{VIS:150},{VIS:350},{VIS:900},{VIS:3000},{VIS:9000}]},{score:70,saturation:92,leadHours:6});
assert(tight.confidence>wide.confidence);

const event=V.eventSummary([
  {t:1,visGuidance:{point:800,low:500,high:1300,p1500:70,p1000:55,p500:20,p200:5,confidence:.7}},
  {t:2,visGuidance:{point:400,low:250,high:800,p1500:90,p1000:80,p500:60,p200:20,confidence:.65}}
]);
assert.strictEqual(event.minimum,400);
assert.strictEqual(event.minimumTime,2);
assert.strictEqual(event.p500,60);
console.log('fog-visibility-vnext: ok');
