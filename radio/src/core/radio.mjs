import { setTimeout as delay } from 'node:timers/promises';
import { discoverTracks, ShuffleBag } from './library.mjs';
import { RadioState } from './state.mjs';
import { createTranscoder } from './transcoder.mjs';
import { validateConfig } from './config.mjs';
import { RadioController } from './controller.mjs';

// play must consume PCM and settle on natural completion or signal abort.
// It must reject playback/connection failures rather than silently swallowing them.
export async function runRadio({ config: input, play, signal, controller = new RadioController(), log = () => {}, transcode = createTranscoder, discover = discoverTracks, externalVolume = false }) {
  const config = validateConfig(input);
  const state = new RadioState(config.stateFile, { maxEntries: config.maxStateEntries });
  await state.load();
  const bag = new ShuffleBag({ last: state.last });
  let tracks = [], nextScan = 0;
  const save = async () => { try { await state.save(); } catch (error) { log('state-error', { message: error.message }); } };
  try {
    while (!signal?.aborted) {
      await controller.waitUntilResumed(signal);
      if (signal?.aborted) break;
      if (Date.now() >= nextScan) {
        try { tracks = await discover(config.musicDir, { maxTracks: config.maxTracks, signal }); state.prune(tracks); controller.update({ tracks: tracks.length }); }
        catch (error) { if (signal?.aborted) break; log('scan-error', { message: error.message }); }
        nextScan = Date.now() + config.scanIntervalMs;
      }
      const track = bag.next(tracks.filter(item => state.eligible(item)));
      if (!track) {
        controller.update({ status: 'waiting', track: null, startedAt: null });
        log('waiting', { tracks: tracks.length });
        await delay(config.retryDelayMs, undefined, { signal });
        continue;
      }
      let pipeline;
      let decodeFailure = false;
      let connectionFailure = false;
      const trackController = new AbortController();
      const abortTrack = () => trackController.abort();
      signal?.addEventListener('abort', abortTrack, { once: true });
      if (signal?.aborted) abortTrack();
      controller.currentAbort = abortTrack;
      try {
        controller.update({ status: 'playing', track, startedAt: Date.now(), error: null });
        log('playing', { track });
        pipeline = transcode(track, { signal: trackController.signal, volume: externalVolume ? 1 : (controller.volume ?? config.volume), maxTrackMs: config.maxTrackMs });
        // A decode failure cancels playback; a playback failure stops FFmpeg.
        await Promise.all([play(pipeline.stream, { signal: trackController.signal, track }), pipeline.done.catch(error => { if (!trackController.signal.aborted) decodeFailure = true; throw error; })]);
        if (!trackController.signal.aborted) state.succeeded(track);
      } catch (error) {
        if (!trackController.signal.aborted) {
          if (decodeFailure || !pipeline) { state.failed(track); log('track-error', { track, message: error.message }); }
          else { connectionFailure = true; log('playback-error', { message: error.message }); }
          controller.update({ status: 'waiting', error: error.message });
        }
      } finally {
        abortTrack();
        controller.currentAbort = null;
        signal?.removeEventListener('abort', abortTrack);
        pipeline?.stop();
        if (pipeline) await pipeline.done.catch(() => {});
        await save();
      }
      if (!signal?.aborted) await delay(connectionFailure ? config.retryDelayMs : 100, undefined, { signal });
    }
  } catch (error) { if (!signal?.aborted) throw error; }
  finally { controller.currentAbort = null; controller.update({ status: 'stopped', track: null, startedAt: null }); await save(); }
}
