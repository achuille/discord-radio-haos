import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VoiceTarget } from '../src/core/voice-target.mjs';
import { createDiscordAdapter } from '../src/discord.mjs';

const config = { token: 'SECRET_NEVER_LOG', guildId: '123456', channelId: '654321' };
function fixture({ loginError, joinFailures = 0, permissions = true, now = Date.now, options = {}, sleep, fetchChannel, onStatus } = {}) {
  let joins = 0, logins = 0, clients = 0, players = 0;
  const waits = [];
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.play = (resource) => { player.resource = resource; player.state = { status: 'playing' }; };
  player.stop = () => { player.state = { status: 'idle' }; player.emit('stateChange', {}, player.state); };
  player.pause = () => true; player.unpause = () => true;
  const connections = [], joinOptions = [], fetchedChannels = [];
  let client;
  class Client extends EventEmitter {
    constructor() {
      super(); clients++; client = this;
      this.user = { id: '777777' }; this.ready = false;
      this.guilds = { fetch: async () => ({ voiceAdapterCreator: 'guild-adapter', channels: { fetch: async (id) => { fetchedChannels.push(id); return fetchChannel ? fetchChannel(id) : { type: 'GUILD_VOICE', permissionsFor: () => ({ has: () => permissions }) }; } } }) };
    }
    isReady() { return this.ready; }
    async login() { logins++; if (loginError) throw loginError; this.ready = true; }
    async destroy() { this.ready = false; }
  }
  const api = {
    Client, VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected', Connecting: 'connecting', Signalling: 'signalling' },
    AudioPlayerStatus: { Idle: 'idle' }, NoSubscriberBehavior: { Pause: 'pause' }, StreamType: { Raw: 'raw' },
    createAudioPlayer: () => { players++; return player; },
    createAudioResource: (stream, options) => ({ stream, options, volume: { value: 1, setVolume(value) { this.value = value; } } }),
    joinVoiceChannel: (options) => {
      joins++; joinOptions.push(options); assert.equal(options.adapterCreator, 'guild-adapter');
      const connection = new EventEmitter(); connection.state = { status: 'connecting' };
      connection.destroy = () => { connection.state = { status: 'destroyed' }; };
      connection.subscribe = (p) => assert.equal(p, player);
      connections.push(connection); return connection;
    },
    entersState: async (connection) => { if (joins <= joinFailures) throw Error('with SECRET_NEVER_LOG'); connection.state = { status: 'ready' }; },
  };
  const adapter = createDiscordAdapter({...config,...options}, { dependencies: async () => api, onStatus, now, random: () => 0.5, sleep: async (ms, value, context) => { waits.push(ms); return sleep?.(ms, value, context); } });
  return { adapter, player, connections, joinOptions, fetchedChannels, waits, api, get client() { return client; }, counts: () => ({ joins, logins, clients, players }) };
}

test('missing credentials never loads a gateway or exposes secrets', async () => {
  const adapter = createDiscordAdapter({}, { dependencies: () => { throw Error('must not load'); } });
  await assert.rejects(adapter.connect(), { code: 'auth_required' });
  assert.equal(adapter.status().state, 'auth_required');
  await adapter.close();
});
test('concurrent connects share one client/player and modern voice adapter', async () => {
  const f = fixture(); await Promise.all([f.adapter.connect(), f.adapter.connect()]);
  assert.deepEqual(f.counts(), { joins: 1, logins: 1, clients: 1, players: 1 });
  assert.equal(f.adapter.status().connected, true); await f.adapter.close();
});
test('PCM playback completes naturally and removes per-track handlers', async () => {
  const f = fixture(); await f.adapter.connect();
  const stream = new PassThrough(); const abort = new AbortController();
  const playing = f.adapter.play(stream, { signal: abort.signal });
  assert.equal(f.player.resource.options.inputType, 'raw');
  f.player.stop(); await playing;
  assert.equal(stream.destroyed, true); assert.equal(f.player.listenerCount('stateChange'), 0);
  await f.adapter.close();
});
test('abort interrupts rather than completing, cleans handlers and permits next track', async () => {
  const f = fixture(); await f.adapter.connect();
  const stream = new PassThrough(); const abort = new AbortController();
  const playing = f.adapter.play(stream, { signal: abort.signal });
  const check = assert.rejects(playing, { code: 'playback_aborted' }); abort.abort(); await check;
  assert.equal(f.player.listenerCount('stateChange'), 0); assert.equal(stream.listenerCount('error'), 0);
  const next = f.adapter.play(new PassThrough()); f.player.stop(); await next; await f.adapter.close();
});
test('duplicate play rejected; shutdown rejects active playback', async () => {
  const f = fixture(); await f.adapter.connect();
  const first = f.adapter.play(new PassThrough());
  await assert.rejects(f.adapter.play(new PassThrough()), { code: 'already_playing' });
  const check = assert.rejects(first, { code: 'closed' }); await f.adapter.close(); await check;
  await assert.rejects(f.adapter.connect(), { code: 'closed' });
});
test('bounded exponential reconnect has jitter and no secret error objects', async () => {
  const f = fixture({ joinFailures: 20 });
  await assert.rejects(f.adapter.connect(), { code: 'retry_exhausted' });
  assert.deepEqual(f.waits, [2000, 4000, 8000, 16000, 32000]);
  assert.equal(f.counts().joins, 6); assert.doesNotMatch(JSON.stringify(f.adapter.status()), /SECRET/); await f.adapter.close();
});
test('authentication and permissions are terminal, not aggressively retried', async () => {
  for (const options of [{ loginError: { code: 'TOKEN_INVALID', message: config.token } }, { permissions: false }]) {
    const f = fixture(options); const code = options.loginError ? 'auth_required' : 'permission_denied';
    await assert.rejects(f.adapter.connect(), { code }); await assert.rejects(f.adapter.connect(), { code });
    assert.equal(f.counts().logins, 1); assert.deepEqual(f.waits, []); await f.adapter.close();
  }
});
test('transient join retries eventually succeed without duplicate players', async () => {
  const f = fixture({ joinFailures: 2 }); await f.adapter.connect();
  assert.equal(f.counts().joins, 3); assert.equal(f.counts().players, 1); assert.equal(f.adapter.status().connected, true); await f.adapter.close();
});
test('player and input errors interrupt playback with sanitized failure', async () => {
  for (const source of ['player', 'stream']) {
    const f = fixture(); await f.adapter.connect(); const stream = new PassThrough();
    const playing = f.adapter.play(stream); const check = assert.rejects(playing, { code: 'audio_failed' });
    (source === 'player' ? f.player : stream).emit('error', Error(config.token)); await check; await f.adapter.close();
  }
});
test('join-to-create move adopts actual room without reconnecting or interrupting healthy playback', async () => {
  const f = fixture(); await f.adapter.connect();
  const stream = new PassThrough(), playing = f.adapter.play(stream);
  move(f, '999999'); move(f, '999998'); move(f, '999998');
  await tick(); await f.adapter.connect();
  assert.equal(f.adapter.status().channelId, '999998');
  assert.equal(f.adapter.status().configuredChannelId, config.channelId);
  assert.deepEqual(f.waits, []); assert.equal(f.counts().joins, 1);
  assert.equal(stream.destroyed, false);
  f.player.stop(); await playing; await f.adapter.close();
});
test('unexpected gateway adapter destruction recreates voice connection after cooldown', async () => {
  const f = fixture(); await f.adapter.connect(); const old = f.connections[0];
  old.state = { status: 'destroyed' }; old.emit('stateChange', {}, old.state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().joins, 2); assert.ok(f.waits.includes(15000)); await f.adapter.close();
});
test('retry exhaustion prevents immediate new batches', async () => {
  const f = fixture({ joinFailures: 100 });
  await assert.rejects(f.adapter.connect(), { code: 'retry_exhausted' });
  await assert.rejects(f.adapter.connect(), { code: 'retry_exhausted' });
  assert.equal(f.counts().joins, 6); await f.adapter.close();
});
test('shutdown while gateway login is pending rejects connect promptly', async () => {
  const f = fixture();
  f.api.Client.prototype.login = async function () { await new Promise(() => {}); };
  const pending = f.adapter.connect();
  const check = assert.rejects(pending, { code: 'closed' });
  await new Promise(resolve => setImmediate(resolve));
  await f.adapter.close(); await check;
  assert.equal(f.client.isReady(), false); assert.equal(f.counts().joins, 0);
});

test('retry cooldown expires and permits a later controlled batch', async () => {
  let now = 0;
  const f = fixture({ joinFailures: 6, now: () => now });
  await assert.rejects(f.adapter.connect(), { code: 'retry_exhausted' });
  now = 299999;
  await assert.rejects(f.adapter.connect(), { code: 'retry_exhausted' });
  now = 300000; await f.adapter.connect();
  assert.equal(f.counts().joins, 7); await f.adapter.close();
});
test('late dependency loading after shutdown cannot create a gateway', async () => {
  const f = fixture(); let release;
  const adapter = createDiscordAdapter(config, { dependencies: () => new Promise(resolve => { release = resolve; }) });
  const pending = adapter.connect(); const check = assert.rejects(pending, { code: 'closed' });
  await adapter.close(); release(f.api); await check;
  assert.equal(f.counts().clients, 0); assert.equal(adapter.status().state, 'closed');
});

test('volume changes apply to the active resource immediately and persist for next track', async () => {
  const f = fixture(); await f.adapter.connect();
  let playing = f.adapter.play(new PassThrough());
  assert.equal(f.player.resource.options.inlineVolume, true);
  assert.equal(f.player.resource.volume.value, 0.6);
  f.adapter.setVolume(0.2); assert.equal(f.player.resource.volume.value, 0.2);
  assert.equal(f.adapter.status().volume, 0.2);
  assert.throws(() => f.adapter.setVolume(Infinity), { code: 'invalid_volume' });
  assert.equal(f.player.resource.volume.value, 0.2);
  f.player.stop(); await playing;
  playing = f.adapter.play(new PassThrough()); assert.equal(f.player.resource.volume.value, 0.2);
  f.player.stop(); await playing; await f.adapter.close();
});

test('verification and CAPTCHA challenges are terminal and never automatically solved', async () => {
  for (const loginError of [{ code: 40002 }, { captcha: { captcha_service: 'hcaptcha' } }, { httpStatus: 401 }]) {
    const f = fixture({ loginError });
    await assert.rejects(f.adapter.connect(), { code: 'auth_required' });
    assert.equal(f.counts().logins, 1); assert.deepEqual(f.waits, []); await f.adapter.close();
  }
});


const tick = () => new Promise(resolve => setImmediate(resolve));
const move = (f, channelId, overrides = {}) => f.client.emit('voiceStateUpdate', {}, { id: f.client.user.id, guild: { id: config.guildId }, channelId, ...overrides });
const voiceState = (connection, status) => { const old = connection.state; connection.state = {status}; connection.emit('stateChange', old, connection.state); };
const channel = () => ({ type:'GUILD_VOICE', permissionsFor: () => ({has: () => true}) });
function controlledSleep() {
  const timers = [];
  return { timers, sleep: (ms, _value, {signal}) => new Promise((resolve,reject) => {
    const abort = () => { signal.removeEventListener('abort',abort); reject(Object.assign(new Error('aborted'),{name:'AbortError'})); };
    const release = () => { signal.removeEventListener('abort',abort); resolve(); };
    signal.addEventListener('abort',abort,{once:true});
    timers.push({ms,signal,release}); if(signal.aborted) abort();
  }) };
}
async function privateState(t, value) {
  const root = await mkdtemp(path.join(tmpdir(),'radio-voice-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const file = path.join(root,'voice-target.json');
  if (value) await writeFile(file,JSON.stringify(value));
  return file;
}

test('unrelated users/guilds and mute events never move or reconnect the adapter', async () => {
  const f = fixture(); await f.adapter.connect();
  move(f,'999999',{id:'111111'}); move(f,'999999',{guild:{id:'222222'}}); move(f,config.channelId);
  await tick(); assert.equal(f.adapter.status().channelId,config.channelId);
  assert.equal(f.counts().joins,1); assert.deepEqual(f.waits,[]); await f.adapter.close();
});

test('disconnect retains adopted room and shares one recovery grace period with playback callers', async () => {
  const timer = controlledSleep(), f = fixture({sleep:timer.sleep}); await f.adapter.connect();
  move(f,'999999'); move(f,null);
  voiceState(f.connections[0],'disconnected'); f.connections[0].emit('error',new Error('transient'));
  const a = f.adapter.connect(), b = f.adapter.connect(); await tick();
  assert.equal(f.adapter.status().channelId,'999999');
  assert.equal(f.counts().joins,1); assert.equal(timer.timers.length,1);
  timer.timers[0].release(); await Promise.all([a,b]);
  assert.deepEqual(f.joinOptions.map(x=>x.channelId),[config.channelId,'999999']);
  assert.equal(f.counts().logins,1); await f.adapter.close();
});

test('native recovery cancels fallback timer and never bounces a server-moved room', async () => {
  const timer = controlledSleep(), f = fixture({sleep:timer.sleep}); await f.adapter.connect();
  voiceState(f.connections[0],'disconnected'); const waiting = f.adapter.connect();
  move(f,'999999'); voiceState(f.connections[0],'ready');
  await waiting; assert.equal(timer.timers[0].signal.aborted,true);
  timer.timers[0].release(); await tick();
  assert.equal(f.counts().joins,1); assert.equal(f.adapter.status().channelId,'999999'); await f.adapter.close();
});

test('stalled connecting transition recovers to latest room once after native grace', async () => {
  const timer = controlledSleep(), f = fixture({sleep:timer.sleep}); await f.adapter.connect();
  move(f,'999999'); voiceState(f.connections[0],'connecting'); move(f,'999998');
  assert.equal(timer.timers.length,1); timer.timers[0].release(); await tick();
  assert.deepEqual(f.joinOptions.map(x=>x.channelId),[config.channelId,'999998']); await f.adapter.close();
});

test('shutdown aborts pending recovery and ignores late gateway moves', async () => {
  const timer = controlledSleep(), f = fixture({sleep:timer.sleep}); await f.adapter.connect();
  voiceState(f.connections[0],'disconnected');
  await f.adapter.close(); move(f,'999999'); timer.timers[0].release(); await tick();
  assert.equal(f.adapter.status().state,'closed'); assert.equal(timer.timers[0].signal.aborted,true);
  assert.equal(f.counts().joins,1); assert.equal(f.adapter.status().channelId,config.channelId);
});

test('move racing channel lookup never sends a stale join', async () => {
  let release;
  const f = fixture({fetchChannel:id=>id===config.channelId ? new Promise(resolve=>{release=resolve;}) : channel()});
  const pending = f.adapter.connect(); await tick(); move(f,'999999'); release(channel()); await pending;
  assert.deepEqual(f.joinOptions.map(x=>x.channelId),['999999']); await f.adapter.close();
});

test('move during initial join handshake is adopted, including a subsequent retry', async () => {
  const f = fixture();
  let attempts=0;
  f.api.entersState = async connection => {
    if (++attempts===1) { move(f,'999999'); throw new Error('handshake interrupted'); }
    connection.state={status:'ready'};
  };
  await f.adapter.connect();
  assert.deepEqual(f.joinOptions.map(x=>x.channelId),[config.channelId,'999999']);
  assert.equal(f.counts().logins,1); assert.deepEqual(f.waits,[2000]); await f.adapter.close();
});

test('late channel fetch after bounded timeout cannot create a connection', async () => {
  let release;
  const f = fixture({options:{connectTimeoutMs:10,maxAttempts:1},fetchChannel:()=>new Promise(resolve=>{release=resolve;})});
  await assert.rejects(f.adapter.connect(),{code:'retry_exhausted'});
  release(channel()); await tick(); assert.equal(f.counts().joins,0); await f.adapter.close();
});

test('adopted target persists privately, normal restart retains it, explicit HA changes reset it', async t => {
  const file = await privateState(t), options={voiceStateFile:file};
  const f=fixture({options}); await f.adapter.connect(); move(f,'999999'); move(f,null); await f.adapter.close();
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(saved,{version:1,guildId:config.guildId,configuredChannelId:config.channelId,channelId:'999999'});
  assert.equal((await stat(file)).mode & 0o777,0o600);
  const same=fixture({options}); await same.adapter.connect(); assert.equal(same.joinOptions[0].channelId,'999999'); await same.adapter.close();
  const changed=fixture({options:{...options,channelId:'888888'}}); await changed.adapter.connect(); assert.equal(changed.joinOptions[0].channelId,'888888'); await changed.adapter.close();
});

test('deleted remembered temporary room falls back once to bootstrap and adopts replacement', async t => {
  for (const missing of ['null','10003']) {
    const file=await privateState(t,{version:1,guildId:config.guildId,configuredChannelId:config.channelId,channelId:'999999'});
    const f=fixture({options:{voiceStateFile:file},fetchChannel:id=>{
      if(id==='999999') { if(missing==='null') return null; throw Object.assign(new Error('missing'),{code:10003}); }
      return channel();
    }});
    f.api.entersState=async connection=>{ move(f,'999998'); connection.state={status:'ready'}; };
    await f.adapter.connect(); await f.adapter.close();
    assert.deepEqual(f.fetchedChannels,['999999',config.channelId]);
    assert.deepEqual(f.joinOptions.map(x=>x.channelId),[config.channelId]);
    assert.equal(JSON.parse(await readFile(file,'utf8')).channelId,'999998');
  }
});

test('permission denial in adopted room never falls back to creator', async t => {
  const file=await privateState(t,{version:1,guildId:config.guildId,configuredChannelId:config.channelId,channelId:'999999'});
  const f=fixture({options:{voiceStateFile:file},permissions:false});
  await assert.rejects(f.adapter.connect(),{code:'permission_denied'});
  assert.deepEqual(f.fetchedChannels,['999999']); assert.equal(f.counts().joins,0); assert.deepEqual(f.waits,[]); await f.adapter.close();
});

test('missing bootstrap remains terminal instead of looping missing-room fallbacks', async t => {
  const file=await privateState(t,{version:1,guildId:config.guildId,configuredChannelId:config.channelId,channelId:'999999'});
  const f=fixture({options:{voiceStateFile:file},fetchChannel:()=>null});
  await assert.rejects(f.adapter.connect(),{code:'invalid_voice_channel'});
  assert.deepEqual(f.fetchedChannels,['999999',config.channelId]); assert.equal(f.counts().joins,0); await f.adapter.close();
});

test('damaged, oversize or mismatched runtime target state never overrides configuration', async t => {
  const file=await privateState(t);
  for (const content of ['{bad',' '.repeat(4097),JSON.stringify({version:1,guildId:'888888',configuredChannelId:config.channelId,channelId:'999999'}),JSON.stringify({version:1,guildId:config.guildId,configuredChannelId:config.channelId,channelId:'not-an-id'})]) {
    await writeFile(file,content); const target=new VoiceTarget({...config,voiceStateFile:file}); await target.load();
    assert.equal(target.channelId,config.channelId);
  }
});

test('readiness waits out retry cooldown once and is abortable without another login', async () => {
  let now=0;
  const timer=controlledSleep(), f=fixture({options:{maxAttempts:1,retryCooldownMs:5000},joinFailures:1,now:()=>now,sleep:timer.sleep});
  const stop=new AbortController(), waiting=f.adapter.waitUntilConnected({signal:stop.signal}); await tick();
  assert.equal(f.counts().joins,1); assert.deepEqual(f.waits,[5000]);
  now=5000; timer.timers[0].release(); await waiting;
  assert.equal(f.counts().joins,2); assert.equal(f.counts().logins,1); await f.adapter.close();
});

test('terminal readiness failure waits for configuration restart with no polling or retry timers', async () => {
  const f=fixture({loginError:{code:'TOKEN_INVALID'}}), stop=new AbortController();
  const pending=f.adapter.waitUntilConnected({signal:stop.signal}); const rejected=assert.rejects(pending,{code:'playback_aborted'});
  await tick(); await tick(); assert.equal(f.counts().logins,1); assert.deepEqual(f.waits,[]);
  stop.abort(); await rejected; await f.adapter.close();
});

test('slow gateway login is shared across bounded retries and closed if it resolves after shutdown', async () => {
  const f=fixture({options:{connectTimeoutMs:5,maxAttempts:3}}); let release, calls=0;
  f.api.Client.prototype.login=async function () { calls++; await new Promise(resolve=>{release=resolve;}); this.ready=true; };
  await assert.rejects(f.adapter.connect(),{code:'retry_exhausted'}); assert.equal(calls,1);
  await f.adapter.close(); release(); await tick();
  assert.equal(f.client.isReady(),false); assert.equal(f.counts().joins,0);
});

test('native voice ready listener is aborted on shutdown, not left until timeout', async () => {
  const f=fixture(); let readySignal;
  f.api.entersState=async (_connection,_state,signal)=>{
    readySignal=signal;
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  };
  const pending=f.adapter.connect(), rejected=assert.rejects(pending,{code:'closed'});
  await tick(); await f.adapter.close(); await rejected;
  assert.equal(readySignal.aborted,true);
});

test('terminal gateway event during login cannot be overwritten by a late login success', async () => {
  const f=fixture(); let release;
  f.api.Client.prototype.login=async function () { await new Promise(resolve=>{release=resolve;}); this.ready=true; };
  const pending=f.adapter.connect(), rejected=assert.rejects(pending,{code:'auth_required'});
  await tick(); f.client.emit('invalidated'); release(); await rejected;
  assert.equal(f.counts().joins,0); assert.equal(f.adapter.status().state,'auth_required');
  await f.adapter.close(); f.client.emit('invalidated'); assert.equal(f.adapter.status().state,'closed');
});


test('native status callback only reports changed sanitized states, never duplicate moves or secrets', async () => {
  const events=[], f=fixture({onStatus:event=>events.push(event)}); await f.adapter.connect();
  const count=events.length; move(f,'999999'); move(f,'999999'); await f.adapter.connect();
  assert.equal(events.length,count); assert.deepEqual(events.at(-1),{state:'connected',error:null});
  f.client.emit('error',{code:'TOKEN_INVALID',message:config.token,token:config.token});
  assert.deepEqual(events.at(-1),{state:'auth_required',error:'auth_required'});
  assert.doesNotMatch(JSON.stringify(events),/SECRET|999999|654321/); await f.adapter.close();
});
