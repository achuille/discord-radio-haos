import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOptions } from './settings.mjs';
import { createDiscordAdapter } from './discord.mjs';
import { createApplication } from './application.mjs';
import { createServer, listen } from './server.mjs';

export async function start({dataDir = '/data', optionsPath = path.join(dataDir,'options.json'), dev = false, port = 8080} = {}) {
  const options = await readOptions(optionsPath);
  const adapter = createDiscordAdapter(options);
  const app = await createApplication({options,dataDir,adapter});
  const server = createServer({app,dev,publicDir:fileURLToPath(new URL('../public/',import.meta.url))});
  try { await listen(server,{dev,port}); }
  catch (error) { await app.close(); throw error; }
  let closing;
  const close = () => closing ??= (async () => { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await app.close(); await stopped; })();
  return {app,server,close};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await start({dev:process.env.RADIO_DEV_LOOPBACK === '1',dataDir:process.env.RADIO_DEV_LOOPBACK === '1' ? (process.env.RADIO_DATA_DIR || '/data') : '/data'});
    console.log('Radio control service started');
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => { runtime.close().catch(() => { process.exitCode = 1; }); });
  } catch { console.error('Radio startup failed; check add-on configuration and private data permissions.'); process.exitCode = 1; }
}
