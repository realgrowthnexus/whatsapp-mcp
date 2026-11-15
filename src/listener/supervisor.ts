import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../shared/paths.js';
import { ensurePrivateDir } from '../shared/secure.js';
import { NO_RESTART } from './exit-codes.js';

/**
 * Runs the listener in the background and restarts it if it crashes.
 * Started at Windows logon (Startup folder) or by "npm run start".
 * Output goes to listener.log in the private data folder.
 */
ensurePrivateDir(paths.root);
const listenerJs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
const MAX_LOG = 5 * 1024 * 1024;
let restarts = 0;

function openLog(): number {
  try {
    if (fs.statSync(paths.listenerLog).size > MAX_LOG) fs.renameSync(paths.listenerLog, `${paths.listenerLog}.old`);
  } catch { /* no log yet */ }
  return fs.openSync(paths.listenerLog, 'a', 0o600);
}

function line(fd: number, msg: string) {
  fs.writeSync(fd, `[${new Date().toISOString()}] [supervisor] ${msg}\n`);
}

function startChild(): void {
  const fd = openLog();
  const started = Date.now();
  const child = spawn(process.execPath, [listenerJs], { stdio: ['ignore', fd, fd], windowsHide: true });
  const forward = () => child.kill();
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);

  child.on('exit', (code) => {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    const exitCode = code ?? 1;
    if (NO_RESTART.has(exitCode)) {
      line(fd, `Listener exited with code ${exitCode}; not restarting.`);
      fs.closeSync(fd);
      process.exit(0);
    }
    if (Date.now() - started > 10 * 60_000) restarts = 0; // it ran fine for a while
    const delay = Math.min(5 * 60_000, 5_000 * 2 ** restarts++);
    line(fd, `Listener exited with code ${exitCode}; restarting in ${Math.round(delay / 1000)}s.`);
    fs.closeSync(fd);
    setTimeout(startChild, delay);
  });
}

startChild();
