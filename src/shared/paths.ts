import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * All private state (WhatsApp session keys, database, media, logs, config)
 * lives in ONE folder that only the current OS user can access.
 *
 * Windows: %LOCALAPPDATA%\WhatsAppMCP
 * macOS/Linux: ~/.whatsapp-mcp
 * Override (tests, custom location): WHATSAPP_MCP_HOME
 */
export function dataDir(): string {
  const override = process.env.WHATSAPP_MCP_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'WhatsAppMCP');
  }
  return path.join(os.homedir(), '.whatsapp-mcp');
}

export const paths = {
  get root() { return dataDir(); },
  get config() { return path.join(dataDir(), 'config.json'); },
  get auth() { return path.join(dataDir(), 'auth'); },
  get db() { return path.join(dataDir(), 'wa.db'); },
  get draftsDb() { return path.join(dataDir(), 'drafts.db'); },
  get media() { return path.join(dataDir(), 'media'); },
  get audit() { return path.join(dataDir(), 'audit.log'); },
  get ipc() { return path.join(dataDir(), 'ipc.json'); },
  get listenerLog() { return path.join(dataDir(), 'listener.log'); },
  get qrPng() { return path.join(dataDir(), 'qr.png'); },
  get tmp() { return path.join(dataDir(), 'tmp'); },
};

/** Absolute path of the project root (one level above dist/ or src/). */
export function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/dist/shared
  return path.resolve(here, '..', '..');
}
