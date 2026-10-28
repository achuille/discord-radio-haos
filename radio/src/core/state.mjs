import { readFile, mkdir, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export class RadioState {
  constructor(file, { maxEntries = 10000, now = Date.now } = {}) { this.file = file; this.maxEntries = maxEntries; this.now = now; this.last = null; this.failures = new Map(); }
  async load() {
    try {
      if ((await stat(this.file)).size > 4 * 1024 * 1024) return;
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1) return;
      this.last = typeof data.last === 'string' && data.last.length <= 4096 ? data.last : null;
      for (const item of (Array.isArray(data.failures) ? data.failures : []).slice(-this.maxEntries)) {
        if (typeof item.path === 'string' && item.path.length <= 4096 && Number.isSafeInteger(item.count) && item.count > 0 && Number.isFinite(item.until)) this.failures.set(item.path, { count: Math.min(item.count, 16), until: Math.min(item.until, this.now() + 3600000) });
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  eligible(track) { return (this.failures.get(track)?.until ?? 0) <= this.now(); }
  failed(track) {
    const count = Math.min((this.failures.get(track)?.count ?? 0) + 1, 16);
    this.failures.delete(track);
    this.failures.set(track, { count, until: this.now() + Math.min(30000 * 2 ** (count - 1), 3600000) });
    while (this.failures.size > this.maxEntries) this.failures.delete(this.failures.keys().next().value);
  }
  succeeded(track) { this.failures.delete(track); this.last = track; }
  prune(tracks) { const valid = new Set(tracks); for (const track of this.failures.keys()) if (!valid.has(track)) this.failures.delete(track); }
  async save() {
    const data = JSON.stringify({ version: 1, last: this.last, failures: [...this.failures].map(([file, value]) => ({ path: file, ...value })) });
    if (data === this.saved) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, this.file);
    this.saved = data;
  }
}
