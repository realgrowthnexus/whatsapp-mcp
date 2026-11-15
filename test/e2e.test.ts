import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WAMessage } from 'baileys';
import { loadConfig } from '../src/shared/config.js';
import { openDraftsDb, openWaDbWritable, type DB } from '../src/shared/db.js';
import { getDraft } from '../src/shared/drafts.js';
import { Store } from '../src/listener/store.js';
import { Actions } from '../src/listener/actions.js';
import { startIpcServer, type IpcServer } from '../src/listener/server.js';
import { createServer } from '../src/mcp/server.js';
import { ALI, ALI_LID, baseConfig, FakeTransport, GROUP, inbound, SARA, STRANGER, tempHome, writeConfig } from './helpers.js';

type Res = { content: { type: string; text: string }[]; isError?: boolean };

let home: string;
let db: DB;
let drafts: DB;
let store: Store;
let fake: FakeTransport;
let ipc: IpcServer;
let client: Client;
let mcp: ReturnType<typeof createServer>;
const sleeps: number[] = [];
let onSleep: (() => void) | undefined;
let cfg = baseConfig();

async function call(name: string, args: Record<string, unknown> = {}): Promise<Res> {
  return (await client.callTool({ name, arguments: args })) as Res;
}
const json = (r: Res) => JSON.parse(r.content[0]!.text);
const text = (r: Res) => r.content[0]!.text;
const auditLines = () =>
  fs.readFileSync(path.join(home, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const setConfig = (patch: Partial<ReturnType<typeof baseConfig>>) => {
  cfg = { ...cfg, ...patch };
  writeConfig(home, cfg);
  mcp.syncSendTool();
};

beforeAll(async () => {
  home = tempHome(cfg);
  db = openWaDbWritable();
  drafts = openDraftsDb();
  store = new Store(db);
  fake = new FakeTransport();

  // History: an old conversation with Ali (already read), a contact name, a stranger and a group.
  store.upsertContacts([{ id: ALI, name: 'Ali Khan' }, { id: SARA, notify: 'Sara Boutique' }]);
  store.ingestMessages([inbound(ALI, 'Hi, I ordered 2 shirts last week', { ts: 1_700_000_000 })], { live: false });
  store.ingestMessages([inbound(STRANGER, 'Secret message from a non-allowlisted number')], { live: true });
  store.ingestMessages([inbound(GROUP, 'Group chatter', { participant: SARA, pushName: 'Sara' })], { live: true });

  const actions = new Actions({
    store,
    drafts,
    transport: fake,
    loadConfig: () => loadConfig(),
    sleep: async (ms) => { sleeps.push(ms); onSleep?.(); },
    random: () => 0.5,
  });
  ipc = await startIpcServer(actions, { startedAt: new Date().toISOString(), onShutdown: () => undefined });

  mcp = createServer({ configWatchMs: 0 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([mcp.server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await mcp.close();
  await ipc.close();
  db.close();
  drafts.close();
});

describe('end to end: receive → read unread → draft → approve → sent', () => {
  it('a new message arrives in real time and is stored', () => {
    const touched = store.ingestMessages([inbound(ALI, 'Assalam o alaikum, what is my order status?', { pushName: 'Ali' })], { live: true });
    expect(touched).toEqual([ALI]);
  });

  it('does not expose send_message in drafts-only mode', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      ['approve_draft', 'discard_draft', 'download_media', 'draft_reply', 'get_contact', 'get_status', 'get_unread',
        'list_chats', 'list_drafts', 'mark_as_read', 'read_chat', 'search_messages'].sort(),
    );
  });

  it('get_unread shows only allowlisted chats', async () => {
    const groups = json(await call('get_unread'));
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Ali Khan');
    expect(groups[0].messages.map((m: { text: string }) => m.text)).toEqual(['Assalam o alaikum, what is my order status?']);
    expect(JSON.stringify(groups)).not.toContain('Secret');
    expect(JSON.stringify(groups)).not.toContain('Group chatter');
  });

  it('list_chats hides non-allowlisted chats and groups', async () => {
    const chats = json(await call('list_chats'));
    expect(chats.map((c: { name: string }) => c.name)).toEqual(['Ali Khan']);
    expect(chats[0].unread_count).toBe(1);
    expect(chats[0].phone).toBe('+923001112222');
  });

  it('get_contact finds by name and number', async () => {
    expect(json(await call('get_contact', { query: 'ali' }))[0].phone).toBe('+923001112222');
    expect(json(await call('get_contact', { query: '1112222' }))[0].name).toBe('Ali Khan');
    expect(text(await call('get_contact', { query: 'stranger' }))).toContain('No allowlisted contact');
  });

  let draftId: number;
  it('draft_reply saves a draft and sends NOTHING', async () => {
    const r = json(await call('draft_reply', { chat: 'Ali Khan', text: 'Walaikum assalam! Your order ships tomorrow.' }));
    draftId = r.draft_id;
    expect(r.status).toBe('pending');
    expect(r.note).toContain('NOT sent');
    expect(fake.sends()).toHaveLength(0);
    const list = json(await call('list_drafts'));
    expect(list.map((d: { draft_id: number }) => d.draft_id)).toEqual([draftId]);
  });

  it('approve_draft sends with typing indicator + delay, and audits it', async () => {
    const r = json(await call('approve_draft', { draft_id: draftId }));
    expect(r.sent).toBe(true);
    expect(fake.sends()).toEqual([{ kind: 'send', jid: ALI, text: 'Walaikum assalam! Your order ships tomorrow.' }]);

    const seq = fake.events.map((e) => (e.kind === 'presence' ? e.type : e.kind));
    expect(seq.indexOf('composing')).toBeLessThan(seq.indexOf('send'));
    expect(seq.indexOf('paused')).toBeLessThan(seq.indexOf('send'));
    expect(seq[seq.length - 1]).toBe('unavailable');
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);

    expect(getDraft(drafts, draftId)?.status).toBe('sent');
    const events = auditLines().map((l) => l.event);
    expect(events).toEqual(expect.arrayContaining(['draft_created', 'draft_approved', 'message_sent']));
    const sent = auditLines().find((l) => l.event === 'message_sent')!;
    expect(sent.chat).toBe(ALI);
    expect(sent.text).toBe('Walaikum assalam! Your order ships tomorrow.');
    expect(sent.ts).toBeTruthy();
  });

  it('the same draft can never be sent twice', async () => {
    const r = await call('approve_draft', { draft_id: draftId });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('already sent');
    expect(fake.sends()).toHaveLength(1);
  });

  it('read_chat shows the conversation including the sent reply', async () => {
    const r = json(await call('read_chat', { chat: '+92 300 1112222' }));
    expect(r.messages.map((m: { from: string }) => m.from)).toEqual(['Ali Khan', 'Ali Khan', 'me']);
    expect(r.messages[2].sent_by_claude).toBe(true);
    const old = json(await call('read_chat', { chat: ALI, before: '2024-01-01' }));
    expect(old.messages).toHaveLength(1);
    const recent = json(await call('read_chat', { chat: ALI, after: '2024-01-01' }));
    expect(recent.messages).toHaveLength(2);
  });

  it('search_messages finds text in allowlisted chats only', async () => {
    const hits = json(await call('search_messages', { query: 'shirt' }));
    expect(hits).toHaveLength(1);
    expect(hits[0].chat_name).toBe('Ali Khan');
    expect(text(await call('search_messages', { query: 'secret' }))).toContain('No messages found');
    // FTS syntax characters must not break the search
    expect((await call('search_messages', { query: 'order" OR (' })).isError).toBeFalsy();
  });

  it('mark_as_read sends read receipts and clears unread', async () => {
    expect(text(await call('mark_as_read', { chat: 'Ali' }))).toContain('Marked 1 message');
    const read = fake.events.find((e) => e.kind === 'read');
    expect(read && read.kind === 'read' && read.keys[0]?.remoteJid).toBe(ALI);
    expect(text(await call('get_unread'))).toContain('No unread messages');
  });

  it('discard_draft discards without sending', async () => {
    const d = json(await call('draft_reply', { chat: ALI, text: 'never mind' }));
    expect(text(await call('discard_draft', { draft_id: d.draft_id }))).toContain('discarded');
    expect((await call('approve_draft', { draft_id: d.draft_id })).isError).toBe(true);
    expect(fake.sends()).toHaveLength(1);
  });
});

describe('safety rules', () => {
  it('cannot draft to a non-allowlisted number, a group, or a number with no chat', async () => {
    const r1 = await call('draft_reply', { chat: '923009998888', text: 'hi' });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toContain('allowlist');
    const r2 = await call('draft_reply', { chat: GROUP, text: 'hi' });
    expect(r2.isError).toBe(true);
    const r3 = await call('draft_reply', { chat: '923001234567', text: 'hi' });
    expect(r3.isError).toBe(true);
  });

  it('cannot message an allowlisted contact who never messaged us', async () => {
    store.ensureChat(SARA, null, Math.floor(Date.now() / 1000)); // chat exists, but no inbound message
    const r = await call('draft_reply', { chat: SARA, text: 'Special offer!' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('never messaged');
  });

  it('kill switch blocks sending immediately', async () => {
    const d = json(await call('draft_reply', { chat: ALI, text: 'Kill switch test' }));
    setConfig({ killSwitch: true });
    const r = await call('approve_draft', { draft_id: d.draft_id });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('kill switch');
    expect(getDraft(drafts, d.draft_id)?.status).toBe('pending'); // can be approved later
    expect(auditLines().some((l) => l.event === 'send_blocked' && l.draftId === d.draft_id)).toBe(true);
    setConfig({ killSwitch: false });
    await call('discard_draft', { draft_id: d.draft_id });
  });

  it('kill switch flipped while "typing" aborts the send', async () => {
    const d = json(await call('draft_reply', { chat: ALI, text: 'Mid-typing kill' }));
    const before = fake.sends().length;
    onSleep = () => writeConfig(home, { ...cfg, killSwitch: true });
    const r = await call('approve_draft', { draft_id: d.draft_id });
    onSleep = undefined;
    expect(r.isError).toBe(true);
    expect(fake.sends().length).toBe(before);
    writeConfig(home, cfg);
    await call('discard_draft', { draft_id: d.draft_id });
  });

  it('approving from Claude can be disabled (terminal only)', async () => {
    const d = json(await call('draft_reply', { chat: ALI, text: 'Terminal-only approval' }));
    setConfig({ approvals: { allowFromClaude: false } });
    const r = await call('approve_draft', { draft_id: d.draft_id });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('npm run drafts');
    setConfig({ approvals: { allowFromClaude: true } });
    await call('discard_draft', { draft_id: d.draft_id });
  });

  it('send_message appears only when auto-send is ON and respects the per-chat cap', async () => {
    setConfig({ autoSend: true });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('send_message');

    // perChatPerHour = 3 and one message was already sent to Ali.
    expect(json(await call('send_message', { chat: ALI, text: 'auto 1' })).sent).toBe(true);
    expect(json(await call('send_message', { chat: ALI, text: 'auto 2' })).sent).toBe(true);
    const r = await call('send_message', { chat: ALI, text: 'auto 3' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Rate limit');
    expect(fake.sends()).toHaveLength(3);

    setConfig({ killSwitch: true });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('send_message');
    setConfig({ killSwitch: false, autoSend: false });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('send_message');
  });

  it('global hourly cap applies across chats', async () => {
    // Sara messages us, then we try to reply: global cap is 4 and 3 were sent already.
    store.ingestMessages([inbound(SARA, 'Do you have this in red?')], { live: true });
    const d1 = json(await call('draft_reply', { chat: 'Sara', text: 'Yes we do!' }));
    expect(json(await call('approve_draft', { draft_id: d1.draft_id })).sent).toBe(true);
    const d2 = json(await call('draft_reply', { chat: 'Sara', text: 'Shall I book it?' }));
    const r = await call('approve_draft', { draft_id: d2.draft_id });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('across all chats');
  });

  it('a failed send keeps the draft pending with the error', async () => {
    setConfig({ limits: { ...cfg.limits, globalPerHour: 100, perChatPerHour: 50 } });
    fake.failNextSend = true;
    const d = json(await call('draft_reply', { chat: 'Sara', text: 'This will fail once' }));
    const r = await call('approve_draft', { draft_id: d.draft_id });
    expect(r.isError).toBe(true);
    expect(getDraft(drafts, d.draft_id)?.status).toBe('pending');
    expect(getDraft(drafts, d.draft_id)?.error).toContain('network down');
    expect(json(await call('approve_draft', { draft_id: d.draft_id })).sent).toBe(true);
  });

  it('refuses to send while WhatsApp is disconnected, with a clear message', async () => {
    fake.connection = 'logged_out';
    const d = json(await call('draft_reply', { chat: 'Sara', text: 'offline test' }));
    const r = await call('approve_draft', { draft_id: d.draft_id });
    fake.connection = 'open';
    expect(text(r)).toMatch(/re-link/i);
    await call('discard_draft', { draft_id: d.draft_id });
  });

  it('messages arriving under a privacy LID are filed under the phone number', async () => {
    store.ingestMessages([inbound(ALI_LID, 'Message via LID', { alt: ALI, ts: Math.floor(Date.now() / 1000) + 10 })], { live: true });
    const r = json(await call('read_chat', { chat: 'Ali Khan', limit: 1 }));
    expect(r.messages[0].text).toBe('Message via LID');
    store.ingestMessages([inbound(ALI_LID, 'Second LID message without alt', { ts: Math.floor(Date.now() / 1000) + 20 })], { live: true });
    expect(json(await call('read_chat', { chat: ALI, limit: 1 })).messages[0].text).toBe('Second LID message without alt');
  });

  it('download_media saves the file into the private media folder', async () => {
    const msg = {
      key: { remoteJid: ALI, id: 'IMG1', fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'payment screenshot' } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
    store.ingestMessages([msg], { live: true });
    const r = json(await call('download_media', { chat: ALI, message_id: 'IMG1' }));
    expect(r.path.startsWith(path.join(home, 'media'))).toBe(true);
    expect(fs.readFileSync(r.path, 'utf8')).toBe('fake-media');
  });

  it('voice notes: returns a clear note when transcription is not set up', async () => {
    const msg = {
      key: { remoteJid: ALI, id: 'PTT1', fromMe: false },
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7 } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
    store.ingestMessages([msg], { live: true });
    const r = json(await call('download_media', { chat: ALI, message_id: 'PTT1' }));
    expect(r.path).toMatch(/\.ogg$/);
    expect(r.transcriptNote).toContain('Transcription is off');
  });
});

describe('local channel security', () => {
  it('binds to 127.0.0.1 only and rejects a wrong token', async () => {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'ipc.json'), 'utf8'));
    expect(info.port).toBe(ipc.info.port);
    const bad = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    const none = await fetch(`http://127.0.0.1:${info.port}/status`);
    expect(none.status).toBe(401);
    const browser = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { authorization: `Bearer ${info.token}`, origin: 'https://evil.example' },
    });
    expect(browser.status).toBe(403);
    const good = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` } });
    expect(good.status).toBe(200);
  });

  it('rejects unexpected fields (no bulk sends via the channel)', async () => {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'ipc.json'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${info.port}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chats: [ALI, SARA], text: 'bulk', via: 'claude-auto' }),
    });
    expect(res.status).toBe(400);
  });

  it('direct send through the channel is refused while auto-send is OFF', async () => {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'ipc.json'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${info.port}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ALI, text: 'sneaky', via: 'claude-auto' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('auto_send_off');
  });
});
