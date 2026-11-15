import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG_TEXT, loadConfig } from '../shared/config.js';
import { paths, projectRoot } from '../shared/paths.js';
import { ensurePrivateDir, lockDownWindows, writePrivateFile } from '../shared/secure.js';

/**
 * One-time setup: creates the private data folder, locks it to your user,
 * writes a default config and shows the Claude Desktop config entry.
 *   npm run setup                 -> print the Claude Desktop entry
 *   npm run setup -- --claude     -> also add it to claude_desktop_config.json (backup made first)
 */
ensurePrivateDir(paths.root);
if (process.platform === 'win32') lockDownWindows(paths.root); // re-apply every time setup runs
ensurePrivateDir(paths.media);

if (!fs.existsSync(paths.config)) {
  writePrivateFile(paths.config, DEFAULT_CONFIG_TEXT);
  console.log(`✅ Created config: ${paths.config}`);
} else {
  console.log(`ℹ️  Config already exists (left unchanged): ${paths.config}`);
}
try {
  loadConfig();
} catch (err) {
  console.error(`⚠️  ${(err as Error).message}`);
}

const mcpEntry = {
  command: process.execPath,
  args: [path.join(projectRoot(), 'dist', 'mcp', 'index.js')],
};
const snippet = { mcpServers: { whatsapp: mcpEntry } };

const claudeConfig =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');

if (process.argv.includes('--claude')) {
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(claudeConfig)) {
    const backup = `${claudeConfig}.bak-${Date.now()}`;
    fs.copyFileSync(claudeConfig, backup);
    console.log(`ℹ️  Backed up Claude config to ${backup}`);
    try {
      existing = JSON.parse(fs.readFileSync(claudeConfig, 'utf8'));
    } catch {
      console.error(`❌ ${claudeConfig} is not valid JSON. Fix it or add the entry below by hand.`);
      process.exit(1);
    }
  }
  existing.mcpServers = { ...(existing.mcpServers ?? {}), whatsapp: mcpEntry };
  fs.mkdirSync(path.dirname(claudeConfig), { recursive: true });
  fs.writeFileSync(claudeConfig, JSON.stringify(existing, null, 2) + '\n');
  console.log(`✅ Added "whatsapp" to ${claudeConfig}. Fully quit and reopen Claude Desktop.`);
} else {
  console.log(`\nAdd this to ${claudeConfig}`);
  console.log('(or run "npm run setup -- --claude" to add it automatically):\n');
  console.log(JSON.stringify(snippet, null, 2));
}

console.log(`
Next steps:
  1. Edit ${paths.config}
     and put your clients' numbers in "allowlist" -> "chats" (e.g. "923001234567").
     Tip: after linking, "npm run chats" lists your chats with their numbers/IDs.
  2. npm run link              (scan the QR code with your phone)
  3. npm run install-service   (start automatically when you log in to Windows)
  4. Restart Claude Desktop.
`);
