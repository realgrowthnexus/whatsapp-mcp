import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Create a directory and lock it down so only the current OS user can access it.
 * Windows: removes inherited permissions and grants Full Control to the current
 * user only (icacls). Elsewhere: chmod 700.
 */
export function ensurePrivateDir(dir: string): void {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    if (!existed || process.env.WHATSAPP_MCP_FORCE_ACL === '1') lockDownWindows(dir);
  } else {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

export function lockDownWindows(dir: string): void {
  const who = windowsUserSid() ?? windowsUser();
  const icacls = (args: string[]) => execFileSync('icacls', args, { stdio: 'ignore', windowsHide: true });
  try {
    // On the folder itself only:
    //   /inheritance:r -> drop permissions inherited from parent folders
    //   /grant:r       -> this user (by SID, so the name can never resolve to the wrong account),
    //                     Full control, inherited by sub-folders (CI) and files (OI)
    icacls([dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '/Q']);
  } catch (err) {
    throw new Error(
      `Could not restrict permissions on ${dir} (icacls failed for "${who}"). ` +
        `Run the installer again from a normal (non-admin) PowerShell window. Details: ${(err as Error).message}`,
    );
  }
  // Everything inside simply inherits from the folder. (Re-locking each file with /T could
  // leave files with NO permissions at all, which caused "EPERM: operation not permitted".)
  try { icacls([path.join(dir, '*'), '/reset', '/T', '/C', '/Q']); } catch { /* empty folder or nothing to fix */ }
}

function windowsUser(): string {
  const name = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

/** "*S-1-5-21-..." for the current user, so icacls never depends on how the account name resolves. */
function windowsUserSid(): string | null {
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = out.match(/S-1-[\d-]+/)?.[0];
    return sid ? `*${sid}` : null;
  } catch {
    return null;
  }
}

/** Write a file readable/writable by the owner only (mode is ignored on Windows; the folder ACL applies). */
export function writePrivateFile(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
}
