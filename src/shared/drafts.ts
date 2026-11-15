import type { DB } from './db.js';
import { nowSec } from './db.js';

export type DraftStatus = 'pending' | 'sending' | 'sent' | 'discarded' | 'failed';

export interface Draft {
  id: number;
  chat_jid: string;
  text: string;
  status: DraftStatus;
  created_at: number;
  updated_at: number;
  decided_via: string | null;
  error: string | null;
  message_id: string | null;
}

export function createDraft(db: DB, chatJid: string, text: string): Draft {
  const now = nowSec();
  const info = db
    .prepare('INSERT INTO drafts (chat_jid, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(chatJid, text, 'pending', now, now);
  return getDraft(db, Number(info.lastInsertRowid))!;
}

export function getDraft(db: DB, id: number): Draft | undefined {
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
}

export function listDrafts(db: DB, status: DraftStatus | 'all' = 'pending', limit = 100): Draft[] {
  if (status === 'all') return db.prepare('SELECT * FROM drafts ORDER BY id DESC LIMIT ?').all(limit) as Draft[];
  return db.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY id ASC LIMIT ?').all(status, limit) as Draft[];
}

/**
 * Atomically move a draft from one status to another.
 * Returns false if the draft was not in the expected status (e.g. already sent).
 */
export function transitionDraft(
  db: DB,
  id: number,
  from: DraftStatus,
  to: DraftStatus,
  extra: { via?: string; error?: string | null; messageId?: string | null } = {},
): boolean {
  const res = db
    .prepare(
      `UPDATE drafts SET status = ?, updated_at = ?,
         decided_via = COALESCE(?, decided_via), error = ?, message_id = COALESCE(?, message_id)
       WHERE id = ? AND status = ?`,
    )
    .run(to, nowSec(), extra.via ?? null, extra.error ?? null, extra.messageId ?? null, id, from);
  return res.changes === 1;
}
