'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const api=require('../meteogram-precip-compact-info.js');
const labels=['Opad','Wilgotność','Modele z opadem','Próg opadu',
  'Rodzaj','Kod orientacyjny','Inne warianty','TCu / Cb (wskaźnik NWP)'];
const z={RR:.23,RH:94,wet:93,
  precipType:{code:'VAR',label:'Deszcz lub śnieg — modele niezgodne (nie RASN)',
    alternatives:'DZ 35%, SG 15%, RA 13%',phaseAgreementPct:52,
    agreementPct:37,supportPct:93},
  precipEvidence:{convectionAvailable:true,tcu:19,cb:15,ts:0,
    models:3,agreement:100,showerModelSupport:0},
  precipCloudContext:{regime:'undetermined',changed:false}};
const rows=api.rows(z);
assert.deepEqual(rows.map(x=>x[0]),labels);
assert.equal(rows[0][1],'0.23 mm/h');
assert.equal(rows[1][1],'94%');
assert.equal(rows[2][1],'93%');
assert.equal(rows[3][1],'≥ 0.1 mm/h');
assert.equal(rows[4][1],z.precipType.label);
assert.equal(rows[5][1],'VAR');
assert.equal(rows[6][1],'DZ 35%, SG 15%, RA 13%');
assert.equal(rows[7][1],'TCu 19% · Cb 15% · TS 0%');
for(const forbidden of ['Zgodność fazy opadu','Zgodność charakteru','Zgodność kodu szczegółowego',
  'Modele wskazujące rodzaj opadu','Podstawa klasyfikacji','Zgodność modeli konwekcji',
  'Modele wskazujące opad przelotny','Interpretacja','Układ chmur — interpretacja'])
  assert.ok(!rows.some(x=>x[0]===forbidden),'hide '+forbidden);
const noWx=api.rows({RR:0,RH:78,wet:0});
assert.deepEqual(noWx.map(x=>x[0]),labels.slice(0,6));
assert.equal(noWx[4][1],'Nie stwierdzono / brak danych o rodzaju');
assert.equal(noWx[5][1],'—');
assert.equal(api.rows({RR:null,RH:null,wet:null})[0][1],'— mm/h');
assert.equal(api.rows({RR:0.2,RH:90,wet:95,precipType:{code:'RA',
  temporalAdjusted:true}})[5][1],'RA*');
assert.equal(api.rows({RR:0.2,RH:90,wet:95,precipType:{code:'DZ',
  intelligenceAdjusted:true}})[5][1],'DZ*');
assert.equal(api.rows({RR:0.2,RH:90,wet:95,precipEvidence:{convectionAvailable:false}})
  .some(x=>x[0]==='TCu / Cb (wskaźnik NWP)'),false);
assert.deepEqual(api.rows(null),[]);

const source=fs.readFileSync(path.join(root,'meteogram-precip-compact-info.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const build=fs.readFileSync(path.join(root,'scripts/prepare_pages.py'),'utf8');
const hover=fs.readFileSync(path.join(root,'visual-style-fix.js'),'utf8');
for(const page of [html,build]){
  const last=page.indexOf('meteogram-precip-compact-info.js');
  assert.ok(last>page.indexOf('meteogram-precipitation-continuity.js'),
    'compact UI installed after precipitation diagnostics');
  assert.ok(last>page.indexOf('convection-horizon-12h.js'),
    'compact UI must be the final precip-specific wrapper');
}
assert.match(hover,/PrognozaEPIRPrecipCompactInfo\?\.rows\(z\)/);
assert.doesNotMatch(hover,/PrognozaEPIRPrecipitation\?\.tooltipRows\(z\)/,
  'desktop hover must not leak verbose precipitation rows');

class Node{
  constructor(){this.children=[];this.textContent='';this.className='';this.removed=false;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  remove(){this.removed=true;}
}
const holder=new Node(),help=new Node();
const title=new Node();title.textContent='Opad / wilgotność · 00 UTC';
const box={
  querySelector(selector){
    return selector==='.section-values'?holder:selector==='.section-help'?help:null;
  }
};
const doc={createElement(){return new Node();},getElementById(id){
  return id==='sectionInfo'?box:null;
}};
const context={document:doc,z,visits:[]};
vm.runInNewContext('function showSectionInfo(z,panelId){visits.push(panelId);'+
  'const holder=document.getElementById("sectionInfo").querySelector(".section-values");'+
  'holder.replaceChildren({textContent:"ORIGINAL"},'+
  '{textContent:"Zgodność fazy opadu"},'+
  '{textContent:"Podstawa klasyfikacji"});return 77;}\n'+source,context);
const result=context.showSectionInfo(z,'prec');
assert.equal(result,77);
assert.equal(context.visits[0],'prec');
assert.deepEqual(holder.children.map(child=>child.children[0].textContent),labels);
assert.deepEqual(holder.children.map(child=>child.children[1].textContent),rows.map(x=>x[1]));
assert.equal(help.removed,true,'verbose precip footnote hidden');
assert.equal(title.textContent,'Opad / wilgotność · 00 UTC','heading and time unchanged');
assert.equal(context.showSectionInfo(z,'temp'),77);
assert.deepEqual(holder.children.map(child=>child.textContent),[
  'ORIGINAL','Zgodność fazy opadu','Podstawa klasyfikacji'],
  'other sections unaffected');
context.showSectionInfo(z,'prec');
assert.equal(holder.children.length,8,'repeat click must not accumulate cards');
assert.deepEqual(context.visits,['prec','temp','prec']);
console.log('Compact precip card: exact 8 labels, conditional optional rows, browser wrapper, hover and no backend mutation PASS');
