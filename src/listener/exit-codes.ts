/** Exit codes the supervisor uses to decide whether to restart the listener. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  /** WhatsApp unlinked this device, or it was never linked: needs a QR scan. Do NOT restart. */
  NEEDS_LINK: 3,
  /** Stopped on purpose ("npm run stop"). Do NOT restart. */
  STOPPED: 4,
  /** Another listener is already running. Do NOT restart. */
  ALREADY_RUNNING: 5,
  /** Another program took over this session. Do NOT restart. */
  REPLACED: 6,
  /** Config file is invalid. Do NOT restart until fixed. */
  BAD_CONFIG: 7,
} as const;

export const NO_RESTART = new Set<number>([EXIT.OK, EXIT.NEEDS_LINK, EXIT.STOPPED, EXIT.ALREADY_RUNNING, EXIT.REPLACED, EXIT.BAD_CONFIG]);
