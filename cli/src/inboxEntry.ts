/**
 * inbox.mjs's entry: the Windows follower of a session's inbox, `device claude inbox <session id>`, in a file of its own
 * in a release, beside cli.js (build-bundle.mjs). harness.exe runs it for the follower's line when the version folder
 * holds it (pty/src/command.rs), else cli.js, whose entry takes the same path (entry.ts). One runs per Claude Code
 * session, as long as the session, and Node reads and compiles every byte of the file it starts on: measured from the
 * release bundle on macOS, Node 22.23.5, in its retry wait 8 s after start (2026-11-27), this 99 KB file holds 57 MB
 * resident, against 143 MB from cli.js with entry.ts's branch and 158 MB before it
 * (docs/plans/2026-11-27-windows-follower-ram-design.md). Only the installer and the updaters write it into a version
 * folder, checked against the manifest's sha256; nothing writes it at run time.
 *
 * Any line that is not the follower's follows '', the id followInbox refuses before it reads or dials anything: it
 * prints {"off":true} and exits 0, the answer harness.exe, the updaters' canary and install.ps1 rely on.
 */
import './lib/connectWait.js'
import { inboxSessionOf, processInboxDeps, runInbox } from './deviceClaude/inboxCommand.js'

const session = process.argv[2] === 'device' ? inboxSessionOf(process.argv.slice(3)) : null
process.exitCode = await runInbox(session ?? '', processInboxDeps())
