import fs from 'node:fs';
import { ipcCall } from '../shared/ipc.js';
import { paths } from '../shared/paths.js';
import { listenerStatus, sleep } from './common.js';

/** Forget the current WhatsApp session so a new QR code can be scanned. Messages and drafts are kept. */
if (await listenerStatus()) {
  console.log('Stopping the listener…');
  await ipcCall('POST', '/shutdown').catch(() => undefined);
  await sleep(2000);
}
fs.rmSync(paths.auth, { recursive: true, force: true });
fs.rmSync(paths.qrPng, { force: true });
console.log('✅ Old session removed (your saved messages and drafts are kept).');
console.log('   Also remove the old entry on your phone: WhatsApp → Linked devices → tap it → Log out.');
console.log('   Now run "npm run link" and scan the new QR code.');
