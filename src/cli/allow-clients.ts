import { loadConfig, patchConfigFile } from '../shared/config.js';
import { clientChats } from '../shared/clients.js';
import { openWaDbReadonly } from '../shared/db.js';
import { paths } from '../shared/paths.js';
import { die } from './common.js';

/**
 * Local helper (NOT available to Claude): add your clients to "allowlist.chats":
 * every one-to-one chat EXCEPT numbers starting with +92. Groups stay hidden.
 * Existing entries are kept.
 *   npm run allow-clients             add them
 *   npm run allow-clients -- --dry-run   only show what would be added
 * Run it again any time to add new clients.
 */
let db;
try { db = openWaDbReadonly(); } catch (err) { die((err as Error).message); }
const config = loadConfig();
const dryRun = process.argv.includes('--dry-run');

const existing = new Set(config.allowlist.chats.map((e) => e.trim()));
const { clients: found, unknownNumber } = clientChats(db);
const added = found.filter((c) => !existing.has(c.entry));

if (!found.length) {
  console.log('No client chats (non +92 numbers) found yet. (Wait a minute after linking for chats to download, then run this again.)');
  process.exit(0);
}

for (const c of found) console.log(`${existing.has(c.entry) ? '  (already allowed)' : '  + allow          '}  ${c.name.slice(0, 32).padEnd(32)}  ${c.entry}`);

if (dryRun) {
  console.log(`\n${added.length} chat(s) would be added. Nothing was changed (--dry-run).`);
} else if (added.length) {
  const raw = config.allowlist;
  patchConfigFile({ allowlist: { ...raw, chats: [...config.allowlist.chats, ...added.map((c) => c.entry)] } });
  loadConfig(); // make sure the file is still valid
  console.log(`\n✅ Claude can now see ${added.length} more chat(s) (${existing.size + added.length} in total).`);
  console.log(`   To remove one, delete its number from "allowlist" -> "chats" in ${paths.config}`);
} else {
  console.log('\n✅ All client chats were already allowed. Nothing changed.');
}
if (unknownNumber) {
  console.log(`ℹ️  ${unknownNumber} chat(s) were skipped because WhatsApp hides their phone number (country unknown).`);
  console.log('   Run this again later: once WhatsApp shares their number, they will be added (unless it is +92).');
}
