import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOptions } from './settings.mjs';
import { createDiscordAdapter } from './discord.mjs';
import { createApplication } from './application.mjs';

export async function start({dataDir = '/data',optionsPath = path.join(dataDir,'options.json'),log = console.log, onFatal = () => {}} = {}) {
  const options = await readOptions(optionsPath);
  const adapter = createDiscordAdapter({...options,voiceStateFile:path.join(dataDir,'voice-target.json')},{onStatus:({state,error}) => log(`Discord voice: ${state}${error ? ` (${error})` : ''}.`)});
  let app, failed = false;
  const fatal = () => { failed = true; onFatal(); if (app) void app.close().catch(() => log('Radio worker shutdown failed; check private data permissions.')); };
  app = await createApplication({options,dataDir,adapter,log,onFatal:fatal});
  if (failed) await app.close();
  let closing;
  const close = () => closing ??= app.close();
  return {app,close};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await start({onFatal:() => { process.exitCode = 1; }});
    console.log('Radio worker started; manage settings in Home Assistant Configuration (no web server).');
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => { runtime.close().catch(() => { process.exitCode = 1; }); });
  } catch { console.error('Radio startup failed; check add-on Configuration and private data permissions.'); process.exitCode = 1; }
}
