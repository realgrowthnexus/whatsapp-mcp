import type { WAMessage, WAMessageKey } from 'baileys';

export type Presence = 'available' | 'unavailable' | 'composing' | 'paused';

/**
 * The small slice of WhatsApp that the send/read logic needs.
 * The real implementation wraps a Baileys socket (wa.ts); tests use a fake.
 */
export interface WaTransport {
  state(): { connection: 'connecting' | 'open' | 'closed' | 'logged_out' | 'needs_link'; linkedAs: string | null; lastError: string | null };
  sendText(jid: string, text: string): Promise<WAMessage | undefined>;
  presence(type: Presence, jid?: string): Promise<void>;
  readMessages(keys: WAMessageKey[]): Promise<void>;
  downloadMedia(msg: WAMessage): Promise<Buffer>;
}
