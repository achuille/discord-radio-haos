// Real application, isolated empty configuration: never credentials or user data.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const dataDir = await mkdtemp(path.join(tmpdir(), 'radio-ui-'));
await writeFile(path.join(dataDir, 'options.json'), '{}', { mode: 0o600 });
const child = spawn(process.execPath, ['src/index.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, RADIO_DEV_LOOPBACK: '1', RADIO_DATA_DIR: dataDir },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', async error => { await rm(dataDir, { recursive: true, force: true }); throw error; });
child.on('exit', async code => { await rm(dataDir, { recursive: true, force: true }); process.exit(code ?? 0); });
