import { EventEmitter } from 'node:events';

// Pause stops decoding; resume starts the next shuffled track (no seek resume).
export class RadioController extends EventEmitter {
  constructor() {
    super();
    this.paused = false;
    this.currentAbort = null;
    this.state = { status: 'starting', track: null, tracks: 0, startedAt: null, error: null, paused: false };
  }
  setVolume(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Volume must be between 0 and 1");
    this.volume = value; this.update({volume:value});
  }
  snapshot() { return { ...this.state }; }
  update(patch) { Object.assign(this.state, patch, { paused: this.paused }); this.emit('change', this.snapshot()); }
  subscribe(listener) { this.on('change', listener); return () => this.off('change', listener); }
  pause() { this.paused = true; this.currentAbort?.(); this.update({ status: 'paused', track: null, startedAt: null }); this.emit('control'); }
  resume() { this.paused = false; this.update({ status: 'waiting' }); this.emit('control'); }
  skip() { this.currentAbort?.(); this.emit('control'); }
  async waitUntilResumed(signal) {
    while (this.paused && !signal?.aborted) {
      await new Promise(resolve => {
        const finish = () => { this.off('control', finish); signal?.removeEventListener('abort', finish); resolve(); };
        this.once('control', finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted || !this.paused) finish();
      });
    }
  }
}
