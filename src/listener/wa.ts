import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto,
} from 'baileys';
import pino from 'pino';
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { paths } from '../shared/paths.js';
import { ensurePrivateDir } from '../shared/secure.js';
import { isGroupJid } from '../shared/jid.js';
import { EXIT } from './exit-codes.js';
import { log } from './log.js';
import type { Store } from './store.js';
import type { Presence, WaTransport } from './transport.js';

type ConnState = ReturnType<WaTransport['state']>;

export interface ConnectionOptions {
  /** true when running in a terminal ("npm run link"): show the QR code. */
  interactive: boolean;
  /** Called for problems that need YOU to do something (re-link etc.). */
  onFatal: (exitCode: number, message: string) => void;
  /** Called every time the connection opens (used by "--exit-after-link"). */
  onOpen?: () => void;
}

/**
 * Keeps one Baileys (WhatsApp Web protocol) connection alive, writes everything
 * it receives into the local database and reconnects automatically.
 */
export class WhatsAppConnection implements WaTransport {
  private sock?: WASocket;
  private conn: ConnState = { connection: 'connecting', linkedAs: null, lastError: null };
  private retry = 0;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly groupNamesRequested = new Set<string>();
  // Baileys logs at "silent" so nothing sensitive (keys, session data) can reach a log file.
  private readonly logger = pino({ level: process.env.WHATSAPP_MCP_DEBUG === '1' ? 'warn' : 'silent' });

  constructor(private readonly store: Store, private readonly opts: ConnectionOptions) {}

  state(): ConnState {
    return { ...this.conn };
  }

  async start(): Promise<void> {
    ensurePrivateDir(paths.auth);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try { this.sock?.end(undefined); } catch { /* ignore */ }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const { state, saveCreds } = await useMultiFileAuthState(paths.auth);

    if (!state.creds.registered && !this.opts.interactive) {
      this.conn = { connection: 'needs_link', linkedAs: null, lastError: 'Not linked yet' };
      this.opts.onFatal(
        EXIT.NEEDS_LINK,
        'This computer is not linked to WhatsApp yet. Open a terminal in the whatsapp-mcp folder and run "npm run link", then scan the QR code.',
      );
      return;
    }

    this.conn = { ...this.conn, connection: 'connecting' };
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger,
      browser: Browsers.windows('Desktop'),
      // Stay "offline" so your phone keeps receiving notifications as usual.
      markOnlineOnConnect: false,
      // Never fetch web pages for link previews (no outbound connections except WhatsApp).
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      getMessage: async (key) => this.lookupForRetry(key),
    });
    this.sock = sock;

    sock.ev.process(async (events) => {
      try {
        if (events['creds.update']) await saveCreds();
        if (events['connection.update']) await this.onConnectionUpdate(events['connection.update']);
        if (events['messaging-history.set']) {
          const h = events['messaging-history.set'];
          for (const m of h.lidPnMappings ?? []) this.store.addLidMapping(m.lid, m.pn);
          this.store.upsertContacts(h.contacts);
          this.store.ingestMessages(h.messages, { live: false });
          this.store.upsertChats(h.chats);
          log(`History sync: ${h.messages.length} messages, ${h.chats.length} chats.`);
        }
        if (events['lid-mapping.update']) {
          const m = events['lid-mapping.update'];
          this.store.addLidMapping(m.lid, m.pn);
        }
        if (events['contacts.upsert']) this.store.upsertContacts(events['contacts.upsert']);
        if (events['contacts.update']) this.store.upsertContacts(events['contacts.update']);
        if (events['chats.upsert']) this.store.upsertChats(events['chats.upsert']);
        if (events['chats.update']) this.store.upsertChats(events['chats.update']);
        if (events['messages.upsert']) {
          const { messages, type } = events['messages.upsert'];
          const touched = this.store.ingestMessages(messages, { live: type === 'notify' });
          for (const jid of touched) if (isGroupJid(jid)) void this.fetchGroupName(jid);
        }
      } catch (err) {
        log('Error while processing WhatsApp events:', err);
      }
    });
  }

  private async onConnectionUpdate(u: Partial<import('baileys').ConnectionState>): Promise<void> {
    if (u.qr) {
      this.conn = { connection: 'needs_link', linkedAs: null, lastError: null };
      if (this.opts.interactive) {
        console.log('\nScan this QR code with WhatsApp on your phone:');
        console.log('  WhatsApp Business → ⋮ (or Settings) → Linked devices → Link a device\n');
        qrTerminal.generate(u.qr, { small: true });
      }
      await QRCode.toFile(paths.qrPng, u.qr, { width: 360 }).catch(() => undefined);
      console.log(`(If the QR above is hard to scan, open this image instead: ${paths.qrPng})\n`);
    }

    if (u.connection === 'open') {
      fs.rmSync(paths.qrPng, { force: true });
      this.retry = 0;
      const id = this.sock?.user?.id ?? '';
      const phone = id ? `+${id.split('@')[0]!.split(':')[0]}` : null;
      this.conn = { connection: 'open', linkedAs: phone, lastError: null };
      this.store.setMeta('linked_as', phone ?? '');
      log(`Connected to WhatsApp as ${phone ?? 'unknown'}.`);
      this.opts.onOpen?.();
      if (this.opts.interactive && !process.argv.includes('--exit-after-link')) {
        console.log('\n✅ Linked! Messages are now being saved on this computer.');
        console.log('   You can keep this window open, or press Ctrl+C and run "npm run start" to run it in the background.\n');
      }
    }

    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error as { message?: string; output?: { statusCode?: number } } | undefined;
      const code = err?.output?.statusCode;
      const reason = err?.message ?? 'unknown';

      if (code === DisconnectReason.loggedOut) {
        this.conn = { connection: 'logged_out', linkedAs: null, lastError: 'Logged out' };
        this.opts.onFatal(
          EXIT.NEEDS_LINK,
          'Session logged out — WhatsApp unlinked this computer. Run "npm run relink", then "npm run link" and scan the new QR code.',
        );
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        this.conn = { connection: 'closed', linkedAs: this.conn.linkedAs, lastError: 'Connection replaced' };
        this.opts.onFatal(
          EXIT.REPLACED,
          'Another program opened this same WhatsApp session, so this listener stopped. Make sure only one listener is running ("npm run status"), then "npm run start".',
        );
        return;
      }
      if (code === DisconnectReason.forbidden) {
        this.conn = { connection: 'closed', linkedAs: this.conn.linkedAs, lastError: 'Forbidden (403)' };
        this.opts.onFatal(EXIT.NEEDS_LINK, 'WhatsApp refused the connection (403). Check the account on your phone, then re-link with "npm run relink".');
        return;
      }

      this.conn = { connection: 'closed', linkedAs: this.conn.linkedAs, lastError: `${reason} (${code ?? '?'})` };
      if (this.stopped) return;
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2_000 * 2 ** this.retry++);
      log(`Connection closed (${reason}, code ${code ?? '?'}). Reconnecting in ${Math.round(delay / 1000)}s…`);
      this.reconnectTimer = setTimeout(() => void this.connect().catch((e) => log('Reconnect failed:', e)), delay);
    }
  }

  private async fetchGroupName(jid: string): Promise<void> {
    if (this.groupNamesRequested.has(jid) || this.conn.connection !== 'open' || !this.sock) return;
    this.groupNamesRequested.add(jid);
    try {
      const meta = await this.sock.groupMetadata(jid);
      if (meta.subject) this.store.setChatName(jid, meta.subject);
    } catch { /* not important */ }
  }

  /** Baileys asks for this when a recipient's phone needs a message re-sent. */
  private async lookupForRetry(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id) return undefined;
    const row = this.store.db.prepare('SELECT text FROM messages WHERE id = ? AND from_me = 1').get(key.id) as { text: string } | undefined;
    return row ? { conversation: row.text } : undefined;
  }

  private requireSock(): WASocket {
    if (!this.sock || this.conn.connection !== 'open') throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  async sendText(jid: string, text: string): Promise<WAMessage | undefined> {
    return this.requireSock().sendMessage(jid, { text, linkPreview: null });
  }

  async presence(type: Presence, jid?: string): Promise<void> {
    await this.requireSock().sendPresenceUpdate(type, jid);
  }

  async readMessages(keys: WAMessageKey[]): Promise<void> {
    await this.requireSock().readMessages(keys);
  }

  async downloadMedia(msg: WAMessage): Promise<Buffer> {
    const sock = this.requireSock();
    return downloadMediaMessage(msg, 'buffer', {}, { logger: this.logger, reuploadRequest: sock.updateMediaMessage });
  }
}
