import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { openDraftsDb } from '../shared/db.js';
import { listDrafts } from '../shared/drafts.js';
import { paths } from '../shared/paths.js';
import { listenerStatus } from './common.js';

const s = await listenerStatus();
let cfgLine = '';
try {
  const c = loadConfig();
  cfgLine =
    `Mode:          ${c.autoSend ? 'AUTO-SEND (Claude can send directly)' : 'DRAFTS ONLY (you approve every message)'}\n` +
    `Kill switch:   ${c.killSwitch ? 'ON ⛔ (nothing can be sent)' : 'off'}\n` +
    `Allowlist:     ${c.allowlist.chats.length} chat(s), ${c.allowlist.groups.length} group(s)\n` +
    `Limits:        ${c.limits.perChatPerHour}/chat/hour, ${c.limits.globalPerHour}/hour total`;
} catch (err) {
  cfgLine = `Config:        ⚠️  ${(err as Error).message}`;
}

let pending = 0;
if (fs.existsSync(paths.draftsDb)) {
  const db = openDraftsDb();
  pending = listDrafts(db, 'pending').length;
  db.close();
}

console.log('WhatsApp connector status');
console.log('-------------------------');
if (!s) {
  console.log('Listener:      NOT RUNNING  →  start it with "npm run start"');
  if (!fs.existsSync(`${paths.auth}/creds.json`)) console.log('               (not linked yet → run "npm run link" first)');
} else {
  const conn =
    s.connection === 'open' ? `connected ✅ as ${s.linkedAs}` :
    s.connection === 'logged_out' ? 'LOGGED OUT → run "npm run relink" then "npm run link"' :
    s.connection === 'needs_link' ? 'NOT LINKED YET → waiting for the QR code to be scanned ("npm run link")' :
    `${s.connection} (reconnecting automatically)${s.lastError ? ` — last error: ${s.lastError}` : ''}`;
  console.log(`Listener:      running (process ${s.pid}, since ${new Date(s.startedAt).toLocaleString()})`);
  console.log(`WhatsApp:      ${conn}`);
  console.log(`Sent (1 hour): ${s.sentLastHour} / ${s.globalPerHour}`);
}
console.log(cfgLine);
console.log(`Pending drafts: ${pending}${pending ? '  →  review with "npm run drafts"' : ''}`);
console.log(`Data folder:   ${paths.root}`);
