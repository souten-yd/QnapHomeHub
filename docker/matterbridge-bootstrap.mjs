import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeStorageManager } from 'matterbridge/storage';

async function readSecret() {
  const file = process.env.MATTERBRIDGE_PASSWORD_FILE;
  if (file) {
    try { return (await fs.readFile(file, 'utf8')).trim(); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return (process.env.MATTERBRIDGE_PASSWORD ?? '').trim();
}

const password = await readSecret();
if (!password) {
  console.log('Matterbridge password secret is empty; leaving frontend password unchanged.');
  process.exit(0);
}

const home = process.env.MATTERBRIDGE_HOMEDIR ?? '/data';
const storageDir = path.join(home, '.matterbridge', 'storage');
await fs.mkdir(storageDir, { recursive: true });

const manager = new NodeStorageManager({
  dir: storageDir,
  writeQueue: false,
  expiredInterval: undefined,
  logging: false,
});
try {
  const context = await manager.createStorage('matterbridge');
  await context.set('password', password);
  await context.close();
  console.log('Matterbridge frontend password synchronized from Docker secret.');
} finally {
  await manager.close();
}
