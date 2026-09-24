# Domain-specific harness contract (spec 1)

Frozen 2026-09-14. Changes go to [CHANGES.md](CHANGES.md), append-only.

A DSH is a git repo, or one folder of one (a registry entry's `path`; see CHANGES.md 2026-09-17).
Harness reads `harness.json` at its root and nothing else about its code.


## `harness.json`

```jsonc
{
  "spec": 1,
  "id": "autonomous/autonomous-circuit", // owner/name; the install dir and the wire id
  "name": "Autonomous Circuit",           // the picker tile
  "description": "Chat with AI → a board you can order",
  "engine": "claude",                     // base engine, one of ENGINES
  "workspace": {
    "template": "template",               // copied into an EMPTY workspace (no marker present)
    "marker": "product.json",             // relative path; present = already materialized
    "init": "toolchain/init-workspace.sh" // optional; run after the template copy, cwd = workspace
  },
  "agent": {
    "instructions": "AGENTS.md",          // copied to <workspace>/AGENTS.md, see below
    "skills": ["skills"],                 // dirs whose SKILL.md-bearing subdirs are linked in
    "env": { "CIRCUIT_TOOLCHAIN": "${dsh}/toolchain" },  // ${dsh} ${workspace} ${home} expand
    "args": []                            // appended to the base engine's argv
  },
  "toolchain": {
    "setup": "toolchain/setup.sh",        // run once at install, cwd = install dir
    "doctor": "toolchain/doctor.sh"       // exit 0 = ready; stdout lines are shown to the user
  },
  "viewer": {                             // optional (tier 2)
    "command": "toolchain/viewer.sh",     // long-running; env HARNESS_VIEWER_PORT, HARNESS_WORKSPACE
    "url": "http://127.0.0.1:${port}/?file=${artifact}",  // ${port} ${artifact} (url-encoded)
    "artifactExtensions": [".step", ".stl"]               // newest such file under the workspace
  },
  "verdict": ".harness/verdict.json"      // relative to the workspace; optional (tier 1+)
}
```

An agent package's `engine` is its default for clients that have not chosen an engine. The
portable runtime binds every spec-1 harness to every integrated process engine. There is no
package allowlist or opt-in flag. Terminal is a plain shell and is offered only with Coding.
Older daemons still read the same manifest and use its default engine. New desktop clients use the
machine's `dsh_list.engines` and fall back to `engine` for older daemons.

Materialization prepares the workspace independently of the engine:

1. If `workspace.marker` is absent: copy `workspace.template/*` without overwriting existing files,
   then run `workspace.init` if declared.
2. Create `<workspace>/.harness/` for verdicts and runtime state.
3. Bind the selected engine to a session-scoped context bundle under `.harness/runtime/`.
   Its instructions and skill index are loaded through the engine adapter. A small, generic
   bootstrap in the engine's project instruction file reads `HARNESS_CONTEXT_FILE`; it contains
   no particular harness's instructions. Existing project text is preserved.

Launch env includes `HARNESS_DSH`, `HARNESS_DSH_DIR`, `HARNESS_WORKSPACE`,
`HARNESS_CONTEXT_FILE`, and `HARNESS_SKILLS_DIR`, plus expanded `agent.env`. Skills are readable
files with shell commands; native skills and MCP are not prerequisites. Old workspace skill paths
in env are translated to the session's skills directory. `agent.args` remains a legacy extension
for the manifest's default engine only; those flags are never handed to another engine.

Create records a runtime key along with the chosen engine and harness. Resume uses that bundle;
fork copies its configuration into a new bundle. Instructions, env and argv remain stable across
package-default changes. Installed skill assets and toolchains follow package updates, as before.
Missing packages or damaged contexts refuse a restart with a specific error.

See [the runtime contract and adapter sources](portability.md) for lifecycle, migration, compatibility,
and the coverage gate.

## Viewer packages (spec 1.1)

A viewer can be a package of its own, pointed at by any number of harnesses:

```jsonc
// harness.json of a viewer package
{ "spec": 1, "kind": "viewer", "id": "autonomous/cad-viewer", "name": "CAD Viewer",
  "toolchain": { "setup": "setup.sh", "doctor": "doctor.sh" },
  "viewer": { "command": "viewer.sh", "url": "http://127.0.0.1:${port}/?file=${artifact}",
              "artifactExtensions": [".step", ".stp", ".glb", ".stl", ".3mf"] } }

// harness.json of an agent that uses it
{ "spec": 1, "id": "autonomous/text-to-cad", "name": "text-to-cad", "engine": "claude",
  "viewer": { "use": "autonomous/cad-viewer" } }
```

A viewer package has no engine, no workspace and no verdict, and is never a tile. `harness dsh
install` of a harness that `use`s a viewer installs the viewer too (by registry id). At launch the
daemon runs the viewer's command in the VIEWER's directory with the usual env plus
`HARNESS_VIEWER=<viewer id>` and `HARNESS_VIEWER_DIR=<its install dir>`; `HARNESS_DSH` and
`HARNESS_DSH_DIR` still name the harness. The harness may narrow `url` and `artifactExtensions`.

## `.harness/verdict.json`

```jsonc
{
  "spec": 1,
  "ready": false,                         // the one machine fact: fab.ready, gates passed, exam passed
  "summary": "3 errors, 2 warnings",      // one line for the pane header
  "findings": [
    { "severity": "error", "kind": "source_trace_not_connected", "message": "…", "ref": "U3.pin7" }
  ],                                      // severity ∈ error | warning | info; kind is open
  "artifact": "boards/main.board.json",   // optional; primary thing to view, workspace-relative
  "phases": [                             // optional; where the work is, in order, for the pane header
    { "id": "build", "name": "Build", "state": "done" },
    { "id": "checks", "name": "Checks", "state": "active" },
    { "id": "fab", "name": "Fab", "state": "pending" }
  ],                                      // state ∈ done | active | pending | failed; ≤ 12 phases
  "updatedAt": "2026-09-14T20:00:00Z"
}
```

The verdict is a feed, not a gate: write it at every phase change and every check, not only at the
end. The pane is the product, and it must move while the agent works — a harness that only writes a
final verdict is not progressive. `phases` is how the header says "you are here"; `ready` stays the
one final truth.

Lifted from Circuit's `.board.json` and TV's `.episode.json` sidecars (same severity gate). Circuit
writes it beside the sidecar in `circuitpy.generation`; Workshop writes it from `verify_project`.

## Wire (daemon ↔ desktop)

- `agent_create` payload gains `dsh?: string`. Refused with `INVALID_DSH` when not installed on
  this machine or when `engine` is not supported by the installed manifest. Saved sessions keep
  their actual `engine` for resume, restart and fork, independently of the manifest's default.
- `AgentFrame` gains `dsh: string | null`, `dshName: string | null`, `viewerUrl: string | null`,
  `verdict: { ready, summary, errors, warnings, artifact, phases, updatedAt } | null`. Null is a real answer
  (see `agentFrame.ts`'s doc on erased fields).
- `dsh_list` → `{ dsh: [{ id, name, description, category, engine, engines, installed, viewer, tier }] }`: installed
  DSHs on this machine merged with the bundled registry (the `store/` folders and `store/registry/`).
  `engines` lists supported engines. Installed metadata wins over catalog metadata; an older
  daemon omitting `engines` supports only its advertised `engine`.
- `dsh_install { id?, url?, ref? }` → runs clone → setup → doctor; pushes
  `dsh_install_status { id, phase: clone|setup|doctor|done|failed, detail? }`; replies `{ ok }` at
  the end (the desktop uses a 10-minute timeout for this one request).
- Discovery reads `HARNESS_DSH` off the live process (`probeDsh`, same cached env read as
  `probeCodexHome`) so a pane the daemon did not create, or re-minted after a restart, is labelled.

### The store's facts

A registry entry may also carry `homepage`, `upstream`, `license`, `screenshots` and `examples` (see
`cli/src/dsh/registry.ts`); a built-in package keeps them in `store.json` beside its manifest. They are
the store page's, not the package's: a manifest never has them,
and `dsh_list` rows forward them from the registry whether or not the package is installed, with
`repo` and `linked` beside them. `dsh_remove { id }` uninstalls from the answering machine.

## On disk

```
~/.harness/dsh/
  installed.json                # [{ id, dir, source, ref, path?, commit, linked, installedAt }]
  autonomous/typst/             # clone (of one folder, for a store package), or a symlink with --link
  autonomous/doc-viewer/
```

CLI: `harness dsh install <id|git-url|path> [--link] [--ref <ref>] [--path <folder>]`, `harness dsh list`,
`harness dsh doctor <id>`, `harness dsh remove <id>`.

## In the monorepo

```
store/
  README.md            what a package is, the tiers, how to build and publish, the shelf's rules
  spec/README.md       this contract, frozen; CHANGES.md is append-only
  spec/schema/         harness.schema.json, verdict.schema.json
  starter/             tier 0: manifest + AGENTS.md + one skill; the CLI's test fixture
  agents/<name>/       built-in harnesses: harness.json + store.json, each its own registry entry
  viewers/<name>/      built-in viewer packages, the same way
  registry/<owner>/    entries for packages in repositories of their own
  tools/               daemon-level checks over the loopback socket
cli/src/dsh/           manifest, install, materialize, viewer, verdict, probe, registry
desktop/lib/dsh/       catalog, web pane, verdict chip
```

Normative schemas: [`schema/harness.schema.json`](schema/harness.schema.json), [`schema/verdict.schema.json`](schema/verdict.schema.json).
