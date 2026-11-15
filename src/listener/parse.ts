import { BufferJSON, getContentType, normalizeMessageContent, proto, type WAMessage } from 'baileys';

export interface Parsed {
  type: string;
  text: string;
  media?: { kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'; mime: string | null; filename: string | null; seconds: number | null };
  /** For edits/deletes: the id of the message being changed. */
  edit?: { targetId: string; newText: string | null };
  /** Messages we don't store at all (reactions, key distribution, receipts...). */
  skip?: boolean;
}

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(typeof v === 'object' ? String(v) : v);
  return Number.isFinite(n) ? n : null;
};

export function timestampOf(msg: WAMessage): number {
  return toNum(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000);
}

export function parseMessage(msg: WAMessage): Parsed {
  const content = normalizeMessageContent(msg.message);
  if (!content) return { type: 'empty', text: '', skip: true };
  const type = getContentType(content);
  if (!type) return { type: 'unknown', text: '', skip: true };

  switch (type) {
    case 'conversation':
      return { type: 'text', text: content.conversation ?? '' };
    case 'extendedTextMessage':
      return { type: 'text', text: content.extendedTextMessage?.text ?? '' };
    case 'imageMessage': {
      const m = content.imageMessage!;
      return { type: 'image', text: m.caption ?? '', media: { kind: 'image', mime: m.mimetype ?? null, filename: null, seconds: null } };
    }
    case 'videoMessage': {
      const m = content.videoMessage!;
      return { type: 'video', text: m.caption ?? '', media: { kind: 'video', mime: m.mimetype ?? null, filename: null, seconds: toNum(m.seconds) } };
    }
    case 'audioMessage': {
      const m = content.audioMessage!;
      const kind = m.ptt ? 'voice' : 'audio';
      const secs = toNum(m.seconds);
      return {
        type: kind,
        text: m.ptt ? `[voice note${secs ? ` ${secs}s` : ''}]` : '[audio]',
        media: { kind, mime: m.mimetype ?? null, filename: null, seconds: secs },
      };
    }
    case 'documentMessage':
    case 'documentWithCaptionMessage': {
      const m = content.documentMessage ?? content.documentWithCaptionMessage?.message?.documentMessage;
      if (!m) return { type: 'document', text: '[document]' };
      const label = m.caption || `[document: ${m.fileName ?? m.title ?? 'file'}]`;
      return { type: 'document', text: label, media: { kind: 'document', mime: m.mimetype ?? null, filename: m.fileName ?? null, seconds: null } };
    }
    case 'stickerMessage':
      return { type: 'sticker', text: '[sticker]', media: { kind: 'sticker', mime: content.stickerMessage?.mimetype ?? null, filename: null, seconds: null } };
    case 'locationMessage': {
      const l = content.locationMessage!;
      return { type: 'location', text: `[location ${l.degreesLatitude},${l.degreesLongitude}${l.name ? ` ${l.name}` : ''}]` };
    }
    case 'liveLocationMessage':
      return { type: 'location', text: '[live location]' };
    case 'contactMessage':
      return { type: 'contact', text: `[contact: ${content.contactMessage?.displayName ?? ''}]` };
    case 'contactsArrayMessage':
      return { type: 'contact', text: `[${content.contactsArrayMessage?.contacts?.length ?? 0} contacts]` };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const p = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
      return { type: 'poll', text: `[poll: ${p?.name ?? ''}]` };
    }
    case 'buttonsResponseMessage':
      return { type: 'text', text: content.buttonsResponseMessage?.selectedDisplayText ?? '' };
    case 'listResponseMessage':
      return { type: 'text', text: content.listResponseMessage?.title ?? '' };
    case 'templateButtonReplyMessage':
      return { type: 'text', text: content.templateButtonReplyMessage?.selectedDisplayText ?? '' };
    case 'protocolMessage': {
      const p = content.protocolMessage!;
      const targetId = p.key?.id;
      if (targetId && p.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        return { type: 'protocol', text: '', skip: true, edit: { targetId, newText: '[message deleted]' } };
      }
      if (targetId && p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
        const edited = normalizeMessageContent(p.editedMessage);
        const newText = edited?.conversation ?? edited?.extendedTextMessage?.text ?? edited?.imageMessage?.caption ?? null;
        return { type: 'protocol', text: '', skip: true, edit: { targetId, newText: newText ? `${newText} (edited)` : null } };
      }
      return { type: 'protocol', text: '', skip: true };
    }
    case 'reactionMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo':
    case 'pollUpdateMessage':
    case 'keepInChatMessage':
    case 'pinInChatMessage':
      return { type, text: '', skip: true };
    default:
      return { type: String(type), text: `[${String(type).replace(/Message$/, '')}]` };
  }
}

/** Serialise a media message so the listener can download it later. */
export const serialiseMessage = (msg: WAMessage) => JSON.stringify(msg, BufferJSON.replacer);
export const deserialiseMessage = (raw: string) => JSON.parse(raw, BufferJSON.reviver) as WAMessage;
