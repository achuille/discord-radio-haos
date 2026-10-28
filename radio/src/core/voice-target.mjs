import { mkdir, readFile, rename, lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const validId = value => typeof value === 'string' && /^\d{5,25}$/.test(value);

// Keep the runtime destination separate from HA's bootstrap channel. Changing the
// configured guild/channel intentionally invalidates an older saved destination.
export class VoiceTarget {
  constructor({ voiceStateFile, guildId, channelId }) {
    this.file = voiceStateFile;
    this.guildId = guildId;
    this.configuredChannelId = channelId;
    this.channelId = channelId;
    this.pending = Promise.resolve();
  }
  async load() {
    if (!this.file) return;
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 4096) return;
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version === 1 && value.guildId === this.guildId && value.configuredChannelId === this.configuredChannelId && validId(value.channelId)) this.channelId = value.channelId;
    } catch { /* A missing/damaged private state file must not prevent startup. */ }
  }
  adopt(channelId) {
    if (!validId(channelId) || channelId === this.channelId) return;
    this.channelId = channelId;
    if (!this.file) return;
    this.pending = this.pending.then(async () => {
      // Coalesce rapid moves before writing, and never persist credentials.
      const data = JSON.stringify({ version: 1, guildId: this.guildId, configuredChannelId: this.configuredChannelId, channelId: this.channelId });
      if (data === this.saved) return;
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
        await rename(temp, this.file);
        this.saved = data;
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    }).catch(() => { /* Runtime moves still work if persistent storage is unavailable. */ });
  }
}
