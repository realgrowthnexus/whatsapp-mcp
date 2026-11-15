/**
 * Is this computer linked to WhatsApp? A QR-code link stores the account in
 * `creds.me`; `creds.registered` is only set by the pairing-code flow, so it
 * must not be used on its own (it stays false after a normal QR link).
 */
export function isLinkedCreds(creds: { me?: { id?: string } | null; registered?: boolean }): boolean {
  return !!creds.me?.id || !!creds.registered;
}
