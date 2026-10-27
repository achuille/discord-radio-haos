import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readOptions(file = '/data/options.json') {
  let input;
  try { input = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') input = {}; else throw new Error('Cannot read add-on configuration'); }
  const number = (key, fallback, min, max, integer = false) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${key}`);
    return value;
  };
  const token = typeof input.discord_token === 'string' ? input.discord_token.trim() : '';
  const id = key => { const v = input[key] ?? ''; if (typeof v !== 'string' || (v && !/^\d{16,22}$/.test(v))) throw new Error(`Invalid ${key}`); return v; };
  if (input.auth_mode && input.auth_mode !== 'selfbot') throw new Error('Only selfbot authentication is supported');
  return { token, guildId: id('guild_id'), channelId: id('voice_channel_id'), authMode: 'selfbot',
    volume: number('volume', 0.6, 0, 1), scanIntervalMs: number('scan_interval_seconds', 60, 1, 3600, true) * 1000,
    maxTrackMs: number('max_track_seconds', 14400, 1, 86400, true) * 1000 };
}

export class SettingsStore {
  constructor(file, { volume = 0.6 } = {}) { this.file = file; this.value = { volume, sources: [] }; this.pending = Promise.resolve(); }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!value || typeof value.volume !== 'number' || value.volume < 0 || value.volume > 1 || !Array.isArray(value.sources) || value.sources.length > 50) throw new Error('Invalid settings');
      const sources = value.sources.map(s => {
        if (!s || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id) || typeof s.url !== 'string' || s.url.length > 2048 || !['drive', 'direct'].includes(s.type)) throw new Error('Invalid source');
        return { id: s.id, url: s.url, type: s.type };
      });
      if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Duplicate source');
      this.value = { volume: value.volume, sources };
      await chmod(this.file, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read private radio settings'); }
    return this.value;
  }
  save(value = this.value) {
    const safe = { volume: value.volume, sources: value.sources.map(({id,url,type}) => ({id,url,type})) };
    this.value = safe;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(safe), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
      await chmod(this.file, 0o600);
    });
    return this.pending;
  }
}
