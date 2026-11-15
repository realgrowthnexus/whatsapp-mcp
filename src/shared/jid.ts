import type { Config } from './config.js';

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
export const isLidJid = (jid: string) => jid.endsWith('@lid');
export const isPnJid = (jid: string) => jid.endsWith('@s.whatsapp.net');
export const isBroadcastLike = (jid: string) =>
  jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid === 'status@broadcast';

/** "923001234567:12@s.whatsapp.net" -> "923001234567" */
export function userPart(jid: string): string {
  const at = jid.indexOf('@');
  const user = at === -1 ? jid : jid.slice(0, at);
  return user.split(':')[0] ?? user;
}

/** Phone digits for a phone-number JID, otherwise undefined. */
export function phoneOf(jid: string | null | undefined): string | undefined {
  if (!jid || !isPnJid(jid)) return undefined;
  return userPart(jid);
}

/** "+92 300-1234567" -> "923001234567" */
export const digitsOnly = (s: string) => s.replace(/[^\d]/g, '');

export const pnJid = (phone: string) => `${digitsOnly(phone)}@s.whatsapp.net`;

/**
 * Is this chat allowed by the allowlist?
 * @param pnForChat phone-number JID for the chat if `jid` is a LID (privacy ID) and the mapping is known.
 */
export function isAllowed(config: Config, jid: string, pnForChat?: string | null): boolean {
  if (isBroadcastLike(jid)) return false;
  if (isGroupJid(jid)) {
    return config.allowlist.groups.some((g) => g.trim() === jid);
  }
  const candidates = [jid, pnForChat].filter((x): x is string => !!x);
  for (const entryRaw of config.allowlist.chats) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    if (entry === '*') return true;
    for (const c of candidates) {
      if (entry.includes('@')) {
        if (entry === c) return true;
      } else if (isPnJid(c) && digitsOnly(entry) === userPart(c)) {
        return true;
      }
    }
  }
  return false;
}
