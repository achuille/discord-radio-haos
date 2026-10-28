// Gateway only: do not use the selfbot library's legacy voice.joinChannel transport.
// @discordjs/voice owns modern voice encryption, DAVE, Opus and reconnects.
import { setTimeout as sleep } from 'node:timers/promises';
import { VoiceTarget } from './core/voice-target.mjs';

const failure = (code) => Object.assign(new Error(code), { code });
function classify(error) {
  const code = error?.code;
  if (error?.captcha || error?.httpStatus === 401) return 'auth_required';
  if (error?.httpStatus === 403) return 'permission_denied';
  if (['TOKEN_INVALID', 'TOKEN_MISSING', 'INVALID_TOKEN', 4004, 401, 40002, 50014].includes(code)) return 'auth_required';
  if ([403, 40333, 50001, 50009, 50013].includes(code)) return 'permission_denied';
  if ([10003, 10004].includes(code)) return 'invalid_voice_channel';
  return 'connection_failed';
}
async function dependencies() {
  const [gateway, voice] = await Promise.all([import('discord.js-selfbot-v13'), import('@discordjs/voice')]);
  return { Client: gateway.Client ?? gateway.default.Client, ...voice };
}

export function createDiscordAdapter(config, injected = {}) {
  const authMode = config.authMode ?? 'selfbot';
  let volume = config.volume ?? 0.6;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw failure('invalid_volume');
  let api, client, connection, player, active, connecting, recovery, loggingIn;
  let state = 'disconnected', lastError = null, retryAttempt = 0, closed = false, retryAfter = 0, generation = 0;
  const lifetime = new AbortController();
  const pendingOperations = new Set();
  const target = new VoiceTarget(config);
  let targetLoaded = false;
  const maxAttempts = config.maxAttempts ?? 6;
  const delay = injected.sleep ?? sleep;
  const random = injected.random ?? Math.random;
  const now = injected.now ?? Date.now;
  function destroyConnection() {
    const previous = connection; connection = null;
    if (previous && previous.state.status !== api.VoiceConnectionStatus.Destroyed) previous.destroy();
  }
  const report = (next, code = null) => {
    if (state === next && lastError === code) return;
    state = next; lastError = code;
    try { injected.onStatus?.({state, error: code}); } catch { /* Logging must not affect playback. */ }
  };
  const interrupted = (code = 'playback_interrupted') => active?.finish(failure(code));
  function cancelRecovery() {
    const previous = recovery; recovery = null; previous?.abort.abort();
  }
  function terminal(code) {
    if (closed) return;
    generation++;
    cancelRecovery();
    report(code, code);
    for (const finish of pendingOperations) finish(failure(code));
    interrupted(code);
    destroyConnection();
  }
  function scheduleRecovery() {
    if (closed || connecting || recovery || ['auth_required', 'permission_denied', 'retry_exhausted'].includes(state)) return;
    const task = { abort: new AbortController() };
    recovery = task;
    task.promise = (async () => {
      try {
        // Give the voice library one grace period for server moves/native resume.
        // All callers of connect() share it instead of issuing an early rejoin.
        await delay(config.recoveryDelayMs ?? 15000, undefined, { signal: task.abort.signal });
        if (closed || recovery !== task) return;
        recovery = null;
        if (connection?.state.status === api.VoiceConnectionStatus.Ready && state === 'connected') return;
        interrupted();
        destroyConnection();
        await connect();
      } catch (error) {
        if (!task.abort.signal.aborted && !closed) throw error;
      } finally { if (recovery === task) recovery = null; }
    })();
    // Event-driven recovery has no caller; connect/waitUntilConnected still see
    // its rejection and the sanitized state, without an unhandled rejection.
    void task.promise.catch(() => {});
  }
  function bounded(operation) {
    return new Promise((resolve, reject) => {
      const operationAbort = new AbortController();
      let done = false;
      const abort = () => finish(failure('closed'));
      const timer = setTimeout(() => finish(failure('connection_failed')), config.connectTimeoutMs ?? 30000);
      const finish = (error, value) => {
        if (done) return;
        done = true;
        pendingOperations.delete(finish);
        clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort);
        operationAbort.abort();
        error ? reject(error) : resolve(value);
      };
      pendingOperations.add(finish);
      lifetime.signal.addEventListener('abort', abort, { once: true });
      if (closed) { abort(); return; }
      Promise.resolve().then(() => {
        if (operationAbort.signal.aborted) throw failure('closed');
        return operation(operationAbort.signal);
      }).then(value => finish(null, value), error => finish(error));
    });
  }
  function login() {
    // A slow login is shared even across bounded retry attempts. If shutdown wins
    // the race, a late successful login must not leave a live gateway behind.
    loggingIn ??= Promise.resolve().then(() => client.login(config.token)).then(async value => {
      if (closed || ['auth_required', 'permission_denied'].includes(state)) { await client.destroy(); throw failure(closed ? 'closed' : state); }
      return value;
    }).finally(() => { loggingIn = null; });
    return loggingIn;
  }
  async function initialize() {
    if (!targetLoaded) { await target.load(); targetLoaded = true; }
    api ??= await (injected.dependencies?.() ?? dependencies());
    if (closed) throw failure('closed');
    if (client) return;
    client = new api.Client({ checkUpdate: false, captchaSolver: null, captchaRetryLimit: 0 });
    // Never subscribe to messages, send presence, or dump gateway/error objects.
    client.on('error', (error) => {
      const code = classify(error);
      if (code === 'auth_required' || code === 'permission_denied') terminal(code);
    });
    client.on('invalidated', () => terminal('auth_required'));
    client.on('voiceStateUpdate', (_old, next) => {
      if (closed || ['auth_required', 'permission_denied'].includes(state) || next.id !== client.user?.id || next.guild?.id !== config.guildId) return;
      if (/^\d{5,25}$/.test(next.channelId ?? '')) {
        // Discord is authoritative: join-to-create/moderator moves are not drift.
        // @discordjs/voice receives this same packet and updates its own joinConfig.
        target.adopt(next.channelId);
        if (connection?.state.status === api.VoiceConnectionStatus.Ready) {
          cancelRecovery(); report('connected');
        }
      } else if (next.channelId === null) {
        // Keep the last real destination for recovery, never the bootstrap room.
        report('reconnecting'); interrupted(); scheduleRecovery();
      }
    });
    player = api.createAudioPlayer({ behaviors: { noSubscriber: api.NoSubscriberBehavior.Pause } });
    player.on('error', () => interrupted('audio_failed'));
  }
  async function join(epoch, signal) {
    if (closed || signal.aborted || epoch !== generation) throw failure('closed');
    const guild = await client.guilds.fetch(config.guildId);
    let channel, channelId;
    do {
      if (closed || signal.aborted || epoch !== generation) throw failure('closed');
      channelId = target.channelId;
      try { channel = await guild.channels.fetch(channelId); }
      catch (error) {
        if (closed || signal.aborted || epoch !== generation) throw failure('closed');
        if (channelId !== target.channelId) continue;
        if (error?.code === 10003 && channelId !== config.channelId) { target.adopt(config.channelId); continue; }
        throw error;
      }
      if (closed || signal.aborted || epoch !== generation) throw failure('closed');
      if (!channel && channelId === target.channelId && channelId !== config.channelId) { target.adopt(config.channelId); continue; }
      // A move can arrive while a REST fetch is pending. Never emit a stale join.
    } while (channelId !== target.channelId);
    if (closed || signal.aborted || epoch !== generation) throw failure('closed');
    if (!channel || !['GUILD_VOICE', 2].includes(channel.type)) throw failure('invalid_voice_channel');
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has(['VIEW_CHANNEL', 'CONNECT', 'SPEAK'])) throw failure('permission_denied');
    connection = api.joinVoiceChannel({
      guildId: config.guildId, channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, selfMute: false,
    });
    const joined = connection;
    joined.on('error', () => { if (connection === joined) scheduleRecovery(); });
    joined.on('stateChange', (_old, next) => {
      if (closed || connection !== joined) return;
      if (next.status === api.VoiceConnectionStatus.Ready) { cancelRecovery(); report('connected'); }
      if (next.status === api.VoiceConnectionStatus.Destroyed) {
        connection = null; report('reconnecting'); interrupted(); scheduleRecovery();
      }
      if ([api.VoiceConnectionStatus.Disconnected, api.VoiceConnectionStatus.Connecting, api.VoiceConnectionStatus.Signalling].includes(next.status)) {
        report('reconnecting'); interrupted(); scheduleRecovery();
      }
    });
    await api.entersState(joined, api.VoiceConnectionStatus.Ready, signal);
    if (closed || signal.aborted || epoch !== generation || connection !== joined) throw failure('closed');
    joined.subscribe(player);
    report('connected'); retryAttempt = 0;
  }
  function connect() {
    if (closed) return Promise.reject(failure('closed'));
    if (connecting) return connecting;
    if (recovery) return recovery.promise.then(() => connect());
    if (state === 'retry_exhausted' && now() < retryAfter) return Promise.reject(failure('retry_exhausted'));
    if (connection && connection.state.status === api.VoiceConnectionStatus.Ready) return Promise.resolve();
    if (['auth_required', 'permission_denied'].includes(state)) return Promise.reject(failure(state));
    connecting = (async () => {
      if (authMode !== 'selfbot') { report('unsupported_auth_mode', 'unsupported_auth_mode'); throw failure('unsupported_auth_mode'); }
      if (!config.token?.trim()) { report('auth_required', 'auth_required'); throw failure('auth_required'); }
      if (!/^\d{5,25}$/.test(config.guildId ?? '') || !/^\d{5,25}$/.test(config.channelId ?? '')) throw failure('invalid_channel_config');
      try { await initialize(); } catch { if (closed) throw failure('closed'); report('dependency_failed', 'dependency_failed'); throw failure('dependency_failed'); }
      for (let attempt = 0; attempt < maxAttempts && !closed; attempt++) {
        retryAttempt = attempt + 1; report(attempt ? 'reconnecting' : 'connecting');
        try {
          if (!client.isReady()) await bounded(() => login());
          if (closed) throw failure('closed');
          if (['auth_required', 'permission_denied'].includes(state)) throw failure(state);
          await bounded(signal => join(++generation, signal));
          return;
        } catch (error) {
          generation++;
          if (closed) throw failure('closed');
          const code = ['auth_required', 'permission_denied'].includes(state) ? state : (['auth_required', 'permission_denied', 'invalid_voice_channel'].includes(error?.code) ? error.code : classify(error));
          destroyConnection();
          if (code !== 'connection_failed') { report(code, code); throw failure(code); }
          // A failed voice handshake does not require another gateway login.
          // The gateway client owns its own websocket resume/reconnect lifecycle.
          if (attempt + 1 === maxAttempts) break;
          report('reconnecting', code);
          const ms = Math.min(config.retryMaxMs ?? 60000, (config.retryBaseMs ?? 2000) * 2 ** attempt);
          await delay(Math.min(config.retryMaxMs ?? 60000, Math.round(ms * (0.75 + random() * 0.5))), undefined, { signal: lifetime.signal });
        }
      }
      retryAfter = now() + (config.retryCooldownMs ?? 300000);
      report(closed ? 'closed' : 'retry_exhausted', closed ? null : 'retry_exhausted');
      throw failure(closed ? 'closed' : 'retry_exhausted');
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function waitUntilConnected({ signal } = {}) {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    while (!combined.aborted) {
      try {
        await new Promise((resolve, reject) => {
          const abort = () => finish(failure(closed ? 'closed' : 'playback_aborted'));
          const finish = (error) => { combined.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
          combined.addEventListener('abort', abort, { once: true });
          if (combined.aborted) { abort(); return; }
          connect().then(() => finish(), finish);
        });
        return;
      } catch (error) {
        if (combined.aborted) throw error;
        if (state === 'retry_exhausted') {
          await delay(Math.max(1, retryAfter - now()), undefined, { signal: combined });
        } else {
          // Credentials/configuration cannot be repaired by retrying each track.
          // HA applies changed options by restarting the process; wait without a timer.
          await new Promise((_, reject) => {
            const abort = () => { combined.removeEventListener('abort', abort); reject(failure(closed ? 'closed' : 'playback_aborted')); };
            combined.addEventListener('abort', abort, { once: true });
            if (combined.aborted) abort();
          });
        }
      }
    }
    throw failure(closed ? 'closed' : 'playback_aborted');
  }
  async function play(stream, { signal } = {}) {
    if (signal?.aborted) { stream.destroy(); throw failure('playback_aborted'); }
    if (active) throw failure('already_playing');
    if (closed || !connection || connection.state.status !== api.VoiceConnectionStatus.Ready) throw failure('not_connected');
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => finish(failure('playback_aborted'));
      const onError = () => finish(failure('audio_failed'));
      const onState = (_old, next) => { if (next.status === api.AudioPlayerStatus.Idle) finish(); };
      const finish = (error) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        player.off('stateChange', onState);
        stream.off('error', onError);
        active = null;
        if (error) player.stop(true);
        stream.destroy();
        error ? reject(error) : resolve();
      };
      active = { finish };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('error', onError);
      player.on('stateChange', onState);
      try {
        const resource = api.createAudioResource(stream, { inputType: api.StreamType.Raw, inlineVolume: true });
        resource.volume.setVolume(volume);
        active.resource = resource;
        player.play(resource);
      } catch { finish(failure('audio_failed')); }
    });
  }
  async function close() {
    if (closed) return;
    closed = true; generation++; cancelRecovery(); lifetime.abort(); interrupted('closed');
    player?.stop(true);
    destroyConnection();
    try { await client?.destroy(); } catch { /* Never disclose a gateway error. */ }
    await target.pending;
    report('closed');
  }
  return {
    connect, waitUntilConnected, play, close,
    setVolume(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw failure('invalid_volume');
      volume = value; active?.resource?.volume.setVolume(value);
    },
    pause: () => player?.pause() ?? false,
    resume: () => player?.unpause() ?? false,
    status: () => ({ state, authMode, connected: state === 'connected', channelId: target.channelId, configuredChannelId: config.channelId, volume, retryAttempt, error: lastError }),
  };
}
