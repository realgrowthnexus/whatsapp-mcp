import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../shared/config.js';
import type { DB } from '../shared/db.js';
import { nowSec } from '../shared/db.js';
import { audit } from '../shared/audit.js';
import { getDraft, transitionDraft } from '../shared/drafts.js';
import type { ListenerStatus, MediaResult, SendResult } from '../shared/ipc.js';
import { chatIsAllowed, countSentSince, displayName, getChat } from '../shared/queries.js';
import { ensurePrivateDir } from '../shared/secure.js';
import { paths } from '../shared/paths.js';
import { checkCanSend, GuardError, typingDelayMs } from './guard.js';
import { deserialiseMessage } from './parse.js';
import type { Store } from './store.js';
import { transcribe, TranscriptionUnavailable } from './transcribe.js';
import type { WaTransport } from './transport.js';

export class ActionError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
  }
}

export interface ActionDeps {
  store: Store;
  drafts: DB;
  transport: WaTransport;
  loadConfig: () => Config;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  startedAt?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Everything that changes something on WhatsApp goes through here.
 * Sends are processed one at a time (a queue) so rate limits can't be raced.
 */
export class Actions {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly startedAt: string;

  constructor(private readonly d: ActionDeps) {
    this.sleep = d.sleep ?? defaultSleep;
    this.random = d.random ?? Math.random;
    this.startedAt = d.startedAt ?? new Date().toISOString();
  }

  private get db(): DB {
    return this.d.store.db;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  status(): ListenerStatus {
    let config: Config | null = null;
    try { config = this.d.loadConfig(); } catch { /* reported below */ }
    const s = this.d.transport.state();
    return {
      connection: s.connection,
      linkedAs: s.linkedAs,
      lastError: s.lastError,
      killSwitch: config?.killSwitch ?? true,
      autoSend: config?.autoSend ?? false,
      sentLastHour: countSentSince(this.db, nowSec() - 3600),
      globalPerHour: config?.limits.globalPerHour ?? 0,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  private chatName(jid: string): string {
    return displayName(this.db, jid, getChat(this.db, jid)?.name);
  }

  /** Send an approved draft. `via` is who approved it: "claude" or "terminal". */
  async sendDraft(draftId: number, via: 'claude' | 'terminal'): Promise<SendResult> {
    const config = this.d.loadConfig();
    if (via === 'claude' && !config.approvals.allowFromClaude) {
      throw new ActionError(
        'Approving drafts from Claude is turned off ("approvals.allowFromClaude": false). Approve it in a terminal with "npm run drafts".',
        'claude_approval_disabled',
        403,
      );
    }
    const draft = getDraft(this.d.drafts, draftId);
    if (!draft) throw new ActionError(`Draft #${draftId} does not exist.`, 'no_draft', 404);
    if (draft.status !== 'pending') {
      throw new ActionError(`Draft #${draftId} is already ${draft.status}; it cannot be sent again.`, 'draft_not_pending', 409);
    }
    // Claim the draft so a double-approve can never send twice.
    if (!transitionDraft(this.d.drafts, draftId, 'pending', 'sending', { via })) {
      throw new ActionError(`Draft #${draftId} is already being handled.`, 'draft_not_pending', 409);
    }
    const chatJid = this.d.store.canonical(draft.chat_jid);
    try {
      const result = await this.enqueue(() => this.performSend(chatJid, draft.text, 'approved_draft', { draftId, via }));
      transitionDraft(this.d.drafts, draftId, 'sending', 'sent', { messageId: result.messageId });
      return result;
    } catch (err) {
      // Put it back so you can approve it again later (e.g. after a rate limit).
      transitionDraft(this.d.drafts, draftId, 'sending', 'pending', { error: (err as Error).message });
      throw err;
    }
  }

  /** Direct send (only when autoSend is ON). */
  async sendDirect(chatJid: string, text: string): Promise<SendResult> {
    return this.enqueue(() => this.performSend(chatJid, text, 'auto', { via: 'claude-auto' }));
  }

  private async performSend(
    chatJid: string,
    text: string,
    mode: 'approved_draft' | 'auto',
    meta: { draftId?: number; via: string },
  ): Promise<SendResult> {
    const chatName = this.chatName(chatJid);
    const blocked = (err: unknown) => {
      if (err instanceof GuardError) {
        audit({ event: 'send_blocked', chat: chatJid, chatName, text, draftId: meta.draftId, via: meta.via, reason: err.message });
        throw new ActionError(err.message, err.code, 403);
      }
      throw err;
    };

    try { checkCanSend(this.db, this.d.loadConfig(), chatJid, text, mode); } catch (e) { blocked(e); }

    const conn = this.d.transport.state();
    if (conn.connection !== 'open') {
      throw new ActionError(
        conn.connection === 'logged_out' || conn.connection === 'needs_link'
          ? 'WhatsApp session is logged out. Re-link: run "npm run relink", then "npm run link" and scan the QR code.'
          : `WhatsApp is not connected right now (${conn.connection}). It reconnects automatically — try again in a minute.`,
        'not_connected',
        503,
      );
    }

    // Behave like a person: show "typing…" for a while before sending.
    const delayMs = typingDelayMs(text, this.d.loadConfig(), this.random);
    const t = this.d.transport;
    try {
      await t.presence('available');
      let remaining = delayMs;
      while (remaining > 0) {
        await t.presence('composing', chatJid);
        const step = Math.min(remaining, 10_000);
        await this.sleep(step);
        remaining -= step;
      }
      await t.presence('paused', chatJid);

      // Check again: the kill switch may have been flipped while "typing".
      try { checkCanSend(this.db, this.d.loadConfig(), chatJid, text, mode); } catch (e) { blocked(e); }

      let sent;
      try {
        sent = await t.sendText(chatJid, text);
      } catch (err) {
        audit({ event: 'send_failed', chat: chatJid, chatName, text, draftId: meta.draftId, via: meta.via, reason: (err as Error).message });
        throw new ActionError(`WhatsApp refused the message: ${(err as Error).message}`, 'send_failed', 502);
      }
      const sentAt = nowSec();
      const messageId = sent?.key?.id ?? null;
      this.d.store.recordOutbox({ chatJid, text, source: mode, draftId: meta.draftId, messageId, sentAt });
      if (sent) this.d.store.ingestMessages([sent], { live: true, sentBy: 'claude' });
      if (meta.draftId !== undefined) {
        audit({ event: 'draft_approved', chat: chatJid, chatName, text, draftId: meta.draftId, via: meta.via });
      }
      audit({ event: 'message_sent', chat: chatJid, chatName, text, draftId: meta.draftId, via: meta.via, messageId: messageId ?? undefined });
      return { ok: true, chat: chatJid, messageId, sentAt: new Date(sentAt * 1000).toISOString(), delayMs };
    } finally {
      // Go back to "offline" so your phone keeps getting notifications.
      await t.presence('unavailable').catch(() => undefined);
    }
  }

  async markRead(chatJid: string): Promise<{ ok: true; marked: number }> {
    const config = this.d.loadConfig();
    if (!chatIsAllowed(this.db, config, chatJid)) throw new ActionError('That chat is not in the allowlist.', 'not_allowed', 403);
    const keys = this.d.store.unreadKeys(chatJid);
    if (keys.length) {
      if (this.d.transport.state().connection !== 'open') {
        throw new ActionError('WhatsApp is not connected right now; try again in a minute.', 'not_connected', 503);
      }
      await this.d.transport.readMessages(keys);
    }
    this.d.store.setChatUnread(chatJid, 0);
    audit({ event: 'mark_read', chat: chatJid, chatName: this.chatName(chatJid), via: 'claude' });
    return { ok: true, marked: keys.length };
  }

  async downloadMedia(chatJid: string, messageId: string, wantTranscript: boolean): Promise<MediaResult> {
    const config = this.d.loadConfig();
    if (!chatIsAllowed(this.db, config, chatJid)) throw new ActionError('That chat is not in the allowlist.', 'not_allowed', 403);
    const row = this.d.store.getRaw(chatJid, messageId);
    if (!row) throw new ActionError(`Message ${messageId} not found in that chat.`, 'no_message', 404);
    if (!row.media_kind || !row.raw) throw new ActionError('That message has no downloadable media.', 'no_media', 400);

    let file = row.media_path && fs.existsSync(row.media_path) ? row.media_path : null;
    if (!file) {
      if (this.d.transport.state().connection !== 'open') {
        throw new ActionError('WhatsApp is not connected right now; try again in a minute.', 'not_connected', 503);
      }
      let buf: Buffer;
      try {
        buf = await this.d.transport.downloadMedia(deserialiseMessage(row.raw));
      } catch (err) {
        throw new ActionError(
          `Could not download the media (it may have expired on WhatsApp's servers — very old media often does): ${(err as Error).message}`,
          'download_failed',
          502,
        );
      }
      const dir = path.join(paths.media, safeName(chatJid.split('@')[0] ?? 'chat'));
      ensurePrivateDir(paths.media);
      fs.mkdirSync(dir, { recursive: true });
      const base = row.media_filename ? safeName(row.media_filename) : `${row.media_kind}${extFor(row.media_mime, row.media_kind)}`;
      file = path.join(dir, `${new Date(row.ts * 1000).toISOString().slice(0, 10)}_${safeName(messageId)}_${base}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      this.d.store.setMediaPath(chatJid, messageId, file);
    }

    const result: MediaResult = { path: file, mime: row.media_mime, kind: row.media_kind };
    if (wantTranscript && (row.media_kind === 'voice' || row.media_kind === 'audio')) {
      if (row.transcript) {
        result.transcript = row.transcript;
      } else {
        try {
          result.transcript = await transcribe(file, config);
          this.d.store.setTranscript(chatJid, messageId, result.transcript);
        } catch (err) {
          result.transcriptNote =
            err instanceof TranscriptionUnavailable ? err.message : `Transcription failed: ${(err as Error).message}`;
        }
      }
    }
    return result;
  }
}

const safeName = (s: string) => s.replace(/[^\w.\-]+/g, '_').slice(0, 80);

function extFor(mime: string | null, kind: string): string {
  const m = (mime ?? '').split(';')[0]!.trim();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'application/pdf': '.pdf',
  };
  return map[m] ?? (kind === 'voice' ? '.ogg' : '.bin');
}
