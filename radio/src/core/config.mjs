import path from 'node:path';

export function validateConfig(input = {}) {
  const integer = (name, fallback, min, max) => {
    const value = input[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  const absolute = (name, fallback) => {
    const value = input[name] ?? fallback;
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${name} must be an absolute path`);
    return path.normalize(value);
  };
  const volume = input.volume ?? 0.6;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('volume must be between 0 and 1');
  return Object.freeze({
    musicDir: absolute('musicDir', '/data/audio'),
    stateFile: absolute('stateFile', '/data/radio-state.json'), volume,
    scanIntervalMs: integer('scanIntervalMs', 60000, 1000, 3600000),
    retryDelayMs: integer('retryDelayMs', 10000, 100, 300000),
    maxTrackMs: integer('maxTrackMs', 14400000, 1000, 86400000),
    maxTracks: integer('maxTracks', 10000, 1, 100000),
    maxStateEntries: integer('maxStateEntries', 10000, 1, 100000),
  });
}
