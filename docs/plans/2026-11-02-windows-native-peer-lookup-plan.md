# Windows: a native account lookup for local connections: Implementation Plan

> Way of working: this project's instructions. The Engineer implements it task by task, each failing test committed before its code. Security Reviewers: Reed and Orion. The PM starts the real Windows run on the final head.

**Goal:** The check of who is calling over loopback runs natively in `harness-pty` in milliseconds, keeping W1's answers and fail-closed rules, with PowerShell only if the helper is missing.

**Architecture:** A new `harness-pty peer-account` command reads the connection's row (`GetExtendedTcpTable`, `TCP_TABLE_OWNER_MODULE_CONNECTIONS`, which gives its owner and creation time), then the owner process's creation time and token. A pure `verdict` holds the rules, so they run on every platform's tests; a thin Windows layer gathers the facts. `peerAccount.ts` runs it, one process per new connection, as it runs PowerShell.

**Tech Stack:** Rust with `windows-sys` (`pty/`), TypeScript (`cli/`).

**Spec:** Task #2187; W1 (#2605) and `docs/security/2026-11-02-team-account-windows.md`.

## Global Constraints

- Same answers as W1: exactly one established row of the exact pair 127.0.0.1:peer to 127.0.0.1:own; owner compared by SID, never by name; a process gone, unreadable, or started after its connection is no; anything that fails is no.
- The helper's no is final: PowerShell runs only if the helper is missing or too old to know the command, never to ask again after a no.
- Ports and pids are arguments, checked as numbers.
- PR body starts: `Requested by scholes@autonomous.ai through Harness.`
- Two independent security reviews. The real Windows run, x64 and ARM, on the final head.

## Review Focus

- A recycled process id: the process now holding it started after the connection. Answer no, to the finest time Windows gives.
- The lookup itself, or another lookup at once, taking a freed id. Answer no.
- A process of another account whose token Windows will not open. Answer no, and no PowerShell after it.
- An older `harness-pty` beside a new CLI: it refuses the unknown command, and PowerShell answers as before.
- A helper that hangs or dies: its connection is refused, not left waiting.

## Design

- **Growth:** N/A because nothing is stored.
- **Concurrency:** W1's limit of lookups at once and its queue stay. Each lookup is one short process.
- **Read cost:** one read of the TCP table and one process's facts per new authenticated connection, asked only after the secret matched.
- **Scale (10x):** a table of tens of thousands of rows is still read once per new connection. What warns first: the lookup's log line and its time in the real Windows spec.
- **Compatibility:** an older `harness-pty` falls back to PowerShell. Other platforms answer `unsupported` and keep their own lookups.
- **Migration + rollback:** none. Rolling back restores PowerShell.
- **Audience:** N/A because it answers only yes or no to the daemon that started it.
- **Identity:** compares the caller's SID with this process's own; never a name.
- **Failure:** every failure is no, logged with its reason.
- **Platforms:** Windows x64 and ARM; elsewhere the command says unsupported.

---

### Task 1: The rules, in `harness-pty`

**Files:**
- Create: `pty/src/peer.rs`
- Modify: `pty/src/cli.rs`, `pty/src/lib.rs`, `pty/src/ps.rs`, `pty/Cargo.toml`

**Interfaces:**
- Produces: `harness-pty peer-account --peer-port N --own-port N --daemon-pid N`, printing `yes` or `no: <why>`, exit 0. Exit 2 for usage or an older binary's unknown command; exit 3 unsupported.

- [ ] **Step 1: Commit failing tests** of the pure `verdict`, one per rule above, and of the command's arguments.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Commit the code**, then the Windows layer, cross-checked for x64 and ARM.

### Task 2: `peerAccount.ts` asks it

**Files:**
- Modify: `cli/src/lib/peerAccount.ts`, `cli/src/lib/peerAccount.spec.ts`, `cli/src/lib/windows/peerAccount.windows.real.spec.ts`

**Interfaces:**
- Consumes: the command above; `ptyHostBinary()`.

- [ ] **Step 1: Commit failing tests:** yes and no are taken from the helper; PowerShell runs only when the helper is missing or says 2 or 3; a hang or crash is no, without PowerShell; the real spec measures each lookup under 1 s.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Commit the code. Mark the pull request ready; message Reed and Orion in their steps; ask the PM for the real Windows run.**
