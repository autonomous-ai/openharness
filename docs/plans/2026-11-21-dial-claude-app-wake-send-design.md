# Voice to a resting Claude app session opens it, then sends

Branch: `feat/dial-claude-app-wake-send`. Component: `cli/` (the devices process only). Platforms: macOS, Windows and
Linux, wherever the Claude app's `claude://code/continue` link opens (below). No firmware, Desktop or core change.

## Intent

Diego (2026-11-21), eval scenario C8: a voice prompt to a Claude app session that has no process "tự mở session đó rồi
gửi": opens that session in the Claude app, then sends the words to it.

Success: speaking to (or sending a voice draft to) a resting Claude app row on the dial opens exactly that session in
the app, and the words reach exactly that session once its process runs. If it does not come up in a bounded time, the
dial says so and a log line says why. **No prompt ever reaches another session** (the eval's hard gate).

## What is there today (read on this branch, 2026-11-21)

- `claudeAppSource.ts` lists every Code session of the Claude app's store as an idle row with `resting: true`, the id
  `observedAgentId('claude', cliSessionId)`, the pane key `claude-app:<local id>`. Its `capabilities()` says
  `voice: false` and it has no `send`.
- The dial's firmware (both dials) keeps voice off for an agent whose caps lack `v`; the cable session also refuses a
  voice start for it before any audio is kept (`cableSession.ts`, "Talking to it from the device comes in an update.").
- A tap on the row runs `devices.ts` `focus`: `noteMove()`, `noteLink(agentId)`, then
  `opener.open(agentId, { bundle: APP_BUNDLES.claude, pane: claudePane(localId) })`, which runs the Claude adapter's
  link (`claudeApp.ts`, `appLink.ts`): macOS `open -b <bundle> <url>`, Windows `windowsRaise.link`, Linux `xdg-open`
  once `xdg-mime` names an app for `claude://`. The app opens the session and starts its Claude Code process.
- That process's hooks make an observed copy (`observed.ts`) with the same agent id; the registry shows it in the
  store row's place (`registry.ts`). Its voice goes to the harness-device mod's long poll (`inbox.ts`), keyed by the
  Claude Code session id: `observed.send` → `inbox.deliver(sessionId, text)`. `inbox.ready(sessionId)` is true once
  that session's mod polls.
- The dial waits 65 s for a voice reply after the recording ends (`ui_habitat.c` `voice_wait_until`, `pro_voice.c`
  `REPLY_WAIT_MS`), showing its sending state (the working character) meanwhile; a `voice.error` shows its message.
- The ChatGPT app's resting threads (`codexAppSource.ts`) have the same drop: `voice: false`, no `send`.

## Design

### 1. The row takes voice where its link opens

`ClaudeAppSource.capabilities(agent)` (it now takes the agent) says `voice: true` when the row's session can be opened
by its link on this computer: `deps.canLink(localId)`, a new `canLink(pane)` of `appLink.ts` (its `canOpen(id, false)`):
true on macOS and Windows; on Linux only once `xdg-mime` has answered that `claude://` has an app (the first look starts
that read and answers no). `canFocus` is not used: on Linux it answers yes before the read, for a tap's sake. Nothing
else in its caps changes.

So the firmware and the cable session let the person talk to it, as to any agent with voice. No firmware change.

### 2. `ClaudeAppSource.send` hands the words to a wake

`send(agent, text)` finds its row and calls `deps.wake({ localId, sessionId, agentId, name }, text)`, with the row's
values **at the moment the words arrive**. A row no longer listed answers `<name> did not answer.` and opens nothing.
`ClaudeAppSource.stop()` calls `wake.stop()`.

### 3. The wake: `cli/src/cable/hosts/appWake.ts`

A small class in the devices process, built in `devices.ts` before `claudeAppSource` and handed to it as `wake`:

```ts
interface AppWakeDeps {
  /** The tap's link, without its fallback: noteMove(), noteLink(agentId), then the Claude adapter's own
   *  focus(claudePane(localId)) (appLink.ts), which answers false when the link definitely failed. */
  open(localId: string, agentId: string): Promise<boolean>
  observed: Pick<ObservedSource, 'list' | 'onChange' | 'send'>
  /** Inbox.onPoll: called synchronously as a session's poll opens, with its Claude Code session id; its stop. */
  onPoll(listener: (sessionId: string) => void): () => void
  after(ms: number, run: () => void): () => void
  monotonic(): number
  log(line: string): void
  count(what: string): void
}
class AppWake {
  send(target: { localId: string; sessionId: string; agentId: string; name: string }, text: string): Promise<SendResult>
  stop(): void
}
```

The link is run without the opener's fallback (`open.ts`, which brings the app forward and answers true when the link
fails): a fallback brings the app on whatever session it shows, and would turn a failed link into a 30 s wait. The
Claude adapter's link has no `forward`, so its `focus` answers false on a link that failed. Two opens of one link do no
harm (`appLink.ts`), so a tap running at the same moment does not refuse the wake.

0. **Too long:** words over `MAX_TEXT` (`orca.ts`, the limit `observed.ts` uses) are refused before anything opens, with the observed
   source's own text, `Too long. Say it shorter.` (log `[claude-app] wake · too long`, count `wake-too-long`).
1. **One wake at a time**, for the whole devices process. Words that come while one is opening, for the same row or
   another, are refused at once: `Still opening <name of the one opening>. Try again in a moment.`
2. **Open, then wait.** It records `opened = monotonic()`, runs `open`, and fails at once on false. Then it waits,
   **pushed, never polled**, on `observed.onChange` and `onPoll`, checking at each event. A timer bounds the wait at
   **30 s** (fits in the dial's 65 s with transcription).
3. **Ready** means both, whichever event comes last:
   - **the bound copy** is in `observed.list()`, not `ended`: the observed copy whose id is `target.agentId`, so engine
     `claude` and Claude Code session id `target.sessionId`. Its `app` is not checked: on Linux and Windows it is
     learned later from the process's parents, and the id alone fixes the session;
   - **a poll of that session id opened after `opened`** (heard by `onPoll`). `Inbox.ready()` is not used: it stays
     true for 35 s after the session's last run's last poll.
4. **Deliver** through the normal path: `observed.send(boundCopy, text)`, which goes to the mod by the Claude Code
   session id. When the poll is the last event, it is called inside the `onPoll` listener: `observed.send` runs with no
   await until `inbox.deliver`, so these words take that first poll. Its answer is the wake's answer.
5. **Ended:** the bound copy was live during this wake, then is listed `ended` or leaves the list, before ready: the
   app quit or closed it mid-open. A copy already ended when the wake started (the session's last run, kept until the
   observed source drops it) is not "live during this wake".

**Nothing else is read to choose the session:** not the dial's current row, not the app's front session, not the app's
last attach. The mod's inbox is keyed by that session id, so the words can only reach the process that runs that
session. A process the app starts for another session, or for this app session under another Claude Code id, is never
bound.

**Words after the first.** Once the bound copy is live, the registry shows it in the store row's place
(`registry.ts`), so the dial's later words go to the observed copy's own path, not the wake: before its mod's first
poll that copy has no voice and the dial says what it says today for such an agent (`This agent is in Claude. Talking
to it from the device comes in an update.`); after it, they are delivered behind the first (the inbox holds one at a
time and answers `<name> has not taken your last words yet.` for one more). Both paths reach the same session, the
first words first.

**Failure** answers `{ ok: false, reason }`, which the dial shows as its voice error (and the draft screen as its
error). Each says one fixed line in the log and counts one fixed word with the devices' `count` (voiced) measure; no
id, name, folder or text:

| Case | Dial | Log | Count |
|---|---|---|---|
| the link failed | `<name> did not open in Claude.` | `[claude-app] wake · open failed` | `wake-open-failed` |
| 30 s with no ready (also a link that opened nothing) | `<name> did not open in Claude. Try again.` | `[claude-app] wake · timeout` | `wake-timeout` |
| the bound copy ended before ready (the app quit mid-open) | `<name> closed before it took your words.` | `[claude-app] wake · ended` | `wake-ended` |
| another wake is running | `Still opening <name>. Try again in a moment.` | `[claude-app] wake · busy` | `wake-busy` |
| the source stopped (the dial detached) | `<name> did not answer.` | `[claude-app] wake · stopped` | `wake-stopped` |
| delivered (`observed.send` ok) | (the usual transcript) | `[claude-app] wake · sent · <ms> ms` | `wake-sent` |
| `observed.send` refused | its own reason | `[claude-app] wake · refused` | `wake-refused` |

A voice draft refused by the wake cannot be sent again from the same draft: `voiceDraft.ts` keeps its receipt after any
refusal, for every agent, today. That is not changed here.

### 4. The dial meanwhile

The dial keeps its own sending state (the working character, `Sending...` on the draft screen) until the answer, as for
any send. No new frame, copy or firmware. A failure shows the message above on the dial's voice error view.

### 5. Platforms

| OS | Open path | This feature |
|---|---|---|
| macOS | `open -b com.anthropic.claudefordesktop claude://…` | on |
| Windows | `windowsRaise.link` (`harness-pty open-link`, then a raise) | on |
| Linux | `xdg-open claude://…` once `xdg-mime` names an app | on once that read answered yes; voice stays off otherwise |

The mod and the inbox already run on all three. On Windows the devices run inside the core's process through the inline
door (`services/inline.ts`, a dynamic import): the new file is only in the devices' import graph, as every
`cable/hosts` file is, and the core's static graph does not change (`src/architecture.spec.ts`).

### 6. What does not change

- The core (`cli/src/core/`), the firmware, Desktop, the store reader.
- A live Claude app session's voice (the observed copy's own path).
- A row whose session's process is starting but whose mod has not polled yet: the observed copy holds the row with
  voice off for those moments, as today.
- The ChatGPT app (Out of scope).

## Tests (fakes and throwaway homes only; never the real Claude app or `~/.claude`)

- `appLink.spec.ts`: `canLink` is false on Linux until `xdg-mime` answered with a desktop file, true on macOS and
  Windows.
- `claudeAppSource.spec.ts`: caps say voice exactly when `canLink` says so; `stop()` stops the wake; `send` passes the row's values at that
  moment; a row gone answers `did not answer` and opens nothing.
- `appWake.spec.ts` (fake opener, fake observed source, fake inbox events, fake timer), each asserting **which session
  ids received words** (the fake mod records every delivery):
  - opens once, then delivers to the bound session only once its copy is live and a poll opened after the open, in
    either order of the two events; the words are handed to the first poll (delivered inside the poll's listener);
  - stale state: the session's ended copy from its last run, and a poll from before the open, are not ready;
  - **two quick prompts** to the same row: the second is refused busy, only the first is delivered, once; and through
    the devices' wiring, words after the copy is live go the observed path to the same session, after the first;
  - two prompts to two rows: the second refused busy; nothing to the second's session;
  - **the person switches rows while it opens**: another session's copy comes live and polls (and a third session
    with the same local id but another Claude Code id): nothing reaches them; the target then comes up and gets the words;
  - **the app quits mid-open**: the bound copy appears, then ends → `ended`, nothing delivered anywhere; no copy ever →
    `timeout` at 30 s exactly (fake clock), nothing delivered;
  - the link answers false → `open failed`, no wait, no timer left; a link that answers true and opens nothing →
    `timeout`;
  - stopped mid-wait → `stopped`, listeners and timer released;
  - every log line and count is one of the fixed ones above.
- `inbox.spec.ts`: `onPoll` fires once per opened poll, synchronously, after the poll is held (a `deliver` inside the
  listener is taken by it), with the session id; a listener that throws harms neither the poll nor the next listener.
- `devices.spec.ts`: voice to a resting Claude app row through the devices' real wiring (fake store, fake opener, fake
  hook and mod poll in a throwaway home) runs one continue link and delivers the words to that session; on `linux` with
  no scheme app the row's caps lack `v`; on `win32` the link goes through the Windows raise fake.
- `cableSession.spec.ts`: a voice draft's send to such a row resolves with the wake's refusal text.

`cli/AGENTS.md`'s devices row names the wake beside the Claude app source.

## Decisions (the PM, 2026-11-21)

1. **Bound:** 30 s from the words' arrival to ready.
2. **Strict binding:** only the very Claude Code session id the row names. A session the app reopens under a new Claude
   Code id gets no words; the dial says it did not open.
3. **A second prompt while one opens** is refused, never queued, and the dial shows it plainly: the refusal is a
   `voice.error` whose text (`Still opening <name>. Try again in a moment.`) the dial's voice error view shows (the
   draft screen shows it as its error). Never a silent drop. A test pins the text that reaches the dial.
4. **No firmware change:** the dial's existing sending state while it opens; the failure copy above on its voice error
   view.
5. **ChatGPT app:** its own item (Out of scope).
6. **Too long** words are refused before the link runs (§3 step 0).
7. **Acceptance** is the eval's C8 run (tiers A/B) by `feat/dial-app-eval`: no real Claude app runs on Diego's Mac for
   this branch, and the merge does not wait for it.
8. **Windows end to end** (voice → link → mod on a Windows daemon) is not run: `windowsDaemon.ts` has no stand-in for
   speech-to-text. Covered by the Windows case of `devices.spec.ts` and `windows-e2e` showing the rows with voice; a fake
   speech-to-text for Windows is proposed as its own item in the final report.

## Out of scope

- **The ChatGPT app's resting threads.** They drop voice the same way (`codexAppSource.ts`, `voice: false`, no
  `send`). Proposed as its own item: open the thread (`codex://threads/<id>`) then send as here, or put the words in the
  thread's queue with the app's own `codex queue` with no process (needs a spike: unverified that it runs a thread the
  app has not loaded).
- A voice draft's resend after a refusal (`voiceDraft.ts`, every agent).
- Voice in the moments between a session's process starting and its mod's first poll.
