# Sample 2 — Desk assistant: new email → Fo → round device

A small Python script (`mail_to_fo.py`, standard library only) reads your mailbox over IMAP, checks for new unread
email every 30 seconds, and hands each email to **one** long-lived Fo harness named **Fo inbox**. Fo sums up the email
in one sentence and tells you what to do about it. When Fo finishes answering, its turn ends: the round device beeps
and creates a Notice with the recap. Job-hunt emails also update the `GLANCE …` line, so the
[Sample 1](../01-fo-glance/README.md) screen can draw the numbers.

```
Gmail ──IMAP/TLS──▶ mail_to_fo.py ──ws://127.0.0.1:18473/api/local-ws──▶ Harness daemon ──▶ Fo (cloud)
                                                                              │
                                                 round device ◀── recap ──────┘
```

What you'll see on the device (rendered by the firmware's own drawing code):

| 1. Email arrives | 2. Tap the bell | 3. Open Fo inbox |
|---|---|---|
| <img src="../images/device-notice.png" width="220" alt="Bell with 1 beside the working pet"> | <img src="../images/device-inbox.png" width="220" alt="Notices page with Fo inbox's message"> | <img src="../images/device-glance.png" width="220" alt="Glance screen with the job-hunt numbers"> |
| Fo answered: the bell and its count pop in beside whatever agent you're on | Notices: the machine, **Fo inbox**, and Fo's one-line summary | with Sample 1 flashed, a job-hunt email shows as numbers; without it, the recap card |

What the script sends to Fo: the sender, subject, date, the body as plain text (HTML stripped, cut to 2,000
characters) and the summarizing instructions. The script **doesn't save email** to disk: `state.json` only keeps the
harness id and the UIDs it has handled. It **doesn't mark email as read** unless you run it with `--mark-read`.

## The files

| File | What it is |
|---|---|
| `mail_to_fo.py` | the main script: IMAP → text → harness (with a minimal RFC 6455 WebSocket client) |
| `test_mail_to_fo.py` | unit tests (MIME multipart, HTML stripping, RFC 2047 header decoding, the 2,000-character cut, `state.json`, a fake IMAP loop) |
| `sample.eml` | a fake email (an interview invitation, HTML, non-ASCII headers) to try without a mailbox |
| `.env.example` | a config template; copy it to `.env` |

## 1. Get ready

1. Finish steps 1 and 3 of the [main guide](../README.md): Harness is running (`harness start`), you're signed in,
   and **Fo is connected** (Settings ▸ Connectors ▸ **Add custom**, `https://mcp.api.wajo.ai/fo`).
2. Python 3.9 or later (`python3 --version`). Nothing to `pip install`.
3. Check that the script can talk to the daemon and Fo:

   ```bash
   cd samples/hackathon-fo/02-desk-assistant
   python3 mail_to_fo.py --check
   ```

   **You should see:** `Fo is connected.` If you see `NOT_CONNECTED` or `DAEMON_UNREACHABLE`, see
   [Stuck?](#7-stuck) below.

## 2. Gmail app password

Gmail doesn't allow IMAP sign-in with your regular password. You need an **app password** (16 letters):

1. Turn on **2-Step Verification** for your Google account: https://myaccount.google.com/security.
2. Open https://myaccount.google.com/apppasswords, enter a name (for example `harness-desk`), and click **Create**.
3. Google shows 16 letters like `abcd efgh ijkl mnop`. Copy them right away (they're shown only once).
4. Your company's Google Workspace admin may have turned off app passwords. If so, use a personal Gmail account.

Use a test mailbox or a separate label (for example, a filter that moves job email to a `Jobs` label) so you don't send
your whole personal inbox to Fo.

## 3. Set up `.env`

```bash
cp .env.example .env
```

| Variable | Example | Meaning |
|---|---|---|
| `IMAP_HOST` | `imap.gmail.com` | the IMAP server (port 993, TLS) |
| `IMAP_USER` | `you@gmail.com` | your email address |
| `IMAP_APP_PASSWORD` | `abcd efgh ijkl mnop` | the app password from step 2 |
| `IMAP_FOLDER` | `INBOX` or `Jobs` | the folder / label to watch |
| `POLL_SECONDS` | `30` | how often to check (at least 10) |

`.env` and `state.json` are already in `.gitignore`: don't commit them.

## 4. Run it

First try it with the fake email, no mailbox needed:

```bash
python3 mail_to_fo.py --dry-run-message sample.eml --print-only   # only prints what would be sent
python3 mail_to_fo.py --dry-run-message sample.eml                # really sends it to Fo
```

**You should see** (in about 15–40 seconds):

```
Started Fo inbox (cloud_…).
Fo: GLANCE applied=0 replies=0 interviews=1 goal=10

A company invited you to interview for the Frontend Engineer role on Monday Oct 20 at 10:00 …
```

Next time, the script doesn't create a new harness; it keeps writing to **Fo inbox** (`Sent to Fo inbox (cloud_…)`).
Its id is in `state.json`. If you close that harness, the script creates a new one next time.

Then run it for real with your mailbox:

```bash
python3 mail_to_fo.py              # runs until you press Ctrl-C
python3 mail_to_fo.py --once       # checks once, then exits
python3 mail_to_fo.py --mark-read  # marks the emails sent to Fo as read
```

**You should see:** `Watching INBOX of you@gmail.com every 30 s -> Fo inbox.` Send yourself an email. Within 30
seconds you get `New mail 1234: <subject>`, then Fo's answer. On the first run, **every** unread email in the folder is
sent, so start with a folder that has few unread emails.

Other options: `--env PATH`, `--state PATH`, `--port N` (default 18473, or the `HARNESS_PORT` variable), `--help`.

### When Fo isn't available: `--engine claude`

```bash
python3 mail_to_fo.py --engine claude --dry-run-message sample.eml
python3 mail_to_fo.py --engine claude
```

The same content goes to a **Claude Code** harness on this machine, named **Mail inbox**, in the
`~/harnesses/mail-inbox` folder that Harness creates. Claude Code must be installed and signed in (`claude`). Later
emails are typed into its pane. The script waits for Claude to finish its turn before it sends the next email, and
prints `Claude finished its turn.`. Read the answer in the **Mail inbox** pane of Harness Desktop or on the round
device.

## 5. On the round device

- While Fo works, the **Fo inbox** tile switches to the working state.
- When Fo finishes answering: the device **beeps** and the **Notices** bell gets a new entry. Open it to see the
  **recap**, the first paragraph of Fo's answer (a one-sentence summary + what to do).
- Job-hunt emails: the answer starts with `GLANCE applied=… replies=… interviews=… goal=10`. With the Sample 1
  firmware, the device draws the glance screen (three numbers and a progress ring) instead of the recap card. The stock
  firmware just shows that line as text.
- If Fo asks a question and offers choices (a list of 1., 2., …), the question appears on the device's **question
  screen**: tap to choose. Answer questions without choices in Fo's chat pane in Harness Desktop.
- No round device: open Harness Desktop. The **Fo inbox** chat pane shows the whole conversation.

## 6. How the script talks to Harness

No CLI command sends text to an existing harness from a regular terminal (`harness send` is only for agents in the
same tab), so the script talks to the daemon directly over the loopback WebSocket, like `harness new` does:

1. Open `ws://127.0.0.1:18473/api/local-ws` (no `Origin` header, no token needed; it accepts connections from this
   machine only).
2. Send `{"type":"machine_select","payload":{"machineId":"<id>","localProtocolVersion":1,"tool":true}}`. Get the
   `machineId` from `harness machines list --json` (the `"current":true` row). Wait for the `connected` frame.
3. Each request is `{"type":"<name>","payload":{…,"requestId":"<uuid>"}}`. The answer is `<name>_result` with the same
   `requestId`, with `error`/`detail` if it was rejected.

| Request | What it's for |
|---|---|
| `cloud_agents {}` | whether Fo is connected (`agents[].connected`) |
| `agent_create {engine:"fo", name:"Fo inbox", prompt, creationId}` | creates the Fo harness with the first email (an empty prompt is rejected: "Tell Fo what to do.") |
| `cloud_send {agentId, text}` | sends the next email to Fo inbox |
| `cloud_transcript {agentId}` | reads Fo's answer to print it in the terminal |
| `agents_list {}` | whether the harness is still alive (`id`, `status`, `activity.state`) |
| `agent_create {engine:"claude", name:"Mail inbox", projectSource:"new", projectName:"mail-inbox", prompt, creationId}` | the Claude Code harness (`--engine claude`) |
| `message {agentId, content}` | types text into the Claude pane (the daemon doesn't answer this frame) |

The script doesn't send the recap to the round device: the daemon creates it when Fo's turn ends
(`cli/src/core/agents/cloud.ts`, `commander_event` of type `summary`). To dig deeper: `cli/src/localWsServer.ts` (the
handshake), `cli/src/cloud/service.ts` (`cloud_*`), `cli/src/cloud/fo.ts` (Fo over MCP), `cli/src/lib/newCommand.ts`
(`harness new`).

## 7. Stuck?

| You see | What to do |
|---|---|
| `NOT_CONNECTED: Fo is not connected` | Connect Fo: Harness Desktop ▸ Settings ▸ Connectors ▸ **Add custom**, URL `https://mcp.api.wajo.ai/fo`, sign in to Wajo in the browser. Run `--check` again. In the meantime you can use `--engine claude`. |
| `DAEMON_UNREACHABLE: Harness is not running on port 18473` | The daemon isn't running: `harness start` (or open Harness Desktop). `harness status` should say `● running`. |
| `NOT_SIGNED_IN` | `harness login`, then `harness start`. |
| `DISCONNECTED: closed 4404 NO_PEER_LINK` (or `4403 machine mismatch`) | Wrong `machineId`: check that `harness machines list --json` has a `"current":true` row. |
| `Poll failed: b'[AUTHENTICATIONFAILED] Invalid credentials …'` | Wrong app password, or you used your regular password. Create a new app password (step 2). |
| `Cannot open folder Jobs` | Wrong label name. Write nested labels as `Parent/Child`. |
| `Fo has not answered yet; its reply still reaches the device.` | Fo took longer than 3 minutes to answer. That's fine: when it's done, the round device still gets the Notice. |
| Fo inbox doesn't show up | Open Harness Desktop: the **Fo inbox** pane sits with your other harnesses. Delete `state.json` to start a new harness. |
| `--engine claude` sits idle | Claude Code is asking something in the **Mail inbox** pane (sign-in, folder permission): answer it in the pane. |
| The round device doesn't beep | See steps 4–5 of the [main guide](../README.md): a data cable, and the device shows up in Devices. |

Run the tests:

```bash
python3 -m unittest -v
```
