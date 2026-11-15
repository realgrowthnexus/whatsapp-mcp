import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { IpcInfo } from '../shared/ipc.js';
import { paths } from '../shared/paths.js';
import { writePrivateFile } from '../shared/secure.js';
import { ActionError, type Actions } from './actions.js';

const sendSchema = z.union([
  z.object({ draftId: z.number().int().positive(), via: z.enum(['claude', 'terminal']) }).strict(),
  z.object({ chat: z.string().min(1), text: z.string(), via: z.literal('claude-auto') }).strict(),
]);
const readSchema = z.object({ chat: z.string().min(1) }).strict();
const mediaSchema = z.object({ chat: z.string().min(1), messageId: z.string().min(1), transcribe: z.boolean().default(true) }).strict();

const MAX_BODY = 64 * 1024;

export interface IpcServer {
  info: IpcInfo;
  close(): Promise<void>;
}

/**
 * Local control channel between the MCP server / CLI and the listener.
 * - Listens on 127.0.0.1 only (never on your network).
 * - Every request must carry a random secret token stored in the private data folder.
 */
export async function startIpcServer(
  actions: Actions,
  opts: { onShutdown: () => void; writeInfoFile?: boolean; startedAt: string },
): Promise<IpcServer> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token);

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      // Reject anything not from this machine (defence in depth; we only bind to 127.0.0.1 anyway).
      const remote = req.socket.remoteAddress ?? '';
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(remote)) return reply(403, { error: 'Forbidden', code: 'forbidden' });
      // Block browsers: a web page can't set the Authorization header cross-origin without a preflight we never answer.
      if (req.headers.origin) return reply(403, { error: 'Forbidden', code: 'forbidden' });

      const auth = req.headers.authorization ?? '';
      const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
      if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) {
        return reply(401, { error: 'Unauthorized', code: 'unauthorized' });
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/status') return reply(200, actions.status());
      if (req.method !== 'POST') return reply(404, { error: 'Not found', code: 'not_found' });

      const body = await readJson(req);
      switch (url.pathname) {
        case '/send': {
          const p = sendSchema.parse(body);
          const result = 'draftId' in p ? await actions.sendDraft(p.draftId, p.via) : await actions.sendDirect(p.chat, p.text);
          return reply(200, result);
        }
        case '/read': {
          const p = readSchema.parse(body);
          return reply(200, await actions.markRead(p.chat));
        }
        case '/media': {
          const p = mediaSchema.parse(body);
          return reply(200, await actions.downloadMedia(p.chat, p.messageId, p.transcribe));
        }
        case '/shutdown': {
          reply(200, { ok: true });
          setTimeout(opts.onShutdown, 50);
          return;
        }
        default:
          return reply(404, { error: 'Not found', code: 'not_found' });
      }
    } catch (err) {
      if (err instanceof ActionError) return reply(err.status, { error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply(400, { error: `Bad request: ${err.issues.map((i) => i.message).join('; ')}`, code: 'bad_request' });
      if (err instanceof BodyError) return reply(413, { error: err.message, code: 'bad_request' });
      return reply(500, { error: `Listener error: ${(err as Error).message}`, code: 'internal' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('IPC server failed to bind');
  const info: IpcInfo = { port: addr.port, token, pid: process.pid, startedAt: opts.startedAt };
  if (opts.writeInfoFile !== false) writePrivateFile(paths.ipc, JSON.stringify(info));

  return {
    info,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

class BodyError extends Error {}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BodyError('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new BodyError('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}
