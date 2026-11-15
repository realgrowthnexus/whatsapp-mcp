import fs from 'node:fs';
import { paths } from './paths.js';

/** Written by the listener at startup; read by the MCP server and CLI tools. */
export interface IpcInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export interface ListenerStatus {
  connection: 'connecting' | 'open' | 'closed' | 'logged_out' | 'needs_link';
  linkedAs: string | null;
  lastError: string | null;
  killSwitch: boolean;
  autoSend: boolean;
  sentLastHour: number;
  globalPerHour: number;
  pid: number;
  startedAt: string;
}

export interface SendResult {
  ok: true;
  chat: string;
  messageId: string | null;
  sentAt: string;
  delayMs: number;
}

export interface MediaResult {
  path: string;
  mime: string | null;
  kind: string;
  transcript?: string;
  transcriptNote?: string;
}

export class IpcError extends Error {
  constructor(message: string, readonly code: string = 'error', readonly status = 0) {
    super(message);
  }
}

export const NOT_RUNNING =
  'The WhatsApp listener is not running, so nothing can be sent right now. ' +
  'Start it with "npm run start" in the whatsapp-mcp folder (or log off and on again if auto-start is installed). ' +
  'Reading old messages still works.';

export function readIpcInfo(): IpcInfo | null {
  try {
    return JSON.parse(fs.readFileSync(paths.ipc, 'utf8')) as IpcInfo;
  } catch {
    return null;
  }
}

export async function ipcCall<T>(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  const info = readIpcInfo();
  if (!info) throw new IpcError(NOT_RUNNING, 'not_running');
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError') throw new IpcError('The listener did not answer in time. Check "npm run status".', 'timeout');
    throw new IpcError(NOT_RUNNING, 'not_running');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new IpcError(data.error ?? `Listener error (HTTP ${res.status})`, data.code ?? 'error', res.status);
  return data as T;
}
