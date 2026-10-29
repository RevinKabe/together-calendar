// Local-only UI test server. This file and its fixture are not deployed to Pages.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root=resolve('site');
http.createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    let body,type;
    if(path==='/__fixture.js'){body=await readFile('tests/browser-fixture.js');type='text/javascript';}
    else {
      const file=resolve(root,'.'+decodeURIComponent(path).replace(/\/$/,'/index.html'));
      if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
      body=await readFile(file);type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
      if(extname(file)==='.html')body=body.toString().replace('<script src="./config.js" defer></script>','').replace('<script src="./vendor/supabase.js" defer></script>','<script src="/__fixture.js" defer></script>');
    }
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(404).end('Not found');}
}).listen(4180,'127.0.0.1',()=>console.log('Fixture: http://127.0.0.1:4180 (fake accounts; no external network)'));
