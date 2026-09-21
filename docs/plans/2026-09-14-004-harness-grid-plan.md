# The harness grid: one sign-in, one private grid, models from your own machines

Status: proposed · 2026-09-14
Supersedes: `2026-09-11-003-model-mesh-plan.md` (which assumed grid was being deleted — it is not)

## Context

The flow, in five steps:

1. Signing in to harness also signs in to grid. One sign-in, and the app can then call grid functions.
2. On sign-in, a private grid named **harness** is created if it does not exist.
3. A harness node can start a local model and serve it to the harness grid.
4. A node can point an agent at the harness grid's models, alongside its subscription models
   (opus for Claude Code, aster for Codex).
5. Signing out of harness signs out of grid.

### The grid CLI already does all of it

This is the finding that shapes the plan. Every capability the flow needs already exists as a
`grid` subcommand, with `--json` on the ones that matter:

| Need | Command | Output |
|---|---|---|
| Sign in with a harness token | `grid login --harness` | token read from **stdin** |
| Does the grid exist? | `grid ls --json` | `[{grid, type, id}]` |
| Create it | `grid start <name> --type permissioned-public` | creates on first run |
| Who may use/serve it | `grid members add <grid> <email> --role both` | |
| What models can it run now | `grid models --json <grid>` | `[{model, engine, node, responses}]` |
| Endpoint + key | `grid info --env <grid>` | `OPENAI_BASE_URL`, `OPENAI_API_KEY` |
| What can this box pull | `grid catalog --json` / `grid device-info --json` | |
| Download a model | `grid pull <model>` | |
| Serve it | `grid join --serve <model> <grid>` | built-in engine |
| Adopt an existing engine | `grid join --all` or `--kind ollama\|vllm` | |
| What is serving | `grid engines --json <grid>` | |
| Stop serving | `grid leave` | |
| Sign out | `grid logout` | stops serve children first |

**Step 3 is not the build we assumed.** `grid join --serve` starts grid's own built-in engine, and
its flags are llama.cpp's — `--ctx-size`, `--n-predict`, `--flash-attn`, `--mmproj`, `--parallel`.
Grid already owns downloading, running and serving a local model. The harness does not need to
install llama.cpp, supervise it, or learn its flags.

### What the harness already has

- `gridHandoff.ts` — `handOffToGrid(token)`: spawns `grid login --harness`, token on **stdin**
  (never argv, never env), classifies the result by exit code.
- `gridLogout.ts` — `passThroughToGridLogout(args)`: spawns `grid logout`, inherits all three
  streams, adopts its exit code.
- `gridLaunch.ts` — turns a base URL + key + model into a real launch for seven engines, each
  through that vendor's own documented contract, and refuses the rest by name.
- `gridAssignment.ts` — reads back which endpoint a live pane is actually on, off the process.
- `gridCommand.spec.ts` — the test convention: a **fake `grid` first on PATH** that records argv and
  stdin, built in a temp dir.

So four of five steps are wiring, not invention. The two mechanisms for steps 1 and 5 exist and are
simply bolted to the wrong commands.

### Two facts to fix before anything is testable

**The installed `grid` is too old.** It reports `0.3.34`, and its `grid login --help` offers only
`--no-browser` and `--json`. `--harness` exists in `autonomous-grid/cli/parser.py:561` but not in
this build, so `harness grid login` fails today with `GRID_CLI_OUTDATED` — exactly as designed
(argparse exits 2 before any handler runs). Update `grid` before testing.

**There is no grid named `harness`.** The account currently holds `BBB` (domain-restricted),
`autonomous.ai` (private-domain, active) and `private autonomous` (permissioned-public).

## Design principles

**1. The harness orchestrates the grid CLI. It never speaks inference.**
No model protocol, no serving, no dialect translation, no relay of its own. Every capability arrives
as a `grid` subprocess with `--json`. This is the seam that already exists for login and logout;
this plan adds calls to it, not a second kind of integration.

**2. The app names a model. The daemon resolves the endpoint and the key — locally.**
The old `payload.grid` contract had the client mint a key and send `baseUrl` + `apiKey` over the
relay. Do not rebuild that. The app sends `{model: "DeepSeek-V4-Flash-0731"}`; the daemon on that
machine runs `grid info --env` and fills in the rest. **No grid credential ever crosses the relay**,
and there is one source of truth for an endpoint the client could not know anyway.

**3. Grid trouble must never break harness sign-in.**
A missing, old, or failing `grid` is a warning on stderr and a harness login that still succeeds.
`harness grid login` stays as the explicit path, where the same failure is a real failure.

**4. Read the truth; do not bookkeep it.**
Which grid, which models, which engines — asked at the moment it is needed, cached only in daemon
memory and dropped on sign-in/out. `gridAssignment.ts` already applies this to a running pane.

## Architecture

```
harness login
   │
   ├─ SSO (unchanged) ─────────────▶ ~/.harness/auth/session.json
   │
   ├─ handOffToGrid(token) ────────▶ grid login --harness   (token on stdin)
   │
   └─ ensureHarnessGrid() ─────────▶ grid ls --json
                                      └─ absent? grid start harness --type …

desktop                      daemon (node B)                    grid CLI
   │  models_list               │                                  │
   ├───────────────────────────▶│  engine's own models ────────────┤ (runtimeProfile)
   │                            │  + grid models ──────────────────▶ grid models --json
   │◀── one merged list ────────┤                                  │
   │                            │                                  │
   │  agent_retarget {model}    │                                  │
   ├───────────────────────────▶│  grid info --env ───────────────▶│  OPENAI_BASE_URL + KEY
   │                            │  gridLaunch.ts → respawn-pane -k -e
   │                            ▼
   │                        codex, now on the harness grid
```

---

## Change 1 — one sign-in (step 1)

`cli/src/cli.ts`, `loginCommand`.

After the harness SSO succeeds, call `handOffToGrid(token)` — the same call `gridLoginCommand`
already makes (`cli.ts:657`).

**Best-effort, per principle 3.** `GRID_CLI_MISSING`, `GRID_CLI_OUTDATED` and `GRID_LOGIN_FAILED`
all print their existing sentence on stderr and leave `harness login` exiting 0. Each of those
messages already names its own way forward; none of them is a reason to fail a harness sign-in.

Under `--json`, the result line gains grid's own answer through the existing `gridSaid()` helper
(`cli.ts:677`), so a client driving `harness login --json` reads one contract.

`harness grid login` stays exactly as it is: the explicit path, where a hand-off failure **is** the
command's failure, and the repair route when the best-effort attempt was skipped.

---

## Change 2 — the harness grid exists (step 2)

New: `cli/src/lib/gridEnsure.ts`.

```
grid ls --json                     → [{grid, type, id}]
  └─ no entry named "harness"?
       grid start harness --type permissioned-public
```

Runs immediately after a successful hand-off in Change 1, and nowhere else — creating a grid is not
something a daemon should do on a timer.

**Same best-effort rule.** A failure here is a warning, never a failed login.

**Both open questions are now answered from the grid source** (`autonomous-grid` @ `0c6930c`).

**Use `permissioned-public` — the default — and it is the private one.** The name misleads: "public"
means *not keyed to an email domain*, not *open to anyone*. ADR 0034 is explicit, and carries a
correction measured on 2026-08-23 that settles it:

> On any other network type — `permissioned-public` is what the front end creates — **the roster is
> an allowlist with no domain constraint** […] grid-apis `store.member_for_access` checks an
> allowlist row **before anything else, on every network type**.

So a `permissioned-public` grid admits exactly the accounts on its roster. `create_network` writes
every creator an allowlist row (ADR 0039 D-h), so **the owner is a member the moment it is created**.

⚠️ **`permissioned-providers` is the wrong choice, and would be a real mistake.** That is the
*open-consumer* type: `grid_auth._is_open_consumer` and `store._is_denied_consumer` both open by
testing for it, the denylist exists only because strangers can consume there, and `relay._billing_on`
switches on for that type alone — consumers pay and providers earn. Everywhere else "consumers pay
nothing and providers earn nothing" (ADR 0039 D-g/D-h, ADR 0043). For one person's own machines that
is billing and an open door, bought for nothing.

**No `grid members add` is needed for the single-user flow.** Membership is keyed on **email**
(`grid members add [grid] <email>`), not on machine — so every machine that signs in with the
account is already covered by the owner's row. Members are only needed to share the grid.

> ⚠️ Worth reporting upstream: `docs/omagrid-quickstart.md:132` says permissioned-public means
> "anyone signed in can send it requests". Per the ADR above that is wrong, and it is the one
> sentence a reader would use to pick a type.

**`grid start` in remote mode registers and returns — no long-lived process.** `cmd_remote_up`
(`cli/remote_grid.py:183`) is a short control-plane call:

```
credentials.require_session()
  ├─ grid known locally ──▶ control_plane.start_managed_network(…)   idempotent if already running
  │                        get_managed_network_status(…) → print → return 0
  └─ unknown + name given ▶ control_plane.create_managed_network(session, name, type)
                           credentials.add_network(record) → print → return 0
```

The blocking server is **local mode only** — `cli/grid.py:28` `cmd_up`, which calls
`runtime.start_grid(cfg)` and binds a port. Remote mode never goes near it; `cli/dispatch.py` routes
these verbs to `remote_grid` before the local handler is reached.

So **grid creation is safe to call from a login command.** Three behaviours to code against:

- **A name is required.** Remote never auto-creates `home` — bare `grid start` with nothing active
  exits with *"Name a grid to create"*. Always pass `harness`.
- **`--type` applies on create only.** Passed against an existing grid it prints a note and is
  ignored, so it is harmless to send every time.
- ⚠️ **The duplicate-name trap.** `_by_name` reads the **locally stored** registry in
  `credentials.toml` — `grid ls` makes no network call. If that list is stale, the existence check
  misses and `create_managed_network` runs again under the same name. `grid login` fetches the list,
  so a create immediately after the hand-off is safe; anywhere else, run `grid sync` first. The
  handler already warns about this in its own failure path: a grid created server-side that cannot be
  saved locally exits telling the user to re-sync, precisely so "the next `grid start <name>` would
  create a duplicate" does not happen silently.

---

## Change 2b — confirmed: remote, private, and what to name it

**Remote mode is automatic.** `cmd_login` (`autonomous-grid/cli/auth.py:139-141`) sets it: *"Signing
in is what 'I want the hosted grids' looks like, so the mode follows the credentials."* A failed or
denied sign-in leaves the mode alone.

**Local mode is out of scope** — every grid call this plan makes is remote. Pass `--remote` on each
one regardless: it is a one-shot override `resolve_override` strips from any position, and it makes
the harness immune to a user who switched their own machine to local mode for their own reasons.
Nothing here reads, sets, or reasons about the local-mode grid.

**Private is confirmed on both jobs.** `permissioned-public` gates access on an allowlist roster
(ADR 0034, corrected 2026-08-23), and the roster's roles are `consumer | provider | both` — so the
same list governs *using* the grid and *serving* to it. `create_network` writes the creator an
allowlist row, and membership is keyed on **email**, so every machine signed in as the owner can
both serve and consume, and nobody else can do either.

⚠️ **Do not call `grid use`.** Login deliberately does not auto-select a grid (`auth.py:142`), and
the user's active grid is their own setting — on this machine it is currently `autonomous.ai`.
Hijacking it would silently re-point every bare `grid` command they run by hand. **Pass the grid
name explicitly** to `grid models`, `grid info` and `grid join` instead; every one of them takes it
as a positional.

### Naming: the suffix must be recoverable on a second machine

The proposed shape is the email local-part + `-` + a unique string, e.g. `anhthuychaucfc-7f3a91`.
The format is fine — `gridProviderId` slugifies to `[a-z0-9-]` anyway — but **a random suffix has a
trap**, and it is the whole reason this needs deciding before implementation.

`_by_name` matches a **locally stored** record by name or id. Machine A creates the grid and knows
its name. Machine B signs in, fetches the account's grids, and then has to answer *which of these is
the harness grid* — and with a random suffix it cannot. It finds nothing, and
`create_managed_network` runs again: **a second grid, same purpose, different name**, with the user's
models stranded on the first.

**Decided: the backend remembers the name.** It already authenticates the token and holds
`{id, email}` (`backend/src/lib/ssoAuth.ts:91`), and already pushes `machine_meta` to every adapter
on connect. The first machine to create the grid reports the name back; the backend stores it on the
user record and hands it to every other machine of that user. A random suffix is then fine, because
nothing ever has to recompute it.

**Grid names are globally unique** (confirmed), so the email prefix earns its place — it keeps one
user's grid from colliding with another's, and the random suffix keeps it from colliding with their
own. Final shape:

```
<email local-part, lowercased, [^a-z0-9]+ → "-">  "-"  <random suffix>
anhthuychaucfc-7f3a91
```

Sanitize the local-part rather than trusting it: `foo+test@…` and `first.last@…` are ordinary
addresses, and `gridProviderId` slugifies to `[a-z0-9-]` downstream anyway — do it once, up front,
so the name that is stored is the name that is sent.

**Global uniqueness means create can lose a race.** Two machines signing in at once both find no
stored name and both call `create_managed_network`. Make the backend the referee: a machine asks the
backend for the name first, and only creates when the backend has none — then reports it back, with
the backend keeping the first write and returning it to the loser, who adopts it instead of creating
a second grid. Treat a control-plane name collision as "someone else won", re-read, and adopt.

Two alternatives, recorded as rejected: a **deterministic hash suffix** needs the same backend change
to learn the account and gives weaker collision behaviour under global uniqueness; **reading grid's
`~/.grid/credentials.toml`** (it holds `[user] email` and `google_sub`) doubles down on the one
fragile seam we have — `gridCredentials.ts` deliberately does nothing but test that file's existence,
and its path layout is already hand-duplicated from grid's `shared/paths.py` behind a drift warning.

---

## Change 2c — Harness carries the grid CLI

The user must not have to install `grid` separately. Feasible, and the two platforms differ.

**Linux is easy.** Grid already ships a self-contained Nuitka onefile binary — *"no Python, uv, or
pip"*. Download and sha256-verify it into `~/.harness/runtime/grid/` using the mechanism that already
exists for the managed Node runtime: `runtimeInstall.ts` + `downloadVerified` (`selfUpdate.ts`),
which is idempotent, falls back silently when a download fails, and already lands artifacts in
`~/.harness/runtime/`.

**macOS is the real work, and Harness is what unblocks it.** Grid ships *no* macOS binary, and
`packaging/README.md` says exactly why:

> The ad-hoc-signed Nuitka onefile is **SIGKILL'd on modern macOS** (verified on macOS 26) —
> distributing a macOS binary requires Apple **Developer ID signing + notarization**, which isn't set
> up yet. […] When notarization lands, add a `macos-*` binary back to the matrix.

**Harness already has that, and it is who signs this** (decided). The same pipeline that signs the
desktop app signs the grid binary: `desktop/scripts/publish-macos-variant.sh` with
`Developer ID Application` under team `54DJVWMJCC`, `--timestamp --options runtime`, plus
`.github/actions/macos-signing` and the existing notarization step. `packaging/build_binary.sh`
already produces a macOS binary locally — only the signing was missing. So Harness publishes a
signed, notarized grid artifact as a **versioned managed runtime**, on harness's release cadence,
pinned in the same manifest the managed Node runtime uses
(`desktop/scripts/publish-managed-node-runtime.sh` is the precedent to copy). This closes a gap that
blocks grid's own macOS distribution too.

**Decided — build `--standalone`, not onefile.** A Nuitka *onefile* unpacks itself to a temp
directory and executes from there, which is exactly what the hardened runtime
(`--options runtime`, required for notarization) exists to stop. A `--standalone` **directory** of
ordinary Mach-O files is the shape macOS signing and notarization are designed around, so it removes
the risk rather than mitigating it. Build standalone on both platforms and the two pipelines stay the
same shape; Linux can equally keep grid's published onefile, since nothing there objects to it.

⚠️ **It belongs to the CLI, not the app.** A server running `harness start` with no desktop at all
still needs `grid` — the daemon is what shells out to it. Ship it as a managed runtime under
`~/.harness/runtime/`, resolved by `gridExec` ahead of `PATH`, never as a resource inside
`Harness.app`. **The pinned runtime wins, not `PATH`** (decided). Pinning is what makes the version floor a
property we test rather than a surprise we discover, and letting an arbitrary `grid` on `PATH`
take precedence would give that away. Resolution order: `HARNESS_GRID_BIN` (an explicit developer
override) → the pinned managed runtime → `PATH` (only as a fallback when no runtime could be
installed).

⚠️ **The pinned binary and the user's own `grid` share `~/.grid`.** `GRID_HOME` is one state
directory — credentials, device id, the network registry — so two binaries of different versions read
and write the same files. That is fine while they are close, and it makes a grid state-format change
a **coordination point** rather than a grid-side detail: the pin has to move before or with it. Track
grid's releases rather than pinning and forgetting.

### Review 2026-09-17 — this section against the code

A read-only audit of Change 2c against harness, autonomous-grid and grid-src, plus one experiment on a
Mac (macOS 26.6 arm64, Nuitka 4.2.1, grid 0.3.46 source). Two findings were fixed in the same pass;
the rest are for the implementation.

**What holds, what does not**

| Claim | Status | Evidence |
|---|---|---|
| Linux ships a self-contained Nuitka onefile (x86_64 + arm64), no Python/uv/pip | Holds | grid `packaging/README.md:12-13`, `release.yml:55-56`; assets `grid-linux-{x86_64,arm64}` + `SHA256SUMS`, ~35–38 MB at v0.3.47. Unchanged since 2026-09-04. |
| `runtimeInstall.ts` + `downloadVerified` reusable as-is | Partly | `downloadVerified` (`selfUpdate.ts:93-102`) is fetch + sha256 of ONE buffer; tar + `archiveRoot` live in `ensureManagedRuntime` (`runtimeInstall.ts:85-100`). A single-file executable needs a write path of its own. ⚠️ It installs only when ABSENT (`runtimeInstall.ts:65-66`, no version compare) and runs only on `harness start --repair` (`cli.ts:298,856`); `selfUpdate.ts` never passes `repair`. A pin bump would not reach an installed machine. |
| README: "ad-hoc onefile is SIGKILL'd on macOS 26; needs Developer ID + notarization" | Verbatim — but the diagnosis is wrong | `packaging/README.md:15-19`. See the experiment: the QUARANTINE xattr kills an ad-hoc binary, onefile or not. |
| Harness signs with Developer ID + `--options runtime` and notarizes | Holds for the app only | `publish-macos-variant.sh:43,127-128`, `upload-desktop.sh:226-236`, `.github/actions/macos-signing`. No non-app artifact is Developer-ID-signed or notarized today: managed Node is nodejs.org's (`publish-managed-node-runtime.sh:26,43`); managed tmux is built on `macos-15` and **ad-hoc** signed (`build-managed-tmux.sh:152`), never notarized — and ships. |
| `build_binary.sh` already builds macOS locally | Holds | `--standalone --onefile --deployment` (`:76-78`); no sign identity, no entitlements file; `--product-version="0.1.0"` stale. A standalone-not-onefile build needs a knob upstream. |
| Every spawn resolves through `gridBinaryPath()` | Did not — fixed | `gridHandoff.ts` and `gridLogout.ts` looked `grid` up on PATH themselves: sign-in on one binary, models on another. |
| `~/.grid` shared; harness locates it as grid does | Holds | `gridCredentials.ts:23-27,41-45` ↔ grid `shared/paths.py:22`; lockstep test on grid's side. `gridExec.ts` spawns with the daemon's env, so `GRID_HOME` reaches the child. |

**Experiment — is notarization what fixes the SIGKILL?** `packaging/build_binary.sh`'s flags, with and
without `--onefile`, built and run on this Mac:

| Build | Size | Signature | Run, no xattr | Run with `com.apple.quarantine` |
|---|---|---|---|---|
| `--standalone` tree | 79 MB, 59 Mach-O | ad-hoc on every file (Nuitka does it); `codesign --verify --deep --strict` OK | `--version`, `--help`, `device-info --json` all exit 0 | SIGKILL (137) |
| `--standalone --onefile` | 19 MB | ad-hoc | all exit 0 | SIGKILL (137) |

The kill is Gatekeeper on a **quarantined** ad-hoc binary — not a property of onefile. What the
harness fetches itself (`fetch` in `runtimeInstall.ts`, `curl` in `install.sh`) carries no quarantine
xattr, which is exactly why the ad-hoc managed tmux runs on every Mac today. **Decided (2026-09-17):**
ship the managed grid ad-hoc-signed, like tmux, and build no notarization pipeline for it; that
becomes necessary only if the artifact is ever offered as a browser download. `--standalone` vs onefile is
then a size/startup choice, not a signing one — the tree is still the shape to keep if a hardened
runtime is ever adopted, since onefile self-extracts into `{CACHE_DIR}`.

**Missed — for the implementation**, ranked

- ⚠️ **C1 — the PANE, not the daemon, is where `grid` runs for local models.** Change 3 shipped as a
  skill (`docs/skills/harness-compute.md:142,154,175,234`) that has the agent type `grid device-info`,
  `grid pull`, `grid join --serve` in its tmux pane. A runtime under `~/.harness/runtime` is invisible
  to that shell: "the pinned runtime wins over PATH" only covers daemon spawns. And the dialog
  (`run_local_model_dialog.dart:40-93`) checks `gridName != null`, never that a binary exists — a user
  with no `grid` gets an agent that dies at the skill's step 2. On a Mac `~/.local/bin/grid` is a
  symlink `uv tool` owns (grid's own installer), so a harness symlink there would fight uv. Options:
  (A) never touch `~/.local/bin`; the daemon prepends the managed runtime's dir to PATH of every pane
  it launches — where `gridLaunch.ts` already sets the grid env — and sets `GRID_NO_UPDATE_CHECK=1`
  there, which closes C2 as well; (B) symlink `~/.local/bin/grid` only when nothing is there, as tmux
  does — an existing uv link, and its version, stays in charge; (C) both. **Decided (2026-09-17): A** —
  the managed grid is a harness-internal runtime, like Node: visible to the daemon and to the panes
  it launches, and to nothing else. The user's own terminal keeps whichever `grid` they installed.
  **Done** — `gridPanePrelude()` in `engineLaunch.ts`, after the shell's startup files, beside the
  managed-Node prelude; pinned by a test whose startup file resets PATH to a decoy `grid`.
- ⚠️ **C2 — `grid update` overwrites the pin in place.** The stale-version notice is suppressed only
  for `--json`, a non-TTY stderr, or `GRID_NO_UPDATE_CHECK` (grid `cli/update.py:208-225`). Daemon
  spawns are piped and safe; the pane's stderr IS a TTY, so the agent sees "Run `grid update`"
  (`update.py:296-300`), and `_update_binary` resolves `argv[0]` → `which grid` → `os.replace` over
  the managed file (`update.py:382-394,439`). Set `GRID_NO_UPDATE_CHECK=1` in every spawn and pane,
  forbid `grid update` in the skill, and lay the runtime down 0555 so `os.replace` fails loudly.
  **Done** for the first two (`gridChildEnv()` in `gridExec.ts`, the pane prelude, a ground rule in
  the skill); the 0555 lands with the installer.
- **H1 — pin propagation.** A version-aware ensure (compare the `current-grid` dir name with the
  manifest pin) on daemon start and on the post-update restart — not only in `install.sh` and
  `--repair`. Add a test that the manifest pin ≥ `GRID_VERSION_FLOOR` (`gridExec.ts:36`).
  **Done** — `ensureManagedGrid()` (`runtimeInstall.ts`, the Node installer generalised into
  `ensureManagedArchive()`): follows the pin, refuses a manifest below the floor, keeps one version
  back for the panes still on it; fire-and-forget at the top of `runForeground`, awaited under
  `--repair`. The publisher refuses a pin below the floor too.
- **H2 — hardened runtime × native extensions**, only if `--options runtime` is ever adopted:
  `pydantic-core` (a Rust `.so`) is in the runtime dep graph (grid `uv.lock:2255-2270`), so library
  validation needs every Mach-O signed with one Team ID (per file, not `--deep`) or
  `com.apple.security.cs.disable-library-validation`. Serving does NOT need mlx (train-only):
  `grid join --serve` execs `llama-server` from `~/.grid/engines` (`shared/engine/launcher.py:144-150`)
  and re-execs itself for `__server` via resolved argv0 (`local/runtime.py:560-579`), so a managed
  binary run by absolute path serves.
- **H3 — darwin-x64 has no builder.** Node and tmux are published for darwin-x64; Nuitka cannot
  cross-compile and `macos-15` is arm64. An Intel runner, or decide "arm64 only; x64 falls back to PATH".
  **Done, conditionally** — `release-grid-runtime.yml` puts darwin-x64 on `macos-15-intel`; the
  `platforms` input drops it if that label is unavailable, and a platform absent from the manifest
  is a sentence at install time, never an error.
- **H4 — the suite read the developer's real managed runtime.** `vitest.setup.ts` isolated only
  `ADAPTER_DATA_DIR`; with the pin outranking PATH, a real `current-grid` would have hijacked every
  fake-`grid` spec. Fixed in this pass.
- **H5 — the two PATH bypasses** (sign-in, sign-out). Fixed in this pass.
- **M2 — manifest shape.** `install.sh` slices a manifest by its FIRST platform key
  (`publish-managed-tmux-runtime.sh:5-6`): grid gets its own `harness/runtime/grid/metadata.json`, not
  a `grid` key inside Node's. Publishing is a manual `workflow_dispatch`; name who bumps.
  **Done** — `desktop/scripts/publish-managed-grid-runtime.sh` (tmux's, for grid, all four platforms
  or the `GRID_PLATFORMS` subset), `make upload-grid-runtime`, `release-grid-runtime.yml` whose
  `grid_version` input IS the pin. Whoever runs the workflow bumps it — RELEASE.md, "Managed grid runtime".
- **M3 — grid source in harness CI.** Nothing exists. Cleanest: a `release-grid-runtime.yml` cloned
  from `release-tmux-runtime.yml` that checks out `autonomous-ai/autonomous-grid@v<pin>` and runs
  `packaging/build_binary.sh` (after an upstream `--onefile` opt-out). Linux can simply download the
  published onefile and verify it against `SHA256SUMS`.
  **Done** — `cli/scripts/build-managed-grid.sh`: Linux wraps the release binary, verified against
  the release's `SHA256SUMS` and re-hosted under our manifest; macOS clones the tag and runs
  `packaging/build_binary.sh` unchanged — onefile, so no upstream opt-out (see the shape row). The
  repo is public: no token for the checkout.
- **M4 — `install.sh` placement.** `--host` stops after step 1 and `--desktop` skips it
  (`install.sh:11-12,45-53`): grid lands in the step-2/3 region. Cold start was not timed above;
  measure it against `gridExec`'s 30 s timeout (`gridExec.ts:43`).
  **Done** — step 3b, after the CLI and before PATH, in every mode but `--host`; optional (a failed
  download prints one line and the install goes on; the daemon retries on start); no symlink.
- **M5 — no desktop surface for a missing CLI.** Only `grid.webSearch` reaches the frame
  (`registry.ts:118`, `models.dart:120`); `GRID_CLI_MISSING` reaches nothing. A
  `gridCli: managed | path | missing` field beside the model list lets the picker and the local-model
  dialog say so. **Done** — `gridCliPresence()` rides the `grid_models_list` answer (not
  `machine_meta`, which is the backend's frame); both surfaces say "Harness Compute isn't installed
  on this machine." — the feature's name, never the binary's, and the machine's gap before the
  account's.
- Low: Windows is no gap (both Darwin/Linux only). The `current-grid` containment check is satisfied by
  `~/.harness/runtime/grid-<ver>-<key>/grid`; a `~/.local/bin` link is for PATH only, never the
  pointer. Pin against the release tag (0.3.47), not the checkout (0.3.46).

**Done in this pass** (on `feat/harness-grid`)

- `gridHandoff.ts` and `gridLogout.ts` resolve through `gridBinaryPath()`; `GRID_BINARY` moved to
  `gridExec.ts`. Specs: `gridHandoff.spec.ts`, `gridLogout.spec.ts`, one integration case in
  `gridCommand.spec.ts`.
- `vitest.setup.ts` isolates `ADAPTER_RUNTIME_DIR`; `config/envIsolation.spec.ts` pins it;
  `gridCommand.spec.ts` strips `HARNESS_GRID_BIN` from the inherited env.
- cli: tsc clean; 2514 passed. The two failures in `install.spec.ts` (`brew install tmux` vs the
  script's `--force-bottle`) fail identically on HEAD — pre-existing, not from this pass.
- C1 + C2: `gridPanePrelude()` puts the resolved grid first on the pane's PATH and turns grid's
  update check off there; `gridChildEnv()` does the latter for every daemon spawn; the skill forbids
  `grid update`. Specs: `engineLaunch.spec.ts` (incl. a decoy-on-PATH run through a fake startup
  file), `gridExec.spec.ts`.
- M5: `gridCli` on the `grid_models_list` answer (`gridCliPresence()`), parsed into `GridModels`;
  the Local model dialog and the picker's empty sentence say when it is `missing`. Specs on both ends.
- The managed grid itself, end to end (the shape assumed onefile — see the decision table):
  `ensureManagedGrid()` + `ADAPTER_GRID_RUNTIME_METADATA_URL` (daemon, H1); `install_managed_grid()`
  step 3b (installer, M4); `build-managed-grid.sh` + `publish-managed-grid-runtime.sh` +
  `release-grid-runtime.yml` + `make upload-grid-runtime` (M2, M3, H3); RELEASE.md. Specs:
  `runtimeInstall.spec.ts` (7 grid cases), `install.spec.ts` (4), `buildManagedGrid.spec.ts` (3,
  the Linux wrap through a fake release). The Linux wrap was also run against the real v0.3.47
  release, and the macOS build from its tag, on this Mac.
- Found on the way, outside 2c but on its release path: **the Harness Compute skill never shipped.**
  `build-bundle.mjs` copied `docs/skills/*.md` to `dist/skills/`, but nothing publishes that directory —
  `upload-cli.sh` ships `cli.js` + `notify.mjs` only, `install.sh` and the self-updater fetch only
  those, and so does `install-cli.sh`. A daemon installed from the CDN logged "failed to read Harness
  Compute skill sources" and installed no skill and no `harness-compute` agent, silently; only a
  working tree with a hand-copied `skills/` beside its cli.js looked fine. Unreleased (not in
  `v0.2.48_cli`), so never live. Fixed by embedding both docs into `cli.js` at build time
  (`__HARNESS_SKILLS__`, an esbuild `define` like `__DSH_REGISTRY__`): they now travel wherever
  `cli.js` does and cannot lag the code that installs them. `harnessComputeSkill.spec.ts` pins both
  the embedded branch and the two build scripts.

---

## Change 3 — a node serves a local model (step 3)

Deferred, but the shape is now known and much smaller than assumed.

```
grid device-info --json     can this box serve, and with what
grid catalog --json         what it can pull
grid pull <model>           download        (long, needs progress)
grid join --serve <model> <grid>            start grid's built-in engine and join
grid engines --json <grid>  what is serving now
grid leave                  stop
```

Two things the harness owns and nothing else:

- **Progress.** `grid pull` is a long download; the desktop needs to show it. That is the only part
  of step 3 with real UI work.
- **Not supervising the child.** `grid join --serve` leaves a serve child that **grid itself** owns
  and that `grid logout` tears down before deleting any credential. The harness must not daemonize,
  restart, or reap it — doing so would fight the sign-out path that already exists.

`grid join --all` / `--kind ollama` also adopts an engine the machine already runs, which is the
cheaper first version: serve what is there before downloading anything.

---

## Change 4 — one model list, both sources (step 4)

`cli/src/backendSocket.ts` (`models_list`, `agent_retarget`), `cli/src/cli.ts`
(`runtimeModelsProvider`, `cli.ts:1945`), `cli/src/lib/gridLaunch.ts`, and new desktop UI.

**The list.** `models_list` today returns `runtimeProfiles.modelsForSession(session)` — the engine's
own models, read from its own config. Add the harness grid's models beside them, tagged by source:

```jsonc
{ "models": [
  { "id": "opus",                   "source": "subscription" },
  { "id": "DeepSeek-V4-Flash-0731", "source": "grid", "node": "scholes-60001" },
  ] }
```

⚠️ **Filter out `auto`.** `grid models --json` lists the grid-router entry as
`{"model": "auto", "engine": "grid-router"}`. It is deliberately **not** offered in the picker for
now: routing is being reimplemented once E2EE lands on the grid path, and shipping it first would
teach a selection we are about to change. Drop any row whose engine is `grid-router` rather than
matching on the name `auto`, so a renamed router does not leak through.

`node` comes straight from `grid models --json` and is worth surfacing: on the harness grid it names
*which of the user's own machines* answers that model.

**The switch is a pane respawn, not a menu change.** Moving an agent between its subscription and the
grid changes the process's environment, so it goes through the existing `agent_retarget` path —
`respawn-pane -k -e` with `--resume`, keeping the pane, its id and its scrollback, and refusing a
pane mid-turn with `AGENT_BUSY`. The picker must say so; a model menu that silently restarts the
engine is a worse surprise than a confirm.

**The frame.** `agent_retarget` carries `{ model: "<id>", source: "grid" }` and nothing else. The
daemon runs `grid info --env`, builds the launch through `gridLaunch.ts`'s existing per-engine
contracts, and spawns. Per principle 2, no endpoint and no key crosses the relay.

⚠️ **The key must stay out of argv and logs.** `gridLaunch.ts` already routes credentials through the
environment (and codex's `env_key` indirection) for exactly this reason, and `registry.ts:105-111`
holds the full launch for relaunch while documenting that it is never logged. Keep both properties;
`grid info --env` output is a secret and must be handled like one.

**Desktop is net-new.** The app-v2 client has no grid code at all — `models.dart` parses no grid
field, and `harness_cli_runner.dart` runs the harness CLI, not `grid`. This change adds the model
section and the retarget call to `desktop/`, which is now in this repo, so it lands in the same
commit as the CLI side and is testable end to end before merge.

---

## Change 5 — one sign-out (step 5)

`cli/src/cli.ts`, `logoutCommand` (`cli.ts:944`) and `resetCommand` (`cli.ts:4635`).

Call `passThroughToGridLogout([])` — which already exists — **before** clearing the harness session,
and keep `warnIfGridSignInRemains()` only as the fallback for when no `grid` could be run at all.

Order matters and is not arbitrary: `grid logout` tears every serve child down **first**, while the
token that makes their deregistration authoritative still exists, and it refuses rather than
deleting credentials when a child cannot be confirmed stopped. Running it before the harness
sign-out preserves that. Its refusal is reported, not fatal — a harness sign-out must still complete.

⚠️ **This reverses a documented decision.** `gridLogout.ts` and `gridCredentials.ts` both state
there is *"no cascade into the harness session, and none out of it."* That comment becomes wrong the
moment this ships. Update it in the same commit, saying what changed and why, or it will be read as
the current rule and dutifully restored.

---

## Change 6 — one grid seam (cross-cutting)

New: `cli/src/lib/gridExec.ts`.

`gridHandoff.ts` and `gridLogout.ts` each spawn `grid` their own way, which was fine for two calls.
This plan adds roughly eight more. Extract one helper before writing the second one:

- `binaryOnPath` pre-check, so a missing `grid` is a sentence rather than a spawn error every caller
  re-recognises (and it catches present-but-not-executable, which `ENOENT` does not).
- Bounded capture on the **capture** only, never the passthrough — `gridHandoff.ts:52` already has
  the shape.
- One exit-code classification: `0` ok, `2` outdated, else failed.
- Typed `--json` parsing, so no caller hand-rolls `JSON.parse` on child output.

**A version floor.** Several commands here need a `grid` newer than the `0.3.34` on this machine.
Read `grid version` once per daemon start, compare, and say which command needs what — a single
clear "update grid" beats eight different argparse errors.

## Failure modes

| Condition | Where | What happens |
|---|---|---|
| No `grid` on PATH | `gridExec` pre-check | login succeeds; stderr says to install grid |
| `grid` too old for `--harness` | exit 2 | login succeeds; stderr says to update grid |
| Grid sign-in fails | exit ≠ 0,2 | login succeeds; grid's own stderr is shown |
| `grid ls` fails | Change 2 | login succeeds; no grid ensured; retry next login |
| Harness grid missing at model-list time | Change 4 | list shows subscription models only |
| `grid info --env` fails | Change 4 | retarget refused before the pane is touched |
| Pane mid-turn | `agent_retarget` | `AGENT_BUSY` — never interrupt a turn |
| `grid logout` refuses (serve child) | Change 5 | reported; harness sign-out still completes |

## Testing

Follow `gridCommand.spec.ts`: a **fake `grid` first on PATH**, in a temp dir, recording argv and
stdin. It already proves the one thing a fake can honestly prove about the hand-off — that the token
went to stdin and never to argv or the environment.

1. `gridEnsure.spec.ts` — grid present → no `start`; absent → `start` with the right name and type;
   `grid ls` failure → warning, no throw.
2. `login` best-effort — fake `grid` in each of missing / not-executable / outdated / failing, and
   `harness login` still exits 0 every time.
3. `logout` cascade — `grid logout` is spawned **before** the session is cleared; a refusing child
   does not block the harness sign-out.
4. Merged `models_list` — subscription and grid models in one list, correctly tagged and sourced.
5. `agent_retarget` — the frame carries only the model id; the key comes from `grid info --env`;
   **assert no key appears in argv or in any log line**.
6. Desktop widget tests for the picker, including the "this restarts the pane" affordance.

## Sequencing

| Phase | Contents | Ships alone? |
|---|---|---|
| 0 | Update `grid` past `0.3.34` (needed for `login --harness`); signed `--standalone` grid artifact published | prerequisite |
| 1 | Change 6 (seam + version floor) + Change 2c (grid as a managed runtime) | yes, invisible |
| 2 | Change 7 (backend mints the name) → Change 1 + 2 (one sign-in, grid ensured) | yes |
| 3 | Change 5 (one sign-out) | yes — pairs with phase 2 |
| 4 | Change 4 (merged picker + retarget), CLI and desktop together | yes — the feature |
| 5 | Change 3 (serving) | yes |

Phases 2–4 are the flow as described. Phase 5 turns the user's own machines into the thing that
answers, which is where it gets interesting.

## Change 7 — the backend mints and remembers the grid name

`backend/prisma/schema.prisma` (User), a new route, and `cli/src/lib/gridEnsure.ts`.

**The backend computes the whole name; the CLI never proposes one.** The `User` row already holds
both inputs — `email` (unique, normalized) and `id` — and the CLI holds neither. Making the backend
the author removes the proposal round trip, the need to ship the email to every machine, and the
race, all at once.

**Schema.** One nullable column:

```prisma
model User {
  …
  gridName String?   // the private harness grid, minted on first ask; never rewritten
}
```

Deliberately **not** `@unique`: on MongoDB a unique index counts nulls as values, so every user
without a grid would collide with every other. Global uniqueness is the grid control plane's rule
to enforce, not ours — ours is only *one name per user*, which the conditional write below gives.

**Route.** `POST /api/grid/name`, no body, under the existing SSO middleware so the user comes from
the token and never from the path:

```
POST /api/grid/name  →  { "gridName": "anhthuychaucfc-7f3a91c4" }
```

Read-if-set, mint-if-not. The referee is a conditional update rather than a transaction:

```ts
const minted = gridNameFor(user)                       // pure, see below
const { count } = await prisma.user.updateMany({
  where: { id: user.id, gridName: null },              // ← only an unclaimed row matches
  data:  { gridName: minted },
})
// count === 1 → we minted it. count === 0 → another machine won; read theirs and return that.
return count === 1 ? minted : (await prisma.user.findUnique(…))!.gridName
```

Two machines signing in at once therefore converge on one name, and the loser adopts rather than
creating a second grid. A `GET` variant is not needed — the POST is idempotent by construction.

**The name.**

```
gridName = sanitize(localPart(email)).slice(0, 32) + "-" + sha256(user.id).hex.slice(0, 8)
```

- `sanitize` lowercases and maps `[^a-z0-9]+` → `-`, trimming leading/trailing dashes — the same
  reduction `gridProviderId` applies downstream, done once here so what is stored is what is sent.
  `first.last@`, `foo+test@` and a local-part of pure punctuation are all ordinary inputs; the last
  falls back to `user`.
- **8 hex, derived from `user.id`, not random.** Collisions only matter between users who share an
  email local-part — `admin@`, `info@`, `dev@` are the realistic cases. At 8 hex (4.3 × 10⁹), a
  thousand users sharing one local-part collide with probability ≈ 0.01%; at 6 hex it is ≈ 3%, which
  is too high for exactly the prefixes most likely to be shared. Deriving rather than randomising
  also makes the value reproducible when someone has to support it.
- The **stored string is authoritative**. The formula runs once, at mint; changing it later never
  renames an existing grid.

**Delivery.** Push `gridName` on the existing `machine_meta` frame the backend already sends every
adapter on connect (`adapterWs.ts`), so a machine that never calls the route still learns it.

**CLI order matters — claim before create.** Claiming is backend-only and cheap; creating is not.

```
POST /api/grid/name        → the name (minted or adopted)
grid --remote sync         → pull the account's grids, so a name another machine created is visible
grid --remote ls --json    → present? nothing to do
grid --remote start <name> --type permissioned-public
```

The `sync` is what stops the loser of a race from calling `create_managed_network` for a grid that
already exists — without it `_by_name` reads a stale local registry, and **the control plane rejects
a duplicate name outright** (confirmed). That rejection makes duplicates impossible by construction,
which is the property this flow wants.

⚠️ **Detect it by observation, not by parsing the error.** Under `--json`, grid emits a refusal
envelope on **stderr** — `{"error": {"code": …, "message": …}}` (`cli/json_error.py`) — but `code` is
documented as `None` for a local refusal and for any relay sending a plain-string detail, so a
control-plane duplicate is likely to arrive as a sentence carrying a status, not a code. Matching on
that text is exactly the thing that module exists to stop people doing. So on **any** create failure:

```
grid --remote sync
grid --remote ls --json        → name present?  the race was lost, and we are done
                               → still absent?  report grid's own message verbatim
```

The same "read the truth rather than trusting a report" rule the rest of this plan follows, and it
stays correct however the rejection is encoded.

---

## Open questions

None. Every decision this plan waited on is recorded above:

| Question | Decided |
|---|---|
| Grid type for "only my machines" | `permissioned-public` — its roster is an allowlist |
| `grid start` in remote mode | Registers and returns; safe inside a login command |
| Who mints and remembers the name | The backend, from `email` + `id` (Change 7) |
| Name shape | `<local-part>-<8 hex of sha256(user.id)>` |
| Name uniqueness | Global; the control plane **rejects** a duplicate |
| Who signs the grid binary | Harness's own release pipeline (Change 2c) |
| Binary shape | ~~Nuitka `--standalone`, never onefile~~ **Revised 2026-09-17, proposed: onefile** — the tree's reason (a hardened runtime) went with notarization; onefile is grid's own build, Linux reuses grid's published binaries, and every platform shares one archive shape. The implementation assumes it; the choice only changes what `build-managed-grid.sh` puts in `bin/` |
| Grid version | **Pinned** in the harness manifest; no self-update underneath it |
| `auto` / grid-router model | Excluded from the picker until the grid path is E2EE |
| Local mode | Out of scope; every call passes `--remote` |
| macOS signing of the managed grid | **Decided (2026-09-17)**: ad-hoc, like managed tmux — what the harness fetches is never quarantined, and quarantine is what kills an ad-hoc binary. Notarize only if it is ever a browser download |
| Where the agent PANE finds `grid` (C1) | **Done (2026-09-17): A** — the pane's launch script prepends the resolved grid's dir to PATH after the shell's startup files (`gridPanePrelude`); `~/.local/bin/grid` stays grid's / uv's |
| `grid update` under the pin (C2) | **Done (2026-09-17)**: `GRID_NO_UPDATE_CHECK=1` on every spawn and pane; the skill forbids `grid update`. Runtime laid down 0555 — with the installer |
| How the desktop learns the machine has no `grid` (M5) | **Done (2026-09-17)**: `gridCli: managed \| path \| missing` beside the model list; "Harness Compute isn't installed on this machine." in the dialog and the picker |
| How a pin bump reaches installed machines (H1) | **Done (2026-09-17)**: `ensureManagedGrid()` on every daemon start and the post-update restart, awaited under `--repair`; one version kept back for running panes |
| Where the managed grid comes from | **Done (2026-09-17)**: `release-grid-runtime.yml` → `harness/runtime/grid/metadata.json`; Linux wraps grid's release binaries (verified against `SHA256SUMS`), macOS builds from the tag with grid's own script, ad-hoc, on `macos-15` / `macos-15-intel` |
| Which binary signs in and out | **Done (2026-09-17)** — `gridHandoff.ts` and `gridLogout.ts` resolve through `gridBinaryPath()` |
