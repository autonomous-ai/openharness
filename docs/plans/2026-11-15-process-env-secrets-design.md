# The daemon never reads another process's environment

Date: 2026-11-15. Branch: `fix/process-env-secrets`. Platforms: macOS, Linux, Windows (the CLI daemon and the hook).

## Problem

`cli/src/lib/processEnv.ts` reads the whole environment of every live engine process: `ps eww -p <pid> -o command=` on
macOS, `/proc/<pid>/environ` on Linux. An environment holds secrets: API tokens, `ORCA_PAIRING_CODE`,
`ORCA_AGENT_SESSION_SPAWN_TOKEN`, and the rest.

- The core's process holds them. The cache keeps the whole environment of up to 256 processes for 60 s each, and
  merges reads, so a key outlives the read that found it.
- `lib/gatewayRuntime.ts` extracts the OpenRouter key (`OPENROUTER_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and caches it for the life of the process. Nothing uses it:
  `resolveOpenRouterKey()` is called only without a gateway (`lib/voiceRouter.ts`, `lib/jev/jevClient.ts`).
- No operating system can read one variable of another process. `/proc/<pid>/environ`, `ps e` and
  `KERN_PROCARGS2` all return everything. So "read only what is needed" cannot be done by reading the process: the
  daemon must stop reading it.

Project rule (Diego, 2026-11-14): never read another process's environment, not even to drop it right away.

## Who reads it today, and for what

| Caller | Keys used | What it decides |
|---|---|---|
| `lib/gatewayRuntime.ts` (discovery, `core/agents/restart.ts`, `core/agents/retarget.ts`) | `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` (host is `openrouter.ai`), plus the four key variables above | `gateway: 'ori'`: model and effort become display-only |
| Grid evidence (`lib/terminalAgentDiscovery.ts`, `core/agents/gridAssignments.ts` `refresh`) → models' process | claude `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`; hermes `OPENAI_BASE_URL`, `HERMES_INFERENCE_MODEL`; grok `GROK_MODELS_BASE_URL`; copilot `COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL`; opencode `OPENCODE_CONFIG`; pi `PI_CODING_AGENT_DIR` (launches older than #1318); codex already from argv | The grid the app shows for an agent |
| `engines/discoveries.ts` `probeProfileHome` | `CODEX_HOME` | The Codex home a row validates transcripts against (fill-only) |
| `engines/identities.ts` Hermes probes | `HERMES_HOME`, `HERMES_DATA_DIR_SUFFIX`, `HOME`, `USERPROFILE`, `LOCALAPPDATA`, plus any variable `HERMES_HOME` refers to | The Hermes home, whether Harness worked it out, and a sandboxed Hermes's folder |
| `dsh/probe.ts` | `HARNESS_DSH` | The DSH a row belongs to (fill-only) |
| `lib/gridAssignment.ts` `probeGridAssignment` | as grid | Nothing: only specs call it |

History: `f357609b1c` (ori support, 2026-08-17, key read "so each recap bills the agent's own key"; that caller is
gone), `26cf7c55b1` (grid retarget; the read moved to `processEnv.ts`), `3195e6f694` (the incident: the app's grid pill
flickered to "own login" because a macOS `ps eww` read came back partial; the cache started merging),
`4b2f7836d5` (Codex home), `d4eeec74c2` (Hermes home, openharness#191), `ea33286bcc` (DSH), `d311ef5a43` (#1361,
probe spawns off the keystroke path).

## Decisions

PM, 2026-11-15, on the recommendation; Diego may still answer differently.

1. **No reading at all.** `lib/processEnv.ts` is deleted, and so is its line in `architecture.coreFiles.txt`. No
   caller reads another process's environment by any means.
2. **A hook reads only its own environment.** The Harness hook (`cli/hook/notify.mjs` and the engines' plugins) runs
   inside the engine's process tree and inherits its environment. It may read a fixed list of names from its OWN
   environment and send derived, non-secret facts. It never sends a key's value. This follows the existing
   `HOST_HINTS` pattern.
3. **Sandboxed Hermes:** a Hermes in another mount namespace whose home cannot be told without its environment is
   `'unseen'`, and its session is found store by store (the openharness#191 path).
4. **Unknown until the hook speaks:** an agent Harness did not launch (`ori claude`, a Pi launched before #1318) has
   `undefined` for these facts until its first hook arrives. `undefined` already means "could not look" everywhere, and
   never overwrites what the registry knows.
5. **Rule 7 (cli/AGENTS.md):** only facts about the session and its transcript enter the core through the hook. The
   core grows no new record, rule or field for grid, gateway or DSH.
6. **Code over prompts:** an architecture test fails on any read of another process's environment in `cli/src` and
   `cli/hook`. `cli/AGENTS.md` gets one line naming the rule and the test.
7. **Hook facts travel as headers**, not body fields: an older daemon ignores an unknown header, but refuses a body
   with an unknown field (`validHookBody`, 400). The values are only the gateway flag and absolute paths. The daemon
   never logs a header's value.
8. **Homes from the files a process holds open** (Hermes `state.db`, Codex `sessions/**/rollout-*.jsonl`) when no hook
   reports them. The daemon reads only the PATH of each open descriptor, never a file's content through it, and only
   for the engine processes the discovery pass selected, plus, for a launcher, its one direct child that is the same
   engine's binary (an npm-installed Codex), never further down and never any other process. A spike first confirms
   that each engine keeps that file open.
   If the spike fails for an engine, that engine's case is accepted as lost and listed under "What changes for users".
9. **Unseen, as read:** an unknown Hermes home holds no binding. The default home and its profiles are scanned. Only a
   folder with no path in the daemon's view holds.
10. **`engines/kit/processHome.ts` goes** with its spec, `HERMES_HOME_RULE` and its coreFiles line: only the deleted
    probes used it.
11. **Other readers are a separate item:** `cli/native/darwin-process-images.c` (`KERN_PROCARGS2`) and the test tools
    are listed under Follow-ups.

## Design

Each fact gets its source from what Harness wrote itself, from argv, or from the hook's own environment.

### Gateway (`gateway: 'ori' | null`)

- Codex: argv (`-c model_provider=openrouter`, `model_providers.openrouter.`), as today.
- Claude, OpenCode, Hermes: the hook. Its request carries the header `X-Harness-Hook-Gateway: ori` when the hook's
  own `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `OPENAI_API_BASE` parses as a URL on `openrouter.ai`, and
  `X-Harness-Hook-Gateway: none` otherwise. The URL itself is not sent. Where Hermes has no hook, it does not report.
- Why it may enter the core: `gateway` decides whether the core types `/model` into a pane (`runtimeProfiles.ts`,
  `runtimeProfile.ts`), which is session input. The field already exists in the registry; only its source changes.
- `restart.ts` and `retarget.ts` stop probing. They pass `undefined`, which keeps the stored value. The relaunched
  process's next hook reports again.
- `GatewayRuntime.apiKey`, `KEY_VARS`, the `gateway` parameter of `resolveOpenRouterKey` and their specs are deleted.

### Grid assignment

- The grid an agent Harness launched comes from the launch Harness wrote: the registry's `grid` and `gridLaunch`,
  set at create and at retarget (`create.ts`, `retarget.ts`), as today.
- Engines whose launch names the grid's endpoint in argv keep that evidence: codex (`model_providers.<id>.base_url`
  plus `-m`) and pi (`-e …/grid-provider.ts` plus `--model`). Models' process classifies it through the existing port.
- Engines whose endpoint exists only in the environment (claude, hermes, grok, copilot), and OpenCode
  (`OPENCODE_CONFIG`), are no longer read back from the process. Their grid is the launch record.
- The `env` member of `GridAssignmentProcess` goes, and the port carries argv evidence only.
- Behavior change (rule 7): an agent the person started by hand with a grid's relay URL in their own shell
  (`ANTHROPIC_BASE_URL=…/relay claude`) is no longer shown on that grid. Carrying it through the hook would put a grid
  field into the core for the models component.
- Pi launches older than #1318 (`PI_CODING_AGENT_DIR`): `undefined` until relaunched.
- `probeGridAssignment`, `readPiGridAssignment`'s directory branch, and the `PI_CODING_AGENT_DIR` marker are deleted.

### Codex home (`codexHome`)

- An agent Harness created has the home from `agent_create`, as today.
- Any other agent with a Harness hook: the header `X-Harness-Hook-Codex-Home` carries its own `CODEX_HOME` when set and
  different from its default. The core takes it only when it is an absolute path of at most 1,024 characters with no
  control character, and the session's `transcriptPath` lies under `<codexHome>/sessions`. Fill-only, as today.
- Any other agent without one (a custom `CODEX_HOME` with no Harness hooks in it): the home is
  `<home>` of an open `<home>/sessions/**/rollout-*.jsonl` descriptor of the Codex process (decision 8).
- `probeProfileHome` and `profileHomeFromEnv` are deleted.

### Hermes home

- The hook already reports the home whose store holds the session (`registry.ts` `hermesHome`, filled by the hook gate
  and by `notify.mjs`). That stays the source for a Hermes with a hook.
- A Hermes with no hook (0.21.6 and later on macOS and Linux, #4239), including one with only a `HOME` of its own: the
  home is `<home>` of an open `<home>/state.db` descriptor of the Hermes process (decision 8), mapped to the daemon's
  view through `processMounts.ts` for a sandbox. A home found this way is marked `hermesHomeDerived` only when the
  process is in a sandbox (its path was mapped): a relaunch does not export it, and the relaunched Hermes works its
  home out again. Outside a sandbox the home is the store it really uses, so a relaunch exports it as `HERMES_HOME`, and
  a hand-started `HERMES_HOME=/x hermes` still resumes its session after a restart from Harness (PM, 2026-11-15).
- `probeHermesHome`, `probeHermesHomeDerived` and `namedHome` stop reading the environment. With neither a hook report
  nor a descriptor, the default home and its profiles are scanned store by store (openharness#191, decision 9).
- `probeHermesSandbox` keeps reading the mount namespace (`processMounts.ts`).

### DSH

- Only Harness sets `HARNESS_DSH`, and the registry's `dsh` is written at create and carried by every relaunch.
- `probeDsh` and `dshFromEnv` are deleted, and so is the discovery line that fills `dsh` from the process.
- A row minted by discovery (no launch record) has no DSH.

### Discovery

`lib/terminalAgentDiscovery.ts` drops the environment reads. It keeps the argv grid evidence and the mount-namespace
probe. Every probe it removes leaves the field `undefined`, which the registry already treats as "could not look".

### The architecture test

`cli/src/architecture.spec.ts` (or a sibling spec) scans every file under `cli/src` and `cli/hook`, specs excluded,
and fails on:

- `/environ`, as a path segment in a string;
- a `ps` argument list that asks for environments: a BSD-style word without a dash that contains `e` (`eww`, `axe`)
  or macOS `-E`. Not Linux `-e`, which means every process;
- `KERN_PROCARGS2` or `procargs`.

`cli/scripts/remote-machine.sh` is outside the scan for now (Follow-ups).

## What changes for users

The PR body repeats this section.

- Harness-launched agents: no change to grid, DSH, Codex home or Hermes home.
- `ori claude`, `ori opencode`, `ori hermes`: display-only model as today, from the first hook (claude's
  `SessionStart` fires at start). Before it, the model menu behaves as for a vendor login.
- A hand-started agent on a grid relay URL: shows its own login instead of the grid. Accepted by the PM
  (2026-11-15) to keep rule 7: the core carries no grid field for the models component.
- A Hermes with no hook and a home of its own, and a Codex started by hand under a `CODEX_HOME` with no Harness hooks:
  bound from the store file they hold open. If the spike shows an engine does not keep that file open, that engine's
  case is no longer bound, and this line names it.
- `ori hermes` where Hermes has no hook: no gateway report. No visible change: only Claude Code and Codex use
  `gateway` today.

## Design (docs/feature-design-rules.md)

Reviewed revision: this file. Reviewer: final review. Each line: answered / N/A because …

1. Growth: records only shrink. The env cache (up to 256 environments) and the key cache are deleted. The new hook
   fields write existing registry fields only. [x]
2. Concurrency: N/A. Hook fields go through the existing `session-start` handling; the fill-only rules are unchanged. [x]
3. Read cost: discovery stops spawning one `ps eww` per agent per minute on macOS and stops reading `/proc/*/environ`
   on Linux. A hook request grows by two headers: one percent-encoded path (at most 1,024 characters once decoded) and
   one short flag. Reading the open descriptors' paths (decision 8) costs one listing per selected engine process until
   its file is seen, at doubling waits from 5 s to 60 s, then nothing for that process's life. [x]
4. Scale: fewer spawns; nothing grows with agents. [x]
5. Compatibility: an older hook without the new headers leaves the facts `undefined` (no change). An older daemon
   ignores unknown headers; a spec, or the quoted older code, shows it. The models port drops `env`: core and models
   ship in one daemon. [x]
6. Migration and rollback: no stored shape changes. Rolling back restores the reads. [x]
7. Audience: secrets never enter the daemon. The hook sends a boolean and paths, never a key's value. [x]
8. Identity: N/A, no action changes who it runs as. [x]
9. Failure: a missing hook report is `undefined`, shown as unknown and never overwriting the registry. A hook field
   the core refuses is dropped with the existing `[hooks]` warning shape (name only, no value). [x]
10. Platforms: macOS loses its `ps eww` spawn, Linux its `/proc` read. Windows never read environments; the hook
    fields work the same there. [x]

## Testing

Each behavior gets a failing test first, at its layer:

- gateway from the hook's header (claude, opencode, hermes); an unread header changes nothing on an older daemon; `restart` and `retarget` keep the stored gateway;
- the grid from argv only, `GridAssignmentProcess` without `env`; a hand-set relay URL is no grid;
- `codexHome` from the hook, accepted only under its `sessions` folder;
- Hermes: no environment read, a sandbox with no report is 'unseen';
- DSH from the launch record only;
- the architecture test fails on a planted `/proc/<pid>/environ` and a planted `ps eww`.

## Follow-ups

One item, high priority, right after this pull request merges:

- `cli/native/darwin-process-images.c` reads `KERN_PROCARGS2` (argv and environment) of other processes and hashes
  it. It is product code.
- Test tools: `cli/scripts/remote-machine.sh` (the docker rig) and `os/tests/vm.py` read `/proc/<pid>/environ`;
  `store/tools/dsh-e2e.mjs` runs `ps eww`. Each verifies from the hook's report or the launch record instead, then
  comes under the scan.
