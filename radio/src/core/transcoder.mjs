import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';

// Output is 48 kHz stereo signed 16-bit PCM (Discord StreamType.Raw).
// No shell, network protocols, or user-supplied FFmpeg arguments.
export function createTranscoder(track, { signal, volume = 0.6, maxTrackMs = 14400000, executable = 'ffmpeg' } = {}) {
  signal?.throwIfAborted();
  const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,flac,ogg,wav,mov,matroska,webm,aac', '-i', track, '-vn', '-sn', '-dn', '-af', `volume=${volume}`, '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  const stream = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
  child.stdout.pipe(stream);
  // Keep errors observed even if a consumer detaches while cancelling.
  stream.on('error', () => {});
  child.stdout.on('error', error => stream.destroy(error));
  let detail = '';
  let killed = false;
  let killTimer;
  let timeout;
  child.stderr.on('data', chunk => { detail = (detail + chunk.toString()).slice(-2048); });
  const stop = () => {
    if (killed || child.exitCode !== null || child.signalCode !== null) return;
    killed = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  };
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(killTimer); clearTimeout(timeout); signal?.removeEventListener('abort', stop);
      if (code === 0 && !killed && bytes > 0) resolve();
      else reject(new Error(killed ? 'Transcoding cancelled or exceeded time limit' : `FFmpeg exited ${code}: ${detail}`));
    });
  });
  // Consumers may not await until the playback promise completes.
  done.catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  timeout = setTimeout(stop, maxTrackMs); timeout.unref();
  if (signal?.aborted) stop();
  return { stream, done, stop };
}
