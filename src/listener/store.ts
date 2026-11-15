import type { Chat, ChatUpdate, Contact, WAMessage, WAMessageKey } from 'baileys';
import type { DB } from '../shared/db.js';
import { isGroupJid, isLidJid, isPnJid } from '../shared/jid.js';
import { parseMessage, serialiseMessage, timestampOf } from './parse.js';

const cleanJid = (jid: string | null | undefined): string | undefined => {
  if (!jid) return undefined;
  // strip device suffix: 92300...:12@s.whatsapp.net -> 92300...@s.whatsapp.net
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  const user = jid.slice(0, at).split(':')[0];
  return `${user}${jid.slice(at)}`;
};

/**
 * Everything the listener writes to wa.db goes through this class.
 */
export class Store {
  constructor(readonly db: DB) {}

  // ---------- identity (phone number <-> privacy LID) ----------

  pnFor(lid: string): string | undefined {
    const row = this.db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(lid) as { pn: string } | undefined;
    return row?.pn;
  }

  /** The JID we file a chat under: the phone-number JID when known, else the LID. */
  canonical(rawJid: string, alt?: string | null): string {
    const jid = cleanJid(rawJid)!;
    const altJid = cleanJid(alt);
    if (isLidJid(jid)) {
      if (altJid && isPnJid(altJid)) {
        this.addLidMapping(jid, altJid);
        return altJid;
      }
      return this.pnFor(jid) ?? jid;
    }
    if (isPnJid(jid) && altJid && isLidJid(altJid)) this.addLidMapping(altJid, jid);
    return jid;
  }

  addLidMapping(lidRaw: string, pnRaw: string): void {
    const lid = cleanJid(lidRaw)!;
    const pn = cleanJid(pnRaw)!;
    if (!isLidJid(lid) || !isPnJid(pn)) return;
    const existing = this.pnFor(lid);
    if (existing === pn) return;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(lid, pn);
      // Merge anything previously filed under the LID into the phone-number chat.
      const lidChat = this.db.prepare('SELECT * FROM chats WHERE jid = ?').get(lid) as
        | { name: string | null; unread_count: number; last_ts: number }
        | undefined;
      if (lidChat) {
        this.db
          .prepare(
            `INSERT INTO chats (jid, name, is_group, unread_count, last_ts) VALUES (?, ?, 0, ?, ?)
             ON CONFLICT(jid) DO UPDATE SET name = COALESCE(chats.name, excluded.name),
               unread_count = chats.unread_count + excluded.unread_count,
               last_ts = MAX(chats.last_ts, excluded.last_ts)`,
          )
          .run(pn, lidChat.name, lidChat.unread_count, lidChat.last_ts);
        this.db.prepare('DELETE FROM chats WHERE jid = ?').run(lid);
      }
      this.db.prepare('UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
      this.db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(lid);
      this.db.prepare('UPDATE outbox SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
      this.db.prepare('UPDATE contacts SET lid = ? WHERE jid = ? OR phone = ?').run(lid, pn, pn.split('@')[0]);
    })();
  }

  // ---------- contacts & chats ----------

  upsertContacts(contacts: Partial<Contact>[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO contacts (jid, phone, lid, name, notify, verified_name) VALUES (@jid, @phone, @lid, @name, @notify, @verified)
       ON CONFLICT(jid) DO UPDATE SET
         phone = COALESCE(excluded.phone, contacts.phone),
         lid = COALESCE(excluded.lid, contacts.lid),
         name = COALESCE(excluded.name, contacts.name),
         notify = COALESCE(excluded.notify, contacts.notify),
         verified_name = COALESCE(excluded.verified_name, contacts.verified_name)`,
    );
    this.db.transaction(() => {
      for (const c of contacts) {
        if (!c.id) continue;
        const id = cleanJid(c.id)!;
        if (isGroupJid(id)) continue;
        const lid = cleanJid(c.lid) ?? (isLidJid(id) ? id : undefined);
        const pnJ = cleanJid(c.phoneNumber) ?? (isPnJid(id) ? id : undefined);
        if (lid && pnJ) this.addLidMapping(lid, pnJ);
        const jid = pnJ ?? id;
        stmt.run({
          jid,
          phone: pnJ ? pnJ.split('@')[0] : null,
          lid: lid ?? null,
          name: c.name ?? null,
          notify: c.notify ?? null,
          verified: c.verifiedName ?? null,
        });
      }
    })();
  }

  upsertChats(chats: (Chat | ChatUpdate)[]): void {
    this.db.transaction(() => {
      for (const c of chats) {
        if (!c.id) continue;
        const raw = cleanJid(c.id)!;
        if (raw.endsWith('@broadcast') || raw.endsWith('@newsletter')) continue;
        const alt = (c as { pnJid?: string | null }).pnJid ?? null;
        const jid = this.canonical(raw, alt);
        const ts = c.conversationTimestamp != null ? Number(String(c.conversationTimestamp)) : null;
        this.ensureChat(jid, c.name ?? null, ts);
        if (typeof c.unreadCount === 'number') this.setChatUnread(jid, Math.max(0, c.unreadCount));
      }
    })();
  }

  ensureChat(jid: string, name: string | null, ts: number | null): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, is_group, last_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, chats.name),
           last_ts = MAX(chats.last_ts, excluded.last_ts)`,
      )
      .run(jid, name, isGroupJid(jid) ? 1 : 0, ts ?? 0);
  }

  setChatName(jid: string, name: string): void {
    this.db.prepare('UPDATE chats SET name = ? WHERE jid = ?').run(name, jid);
  }

  /** Make our unread state match WhatsApp's: the newest `n` incoming messages are unread, the rest read. */
  setChatUnread(jid: string, n: number): void {
    this.db.prepare('UPDATE chats SET unread_count = ? WHERE jid = ?').run(n, jid);
    this.db.prepare('UPDATE messages SET is_read = 1 WHERE chat_jid = ? AND from_me = 0').run(jid);
    if (n > 0) {
      this.db
        .prepare(
          `UPDATE messages SET is_read = 0 WHERE rowid IN (
             SELECT rowid FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC, rowid DESC LIMIT ?)`,
        )
        .run(jid, n);
    }
  }

  // ---------- messages ----------

  /**
   * Store messages. `live` = received in real time (counts towards unread),
   * otherwise history sync (unread state comes from the chat's unreadCount).
   * Returns the canonical chat JIDs that received new messages.
   */
  ingestMessages(msgs: WAMessage[], opts: { live: boolean; sentBy?: 'claude' } = { live: false }): string[] {
    const touched = new Set<string>();
    const insert = this.db.prepare(
      `INSERT INTO messages (chat_jid, id, raw_jid, participant, from_me, sender_jid, sender_name, ts, type, text,
         media_kind, media_mime, media_filename, media_seconds, raw, is_read, sent_by)
       VALUES (@chat_jid, @id, @raw_jid, @participant, @from_me, @sender_jid, @sender_name, @ts, @type, @text,
         @media_kind, @media_mime, @media_filename, @media_seconds, @raw, @is_read, @sent_by)
       ON CONFLICT(chat_jid, id) DO UPDATE SET sent_by = COALESCE(messages.sent_by, excluded.sent_by)`,
    );
    this.db.transaction(() => {
      for (const msg of msgs) {
        const key = msg.key;
        if (!key?.remoteJid || !key.id) continue;
        const rawJid = key.remoteJid;
        if (rawJid.endsWith('@broadcast') || rawJid.endsWith('@newsletter')) continue;
        const chatJid = this.canonical(rawJid, key.remoteJidAlt);
        const parsed = parseMessage(msg);

        if (parsed.edit) {
          if (parsed.edit.newText !== null) {
            this.db.prepare('UPDATE messages SET text = ? WHERE chat_jid = ? AND id = ?').run(parsed.edit.newText, chatJid, parsed.edit.targetId);
          }
          continue;
        }
        if (parsed.skip) continue;

        const fromMe = key.fromMe ? 1 : 0;
        const group = isGroupJid(chatJid);
        let senderJid: string | null = null;
        if (group && key.participant) senderJid = this.canonical(key.participant, key.participantAlt);
        else if (!fromMe) senderJid = chatJid;
        const ts = timestampOf(msg);
        const isRead = fromMe || !opts.live ? 1 : 0;

        const res = insert.run({
          chat_jid: chatJid,
          id: key.id,
          raw_jid: rawJid,
          participant: key.participant ?? null,
          from_me: fromMe,
          sender_jid: senderJid,
          sender_name: fromMe ? null : msg.pushName ?? null,
          ts,
          type: parsed.type,
          text: parsed.text,
          media_kind: parsed.media?.kind ?? null,
          media_mime: parsed.media?.mime ?? null,
          media_filename: parsed.media?.filename ?? null,
          media_seconds: parsed.media?.seconds ?? null,
          raw: parsed.media ? serialiseMessage(msg) : null,
          is_read: isRead,
          sent_by: opts.sentBy ?? null,
        });

        this.ensureChat(chatJid, null, ts);
        if (res.changes === 1) touched.add(chatJid);

        if (!fromMe && msg.pushName && senderJid && !group) {
          this.upsertContacts([{ id: senderJid, notify: msg.pushName }]);
        }
        if (opts.live && res.changes === 1) {
          if (!fromMe) {
            this.db.prepare('UPDATE chats SET unread_count = unread_count + 1 WHERE jid = ?').run(chatJid);
          } else if (!opts.sentBy) {
            // You replied from your phone, so you have seen the chat.
            this.setChatUnread(chatJid, 0);
          }
        }
      }
    })();
    return [...touched];
  }

  /** Keys of unread incoming messages in a chat (needed to send read receipts). */
  unreadKeys(chatJid: string): WAMessageKey[] {
    const rows = this.db
      .prepare('SELECT id, raw_jid, participant FROM messages WHERE chat_jid = ? AND from_me = 0 AND is_read = 0')
      .all(chatJid) as { id: string; raw_jid: string; participant: string | null }[];
    return rows.map((r) => ({ remoteJid: r.raw_jid, id: r.id, fromMe: false, participant: r.participant ?? undefined }));
  }

  getRaw(chatJid: string, id: string): { raw: string | null; media_kind: string | null; media_mime: string | null; media_filename: string | null; media_path: string | null; transcript: string | null; ts: number } | undefined {
    return this.db
      .prepare('SELECT raw, media_kind, media_mime, media_filename, media_path, transcript, ts FROM messages WHERE chat_jid = ? AND id = ?')
      .get(chatJid, id) as never;
  }

  setMediaPath(chatJid: string, id: string, file: string): void {
    this.db.prepare('UPDATE messages SET media_path = ? WHERE chat_jid = ? AND id = ?').run(file, chatJid, id);
  }

  setTranscript(chatJid: string, id: string, transcript: string): void {
    this.db.prepare('UPDATE messages SET transcript = ? WHERE chat_jid = ? AND id = ?').run(transcript, chatJid, id);
  }

  recordOutbox(entry: { chatJid: string; text: string; source: string; draftId?: number; messageId?: string | null; sentAt: number }): void {
    this.db
      .prepare('INSERT INTO outbox (chat_jid, text, sent_at, source, draft_id, message_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.chatJid, entry.text, entry.sentAt, entry.source, entry.draftId ?? null, entry.messageId ?? null);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
