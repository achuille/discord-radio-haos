import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDiscordAdapter } from '../src/discord.mjs';

const config = { token: 'SECRET_NEVER_LOG', guildId: '123456', channelId: '654321' };
function fixture({ loginError, joinFailures = 0, permissions = true, now = Date.now } = {}) {
  let joins = 0, logins = 0, clients = 0, players = 0;
  const waits = [];
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.play = (resource) => { player.resource = resource; player.state = { status: 'playing' }; };
  player.stop = () => { player.state = { status: 'idle' }; player.emit('stateChange', {}, player.state); };
  player.pause = () => true; player.unpause = () => true;
  const connections = [];
  let client;
  class Client extends EventEmitter {
    constructor() {
      super(); clients++; client = this;
      this.user = { id: '777777' }; this.ready = false;
      this.guilds = { fetch: async () => ({ voiceAdapterCreator: 'guild-adapter', channels: { fetch: async () => ({ type: 'GUILD_VOICE', permissionsFor: () => ({ has: () => permissions }) }) } }) };
    }
    isReady() { return this.ready; }
    async login() { logins++; if (loginError) throw loginError; this.ready = true; }
    async destroy() { this.ready = false; }
  }
  const api = {
    Client, VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected' },
    AudioPlayerStatus: { Idle: 'idle' }, NoSubscriberBehavior: { Pause: 'pause' }, StreamType: { Raw: 'raw' },
    createAudioPlayer: () => { players++; return player; },
    createAudioResource: (stream, options) => ({ stream, options, volume: { value: 1, setVolume(value) { this.value = value; } } }),
    joinVoiceChannel: (options) => {
      joins++; assert.equal(options.adapterCreator, 'guild-adapter');
      const connection = new EventEmitter(); connection.state = { status: 'connecting' };
      connection.destroy = () => { connection.state = { status: 'destroyed' }; };
      connection.subscribe = (p) => assert.equal(p, player);
      connections.push(connection); return connection;
    },
    entersState: async (connection) => { if (joins <= joinFailures) throw Error('with SECRET_NEVER_LOG'); connection.state = { status: 'ready' }; },
  };
  const adapter = createDiscordAdapter(config, { dependencies: async () => api, now, random: () => 0.5, sleep: async (ms) => { waits.push(ms); } });
  return { adapter, player, connections, waits, api, get client() { return client; }, counts: () => ({ joins, logins, clients, players }) };
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
test('own move returns to configured channel after a cooldown', async () => {
  const f = fixture(); await f.adapter.connect();
  f.client.emit('voiceStateUpdate', {}, { id: f.client.user.id, guild: { id: config.guildId }, channelId: '999999' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.waits.includes(15000)); assert.equal(f.counts().joins, 2); await f.adapter.close();
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
