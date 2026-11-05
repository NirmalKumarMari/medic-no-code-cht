import http from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { resolve,sep,extname } from 'node:path';
const root=resolve(process.env.REVIEW_UI_DIR??'mvp-prototype/dist');
const base=process.env.REVIEW_UI_BASE??'/';
const host=process.env.REVIEW_UI_HOST??'127.0.0.1';
const port=Number(process.env.REVIEW_UI_PORT??5173);
const api=new URL(process.env.REVIEW_API_TARGET??'http://127.0.0.1:3003');
if(!['127.0.0.1','localhost'].includes(api.hostname)||api.protocol!=='http:')throw Error('The review worker must be a loopback HTTP endpoint');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(!url.pathname.startsWith(base)){res.writeHead(404);return res.end('Not found');}
  const path=url.pathname.slice(base.length);
  if(path==='api'||path.startsWith('api/')){
   const target='/'+path+url.search;
   const upstream=http.request(api.origin+target,{method:req.method,headers:{...req.headers,host:api.host}},response=>{res.writeHead(response.statusCode??502,{...response.headers,'cache-control':'no-store'});response.pipe(res);});
   upstream.setTimeout(65_000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'The review service is unavailable. No operation has been confirmed.'}));});req.pipe(upstream);return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
  let file=resolve(root,decodeURIComponent(path||'index.html'));
  if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);return res.end();}
  try{if(!(await stat(file)).isFile())file=resolve(root,'index.html');}catch{file=resolve(root,'index.html');}
  const bytes=await readFile(file);res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'same-origin','cache-control':extname(file)==='.html'?'no-store':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch{res.writeHead(500);res.end('The review UI could not be loaded.');}
}).listen(port,host,()=>console.log(`Review UI listening on ${host}:${port}${base}`));
