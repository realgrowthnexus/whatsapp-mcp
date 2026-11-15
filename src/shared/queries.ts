import type { Config } from './config.js';
import type { DB } from './db.js';
import { digitsOnly, isAllowed, isGroupJid, phoneOf, userPart } from './jid.js';
import { toLocalIso } from './time.js';

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  unread_count: number;
  last_ts: number;
}

export interface MessageRow {
  chat_jid: string;
  id: string;
  from_me: number;
  sender_jid: string | null;
  sender_name: string | null;
  ts: number;
  type: string;
  text: string | null;
  media_kind: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_seconds: number | null;
  media_path: string | null;
  transcript: string | null;
  is_read: number;
  sent_by: string | null;
}

interface ContactRow {
  jid: string;
  phone: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
  verified_name: string | null;
}

export class ChatNotFoundError extends Error {}

export function pnForLid(db: DB, jid: string): string | null {
  if (!jid.endsWith('@lid')) return null;
  const row = db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(jid) as { pn: string } | undefined;
  return row?.pn ?? null;
}

function contactFor(db: DB, jid: string): ContactRow | undefined {
  return db
    .prepare('SELECT * FROM contacts WHERE jid = ? OR lid = ? OR phone = ? LIMIT 1')
    .get(jid, jid, phoneOf(jid) ?? '__none__') as ContactRow | undefined;
}

export function displayName(db: DB, jid: string, chatName?: string | null): string {
  if (chatName) return chatName;
  const c = contactFor(db, jid);
  const name = c?.name || c?.verified_name || c?.notify;
  if (name) return name;
  const pn = phoneOf(jid) ?? phoneOf(pnForLid(db, jid));
  return pn ? `+${pn}` : jid;
}

export function phoneForChat(db: DB, jid: string): string | null {
  const pn = phoneOf(jid) ?? phoneOf(pnForLid(db, jid));
  return pn ? `+${pn}` : null;
}

export function chatIsAllowed(db: DB, config: Config, jid: string): boolean {
  return isAllowed(config, jid, pnForLid(db, jid));
}

/** All chats (with activity) that the allowlist lets Claude see. */
export function allowedChats(db: DB, config: Config): ChatRow[] {
  const rows = db.prepare('SELECT * FROM chats ORDER BY last_ts DESC').all() as ChatRow[];
  return rows.filter((r) => chatIsAllowed(db, config, r.jid));
}

export function getChat(db: DB, jid: string): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as ChatRow | undefined;
}

export function hasInbound(db: DB, jid: string): boolean {
  return !!db.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND from_me = 0 LIMIT 1').get(jid);
}

export function countSentSince(db: DB, sinceSec: number, chatJid?: string): number {
  const row = chatJid
    ? (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at >= ? AND chat_jid = ?').get(sinceSec, chatJid) as { n: number })
    : (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at >= ?').get(sinceSec) as { n: number });
  return row.n;
}

/**
 * Turn whatever Claude passed ("+92 300 1234567", "Ali Khan", a chat id) into an
 * allowlisted chat JID — or a clear error.
 */
export function resolveChat(db: DB, config: Config, input: string): string {
  const q = input.trim();
  if (!q) throw new ChatNotFoundError('Chat is required (a phone number, contact name or chat_id).');
  const chats = allowedChats(db, config);

  if (q.includes('@')) {
    if (chats.some((c) => c.jid === q)) return q;
    throw new ChatNotFoundError(`Chat "${q}" was not found or is not in the allowlist.`);
  }

  const digits = digitsOnly(q);
  if (digits.length >= 6 && digits.length === q.replace(/[\s+\-()]/g, '').length) {
    const hit = chats.find((c) => {
      const pn = phoneOf(c.jid) ?? phoneOf(pnForLid(db, c.jid));
      return pn === digits;
    });
    if (hit) return hit.jid;
    throw new ChatNotFoundError(
      `No allowlisted chat with number +${digits}. Claude can only use existing chats that are listed in config.json "allowlist".`,
    );
  }

  const named = chats.map((c) => ({ jid: c.jid, name: displayName(db, c.jid, c.name) }));
  const lower = q.toLowerCase();
  const exact = named.filter((n) => n.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!.jid;
  const partial = exact.length > 1 ? exact : named.filter((n) => n.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!.jid;
  if (partial.length > 1) {
    const list = partial.slice(0, 10).map((p) => `${p.name} (${p.jid})`).join('; ');
    throw new ChatNotFoundError(`"${q}" matches several chats: ${list}. Please use the chat_id.`);
  }
  throw new ChatNotFoundError(`No allowlisted chat matches "${q}".`);
}

export interface MessageView {
  id: string;
  time: string;
  from: string;
  text: string;
  type: string;
  unread?: boolean;
  sent_by_claude?: boolean;
  media?: { kind: string; mime: string | null; filename: string | null; seconds: number | null; downloaded_path: string | null };
  transcript?: string;
}

export function viewMessage(db: DB, m: MessageRow, chatName?: string): MessageView {
  let from: string;
  if (m.from_me) from = 'me';
  else if (isGroupJid(m.chat_jid)) from = m.sender_name || (m.sender_jid ? displayName(db, m.sender_jid) : 'unknown');
  else from = chatName ?? displayName(db, m.chat_jid);
  const v: MessageView = { id: m.id, time: toLocalIso(m.ts), from, text: m.text ?? '', type: m.type };
  if (!m.from_me && !m.is_read) v.unread = true;
  if (m.sent_by === 'claude') v.sent_by_claude = true;
  if (m.media_kind) {
    v.media = {
      kind: m.media_kind,
      mime: m.media_mime,
      filename: m.media_filename,
      seconds: m.media_seconds,
      downloaded_path: m.media_path,
    };
  }
  if (m.transcript) v.transcript = m.transcript;
  return v;
}

export function lastMessage(db: DB, jid: string): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(jid) as
    | MessageRow
    | undefined;
}

export function listChats(db: DB, config: Config, opts: { limit: number; unreadOnly?: boolean }) {
  let chats = allowedChats(db, config);
  if (opts.unreadOnly) chats = chats.filter((c) => c.unread_count > 0);
  return chats.slice(0, opts.limit).map((c) => {
    const name = displayName(db, c.jid, c.name);
    const last = lastMessage(db, c.jid);
    return {
      chat_id: c.jid,
      name,
      phone: phoneForChat(db, c.jid),
      is_group: !!c.is_group,
      unread_count: c.unread_count,
      last_activity: c.last_ts ? toLocalIso(c.last_ts) : null,
      last_message: last ? viewMessage(db, last, name) : null,
    };
  });
}

export function getUnread(db: DB, config: Config, perChatLimit: number) {
  const chats = allowedChats(db, config);
  const out: { chat_id: string; name: string; unread_count: number; messages: MessageView[] }[] = [];
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE chat_jid = ? AND from_me = 0 AND is_read = 0 ORDER BY ts DESC, rowid DESC LIMIT ?',
  );
  for (const c of chats) {
    const rows = stmt.all(c.jid, perChatLimit) as MessageRow[];
    if (!rows.length) continue;
    const name = displayName(db, c.jid, c.name);
    out.push({
      chat_id: c.jid,
      name,
      unread_count: Math.max(c.unread_count, rows.length),
      messages: rows.reverse().map((m) => viewMessage(db, m, name)),
    });
  }
  return out;
}

export function readChat(db: DB, jid: string, opts: { limit: number; before?: number; after?: number }) {
  const where = ['chat_jid = ?'];
  const args: (string | number)[] = [jid];
  if (opts.before !== undefined) { where.push('ts < ?'); args.push(opts.before); }
  if (opts.after !== undefined) { where.push('ts > ?'); args.push(opts.after); }
  // When only "after" is given, return the OLDEST messages after that date; otherwise the newest.
  const order = opts.after !== undefined && opts.before === undefined ? 'ASC' : 'DESC';
  const rows = db
    .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ts ${order}, rowid ${order} LIMIT ?`)
    .all(...args, opts.limit) as MessageRow[];
  if (order === 'DESC') rows.reverse();
  const chat = getChat(db, jid);
  const name = displayName(db, jid, chat?.name);
  return { chat_id: jid, name, phone: phoneForChat(db, jid), messages: rows.map((m) => viewMessage(db, m, name)) };
}

/** Make arbitrary user text safe for FTS5 MATCH: every word becomes a quoted prefix term. */
export function ftsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean);
  return terms.map((t) => `"${t}"*`).join(' ');
}

export function searchMessages(db: DB, config: Config, query: string, opts: { chatJid?: string; limit: number }) {
  const fts = ftsQuery(query);
  if (!fts) throw new Error('Search query is empty.');
  const allowed = opts.chatJid ? [opts.chatJid] : allowedChats(db, config).map((c) => c.jid);
  if (!allowed.length) return [];
  const rows = db
    .prepare(
      `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
       WHERE messages_fts MATCH ? AND m.chat_jid IN (SELECT value FROM json_each(?))
       ORDER BY m.ts DESC LIMIT ?`,
    )
    .all(fts, JSON.stringify(allowed), opts.limit) as MessageRow[];
  return rows.map((m) => {
    const chat = getChat(db, m.chat_jid);
    const name = displayName(db, m.chat_jid, chat?.name);
    return { chat_id: m.chat_jid, chat_name: name, ...viewMessage(db, m, name) };
  });
}

export function findContacts(db: DB, config: Config, query: string) {
  const q = query.trim().toLowerCase();
  const digits = digitsOnly(query);
  return allowedChats(db, config)
    .filter((c) => !c.is_group)
    .map((c) => {
      const contact = contactFor(db, c.jid);
      return {
        chat_id: c.jid,
        name: displayName(db, c.jid, c.name),
        saved_name: contact?.name ?? null,
        whatsapp_name: contact?.notify ?? null,
        business_name: contact?.verified_name ?? null,
        phone: phoneForChat(db, c.jid),
      };
    })
    .filter((c) => {
      if (digits.length >= 4 && c.phone && digitsOnly(c.phone).includes(digits)) return true;
      return [c.name, c.saved_name, c.whatsapp_name, c.business_name].some((n) => n?.toLowerCase().includes(q));
    });
}

export function getMessage(db: DB, chatJid: string, id: string): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND id = ?').get(chatJid, id) as MessageRow | undefined;
}

export { userPart };
