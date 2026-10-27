// Offline native dependency smoke tests: no token, socket, Discord API or media fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import opus from '@discordjs/opus';
import davey from '@snazzah/davey';
import { createAudioResource, StreamType } from '@discordjs/voice';

test('native Opus encodes a 20ms 48k stereo s16le PCM frame', () => {
  const encoder = new opus.OpusEncoder(48000, 2);
  const packet = encoder.encode(Buffer.alloc(960 * 2 * 2));
  assert.ok(packet.length > 0);
});
test('modern voice resource transcodes raw PCM into Opus packets offline', async () => {
  const resource = createAudioResource(Readable.from([Buffer.alloc(960 * 2 * 2 * 5)]), { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume.setVolume(0.6);
  try {
    await once(resource.playStream, 'readable');
    assert.ok(resource.read()?.length > 0);
  } finally { resource.playStream.destroy(); }
});
test('DAVE native binding initializes a local session without network traffic', () => {
  assert.ok(davey.DAVE_PROTOCOL_VERSION >= 1);
  const session = new davey.DAVESession(davey.DAVE_PROTOCOL_VERSION, '123456789012345678', '234567890123456789');
  assert.equal(session.protocolVersion, davey.DAVE_PROTOCOL_VERSION);
  session.reset();
});
