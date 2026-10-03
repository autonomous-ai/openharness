# One way in, from any device

September 27, 2026. People arrive in three orders:

- **Phone → computer:** they find the app, then set up their Mac.
- **Computer → computer:** they add a second Mac.
- **Computer → phone:** they already use Harness and add the phone.

Each device needs the same two things, and today it gets them through two separate chores:

1. **An account session: who you are.** The phone signs in with an email code; the desktop app and
   `harness login` sign in through a browser.
2. **Trust: an end-to-end key the other devices accept.** It lets this device read and drive your
   terminals, which the server relays but cannot read. Today that means inventing a remote password
   and typing it on every client, once per computer.

**Proposal: approving a new device on one you already have does both, and it looks the same on
every path.** This plan builds on `2026-09-26-001-mobile-zero-questions.md`.

## Today

1. **Two sign-ins.** The phone uses an email code (`mobile/lib/viewer/email_code_api.dart`); the
   desktop and CLI use browser SSO (`cli/src/cli.ts:846-932`). Over SSH you paste a callback URL
   back by hand.
2. **A password per computer, typed on every client.** You set it twice on the computer and enter it
   on the phone. Wrong guesses lock you out for 5 minutes, doubling up to a day (`e2ee/store.ts:24-25`).
   The desktop app doesn't set one by default (Machines ▸ Set password).
3. **The phone's setup page is four terminal commands**, in a different order from the installer's.
   It can only email them to yourself (`mobile/lib/phone/welcome/connect_computer.dart:15-20, 66-92`).
4. **Nothing survives a reboot without the desktop app.** The CLI installs no launch agent or
   service (`cli/src/cli.ts:6311-6319`).
5. **Your existing sessions aren't there.** Plain `claude` and `codex` sessions are invisible
   (`cli/src/lib/tmuxAgentDiscovery.ts:129-148`).

## The pattern: approve on a device you have

A new device (the phone app, the desktop app, or the CLI) asks for one thing, your email:

```
 NEW DEVICE                               A DEVICE YOU ALREADY HAVE
 ──────────                               ─────────────────────────
 Your email  [ dee@…            ]
 [ Continue ]

 Approve on your iPhone                   ┌──────────────────────────────┐
 or MacBook Pro.                          │ MacBook Air wants to join    │
                                          │ your Harness.                │
 The code on it should read:              │                              │
        482 913                           │ Its code:  482 913           │
                                          │                              │
 [ Use an email code instead ]            │ [ Deny ]          [ Approve ]│
                                          └──────────────────────────────┘
 ✓ You're in. MacBook Air can reach
   your computers, and they can reach it.
```

- **Approve does both.** The new device is signed in and trusted by every computer and phone you
  have. There's no email code and no password.
- **The first device of an account** has nothing to approve with. It signs in with an email code and
  starts your list of devices.
- **With the phone in hand,** a desktop or the CLI also shows the code as a QR. Scanning it approves
  without comparing numbers.
- **No approval, no entry.** Only the account's first device gets in on an email code alone.

### The three orders

1. **Phone → computer.**
   - The phone signs in with an email code. It is your first device.
   - **Set up your computer** leads with the app: *"Get Harness for Mac"* sends
     `harness.autonomous.ai/desktop` to the Mac by AirDrop, Messages or email.
   - On the Mac, install and open the app, then enter your email.
   - The phone shows *"Approve MacBook Pro? 482 913"*. Approve. The Mac is signed in, its daemon is
     running, and the phone lists its sessions.
2. **Computer → computer.** The second Mac enters your email. The first Mac, and the phone if you have
   one, show the approval. Approve. All of them trust each other.
3. **Computer → phone.** The phone enters your email. The Mac shows *"Approve iPhone? 482 913"*.
   Approve.

**The terminal path (the 1%):** `curl -fsSL https://cdn.autonomous.ai/harness/desktop/install.sh | bash`
installs the same desktop app (macOS or Linux) and opens it; the app does the rest. A server over SSH,
with no desktop, gets the CLI alone: `curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash`,
`harness login`, `harness start`. The phone's set-up page is the website's download menu
(autonomous.ai/harness-app): macOS Apple Silicon and Intel, Linux Intel/AMD and ARM, each SENT to the
computer from the release manifest, and CLI, which copies its command. The phone's setup page offers it second, under *"Using a terminal or Linux?"*.

## How one approval is enough

**The device list.** Every device already has its own identity key. The account gets a list of its
trusted devices' keys, and each entry is signed by the device that approved it. The server stores
and hands out the list, but it can't add to it: an entry without a valid signature from a device
already on the list is ignored. A computer's daemon trusts every key it can verify on the list,
where today it trusts only the keys it pinned with a password. So one approval reaches every
computer. Parts exist already: a trusted client can vouch for a new hardware device
(`pairDeviceFromTrustedWeb`, `cli/src/lib/e2ee/manager.ts:465-496`), and the live-code pairing that
underlies it (`manager.ts:405-568`).

**Why comparing six digits replaces the password.** The danger E2E guards against is the server
handing each side its own key and sitting in the middle. The approval exchange commits to both
devices' keys first, then derives the six digits from both (Bluetooth's numeric comparison and
Signal's safety numbers work this way). A server that swapped a key can't make the two screens show
the same digits except by a one-in-a-million guess, and every attempt is a new approval someone has
to accept. You compare instead of typing, and nothing secret has to be chosen or remembered.

**The session comes with the approval.** The approving device asks the backend for a one-time
handoff. The new device, polling, receives its own session: the tokens `harness login` stores today
(`~/.harness/auth/session.json`), written by the app. The backend's device-code flow is most of this
(`backend/src/routes/deviceAuth.ts`). It needs to return a session the daemon's socket accepts;
today it returns a machine key that `/api/adapter-ws` rejects (`backend/src/lib/adapterWs.ts:11-13`).

**Removing a device** is signed from any trusted device, in Settings ▸ Devices.

**Losing every device:** an email code starts a new list. Your computers keep trusting the old one
until you approve at each computer itself (`harness trust reset` shows a code and a QR). This is
rare, and it is deliberate.

**The remote password stays** as a fallback for computers set up by hand and for older CLIs. It is
never asked for on these paths.

## Sessions you already have

After a computer joins, the phone and desktop list its sessions, **including ones started outside
Harness**.

- The session search indexer already reads every engine's transcripts
  (`docs/research/2026-09-26-session-search.md`). Index `~/.claude/projects` and `~/.codex/sessions`
  whole, not only sessions Harness registered.
- Outside sessions show as sessions to resume. Tapping one resumes it in a Harness pane
  (`claude --resume <id>`, `codex resume <id>`).

## Work

| | Part | Est. |
|---|---|---|
| **1. Phone, now** | The setup page leads with "Get Harness for Mac" (share `harness.autonomous.ai/desktop`). The terminal path is second, with `cdn.autonomous.ai/harness/desktop/install.sh` and the installer's own order. Plain-words errors. The computer list refreshes live. | 2 days |
| **2. Backend** | Approval requests (start, poll, approve, deny) that return a daemon-ready session. The signed device list: append-only, delivered to every device. Push to the phone for approvals (APNs; "needs you" wants it too). | 1.5–2 weeks + security review |
| **3. CLI / daemon** | Trust keys on the verified list. `harness login` shows the code and QR and waits. A launchd/systemd unit so the daemon survives a reboot. | 1 week |
| **4. Desktop app** | Email-and-approve sign-in in place of the browser. The approval prompt. Settings ▸ Devices. | 1 week |
| **5. Phone** | The same sign-in, the approval prompt, a QR scanner, Settings ▸ Devices. | 1 week |
| **6. Sessions** | Index outside sessions; "Resume" rows. | 1 week |

Part 1 stands alone. Parts 2–5 ship together behind the remote password, which keeps working
throughout. Part 6 stands alone.

## The bar

Hand a phone to someone with a Mac who has never heard of Harness. Within three minutes they are
talking to one of their existing Claude Code sessions from the phone, and they haven't typed a
password or signed in twice.

## Decided (2026-09-27)

- **The welcome screen is your sessions.** When a computer joins, the first screen is "Pick up where
  you left off": the Claude Code and Codex sessions already on it, newest first, including ones
  started outside Harness. Tap one to resume it. Only an account with no sessions sees New.
- **A QR skips the email.** A device you have shows "Add your phone" (or a new Mac shows a QR); the
  other scans it and is signed in and approved in one step. Email is typed only on the first device.
- **Spam-proof approvals:** the approver picks the new device's number from three, not just Approve
  (number matching, so a flood can't be tapped through). Requests are rate-limited per account and
  expire in 2 minutes. The prompt names the device and city, with "Not me" to block it.

1. **Approval:** compare six digits everywhere; a QR where a phone camera is in hand.
2. **Unapproved devices get nothing.** Only the account's first device signs in on an email code.
3. **Sign-in is your email, never a password,** on the phone, the desktop and the CLI: approve on a
   device you have, or a six-digit email code for your first. The browser sign-in retires.

- **Scan and go, built (2026-09-27).** The Autonomous account service can't sign one device in
  from another (its grants are password, otp, refresh_token and social_token), so Harness issues
  the phone's session itself. The signed-in Mac asks the backend for a one-time code
  (`POST /api/auth/handoff`, 32 random bytes, 90 s, spent by the first redeem) through its daemon's
  owner-only socket. Add Phone puts it in the QR as `h=` and renews it every minute. The phone
  trades it at `/api/auth/handoff/redeem` for a `hna_`/`hnr_` session (`backend/src/lib/harnessSession.ts`),
  renewed at `/api/auth/refresh` and revoked on sign-out. Every sign-in check goes through
  `authenticateAccessToken`, so that is the one branch; machine connections refuse these sessions.
  No Allow click on the Mac, by decision: the QR is fresh, single use and on screen for a minute.
  "Remove" for a phone that isn't yours comes later. Old apps, CLIs and backends fall back to the
  emailed code. A phone session can't mint codes, or use billing routes that forward the token to
  the account service.
- **Trust stays per computer, as it is.** A computer admits only keys on its own list
  (`cli/src/lib/e2ee/manager.ts` `onHello`), so one viewer links N computers: O(N), which is fine.
  The signed device list is shelved; it would only save the per-computer password steps.

## Open

1. **Outside sessions** (Claude Code or Codex started by hand, not through Harness). Index them by default, or ask once on the computer ("Show my Claude Code and
   Codex sessions on my phone?"). They never leave the machine except as sealed search hits and
   previews, as today.
