# Common question authority

## Design

Native and service-owned sessions now use one canonical question presentation and the existing request index.
The native remote-replay Map and Cloud's retained close frames are removed. This slice shares question authority;
it does not implement the separately proposed owner-presentation transport or approve its memory budget.

### Ownership, storage and lifetime

`createQuestionPresentations` owns the existing owner/session-keyed Map and reuses the Cloud request index as
`requestId -> canonical entry`. An entry contains `{owner,key,requestId,frame,dial,remote}`. Both indexes refer to
that same entry and frame. The public `openQuestions` facade exposes only size/has/get/values; mutation is through
owner-checked set/remove. Unknown or colliding request identities cannot overwrite another owner's question.
A close is derived from the accepted frame's agent/session/request fields, using the originally accepted dial
bit. It is not retained as a duplicate presentation.

Native `pending` remains the ordinary AskUserQuestion wait metadata; an accepted permission replacement removes
an older ordinary wait. `AskQuestionController.pending` remains the bounded historical request-to-session lookup,
and its driving Set and terminal lease are unchanged. Retired native answers still delegate to that controller,
which rereads and proves the live screen before typing. Current presentation is not permission to type.

The presentation/wait Map count falls from four to three: canonical owners, the reused request index, and native
pending. Native controller state is outside that count and unchanged. Native questions add entries to the shared
request index as their old remote Map entries disappear. This is a structural count, not a measured heap claim.

Each existing retained service owner row also carries one private, non-enumerable Symbol property pointing to its
incarnation token. Consecutive publications preserve the token only while the same id, factory and createdAt remain
present. Removal/recreation, even with identical provider facts, gets a fresh token. No additional catalogue Map,
history or receipt is kept. This authority metadata belongs in the eventual common owner entry; it is not a new
Cloud state store. It never enters JSON, checkpoints, frames or prepared rename payloads.

### Admission, dispatch and retirement

Native watcher callbacks construct their existing public frame verbatim and admit it before input/wait/control
side effects. A late `onQuestionGone(r1)` cannot remove r2 or clear its wait/input state. An unknown close with no
current entry preserves the prior callback behavior. Native permission metadata, parser/control limits and public
field order remain unchanged.

Cloud's existing 22 KiB question and 1 KiB close admission stays at its current door in this slice. Its exact field,
owner and request guards are unchanged; service physical-connection authority remains at the existing dispatcher.
Cloud frames are cloned on admission so an inline caller cannot mutate accepted bytes. Native frames retain their
existing trusted producer lifetime; the facade removes Map mutation, not every possible object mutation by trusted
core code. A full common service-presentation schema remains separate work.

Identical Cloud replay retains the canonical entry identity and originally accepted close audience. Replay may
narrow live destinations, never widen them or change content. A new request for one owner atomically replaces the
canonical entry, closes the captured old frame, then emits the new frame. A late retired close is an idempotent
no-op. Publication removal or changed owner incarnation retires its question before the owner deletion/change
notifications.

An answer captures the canonical question and owner incarnation. After first-start readiness, immediately before
provider dispatch, both must still be current. On settlement, the original owner incarnation and physical port
must still be current; the question need not remain open because the real service unasks before returning success.
An old result cannot succeed against a removed/recreated owner. A normal successful answer may close its question
and change ordinary owner state. The existing bounded port wait and public fallback remain unchanged.

### Callers and exact ordering

| Caller | Result |
| --- | --- |
| Native watcher asked/gone | Shared admission/retirement; existing native controller, wait and three-audience sends remain. |
| Cloud ask/unask and publish | Shared owner/request entry; no separate asked Map or retained close frame. |
| Main questionProvider, CoreApi questions, backend response handler | Existing `cloud.answer(...) ?? asking.answer(...)` delegation; Cloud reads the shared index, native retains its controller fallback. |
| Local snapshot and device attach | Canonical owner Map order; initial device attach still includes free-text Cloud questions even when their live dial send is disabled. |
| Remote snapshot/reannounce | Same canonical order, filtered by accepted remote audience; Cloud questions remain local. |
| Native monitor and close checks | Existing O(1) has/get facade; no scan or extra membership Set. |

Native Map replacement preserves the owner's position. Cloud replacement removes/reinserts that owner, preserving
its prior move-to-end behavior. There is no sorting, ordinal or linked-list structure. Native and Cloud use the
same close envelope and one frame object per canonical entry; no Registry presentation cache is added.

### Failures and privacy

Conflicting native admission logs fixed `QUESTION_ID_CONFLICT` and performs no question side effects. Existing
Cloud admission logs fixed `CLOUD_QUESTION_INVALID`; stale answer authority uses the existing fixed answer fallback.
The affected native watcher/controller logs contain fixed events/outcomes only, removing question, answer, dialog,
request/session identifiers and thrown-error text. Terminal lookup, lease and screen proof are otherwise unchanged.
Synthetic canaries cover each removed content-bearing refusal path. No persisted schema or user recovery command
changes; questions retain their existing process/session lifecycle.

## Validation

On macOS with pinned Node 24.22.2 and the shared immutable dependency tree:

- Initial RED receipt `20261118T165745.062647Z-91829`: seven intended stale-native-close/privacy failures.
- Answer review RED `20261118T171118.519337Z-7131`: four stale-start dispatch failures, unchanged replay identity,
  three owner-result revocation failures. Its ninth failure was an incomplete synthetic provider update; the real
  service suppresses needs-input before hearing a new message. Correcting that fixture produced a positive
  close-before-reply PASS in `20261118T171208.477049Z-8269`, beside the intended permission-replacement RED.
- Owner-replacement RED `20261118T171256.039119Z-9217`: the old incarnation's question remained answerable.
- Initial GREEN attempt `20261118T171340.670290Z-10432`: all 273 tests / 11 files passed, but the gate failed on two
  unexercised collision branches and a TypeScript unreachable `prior?.dial` expression. Both failed receipts remain.
- Final receipt `20261118T171530.805979Z-12483`: 84 tests in five directly affected core files pass, questions.ts and cloud.ts
  reach 100% statements/branches/functions/lines, and CLI types pass. The prior unchanged six files supply native
  controller/privacy, real-service recovery/close-before-reply, observation/close and architecture evidence.

No packaged native, transport timing or new heap acceptance is claimed for this slice. Parent integration owns
combined gates and packaged native proof. The earlier Cloud publication cost packets predate these changes; the
connected publication regression remains open. The staged common owner/read boundary and its exact bounded
allocation evidence remain unfinished and unapproved for runtime implementation.
