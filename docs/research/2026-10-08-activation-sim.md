# Activation: simulated new users on a fresh Mac (2026-10-08)

Goal: a brand-new user reaches a **first successful session** (an agent finishes a real piece of
work) as fast as possible, keeps working, and comes back for a **second session** that picks up
where they left off. Every run below is a fresh macOS VM driven like a new user would drive it:
download from the website, drag to Applications, open, type a task.

## Why

New-user D1 dropped from 64% (16/25, 2026-09-28/29 cohorts) to 28% (17/60, 09-30 → 10-06),
Fisher p ≈ 0.003, while retention after D1 stays flat. Users who ran a turn on day 0 came back on
day 1. The gate is the first turn.

## Rig

- VM: Tart (built from source, guest-agent removed; the Homebrew tap is broken on this brew),
  `ghcr.io/cirruslabs/macos-tahoe-vanilla` (macOS 26.6.2, user `admin`, SSH + auto-login). A bare
  Mac: no Homebrew, no Node, no Xcode Command Line Tools (`/usr/bin/git` is the install shim), no
  Claude Code, no Codex.
- Driven over VNC (`vncdo`) with screenshots after every step, and SSH for read-only checks.
- Each run starts from a fresh APFS clone of the image.
- Network: Vietnam (Cloudflare DAD/HKG). GitHub's release CDN was unreachable from here for about
  an hour this morning, then came back.

## Personas

| Id | Has | Signed in to the engine |
|----|-----|------------------------|
| A | nothing (no Claude Code, no Codex) | — |
| B | Claude Code | yes / no |
| C | Codex | yes / no |
| D | Claude Code and Codex | yes / no |

"Signed in" engines are simulated with Harness's fake engines (`cli/e2e/harness/fakeEngine.mjs`),
since a real account cannot be signed in overnight. "Installed, not signed in" uses the real
vendor binaries, so their real login screens appear.

## Activation score (per run, 0–100)

| Part | Points | How |
|------|--------|-----|
| First result | 40 | The agent finished the first task in the first session. 0 if not. |
| Time to first result | 20 | From first app open to the first result, counting only machine time and required user steps. 20 at ≤ 90 s, falling linearly to 0 at 10 min. |
| Friction before the first result | 20 | −15 per blocker (an error or dead end the user must work out), −5 per needless decision or prompt. |
| Second session | 20 | 10 if reopening shows the previous work and a new task starts in one step; 10 minus 5 per unexpected prompt or error on reopen. |

## Runs

| Run | Build | Persona | First result | Time | Friction | 2nd session | Score |
|-----|-------|---------|-------------|------|----------|-------------|-------|
| A1 | desktop 1.2.59, CLI release | A | yes (OpenCode free model) | ~80 s machine + forced picker | blocker: "OpenCode is unavailable. Choose an agent." | restored; Local Network prompt | **~69** |
| A2 | branch (fa64b0e15), CLI release | A | yes | box ready ≤ 45 s, result 39 s after Enter (~85 s) | none | restored, no prompt; "Untitled Pane" (fixed in f8ca37071) | **~92** |
| A3 | branch (916f244d7 + Git fixes), branch CLI | A | yes | box ≤ 45 s on first open; OpenCode installed in the background 8.6 s after the daemon; result 29 s after Enter, 54 s after opening (incl. ~20 s typing) | none | restored, no prompt; second harness in the same project ran in 14 s after the Git fixes | **~97** |
| B2 | branch, CLI 9.0.2 preinstalled | B, signed in (fake) | yes | box opens on Claude Code; first message answered at once (fake) | none | second harness "Untitled Pane" (fixed e71fb2644) | — |
| B3 | branch, CLI 9.0.2 preinstalled | B, not signed in, Anthropic blocked | no (network) | — | error now stays in the pane; recovery via the header's Change agent | — | — |
| D1 | branch, CLI 9.0.2 preinstalled | D, both signed in (fake), Codex last | yes | box opens on Codex; answered within 12 s of Enter | none | — | — |
| A5 | branch-2 (setup-time task, f8112ccd0), CLI release | A | yes | task typed and sent during setup at 21 s; first file at 70 s after opening, no further action (released CLI: grid still downloaded, OpenCode installed in the pane) | none | — | — |
| A6 | branch-2 (af410791d), CLI release | A | yes | task sent during setup at 14 s; first file at 72 s; the person was in Finder meanwhile | none | back in Harness: "An agent finished while you were away. Get a notification next time? Turn on" | — |
| C1 | branch-2, CLI release | C, Codex from npm, not signed in | no | — | blocker: "could not verify Codex startup options" (first `codex --help` past the 5 s check) | — | — |
| C2 | branch-2 + CLI 9.0.3 (e1aa14ed7) | C, same | sign-in screen | box keeps OpenCode, picker says Codex Needs sign-in; picking Codex opens its own sign-in screen with the task held | none from Harness (sign-in is the person's step) | — | — |
| A7 | everything combined (PR #1047 + follow-up), the app installing CLI 9.0.4 itself | A | yes | task typed and sent during setup at 15 s; first file at 69 s after opening, no other step; background install then added Claude Code (9.9 s), Codex, Pi | none | — | **~97** |
| I1 | #1054 (background install, third-review fixes) + CLI 9.0.5 installed by the app | A | yes | background install started 42 s after open (OpenCode 7.4 s, Claude Code 8.4 s, Codex 11.7 s, Pi 11.5 s); first harness answered 23 s after Enter, nothing installed in its pane; a second launch (CLI present) started no install | none | — | — |
| I2 | #1054 redesign (one Node lock), CLI 9.0.6 installed by the app | A, harness started as the box appeared | yes | the pane said "OpenCode is already installing in the background — waiting for it"; OpenCode was in place 1 s after the pane opened, but the pane waited behind Claude Code, Codex and Pi: first result 46 s after Enter | one lock serialized unrelated agents | — | — |
| I3 | #1054 + waiting fix (8d0093761), CLI 9.0.7 | same | yes | the pane went ahead as soon as OpenCode was in place: first result 14 s after Enter, 62 s after first open | none | — | — |
| R1 | #1054 build, the I3 VM the next "day" | A, restarted Mac | — | Harness reopened at login with the first harness; OpenCode resumed its session (`--session`) and answered a follow-up; a second harness in the same project wrote its change 13 s after Enter | none | restored, no prompt; new task in one step | **20/20 for the second session** |
| R2 | main + move prompt (#1061), real `.dmg` layout | A, opens Harness inside the disk image | — | prompt "Move Harness to Applications?"; Move reopened it from Applications in 3–4 s (also when Gatekeeper translocated it) and ejected the image | one prompt that saves the second session | — | — |
| B1 | branch, CLI release | B, Claude Code 2.1.294 installed, not signed in | no | — | default still OpenCode; picker shows no install state; Claude Code exited at start ("Unable to connect to Anthropic services", transient network) and its pane vanished: user back on an empty box with a stray "Terminal harness" | — | **~20** |

## Findings

### Full matrix on the combined build (2026-10-08 evening)

#1047 + #1052 (with finding 24) + #1061, desktop debug build, CLI 9.0.11 installed by the app from a
local manifest; every run a fresh VM. "Signed in" engines are the fake engines (they answer at once,
so their times exclude model time); OpenCode runs are real (free model). First task typed on the setup
screen; second session = + tab, new task in the same project, Enter. Scored with the rubric above.

| Run | Persona | Box opened on | First result (from first open) | Second session | Friction | Score |
|-----|---------|---------------|-------------------------------|----------------|----------|-------|
| M-A | nothing installed (CLI 9.0.9, before finding 24) | OpenCode | 67 s | 13 s | Apple's "install developer tools" dialog over the app on both sessions | 90 |
| M-A3 | nothing installed | OpenCode | 69 s | 14 s | none | **100** |
| M-B1 | Claude Code, signed in | Claude Code | ~50 s | at once | none | **100** |
| M-B2 | Claude Code, not signed in | OpenCode (picker: Claude Code "Needs sign-in") | 71 s | 11 s | none | **100** |
| M-C1 | Codex, signed in | Codex | ~50 s | at once | none | **100** |
| M-C2 | Codex, not signed in | OpenCode | 66 s | 12 s | none | **100** |
| M-D2 | both signed in, Claude Code used last | Claude Code | ~50 s | at once | none | **100** |
| M-D3 | both installed, neither signed in | OpenCode (both "Needs sign-in") | 67 s | 16 s | none | **100** |

D1 (both signed in, Codex used last → Codex) is the earlier run above. Reopening the app (M-A, M-B1)
restored every harness with no prompt.


### A1 — bare Mac, official desktop 1.2.59

1. **Blocker: the default agent is "unavailable" on the first New Harness box.** On a bare Mac
   the box opens with OpenCode (the product default) and a red "OpenCode is unavailable. Choose an
   agent." Pressing Enter with a task opens the agent picker instead of starting. Re-picking the
   same OpenCode clears it and the harness starts and installs OpenCode in the pane.
   Cause: `NewHarnessController` treats the product default as a *remembered* agent
   (`_rememberedAgent = !explicitSelection`), and a remembered agent that the engine probe reports
   `installed == false` requires an explicit replacement — even though Harness installs it on
   Create. Same trap before 10-01, when the default was the first engine (Claude Code).
2. The agent picker gives no hint which agents are installed or will install.
3. Setup footer still says "Next: sign in and start a harness."; the setup screen promised a
   sign-in step that does not exist (fixed in 8a932cb1a, the footer still to do).
4. Once started, the first turn worked: OpenCode installed in the pane (~14 s) and the free model
   wrote `index.html` (~8 s). The result says "Open it in a browser to view." with no way to open it.
5. Closing the window quits the app (`applicationShouldTerminateAfterLastWindowClosed`). The daemon
   and the agent keep running.
6. **Reopening asks "Allow Harness to find devices on local networks? … Autonomous robots".** The
   app restarts a daemon it did not launch (09d915773, shipped 09-30 in 1.2.28) and probes the LAN,
   which raises the macOS Local Network prompt for someone with no robot. Don't Allow leaves the
   session working.
7. The DMG window has no "drag to Applications" hint.

### B1 — Claude Code installed, not signed in

8. Default is OpenCode even with Claude Code installed; the picker shows no "installed" marks.
9. **An engine that exits at start leaves no trace.** The daemon (`retainExitedSession`) archives the
   conversation, keeps the shell under a new Terminal identity and sends `agent_deleted`; the desktop
   closes the pane. The error ("Unable to connect to Anthropic services … not available in your
   country") is only in the hidden shell. Next fix, half designed: send `successor: <terminal id>` on
   `agent_deleted` (cli/src/lib/retainExitedSession.ts, compute `releaseEngine` before sending) and
   have the desktop move the panes onto it instead of closing (reuse the agent-switch repoint in
   app_state.dart; the attach must wait for the successor's `agent_synced`).

### A3 — bare Mac, background install, second session

10. **Second session blocked on a Mac without the Command Line Tools.** A new harness in the first
    project (the box's default) failed with "Could not check Git on <Mac>. Check the connection and
    Harness CLI, then retry." `/usr/bin/git` is Apple's installer stub and exits 1, which both the
    desktop's own reader and the daemon's took for "git unavailable". Fixed: a folder with no `.git`
    in it or above it is not a Git project, decided without running git (daemon 4th fix below, desktop
    after it). The misleading "main" branch chip went with it.
11. Background install works: OpenCode 8.6 s, Claude Code 13.3 s, Codex 20.3 s, Pi 11.3 s, one at a
    time, all done about a minute after opening; the first harness never installed in its pane.

### B2 — Claude Code installed and signed in (fake engine; CLI preinstalled)

12. The box now opens on Claude Code (b989c2760); the picker marks Claude Code Installed, Codex
    Needs sign-in (the background install added it), OpenCode Installed, the rest Installs on start
    (69c98f770, 8002fcbd5 — the composer's dropdown is a different widget from the form's list).
13. A second harness in the existing project read "Untitled Pane": only generated projects named
    their agent. A first message now names it wherever it starts (e71fb2644).

### B3 — Claude Code installed, not signed in, Anthropic unreachable

14. The box keeps OpenCode (Claude Code is not signed in) and marks Claude Code Needs sign-in.
15. Picking Claude Code anyway: it exits with "Unable to connect to Anthropic services". The pane now
    stays, with that message and "claude exited (1). This pane is a shell now" (fc88462b5). The
    pane header's agent name opens Change agent; OpenCode there starts in the same folder. The
    first task is not carried to it (Claude Code never took it) — still to do.

### D1 — Claude Code and Codex, both signed in, Codex used last (fake engines)

16. The box opens on Codex; the first task reached it and the pane is named after it.

### A5 — first task typed during setup

17. The setup screen takes the first task ("While this finishes: what would you like to work on?").
    Return queues it ("Starts as soon as this computer is ready.") and the first box starts it once
    the machine has answered the engine probe; typing alone pre-fills the box (f8112ccd0).
18. A run before it (A4) hung on a black window: the VM's `fseventsd` never answered, and the app
    blocks its main thread in a Dart `Directory.watch` at launch (FSEventStreamStart). A fresh clone
    was fine. On a real Mac with a stalled `fseventsd` the same black window would appear; worth
    moving that watch off the first frame.

### A6 — away while the first agent works

19. Returning to Harness after the first agent finished shows the one-time notification offer
    (af410791d). `index.html` in OpenCode's answer is underlined as a link on hover (c4b4df780);
    links open with ⌘-click, which this VNC server cannot send (⌘T arrived as "t"), so the open itself
    is covered by `terminal_link_opener_test.dart` rather than the VM.

### C1/C2 — Codex installed from npm, not signed in

20. The first run of a freshly installed Codex is slow (2.9 s idle, the second 0.05 s); at first
    launch it passed the 5 s `--no-daemon` startup check and the harness failed with "could not
    verify Codex startup options". The check now allows 30 s (e1aa14ed7); C2 opens Codex's own
    sign-in screen (ChatGPT, device code or API key) and holds the task.

### R1 — the next day, after a restart

21. Nothing to fix: macOS reopened Harness at login, the daemon resumed OpenCode with its session id,
    the follow-up turn worked, and a new harness from the + tab started in the last project (13 s to
    the first change). Both tabs read "code" (expected, see the QA notes).

### R2 — Harness opened from inside the disk image

22. **No Harness on day 2.** Double-clicking Harness in the disk image window (instead of dragging it)
    works that day, but after the image is ejected or the Mac restarts there is nothing in
    Applications, Launchpad or Spotlight, and the updater cannot replace a bundle on a read-only
    volume. Fixed in #1061: before the engine starts, "Move Harness to Applications?" copies it, reopens
    it from Applications and ejects the image; opening the image's copy again later goes to the
    installed one. Moving a copy out of Downloads was dropped: it raised macOS's "access files in your
    Downloads folder" prompt, and the website only hands out the `.dmg`.

### Where first-run setup time goes

23. Measured in the R2 VM, back to back on the same network, `install.sh --desktop` in an empty home:
    main 23 s (Node 187 MB unpacked, the CLI, and grid 19 MB), #1047 11 s (no grid). In the R2 app
    run on main, the app opened at 19:35:21, the CLI answered at 19:35:50, the daemon was up 3 s later
    and the agent probe 3 s after that: about 35 s from opening to the New Harness box, of which
    #1047 removes ~12 s. Bundling Node and the CLI in the app would save the remaining ~11 s, at the
    cost of a larger universal app and signing an embedded Node; not worth it before #1047 ships.

### Full matrix

24. **Apple's "install the command line developer tools" dialog on a fresh Mac's first harness.** On a
    Mac without the Command Line Tools, `/usr/bin/git` is Apple's stub, and running it opens that
    dialog in front of Harness. Five daemon readers ran git in a folder with no `.git`: the agent
    project reader as each agent started (4 s after the first task), the pull request reader for the
    focused pane, the project picker's preview, the workspaces service naming a worktree branch once
    the agent had a title, and Change agent's handoff check (review added Harness Monitor's delete preview
    and a Store `--link` install). All of them now decide "not a checkout" from
    the missing `.git` first (`insideGitCheckout`), with a test that puts a recording `git` on PATH
    (`cli/src/lib/gitStub.spec.ts`). Found with a logging `git` wrapper and the
    `com.apple.dt.CommandLineTools.installondemand` log, which names the requesting process's parent.
    An agent that runs `python3` or `git` itself still raises it (OpenCode did, once, in M-A); that is
    the agent's command, not Harness's.
25. **Garbled glyphs in the VM are Impeller on its virtual GPU.** Letters drew as hatched boxes in
    the debug build and, worse, in an AOT (profile) build ("Ope▒C▒▒", "New H▒r▒ess"); the same profile
    build with `FLTEnableImpeller` set to false (Skia) drew every letter correctly. Apple Silicon
    release builds ship on Impeller, so this would show for anyone running Harness inside a macOS VM
    (Tart, UTM, cloud Macs); on real hardware it has not been seen. The black window for several
    seconds at first launch was the debug build only: the profile build showed its first screen
    with content as soon as the window appeared (~5 s after `open`, including Gatekeeper's
    "Verifying Harness…").

### Time to the first result, measured

26. Persona A on a fresh VM with every activation PR combined, #1047's `install.sh` served in place
    of the CDN's (a VM-only `curl` wrapper) and #1067 downloading OpenCode beside setup: **44–46 s
    from opening the app to the first file** (was 67 s on today's CDN installer; ~85 s on the
    release, run A2). Where the 46 s go: CLI install ~10 s, `harness start` 3–6 s, engine probe 1 s,
    the first pane ready in 0.13 s (OpenCode already in place), **OpenCode's own first start 12 s**
    (its database, a 5 MB model list, and an install of `@opencode-ai/plugin` into
    `~/.config/opencode` for Harness's TUI plugin), then the turn ~5 s. `opencode models`,
    `debug config` and `agent list` do none of that first-start work, and `opencode serve` creates
    the database and model list but not the plugin install, so pre-warming it would lean on OpenCode
    internals; not done. Measured in tmux on the VM, fresh home each time: OpenCode's first start
    drew its composer after 3.1–4.9 s without Harness's plugins and 8.4–8.8 s with them, because a config
    folder holding plugins makes OpenCode install `@opencode-ai/plugin` (26 packages) first. So Harness's
    discovery plugins cost ~4–5 s of a new user's first result. `OPENCODE_FAST_BOOT` only skips the TUI's
    loading screen (`skipInitialLoading`), not that install. Options, not taken: install those packages
    ahead (they track OpenCode's version), or register the plugins some other way than the global config
    folder (but that folder is what lets Harness discover OpenCode sessions started outside it).
    Tried and dropped: warming OpenCode during setup with a password-protected `opencode serve` and one
    `/config` request. In isolation it cut the next first start to 2.8–4.9 s. In the real flow it made
    things worse. The server was stopped as soon as `@opencode-ai/plugin` appeared, and the first harness's
    OpenCode then sat 51 s loading its config folder (most likely an interrupted install's lock), so the
    first result came at 87 s against 46 s. Not shipped; the commits stay on local branch
    `prefetch-warm-wip`. The screenshots of the whole flow are in
    `docs/research/2026-10-08-onboarding-flow/index.html`.

## The onboarding build (2026-10-09)

The redesign approved on 2026-10-08 (renders in `docs/research/2026-10-08-onboarding-redesign/`),
built on branch `first-run-onboarding`, desktop only:

- **Setup tour.** Seven slides while a fresh Mac sets up, one quiet line at the bottom with the time
  left and ▸ Details. It waits for setup and for the agent downloads, then opens Harness by itself at
  the end of the slide on screen. Help ▸ Welcome Tour shows it again.
- **Downloads beside setup.** On a computer with no agent: OpenCode (curl, 11–13 s) and Codex plus
  Claude Code (one `npm install -g` into `~/.local` once setup's Node is there, 25–29 s).
- **First workspace** (`desktop/lib/state/first_arrival.dart`), once, on a computer that never had
  Harness: no agent → OpenCode left with "make a small web page that shows today's date" typed but
  not sent, Codex and Claude Code stacked on the right on their own sign-in screens. Claude Code or
  Codex conversations → the ones nothing is running, by last activity: the latest of each agent side
  by side, then the next three in a second tab, mixing the agents.

### Persona matrix (macOS VM, final build)

Claude Code and Codex are the e2e fake engines with real-format transcripts in `~/.claude/projects`
and `~/.codex/sessions`; a "running" conversation is held by a live process the daemon recognises
(a `~/.claude/sessions/<pid>.json` record, or a process named codex holding its rollout open).
OpenCode is the real one. History is listed most recent first (c = Claude Code, x = Codex).
"First arrival" is from the workspace showing to the last pane open. The none, c6, cx-run and repair
rows are from the rerun after the review fixes; the rest from the run before them.

| Persona | Agents | History (running) | Opened | First arrival |
|---|---|---|---|---|
| none | — | — | OpenCode + Codex + Claude Code, task typed | 6.8 s |
| oc | OpenCode | — | OpenCode, task typed | 2.1 s |
| c | Claude Code | — | Claude Code | 3.2 s |
| x | Codex | — | Codex | 3.3 s |
| cx | both | — | Claude Code + Codex | 2.4 s |
| c6 | Claude Code | c c c c c c | 2 + 3 | 4.5 s |
| x4 | Codex | x x x x | 2 + 2 | 3.5 s |
| cx-conly | both | c c c | 2 + 1 | 3.7 s |
| cx-run | both | c x c c x c x (first two running) | c2 + x4, then c3 c5 x6 | 4.8 s |
| cx-allrun | both | c x (both running) | fresh Claude Code + Codex | 3.5 s |
| oc-c | OpenCode, Claude Code | c c | 2 Claude Code | 3.0 s |
| oc-x-run | OpenCode, Codex | x x x (first running) | x1 + x2 | 3.4 s |
| c1 | Claude Code | c | 1 | 2.7 s |
| cx-mix | both | x c c c c x | x0 + c1, then c2 c3 x5 | 4.2 s |
| cli-first | CLI installed from a terminal first | c x | nothing: the New Harness box, as today | — |
| repair | existing user, managed Node gone | c x | nothing: no tour, no first workspace, the New Harness box | — |

New user end to end with the tour: launch → Harness opens by itself at 45 s (all three agents
downloaded) → three panes at 52–53 s → task typed at 65 s, when OpenCode's own screen is up.

Found and fixed on the way:

- Adding a pane resets the tab's layout for that pane count, so the three-pane layout is applied
  once the third pane is in.
- Codex's first start on a fresh Mac took 9.4 s and held Claude Code behind it; a tab's later panes
  now start together.
- Two creates of one engine started together collide in the daemon: tmux sessions are named
  `harness-<engine>-<millisecond>` ("duplicate session"). First arrival never starts two of one
  engine at once. **The daemon should make that name unique** (left for the core refactor).
- Real Claude Code cannot reach `api.anthropic.com` from Node inside this VM (ECONNRESET; curl works,
  the host's Node works), so its pane shows "Unable to connect" there. The VM's network, not the
  product.

## Hill-climb on the merged onboarding (2026-10-09)

Full journeys on a fresh macOS VM per persona (`vm/journey` in the session scratchpad): install and open
Harness (the tour), the first task (Enter on OpenCode's typed task, or a task typed into the first
pane), its result, a second session (a new tab, a task, Enter), and for some the next day (quit,
reopen, a follow-up in the pane that came back). Scored with the rubric above. "Real" Claude Code and
Codex are the npm packages on a Node of the person's own, never signed in; the others are the fake
engines.

| Persona | Opens | First result | Second session | Next day | Score |
|---|---|---|---|---|---|
| nothing installed | OpenCode + Codex + Claude Code | 61–66 s | 15–21 s | follow-up in 4–7 s, no prompt | 100 |
| Claude Code signed in | Claude Code | 46 s | 2 s | — | 100 |
| Claude Code signed in, 3 sessions | 2 + 1 sessions | 46 s | 2 s | — | 100 |
| Codex signed in | Codex | 45 s | 3 s | — | 100 |
| both signed in | Claude Code + Codex | 46 s | 3 s | — | 100 |
| both signed in, 5 sessions, 1 running | 2 + 2 sessions | 46 s | 2 s | follow-up at once, no prompt | 100 |
| OpenCode only | OpenCode | 55–56 s | 20 s | — | 100 |
| real Codex, not signed in, **before** | Codex's sign-in alone (sends you to a browser) | none | — | — | ~25 |
| real Codex, not signed in, after | OpenCode + Codex | 53–61 s | 16–27 s | follow-up in 7 s | 100 |
| real Claude Code and Codex, not signed in | OpenCode + Codex + Claude Code | 55–74 s | 16–38 s | — | 100 |

Changes (PR #1077):

- **Agents nobody signed in to:** OpenCode leads with the starter task; their agents sit beside it on
  their sign-in. Before, the only pane was Codex's sign-in, which opens a browser: no first result
  without an account.
- **The first workspace is built behind the tour:** OpenCode has started and its task is typed when
  the tour hands over (it took ~12 s after the tour before). The new user's first result went from
  66 s to 61 s. The run fixes its tabs only when the first pane opens, because the desk is still being
  read behind the tour (the first attempt pinned the tab at the start and gave up on an existing
  user's sessions).

Existing users, checked by upgrading: a Mac that installed and used the released desktop 1.2.59 (CLI
0.3.67), then got this build: no tour, no first workspace, no agent downloads; its harness came back
and answered a follow-up. The new desktop accepts any CLI from 0.2.48, so updating the desktop before
the CLI asks for nothing. The released 1.2.59 still shows a new user "OpenCode is unavailable. Choose
an agent." and Apple's developer-tools dialog; both are fixed on main.

## Faster opening and the developer-tools dialog (2026-10-09)

**Harness opens before Codex and Claude Code finish downloading** (PR #1090, the owner's idea after
1.2.60). The tour now waits only for setup and OpenCode. The Codex and Claude Code panes open at once
and show the CLI's install line and bar while the one background npm finishes, then their own
screens:
- Each download names its process in `~/.harness/run/downloading-<engine>`, and a pane waits for that
  process rather than starting a second npm into the same `~/.local`.
- OpenCode's first run (`--version`) happens during setup: 3.9 s cold, 0.4 s after.

| Persona (fresh macOS VM) | Harness open | First result | Second session |
|---|---|---|---|
| nothing installed (two runs) | 40–41 s (was 47–59) | 54–59 s (was 64–70) | 20 s, 83 s (free-model variance) |
| Claude Code signed in | 41 s | 46 s | 2 s |
| both, 5 sessions, 1 running | 40 s | 46 s | 3 s |
| real Codex, not signed in | 41 s | 59 s | 20 s |
| real Claude Code and Codex, not signed in | 41 s | 66 s | 21 s |
| OpenCode only | 40 s | 54 s | 16 s |

The review of #1090 found three ways to install twice, all fixed before merge:
- A Ctrl-C during the wait fell through to the pane's own npm.
- On Linux, bash 5 replaces the download's shell with npm, so its pid lost the name the pane checks.
- A create skipped its own wait before the marker existed.

**Apple's developer-tools dialog.** On a Mac without the command line developer tools, the "Install
Command Line Developer Tools" dialog came up during the first session. Cause, traced on the VM:
- `/usr/bin/git`, `python3`, `make`, `cc` and 74 more are one stub that opens the dialog.
- Agents run them unasked: OpenCode ran `python3` for the starter task, and a real Claude Code and
  Codex pair brought it up in one run of three.

Agent panes on such a Mac now get `DEVELOPER_DIR=/Library/Developer/CommandLineTools`, where the tools
install. Measured on a fresh VM without them:
- every stub (`git`, `python3`, `make`, `xcrun`, `xcodebuild`) fails at once with "xcrun: error:
  missing DEVELOPER_DIR path", and no dialog;
- the variable survives the login shells agents run commands in, and covers absolute `/usr/bin` calls;
- once the tools are installed, the same folder works, in panes already open too.

A first version put 78 stand-ins on PATH instead. Its review found two failures, both confirmed:
- `path_helper` in a login shell put `/usr/bin` back in front of them;
- about 40% of panes opening together came up without them.

Official desktop 1.2.62 with CLI 0.3.73 on fresh VMs (faster opening released; no dialog in any run):

| Persona | Workspace | First result | Second session |
|---|---|---|---|
| nothing installed | 41 s | 57 s | 20 s; next day, a follow-up in 25 s |
| real Claude Code and Codex, not signed in | 40 s | 56 s | 139 s |
| OpenCode only | 41 s | 54 s | 27 s |

## Returning users, and where it stops paying (2026-10-09)

Main's app and CLI on fresh VMs, with signed-in Claude Code and Codex (the e2e fake engines) and
their recent conversations in the CLIs' own record shapes:

| Persona | Workspace | First result | Second session |
|---|---|---|---|
| Claude Code signed in, no history | 41 s | 46 s | 3 s |
| Claude Code signed in, Codex not | 41 s | 46 s | 2 s |
| both, 5 recent conversations (2 tabs reopened) | 41 s | 46 s (was lost) | 2 s; the next day too |
| Codex, 2 recent conversations | 41 s | 46 s (was lost) | 2 s |

**Before #1119:**
- The daemon held the reopened conversations a moment, then started them. The app heard of the
  start only at its 60 s agent sync.
- For that minute the panes said "Waiting" over running agents. Read only since #1117, they lost
  the first task typed into them.

**#1119:**
- A held harness is read again (3 s, backing off) until the daemon starts it.
- It stays writable.

Also fixed today:
- #1116: ⌘P Enter moves a conversation from a terminal without a dialog.
- #1117: a held pane says "Waiting" and why.
- #1094: no developer-tools dialog in agent panes.

**Where it stops paying.** Every persona now reaches its workspace at 40–41 s. The first result
follows at 46 s with a signed-in agent, or 52–57 s on OpenCode's free model, where the model's own
answer is the rest. No UI step remains between opening the app and typing.

What is left is first-run setup itself: the CLI, Node and tmux downloaded before the workspace
opens. The one lever named for it (finding 23) is shipping Node and the CLI inside the app, about
11 s, at the cost of a larger universal app and signing an embedded Node. That is a packaging
decision, not an onboarding iteration.

**The whole matrix on final main** (167001ed2, app and CLI built from it), each persona on a fresh Mac
without developer tools. Every one finished two sessions, and no dialog appeared:

| Persona | Opens on | Workspace | First result | Second session |
|---|---|---|---|---|
| nothing installed | OpenCode + Codex + Claude Code | 40 s | 52 s | 48 s; next day 7 s |
| OpenCode only | OpenCode | 40 s | 56 s | 18 s |
| real Codex, not signed in | OpenCode + Codex | 40 s | 81 s* | 163 s* |
| real Claude Code, not signed in | OpenCode + Claude Code | 40 s | 124 s* | 90 s* |
| real Claude Code and Codex, not signed in | all three | 41 s | 55 s | 17 s |
| Claude Code signed in | Claude Code | 41 s | 46 s | 2 s |
| Codex signed in | Codex | 40 s | 46 s | 3 s |
| both signed in | Claude Code + Codex | 41 s | 46 s | 2 s |
| both, 5 recent conversations | 2 tabs reopened | 41 s | 46 s | 2 s; next day at once |
| Codex, 2 recent conversations | 1 tab reopened | 40 s | 46 s | 3 s |
| Claude Code signed in, real Codex not | Claude Code + Codex | 40 s | 46 s | 3 s |

\* OpenCode's free model itself: its footer read "Muse Spark 1.3 Free · 1m 17s" and "2m 38s" in
those runs, against 8–15 s an hour earlier. The flow around it was immediate.

**Would another free model help the slow runs?** No. OpenCode's ten free models were each run three
times on the starter task (`opencode run -m <model>`, a fresh folder and home each, side by side,
2026-10-09):
- **The default, `muse-spark-1.3-contributor-free`:** 13.3, 11.7 and 7.1 s, the page made each time.
  This is the model that took 77 s and 158 s in the matrix an hour earlier.
- **`space-bunny-free`** (9–11 s) and **`big-pickle`** (8–12 s): as fast, not faster.
- **The rest:** slower, or failed to make the page (`ling-*`, `fledge-alpha-free`,
  `nemotron-3.5-lightning-free`).

The slow runs were the default model under load at that moment. Pinning another model would risk
a first session failing when OpenCode changes its free list, for no steady gain.

**Where a new user's first 30 s go** (final main, fresh VM, from the app's and CLI's logs, 2026-10-09):

| After opening | Step |
|---|---|
| +4 s | app launched |
| +7 s | tmux in place (managed runtime) |
| +7 → +20 s | Harness's Node runtime and the CLI downloaded and installed: the longest step |
| +15 s / +18 s | OpenCode downloaded (10.4 s, in parallel) / its first run done |
| +22 → +25 s | `harness start`: the daemon is ready |
| +27 → +30 s | the first workspace planned (1.9 s) and its three panes opened (4.5 s) |

OpenCode is off the critical path, so finishing it in its pane as Codex and Claude Code do would
gain nothing. The one large step is the Node runtime and the CLI. Shipping them in the app would
save about 13 s, against the documented choice that `install.sh` alone installs them
(desktop/CLAUDE.md). That is the owner's decision. Everything else left is 1–4 s.

**Rig note:** the VM has no developer tools, so it raises Apple's dialog for anything that runs
`git`. Returning users of Claude Code or Codex have them, so a dialog seen there is the rig's, not
theirs.

## Next

- #1061 merged. #1047, #1052, #1067 and #1069 are carried by the onboarding PR (branch
  `first-run-onboarding`); release desktop and CLI after it.
- Background install (#1054) is parked as a draft after five reviews found cross-process lock races;
  it saves ~10–25 s on the first harness. Options in the PR: the desktop holds a create until that
  agent's install finished (no pane lock), npm-prefix plus per-agent locks, or drop it.
- Still open: closing the window quits the app (product decision); first-run telemetry for signed-out
  users; bundling Node and the CLI in the app (~11 s once #1047 ships, finding 23).

## Fixes

PR #1047 (branch `user-activation`):

| Fix |
|-----|
| The first New Harness box starts the default agent instead of "OpenCode is unavailable". |
| OpenCode falls back to `npm install -g opencode-ai` when its GitHub download does not finish. |
| The box opens on the Claude Code or Codex the person already uses (installed, signed in, most recent). |
| The agent picker says Installed / Needs sign-in / Installs on start. |
| An agent that exits soon after it started keeps its pane and its error (`successor`). |
| Harnesses are named after their first task (composer, existing folders). |
| A folder with no `.git` above it is not a Git project, without running Apple's git stub (desktop and daemon). |
| No Local Network prompt on reopen without a paired robot. |
| Desktop first run no longer downloads grid. |
| Setup copy no longer promises a sign-in. |
| Review of #1047: successor only for a failed start; truer sign-in and last use; handover respects Close/Change; non-installable default still unavailable; symlinked folders; debounced folder check. |

Follow-up branch `user-activation-2`:

| Fix |
|-----|
| Type the first task during setup; Return starts it once the computer is ready. |
| Change agent after a failed start carries the first task to the new agent. |
| Web pages and PDFs an agent names open with a click, relative names from its project folder. |

Background install, PR #1054 (branch `user-activation-install`, parked draft):

| Fix |
|-----|
| Agents the person does not have install in the background at first launch (`harness agents install-missing --background`); a pane that needs one waits for it. |

PR #1061 (branch `user-activation-move`):

| Fix |
|-----|
| Opened from inside the disk image: offer to move Harness to Applications, reopen it there and eject the image. |
