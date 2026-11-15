import type { Config } from '../shared/config.js';
import type { DB } from '../shared/db.js';
import { isBroadcastLike, isGroupJid } from '../shared/jid.js';
import { chatIsAllowed, countSentSince, getChat, hasInbound } from '../shared/queries.js';

export type GuardCode =
  | 'kill_switch'
  | 'auto_send_off'
  | 'empty'
  | 'too_long'
  | 'broadcast'
  | 'not_allowed'
  | 'unknown_chat'
  | 'chat_rate_limit'
  | 'global_rate_limit';

export class GuardError extends Error {
  constructor(message: string, readonly code: GuardCode) {
    super(message);
  }
}

/**
 * The single place that decides whether a message may be sent.
 * Runs inside the listener, so nothing on the Claude side can skip it.
 */
export function checkCanSend(
  db: DB,
  config: Config,
  chatJid: string,
  text: string,
  mode: 'approved_draft' | 'auto',
  nowSec = Math.floor(Date.now() / 1000),
): void {
  if (config.killSwitch) {
    throw new GuardError(
      'Sending is switched OFF by the kill switch (killSwitch: true in config.json). Nothing was sent. Run "npm run unkill" to allow sending again.',
      'kill_switch',
    );
  }
  if (mode === 'auto' && !config.autoSend) {
    throw new GuardError('Direct sending is OFF (autoSend: false in config.json). Use draft_reply and approve the draft instead.', 'auto_send_off');
  }
  if (!text.trim()) throw new GuardError('Message text is empty.', 'empty');
  if (text.length > config.limits.maxMessageLength) {
    throw new GuardError(`Message is too long (${text.length} characters; limit is ${config.limits.maxMessageLength}).`, 'too_long');
  }
  if (isBroadcastLike(chatJid)) throw new GuardError('Broadcasts, status updates and channels are never allowed.', 'broadcast');
  if (!chatIsAllowed(db, config, chatJid)) {
    throw new GuardError(
      isGroupJid(chatJid)
        ? `Group ${chatJid} is not in allowlist.groups in config.json, so Claude may not message it.`
        : `Chat ${chatJid} is not in allowlist.chats in config.json, so Claude may not message it.`,
      'not_allowed',
    );
  }
  if (!getChat(db, chatJid) || !hasInbound(db, chatJid)) {
    throw new GuardError(
      'Claude can only reply inside an existing chat where this contact has messaged you before. New or unknown numbers are blocked.',
      'unknown_chat',
    );
  }
  const hourAgo = nowSec - 3600;
  const perChat = countSentSince(db, hourAgo, chatJid);
  if (perChat >= config.limits.perChatPerHour) {
    throw new GuardError(
      `Rate limit: already sent ${perChat} messages to this chat in the last hour (limit ${config.limits.perChatPerHour}). Try again later.`,
      'chat_rate_limit',
    );
  }
  const global = countSentSince(db, hourAgo);
  if (global >= config.limits.globalPerHour) {
    throw new GuardError(
      `Rate limit: already sent ${global} messages in the last hour across all chats (limit ${config.limits.globalPerHour}). Try again later.`,
      'global_rate_limit',
    );
  }
}

/** Human-like "typing" time: longer messages take longer, with randomness, always within [min, max]. */
export function typingDelayMs(text: string, config: Config, random: () => number = Math.random): number {
  const { minDelayMs: min, maxDelayMs: max } = config.limits;
  const span = Math.max(0, max - min);
  const lengthFactor = Math.min(1, 0.3 + text.length / 250);
  return Math.round(min + span * lengthFactor * (0.5 + 0.5 * random()));
}
