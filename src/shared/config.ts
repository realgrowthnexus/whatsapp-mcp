import fs from 'node:fs';
import { z } from 'zod';
import { paths } from './paths.js';
import { writePrivateFile } from './secure.js';

const limitsSchema = z
  .object({
    /** Max messages Claude may send into ONE chat in any rolling 60 minutes. */
    perChatPerHour: z.number().int().min(1).max(60).default(5),
    /** Max messages Claude may send across ALL chats in any rolling 60 minutes. */
    globalPerHour: z.number().int().min(1).max(200).default(20),
    /** Random "typing" delay before each send, in milliseconds. */
    minDelayMs: z.number().int().min(0).default(3000),
    maxDelayMs: z.number().int().min(0).default(12000),
    /** Longest message Claude may send. */
    maxMessageLength: z.number().int().min(1).max(4096).default(2000),
  })
  .refine((l) => l.maxDelayMs >= l.minDelayMs, { message: 'limits.maxDelayMs must be >= limits.minDelayMs' });

export const configSchema = z.object({
  /** OFF by default: Claude can only create drafts. Turn ON to enable the send_message tool. */
  autoSend: z.boolean().default(false),
  /** Emergency stop: when true, NOTHING is sent (drafts can still be created, reading still works). */
  killSwitch: z.boolean().default(false),
  allowlist: z
    .object({
      /**
       * Individual chats Claude may read and reply to: phone numbers in international
       * format (e.g. "923001234567" or "+92 300 1234567"). Use "*" to allow ALL
       * one-to-one chats (not recommended).
       */
      chats: z.array(z.string()).default([]),
      /** Group chats are blocked unless their ID (e.g. "120363012345678901@g.us") is listed here. */
      groups: z.array(z.string()).default([]),
      /**
       * true: NEW one-to-one chats are allowed automatically as soon as their phone
       * number is known, unless it starts with +92 or is your own number. Groups,
       * broadcasts and chats with a hidden number stay blocked. All other safety
       * rules (drafts only, reply-only, rate limits, kill switch) still apply.
       */
      autoAllowNewClients: z.boolean().default(false),
    })
    .default({ chats: [], groups: [], autoAllowNewClients: false }),
  approvals: z
    .object({
      /**
       * true: you can approve drafts by telling Claude ("approve draft 3").
       * false: drafts can ONLY be approved from the terminal with `npm run drafts`.
       */
      allowFromClaude: z.boolean().default(true),
    })
    .default({ allowFromClaude: true }),
  limits: limitsSchema.default({
    perChatPerHour: 5,
    globalPerHour: 20,
    minDelayMs: 3000,
    maxDelayMs: 12000,
    maxMessageLength: 2000,
  }),
  transcription: z
    .object({
      enabled: z.boolean().default(false),
      /** Full path to whisper.cpp's whisper-cli.exe */
      whisperCli: z.string().default(''),
      /** Full path to a whisper.cpp model, e.g. ggml-base.bin */
      model: z.string().default(''),
      /** "auto", "en", "ur", ... */
      language: z.string().default('auto'),
    })
    .default({ enabled: false, whisperCli: '', model: '', language: 'auto' }),
});

export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG_TEXT = `{
  "autoSend": false,
  "killSwitch": false,
  "allowlist": {
    "chats": [],
    "groups": [],
    "autoAllowNewClients": false
  },
  "approvals": {
    "allowFromClaude": true
  },
  "limits": {
    "perChatPerHour": 5,
    "globalPerHour": 20,
    "minDelayMs": 3000,
    "maxDelayMs": 12000,
    "maxMessageLength": 2000
  },
  "transcription": {
    "enabled": false,
    "whisperCli": "",
    "model": "",
    "language": "auto"
  }
}
`;

export class ConfigError extends Error {}

export function loadConfig(file = paths.config): Config {
  if (!fs.existsSync(file)) {
    throw new ConfigError(`Config file not found at ${file}. Run "npm run setup" first.`);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      throw new ConfigError(
        `Windows refused access to ${file} (${code}): the folder's permissions are broken. ` +
          'Run the installer line again; it repairs them (it may ask for one "Yes" click).',
      );
    }
    throw new ConfigError(`Could not read config file ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Config file ${file} has problems:\n${issues}`);
  }
  return parsed.data;
}

/** Change top-level keys of the config file without touching anything else. */
export function patchConfigFile(patch: Record<string, unknown>, file = paths.config): void {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  Object.assign(raw, patch);
  writePrivateFile(file, JSON.stringify(raw, null, 2) + '\n');
}
