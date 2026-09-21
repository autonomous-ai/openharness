# Autonomous Circuit, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[Autonomous Circuit](https://github.com/autonomous-ai/autonomous-circuit): describe a board in the chat
pane and get a fab-ready PCB, with the project's own live board view in the pane beside the agent.
Runs on Claude Code.

This folder is a **wrapper**. It holds no Circuit code: `toolchain/setup.sh` fetches the project from its
own public repository at the commit `VERSIONS` pins (everything but its product library and examples),
into `upstream/`, and runs the project's own setup there. The manifest points the agent at the project's
own `AGENTS.md`, skills and template; the doctor, workspace init and viewer are the project's own scripts,
run against that copy.

- `harness.json` — name, category, engine, and paths into `upstream/`. `formerly` keeps agents created
  under the ids this harness had before (`autonomous/copper`, `autonomous/circuit`).
- `VERSIONS` — the repository, the pinned commit on its main, and the sparse patterns.
- `toolchain/fetch-upstream.sh` — the read-only, sparse, blob-less fetch; `setup.sh`, `doctor.sh`,
  `init-workspace.sh`, `viewer.sh` hand off to the project's scripts of the same names.
- `toolchain/runtimes.sh` — the store's shared helper (a copy; `store/tools/sync-runtimes.mjs` writes it).
  What the project's scripts expect on PATH comes from it, so a machine with no Node and Apple's
  Python 3.9 installs as well as any: Node >= 22.12 (Harness's own when the machine has none) and a
  CPython 3.12 `.venv` with numpy for the board pipeline.
- `toolchain/python` — that `.venv`'s Python with Node on PATH, handed to the agent as `CIRCUIT_PYTHON`:
  the project's skills start the pipeline with `python3` and re-exec it there when that is too old.

## Credit and stewardship

Autonomous Circuit is its own project, [autonomous-ai/autonomous-circuit](https://github.com/autonomous-ai/autonomous-circuit),
under its repository's licence (MIT). Nothing of it is changed or copied here. Harness treats it like any
other project in the store: bugs in board generation belong in that repository, bugs in the wrapper
belong here, and a newer Circuit is a bump of `UPSTREAM_COMMIT` in `VERSIONS`. If the Circuit team wants
to own the store entry, the wrapper moves into their repository and the registry points there.

```sh
harness dsh check "$PWD"                           # conformance (warns: the project arrives with setup)
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest discover -s toolchain          # the scripts, against a local stand-in repository
```
