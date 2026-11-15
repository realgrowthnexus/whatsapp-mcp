import fs from 'node:fs';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { audit } from '../shared/audit.js';
import { type Config, ConfigError, loadConfig } from '../shared/config.js';
import { type DB, NotLinkedError, openDraftsDb, openWaDbReadonly } from '../shared/db.js';
import { createDraft, type Draft, getDraft, listDrafts, transitionDraft } from '../shared/drafts.js';
import { ipcCall, IpcError, type ListenerStatus, type MediaResult, type SendResult } from '../shared/ipc.js';
import { paths } from '../shared/paths.js';
import {
  ChatNotFoundError,
  chatIsAllowed,
  displayName,
  findContacts,
  getChat,
  getMessage,
  getUnread,
  hasInbound,
  listChats,
  readChat,
  resolveChat,
  searchMessages,
} from '../shared/queries.js';
import { parseDate, toLocalIso } from '../shared/time.js';

const INSTRUCTIONS = `This server connects to the user's WhatsApp Business account on their own computer.
Rules:
- Default workflow is DRAFT FIRST: use draft_reply to propose a reply. Nothing is sent until the user approves.
- Only call approve_draft when the user has explicitly approved that specific draft in this conversation (e.g. "approve draft 3", "send it"). Never approve on your own initiative.
- Only chats in the user's allowlist are visible. You cannot message new numbers, groups that are not allowlisted, or many people at once.
- Show the user the exact draft text and draft id after drafting.
- Times are in the user's local time zone.`;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const KNOWN_ERRORS = [ConfigError, NotLinkedError, ChatNotFoundError, IpcError];

export interface ServerOptions {
  /** Poll interval for picking up config changes (auto-send on/off). 0 disables watching. */
  configWatchMs?: number;
}

export function createServer(opts: ServerOptions = {}) {
  const server = new McpServer({ name: 'whatsapp-local', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  let waDb: DB | undefined;
  let draftsDb: DB | undefined;
  const wa = () => (waDb ??= openWaDbReadonly());
  const drafts = () => (draftsDb ??= openDraftsDb());

  /** Wrap a handler: fresh config each call, friendly errors. */
  const handle =
    <A>(fn: (args: A, config: Config) => Promise<ToolResult> | ToolResult) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args, loadConfig());
      } catch (err) {
        if (KNOWN_ERRORS.some((E) => err instanceof E)) return fail((err as Error).message);
        return fail(`Error: ${(err as Error).message}`);
      }
    };

  const draftView = (d: Draft) => ({
    draft_id: d.id,
    chat_id: d.chat_jid,
    chat_name: safeName(d.chat_jid),
    text: d.text,
    status: d.status,
    created: toLocalIso(d.created_at),
    ...(d.error ? { last_error: d.error } : {}),
  });
  const safeName = (jid: string) => {
    try { return displayName(wa(), jid, getChat(wa(), jid)?.name); } catch { return jid; }
  };

  const chatArg = z.string().describe('Chat to use: a chat_id from list_chats, a phone number in international format, or a contact name.');

  // ---------------- reading ----------------

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description: 'Recent WhatsApp chats (allowlisted only) with name, last message, unread count and last activity time.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20).describe('How many chats (default 20).'),
        unread_only: z.boolean().default(false).describe('Only chats with unread messages.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ limit, unread_only }, config) => ok(listChats(wa(), config, { limit, unreadOnly: unread_only }))),
  );

  server.registerTool(
    'get_unread',
    {
      title: 'Get unread messages',
      description: 'All unread incoming messages, grouped by chat (allowlisted chats only).',
      inputSchema: { limit_per_chat: z.number().int().min(1).max(100).default(20).describe('Max messages per chat (default 20).') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ limit_per_chat }, config) => {
      const groups = getUnread(wa(), config, limit_per_chat);
      return ok(groups.length ? groups : 'No unread messages in allowlisted chats.');
    }),
  );

  server.registerTool(
    'read_chat',
    {
      title: 'Read chat',
      description: 'Message history of one chat, oldest first. Optional date filters (ISO dates, local time).',
      inputSchema: {
        chat: chatArg,
        limit: z.number().int().min(1).max(500).default(50).describe('Max messages (default 50).'),
        before: z.string().optional().describe('Only messages before this date/time, e.g. 2026-11-15 or 2026-11-15T14:30.'),
        after: z.string().optional().describe('Only messages after this date/time.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ chat, limit, before, after }, config) => {
      const jid = resolveChat(wa(), config, chat);
      return ok(
        readChat(wa(), jid, {
          limit,
          before: before ? parseDate(before, 'before') : undefined,
          after: after ? parseDate(after, 'after') : undefined,
        }),
      );
    }),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description: 'Keyword search across allowlisted chats (or one chat). Matches word prefixes.',
      inputSchema: {
        query: z.string().min(1).describe('Words to search for.'),
        chat: chatArg.optional(),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ query, chat, limit }, config) => {
      const chatJid = chat ? resolveChat(wa(), config, chat) : undefined;
      const hits = searchMessages(wa(), config, query, { chatJid, limit });
      return ok(hits.length ? hits : `No messages found for "${query}".`);
    }),
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get contact',
      description: 'Look up a contact (allowlisted chats only) by name or phone number. Returns names and number.',
      inputSchema: { query: z.string().min(1).describe('Name or part of a phone number.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ query }, config) => {
      const hits = findContacts(wa(), config, query);
      return ok(hits.length ? hits : `No allowlisted contact matches "${query}".`);
    }),
  );

  server.registerTool(
    'download_media',
    {
      title: 'Download media',
      description:
        'Save the image, video, voice note or document of a message to the local media folder and return the file path. Voice notes are transcribed offline when transcription is set up.',
      inputSchema: {
        chat: chatArg,
        message_id: z.string().min(1).describe('The message id (from read_chat / get_unread).'),
        transcribe: z.boolean().default(true).describe('Transcribe voice notes/audio locally (default true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle(async ({ chat, message_id, transcribe }, config) => {
      const jid = resolveChat(wa(), config, chat);
      if (!getMessage(wa(), jid, message_id)) return fail(`Message ${message_id} not found in that chat.`);
      const r = await ipcCall<MediaResult>('POST', '/media', { chat: jid, messageId: message_id, transcribe }, 15 * 60_000);
      return ok(r);
    }),
  );

  // ---------------- drafts ----------------

  server.registerTool(
    'draft_reply',
    {
      title: 'Draft a reply',
      description: 'Save a reply to the local drafts queue. This does NOT send anything. The user must approve it first.',
      inputSchema: { chat: chatArg, text: z.string().min(1).describe('The reply text exactly as it should be sent.') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle(async ({ chat, text }, config) => {
      const jid = resolveChat(wa(), config, chat);
      if (!hasInbound(wa(), jid)) {
        return fail('This contact has never messaged you, so Claude may not message them. Only replies into existing chats are allowed.');
      }
      if (text.length > config.limits.maxMessageLength) {
        return fail(`Draft is too long (${text.length} characters; limit ${config.limits.maxMessageLength}).`);
      }
      const d = createDraft(drafts(), jid, text);
      audit({ event: 'draft_created', chat: jid, chatName: safeName(jid), text, draftId: d.id, via: 'claude' });
      const how = config.approvals.allowFromClaude
        ? `To send it, the user can say "approve draft ${d.id}", or run "npm run drafts" in a terminal.`
        : 'The user must approve it in a terminal with "npm run drafts".';
      return ok({ ...draftView(d), note: `Saved as draft #${d.id}. NOT sent. ${how}` });
    }),
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts',
      description: 'Show drafts waiting for approval (or other statuses).',
      inputSchema: {
        status: z.enum(['pending', 'sent', 'discarded', 'failed', 'all']).default('pending'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ status, limit }, config) => {
      const rows = listDrafts(drafts(), status, limit).filter((d) => chatIsAllowed(wa(), config, d.chat_jid));
      return ok(rows.length ? rows.map(draftView) : `No ${status === 'all' ? '' : status + ' '}drafts.`);
    }),
  );

  server.registerTool(
    'approve_draft',
    {
      title: 'Approve and send draft',
      description:
        'Send a pending draft to the client. ONLY call this after the user explicitly approved this exact draft in the conversation. Shows "typing…" and waits a few seconds before sending.',
      inputSchema: { draft_id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(async ({ draft_id }, config) => {
      if (!config.approvals.allowFromClaude) {
        return fail('Approving from Claude is turned off in config.json. Ask the user to run "npm run drafts" in a terminal to approve it.');
      }
      const d = getDraft(drafts(), draft_id);
      if (!d) return fail(`Draft #${draft_id} does not exist.`);
      if (!chatIsAllowed(wa(), config, d.chat_jid)) return fail('That draft is for a chat that is no longer in the allowlist.');
      const r = await ipcCall<SendResult>('POST', '/send', { draftId: draft_id, via: 'claude' });
      return ok({ sent: true, draft_id, chat_name: safeName(r.chat), message_id: r.messageId, sent_at: r.sentAt });
    }),
  );

  server.registerTool(
    'discard_draft',
    {
      title: 'Discard draft',
      description: 'Delete a pending draft without sending it.',
      inputSchema: { draft_id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle(async ({ draft_id }) => {
      const d = getDraft(drafts(), draft_id);
      if (!d) return fail(`Draft #${draft_id} does not exist.`);
      if (!transitionDraft(drafts(), draft_id, 'pending', 'discarded', { via: 'claude' })) {
        return fail(`Draft #${draft_id} is ${d.status}; only pending drafts can be discarded.`);
      }
      audit({ event: 'draft_discarded', chat: d.chat_jid, chatName: safeName(d.chat_jid), text: d.text, draftId: d.id, via: 'claude' });
      return ok(`Draft #${draft_id} discarded.`);
    }),
  );

  // ---------------- actions ----------------

  server.registerTool(
    'mark_as_read',
    {
      title: 'Mark chat as read',
      description: 'Mark all messages in a chat as read (sends read receipts / blue ticks, like opening the chat on your phone).',
      inputSchema: { chat: chatArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle(async ({ chat }, config) => {
      const jid = resolveChat(wa(), config, chat);
      const r = await ipcCall<{ marked: number }>('POST', '/read', { chat: jid });
      return ok(`Marked ${r.marked} message(s) as read in ${safeName(jid)}.`);
    }),
  );

  server.registerTool(
    'get_status',
    {
      title: 'Connector status',
      description: 'Is WhatsApp connected? Is auto-send on? Is the kill switch on? How many messages were sent this hour?',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async () => {
      try {
        return ok(await ipcCall<ListenerStatus>('GET', '/status', undefined, 5000));
      } catch (err) {
        if (err instanceof IpcError && err.code === 'not_running') return ok({ connection: 'listener_not_running', note: err.message });
        throw err;
      }
    }),
  );

  const sendTool: RegisteredTool = server.registerTool(
    'send_message',
    {
      title: 'Send message (auto-send mode)',
      description:
        'Send a reply directly into an existing allowlisted chat without a draft. Only available because the user turned on auto-send mode. Prefer draft_reply when unsure.',
      inputSchema: { chat: chatArg, text: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(async ({ chat, text }, config) => {
      if (!config.autoSend) return fail('Auto-send mode is OFF. Use draft_reply instead.');
      if (config.killSwitch) return fail('The kill switch is ON; sending is disabled.');
      const jid = resolveChat(wa(), config, chat);
      const r = await ipcCall<SendResult>('POST', '/send', { chat: jid, text, via: 'claude-auto' });
      return ok({ sent: true, chat_name: safeName(r.chat), message_id: r.messageId, sent_at: r.sentAt });
    }),
  );

  // send_message only appears when auto-send is ON (and the kill switch is OFF).
  const syncSendTool = () => {
    let on = false;
    try { const c = loadConfig(); on = c.autoSend && !c.killSwitch; } catch { on = false; }
    if (on && !sendTool.enabled) sendTool.enable();
    if (!on && sendTool.enabled) sendTool.disable();
  };
  syncSendTool();
  let watching = false;
  const watchMs = opts.configWatchMs ?? 2000;
  if (watchMs > 0) {
    fs.watchFile(paths.config, { interval: watchMs }, syncSendTool);
    watching = true;
  }

  const close = async () => {
    if (watching) fs.unwatchFile(paths.config, syncSendTool);
    await server.close();
    waDb?.close();
    draftsDb?.close();
  };

  return { server, close, syncSendTool };
}
