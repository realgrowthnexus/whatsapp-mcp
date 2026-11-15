import fs from 'node:fs';
import Database from 'better-sqlite3';
import { paths } from './paths.js';

export type DB = Database.Database;

const WA_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS chats (
  jid          TEXT PRIMARY KEY,
  name         TEXT,
  is_group     INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_ts      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  jid           TEXT PRIMARY KEY,
  phone         TEXT,
  lid           TEXT,
  name          TEXT,
  notify        TEXT,
  verified_name TEXT
);

CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS messages (
  chat_jid        TEXT NOT NULL,
  id              TEXT NOT NULL,
  raw_jid         TEXT NOT NULL,
  participant     TEXT,
  from_me         INTEGER NOT NULL,
  sender_jid      TEXT,
  sender_name     TEXT,
  ts              INTEGER NOT NULL,
  type            TEXT NOT NULL,
  text            TEXT,
  media_kind      TEXT,
  media_mime      TEXT,
  media_filename  TEXT,
  media_seconds   INTEGER,
  raw             TEXT,
  media_path      TEXT,
  transcript      TEXT,
  is_read         INTEGER NOT NULL DEFAULT 1,
  sent_by         TEXT,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_jid, ts);
CREATE INDEX IF NOT EXISTS messages_unread ON messages (is_read, from_me);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Every message sent by this connector (used for rate limits).
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid   TEXT NOT NULL,
  text       TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  source     TEXT NOT NULL,
  draft_id   INTEGER,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS outbox_sent_at ON outbox (sent_at);
`;

const DRAFTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid    TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | discarded | failed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  decided_via TEXT,
  error       TEXT,
  message_id  TEXT
);
CREATE INDEX IF NOT EXISTS drafts_status ON drafts (status);
`;

function tune(db: DB) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
}

/** Read-write handle used by the listener (creates the schema). */
export function openWaDbWritable(file = paths.db): DB {
  const db = new Database(file);
  tune(db);
  db.exec(WA_SCHEMA);
  return db;
}

export class NotLinkedError extends Error {}

/** Read-only handle used by the MCP server. */
export function openWaDbReadonly(file = paths.db): DB {
  if (!fs.existsSync(file)) {
    throw new NotLinkedError(
      'No WhatsApp data yet. Link your phone first: open a terminal in the whatsapp-mcp folder and run "npm run link".',
    );
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Drafts live in their own small database so the MCP server can write drafts while keeping wa.db read-only. */
export function openDraftsDb(file = paths.draftsDb): DB {
  const db = new Database(file);
  tune(db);
  db.exec(DRAFTS_SCHEMA);
  return db;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
