import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/** Pi's folder is lossy. Only its complete first entry establishes the session id and cwd. */
import type { SessionFolder, SessionHeader } from '../kit/sessionIdentity.js'

// Pi accepts custom ids. A .jsonl suffix makes --session interpret the value as a file instead.
export const PI_SESSION_ID = /^(?!.*\.jsonl$)[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/
export const PI_HEADER: SessionHeader = {
  bytes: [16 * 1024, 1024 * 1024], type: 'session',
  id: { field: ['id'], pattern: PI_SESSION_ID }, cwd: ['cwd'],
}
/** Bound control checks the same native header and canonical workspace as exact discovery. */
export const PI_CONTROL_IDENTITY = {
  maxBytes: PI_HEADER.bytes.at(-1)!, maxRecords: 1, type: PI_HEADER.type,
  id: PI_HEADER.id.field, idPattern: PI_HEADER.id.pattern, cwd: PI_HEADER.cwd, canonicalWorkspace: true,
} as const satisfies import('../kit/controlIdentity.js').ControlIdentityRule
export const PI_FOLDER: SessionFolder = {
  prefix: '--', suffix: '--', trim: /^[/\\]/, mangle: /[/\\:]/g, replacement: '-',
}

/** Native source runs in the engine process; the daemon only renders and installs these bytes. */
export const PI_EXTENSION = {
  file: hookPath(hookEnvironment.PI_HOME, 'agent', 'extensions', 'launcher-register.ts'),
  template: [
`// session-register — auto-installed by the machine adapter. Binds this Pi session to the local
// machine daemon (127.0.0.1:`,
{ argument: 'port' },
`) so it can be mirrored to web/device. No-op if machine isn't running.
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let announced = false;   // posted at least once (the transcript may not exist yet)
  let registered = false;  // posted with a real, on-disk transcript — nothing left to do

  const register = async (ctx: any) => {
    const pane = process.env.TMUX_PANE;
    let token = "";
    try { token = readFileSync(`,
{ argument: 'credential' },
`, "utf8").trim(); } catch {}
    if (!pane || !token) return;
    // Pi knows the session file path immediately but only WRITES it once the first assistant message
    // lands. Sending a path that isn't on disk yet is rejected by the daemon (it validates the file),
    // so announce without one first and attach the real path on a later turn.
    const file = ctx?.sessionManager?.getSessionFile?.() ?? null;
    const ready = !!file && existsSync(file);
    if (registered || (announced && !ready)) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    try {
      const res = await fetch("http://127.0.0.1:`,
{ argument: 'port' },
`/api/hook/session-start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-hook-token": token },
        body: JSON.stringify({
          engine: "pi",
          pluginVersion: `,
{ argument: 'version' },
`,
          sessionId,
          transcriptPath: ready ? file : undefined,
          cwd: ctx?.cwd ?? undefined,
          tmuxPane: pane,
          callerPid: process.pid,
          runtimeHints: [
            ...(pane ? [{ backend: "tmux", paneId: pane }] : []),
          ],
        }),
      });
      if (!res.ok) return; // daemon refused (e.g. transcript not readable yet) — retry on the next turn
      announced = true;
      if (ready) registered = true;
    } catch {}
  };

  // session_start fires before the transcript exists; the turn hooks catch it once it does.
  pi.on("session_start", async (_event, ctx) => { await register(ctx); });
  pi.on("turn_start", async (_event, ctx) => { await register(ctx); });
  pi.on("turn_end", async (_event, ctx) => { await register(ctx); });
}
`
],
  messages: {
  "current": "[hooks] Pi discovery extension already installed",
  "installed": "[hooks] installed Pi discovery extension → {file}",
  "after": [
    "[hooks] (takes effect on the next pi session start)"
  ],
  "failed": "[hooks] failed to write Pi extension:"
},
} as const satisfies import('../kit/nativePlugin.js').NativePlugin
