import fs from 'node:fs';
import os from 'node:os';
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
  const user = windowsUser();
  try {
    // /inheritance:r  -> drop permissions inherited from parent folders
    // /grant:r        -> replace any explicit grants with: this user, Full control,
    //                    inherited by sub-folders (CI) and files (OI)
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/T', '/Q'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(
      `Could not restrict permissions on ${dir} (icacls failed for user "${user}"). ` +
        `Run "npm run setup" again from a normal (non-admin) terminal. Details: ${(err as Error).message}`,
    );
  }
}

function windowsUser(): string {
  const name = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

/** Write a file readable/writable by the owner only (mode is ignored on Windows; the folder ACL applies). */
export function writePrivateFile(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
}
