import { mkdir, readFile, writeFile, rename, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeSources } from './sources/importer.mjs';
import { driveFolder } from './sources/drive.mjs';

const has = (value, key) => Object.hasOwn(value, key);
async function readJSON(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Invalid private configuration file');
  return JSON.parse(await readFile(file, 'utf8'));
}
export function sourceURLs(input) {
  if (!Array.isArray(input) || input.length > 20 || input.some(url => typeof url !== 'string' || !url.length || url.length > 2048)) throw new Error('Invalid sources: use at most 20 public audio or Drive URLs');
  try { return normalizeSources(input); }
  catch { throw new Error('Invalid sources: use public HTTP(S) audio or Drive URLs without credentials'); }
}
export function parseOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid add-on configuration');
  const number = (key, fallback, min, max, integer = false) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${key}`);
    return value;
  };
  if (input.discord_token !== undefined && (typeof input.discord_token !== 'string' || input.discord_token.length > 8192)) throw new Error('Invalid discord_token');
  const token = input.discord_token?.trim() ?? '';
  const id = key => { const value = input[key] ?? ''; if (typeof value !== 'string' || (value && !/^\d{17,20}$/.test(value))) throw new Error(`Invalid ${key}`); return value; };
  if (input.auth_mode && input.auth_mode !== 'selfbot') throw new Error('Only selfbot authentication is supported');
  if (input.playback_enabled !== undefined && typeof input.playback_enabled !== 'boolean') throw new Error('Invalid playback_enabled');
  return { token, guildId:id('guild_id'), channelId:id('voice_channel_id'), authMode:'selfbot',
    sources:has(input,'sources') ? sourceURLs(input.sources) : undefined,
    playbackEnabled:input.playback_enabled ?? true,
    volume:number('volume',0.6,0,1), scanIntervalMs:number('scan_interval_seconds',60,10,3600,true)*1000,
    syncIntervalMs:number('sync_interval_seconds',900,60,86400,true)*1000,
    maxTrackMs:number('max_track_seconds',14400,30,86400,true)*1000 };
}
export async function readOptions(file = '/data/options.json') {
  let input;
  try { input = await readJSON(file); }
  catch (error) { if (error.code === 'ENOENT') input = {}; else throw new Error('Cannot read add-on configuration'); }
  return parseOptions(input);
}

export class SettingsStore {
  constructor(file, { volume = 0.6 } = {}) { this.file = file; this.exists = false; this.value = { volume, sources: [] }; this.pending = Promise.resolve(); }
  async load() {
    try {
      const value = await readJSON(this.file);
      if (!value || typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1 || !Array.isArray(value.sources) || value.sources.length > 50) throw new Error('Invalid settings');
      const sources = value.sources.map(s => {
        if (!s || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id) || typeof s.url !== 'string' || s.url.length > 2048 || !['drive','direct'].includes(s.type)) throw new Error('Invalid source');
        return {id:s.id,url:s.url,type:s.type};
      });
      if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Duplicate source');
      this.value = {volume:value.volume,sources,...(value.nativeConfiguration === true ? {nativeConfiguration:true} : {})};
      this.exists = true;
      await chmod(this.file,0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read private radio settings'); }
    return this.value;
  }
  save(value = this.value) {
    const safe = {volume:value.volume,sources:value.sources.map(({id,url,type}) => ({id,url,type})),...(value.nativeConfiguration === true ? {nativeConfiguration:true} : {})};
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp,JSON.stringify(safe),{mode:0o600,flag:'wx'});
      await rename(temp,this.file);
      await chmod(this.file,0o600);
      this.value = safe; this.exists = true;
    });
    return this.pending;
  }
}

// The Supervisor grants every add-on access to its own options, even with
// hassio_api:false. Never replace !secret references with the rendered token.
// The options dictionary is replaced, not patched: preserve raw saved options.
export async function migrateNativeOptions(legacy, {token = process.env.SUPERVISOR_TOKEN, request = fetch, initialVolume} = {}) {
  if (!token) return null;
  const signal = AbortSignal.timeout(8000);
  const call = async (route, body) => {
    const response = await request(`http://supervisor/addons/self/${route}`,{
      method:body ? 'POST' : 'GET', redirect:'error', signal,
      headers:{authorization:`Bearer ${token}`,...(body ? {'content-type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    if (!response.ok) throw new Error('Native migration unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 256*1024) throw new Error('Native migration response too large');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.result !== 'ok') throw new Error('Native migration unavailable');
    return result.data;
  };
  const before = (await call('info'))?.options;
  if (!before || typeof before !== 'object' || Array.isArray(before)) throw new Error('Native migration unavailable');
  // An explicitly supplied native list, including [], always wins.
  if (has(before,'sources')) return {sources:sourceURLs(before.sources),volume:parseOptions(before).volume};
  const desired = {...before,sources:sourceURLs(legacy.sources.map(source => source.url)),volume:initialVolume !== undefined && before.volume !== undefined && before.volume !== initialVolume ? parseOptions(before).volume : legacy.volume};
  await call('options',{options:desired});
  const after = (await call('info'))?.options;
  if (!after || Object.keys(desired).some(key => JSON.stringify(after[key]) !== JSON.stringify(desired[key]))) throw new Error('Native migration not confirmed');
  return {sources:desired.sources,volume:desired.volume};
}

export async function resolveSettings(store, options, {migrate = migrateNativeOptions, log = () => {}} = {}) {
  await store.load();
  let urls = options.sources, volume = options.volume, native = true;
  if (urls === undefined && store.exists) {
    volume = store.value.nativeConfiguration ? options.volume : store.value.volume;
    if (!store.value.nativeConfiguration) {
      let migrated;
      try { migrated = await migrate(store.value,{initialVolume:options.volume}); } catch { /* Preserve effective legacy state on any migration failure. */ }
      if (migrated) {
        urls = migrated.sources; volume = migrated.volume;
        log('Previous sources and volume are now saved in Home Assistant Configuration. Refresh the Configuration tab before editing.');
      } else {
        native = false;
        log('Native configuration migration pending; previous sources, volume and cache retained. Restart to retry, or set sources and volume explicitly in Home Assistant Configuration.');
      }
    }
  }
  const sources = urls === undefined ? store.value.sources : urls.map(url => {
    const previous = store.value.sources.find(source => source.url === url);
    return previous ?? {id:createHash('sha256').update(url).digest('hex').slice(0,24),url,type:driveFolder(url) ? 'drive' : 'direct'};
  });
  const value = {volume,sources,...(native ? {nativeConfiguration:true} : {})};
  if (JSON.stringify(value) !== JSON.stringify(store.value) || !store.exists) await store.save(value);
  return value;
}
