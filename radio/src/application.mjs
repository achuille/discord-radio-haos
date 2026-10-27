import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, lstat, statfs, rm } from 'node:fs/promises';
import { SettingsStore } from './settings.mjs';
import { RadioController } from './core/controller.mjs';
import { runRadio } from './core/radio.mjs';
import { discoverTracks } from './core/library.mjs';
import { SourceImporter, normalizeSources, readCachedFiles } from './sources/importer.mjs';
import { driveFolder } from './sources/drive.mjs';

const idFor = value => createHash('sha256').update(value).digest('hex').slice(0,24);
const bad = (status, message) => Object.assign(new Error(message), {status});
async function diskBytes(root) {
  let total = 0, entries = 0; const pending = [root];
  while (pending.length) {
    for (const entry of await readdir(pending.pop(), {withFileTypes:true}).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (++entries > 20000) throw new Error('Cache entry limit');
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unsafe cache entry');
      if (entry.isDirectory()) pending.push(file); else if (entry.isFile()) total += (await lstat(file)).size;
    }
  }
  return total;
}
export async function createApplication({options, dataDir = '/data', adapter, importerFactory = config => new SourceImporter(config), radio = runRadio, periodicMs = 15*60*1000}) {
  const store = new SettingsStore(path.join(dataDir, 'settings.json'), {volume:options.volume});
  await store.load();
  const cacheDir = path.join(dataDir, 'audio'); await mkdir(cacheDir, {recursive:true, mode:0o700});
  const controller = new RadioController(); controller.setVolume(store.value.volume); adapter.setVolume?.(store.value.volume);
  const configured = Boolean(options.token && options.guildId && options.channelId);
  const lifetime = new AbortController();
  const sourceState = new Map(), metadata = new Map(), pending = new Set(), refresh = new Set(), activeImports = new Map(), removing = new Set(); let worker = null, stopped = false, tracks = [], playAbort, playTask = Promise.resolve(), restart = Promise.resolve();
  const active = () => store.value.sources;
  const directory = source => path.join(cacheDir, source.id);
  const eligible = track => active().some(source => track.startsWith(directory(source) + path.sep));
  async function scan(_root, {signal} = {}) {
    const result = [];
    for (const source of active()) {
      result.push(...await discoverTracks(directory(source), {signal, maxTracks:500}));
      for (const file of await readCachedFiles(directory(source)).catch(() => [])) if (eligible(file.path)) metadata.set(file.path,file);
    }
    tracks = result.filter(eligible).slice(0,10000);
    const known = new Set(tracks); for (const file of metadata.keys()) if (!known.has(file)) metadata.delete(file);
    return tracks;
  }
  function startPlayback() {
    restart = restart.then(async () => {
      playAbort?.abort(); await playTask;
      if (stopped || !configured) return;
      playAbort = new AbortController();
      playTask = radio({controller, externalVolume:true, signal:playAbort.signal, discover:scan,
        config:{musicDir:cacheDir,stateFile:path.join(dataDir,'radio-state.json'),volume:store.value.volume,scanIntervalMs:options.scanIntervalMs,maxTrackMs:options.maxTrackMs},
        play:async (stream, context) => {
          context.signal?.throwIfAborted();
          if (!eligible(context.track)) throw new Error('source_removed');
          controller.update({status:'connecting',startedAt:null});
          let abort;
          try {
            await Promise.race([adapter.connect(),new Promise((_,reject) => {
              abort = () => reject(new Error('playback_interrupted'));
              context.signal?.addEventListener('abort',abort,{once:true});
              if (context.signal?.aborted) abort();
            })]);
          } finally { if (abort) context.signal?.removeEventListener('abort',abort); }
          context.signal?.throwIfAborted();
          if (!eligible(context.track)) throw new Error('source_removed');
          controller.update({status:'playing',startedAt:Date.now()});
          return adapter.play(stream,context);
        },
        log:() => {}}).catch(() => { controller.update({status:'error'}); });
    });
    return restart;
  }
  async function runSync() {
    while (pending.size && !stopped) {
      const id = pending.values().next().value; pending.delete(id);
      const refreshDirect = refresh.delete(id);
      const source = active().find(item => item.id === id); if (!source) continue;
      sourceState.set(id,{state:'syncing',error:null});
      const importAbort = new AbortController();
      const cancel = () => importAbort.abort();
      lifetime.signal.addEventListener('abort',cancel,{once:true});
      let settled; const done = new Promise(resolve => {settled = resolve;});
      activeImports.set(id,{abort:cancel,done});
      try {
        const total = await diskBytes(cacheDir);
        const space = await statfs(cacheDir);
        const available = Math.min(2*1024**3-total, Number(space.bavail)*Number(space.bsize)-256*1024**2);
        const budget = Math.min(2*1024**3,total+available);
        if (budget <= total) throw new Error('Cache capacity reached');
        const importer = importerFactory({cacheDir:directory(source),cacheRoot:cacheDir,limits:{maxCacheBytes:Math.floor(budget),maxFileBytes:256*1024**2,maxFiles:500}});
        const report = await importer.sync([source],{signal:importAbort.signal,refreshDirect});
        if (active().some(item => item.id === id)) sourceState.set(id,{state:report.errors.length ? 'error' : 'ready',error:report.errors.length ? 'Some audio could not be imported; existing cache retained.' : null});
      } catch { if (!stopped && active().some(item => item.id === id)) sourceState.set(id,{state:'error',error:'Import failed or cache limit reached; existing cache retained.'}); }
      finally {
        lifetime.signal.removeEventListener('abort',cancel);
        activeImports.delete(id); settled();
      }
      await scan(null,{signal:lifetime.signal}).catch(() => {});
    }
  }
  function sync(id, {refreshDirect = true} = {}) {
    if (id && !active().some(source => source.id === id)) throw bad(404,'Source not found');
    for (const source of active()) if (!id || source.id === id) { pending.add(source.id); if(refreshDirect) refresh.add(source.id); }
    if (!worker && !stopped) worker = runSync().finally(() => { worker = null; });
  }
  await scan();
  const timer = setInterval(() => sync(),periodicMs); timer.unref();
  // The ingress starts independently of login and initial imports.
  if (configured) { void adapter.connect().catch(() => {}); void startPlayback(); }
  sync();
  return {
    status() {
      const playback = controller.snapshot();
      return {configured,connection:{state:configured ? adapter.status().state : 'setup_required',channel: options.channelId || null},
        playback:{state:controller.paused ? 'paused' : configured ? playback.status : 'stopped',title:playback.track && eligible(playback.track) ? metadata.get(playback.track)?.title || 'Cached audio' : null,elapsed:playback.startedAt ? Math.max(0,(Date.now()-playback.startedAt)/1000) : 0,duration:metadata.get(playback.track)?.duration || null,volume:store.value.volume},
        sources:active().map(source => ({...source,state:sourceState.get(source.id)?.state || 'idle',error:sourceState.get(source.id)?.error || null,count:tracks.filter(track => track.startsWith(directory(source)+path.sep)).length})),
        tracks:tracks.filter(eligible).map(track => ({id:idFor(track),title:metadata.get(track)?.title || 'Cached audio'}))};
    },
    async control(action,value) {
      if (action === 'volume') { await store.save({...store.value,volume:value}); controller.setVolume(value); adapter.setVolume?.(value); }
      else controller[action]();
    },
    async addSource(url) {
      let normalized; try { [normalized] = normalizeSources([url]); } catch { throw bad(400,'Use a public HTTPS audio or Google Drive folder URL'); }
      if (removing.has(idFor(normalized))) throw bad(409,'Source removal is still finishing');
      if (active().length >= 20) throw bad(400,'Maximum 20 sources');
      if (active().some(source => source.url === normalized)) throw bad(409,'Source already exists');
      const source = {id:idFor(normalized),url:normalized,type:driveFolder(normalized) ? 'drive' : 'direct'};
      await store.save({...store.value,sources:[...active(),source]}); sync(source.id); return source;
    },
    async removeSource(id) {
      if (!active().some(source => source.id === id)) throw bad(404,'Source not found');
      removing.add(id);
      try {
        await store.save({...store.value,sources:active().filter(source => source.id !== id)});
        pending.delete(id); refresh.delete(id); sourceState.delete(id); tracks = tracks.filter(eligible);
        const task = activeImports.get(id); task?.abort();
        await startPlayback();
        await task?.done;
        const target = path.join(cacheDir,id);
        if (!/^[a-f0-9]{24}$/.test(id) || path.dirname(target) !== cacheDir) throw new Error('Unsafe cache directory');
        await rm(target,{recursive:true,force:true});
        for (const file of metadata.keys()) if (file.startsWith(target+path.sep)) metadata.delete(file);
      } finally { removing.delete(id); }
    },
    sync,
    async close() { stopped = true; clearInterval(timer); lifetime.abort(); playAbort?.abort(); await adapter.close(); await Promise.allSettled([worker,playTask,restart,store.pending]); },
  };
}
