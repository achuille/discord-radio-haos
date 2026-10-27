import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, listen, permittedPeer } from '../src/server.mjs';
import { SettingsStore, readOptions } from '../src/settings.mjs';
import { createApplication } from '../src/application.mjs';
import { start } from '../src/index.mjs';

async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(),'radio-test-')); t.after(()=>rm(dir,{recursive:true,force:true})); return dir; }
async function serve(t,{dev=true, rateLimit, app}={}) {
  const dir = await temp(t); await writeFile(path.join(dir,'index.html'),'<h1>radio</h1>');
  const calls=[]; app ??= {status:()=>({configured:false,playback:{volume:0.6}}),control:async(...args)=>calls.push(args),addSource:async url=>({url}),removeSource:async()=>{},sync:()=>{}};
  const server=createServer({app,dev,rateLimit,publicDir:dir}); const address=await listen(server,{dev,port:0});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {base:`http://127.0.0.1:${address.port}`,calls};
}
test('peer trust ignores forwarded identity and normalizes IPv4',()=>{
  assert.equal(permittedPeer('::ffff:172.30.32.2'),true);
  for(const peer of ['127.0.0.1','172.30.32.3','192.168.1.2','::1','']) assert.equal(permittedPeer(peer),false);
  assert.equal(permittedPeer('127.0.0.1',{health:true}),true);
  assert.equal(permittedPeer('172.30.32.2',{dev:true}),false);
});
test('production denies UI/API from localhost but serves minimal health',async t=>{
  const {base}=await serve(t,{dev:false});
  for(const route of ['/','/api/status']) assert.equal((await fetch(base+route,{headers:{'x-forwarded-for':'172.30.32.2'}})).status,403);
  assert.deepEqual(await (await fetch(base+'/health')).json(),{ok:true});
});
test('CSRF, JSON limit, control validation, static path isolation',async t=>{
  const {base,calls}=await serve(t);
  const response=await fetch(base+'/api/status'); const {csrfToken}=await response.json();
  assert.equal(response.headers.get('access-control-allow-origin'),null); assert.match(response.headers.get('content-security-policy'),/default-src 'self'/);
  assert.equal((await fetch(base+'/api/control',{method:'POST',body:'{}'})).status,403);
  const headers={'content-type':'application/json','x-csrf-token':csrfToken};
  assert.equal((await fetch(base+'/api/control',{method:'POST',headers,body:JSON.stringify({action:'volume',value:4})})).status,400);
  assert.equal((await fetch(base+'/api/control',{method:'POST',headers,body:JSON.stringify({action:'volume',value:0.3})})).status,200);
  assert.deepEqual(calls,[['volume',0.3]]);
  assert.equal((await fetch(base+'/api/control',{method:'POST',headers,body:JSON.stringify({a:'x'.repeat(9000)})})).status,413);
  assert.equal((await fetch(base+'/settings.json')).status,404);
  const badHost = await new Promise(resolve => { http.get(base+'/api/status',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}); });
  assert.equal(badHost,403);
});
test('rate limiting bounds ingress request processing',async t=>{
  const {base}=await serve(t,{rateLimit:2});
  assert.equal((await fetch(base+'/api/status')).status,200);assert.equal((await fetch(base+'/api/status')).status,200);assert.equal((await fetch(base+'/api/status')).status,429);
});
test('private settings persist atomically without credentials',async t=>{
  const dir=await temp(t), file=path.join(dir,'settings.json');const store=new SettingsStore(file);await store.load();
  await store.save({volume:0.2,sources:[],token:'SECRET'});assert.equal((await stat(file)).mode & 0o777,0o600);
  assert.equal((await readFile(file,'utf8')).includes('SECRET'),false);
  const reload=new SettingsStore(file);await reload.load();assert.equal(reload.value.volume,0.2);
  await writeFile(path.join(dir,'options.json'),JSON.stringify({discord_token:'SECRET',guild_id:'1234567890123456',volume:0.3}));
  assert.equal((await readOptions(path.join(dir,'options.json'))).volume,0.3);
});
test('unconfigured actual startup serves setup UI and shuts down',async t=>{
  const dir=await temp(t);const runtime=await start({dataDir:dir,dev:true,port:0});t.after(()=>runtime.close());
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  assert.equal((await fetch(base+'/')).status,200);
  const status=await (await fetch(base+'/api/status')).json();assert.equal(status.configured,false);assert.equal(status.connection.state,'setup_required');assert.equal(status.playback.state,'stopped');
  assert.equal(JSON.stringify(status).includes(dir),false);
});
test('source imports serialize/coalesce and removed source is ineligible',async t=>{
  const dir=await temp(t);let imports=0, running=0,maxRunning=0;let release;
  const gate=new Promise(resolve=>{release=resolve;});let began;const started=new Promise(resolve=>{began=resolve;});
  const app=await createApplication({dataDir:dir,options:{volume:0.6,token:'',scanIntervalMs:1000,maxTrackMs:1000},adapter:{status:()=>({state:'disconnected'}),close:async()=>{}},importerFactory:({cacheDir})=>({async sync(){imports++;maxRunning=Math.max(maxRunning,++running);began();await gate;await mkdir(cacheDir,{recursive:true});await writeFile(path.join(cacheDir,'track.mp3'),'mock');running--;return {errors:[],tracks:[]};}})});
  t.after(()=>app.close());const source=await app.addSource('https://example.com/music.mp3');
  await started;app.sync(source.id);app.sync(source.id);const removal=app.removeSource(source.id);release();await removal;await app.close();
  await assert.rejects(stat(path.join(dir,'audio',source.id)),{code:'ENOENT'});
  assert.equal(maxRunning,1);assert.equal(imports,1);assert.deepEqual(app.status().sources,[]);assert.deepEqual(app.status().tracks,[]);
});
test('each playback retries connection and removal cancels pending connect before voice play',async t=>{
  const dir=await temp(t), id='0123456789abcdef01234567'; await mkdir(path.join(dir,'audio',id),{recursive:true});
  await writeFile(path.join(dir,'audio',id,'track.mp3'),'mock');
  const store=new SettingsStore(path.join(dir,'settings.json'));await store.save({volume:0.6,sources:[{id,url:'https://example.com/music.mp3',type:'direct'}]});
  let connectCalls=0,voicePlays=0,releaseConnect,firstAttempt;const pendingConnect=new Promise(resolve=>{releaseConnect=resolve;});
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const adapter={connect:()=>{connectCalls++;return connectCalls===1?Promise.reject(new Error('temporary outage')):pendingConnect;},play:async()=>{voicePlays++;},status:()=>({state:'reconnecting'}),close:async()=>{releaseConnect();}};
  const radio=async({play,signal,discover})=>{const tracks=await discover(null,{signal});if(tracks.length){firstAttempt=play(null,{track:tracks[0],signal}).catch(error=>error);started();await firstAttempt;}else await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});};
  const app=await createApplication({dataDir:dir,options:{volume:0.6,token:'SECRET',guildId:'1234567890123456',channelId:'1234567890123456',scanIntervalMs:1000,maxTrackMs:1000},adapter,radio,importerFactory:()=>({sync:async()=>({errors:[],tracks:[]})})});t.after(()=>app.close());await ready;
  assert.equal(app.status().playback.state,'connecting');assert.equal(app.status().playback.elapsed,0);
  await app.removeSource(id);assert.match((await firstAttempt).message,/playback_interrupted|aborted/i);releaseConnect();
  assert.equal(connectCalls,2);assert.equal(voicePlays,0);
});
