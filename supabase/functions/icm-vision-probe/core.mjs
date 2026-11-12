export const PARAMETERS={temperatureC:[-100,65],dewPointC:[-110,65],humidityPct:[0,100],cloudCoverPct:[0,100],cloudBaseM:[0,20000],windSpeedMs:[0,90],windDirectionDeg:[0,360],precipitationMmH:[0,300],visibilityM:[0,60000]};
export function imageMetadata(bytes,mime){
 if(!(bytes instanceof Uint8Array)||bytes.length<100||bytes.length>4000000)throw Error('invalid_image_size');
 const png=[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n);
 const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const webp=String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&String.fromCharCode(...bytes.subarray(8,12))==='WEBP';
 if(!({'image/png':png,'image/jpeg':jpeg,'image/webp':webp})[mime])throw Error('invalid_image_signature');
 return {mimeType:mime,byteLength:bytes.length};
}
export function normalize(raw){
 if(!raw||!Array.isArray(raw.rows)||raw.rows.length>96)throw Error('invalid_gemini_output');
 const flags=[],rows=[],seen=new Set(),basis=['UTC','LOCAL','UNKNOWN'].includes(raw.timeBasis)?raw.timeBasis:'UNKNOWN';
 const isUtc=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/.test(x)&&!Number.isNaN(Date.parse(x));
 for(let i=0;i<raw.rows.length;i++){
  const v=raw.rows[i];if(!v||typeof v!=='object')continue;
  const timestampUtc=basis==='UTC'&&isUtc(v.timestampUtc)?v.timestampUtc:null;
  if(timestampUtc&&seen.has(timestampUtc)){flags.push('duplicate_utc:'+i);continue;}
  if(timestampUtc)seen.add(timestampUtc);else flags.push('uncertain_time:'+i);
  const row={axisLabel:String(v.axisLabel??'').slice(0,50),timestampUtc,confidence:['high','medium','low'].includes(v.confidence)?v.confidence:'low',evidence:String(v.evidence??'').slice(0,200)};
  let useful=0;
  for(const [key,[min,max]] of Object.entries(PARAMETERS)){
   row[key]=typeof v[key]==='number'&&Number.isFinite(v[key])&&v[key]>=min&&v[key]<=max?v[key]:null;
   if(row[key]!==null)useful++;else if(v[key]!=null)flags.push('out_of_range:'+key+':'+i);
  }
  if(row.dewPointC!==null&&row.temperatureC!==null&&row.dewPointC>row.temperatureC+2)flags.push('dewpoint_inconsistent:'+i);
  // UM4 meteograms display total cloud cover in octas, NOT percentage.
  // A fraction read from the fog panel (0..1) must never become cloudCoverPct.
  if(/\\bUM4\\b/i.test(String(raw.modelLabel??''))&&row.cloudCoverPct!==null){
    row.cloudCoverPct=null;flags.push('cloud_cover_unit_not_pct:'+i);
  }
  // "Reading from n-th column" does not identify curve/color/unit or gust vs mean.
  if(/^Reading from (?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\\d+)/i.test(row.evidence)){
    row.confidence='low';flags.push('generic_evidence:'+i);
    if(row.windSpeedMs!==null){row.windSpeedMs=null;flags.push('wind_series_not_identified:'+i);}
  }
  if(useful)rows.push(row);
 }
 for(let i=1;i<rows.length;i++)if(rows[i].timestampUtc&&rows[i-1].timestampUtc&&rows[i].timestampUtc<=rows[i-1].timestampUtc)flags.push('time_not_ascending');
 // The full-ICM axis can label every 3h. Model output of every tick is not hourly.
 // Detect unsafe spacing even when UTC timestamps are unavailable.
 const asClock=label=>{const m=String(label).trim().match(/^(\\d{1,2})(?::00)?$/);const h=m?Number(m[1]):NaN;return h>=0&&h<24?h:null;};
 for(let i=1;i<rows.length;i++){
   const a=asClock(rows[i-1].axisLabel),b=asClock(rows[i].axisLabel);
   if(a!==null&&b!==null&&(b-a+24)%24!==1){flags.push('non_hourly_axis_step:'+i);}
   if(rows[i].timestampUtc&&rows[i-1].timestampUtc&&Date.parse(rows[i].timestampUtc)-Date.parse(rows[i-1].timestampUtc)!==3600000){flags.push('non_hourly_utc_step:'+i);}
 }
 if(!rows.length)flags.push('no_readable_values');
 return {schema:'prognozaepir-icm-vision-probe-v1',source:'ICM_MANUAL_IMAGE',isolated:true,consensusEnabled:false,tafEnabled:false,requiresHumanReview:true,timeBasis:basis,modelLabel:String(raw.modelLabel??'').slice(0,80),issueUtc:basis==='UTC'&&isUtc(raw.issueUtc)?raw.issueUtc:null,rows,flags:[...new Set(flags)]};
}
