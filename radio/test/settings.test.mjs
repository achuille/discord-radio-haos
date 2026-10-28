import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, readOptions, parseOptions, migrateNativeOptions, resolveSettings } from '../src/settings.mjs';
import { createApplication } from '../src/application.mjs';
import { start } from '../src/index.mjs';

const url = 'https://example.com/music.mp3';
const source = {id:'0123456789abcdef01234567',url,type:'direct'};
async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(),'radio-native-')); t.after(() => rm(dir,{recursive:true,force:true})); return dir; }
async function legacy(t) { const dir = await temp(t); const store = new SettingsStore(path.join(dir,'settings.json')); await store.save({volume:0.2,sources:[source]}); return {dir,store}; }
function supervisor(options, {failPost = false, mismatch = false} = {}) {
  let saved = {...options}; const calls = [];
  return {calls, get saved() { return saved; }, request:async (address,init) => {
    calls.push({address,...init}); assert.equal(new URL(address).origin,'http://supervisor'); assert.equal(init.redirect,'error'); assert.ok(init.signal); assert.equal(init.headers.authorization,'Bearer INTERNAL_SECRET');
    if (init.method === 'POST') {
      if (failPost) throw new Error('INTERNAL_SECRET must never be logged');
      saved = JSON.parse(init.body).options;
      if (mismatch) saved.volume = 0.9;
      return Response.json({result:'ok',data:{}});
    }
    return Response.json({result:'ok',data:{options:saved}});
  }};
}
const migrateWith = mock => (value,context) => migrateNativeOptions(value,{token:'INTERNAL_SECRET',request:mock.request,...context});

test('native options distinguish omitted/empty sources and validate bounded configuration',() => {
  assert.equal(parseOptions({}).sources,undefined); assert.deepEqual(parseOptions({sources:[]}).sources,[]);
  assert.deepEqual(parseOptions({sources:[url,url]}).sources,[url]); assert.equal(parseOptions({playback_enabled:false}).playbackEnabled,false);
  for (const input of [{sources:null},{sources:['http://127.0.0.1/music.mp3']},{sources:['https://user:pass@example.com/a']},{sources:[url.repeat(100)]},{sources:Array(21).fill(url)},{volume:2},{playback_enabled:'false'},{scan_interval_seconds:1},{sync_interval_seconds:59},{max_track_seconds:1},{guild_id:'1'},{discord_token:4}]) assert.throws(() => parseOptions(input));
});
test('private settings persist atomically without credentials; reject oversized/symlink inputs',async t => {
  const dir = await temp(t), file = path.join(dir,'settings.json'); const store = new SettingsStore(file);
  await store.save({volume:0.2,sources:[],token:'SECRET'}); assert.equal((await stat(file)).mode & 0o777,0o600); assert.equal((await readFile(file,'utf8')).includes('SECRET'),false);
  const reload = new SettingsStore(file); await reload.load(); assert.equal(reload.value.volume,0.2);
  await writeFile(path.join(dir,'options.json'),JSON.stringify({discord_token:'SECRET',guild_id:'12345678901234567',volume:0.3}));
  assert.equal((await readOptions(path.join(dir,'options.json'))).volume,0.3);
  await symlink(path.join(dir,'options.json'),path.join(dir,'link.json')); await assert.rejects(readOptions(path.join(dir,'link.json')));
  await writeFile(path.join(dir,'large.json'),' '.repeat(128*1024+1)); await assert.rejects(readOptions(path.join(dir,'large.json')));
});
test('legacy migration saves native options, keeps secret references and IDs, and is restart-idempotent',async t => {
  const {dir,store} = await legacy(t); const mock = supervisor({discord_token:'!secret radio_token',guild_id:'12345678901234567',volume:0.6,auth_mode:'selfbot',playback_enabled:false});
  const logs = []; const result = await resolveSettings(store,parseOptions({volume:0.6}),{migrate:migrateWith(mock),log:text => logs.push(text)});
  assert.equal(result.volume,0.2); assert.deepEqual(result.sources,[source]); assert.equal(result.nativeConfiguration,true);
  assert.equal(mock.saved.discord_token,'!secret radio_token'); assert.equal(mock.saved.playback_enabled,false); assert.equal(mock.saved.guild_id,'12345678901234567'); assert.deepEqual(mock.saved.sources,[url]);
  assert.equal(mock.calls.length,3); assert.equal(logs.some(line => line.includes(url) || line.includes('SECRET')),false);
  const again = await resolveSettings(new SettingsStore(path.join(dir,'settings.json')),parseOptions(mock.saved),{migrate:() => { throw new Error('Must not migrate twice'); }});
  assert.deepEqual(again,result); assert.equal((await readFile(store.file,'utf8')).includes('token'),false);
});
test('migration failure or unconfirmed readback never overwrites legacy sources or effective volume',async t => {
  for (const failure of [{failPost:true},{mismatch:true}]) {
    const {store} = await legacy(t), original = await readFile(store.file,'utf8');
    const result = await resolveSettings(store,parseOptions({volume:0.6}),{migrate:migrateWith(supervisor({volume:0.6},failure))});
    assert.equal(result.volume,0.2); assert.deepEqual(result.sources,[source]); assert.equal(result.nativeConfiguration,undefined); assert.equal(await readFile(store.file,'utf8'),original);
  }
  assert.equal(await migrateNativeOptions({volume:0.2,sources:[source]},{token:''}),null);
});
test('explicit empty native sources wins and old cache is not silently deleted',async t => {
  const {dir,store} = await legacy(t); const cache = path.join(dir,'audio',source.id); await mkdir(cache,{recursive:true}); await writeFile(path.join(cache,'track.mp3'),'old-audio');
  const result = await resolveSettings(store,parseOptions({sources:[],volume:0.7}),{migrate:() => { throw new Error('Native choices must not be migrated'); }});
  assert.deepEqual(result.sources,[]); assert.equal(result.volume,0.7); assert.equal(await readFile(path.join(cache,'track.mp3'),'utf8'),'old-audio');
});
test('new native choices observed at Supervisor win over stale startup options',async t => {
  const {store} = await legacy(t); const mock = supervisor({sources:[],volume:0.8});
  const result = await resolveSettings(store,parseOptions({volume:0.6}),{migrate:migrateWith(mock)});
  assert.deepEqual(result.sources,[]); assert.equal(result.volume,0.8); assert.equal(mock.calls.length,1);
});
test('a volume edited after startup is preserved when only sources require migration',async t => {
  const {store} = await legacy(t); const mock = supervisor({volume:0.8});
  const result = await resolveSettings(store,parseOptions({volume:0.6}),{migrate:migrateWith(mock)});
  assert.equal(result.volume,0.8); assert.equal(mock.saved.volume,0.8);
});
test('legacy fallback retries migration on later restart, never in a background loop',async t => {
  const {dir,store} = await legacy(t); let attempts = 0;
  await resolveSettings(store,parseOptions({}),{migrate:async () => { attempts++; return null; }});
  assert.equal(attempts,1);
  const mock = supervisor({volume:0.6});
  const result = await resolveSettings(new SettingsStore(path.join(dir,'settings.json')),parseOptions({}),{migrate:migrateWith(mock)});
  assert.equal(result.nativeConfiguration,true); assert.equal(result.volume,0.2);
});
test('actual unconfigured worker has no HTTP server and closes cleanly',async t => {
  const dir = await temp(t); const runtime = await start({dataDir:dir,log:() => {}}); t.after(() => runtime.close());
  assert.equal(runtime.server,undefined); assert.equal(runtime.app.status().configured,false); assert.equal(runtime.app.status().connection.state,'setup_required');
  assert.equal(runtime.app.status().playback.state,'stopped'); assert.equal(JSON.stringify(runtime.app.status()).includes(dir),false);
  await runtime.close(); await runtime.close();
});
test('disabled playback imports native sources without connecting, decoding, or losing cached state',async t => {
  const dir = await temp(t); let imports = 0, connects = 0, radioCalls = 0; let imported; const done = new Promise(resolve => { imported = resolve; });
  const app = await createApplication({dataDir:dir,options:{...parseOptions({sources:[url],playback_enabled:false}),token:'SECRET',guildId:'12345678901234567',channelId:'12345678901234567'},adapter:{connect:() => {connects++;},status:() => ({state:'disconnected'}),close:async () => {}},radio:async () => {radioCalls++;},importerFactory:() => ({sync:async (_sources,options) => {imports++; assert.equal(options.refreshDirect,true); imported(); return {errors:[]};}})}); t.after(() => app.close());
  await done; assert.equal(imports,1); assert.equal(connects,0); assert.equal(radioCalls,0); assert.equal(app.status().sources.length,1); assert.equal(app.status().playback.state,'stopped');
});
test('native source imports serialize and repeated synchronization coalesces',async t => {
  const dir = await temp(t); let imports = 0, running = 0, maxRunning = 0, release, began;
  const gate = new Promise(resolve => {release = resolve;}); const started = new Promise(resolve => {began = resolve;});
  const app = await createApplication({dataDir:dir,options:parseOptions({sources:[url]}),adapter:{status:() => ({state:'disconnected'}),close:async () => {}},importerFactory:() => ({async sync() { imports++; maxRunning = Math.max(maxRunning,++running); began(); await gate; running--; return {errors:[]}; }})}); t.after(() => app.close());
  await started; app.sync(); app.sync(); release(); await app.close(); assert.equal(maxRunning,1); assert.equal(imports,1);
});
test('shutdown aborts preparation before voice play and reports the actual moved channel',async t => {
  const {dir} = await legacy(t); const cache = path.join(dir,'audio',source.id); await mkdir(cache,{recursive:true}); await writeFile(path.join(cache,'track.mp3'),'mock');
  let connects = 0, plays = 0, began, outcome; const started = new Promise(resolve => {began = resolve;});
  const adapter = {connect:() => {connects++; return new Promise(() => {});},play:async () => {plays++;},status:() => ({state:'reconnecting',channelId:'23456789012345678'}),close:async () => {}};
  const radio = async ({prepare,play,signal,discover}) => { const tracks = await discover(null,{signal}); outcome = prepare({track:tracks[0],signal}).catch(error => error); began(); const result = await outcome; if (!(result instanceof Error)) await play(null,{track:tracks[0],signal}); };
  const app = await createApplication({dataDir:dir,options:{...parseOptions({}),token:'SECRET',guildId:'12345678901234567',channelId:'12345678901234567'},adapter,radio,migrate:async () => null,importerFactory:() => ({sync:async () => ({errors:[]})})}); t.after(() => app.close());
  await started; assert.equal(app.status().playback.state,'connecting'); assert.equal(app.status().playback.elapsed,0); assert.equal(app.status().connection.channel,'23456789012345678'); await app.close();
  assert.match((await outcome).message,/interrupted|aborted/i); assert.equal(connects,1); assert.equal(plays,0);
});

test('worker log messages are fixed and deduplicated, never raw errors, paths or source URLs',async t => {
  const dir = await temp(t), logs = []; let reported; const done = new Promise(resolve => {reported = resolve;});
  const app = await createApplication({dataDir:dir,options:{...parseOptions({}),token:'SECRET',guildId:'12345678901234567',channelId:'12345678901234567'},adapter:{status:() => ({state:'connected'}),close:async () => {}},log:text => logs.push(text),radio:async ({log,signal}) => {
    for (let i = 0; i < 4; i++) { log('waiting',{message:'SECRET',track:url}); log('track-error',{message:'SECRET',track:dir}); }
    log('unknown-secret-event',{message:'SECRET'}); reported(); await new Promise(resolve => {signal.addEventListener('abort',resolve,{once:true}); if(signal.aborted)resolve();});
  }}); t.after(() => app.close()); await done;
  assert.equal(logs.filter(line => line.includes('Waiting for playable')).length,1); assert.equal(logs.filter(line => line.includes('audio file failed')).length,1);
  assert.equal(logs.some(line => line.includes('SECRET') || line.includes(url) || line.includes(dir)),false);
});
test('unexpected radio failure is reported without details and not silently swallowed',async t => {
  const dir = await temp(t), logs = []; let failed; const fatal = new Promise(resolve => {failed = resolve;});
  const app = await createApplication({dataDir:dir,options:{...parseOptions({}),token:'SECRET',guildId:'12345678901234567',channelId:'12345678901234567'},adapter:{status:() => ({state:'connected'}),close:async () => {}},log:text => logs.push(text),radio:async () => {throw new Error('SECRET URL '+url);},onFatal:failed}); t.after(() => app.close());
  await fatal; assert.equal(app.status().playback.state,'error'); assert.equal(logs.filter(line => line.includes('failed unexpectedly')).length,1); assert.equal(logs.some(line => line.includes('SECRET') || line.includes(url)),false);
});
