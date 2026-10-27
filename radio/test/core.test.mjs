import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateConfig } from '../src/core/config.mjs';
import { discoverTracks, ShuffleBag } from '../src/core/library.mjs';
import { RadioState } from '../src/core/state.mjs';
import { createTranscoder } from '../src/core/transcoder.mjs';
import { RadioController } from '../src/core/controller.mjs';
import { runRadio } from '../src/core/radio.mjs';

async function temp(t) { const root = await mkdtemp(path.join(tmpdir(), 'radio-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('config validates paths, finite volume and bounded integer limits', () => {
  assert.equal(validateConfig().volume, 0.6);
  for (const input of [{ volume: NaN }, { volume: 2 }, { musicDir: '../x' }, { maxTracks: 0 }, { scanIntervalMs: '1000' }]) assert.throws(() => validateConfig(input));
});

test('recursive discovery ignores symlinks, hidden and unsupported files and caps results', async t => {
  const root = await temp(t);
  await mkdir(path.join(root, 'nested'));
  await Promise.all(['a.mp3', 'nested/b.FLAC', 'note.txt', '.private.mp3'].map(file => writeFile(path.join(root, file), '')));
  await symlink(path.join(root, 'a.mp3'), path.join(root, 'link.mp3'));
  assert.deepEqual((await discoverTracks(root)).map(file => path.relative(root, file)), ['a.mp3', 'nested/b.FLAC']);
  assert.equal((await discoverTracks(root, { maxTracks: 1 })).length, 1);
  assert.deepEqual(await discoverTracks(path.join(root, 'absent')), []);
});

test('shuffle plays all unique entries per cycle without boundary repeats', () => {
  const bag = new ShuffleBag({ random: () => 0.1 });
  const list = ['a', 'b', 'c']; let previous;
  for (let cycle = 0; cycle < 100; cycle++) {
    const played = [];
    for (let i = 0; i < 3; i++) { const item = bag.next(list); assert.notEqual(item, previous); previous = item; played.push(item); }
    assert.equal(new Set(played).size, 3);
  }
  assert.equal(bag.next([]), null);
  assert.equal(bag.next(['only']), 'only');
  assert.equal(bag.next(['only']), 'only');
});

test('state persists bounded failures, retries with backoff, clears success, tolerates malformed JSON', async t => {
  const root = await temp(t); let now = 100000;
  const file = path.join(root, 'data', 'state.json');
  const state = new RadioState(file, { maxEntries: 2, now: () => now });
  state.failed('a'); assert.equal(state.eligible('a'), false);
  now += 30000; assert.equal(state.eligible('a'), true);
  state.failed('a'); assert.equal(state.failures.get('a').until - now, 60000);
  state.failed('b'); state.failed('c'); assert.equal(state.failures.size, 2);
  state.succeeded('b'); await state.save();
  const loaded = new RadioState(file, { now: () => now }); await loaded.load();
  assert.equal(loaded.last, 'b'); assert.equal(loaded.failures.size, 1);
  loaded.prune([]); assert.equal(loaded.failures.size, 0);
  await writeFile(file, '{broken'); await new RadioState(file).load();
});

test('real FFmpeg decodes generated audio to PCM; filename is never shell evaluated', async t => {
  const root = await temp(t);
  const file = path.join(root, 'tone; touch hacked.wav');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', file]);
  assert.equal(generated.status, 0);
  const pipeline = createTranscoder(file); let bytes = 0;
  for await (const chunk of pipeline.stream) bytes += chunk.length;
  await pipeline.done;
  assert.equal(bytes, 19200);
});

test('FFmpeg missing executable, invalid audio and active cancellation settle safely', async t => {
  const root = await temp(t);
  const bad = path.join(root, 'bad.mp3'); await writeFile(bad, 'not audio');
  for (const options of [{}, { executable: path.join(root, 'missing-ffmpeg') }]) {
    const pipeline = createTranscoder(bad, options); pipeline.stream.resume();
    await assert.rejects(pipeline.done);
  }
  const file = path.join(root, 'long.wav');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', file]).status, 0);
  const controller = new AbortController();
  const pipeline = createTranscoder(file, { signal: controller.signal });
  controller.abort(); await assert.rejects(pipeline.done);
});

test('radio quarantines bad track without a busy loop and persists shutdown state', async t => {
  const root = await temp(t); const controller = new AbortController();
  const events = []; let calls = 0;
  await runRadio({
    config: { musicDir: root, stateFile: path.join(root, 'state.json'), retryDelayMs: 100 }, signal: controller.signal,
    discover: async () => ['bad'],
    transcode: () => ({ stream: {}, done: Promise.reject(new Error('broken decode')), stop: () => {} }),
    play: async () => { calls++; },
    log: (event) => { events.push(event); if (event === 'waiting') controller.abort(); },
  });
  assert.equal(calls, 1); assert.ok(events.includes('track-error'));
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).failures[0].path, 'bad');
});

test('decode failure aborts pending playback and loop shutdown is prompt', async t => {
  const root = await temp(t); const controller = new AbortController(); let playbackAborted = false;
  await runRadio({ config: { musicDir: root, stateFile: path.join(root, 'state.json'), retryDelayMs: 100 }, signal: controller.signal,
    discover: async () => ['bad'],
    transcode: () => ({ stream: {}, done: Promise.reject(new Error('decode')), stop() {} }),
    play: (_stream, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => { playbackAborted = true; resolve(); }, { once: true })),
    log: event => { if (event === 'waiting') controller.abort(); },
  });
  assert.equal(playbackAborted, true);
});


test('radio plays healthy track through failures and persists last successful track', async t => {
  const root = await temp(t); const controller = new AbortController(); let good = 0;
  await runRadio({ config: { musicDir: root, stateFile: path.join(root, 'state.json'), retryDelayMs: 100 }, signal: controller.signal,
    discover: async () => ['bad', 'good'],
    transcode: track => ({ stream: {}, done: track === 'bad' ? Promise.reject(new Error('bad audio')) : Promise.resolve(), stop() {} }),
    play: async (_stream, { track }) => { if (track !== 'bad' && ++good === 2) setTimeout(() => controller.abort(), 10); },
  });
  assert.equal(good, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).last, 'good');
});


test('controller pause, resume and skip cancel without quarantining valid tracks', async t => {
  const root = await temp(t); const stop = new AbortController(); const control = new RadioController(); let plays = 0;
  control.pause();
  const run = runRadio({ config: { musicDir: root, stateFile: path.join(root, 'state.json') }, signal: stop.signal, controller: control,
    discover: async () => ['healthy'],
    transcode: () => ({ stream: {}, done: Promise.resolve(), stop() {} }),
    play: (_stream, { signal }) => new Promise((resolve, reject) => {
      plays++;
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      if (plays === 1) setTimeout(() => control.skip(), 5);
      else setTimeout(() => stop.abort(), 5);
    }),
  });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(plays, 0);
  control.resume(); await run;
  assert.equal(plays, 2); assert.equal(control.snapshot().status, 'stopped');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).failures, []);
});

 test('network playback errors do not quarantine good audio and use retry delay', async t => {
 const root = await temp(t), stop = new AbortController(); let calls=0; const start=Date.now();
 await runRadio({config:{musicDir:root,stateFile:path.join(root,'state.json'),retryDelayMs:100},signal:stop.signal,discover:async()=>['good'],transcode:()=>({stream:{},done:Promise.resolve(),stop(){}}),play:async()=>{calls++; if(calls===2) stop.abort(); throw new Error('network');}});
 assert.equal(calls,2); assert.ok(Date.now()-start>=90); assert.deepEqual(JSON.parse(await readFile(path.join(root,'state.json'),'utf8')).failures,[]);
 });
