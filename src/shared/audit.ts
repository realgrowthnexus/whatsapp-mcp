import fs from 'node:fs';
import { paths } from './paths.js';

export type AuditEvent =
  | 'draft_created'
  | 'draft_discarded'
  | 'draft_approved'
  | 'message_sent'
  | 'send_blocked'
  | 'send_failed'
  | 'mark_read'
  | 'kill_switch_on'
  | 'kill_switch_off';

export interface AuditEntry {
  event: AuditEvent;
  chat?: string;
  chatName?: string | null;
  text?: string;
  draftId?: number;
  via?: string;
  reason?: string;
  messageId?: string;
}

/**
 * Append-only audit log (one JSON object per line). Never contains credentials.
 */
export function audit(entry: AuditEntry, file = paths.audit): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(file, line, { mode: 0o600 });
}
