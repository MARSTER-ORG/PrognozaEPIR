'use strict';
const assert=require('node:assert/strict');
const pa=require('../pressure-altitude.js');

function near(actual,expected,tolerance,message){
  assert.ok(Math.abs(actual-expected)<=tolerance,`${message}: ${actual} vs ${expected}`);
}

const standard=pa.calculate(1013.25,84.1248);
near(standard.pressureAltitudeFt,276,1e-8,'QNH 1013.25 must reproduce EPIR elevation');
near(standard.pressureAltitudeM,84.1248,1e-9,'QNH 1013.25 must reproduce EPIR elevation in metres');

near(pa.calculate(1000,84.1248).pressureAltitudeFt,639.103744989,0.001,'QNH 1000');
near(pa.calculate(1030,84.1248).pressureAltitudeFt,-177.555569109,0.001,'QNH 1030');
assert.throws(()=>pa.calculate(0,84.1248),/QNH/);
assert.throws(()=>pa.calculate('abc',84.1248),/QNH/);

console.log('pressure-altitude: OK');
