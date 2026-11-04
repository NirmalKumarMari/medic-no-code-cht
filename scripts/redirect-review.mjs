import http from 'node:http';
const destination=process.env.REVIEW_HTTPS_URL;
if(!destination?.startsWith('https://'))throw Error('Set the authenticated HTTPS review URL');
for(const host of ['127.0.0.1',process.env.REVIEW_LAN_HOST].filter(Boolean)){
 http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'||req.url?.startsWith('/api/')){res.writeHead(410,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'The review UI moved to AWS. Reload the page to use the authenticated site.'}));return;}
  res.writeHead(302,{Location:destination});res.end('The review UI now uses the authenticated AWS site.');
 }).listen(5173,host,()=>console.log(`Review redirect listening on ${host}:5173`));
}
