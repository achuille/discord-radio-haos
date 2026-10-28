// Offline native dependency smoke tests: no token, socket, Discord API or media fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import opus from '@discordjs/opus';
import davey from '@snazzah/davey';
import { createAudioResource, joinVoiceChannel, StreamType } from '@discordjs/voice';

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


test('installed voice library adopts server move packets without a gateway rejoin', () => {
  const sent=[]; let gateway;
  const connection=joinVoiceChannel({guildId:'123456789012345678',channelId:'234567890123456789',group:'offline-move-test',selfDeaf:true,
    adapterCreator:methods=>{gateway=methods; return {sendPayload:payload=>{sent.push(payload); return true;},destroy(){}};}});
  try {
    assert.equal(sent.length,1);
    // No voice-server packet/endpoint is supplied, so this opens no network socket.
    gateway.onVoiceStateUpdate({guild_id:'123456789012345678',user_id:'345678901234567890',channel_id:'456789012345678901',session_id:'offline'});
    assert.equal(sent.length,1);
    connection.rejoin();
    assert.equal(sent[1].d.channel_id,'456789012345678901');
  } finally { connection.destroy(); }
});
