# Round dial: the thread you started is on the face (Diego, 2026-11-03)

## What Diego asked

Talking to the PM (or the Buddy) is threaded: a task said on the dial is answered in a thread rooted at the words said,
so the app opens that thread while the dial stays on the PM's main chat and never shows the answer. The dial should go
into that thread, and look unmistakably different while it is in one.

Choices Diego made (mockup `devices/harness-device/mockup/round-thread/index.html`, option A):

- After words said on the dial are posted, the dial's face goes into the thread rooted at that message. The app opens the
  same thread beside the chat.
- When the app opens a thread (a click there), the dial follows it, as it follows the app's chat today.
- A **horizontal swipe** in a thread leaves it, back to the main chat of the same Lead (it does not change project);
  the app closes the thread too. The next horizontal swipe changes project, as today.
- The app moving to another chat or thread moves the dial with it (the newest move wins, as the focus rule does today).
- The thread face: teal ring, "↳ Thread" (or "↳ Thread · Buddy") under the project's name, the thread's title on up to
  two lines, **no pet and no bottom arc**, the recap card with a teal spine and a small "PM · N replies" line, and "‹ chat"
  at the left edge. With no agent reply yet the card says "Waiting for the PM…" ("Waiting for your Buddy…").
- The PM face keeps no chat label (the project's name is enough); the Buddy face keeps "Your Buddy".

## Builds on

PR #2718 (round dial: recap answers at once, app order, threads): Desktop announces `threadRoot` while a thread pane is
on screen; the cards service carries it in its focus; a face whose conversation has that thread reads its recap from the
thread and posts words there (`replyTo: root`). This work adds the dial's own thread (started by its words), shows it on
the dial, and lets the dial leave it.

## Behaviour

### Where the face's thread comes from (cards service)

Each Swarm's face has at most one thread, kept per Swarm like the side a swarmBuddy dial keeps (`sides`):

1. **The app's thread** — the window's focus names `threadRoot` in the conversation on the face (#2718).
2. **The dial's thread** — set when words said on the dial are posted at top level (no thread on the face yet): its
   root is the posted message's id (`result.messageId` of the `message.send`), its title the words said.

The newest wins: the app's focus changing (another conversation, another thread, a thread closed) clears the dial's
thread, as a desktop move clears the dial's side today; the dial starting a thread sets it and asks the window to open it
(so the focus then names the same root). A thread lives only while its conversation is the one on the face.

The dial leaves with `supertab.thread.leave {tab, lead}`: the dial's thread is cleared and the window is asked to close
its thread pane (so the focus stops naming it).

### What the dial is told

- The face chat (`SwarmChat`) carries `thread: { root, title, replies? }` while the face is in a thread. `title` is the
  dial's words for its own thread, else the root message's text; its first line, at most 80 bytes. `replies` is the
  thread's reply count when the read that answers the recap gives it.
- A recap read from a thread names it (`LeadRecap.thread = root`), so the dial never takes a thread's recap for its main
  chat or the other way round.
- Only a dial that announces the capability `swarmThread` is sent `thread` fields and may send `supertab.thread.leave`.
  An older dial keeps #2718's behaviour (it follows the app's thread with no mark).

### What the dial does (round dial firmware)

- A Lead whose face chat has `thread` draws the thread face described above (teal `#2dd4bf`). The title wraps on words to
  two lines of about 22 characters, ending "…" when longer. The recap card shows up to three lines.
- The recap for a thread face is accepted only when its `thread` matches the face's root (and its chat id the face's
  chat), so a face that leaves its thread asks for the main chat's recap again.
- A horizontal swipe on a thread face sends `supertab.thread.leave` and shows the main chat at once (the thread drawn off
  locally, the recap asked again); it does not change project. Vertical swipes are unchanged (up: Buddy side, which
  leaves the PM's thread; down: inbox on the PM side, PM side from the Buddy side).
- The bell pill for unread notices still shows on a thread face; the bottom arc text does not.

### Desktop

`dial_super_tab` takes `threadRoot`: a string opens that thread beside the project's chat it opens; `null` closes the open
thread pane. Absent, today's behaviour.

## Design

- **Growth:** none stored. The dial's thread is in memory per Swarm in the cards service, cleared with the device, the
  account, a lost Swarm, or a focus move.
- **Concurrency:** one service, one map; the device's leave and the window's focus are ordered by arrival (newest wins).
- **Read cost:** no new reads for a dial-started thread (title from the words). An app-opened thread's title comes from the
  thread read the recap already makes (#2718), read again only when the root changes.
- **Scale:** one thread per Swarm face; the cards frame grows by at most ~120 bytes on one Lead, inside `fitFrame`'s cap
  (`threadTitle` is trimmed like `chatName`).
- **Compatibility:** gated by the dial's `swarmThread` capability; an old dial or daemon ignores the new fields; an old
  Desktop ignores `threadRoot` in `dial_super_tab` (the dial still shows its thread; the app just does not open it).
- **Migration + rollback:** none; nothing persisted.
- **Audience:** a thread is only ever in a conversation already on this reader's face; the backend checks the reply as for
  typing.
- **Identity:** the signed-in person's own reads and posts, as the dial's voice today.
- **Failure:** a post whose answer has no `messageId` starts no thread (the face stays on the main chat, as today). A leave
  the window cannot apply leaves its pane open; the dial is off the thread either way until the app moves again.
- **Platforms:** round dial (harness-device) firmware, the daemon (cli), Desktop on every OS. Harness Pro: not in scope.
