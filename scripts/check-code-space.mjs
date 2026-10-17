// Browser check (headless Chromium + stub API). Run: node scripts/check-code-space.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = createRequire(path.join(ROOT, 'sandbox-terminal') + '/')('playwright');
const root=path.join(ROOT, 'public'); const calls=[]; let orchN=0;
const sse=(res,reply)=>{ res.writeHead(200,{'content-type':'text/event-stream'}); res.write('data: '+JSON.stringify({type:'done',reply})+'\n\n'); setTimeout(()=>res.end(),150); };
const server=http.createServer((req,res)=>{ const u=req.url.split('?')[0];
 if(u.startsWith('/api/')){ let b=''; req.on('data',d=>b+=d); req.on('end',()=>{
  if(u==='/api/agent-chat'){ const j=JSON.parse(b); calls.push({orch:!!j.orchestrate,sys:String(j.systemPrompt||'')});
    if(j.orchestrate){ orchN++; if(orchN===1) return sse(res,"Plan's up — building the page.\n<<<BRIEF\nGoal: a hello page\nFiles: index.html\nBRIEF>>>\n<<<PLAN\n## Build\n- [ ] Write index.html\n- [ ] Style it\n## Ship\n- [ ] Deploy\nPLAN>>>"); return sse(res,"Noted."); }
    return sse(res,'File: index.html\n```html\n<!doctype html><h1>Hello</h1>\n```'); }
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({sandboxId:'sb1',sessionId:'sb1',ok:true,files:[],tree:[],results:[]})); }); return; }
 let f=path.join(root,u.endsWith('/')?u+'index.html':u); if(fs.existsSync(f)&&fs.statSync(f).isDirectory()) f=path.join(f,'index.html'); if(!fs.existsSync(f)){res.statusCode=404;return res.end();}
 const ext=path.extname(f); res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[ext]||'application/octet-stream'); res.end(fs.readFileSync(f)); }).listen(0);
const PORT=server.address().port; let fails=0; const check=(n,ok)=>{ console.log((ok?'ok  ':'FAIL')+' '+n); if(!ok) fails++; };
const b=await pw.chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/opt/pw-browsers/chromium',args:['--no-sandbox']});
const pg=await (await b.newContext({viewport:{width:1280,height:900}})).newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto('http://localhost:'+PORT+'/agent/'); await pg.waitForTimeout(3000);
const api=[]; pg.on('request',r=>{const u=r.url(); if(u.includes('/api/')&&!/keepalive|hub\/state|models|public-config/.test(u)) api.push(r.method()+' '+u.replace('http://localhost:'+PORT+'',''));});
await pg.locator('button:has-text("Start blank project"):visible').first().click(); await pg.waitForTimeout(2500);
check('blank project started', api.some(x=>x.includes('init-blank')));
const ta=pg.locator('[data-testid=chat-input]:visible').first();
await ta.fill('build me a hello page'); await pg.locator('button:has-text("Send"):visible').first().click(); await pg.waitForTimeout(5000);
const bi=pg.locator('button:has-text("Build it")').first();
check('brief card with "Build it" appeared', await bi.count()>0);
await bi.click(); await pg.waitForTimeout(6000);
check('coder was called and file written to the sandbox', api.some(x=>x.includes('write-files')));
check('coder file card shows index.html', (await pg.locator('text=index.html').count())>0);
check('pending-files bar offers Save', (await pg.locator('button:has-text("Save"):visible').count())>0);
const wf0=api.filter(x=>x.includes('write-files')).length;
await pg.locator('button:has-text("Save"):visible').last().click(); await pg.waitForTimeout(2500);
check('Save writes the file to the sandbox', api.filter(x=>x.includes('write-files')).length>wf0 || (await pg.locator('text=/1 file/').count())===0);
check('Code Space did not navigate away', new URL(pg.url()).pathname.startsWith('/agent'));
await pg.locator('text=PREVIEW >> visible=true').first().click(); await pg.waitForTimeout(1000);
await pg.screenshot({path:'csf2.png'});
const btns=await pg.locator('button:visible').allTextContents(); console.log('buttons now:', btns.map(x=>x.trim()).filter(Boolean).join(' | ').slice(0,300));
const sp=pg.locator('button:has-text("Start preview"):visible, button:has-text("Restart"):visible').first();
if (await sp.count()) { await sp.click(); await pg.waitForTimeout(3000); }
check('preview start request went out', api.some(x=>x.includes('preview-start')));
check('Settings opens', await (async()=>{ await pg.locator('button:has-text("⚙")').first().click().catch(()=>{}); await pg.waitForTimeout(500); return (await pg.locator('[role=dialog]:visible').count())>0; })());
check('no page errors', errs.length===0); if(errs.length) console.log(errs);
console.log(fails? `${fails} FAILED`:'all code space checks passed');
await b.close(); server.close();
