import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceImporter } from '../src/sources/importer.mjs';
import { openPublic, responseValidators } from '../src/sources/network.mjs';
import { runRadio } from '../src/core/radio.mjs';
import { RadioController } from '../src/core/controller.mjs';
import { RadioState } from '../src/core/state.mjs';
import { createApplication } from '../src/application.mjs';

const source = 'https://example.com/music.mp3';
const etag = '"audio-v1"';
const modified = 'Wed, 21 Oct 2015 07:28:00 GMT';
const response = (content, headers = {}, statusCode = 200) => ({
  statusCode, headers, url:source, body:Readable.from([Buffer.from(content)]),
});
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'radio-efficiency-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  return dir;
}

test('conditional refresh reuses audio without decoding or rewriting unchanged cache', async t => {
  const dir = await temp(t);
  let requests = 0, probes = 0;
  const options = {
    cacheDir:dir,
    open:async (_url, {validators}) => {
      requests++;
      if (requests === 1) {
        assert.equal(validators,undefined);
        return response('first',{'etag':etag,'last-modified':modified});
      }
      assert.deepEqual(validators,responseValidators(source,{'etag':etag,'last-modified':modified}));
      return response('',{},304);
    },
    probe:async () => { probes++; return {duration:1}; },
  };
  const initial = await new SourceImporter(options).sync([source]);
  const audio = initial.tracks[0], metadata = path.join(dir,'.metadata.json');
  const audioBefore = await stat(audio,{bigint:true}), metadataBefore = await stat(metadata,{bigint:true});
  // New instances exercise persisted validators, including process restarts.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await new SourceImporter(options).sync([source]);
    assert.equal(result.cached,1); assert.equal(result.imported,0);
    assert.deepEqual(result.errors,[]);
  }
  assert.equal(requests,4); assert.equal(probes,1);
  assert.equal((await stat(audio,{bigint:true})).mtimeNs,audioBefore.mtimeNs);
  assert.equal((await stat(metadata,{bigint:true})).mtimeNs,metadataBefore.mtimeNs);
  assert.equal(await readFile(audio,'utf8'),'first');
  assert.equal((await readdir(dir)).length,2);
});

test('changed direct audio still refreshes, and failed refresh retains valid cached audio', async t => {
  const dir = await temp(t);
  let version = 1, probes = 0;
  const importer = new SourceImporter({cacheDir:dir,
    open:async () => response(`version-${version}`,{etag:`"version-${version}"`}),
    probe:async () => { probes++; if (version === 3) throw Error('bad new file'); return {duration:1}; },
  });
  const first = await importer.sync([source]);
  version = 2;
  const second = await importer.sync([source]);
  assert.equal(second.imported,1); assert.equal(await readFile(first.tracks[0],'utf8'),'version-2');
  version = 3;
  const third = await importer.sync([source]);
  assert.equal(third.errors.length,1); assert.equal(await readFile(first.tracks[0],'utf8'),'version-2');
  assert.equal(probes,3);
  const metadata = JSON.parse(await readFile(path.join(dir,'.metadata.json'),'utf8'));
  assert.equal(metadata[path.basename(first.tracks[0])].http.etag,'"version-2"');
});

test('servers without validators are refreshed, not silently cached forever', async t => {
  const dir = await temp(t);
  let requests = 0, probes = 0;
  const importer = new SourceImporter({cacheDir:dir,
    open:async (_url,{validators}) => { assert.equal(validators,undefined); return response(String(++requests)); },
    probe:async () => { probes++; return {duration:1}; },
  });
  await importer.sync([source]);
  const next = await importer.sync([source]);
  assert.equal(requests,2); assert.equal(probes,2);
  assert.equal(await readFile(next.tracks[0],'utf8'),'2');
});

test('conditional cache hits need no free write budget, while changed bodies remain bounded', async t => {
  const dir = await temp(t);
  let statusCode = 304, requests = 0;
  const first = await new SourceImporter({cacheDir:dir,open:async () => response('audio',{etag}),probe:async () => ({duration:1})}).sync([source]);
  const importer = new SourceImporter({cacheDir:dir,limits:{maxCacheBytes:1},
    open:async () => { requests++; return response('changed',{},statusCode); },
    probe:async () => { throw Error('must not decode'); },
  });
  const cached = await importer.sync([source]);
  assert.equal(cached.cached,1); assert.deepEqual(cached.errors,[]);
  statusCode = 200;
  const changed = await importer.sync([source]);
  assert.equal(changed.errors.length,1); assert.equal(requests,2);
  assert.equal(await readFile(first.tracks[0],'utf8'),'audio');
  assert.equal((await readdir(dir)).length,2);
});

test('application startup and periodic sync keep conditional revalidation enabled', {timeout:3000}, async t => {
  const dir = await temp(t), id = createHash('sha256').update(source).digest('hex').slice(0,24);
  const cacheRoot = path.join(dir,'audio'), cacheDir = path.join(cacheRoot,id);
  let probes = 0, completed = 0, release;
  const refreshed = new Promise(resolve => { release = resolve; });
  const probe = async () => { probes++; return {duration:1}; };
  await new SourceImporter({cacheDir,cacheRoot,probe,open:async () => response('audio',{etag})}).sync([source]);
  const flags = [];
  const app = await createApplication({dataDir:dir,options:{sources:[source],volume:0.6,token:''},periodicMs:20,
    adapter:{status:() => ({state:'disconnected'}),close:async () => {}},
    importerFactory:config => {
      const importer = new SourceImporter({...config,probe,open:async (_url,{validators}) => {
        assert.equal(validators.etag,etag); return response('',{},304);
      }});
      return {sync:async (sources,options) => {
        flags.push(options.refreshDirect);
        const result = await importer.sync(sources,options);
        assert.equal(result.cached,1); assert.deepEqual(result.errors,[]);
        if (++completed >= 3) release();
        return result;
      }};
    },
  });
  t.after(() => app.close());
  await refreshed; await app.close();
  assert.ok(completed >= 3); assert.ok(flags.every(flag => flag === true));
  assert.equal(probes,1);
});

test('cache validators are scoped to exact final resource across redirects', async () => {
  const start = 'https://example.com/redirect', target = 'https://cdn.example.com/music.mp3';
  const validators = responseValidators(target,{etag,'last-modified':modified});
  const requests = [];
  const result = await openPublic(start,{
    validators, lookup:async () => [{address:'8.8.8.8',family:4}],
    request:(url,options,callback) => {
      requests.push({url:url.href,headers:options.headers});
      const request = new EventEmitter();
      queueMicrotask(() => callback({statusCode:url.href === start ? 302 : 304,
        headers:url.href === start ? {location:target} : {},destroy(){}}));
      return request;
    },
  });
  assert.equal(result.statusCode,304);
  assert.equal(requests[0].headers['if-none-match'],undefined);
  assert.equal(requests[0].headers['if-modified-since'],undefined);
  assert.equal(requests[1].headers['if-none-match'],etag);
  assert.equal(requests[1].headers['if-modified-since'],modified);
  assert.equal(requests[1].headers.authorization,undefined);
  assert.equal(JSON.stringify(validators).includes(target),false);
});

test('unsolicited 304 and unsafe validators cannot bypass download validation', async t => {
  assert.equal(responseValidators(source,{etag:'*','last-modified':'invalid'}),undefined);
  assert.equal(responseValidators(source,{'last-modified':'Invalid Date'}),undefined);
  assert.equal(responseValidators(source,{etag:'"x"\r\nAuthorization: leaked'}),undefined);
  await assert.rejects(openPublic(source,{
    lookup:async () => [{address:'8.8.8.8',family:4}],
    request:(_url,_options,callback) => {
      const request = new EventEmitter();
      queueMicrotask(() => callback({statusCode:304,headers:{},destroy(){}}));
      return request;
    },
  }),/HTTP 304/);
  const dir = await temp(t);
  const importer = new SourceImporter({cacheDir:dir,open:async () => response('',{},304),probe:async () => {throw Error('must not probe');}});
  const result = await importer.sync([source]);
  assert.equal(result.errors.length,1); assert.deepEqual(result.tracks,[]);
});

test('readiness is established before any transcoder is created', {timeout:3000}, async t => {
  const dir = await temp(t), abort = new AbortController();
  t.after(() => abort.abort());
  let prepared = false, decoders = 0, plays = 0;
  await runRadio({config:{musicDir:dir,stateFile:path.join(dir,'state.json')},signal:abort.signal,
    discover:async () => ['healthy'],
    prepare:async ({signal,track}) => { assert.equal(track,'healthy'); assert.equal(signal.aborted,false); prepared = true; },
    transcode:() => { assert.equal(prepared,true); decoders++; return {stream:{},done:Promise.resolve(),stop(){}}; },
    play:async () => { plays++; abort.abort(); },
  });
  assert.equal(decoders,1); assert.equal(plays,1);
});

test('native application runs real radio preparation before decoding and cancels it on close', {timeout:3000}, async t => {
  const dir = await temp(t), id = createHash('sha256').update(source).digest('hex').slice(0,24);
  const cacheRoot = path.join(dir,'audio'), cacheDir = path.join(cacheRoot,id);
  await new SourceImporter({cacheDir,cacheRoot,open:async () => response('cached-audio'),probe:async () => ({duration:1})}).sync([source]);
  let entered, preparations = 0, decoders = 0, voicePlays = 0;
  const preparing = new Promise(resolve => { entered = resolve; });
  const adapter = {
    waitUntilConnected:({signal}) => {
      preparations++; entered();
      return new Promise((_,reject) => {
        const abort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort',abort,{once:true});
        if (signal.aborted) abort();
      });
    },
    connect:async () => { throw Error('application must use readiness-aware connection'); },
    play:async () => { voicePlays++; },
    status:() => ({state:'reconnecting'}), close:async () => {},
  };
  const app = await createApplication({dataDir:dir,
    options:{sources:[source],volume:0.6,token:'OFFLINE_TEST_TOKEN',guildId:'12345678901234567',channelId:'12345678901234567'},
    adapter, importerFactory:() => ({sync:async () => ({errors:[]})}),
    // Run the actual engine, replacing only process creation with an observable
    // boundary. A missing/miswired application prepare hook fails this test.
    radio:options => runRadio({...options,transcode:() => {
      decoders++; return {stream:{},done:Promise.resolve(),stop(){}};
    }}),
  });
  t.after(() => app.close());
  await preparing; await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.status().playback.state,'connecting');
  assert.equal(preparations,1); assert.equal(decoders,0); assert.equal(voicePlays,0);
  await app.close();
  assert.equal(decoders,0); assert.equal(voicePlays,0);
});

test('connection readiness failures do not start FFmpeg or quarantine cached tracks', {timeout:3000}, async t => {
  const dir = await temp(t), abort = new AbortController();
  t.after(() => abort.abort());
  let attempts = 0, decoders = 0, plays = 0;
  await runRadio({config:{musicDir:dir,stateFile:path.join(dir,'state.json'),retryDelayMs:100},signal:abort.signal,
    discover:async () => ['healthy'],
    prepare:async () => { if (++attempts === 2) abort.abort(); throw Error('offline'); },
    transcode:() => { decoders++; return {stream:{},done:Promise.resolve(),stop(){}}; },
    play:async () => { plays++; },
  });
  assert.equal(attempts,2); assert.equal(decoders,0); assert.equal(plays,0);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).failures,[]);
});

test('pause keeps decoding idle and shutdown aborts pending readiness before spawning', {timeout:3000}, async t => {
  const dir = await temp(t), abort = new AbortController(), controller = new RadioController();
  t.after(() => abort.abort());
  controller.pause();
  let ready, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let decoders = 0, attempts = 0;
  const pending = runRadio({config:{musicDir:dir,stateFile:path.join(dir,'state.json')},signal:abort.signal,controller,
    discover:async () => ['healthy'],
    prepare:({signal}) => { attempts++; entered(); return new Promise((_,reject) => {
      ready = () => reject(new Error('closed'));
      signal.addEventListener('abort',ready,{once:true});
    }); },
    transcode:() => { decoders++; return {stream:{},done:Promise.resolve(),stop(){}}; },
    play:async () => {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts,0); assert.equal(decoders,0);
  controller.resume(); await started; abort.abort(); await pending;
  assert.equal(attempts,1); assert.equal(decoders,0);
  assert.equal(controller.listenerCount('control'),0);
  assert.equal(controller.currentAbort,null);
});

test('unchanged playback state is not rewritten on every retry or shutdown', async t => {
  const dir = await temp(t), file = path.join(dir,'state.json');
  const state = new RadioState(file);
  state.succeeded('healthy'); await state.save();
  const initial = await stat(file,{bigint:true});
  for (let attempt = 0; attempt < 10; attempt++) await state.save();
  assert.equal((await stat(file,{bigint:true})).mtimeNs,initial.mtimeNs);
  state.failed('broken'); await state.save();
  assert.equal(JSON.parse(await readFile(file,'utf8')).failures.length,1);
});
