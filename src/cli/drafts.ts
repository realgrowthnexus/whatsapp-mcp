import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { audit } from '../shared/audit.js';
import { openDraftsDb, openWaDbReadonly, type DB } from '../shared/db.js';
import { listDrafts, transitionDraft } from '../shared/drafts.js';
import { ipcCall, IpcError, type SendResult } from '../shared/ipc.js';
import { displayName, getChat } from '../shared/queries.js';
import { toLocalIso } from '../shared/time.js';

/** Review drafts in the terminal: approve (send), discard or skip each one. */
const drafts = openDraftsDb();
let wa: DB | undefined;
try { wa = openWaDbReadonly(); } catch { /* names will show as IDs */ }
const nameOf = (jid: string) => (wa ? displayName(wa, jid, getChat(wa, jid)?.name) : jid);

const pending = listDrafts(drafts, 'pending');
if (!pending.length) {
  console.log('No drafts waiting for approval.');
  process.exit(0);
}

const rl = readline.createInterface({ input, output });
console.log(`${pending.length} draft(s) waiting for approval.\n`);
for (const d of pending) {
  console.log('────────────────────────────────────────────');
  console.log(`Draft #${d.id}  →  ${nameOf(d.chat_jid)}   (${toLocalIso(d.created_at).slice(0, 16).replace('T', ' ')})`);
  if (d.error) console.log(`(last attempt failed: ${d.error})`);
  console.log('');
  console.log(d.text);
  console.log('');
  const answer = (await rl.question('[a] approve & send   [d] discard   [s] skip   [q] quit  > ')).trim().toLowerCase();
  if (answer === 'q') break;
  if (answer === 'd') {
    if (transitionDraft(drafts, d.id, 'pending', 'discarded', { via: 'terminal' })) {
      audit({ event: 'draft_discarded', chat: d.chat_jid, chatName: nameOf(d.chat_jid), text: d.text, draftId: d.id, via: 'terminal' });
      console.log('🗑️  Discarded.\n');
    } else console.log('That draft was already handled.\n');
    continue;
  }
  if (answer === 'a') {
    console.log('Sending (shows "typing…" for a few seconds first)…');
    try {
      const r = await ipcCall<SendResult>('POST', '/send', { draftId: d.id, via: 'terminal' });
      console.log(`✅ Sent at ${new Date(r.sentAt).toLocaleTimeString()}.\n`);
    } catch (err) {
      console.log(`❌ Not sent: ${err instanceof IpcError ? err.message : (err as Error).message}\n`);
    }
    continue;
  }
  console.log('Skipped.\n');
}
rl.close();
