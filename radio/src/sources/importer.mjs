import { mkdir, readdir, readFile, writeFile, lstat, open as openFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPublic, publicURL } from './network.mjs';
import { driveFolder, listDriveFiles } from './drive.mjs';
const execute = promisify(execFile);
const rootLocks = new Map();
function safeError(error) {
  const message = String(error?.message ?? '');
  if (/^(Source returned HTTP \d{3}|Audio (cache byte limit reached|exceeds byte limit|validation failed \(ffprobe required\))|Cache file count limit reached|Empty audio response|Drive download size differs from listing|Downloaded content is not a supported audio container|File has no finite playable audio|Source returned a web page, login\/confirmation page or error instead of audio|Public Drive listing format changed|Drive folder may be paginated; use folders with fewer than 50 entries|Drive recursion depth limit exceeded|Drive folder count limit exceeded|Source file count limit exceeded|Response exceeds byte limit|Private network URLs are forbidden|Source resolves to a private or reserved network|Too many redirects|HTTPS downgrade forbidden)$/.test(message)) return message;
  if (message.startsWith('Public Drive listing unavailable:')) return 'Public Drive listing unavailable: folder must be public; login and CAPTCHA are unsupported';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'Source request timed out or was cancelled';
  return 'Source request or local cache operation failed';
}
const hash = value => createHash('sha256').update(value).digest('hex');
export const DEFAULT_LIMITS = Object.freeze({maxSources:20,maxFiles:500,maxFileBytes:256*1024*1024,maxCacheBytes:2*1024*1024*1024,maxDepth:3,maxFolders:50});
export function normalizeSources(values) {
  if (!Array.isArray(values) || values.length > DEFAULT_LIMITS.maxSources) throw new Error('Sources must be an array of at most 20 URLs');
  return [...new Set(values.map(value => publicURL(typeof value === 'string' ? value : value?.url).href))];
}
export async function validateAudio(file, {signal} = {}) {
  const handle = await openFile(file,'r');
  const prefix = Buffer.alloc(16);
  try { await handle.read(prefix,0,16,0); } finally { await handle.close(); }
  const ascii = prefix.toString('ascii');
  if (!(ascii.startsWith('ID3') || ascii.startsWith('fLaC') || ascii.startsWith('OggS') || ascii.startsWith('RIFF') || ascii.slice(4,8) === 'ftyp' || (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0) || prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))) throw new Error('Downloaded content is not a supported audio container');
  let result;
  try {
    result = await execute('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mp3,flac,ogg,wav,mov,matroska,webm,aac','-show_entries','stream=codec_type:format=duration','-of','json',file], {timeout:15000,maxBuffer:1024*1024,signal});
  } catch { throw new Error('Audio validation failed (ffprobe required)'); }
  const data = JSON.parse(result.stdout);
  if (!data.streams?.some(stream => stream.codec_type === 'audio') || !Number.isFinite(Number(data.format?.duration)) || Number(data.format.duration) <= 0) throw new Error('File has no finite playable audio');
  return {duration:Number(data.format.duration)};
}
async function cacheState(root, recursive = false) {
  await mkdir(root,{recursive:true,mode:0o700});
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Cache directory must not be a symlink');
  let bytes = 0; const tracks = [];
  const pending = [root]; let count = 0;
  while (pending.length) {
  const directory = pending.pop();
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (++count > 10000) throw new Error('Cache directory entry limit exceeded');
    if (entry.isDirectory() && recursive) { pending.push(path.join(directory,entry.name)); continue; }
    if (!entry.isFile()) { if (entry.isSymbolicLink()) throw new Error('Cache must not contain symlinks'); continue; }
    const file = path.join(directory,entry.name), stat = await lstat(file);
    bytes += stat.size;
    if (/^[a-f0-9]{64}\.mp3$/.test(entry.name)) tracks.push(file);
  }
  }
  return {bytes,tracks};
}
export async function readCachedFiles(cacheDir) {
  const root = path.resolve(cacheDir);
  const cache = await cacheState(root);
  let metadata = {};
  try {
    const file = path.join(root,'.metadata.json');
    if ((await lstat(file)).size <= 1024*1024) metadata = JSON.parse(await readFile(file,'utf8'));
  } catch { /* Cache remains playable without display metadata. */ }
  return cache.tracks.sort().map(file => ({path:file,id:path.basename(file,'.mp3'),title:metadata?.[path.basename(file)]?.title || 'Audio',duration:metadata?.[path.basename(file)]?.duration ?? null}));
}
export class SourceImporter {
  constructor({cacheDir = '/data/audio', cacheRoot = cacheDir, limits = {}, open = openPublic, probe = validateAudio} = {}) {
    this.cacheDir = path.resolve(cacheDir); this.cacheRoot = path.resolve(cacheRoot);
    if (this.cacheDir !== this.cacheRoot && !this.cacheDir.startsWith(this.cacheRoot + path.sep)) throw new Error('Cache directory must be inside cache root');
    this.open = open; this.probe = probe;
    this.limits = {...DEFAULT_LIMITS,...limits}; this.running = null;
    for (const [key,value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > (DEFAULT_LIMITS[key] ?? 0)) throw new Error(`Invalid source limit: ${key}`);
  }
  sync(sources, options = {}) {
    if (this.running) return this.running;
    const prior = rootLocks.get(this.cacheRoot) ?? Promise.resolve();
    this.running = prior.catch(() => {}).then(() => this.perform(sources,options)).finally(() => {
      if (rootLocks.get(this.cacheRoot) === this.running) rootLocks.delete(this.cacheRoot);
      this.running = null;
    });
    rootLocks.set(this.cacheRoot,this.running);
    return this.running;
  }
  async perform(sources, {signal, refreshDirect = true} = {}) {
    const urls = normalizeSources(sources);
    if (urls.length > this.limits.maxSources) throw new Error('Source count limit exceeded');
    const global = await cacheState(this.cacheRoot,true);
    const cache = await cacheState(this.cacheDir), report = {imported:0,cached:0,errors:[],sources:[],tracks:cache.tracks};
    const metadataPath = path.join(this.cacheDir,'.metadata.json');
    let metadata = {};
    try {
      if ((await lstat(metadataPath)).size <= 1024*1024) metadata = JSON.parse(await readFile(metadataPath,'utf8'));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
    } catch { /* Missing or damaged metadata never destroys audio. */ }
    let metadataChanged = false;
    let remainingFiles = this.limits.maxFiles;
    for (const [index,url] of urls.entries()) {
      signal?.throwIfAborted();
      const source = {index,imported:0,cached:0,errors:[]}; report.sources.push(source);
      try {
        const entries = driveFolder(url) ? await listDriveFiles(url,{open:this.open,signal,...this.limits,maxFiles:remainingFiles}) : [{url}];
        for (const entry of entries) {
          signal?.throwIfAborted();
          if (--remainingFiles < 0) throw new Error('Source file count limit exceeded');
          const file = path.join(this.cacheDir,`${hash(entry.url)}.mp3`);
          const key = path.basename(file), previous = metadata[key];
          const existing = cache.tracks.includes(file);
          const previousBytes = existing ? (await lstat(file)).size : 0;
          const changed = existing && ((refreshDirect && !driveFolder(url)) || (entry.size != null && (entry.size !== previousBytes || (previous?.modifiedAt && entry.modifiedAt && previous.modifiedAt !== entry.modifiedAt))));
          if (existing && !changed) { source.cached++; report.cached++; continue; }
          try {
            if (!existing && global.tracks.length >= this.limits.maxFiles) throw new Error('Cache file count limit reached');
            const budget = Math.min(this.limits.maxFileBytes,this.limits.maxCacheBytes-global.bytes-4096-Buffer.byteLength(JSON.stringify(metadata)));
            if (budget <= 0 || (entry.size && entry.size > budget)) throw new Error('Audio cache byte limit reached');
            const response = await this.open(entry.url,{signal,timeoutMs:120000});
            const length = Number(response.headers['content-length']);
            if (Number.isFinite(length) && length > budget) { response.body.destroy?.(); throw new Error('Audio exceeds byte limit'); }
            const contentType = (response.headers['content-type'] || '').toLowerCase();
            if (contentType.includes('text/html') || contentType.includes('application/json')) { response.body.destroy?.(); throw new Error('Source returned a web page, login/confirmation page or error instead of audio'); }
            const temporary = path.join(this.cacheDir,`.download-${randomUUID()}`);
            let bytes = 0, handle;
            try {
              handle = await openFile(temporary,'wx',0o600);
              for await (const chunk of response.body) {
                signal?.throwIfAborted(); bytes += chunk.length;
                if (bytes > budget) throw new Error('Audio exceeds byte limit');
                await handle.writeFile(chunk);
              }
              await handle.sync(); await handle.close(); handle = null;
              if (!bytes) throw new Error('Empty audio response');
              if (entry.size !== undefined && entry.size !== null && bytes !== entry.size) throw new Error('Drive download size differs from listing');
              const media = await this.probe(temporary,{signal});
              await rename(temporary,file);
              cache.bytes += bytes - previousBytes; global.bytes += bytes - previousBytes;
              if (!existing) { global.tracks.push(file); cache.tracks.push(file); }
              metadata[key] = {id:hash(entry.url),title:(entry.name || path.basename(new URL(entry.url).pathname) || 'Audio').slice(0,300),duration:media?.duration ?? null,bytes,modifiedAt:entry.modifiedAt ?? null};
              metadataChanged = true; source.imported++; report.imported++;
            } finally { response.body.destroy?.(); await handle?.close(); await unlink(temporary).catch(() => {}); }
          } catch (error) {
            signal?.throwIfAborted();
            source.errors.push(safeError(error));
          }
        }
      } catch (error) { signal?.throwIfAborted(); source.errors.push(safeError(error)); }
      // Never disclose remote file names, URLs or query secrets in UI/log errors.
      if (source.errors.length) report.errors.push({index,message:source.errors[0],count:source.errors.length});
    }
    if (metadataChanged) {
      const temporary = path.join(this.cacheDir,`.metadata-${randomUUID()}`);
      try { await writeFile(temporary,JSON.stringify(metadata),{mode:0o600,flag:'wx'}); await rename(temporary,metadataPath); }
      finally { await unlink(temporary).catch(() => {}); }
    }
    report.tracks = cache.tracks.sort();
    report.files = report.tracks.map(file => ({path:file,id:path.basename(file,'.mp3'),title:metadata[path.basename(file)]?.title || 'Audio',duration:metadata[path.basename(file)]?.duration ?? null}));
    return report;
  }
}
