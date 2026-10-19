import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
import type { SessionHeader } from '../kit/sessionIdentity.js'

/**
 * Prime Agent (Prime Intellect's `prime-agent`) is a fork of Pi: the same `@earendil-works/pi-coding-agent`
 * package with `piConfig {name: 'prime-agent', configDir: '.prime/agent'}`. Inherit Pi's structure, measure
 * the values (engines/README.md). Measured on prime-agent 0.9.5 (darwin-arm64), 2026-10-18:
 *
 * - Sessions are FLAT, `<agentDir>/sessions/<uuidv7>.jsonl`, not Pi's `--<cwd>--` folders, and the header is
 *   on disk when `session_start` fires (Pi writes nothing until the first reply).
 * - The header carries `rlmDepth`. RLM children write `<agentDir>/session-artifacts/<parent>/sub-<id>/*.jsonl`
 *   with `rlmDepth >= 1`.
 */
export const PRIME_SESSION_ID = /^(?!.*\.jsonl$)[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/
export const PRIME_HEADER: SessionHeader = {
  bytes: [16 * 1024, 1024 * 1024], type: 'session',
  id: { field: ['id'], pattern: PRIME_SESSION_ID }, cwd: ['cwd'],
}
/** Bound control checks the same native header and canonical workspace as exact discovery. */
export const PRIME_CONTROL_IDENTITY = {
  maxBytes: PRIME_HEADER.bytes.at(-1)!, maxRecords: 1, type: PRIME_HEADER.type,
  id: PRIME_HEADER.id.field, idPattern: PRIME_HEADER.id.pattern, cwd: PRIME_HEADER.cwd, canonicalWorkspace: true,
} as const satisfies import('../kit/controlIdentity.js').ControlIdentityRule

/** Where Prime Agent keeps a root conversation. Children live elsewhere and are never a pane's session. */
export const primeSessionsDir = (agentDir: string = hookEnvironment.PRIME_AGENT_DIR): string => hookPath(agentDir, 'sessions')

/**
 * The discovery extension. Native source runs in the engine process; the daemon only renders and installs it.
 *
 * Prime Agent does not run the agent in the pane. The pane holds a TUI CLIENT; the session lives in a daemon
 * WORKER, a child of Prime's detached supervisor, and extensions run there. So `process.pid` is the worker,
 * never a descendant of the pane, and `TMUX_PANE` is the one the worker inherited from the client that
 * LAUNCHED it (measured: still `%6` after that client quit and `prime-agent attach` reopened it in `%7`). Two
 * rules follow:
 *
 * - Register on `session_start`. It fires on startup and on `/new`, `/resume` and `/fork`, all of which a
 *   client in the pane just did, and again (same worker pid, new id) when `/new` switches in process. The file
 *   is not there yet at that moment: Prime writes a startup session's header a millisecond later, and a `/new`
 *   session is a `draft` with no file until its first message (measured). So it retries briefly, and a session
 *   this worker saw start registers at its first `agent_start` too. No other turn event registers anything: a
 *   turn can come from a detached worker whose pane now runs something else.
 * - Skip RLM children. They start in the parent's worker with the parent's `TMUX_PANE` (measured) and would
 *   otherwise take over the pane's conversation. The header's `rlmDepth` says which is which.
 *
 * The daemon still verifies every such hook against `prime-agent list --json` (core/engines/primeAttachment.ts):
 * a `-p` run started by an agent's own tool inherits that agent's pane too (measured), and only the list can
 * tell an attached interactive session from it.
 */
export const PRIME_EXTENSION = {
  file: hookPath(hookEnvironment.PRIME_AGENT_DIR, 'extensions', 'harness-register.ts'),
  template: [
`// session-register — auto-installed by the machine adapter. Binds this Prime Agent session to the local
// machine daemon (127.0.0.1:`,
{ argument: 'port' },
`) so it can be mirrored to web/device. No-op if machine isn't running.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The session header (first line). Children carry rlmDepth >= 1; an unreadable header registers nothing. */
function header(file: string): any {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\\n", 1)[0];
    return JSON.parse(line);
  } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}

export default function (pi: ExtensionAPI) {
  const posted = new Set<string>();
  const started = new Set<string>(); // sessions this worker saw start, so a client opened them here

  // When Prime fired the event, kept across retries: the daemon orders a session switch by it
  // (X-Harness-Hook-Fired-At, src/hookServer.ts hookFiredAt) and holds one that has none.
  const firedAt = new Map<string, number>();

  const register = async (ctx: any, attempt: number) => {
    const pane = process.env.TMUX_PANE;
    if (!pane) return;
    let token = "";
    try { token = readFileSync(`,
{ argument: 'credential' },
`, "utf8").trim(); } catch {}
    if (!token) return;
    const file = ctx?.sessionManager?.getSessionFile?.() ?? null;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!file || !sessionId || posted.has(sessionId)) return; // --no-session has no file to follow
    if (!firedAt.has(sessionId)) firedAt.set(sessionId, Date.now());
    const head = header(file);
    // Prime writes the header just AFTER session_start fires (measured: its first entry 1ms later).
    if (!head) { retry(ctx, attempt); return; }
    if (head.type !== "session" || (typeof head.rlmDepth === "number" && head.rlmDepth > 0)) return;
    let ok = false;
    try {
      const res = await fetch("http://127.0.0.1:`,
{ argument: 'port' },
`/api/hook/session-start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-harness-hook-token": token,
          "x-harness-hook-fired-at": String(firedAt.get(sessionId)),
        },
        body: JSON.stringify({
          engine: "prime",
          pluginVersion: `,
{ argument: 'version' },
`,
          sessionId,
          transcriptPath: file,
          cwd: ctx?.cwd ?? head.cwd ?? undefined,
          tmuxPane: pane,
          callerPid: process.pid,
          runtimeHints: [{ backend: "tmux", paneId: pane }],
        }),
      });
      // A 200 that says ignored is a refusal too: at startup the hook can beat the client's attach (measured).
      const reply: any = await res.json().catch(() => ({}));
      ok = res.ok && !reply?.ignored;
    } catch {}
    if (ok) { posted.add(sessionId); return; }
    // The daemon may not have seen the pane's client yet.
    retry(ctx, attempt);
  };

  // Briefly, and never on a later turn: a turn can come from a worker whose pane runs something else now.
  // ctx.setTimeout, not the global: Prime cancels it on unload, and a global timer can kill a worker.
  const retry = (ctx: any, attempt: number) => {
    if (attempt >= 6 || typeof ctx?.setTimeout !== "function") return;
    ctx.setTimeout(() => { void register(ctx, attempt + 1); }, 250 * 2 ** attempt);
  };

  pi.on("session_start", async (_event, ctx) => {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (id) started.add(id);
    await register(ctx, 0);
  });
  // A session from /new is a DRAFT with no file until its first message (measured). Register it then.
  pi.on("agent_start", async (_event, ctx) => {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (id && started.has(id) && !posted.has(id)) await register(ctx, 0);
  });
}
`
],
  messages: {
  "current": "[hooks] Prime Agent discovery extension already installed",
  "installed": "[hooks] installed Prime Agent discovery extension → {file}",
  "after": [
    "[hooks] (takes effect on the next prime-agent session start)"
  ],
  "failed": "[hooks] failed to write Prime Agent extension:"
},
} as const satisfies import('../kit/nativePlugin.js').NativePlugin
