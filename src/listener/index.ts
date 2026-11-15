import fs from 'node:fs';
import { ConfigError, loadConfig } from '../shared/config.js';
import { openDraftsDb, openWaDbWritable } from '../shared/db.js';
import { readIpcInfo } from '../shared/ipc.js';
import { paths } from '../shared/paths.js';
import { ensurePrivateDir } from '../shared/secure.js';
import { Actions } from './actions.js';
import { EXIT } from './exit-codes.js';
import { log } from './log.js';
import { startIpcServer, type IpcServer } from './server.js';
import { Store } from './store.js';
import { WhatsAppConnection } from './wa.js';

async function isListenerAlive(): Promise<number | null> {
  const info = readIpcInfo();
  if (!info || info.pid === process.pid) return null;
  try { process.kill(info.pid, 0); } catch { return null; }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? info.pid : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const interactive = !!process.stdout.isTTY || process.argv.includes('--link');
  ensurePrivateDir(paths.root);

  try {
    loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`❌ ${err.message}`);
      process.exit(EXIT.BAD_CONFIG);
    }
    throw err;
  }

  const running = await isListenerAlive();
  if (running) {
    console.error(
      `ℹ️  The WhatsApp listener is already running in the background (process ${running}).` +
        (interactive ? ' To run it in this window instead, first run "npm run stop".' : ''),
    );
    process.exit(EXIT.ALREADY_RUNNING);
  }

  const db = openWaDbWritable();
  const drafts = openDraftsDb();
  const store = new Store(db);
  const startedAt = new Date().toISOString();

  let ipc: IpcServer | undefined;
  let shuttingDown = false;
  const shutdown = async (code: number, message?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (message) (code === EXIT.OK || code === EXIT.STOPPED ? log : console.error)(message);
    await connection.stop().catch(() => undefined);
    await ipc?.close().catch(() => undefined);
    const info = readIpcInfo();
    if (info?.pid === process.pid) fs.rmSync(paths.ipc, { force: true });
    fs.rmSync(paths.qrPng, { force: true });
    try { db.close(); drafts.close(); } catch { /* ignore */ }
    process.exit(code);
  };

  const connection = new WhatsAppConnection(store, {
    interactive,
    onFatal: (code, message) => void shutdown(code, `❌ ${message}`),
  });
  const actions = new Actions({ store, drafts, transport: connection, loadConfig: () => loadConfig(), startedAt });
  ipc = await startIpcServer(actions, { startedAt, onShutdown: () => void shutdown(EXIT.STOPPED, 'Stopped on request.') });

  // Log kill-switch / auto-send changes as they happen (enforcement re-reads the config on every send).
  let last = { killSwitch: false, autoSend: false };
  try { const c = loadConfig(); last = { killSwitch: c.killSwitch, autoSend: c.autoSend }; } catch { /* ignore */ }
  fs.watchFile(paths.config, { interval: 1000 }, () => {
    try {
      const c = loadConfig();
      if (c.killSwitch !== last.killSwitch) log(c.killSwitch ? '⛔ Kill switch ON: sending disabled.' : '✅ Kill switch OFF: sending allowed.');
      if (c.autoSend !== last.autoSend) log(c.autoSend ? 'Auto-send mode ON.' : 'Auto-send mode OFF (drafts only).');
      last = { killSwitch: c.killSwitch, autoSend: c.autoSend };
    } catch (err) {
      log(`⚠️  config.json is invalid right now, so all sending is blocked until it is fixed: ${(err as Error).message}`);
    }
  });

  process.on('SIGINT', () => void shutdown(EXIT.OK, 'Stopped (Ctrl+C).'));
  process.on('SIGTERM', () => void shutdown(EXIT.OK, 'Stopped.'));
  process.on('uncaughtException', (err) => log('Unexpected error (continuing):', err));
  process.on('unhandledRejection', (err) => log('Unexpected async error (continuing):', err));

  log(`WhatsApp listener starting. Data folder: ${paths.root}`);
  await connection.start();
}

main().catch((err) => {
  console.error('❌ Listener failed to start:', (err as Error).message);
  process.exit(EXIT.ERROR);
});
