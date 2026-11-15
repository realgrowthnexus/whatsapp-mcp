import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/shared/config.js';
import { isAllowed } from '../src/shared/jid.js';
import { typingDelayMs } from '../src/listener/guard.js';
import { ftsQuery } from '../src/shared/queries.js';
import { parseMessage } from '../src/listener/parse.js';
import type { WAMessage } from 'baileys';

const cfg = (chats: string[], groups: string[] = []) => configSchema.parse({ allowlist: { chats, groups } });

describe('allowlist', () => {
  it('matches numbers in any format', () => {
    expect(isAllowed(cfg(['+92 300-1112222']), '923001112222@s.whatsapp.net')).toBe(true);
    expect(isAllowed(cfg(['923001112222']), '923001112223@s.whatsapp.net')).toBe(false);
  });
  it('matches a LID chat through its phone number', () => {
    expect(isAllowed(cfg(['923001112222']), '1234@lid', '923001112222@s.whatsapp.net')).toBe(true);
    expect(isAllowed(cfg(['923001112222']), '1234@lid')).toBe(false);
  });
  it('blocks groups unless listed, even with "*"', () => {
    expect(isAllowed(cfg(['*']), '1203@g.us')).toBe(false);
    expect(isAllowed(cfg([], ['1203@g.us']), '1203@g.us')).toBe(true);
  });
  it('always blocks broadcasts and status', () => {
    expect(isAllowed(cfg(['*']), 'status@broadcast')).toBe(false);
    expect(isAllowed(cfg(['*']), '123@broadcast')).toBe(false);
    expect(isAllowed(cfg(['*']), '123@newsletter')).toBe(false);
  });
});

describe('config defaults', () => {
  it('is drafts-only with the kill switch off by default', () => {
    const c = configSchema.parse({});
    expect(c.autoSend).toBe(false);
    expect(c.killSwitch).toBe(false);
    expect(c.allowlist.chats).toEqual([]);
    expect(c.limits.perChatPerHour).toBe(5);
  });
  it('rejects nonsense limits', () => {
    expect(configSchema.safeParse({ limits: { minDelayMs: 5000, maxDelayMs: 1000 } }).success).toBe(false);
    expect(configSchema.safeParse({ autoSend: 'yes' }).success).toBe(false);
  });
});

describe('typing delay', () => {
  const c = configSchema.parse({});
  it('stays within [min, max] and grows with length', () => {
    for (const r of [0, 0.5, 0.999]) {
      for (const t of ['ok', 'x'.repeat(2000)]) {
        const d = typingDelayMs(t, c, () => r);
        expect(d).toBeGreaterThanOrEqual(c.limits.minDelayMs);
        expect(d).toBeLessThanOrEqual(c.limits.maxDelayMs);
      }
    }
    expect(typingDelayMs('x'.repeat(500), c, () => 0.5)).toBeGreaterThan(typingDelayMs('ok', c, () => 0.5));
  });
});

describe('search query sanitising', () => {
  it('quotes every term', () => {
    expect(ftsQuery('order "status" OR (')).toBe('"order"* "status"* "OR"* "("*');
  });
});

describe('message parsing', () => {
  const m = (message: object) => ({ key: { remoteJid: 'x@s.whatsapp.net', id: '1' }, message }) as WAMessage;
  it('handles text, captions, voice notes, documents and wrappers', () => {
    expect(parseMessage(m({ conversation: 'hi' })).text).toBe('hi');
    expect(parseMessage(m({ extendedTextMessage: { text: 'link' } })).text).toBe('link');
    expect(parseMessage(m({ imageMessage: { caption: 'pic', mimetype: 'image/jpeg' } })).media?.kind).toBe('image');
    const v = parseMessage(m({ audioMessage: { ptt: true, seconds: 12 } }));
    expect(v.type).toBe('voice');
    expect(v.text).toBe('[voice note 12s]');
    expect(parseMessage(m({ documentMessage: { fileName: 'invoice.pdf' } })).text).toBe('[document: invoice.pdf]');
    expect(parseMessage(m({ ephemeralMessage: { message: { conversation: 'disappearing' } } })).text).toBe('disappearing');
    expect(parseMessage(m({ reactionMessage: { text: '👍' } })).skip).toBe(true);
  });
});

describe('built-in SQLite wrapper', () => {
  it('commits, rolls back (incl. nested), binds booleans/undefined and named params', async () => {
    const { Database } = await import('../src/shared/sqlite.js');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.transaction(() => { db.prepare('INSERT INTO t VALUES (@a, @b)').run({ a: true, b: undefined }); })();
    expect(() => db.transaction(() => { db.prepare('INSERT INTO t VALUES (?, ?)').run(2, 'x'); throw new Error('boom'); })()).toThrow('boom');
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run(3, 'y');
      try { db.transaction(() => { db.prepare('INSERT INTO t VALUES (?, ?)').run(4, 'z'); throw new Error('inner'); })(); } catch { /* inner rolled back */ }
    })();
    expect(db.prepare('SELECT a, b FROM t ORDER BY a').all()).toEqual([{ a: 1, b: null }, { a: 3, b: 'y' }]);
    const r = db.prepare('INSERT INTO t VALUES (5, ?)').run('w');
    expect(r.changes).toBe(1);
    expect(Number(r.lastInsertRowid)).toBe(3);
    db.close();
  });
});
