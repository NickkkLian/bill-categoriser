/* Dependency-free CDP harness. Start an approved loopback-only headless Chrome first.
   Usage: BROWSER_URL=http://127.0.0.1:9333 node tests/check-ui.mjs <served docs URL> */
import fs from 'node:fs/promises';
export async function browserPage(url) {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('Tests require 127.0.0.1');
  const endpoint=process.env.BROWSER_URL || 'http://127.0.0.1:9333';
  if (new URL(endpoint).hostname !== '127.0.0.1') throw new Error('CDP requires 127.0.0.1');
  const version=await (await fetch(endpoint + '/json/version')).json();
  async function connect(wsUrl) {
    const ws=new WebSocket(wsUrl), pending=new Map(); let next=0;
    const handlers=new Map();
    ws.onmessage=e=>{ const m=JSON.parse(e.data); if(m.id) {const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} else handlers.get(m.method)?.(m.params); };
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    return {send(method,params={}){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});},on(method,fn){handlers.set(method,fn);},close(){ws.close();}};
  }
  const browser=await connect(version.webSocketDebuggerUrl);
  const context=await browser.send('Target.createBrowserContext');
  const target=await browser.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});
  const list=await (await fetch(endpoint+'/json/list')).json();
  const c=await connect(list.find(t=>t.id===target.targetId).webSocketDebuggerUrl);
  const errors=[];
  await c.send('Runtime.enable');
  c.on('Runtime.exceptionThrown',p=>errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  await c.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  c.on('Fetch.requestPaused',async p=>{
    const local=new URL(p.request.url).hostname==='127.0.0.1';
    await c.send(local?'Fetch.continueRequest':'Fetch.failRequest',local?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'});
  });
  const evaluate=async expression=>{
    const r=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor=async expression=>{
    for(let i=0;i<200;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}
    throw new Error('Timed out: '+expression);
  };
  const size=async(width,height)=>{
    await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});
    await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  };
  const navigate=async dest=>{
    if(new URL(dest).hostname!=='127.0.0.1') throw new Error('Only loopback pages allowed');
    await c.send('Page.navigate',{url:dest});
    await waitFor("document.documentElement.dataset.ready === 'true'");
    await evaluate('document.fonts.ready.then(()=>true)');
  };
  const screenshot=async path=>{
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path,Buffer.from(r.data,'base64'));
  };
  const close=async()=>{await browser.send('Target.disposeBrowserContext',context);c.close();browser.close();};
  await size(1230,690);await navigate(url);
  return {evaluate,waitFor,size,navigate,screenshot,close,errors};
}

