# Device voice in the Swarm chat

Press the Harness device and speak: when the desktop has a Swarm chat in front, the words are posted there as the
person, with the same `message.send` typing uses, so every rule of who may post and who reads applies. The device shows
the chat's name while it records and, before anything is posted, the words with Send and Discard. The daemon also tells
a device how many decisions in a Swarm wait on its person, and opens them in the app when the person presses that.

Nothing here is in the daemon core beyond the two entries that pass the requests through (`core/devicesLink.ts`,
`core/superTabCards.ts`). The round device (`devices/harness-device`) speaks it; the Harness Pro does not yet.

## Where the voice goes

The desktop decides. The active Swarm tab's row in `app_swarms` carries the chat it has open while that chat is the
person's last choice:

```json
{"id":"tab-3","name":"openharness","superTabId":"st1","projectId":"web",
 "conversation":{"id":"c1","title":"Chat with PM","canPost":true}}
```

- `title` is what the chat header shows: the project's name for its Product Manager chat, `Chat with PM`, `Product
  Managers`, or the workgroup's label.
- `canPost` is the window's reading: a member who is not read-only, and a chat that is not archived.
- Absent while anything covers the chat (Your devices, Notifications, the pull requests, the group's terminals), and
  once the person focuses a terminal. Choosing a chat again, even the one already open, brings it back: the last choice
  wins. A chat that is uncovered, renamed or archived is announced again, but only a choice gives the voice back to it.

## Cable

| Direction | Frame | Fields |
|---|---|---|
| device → daemon | `hello` | `voiceTarget: "conversation-v1"` asks for `voice.target` |
| daemon → device | `welcome.features` | `voice.conversation` when this daemon posts in a chat |
| daemon → device | `voice.target` | `target: null` or `{kind:"conversation", tabId, id, name, canPost}`; on a change, and again on every forced swarms push |
| device → daemon | `voice.begin` | `conversationId` with `lang`, `sr`, `uploadId`, and nothing else |
| daemon → device | `voice.draft` | after `voice.end` with `review: true`: `agentId` is the chat's id, `name` its title, `context: "Swarm chat"` |
| daemon → device | `voice.transcript` | without review: `agentId: ""`, `agentName` the title, `conversationId` |
| daemon → device | `voice.error` | why nothing was posted, to show as it is |
| daemon → device | `supertab` | `needsYou`: how many decisions wait on the person in that Swarm; absent at none |
| device → daemon | `supertab.needs` | `tab`: the person pressed it; the window opens that Swarm's Notifications |

`name` is cut on a character to 39 bytes, the device's recipient line. A device names a chat in `voice.begin` only to a
daemon that lists `voice.conversation`: an older one would ignore the name and type the words into the focused terminal.

## Rules the daemon keeps

- **Only the chat the device showed.** `conversationId` must be the chat the window has in front as capture starts; a
  window that moved since the device drew its target gets `The chat changed. Check the device and try again.` The chat
  is then pinned for that recording, even if the window moves while the person speaks.
- **Alone.** A `conversationId` beside any other voice purpose or an `agentId` or `cmd` is refused. It never falls back
  to a terminal, a route or a draft of another kind.
- **Checked again as the person** (`superTabs/cards.ts` `post`): a fresh read of the Swarm as the signed-in person, and
  no post when they are no longer in it, only read it, the chat is archived or gone, or it is someone else's private
  chat. The backend checks the same again.
- **Once.** The post's operation id is the recording's (`device-voice-<uploadId>`), or the draft's, so a retried send
  is one message. A refusal says nothing went; anything uncertain says to check the Swarm chat. Nothing is retried on
  its own.

## Rules the device keeps

- Plain dictation from the face goes to the chat while a target is set; a goal stays with the agent on the face.
- A chat it cannot post in is not recorded for: `You can't post in this chat.`
- Words for a chat are always reviewed (Send or Discard), since everyone in the Swarm reads them.
- What waits on the person is a count only. What was asked is read in the app, never on a screen someone else may see.

## Not in this version

- Reading the Product Manager's reply aloud. It waits on the device owner's choice of where and when; nothing private is
  ever spoken in a shared space unless the person turned it on.
- The round device's light and screen for what waits on the person: the daemon sends the count and takes the press;
  how the device shows it is the device owner's choice, still open.
- The Harness Pro, which has no review screen yet.
- Hands-on requests addressed to one person join `needsYou` when the protocol that carries them lands.
