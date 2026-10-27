// Gateway only: do not use the selfbot library's legacy voice.joinChannel transport.
// @discordjs/voice owns modern voice encryption, DAVE, Opus and reconnects.
import { setTimeout as sleep } from 'node:timers/promises';

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
  let api, client, connection, player, active, connecting, recovery;
  let state = 'disconnected', lastError = null, retryAttempt = 0, closed = false, retryAfter = 0, generation = 0;
  const lifetime = new AbortController();
  const maxAttempts = config.maxAttempts ?? 6;
  const delay = injected.sleep ?? sleep;
  const random = injected.random ?? Math.random;
  const now = injected.now ?? Date.now;
  function destroyConnection() {
    const previous = connection; connection = null;
    if (previous && previous.state.status !== api.VoiceConnectionStatus.Destroyed) previous.destroy();
  }
  const report = (next, code = null) => { state = next; lastError = code; };
  const interrupted = (code = 'playback_interrupted') => active?.finish(failure(code));
  function terminal(code) {
    generation++;
    report(code, code);
    interrupted(code);
    destroyConnection();
  }
  function scheduleRecovery(force = false) {
    if (closed || recovery || ['auth_required', 'permission_denied', 'retry_exhausted'].includes(state)) return;
    recovery = (async () => {
      try {
        // Allow native networking/resume first; avoid racing a moderator's move.
        await delay(config.recoveryDelayMs ?? 15000, undefined, { signal: lifetime.signal });
        if (closed) return;
        if (!force && connection?.state.status === api.VoiceConnectionStatus.Ready) return;
        interrupted();
        destroyConnection();
        await connect();
      } catch { /* connect() records only safe error codes; shutdown aborts timers */ }
      finally { recovery = null; }
    })();
  }
  function bounded(operation) {
    return new Promise((resolve, reject) => {
      const abort = () => finish(failure('closed'));
      const timer = setTimeout(() => finish(failure('connection_failed')), config.connectTimeoutMs ?? 30000);
      const finish = (error, value) => {
        clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      lifetime.signal.addEventListener('abort', abort, { once: true });
      if (closed) abort();
      Promise.resolve(operation).then(value => finish(null, value), error => finish(error));
    });
  }
  async function initialize() {
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
      if (next.id !== client.user?.id || next.guild?.id !== config.guildId) return;
      if (next.channelId !== config.channelId) scheduleRecovery(true);
    });
    player = api.createAudioPlayer({ behaviors: { noSubscriber: api.NoSubscriberBehavior.Pause } });
    player.on('error', () => interrupted('audio_failed'));
  }
  async function join(epoch) {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.channelId);
    if (closed || epoch !== generation) throw failure('closed');
    if (!channel || !['GUILD_VOICE', 2].includes(channel.type)) throw failure('invalid_voice_channel');
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has(['VIEW_CHANNEL', 'CONNECT', 'SPEAK'])) throw failure('permission_denied');
    connection = api.joinVoiceChannel({
      guildId: config.guildId, channelId: config.channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, selfMute: false,
    });
    const joined = connection;
    joined.on('error', () => { if (connection === joined) scheduleRecovery(); });
    joined.on('stateChange', (_old, next) => {
      if (closed || connection !== joined) return;
      if (next.status === api.VoiceConnectionStatus.Ready) report('connected');
      if (next.status === api.VoiceConnectionStatus.Destroyed) {
        connection = null; report('reconnecting'); interrupted(); scheduleRecovery();
      }
      if (next.status === api.VoiceConnectionStatus.Disconnected) {
        report('reconnecting'); interrupted(); scheduleRecovery();
      }
    });
    await api.entersState(joined, api.VoiceConnectionStatus.Ready, config.connectTimeoutMs ?? 30000);
    if (closed || epoch !== generation || connection !== joined) throw failure('closed');
    joined.subscribe(player);
    report('connected'); retryAttempt = 0;
  }
  function connect() {
    if (closed) return Promise.reject(failure('closed'));
    if (connecting) return connecting;
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
          if (!client.isReady()) await bounded(client.login(config.token));
          if (closed) throw failure('closed');
          await bounded(join(++generation));
          return;
        } catch (error) {
          generation++;
          if (closed) throw failure('closed');
          const code = ['auth_required', 'permission_denied'].includes(state) ? state : (['auth_required', 'permission_denied', 'invalid_voice_channel'].includes(error?.code) ? error.code : classify(error));
          destroyConnection();
          if (code !== 'connection_failed') { report(code, code); throw failure(code); }
          try { await client.destroy(); } catch { /* Sanitized retry only. */ }
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
    closed = true; generation++; lifetime.abort(); interrupted('closed');
    player?.stop(true);
    destroyConnection();
    try { await client?.destroy(); } catch { /* Never disclose a gateway error. */ }
    report('closed');
  }
  return {
    connect, play, close,
    setVolume(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw failure('invalid_volume');
      volume = value; active?.resource?.volume.setVolume(value);
    },
    pause: () => player?.pause() ?? false,
    resume: () => player?.unpause() ?? false,
    status: () => ({ state, authMode, connected: state === 'connected', volume, retryAttempt, error: lastError }),
  };
}
