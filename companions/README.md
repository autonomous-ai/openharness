# Optional Companions and Memory

This private package holds two subsystems extracted from the core Harness CLI.
It currently builds as libraries. It does not start itself, install hooks, open a
conversation, or connect the experimental desktop viewer. The core CLI can build
and run without installing this package.

| Directory | Owns |
| --- | --- |
| `src/companion` | Characters, collection state, growth, artwork, presentation and companion interaction. |
| `src/memory` | Coding observations, evidence, durable knowledge, review, recall, native inference adapters and the earlier shared-lesson store. |
| `src/application` | Explicit composition between the selected companion model and Memory; conversation review and lesson publication. |
| `src/shared` | Policy and bounded inference contracts used by both subsystems. |

Memory does not import Companions or the application layer. Companions may import
only Memory's public contract in `src/memory/api.ts`. The application layer joins
them. Import-boundary tests enforce that direction. Build checks reject imports
of core startup, configuration, authentication and running services. Some pure
helpers and types still come from CLI source at build time; the built artifacts
contain those helpers and do not import the installed CLI.

The package exports `@openharness/companions/companion`, `/memory` and
`/application`. Memory storage and artwork rendering run in their own bounded
workers when explicitly invoked. Core no longer embeds those workers, constructs
the feature services, adds recall to native hooks, or keeps a companion terminal
alive for learning.

## Build and test

Use the repository's pinned Node 22 runtime. From this directory:

```sh
npm ci --prefix ../cli --ignore-scripts
npm ci --ignore-scripts
npm run typecheck
npm run build
npm run test:bundle
npm test -- --maxWorkers=3
```

The CLI dependencies support typechecking the retained shared source helpers.
The package lock uses the same toolchain versions as the CLI. The bundle test
copies the built artifacts into a disposable folder with no core service or
source tree. It checks disabled-state inactivity, synthetic memory persistence,
recall scope and worker failure handling. It makes no model calls.

The retained `scripts/memory-*` evaluation and native probe scripts document the
previous integration. Several still expect its retired core endpoints or CLI
commands. They are not certification for this package's future integration and
are not run by its build or default test command.

## Remaining integration

Before enabling the companion experience again, the application layer needs:

- Startup and shutdown outside the core process, with explicit opt-in and stop.
- Verified user, project, session and selected-model inputs through supported
  client APIs, including revocation when consent or identity changes.
- Native recall delivery owned by the add-on, without changing core hook output
  or accepting unverified caller identities.
- Desktop, CLI/MCP and device clients connected to the optional application.
  Device presentation must respect ordinary status, notifications and questions.
- A real sourced-memory check across conversations, including companion switching
  without losing the collection conversation or the user's knowledge.

Core rejects the old optional requests as unsupported, preserving their existing
local-only and encryption restrictions. Browser pairing via `harness pair <code>`
remains a core command; the former companion `harness pair <verb>` commands are
disconnected. Brightness and ordinary device settings remain core transport.

The extraction retains storage formats and development-data paths. It does not
copy, delete or rewrite saved memories, consent, collection state or conversations.
An application host must supply verified scope before opening those stores; the
libraries do not constitute that authorization boundary by themselves.

See the [extraction plan](../docs/plans/2026-10-03-memory-companion-isolation.md)
for the complete acceptance criteria. A passing package suite does not mean the
companion-memory MVP is working in the app.
