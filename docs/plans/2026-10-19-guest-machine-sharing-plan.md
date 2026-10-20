# Guest machine sharing — plan

Replaces the "full owner rights" model of [2026-10-15-share-machine-plan.md](2026-10-15-share-machine-plan.md).
People were not comfortable sharing a whole machine. Decided with the owner on 2026-10-19:

- **Guest is the only level.** It applies to email and domain shares alike. There is no Full level.
  Existing (test) shares are cleaned up, not migrated.
- A guest's harnesses **run as a separate OS user**, one per guest, so they cannot read the
  owner's files, logins or other harnesses.
- **Guests can use the owner's Claude and ChatGPT subscriptions** through a relay in the
  owner's daemon. The owner's token never leaves the owner's account. Subscriptions first;
  saved API keys later.
- Out of scope: owner controls (per-person limits, approval, activity view, notifications).

⚠️ Personal plans (Claude Pro/Max, ChatGPT Plus/Pro) are single-user under the vendors' terms,
and the subscription endpoints are undocumented. The owner accepted both risks.

## What a guest can do

| Can | Cannot |
|---|---|
| Start harnesses in their own workspace on the machine (and later, in folders the owner shares) | See the owner's files, harnesses, terminals, transcripts, settings or devices |
| See, open, type into, stop and resume **their own** harnesses | Pair or unpair devices, change the remote password, share the machine |
| Use the owner's Claude/ChatGPT subscription for those harnesses | Read the owner's credentials or keys |
| Use the machine's CPU/GPU and local models | Reach the owner's daemon API or other machines through it |

## Today's gaps (from a code survey, 2026-10-19)

1. **A shared key is a full owner in the core.** It opens as role `web`, and
   `owner = local || role === 'web'` (`cli/src/backendSocket.ts:856`). No email reaches the core;
   the only trace is the paired-key label (`<machine> · <email>`, `services/sharedMachines.ts:91`).
2. **The gateway answers pairing management before the core** (`e2ee_pairings_list/unpair/unpair_all`,
   `gateway/gateway.ts:536`, `lib/e2ee/manager.ts:291-328`), with no shared check. A guest can unpair
   the owner's devices.
3. **Broadcasts reach guests.** Every session gets the machine's group key in its welcome
   (`manager.ts:894`), and the backend sends broadcasts to every `web` client (`backend/src/lib/hub.ts:80`).
4. **The loopback API has no credential.** HTTP on `127.0.0.1:<port>` has only a CSRF header
   (`hookServer.ts:441-446`). The local WS on TCP "deliberately has no credential"
   (`localWsServer.ts:283`), and a TCP client can even drive the owner's other machines
   (`localWsServer.ts:448`). Any local process — a guest OS user included — is the owner.
5. **Launches run as the owner** in the owner's tmux, from a 0600 launch script
   (`lib/engineLaunch.ts:508`), with grid and API keys in the environment (`lib/gridLaunch.ts`).
   Agents carry no record of who started them (`lib/registry.ts`).
6. **Engines live in the owner's home.** `~/.local/share/claude` and `~/.harness/runtime` are 700.
   The home itself is `drwxr-x---` group `staff`, so any user in `staff` can traverse it.

## Design

### Identity: who a session is
- `sharedTrust` passes each trusted key's **member email** (from the backend's `shareMembers`).
  `PairedClient` stores it as `sharedWith` in `paired.json`.
- The gateway reports `guest: <email>` on `core.client(connId, …)` for a shared key
  (`RemoteClient.guest`).
- The core treats a session as owner only if `local` (trusted socket or authenticated loopback),
  or `role === 'web'` and not a guest.

### Policy: what a guest may ask
A **default-deny allowlist**, checked once per frame in the core (`backendSocket.ts` dispatch) and
in the gateway for gateway-only types:
- **`agents_list`, `sessions_list`:** only agents whose `guest` is this email.
- **`agent_create`:** forced into the guest's workspace, run as the guest's OS user, on the
  owner's subscription or the guest's own login. No grid or saved-API keys.
- **Own agents only:** `agent_close`, `agent_delete`, `agent_resume`, `agent_restart`,
  `agent_retarget` (subscription only), `message`, `cancel`, `question_response`,
  `terminal_*` (JSON and binary).
- **Allowed:** `engines_probe` (the guest's engines), `usage_read` (the owner's plan limits,
  for the picker), `theme_set`.
- **`fs_list_dir`:** inside the guest's workspace only.
- **Everything else** is answered `GUEST_NOT_ALLOWED`. That covers pairing, devices, shared machines,
  settings, search, memory, connectors, store, models management, shell, handoff, orchestrator
  and cloud.
- **Gateway:** no pairing management, no `device_e2ee_pair`, no `phone_pair`, no `group_sync`
  for a guest.

### Broadcasts
- A guest's welcome carries **no group key** (a random throwaway key).
- The gateway delivers what concerns that guest's own agents (`agent_*`, `turn_*`,
  `node_status`, `agents_changed`) to the guest's connId, sealed with its session key
  (`sendTo`).
- Clients must accept a welcome whose group key never opens a broadcast.

### Loopback credential
- The daemon's existing 0600, uid-checked `hook-credential` (`lib/hookAuth.ts`) becomes the
  **local credential**:
  - TCP HTTP requires `X-Harness-Local: <credential>` (or `Authorization: Bearer`). Only
    `/api/status` and the hook routes keep their own checks.
  - The TCP local WS requires the credential in the upgrade.
  - The Unix socket stays credential-free (0600, owner-only).
- Every owner-side TCP client reads the file and sends it: CLI commands, engine hooks,
  companions, devices, orchestrator, `harness new`/`remote`, and the desktop's TCP fallback.
  hn and the service processes already use the socket.
- Guest harnesses get a **guest-scoped hook token** in their environment, valid only for
  `/api/hook/*` on their own agent.

### Running as the guest's OS user
- **Install (once, by the owner).** Turning sharing on installs
  `/usr/local/libexec/harness/guest-helper` (root-owned, 0755) and
  `/etc/sudoers.d/harness-guests`, which lets the owner's user run that helper without a
  password. On macOS this goes through one standard admin prompt (`osascript … with administrator
  privileges`); on Linux, `sudo` once. Guests are never prompted. An owner who is not an admin
  cannot share; the form says so.
- **Helper commands.** Each validates every argument: user names `hg_<hex>`, the group
  `harnessguest`, paths under `/Users/Shared/HarnessGuests` (Linux: `/home/harness-guests`).
  - `ensure <email>` creates the hidden user, its own primary group (not `staff`), a 0700 home
    and `<home>/work`.
  - `run <user> --cwd <dir> --env K=V… -- <argv>` runs `sudo -u <user> env -i …` with an
    allowlisted environment.
  - `install <user> <engine>` installs the engine into the guest's home, as the guest.
  - `remove <user>` deletes the user and its files when sharing with them ends.
- **The pane.** The guest's pane still lives in the owner's tmux. Its command is
  `sudo -n guest-helper run …`, so the engine process is the guest while the daemon keeps the pty.
- **The launch.** It is inline, with no sourced 0600 launch script and no owner `PATH`, `HOME`
  or keys. Engines come from the guest's home.
- **Hook script.** It is copied to `/usr/local/lib/harness/hook` at install time, so the guest's
  engine can report turns with its scoped token.

### Owner subscription relay
- **The server.** A loopback HTTP relay in the owner's daemon, with **per-guest bearer
  tokens** minted by the daemon. A token is revoked when sharing with that person ends.
- **Claude Code.** The guest's harness gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<relay>/claude`
  and `ANTHROPIC_AUTH_TOKEN=<guest token>`. The relay swaps in the owner's OAuth bearer, adds
  `anthropic-beta: oauth-2025-04-20` and streams the response from `api.anthropic.com`.
- **Codex.** The guest's harness gets a provider `harness_owner`:
  `base_url=http://127.0.0.1:<relay>/codex`, `env_key=HARNESS_RELAY_TOKEN`, `wire_api=responses`.
  The relay forwards to the ChatGPT Codex backend with the owner's access token and
  `ChatGPT-Account-Id`.
- **Owner's tokens.** They are read the way `lib/accountUsage.ts` reads them (Keychain or
  `~/.claude`, `~/.codex/auth.json`). Refresh: when the access token has expired, the relay
  refreshes it and writes the result back where it came from, under a lock, so the owner's own
  engine keeps working.
- **Picker.** The guest's picker shows "Anthropic · <owner>'s subscription", from `usage_read`
  (already per machine).

### Clients
- **Desktop and hn, as a guest.** A shared machine says "Guest · shared by <owner>". It lists
  the guest's harnesses only (the daemon enforces this). New Harness opens in the guest
  workspace. Rename, share, remove and folder browsing outside the workspace are hidden.
- **Owner's Share form.** It explains Guest ("They get their own space on this computer and
  can use your Claude and ChatGPT plans. They cannot see your files or harnesses."). It runs the
  one-time install the first time sharing is turned on.

### Shared folders (phase 3)
- The owner picks folders, read-only or read-write.
- The helper grants the guest's user a macOS ACL (`chmod +a`) or a Linux ACL (`setfacl`).
- The guest's New Harness offers those folders beside the workspace.
- The form warns that anything inside a shared folder, secrets included, is readable.

## Phases
1. **Isolation.**
   - identity and policy;
   - gateway gating;
   - broadcasts;
   - loopback credential;
   - the guest helper with install, ensure, run and engine install;
   - guest launches;
   - client wording and guest view;
   - remove the Full wording, clean up test shares.
2. **Subscription relay.**
   - Claude, then Codex;
   - token refresh;
   - picker label.
3. **Shared folders.**

## Status (2026-10-19)

**All three phases are built** on `feat/guest-machine-sharing`. Where the build differs from the design above:

- **Where it lives.** Guest launches are part of the existing `sharedMachines` service in the edge host
  (`services/guestLaunches.ts`), not a new service. It already knows who the machine is shared with, so it
  revokes a guest's relay tokens on the read after sharing with them ends (`sync`). The core reaches it
  through the port `ports.sharedMachines.guestLaunch` (`core/sharedMachinesLink.ts`) and opens the pane itself
  (`core/agents/guestCreate.ts`), recording `guest` on the registry row.
- **No relaunch of a guest's harness.** Restart, resume, retarget, fork and the boot's restore all build an
  owner's launch, which would run the guest's harness as the owner. All of them refuse a row with `guest`
  (`GUEST_HARNESS_REFUSAL`), and the policy refuses them to a guest. The guest starts a new harness instead.
- **Engines: Claude Code and Codex only** (the two whose subscription the relay spends). Each is installed into
  the guest's home on first use, in the pane itself (`lib/guestPaneCommand.ts`), so the guest sees the
  install. A first message goes to the engine as its first prompt.
- **Turning guest access on** is the `shared_machines` action `enable_guests`. The Share form (desktop and
  hn) runs it before the first share, when `get` says `guestAccess` is not `ready`. When the machine is
  already shared and guest access is off (an update made the helper `outdated`), the form says so and offers
  Turn on.
- **Shared folders.** The owner lists folders, each read only or editable (`set_folders`, kept in
  `shared-machines.json`; the backend never hears of them). The helper's `share <user> [--read DIR]...
  [--write DIR]...` gives a guest exactly those folders: an ACL on each folder and everything in it, and
  search-only entries on the closed folders above it. It keeps a root-owned record of what it gave
  (`/var/db/harness-guests/<user>`), changes only what differs, and `run` may start in a shared folder.
  On each read of the sharing, every guest still named gets the folders and every other guest account
  loses them (`sync`). A guest asks `guest_folders` for its workspace and the folders; New Harness offers
  them (desktop and hn), and a harness starts in a shared folder only when the daemon finds it shared.
- **Loopback credential.** TCP HTTP and the TCP local WS require the 0600 credential (`lib/localCredential.ts`);
  the Unix socket does not. Every owner-side TCP client sends it.
- **Clients.** A shared machine reads "Guest · shared by <owner>". New Harness there offers only Claude Code
  and Codex, with no harness, model or profile; its Project is the guest's workspace or a shared folder, and
  it never browses the owner's folders or asks for Store harnesses. Restart, fork, share, model and agent
  switches are hidden or refused with a sentence.

**Known gaps:**
- **Turn status.** A guest's engine has no Harness hooks, so a guest harness's working/idle state is
  limited. The guest-scoped hook token is left at the `hookTokenMatches` seam (`lib/hookServer.ts`).
- **Relay restarts.** Relay tokens live in memory. If the edge host restarts, the relay starts on a new
  port, and a guest's running harness loses its subscription until the guest starts a new one.
- **Unverified upstreams.** The Codex upstream's headers have not been checked against a real ChatGPT
  sign-in, and Anthropic may refuse relayed OAuth requests. Codex keyring storage is not read.
- **A large first share.** Sharing a folder sets an entry on everything in it, which can take minutes
  for a folder with `node_modules`. The read of the sharing waits for it.
- **Verified only by hand.** The real admin prompt, `dscl` and the sudo `env_keep` need the owner's Mac.


## Testing
- **CLI unit tests:** the policy allowlist, per-agent ownership, gateway gating, broadcast
  filtering, the loopback credential on every route, the helper's argument validation
  (helper commands run through an injected runner), and the relay (against a fake upstream).
- **Two-account e2e** (`cli/e2e/sharedMachines.e2e.ts`): a guest lists only its agents, is refused
  pairing and settings, and cannot read broadcasts.
- **Manual, owner's Mac.** The admin prompt and the real OS user are checked by hand: the
  owner approves the one-time prompt. Automated tests never create OS users.
