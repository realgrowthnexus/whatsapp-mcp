import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ipcCall } from '../shared/ipc.js';
import { paths, projectRoot } from '../shared/paths.js';
import { die, listenerStatus, sleep } from './common.js';

const supervisorJs = path.join(projectRoot(), 'dist', 'listener', 'supervisor.js');
const startupFile = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'WhatsAppMCP-Listener.vbs',
);

const vbsQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function start(): Promise<void> {
  const s = await listenerStatus();
  if (s) {
    console.log(`ℹ️  Already running (process ${s.pid}), WhatsApp: ${s.connection}.`);
    return;
  }
  if (!fs.existsSync(path.join(paths.auth, 'creds.json'))) die('Not linked yet. Run "npm run link" first and scan the QR code.');
  const child = spawn(process.execPath, [supervisorJs], { detached: true, stdio: 'ignore', windowsHide: true, cwd: projectRoot() });
  child.unref();
  process.stdout.write('Starting the listener in the background');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    process.stdout.write('.');
    const st = await listenerStatus();
    if (st?.connection === 'open') {
      console.log(`\n✅ Running and connected as ${st.linkedAs}.`);
      return;
    }
  }
  console.log(`\n⚠️  Started, but not connected yet. Check "npm run status" or the log: ${paths.listenerLog}`);
}

async function stop(): Promise<void> {
  if (!(await listenerStatus())) {
    console.log('ℹ️  The listener is not running.');
    return;
  }
  await ipcCall('POST', '/shutdown').catch(() => undefined);
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!(await listenerStatus())) {
      console.log('✅ Stopped. (It will start again at your next Windows login if auto-start is installed.)');
      return;
    }
  }
  console.log('⚠️  It did not stop in time. Check Task Manager for "node.exe".');
}

function install(): void {
  if (process.platform !== 'win32') {
    console.log('Automatic start is set up for Windows only. On this system, run "npm run start" after login,');
    console.log(`or add this command to your login items:  "${process.execPath}" "${supervisorJs}"`);
    return;
  }
  // A tiny script in your Startup folder runs the listener hidden (no window) every time you log in.
  const vbs =
    `' Starts the local WhatsApp listener for Claude (whatsapp-mcp) without a window.\r\n` +
    `Set sh = CreateObject("WScript.Shell")\r\n` +
    `sh.CurrentDirectory = ${vbsQuote(projectRoot())}\r\n` +
    `sh.Run ${vbsQuote(`${vbsQuote(process.execPath)} ${vbsQuote(supervisorJs)}`)}, 0, False\r\n`;
  fs.mkdirSync(path.dirname(startupFile), { recursive: true });
  // UTF-16LE with BOM so folder names with any characters work.
  fs.writeFileSync(startupFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
  console.log(`✅ Auto-start installed: ${startupFile}`);
  console.log('   The listener will start hidden every time you log in to Windows.');
  console.log('   Start it now with: npm run start');
}

function uninstall(): void {
  if (fs.existsSync(startupFile)) {
    fs.rmSync(startupFile);
    console.log('✅ Auto-start removed. (Use "npm run stop" to stop the one running now.)');
  } else {
    console.log('ℹ️  Auto-start was not installed.');
  }
}

const cmd = process.argv[2];
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else die('Usage: node dist/cli/service.js start|stop|install|uninstall');
