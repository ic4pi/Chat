// Browser check (headless Chromium + stub API). Run: node scripts/check-plan-panel.mjs
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
const planBtn=pg.locator('button[title^="Build plan"]');
check('plan button is on the toolbar, empty at first', (await planBtn.textContent()).trim()==='☑');
await pg.locator('button:has-text("Start blank project"):visible').first().click(); await pg.waitForTimeout(2500);
const ta=pg.locator('[data-testid=chat-input]:visible').first();
await ta.fill('build me a hello page'); await ta.press('Control+Enter'); await pg.waitForTimeout(5000);
const body=await pg.locator('body').innerText();
check('persona bubble shows its words', body.includes("Plan's up"));
check('plan block is NOT shown in chat', !body.includes('<<<PLAN') && !body.includes('PLAN>>>') && !body.includes('- [ ] Write index.html'));
check('plan button now shows 0/3', (await planBtn.textContent()).includes('0/3'));
await planBtn.click(); await pg.waitForTimeout(500);
const dlg=pg.locator('[role=dialog]').last();
const dtxt=await dlg.innerText();
check('panel lists both milestones and all three steps', ['Build','Ship','Write index.html','Style it','Deploy'].every(x=>dtxt.includes(x)));
await dlg.locator('input[type=checkbox]').first().click(); await pg.waitForTimeout(300);
check('ticking a step moves the button to 1/3', (await planBtn.textContent()).includes('1/3'));
await pg.screenshot({path:'plan-open.png'});
await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
if (await pg.locator('[role=dialog]').count()) { await pg.locator('[role=dialog]').last().locator('button[aria-label*="lose"], button:has-text("×")').first().click().catch(()=>{}); }
await pg.waitForTimeout(300);
check('panel closes', (await pg.locator('[role=dialog]:visible').count())===0);
// next orchestrator turn must carry the plan state
await pg.waitForTimeout(1500);
const ta2=pg.locator('[data-testid=chat-input]:visible').first();
// a pending brief may be waiting for a builder pick: that's fine, the next message still goes to the persona
await ta2.fill('thanks, what next?'); await ta2.press('Control+Enter'); await pg.waitForTimeout(5000);
const orchCalls=calls.filter(c=>c.orch);
check('second orchestrator turn was sent', orchCalls.length>=2);
check('orchestrator is told the plan and its progress (1/3 done)', !!orchCalls[1] && orchCalls[1].sys.includes('BUILD PLAN (1/3 done'));
check('first orchestrator turn was told "none yet"', orchCalls[0].sys.includes('BUILD PLAN: none yet'));
// reload: plan persists for this session
await pg.reload(); await pg.waitForTimeout(3500);
const after=await pg.locator('button[title^="Build plan"]').textContent();
check('plan survives a reload', after.includes('1/3'));
check('no page errors', errs.length===0); if(errs.length) console.log(errs);
console.log(fails? `${fails} FAILED`:'all plan checks passed');
await b.close(); server.close();
