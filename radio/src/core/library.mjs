import { opendir } from 'node:fs/promises';
import path from 'node:path';
const AUDIO = new Set(['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.webm']);

// Symlinks are deliberately ignored: an uploaded link must not expose host files.
export async function discoverTracks(root, { maxTracks = 10000, signal } = {}) {
  const tracks = [];
  const pending = [root];
  let directories = 0;
  while (pending.length && tracks.length < maxTracks) {
    signal?.throwIfAborted();
    if (++directories > 10000) throw new Error('Music directory scan exceeds 10000 directories');
    const directory = pending.pop();
    let entries;
    try { entries = await opendir(directory); }
    catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) continue; throw error; }
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (pending.length < 10000) pending.push(fullPath); }
      else if (entry.isFile() && AUDIO.has(path.extname(entry.name).toLowerCase())) tracks.push(fullPath);
      if (tracks.length >= maxTracks) break;
    }
  }
  return tracks.sort();
}

export class ShuffleBag {
  constructor({ random = Math.random, last = null } = {}) { this.random = random; this.last = last; this.bag = []; this.signature = ''; }
  next(tracks) {
    const unique = [...new Set(tracks)].sort();
    const signature = JSON.stringify(unique);
    if (signature !== this.signature) { this.bag = []; this.signature = signature; }
    if (!unique.length) return null;
    if (!this.bag.length) {
      this.bag = [...unique];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      const end = this.bag.length - 1;
      if (end > 0 && this.bag[end] === this.last) [this.bag[0], this.bag[end]] = [this.bag[end], this.bag[0]];
    }
    this.last = this.bag.pop();
    return this.last;
  }
}
