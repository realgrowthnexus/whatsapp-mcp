# WhatsApp MCP (local only)

A private connector that lets **Claude Desktop** read your **WhatsApp Business** chats and help you reply. **Everything runs on your own Windows computer.** It doesn't use the Meta Cloud API or any third-party service, and nothing is sent to anyone except WhatsApp itself.

It connects the same way WhatsApp Web does: as a **linked device** (using the open-source [Baileys](https://github.com/WhiskeySockets/Baileys) library). You scan a QR code once from your phone.

```
 Your phone (WhatsApp Business)
          │  linked device (like WhatsApp Web)
          ▼
 ┌──────────────────────────┐   127.0.0.1 only + secret token   ┌────────────────────┐
 │ Listener (background)    │ ◀──────────────────────────────── │ MCP server         │ ◀── Claude Desktop
 │ • always connected       │                                    │ • reads database   │
 │ • saves every message    │ ──▶ SQLite database (read-only) ──▶│ • drafts queue     │
 │ • ALL safety checks      │                                    └────────────────────┘
 └──────────────────────────┘
        %LOCALAPPDATA%\WhatsAppMCP   (only your Windows user can open this folder)
```

## Safety: what Claude can and cannot do

| Rule | How it works |
|---|---|
| **Drafts only (default)** | Claude writes replies into a drafts queue. Nothing is sent until **you** approve it, either in Claude ("approve draft 3") or in a terminal (`npm run drafts`). |
| **Allowlist** | Claude can only see and reply to chats whose numbers you list in `config.json`. Every other chat is invisible to Claude. **Groups are blocked** unless you add their ID. |
| **Replies only** | Claude can only write into an existing chat where that person has messaged you before. It can't message new numbers, broadcast, post status updates, or send to many people at once. |
| **Human-like sending** | Before each message: "typing…" for a few random seconds. Limits: **5 messages per chat per hour** and **20 per hour in total** (you can change these). |
| **Kill switch** | `npm run kill` stops all sending instantly, even a message that's already "typing". `npm run unkill` turns sending back on. |
| **Audit log** | Every draft, approval, send and blocked attempt is written to `audit.log` with the time, chat and text. |
| **Private folder** | Session keys, database, media and logs live in one folder that only your Windows account can open. Credentials are never logged. |
| **No telemetry** | No analytics and no link-preview fetching. The only outbound connections go to WhatsApp's servers. The local control channel listens on `127.0.0.1` only and needs a random secret token. |

These checks run inside the **listener**, not in the part Claude talks to, so Claude can't get around them.

---

## 1. Install (one time, about 10 minutes)

You need:
- **Windows 10 or 11**
- **Node.js 24 LTS** (version 22 or newer) from https://nodejs.org. Use the default installer options.
- **Git** from https://git-scm.com (or download this repo as a ZIP)
- **Claude Desktop**

Open **PowerShell** (Start menu → type "PowerShell") and run:

```bash
cd $HOME
```

```bash
git clone https://github.com/realgrowthnexus/whatsapp-mcp.git
```

```bash
cd whatsapp-mcp
```

```bash
npm install
```

```bash
npm run build
```

```bash
npm run setup
```

`npm run setup` creates your private data folder at `%LOCALAPPDATA%\WhatsAppMCP`, locks it to your Windows user, writes a default `config.json`, and prints the Claude Desktop entry.

## 2. Link your WhatsApp (scan the QR code)

```bash
npm run link
```

1. A QR code appears in the window. If it's hard to scan, open the `qr.png` file whose path is printed under it.
2. On your phone: **WhatsApp Business → ⋮ (Android) or Settings (iPhone) → Linked devices → Link a device**, then scan.
3. When you see **"✅ Linked!"**, wait about a minute while recent chats download, then press **Ctrl+C**.

## 3. Choose which chats Claude may use (allowlist)

List your chats and their numbers. This list only appears in your terminal; Claude never sees it:

```bash
npm run chats
```

Open the config file:

```bash
notepad "$env:LOCALAPPDATA\WhatsAppMCP\config.json"
```

Add the numbers (international format, no `+` needed) and save:

```json
"allowlist": {
  "chats": ["923001234567", "923331112222"],
  "groups": []
}
```

- A group can only be added by its ID, which `npm run chats -- --groups` shows (it looks like `120363012345678901@g.us`).
- `"chats": ["*"]` allows **all** one-to-one chats. This isn't recommended. Groups still need to be listed one by one.
- Changes apply straight away; nothing needs restarting.

## 4. Run it in the background and start it automatically

```bash
npm run install-service
```

```bash
npm run start
```

`install-service` puts a tiny launcher in your Windows **Startup** folder, so the listener starts hidden every time you log in. If it crashes, it restarts itself. It doesn't need admin rights.

## 5. Connect Claude Desktop

The easy way: this adds the entry to Claude's config file for you (a backup is made first):

```bash
npm run setup -- --claude
```

Or add it by hand. Open `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config) and add the entry that `npm run setup` printed. It looks like this, with your own paths:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\YOUR-NAME\\whatsapp-mcp\\dist\\mcp\\index.js"]
    }
  }
}
```

Then **fully quit** Claude Desktop (right-click its icon near the clock → Quit) and open it again. "whatsapp" should now appear in Claude's connectors/tools list.

> **Tip:** The first time Claude uses `approve_draft`, Claude Desktop asks for permission. Choose **"Allow once"** rather than "Always allow" if you want to confirm every send. For terminal-only approvals, set `"approvals": { "allowFromClaude": false }`.

## 6. First real test (5 minutes)

1. Ask a friend (or a second phone) whose number is in your allowlist to send you: *"test message"*.
2. Run `npm run status`. It should say **connected ✅**.
3. In Claude Desktop: **"Show my unread WhatsApp messages."** You should see the test message.
4. **"Draft a reply saying: Thanks, received!"** Claude shows a draft number, e.g. #1. Nothing has been sent yet.
5. **"Approve draft 1."** Your friend sees "typing…", and a few seconds later the message arrives.
6. Check on your phone: the reply shows in the chat as sent by you.
7. Open `%LOCALAPPDATA%\WhatsAppMCP\audit.log`. It lists `draft_created`, `draft_approved` and `message_sent`.

---

## Everyday use, in simple words

| I want to… | Do this |
|---|---|
| **Start** it | `npm run start`. It also starts by itself when you log in to Windows. |
| **Stop** it | `npm run stop`. Claude can still read saved messages, but can't send. |
| **Check** it | `npm run status` shows whether it's connected, the mode, the kill switch and pending drafts. |
| **Stop Claude sending, right now** | `npm run kill` (undo with `npm run unkill`). |
| **Approve drafts myself** | `npm run drafts` walks through each draft: approve, discard or skip. |
| **Re-link** (new phone, or "session logged out") | `npm run relink`, then `npm run link` and scan the new QR, then `npm run start`. |
| **Update** to a new version | `npm run stop` → `git pull` → `npm install` → `npm run build` → `npm run start`. Your messages, drafts, login and config are kept. |
| **Remove** it completely | `npm run stop` → `npm run uninstall-service` → on your phone, Linked devices → log out "Windows" → delete the `%LOCALAPPDATA%\WhatsAppMCP` folder → remove the `whatsapp` entry from Claude's config. |

Things you can ask Claude:
- "Which clients messaged me today and haven't had a reply?"
- "Summarise my chat with Ahmed from last week."
- "Search my WhatsApp for 'invoice'."
- "Download the voice note Sara sent and tell me what she said."
- "Draft polite replies to all unread messages." (Then: "approve drafts 4 and 5, discard 6.")

## Tools Claude gets

| Tool | What it does |
|---|---|
| `list_chats` | Recent chats: name, last message, unread count, last activity |
| `get_unread` | All unread messages, grouped by chat |
| `read_chat` | History of one chat (`limit`, `before`, `after`) |
| `search_messages` | Keyword search across chats |
| `get_contact` | Contact name(s) and number |
| `download_media` | Saves an image, video, voice note or document to `%LOCALAPPDATA%\WhatsAppMCP\media` and returns the path. Voice notes are transcribed offline if set up. |
| `draft_reply` | Saves a reply to the drafts queue. **Does not send.** |
| `list_drafts` / `approve_draft` / `discard_draft` | Review drafts; send the approved ones |
| `mark_as_read` | Blue ticks for a chat, like opening it on your phone |
| `get_status` | Connected? Mode? Kill switch? Sent this hour? |
| `send_message` | Direct send. **Only appears when `autoSend` is `true`** (and the kill switch is off). |

## Configuration (`%LOCALAPPDATA%\WhatsAppMCP\config.json`)

```json
{
  "autoSend": false,
  "killSwitch": false,
  "allowlist": { "chats": [], "groups": [] },
  "approvals": { "allowFromClaude": true },
  "limits": {
    "perChatPerHour": 5,
    "globalPerHour": 20,
    "minDelayMs": 3000,
    "maxDelayMs": 12000,
    "maxMessageLength": 2000
  },
  "transcription": { "enabled": false, "whisperCli": "", "model": "", "language": "auto" }
}
```

| Setting | Meaning |
|---|---|
| `autoSend` | `false` = drafts only (safe default). `true` = Claude also gets `send_message`. All other limits still apply. |
| `killSwitch` | `true` = nothing can be sent. Same as `npm run kill`. |
| `allowlist.chats` | Phone numbers Claude may read and reply to. |
| `allowlist.groups` | Group IDs Claude may read and reply to (none by default). |
| `approvals.allowFromClaude` | `false` = drafts can only be approved with `npm run drafts`. |
| `limits.*` | Hourly caps, the "typing" delay range in milliseconds, and the maximum message length. |

If the file has a mistake (for example a missing comma), sending is blocked and the error explains what's wrong. Running `npm run status` shows it too.

## Voice note transcription (optional, fully offline)

Voice notes are turned into text **on your computer** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Audio never leaves your PC. You download two things once:

1. **whisper.cpp for Windows:** from the [releases page](https://github.com/ggml-org/whisper.cpp/releases), download `whisper-bin-x64.zip` and extract it to `C:\whisper`. It contains `whisper-cli.exe`.
2. **A speech model:** download `ggml-base.bin` (about 150 MB) from https://huggingface.co/ggerganov/whisper.cpp/tree/main into `C:\whisper`. For better Urdu, use `ggml-small.bin` (about 470 MB; slower but more accurate).

Then set this in `config.json` (use forward slashes or double backslashes):

```json
"transcription": {
  "enabled": true,
  "whisperCli": "C:/whisper/whisper-cli.exe",
  "model": "C:/whisper/ggml-base.bin",
  "language": "auto"
}
```

`ffmpeg`, which converts WhatsApp's voice format, is installed automatically by `npm install`. Use `"language": "ur"` or `"en"` if auto-detection guesses wrong.

## Where things are stored

Everything is in `%LOCALAPPDATA%\WhatsAppMCP` (for example `C:\Users\you\AppData\Local\WhatsAppMCP`):

| File | What |
|---|---|
| `auth\` | WhatsApp session keys. **Treat like a password.** Anyone with this folder can act as your linked device. |
| `wa.db` | All saved messages, chats and contacts (SQLite) |
| `drafts.db` | The drafts queue |
| `media\` | Downloaded images, voice notes and documents |
| `audit.log` | Record of every draft, approval and send (one JSON line each) |
| `listener.log` | Connection log, with no message contents or credentials (`listener.log.old` is the previous one) |
| `config.json` | Your settings |
| `ipc.json` | Local port and secret token, recreated at every start |

`npm run setup` removes inherited permissions from this folder and grants access to **your Windows user only** (`icacls /inheritance:r /grant:r <you>:(OI)(CI)F`). Back the folder up only to places you trust.

## Troubleshooting

| Message | What to do |
|---|---|
| **"Session logged out — re-scan QR"** | WhatsApp unlinked this computer, for example from your phone or after about 14 days with your phone offline. Run `npm run relink`, then `npm run link`, then `npm run start`. |
| **"The WhatsApp listener is not running"** | `npm run start`. If it keeps stopping, look at the end of `listener.log`. |
| **"Another program opened this same WhatsApp session"** | Two listeners were running. Run `npm run stop`, then `npm run start`. |
| **"…not in allowlist…"** | Add the number to `allowlist.chats` in `config.json`. |
| **"Claude can only reply inside an existing chat…"** | That person has never messaged you. This is blocked on purpose. |
| **"Rate limit: …"** | The hourly cap was reached. Wait, or raise `limits` in `config.json` carefully. |
| **"Sending is switched OFF by the kill switch"** | `npm run unkill`. |
| **"No WhatsApp data yet"** in Claude | Run `npm run link` first. |
| Claude doesn't show the whatsapp tools | Check the paths in `claude_desktop_config.json`, run `npm run build`, then fully quit and reopen Claude Desktop. Logs are in `%APPDATA%\Claude\logs\mcp-server-whatsapp.log`. |
| `npm install` fails on `better-sqlite3` | Use Node.js 22 or 24 LTS. If you're on a newer non-LTS Node, switch to LTS. |
| Media download fails | WhatsApp deletes media from its servers after a while, so very old media may be gone. |

## Important limits and honest warnings

- This uses WhatsApp's **unofficial** linked-device protocol, like WhatsApp Web. The human-like delays and low limits greatly reduce the chance of WhatsApp flagging the account, but no tool can guarantee that. Keep the limits low and only reply to people who wrote to you.
- Your phone must be online at least every ~14 days, or WhatsApp unlinks all devices.
- On first link, WhatsApp sends **recent** history only. Everything after linking is saved in full.
- WhatsApp allows up to 4 linked devices. This counts as one, shown as "Windows" or "Desktop".

## For developers

```bash
npm test
```

This builds the project and runs the test suite. The suite includes a full end-to-end flow against a fake WhatsApp connection: message arrives → `get_unread` → `draft_reply` → `approve_draft` (typing indicator + delay) → sent → audit log. It also covers allowlist, group, unknown-number, rate-limit, kill-switch (including mid-typing), auto-send, LID and local-channel security tests, and a stdio test that runs the built MCP server the way Claude Desktop does.

```
src/
  shared/    config, paths, private folder, database schema, queries, drafts, audit log, IPC client
  listener/  Baileys connection (wa.ts), storage (store.ts), safety rules (guard.ts),
             send queue (actions.ts), localhost server (server.ts), transcription, supervisor
  mcp/       the MCP server Claude Desktop launches (server.ts = tools)
  cli/       setup, status, start/stop/auto-start, drafts review, kill switch, relink, chats
test/        unit + end-to-end tests
```
