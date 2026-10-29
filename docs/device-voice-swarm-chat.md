# Device voice in the Swarm chat: review before posting

Builds on [the round dial's Swarm chats](superpowers/specs/2026-10-28-round-dial-swarm-chat-design.md) and
[its PM and Buddy screens](superpowers/specs/2026-10-29-round-dial-pm-buddy-spec.md): the face shows the chat the desktop
has open, and words spoken on it go to that chat as the person. Everyone in the Swarm reads that chat, so the dial now
shows the words first (device owner's choice 2a, 2026-10-27).

## Behaviour

- Tap the Swarm face, speak, tap again. The dial shows the words with the project and chat it will post to
  (`openharness · Lead`, `openharness · PM`, a group's title or the Buddy's name), then **Send** or **Discard**.
- Send posts them in that chat as the person, with the same command typing uses and the same access check. Discard posts
  nothing.
- The chat is the one on the face when the person began to speak, even if the desktop moves while they speak or review.
- A refused post (a read-only Chat with PM, someone else's chat) or an unreachable Swarm keeps the draft with the reason.
  Nothing is typed into the Lead's terminal.

## Cable

| Direction | Field | Meaning |
|---|---|---|
| daemon → device | `welcome.features` has `swarm.review` | Words reviewed on a Swarm face are posted in its chat by Send |
| device → daemon | `hello.swarmReview: "v1"` | This dial reviews every word for a Swarm chat |
| device → daemon | `voice.end.review: true` | As for any draft; then `voice.draft` with `name` and `context: "Swarm chat"` |

- A dial asks for review on a Swarm face only from a daemon that lists `swarm.review`. An older daemon would type the
  reviewed draft into the Lead's terminal, so with one the face posts at once, as before, and a hold does not offer review.
- Words begun on a Swarm face keep the face's Lead as their recipient: a pane focused in the window never takes them.
- Send passes `reviewed` with the chat: `SwarmCards.say` posts there while it is still the Lead conversation or an open chat
  of that Lead's project this reader may see, even if the face moved since. Unreviewed words keep today's rule (refused
  once the face moved).
- A daemon that saw `swarmReview` refuses unreviewed words for a Swarm face before they are transcribed:
  `Review the words before they are posted.`

## Not in this version

- Reading the reply aloud (choice 4a: later, only in the person's own chat and only when they turn it on).
- A light or screen for what waits on the person (choice 5a), and the Harness Pro, which has no Swarm chat face.

## Design (docs/feature-design-rules.md)

1. **Growth:** one draft per device session in memory (`VoiceDraft`), cleared on send, discard or detach. Nothing stored.
2. **Concurrency:** the draft is claimed before its post. A second Send returns the first one's receipt, so one Send is
   one message.
3. **Read cost:** no new reads. The face is read from the cards the daemon already holds.
4. **Scale:** one post per Send, as typing. At 10× the first warning is the backend's refusal rate in the cable log.
5. **Compatibility:** gated both ways (`swarm.review`, `swarmReview`). New firmware with an old daemon, or old firmware
   with a new daemon, behaves as today.
6. **Migration and rollback:** none to migrate. Rolling back either side returns to posting at once.
7. **Audience:** the post is the backend's `message.send` as the signed-in person, which enforces who may post. A Buddy
   chat's words never reach a terminal.
8. **Identity:** the signed-in person's, never the machine owner's login, as for every card post.
9. **Failure:** a refused or unconfirmed post leaves the draft with its reason; nothing is retried on its own.
10. **Platforms:** the round dial on macOS, Linux and Windows daemons alike. No platform-specific code.
