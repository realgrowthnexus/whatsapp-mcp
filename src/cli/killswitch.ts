import { audit } from '../shared/audit.js';
import { loadConfig, patchConfigFile } from '../shared/config.js';
import { die } from './common.js';

const mode = process.argv[2];
if (mode !== 'on' && mode !== 'off') die('Usage: npm run kill   |   npm run unkill');
try {
  loadConfig();
} catch (err) {
  if (mode === 'off') die((err as Error).message);
  // When turning the kill switch ON we still try, even if other settings are broken.
}
patchConfigFile({ killSwitch: mode === 'on' });
audit({ event: mode === 'on' ? 'kill_switch_on' : 'kill_switch_off', via: 'terminal' });
console.log(
  mode === 'on'
    ? '⛔ Kill switch ON. Claude can no longer send anything (takes effect immediately, even for messages already "typing"). Reading and drafting still work.\n   Undo with: npm run unkill'
    : '✅ Kill switch OFF. Approved drafts can be sent again.',
);
