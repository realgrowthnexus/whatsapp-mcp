import { loadConfig } from '../shared/config.js';
import { openWaDbReadonly } from '../shared/db.js';
import { chatIsAllowed, displayName, phoneForChat, type ChatRow } from '../shared/queries.js';
import { toLocalIso } from '../shared/time.js';
import { die } from './common.js';

/**
 * Local helper (NOT available to Claude): list your chats with their numbers / group IDs
 * so you can copy them into the allowlist.   npm run chats [-- --groups] [-- --all]
 */
let db;
try { db = openWaDbReadonly(); } catch (err) { die((err as Error).message); }
const config = loadConfig();
const groupsOnly = process.argv.includes('--groups');
const limit = process.argv.includes('--all') ? 100000 : 50;
const rows = (db.prepare('SELECT * FROM chats ORDER BY last_ts DESC').all() as ChatRow[])
  .filter((c) => (groupsOnly ? c.is_group : true))
  .slice(0, limit);

console.log('Allowed  Last activity        Name                           Allowlist entry');
console.log('-------  -------------------  -----------------------------  ------------------------------');
for (const c of rows) {
  const allowed = chatIsAllowed(db, config, c.jid) ? '  ✅   ' : '       ';
  const entry = c.is_group ? c.jid : (phoneForChat(db, c.jid)?.replace('+', '') ?? c.jid);
  const when = c.last_ts ? toLocalIso(c.last_ts).slice(0, 16).replace('T', ' ') : '';
  console.log(`${allowed}  ${when.padEnd(19)}  ${displayName(db, c.jid, c.name).slice(0, 29).padEnd(29)}  ${entry}${c.is_group ? '  (group)' : ''}`);
}
console.log('\nCopy numbers into "allowlist.chats" (and group IDs into "allowlist.groups") in config.json.');
