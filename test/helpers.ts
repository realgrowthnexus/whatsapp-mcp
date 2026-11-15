import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WAMessage, WAMessageKey } from 'baileys';
import type { Presence, WaTransport } from '../src/listener/transport.js';

export const ALI = '923001112222@s.whatsapp.net';
export const STRANGER = '923009998888@s.whatsapp.net';
export const GROUP = '120363000000000001@g.us';
export const ALI_LID = '111122223333@lid';
export const SARA = '923005556666@s.whatsapp.net';

export function tempHome(config: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wamcp-test-'));
  process.env.WHATSAPP_MCP_HOME = dir;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

export function writeConfig(dir: string, config: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

export const baseConfig = () => ({
  autoSend: false,
  killSwitch: false,
  allowlist: { chats: ['+92 300 1112222', '923005556666'], groups: [] as string[] },
  approvals: { allowFromClaude: true },
  limits: { perChatPerHour: 3, globalPerHour: 4, minDelayMs: 1000, maxDelayMs: 4000, maxMessageLength: 500 },
  transcription: { enabled: false, whisperCli: '', model: '', language: 'auto' },
});

let n = 0;
export function inbound(jid: string, text: string, opts: { ts?: number; participant?: string; pushName?: string; alt?: string } = {}): WAMessage {
  return {
    key: { remoteJid: jid, id: `IN${++n}`, fromMe: false, participant: opts.participant, remoteJidAlt: opts.alt },
    message: { conversation: text },
    messageTimestamp: opts.ts ?? Math.floor(Date.now() / 1000) - 60,
    pushName: opts.pushName,
  } as WAMessage;
}

export type FakeEvent =
  | { kind: 'presence'; type: Presence; jid?: string }
  | { kind: 'send'; jid: string; text: string }
  | { kind: 'read'; keys: WAMessageKey[] };

export class FakeTransport implements WaTransport {
  events: FakeEvent[] = [];
  connection: ReturnType<WaTransport['state']>['connection'] = 'open';
  failNextSend = false;
  private sent = 0;

  state() {
    return { connection: this.connection, linkedAs: '+923000000000', lastError: null };
  }
  async sendText(jid: string, text: string): Promise<WAMessage> {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('network down'); }
    this.events.push({ kind: 'send', jid, text });
    return {
      key: { remoteJid: jid, id: `OUT${++this.sent}`, fromMe: true },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as WAMessage;
  }
  async presence(type: Presence, jid?: string) {
    this.events.push({ kind: 'presence', type, jid });
  }
  async readMessages(keys: WAMessageKey[]) {
    this.events.push({ kind: 'read', keys });
  }
  async downloadMedia(): Promise<Buffer> {
    return Buffer.from('fake-media');
  }
  sends() {
    return this.events.filter((e): e is Extract<FakeEvent, { kind: 'send' }> => e.kind === 'send');
  }
}
