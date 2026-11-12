// Only authorized ICM API image URLs. Never fetch app.meteo.pl or meteo.pl HTML.
export function configuredSource(config){
 if(config.approved!=='true')throw Error('icm_license_not_confirmed');
 if(!config.url)throw Error('icm_authorized_image_url_missing');
 let url;try{url=new URL(config.url);}catch(_){throw Error('invalid_provider_url');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('invalid_provider_url');
 if(url.hostname!=='api.meteo.pl'||url.port)throw Error('icm_api_host_not_allowlisted');
 if(!config.token||!String(config.token).trim())throw Error('icm_api_token_missing');
 return url;
}
export async function downloadAuthorizedImage(config,fetchImpl=fetch){
 const url=configuredSource(config);
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),18000);
 try{
  const response=await fetchImpl(url.toString(),{
   method:'GET',redirect:'error',signal:controller.signal,
   headers:{authorization:'Bearer '+config.token,'accept':'image/png, image/jpeg, image/webp'}
  });
  if(!response.ok)throw Error('provider_http_'+response.status);
  const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['image/png','image/jpeg','image/webp'].includes(type))throw Error('provider_returned_non_image');
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>4_000_000)throw Error('provider_image_too_large');
  const data=new Uint8Array(await response.arrayBuffer());
  if(data.length>4_000_000||data.length<100)throw Error('provider_image_size');
  return {data,mimeType:type};
 }finally{clearTimeout(timeout);}
}
