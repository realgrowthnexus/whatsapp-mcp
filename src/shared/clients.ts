import type { DB } from './db.js';
import { isBroadcastLike, isGroupJid, isSkippedNumber } from './jid.js';
import { displayName, phoneForChat, type ChatRow } from './queries.js';

export { SKIPPED_COUNTRY_CODES, isSkippedNumber } from './jid.js';

export interface ClientCandidate {
  name: string;
  entry: string;
  jid: string;
}

export interface ClientScan {
  clients: ClientCandidate[];
  /** Chats whose phone number is hidden by WhatsApp (privacy ID only): country unknown, so not allowed. */
  unknownNumber: number;
}

/**
 * Clients = one-to-one chats with a phone number that does NOT start with +92.
 * Groups, broadcasts, your own number and chats whose number is unknown are skipped.
 */
export function clientChats(db: DB): ClientScan {
  const me = ((db.prepare("SELECT value FROM meta WHERE key = 'linked_as'").get() as { value: string } | undefined)?.value ?? '').replace(/\D/g, '');
  const rows = db.prepare('SELECT * FROM chats ORDER BY last_ts DESC').all() as ChatRow[];
  const clients: ClientCandidate[] = [];
  let unknownNumber = 0;
  for (const c of rows) {
    if (isGroupJid(c.jid) || isBroadcastLike(c.jid)) continue;
    const phone = phoneForChat(db, c.jid)?.replace('+', '') ?? null;
    if (!phone) { unknownNumber++; continue; }
    if (phone === me || isSkippedNumber(phone)) continue;
    clients.push({ name: displayName(db, c.jid, c.name), entry: phone, jid: c.jid });
  }
  return { clients, unknownNumber };
}
