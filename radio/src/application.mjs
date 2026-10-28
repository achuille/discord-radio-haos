import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, lstat, statfs } from 'node:fs/promises';
import { SettingsStore, resolveSettings } from './settings.mjs';
import { RadioController } from './core/controller.mjs';
import { runRadio } from './core/radio.mjs';
import { discoverTracks } from './core/library.mjs';
import { SourceImporter } from './sources/importer.mjs';

const idFor = value => createHash('sha256').update(value).digest('hex').slice(0,24);
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
export async function createApplication({options, dataDir = '/data', adapter, importerFactory = config => new SourceImporter(config), radio = runRadio, periodicMs = options.syncIntervalMs ?? 15*60*1000, log = () => {}, migrate, onFatal = () => {}}) {
  const store = new SettingsStore(path.join(dataDir, 'settings.json'), {volume:options.volume});
  await resolveSettings(store,options,{log,...(migrate ? {migrate} : {})});
  const cacheDir = path.join(dataDir, 'audio'); await mkdir(cacheDir, {recursive:true, mode:0o700});
  const controller = new RadioController(); controller.setVolume(store.value.volume); adapter.setVolume?.(store.value.volume);
  const configured = Boolean(options.token && options.guildId && options.channelId);
  const playbackEnabled = options.playbackEnabled !== false;
  const lifetime = new AbortController();
  const sourceState = new Map(), pending = new Set(), refresh = new Set(); let worker = null, stopped = false, tracks = [], playAbort, playTask = Promise.resolve(), restart = Promise.resolve();
  const radioMessages = {waiting:'Waiting for playable cached audio.',playing:'Audio playback active.', 'scan-error':'Local audio scan failed; retrying.', 'track-error':'An audio file failed validation or playback; trying another track.', 'playback-error':'Voice playback interrupted; waiting for recovery.', 'state-error':'Playback state could not be saved; check private data permissions.'};
  const lastLog = new Map();
  const radioLog = event => {
    if (!radioMessages[event]) return;
    const now = Date.now();
    if (now - (lastLog.get(event) ?? -Infinity) < 5*60*1000) return;
    lastLog.set(event,now); log(radioMessages[event]);
  };
  const active = () => store.value.sources;
  const directory = source => path.join(cacheDir, source.id);
  const eligible = track => active().some(source => track.startsWith(directory(source) + path.sep));
  async function scan(_root, {signal} = {}) {
    const result = [];
    for (const source of active()) {
      result.push(...await discoverTracks(directory(source), {signal, maxTracks:500}));
    }
    tracks = result.filter(eligible).slice(0,10000);
    return tracks;
  }
  function startPlayback() {
    restart = restart.then(async () => {
      playAbort?.abort(); await playTask;
      if (stopped || !configured || !playbackEnabled) return;
      playAbort = new AbortController();
      playTask = radio({controller, externalVolume:true, signal:playAbort.signal, discover:scan,
        config:{musicDir:cacheDir,stateFile:path.join(dataDir,'radio-state.json'),volume:store.value.volume,scanIntervalMs:options.scanIntervalMs,maxTrackMs:options.maxTrackMs},
        prepare:async context => {
          context.signal?.throwIfAborted();
          if (!eligible(context.track)) throw new Error('source_removed');
          controller.update({status:'connecting',startedAt:null});
          let abort;
          try {
            await Promise.race([adapter.waitUntilConnected ? adapter.waitUntilConnected({signal:context.signal}) : adapter.connect(),new Promise((_,reject) => {
              abort = () => reject(new Error('playback_interrupted'));
              context.signal?.addEventListener('abort',abort,{once:true});
              if (context.signal?.aborted) abort();
            })]);
          } finally { if (abort) context.signal?.removeEventListener('abort',abort); }
          context.signal?.throwIfAborted();
          if (!eligible(context.track)) throw new Error('source_removed');
        },
        play:async (stream,context) => {
          context.signal?.throwIfAborted();
          if (!eligible(context.track)) throw new Error('source_removed');
          controller.update({status:'playing',startedAt:Date.now()});
          return adapter.play(stream,context);
        },
        log:radioLog}).catch(() => { if (!stopped) { controller.update({status:'error'}); log('Radio worker failed unexpectedly; stopping for Supervisor recovery.'); onFatal(); } });
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
      try {
        const total = await diskBytes(cacheDir);
        const space = await statfs(cacheDir);
        const available = Math.min(2*1024**3-total, Number(space.bavail)*Number(space.bsize)-256*1024**2);
        const budget = Math.min(2*1024**3,total+available);
        if (budget < 1) throw new Error('Cache capacity reached');
        const importer = importerFactory({cacheDir:directory(source),cacheRoot:cacheDir,limits:{maxCacheBytes:Math.floor(budget),maxFileBytes:256*1024**2,maxFiles:500}});
        const report = await importer.sync([source],{signal:importAbort.signal,refreshDirect});
        if (active().some(item => item.id === id)) sourceState.set(id,{state:report.errors.length ? 'error' : 'ready',error:report.errors.length ? 'Some audio could not be imported; existing cache retained.' : null});
        log(report.errors.length ? 'Source import incomplete; existing cache retained.' : 'Source synchronization complete.');
      } catch { if (!stopped && active().some(item => item.id === id)) { sourceState.set(id,{state:'error',error:'Import failed or cache limit reached; existing cache retained.'}); log('Source import failed or cache limit reached; existing cache retained.'); } }
      finally {
        lifetime.signal.removeEventListener('abort',cancel);
      }
      await scan(null,{signal:lifetime.signal}).catch(() => {});
    }
  }
  function sync(id, {refreshDirect = true} = {}) {
    if (id && !active().some(source => source.id === id)) throw new Error('Source not found');
    for (const source of active()) if (!id || source.id === id) { pending.add(source.id); if(refreshDirect) refresh.add(source.id); }
    if (!worker && !stopped) worker = runSync().finally(() => { worker = null; });
  }
  await scan();
  const timer = setInterval(() => sync(),periodicMs);
  // No listening socket. The sync timer keeps the worker alive even before setup.
  if (configured && playbackEnabled) void startPlayback();
  else log(configured ? 'Playback disabled in Home Assistant Configuration.' : 'Discord setup incomplete; configure the token and IDs in Home Assistant.');
  sync();
  return {
    status() {
      const playback = controller.snapshot();
      return {configured,connection:{state:configured ? adapter.status().state : 'setup_required',channel: adapter.status().channelId || options.channelId || null},
        playback:{state:controller.paused ? 'paused' : configured && playbackEnabled ? playback.status : 'stopped',title:playback.track && eligible(playback.track) ? 'Cached audio' : null,elapsed:playback.startedAt ? Math.max(0,(Date.now()-playback.startedAt)/1000) : 0,duration:null,volume:store.value.volume},
        sources:active().map(source => ({...source,state:sourceState.get(source.id)?.state || 'idle',error:sourceState.get(source.id)?.error || null,count:tracks.filter(track => track.startsWith(directory(source)+path.sep)).length})),
        tracks:tracks.filter(eligible).map(track => ({id:idFor(track),title:'Cached audio'}))};
    },
    sync,
    async close() { stopped = true; clearInterval(timer); lifetime.abort(); playAbort?.abort(); await adapter.close(); await Promise.allSettled([worker,playTask,restart,store.pending]); },
  };
}
