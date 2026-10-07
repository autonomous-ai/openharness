/**
 * Point every test's data AND runtime dirs at throwaway directories BEFORE any module reads `env`.
 *
 * `config/env.ts` resolves `ADAPTER_DATA_DIR` at import time and defaults to the user's real
 * `~/.harness/cli/data`. Specs that import the hook server (and through it the registry) therefore wrote
 * their fixtures into the LIVE registry — a stale `late-session` record turned up there, written by
 * `launcherWs.spec.ts`, which is how this was found. Tests must never touch the user's data.
 *
 * The runtime dir is the same hazard in the other direction. It is only ever READ, but what is read
 * there — `current-grid`, `current-node` — outranks PATH by design (lib/gridExec.ts), so a real pointer
 * under `~/.harness/runtime` would send a spec's calls to this machine's managed binary instead of the
 * fake the spec put on PATH. `src/config/envIsolation.spec.ts` pins both.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// npm test injects its installation prefix. A child zsh login shell can source nvm,
// which prints a prefix-conflict warning into fixture stdout. This made unchanged
// doctor/materialize tests fail locally while pinned CI passed (release 1.2.50).
// Specs that exercise an installation prefix set their own explicit fixture value.
delete process.env.npm_config_prefix
delete process.env.NPM_CONFIG_PREFIX

// Coding sessions can themselves run under harnessd. Its token, topology and supervision flags belong
// to that host, never to a fixture or the Vitest worker. Tests set their own explicit overrides.
for (const name of Object.keys(process.env)) if (name.startsWith('HARNESSD_')) delete process.env[name]

// The home folder itself is a throwaway one, before any module asks for it. Every engine's home, the Harness
// folder and the machine's identity default to a folder in it (config/env.ts: ~/.claude, ~/.codex, ~/.cursor,
// ~/.harness/computer-id, …), and a spec that did not name its own read the developer's. Traced on one Mac,
// 2026-10-06: specs read ~/.claude/settings.json (attachTranscript, runtimeProfile), walked 27 GB of
// ~/.codex/sessions (homes, sessionRepair), read ~/.codex/config.toml (dsh/runtime), ~/.harness/computer-id
// (serviceProcess) and ~/.harness/runtime/current-node (hooks). CI's runner has an empty home, so nothing
// there showed it. A spec that wants a home of its own still sets one.
process.env.HOME = mkdtempSync(join(tmpdir(), 'adapter-test-home-'))
// And no engine's or desktop's folder handed down from the shell that ran the suite (a Codex or Claude Code
// session sets some of these for its own children), which would outrank that home.
for (const name of [
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'GROK_HOME', 'COPILOT_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR',
  'CURSOR_DATA_DIR', 'HERMES_HOME', 'PI_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'COMMANDCODE_HOME',
  'AGY_HOME', 'AGY_CONFIG_DIR', 'OPENCODE_DB', 'KILO_DB', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
]) delete process.env[name]

process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adapter-test-data-'))
process.env.ADAPTER_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'adapter-test-runtime-'))
// Real zsh subprocesses must not load a developer's prompts, plugins, updates,
// or nvm configuration. Shell-startup tests supply their own ZDOTDIR fixture.
process.env.ZDOTDIR = process.env.ADAPTER_DATA_DIR
// Auth is stored outside ADAPTER_DATA_DIR in production. Never let a spec
// discover, refresh, or replace the developer's real Harness account session.
process.env.HARNESS_AUTH_DIR = join(process.env.ADAPTER_DATA_DIR, 'auth')
process.env.DSH_DIR = join(process.env.ADAPTER_DATA_DIR, 'dsh')
// Every daemon of this user records where it listens here (lib/hookRoutes.ts), and the hook reads it: a
// spec must neither write a record beside the person's daemons nor route a test hook by one of theirs.
process.env.HARNESS_HOOK_ROUTES_DIR = join(process.env.ADAPTER_DATA_DIR, 'hook-routes')
// The Store catalog is fetched from GitHub by dsh_list; a test must never depend on what that branch
// holds today (a published catalog turned a fixture registry of two into the live shelf of 23).
// Loopback port 9 refuses at once, so the live catalog falls back to the registry each test stubs.
process.env.HARNESS_STORE_CATALOG_URL ??= 'http://127.0.0.1:9/catalog.json'
