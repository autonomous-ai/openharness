# Phone task lines

The phone renders the server's existing `task-line` message as a quiet opening row in the project chat. This ports Desktop's presentation to the existing phone tokens; no protocol changes.

```
[mark] Task name                    working ›
[mark] Task name                     Answer ›
```

The title comes from the source title, falling back to message text. Words match Desktop: planned, working, in review, ready, shipped, done, stopped. Waiting says Answer only when answerFor identifies the reader; otherwise working. Unknown states say no word. Marks use the existing Lucide circleDashed, circleDot, check and circleSlash icons, matching Desktop. The name truncates when space is tight; the word stays visible. The row has a 44-point minimum tap target and one accessible label containing name and word. Answer uses stronger text weight.

A tap opens the referenced task chat through the existing phone route, only while the current snapshot holds that task. A missing or invalid target remains readable without an action. A legacy ship message is hidden when a task line for that same task is present in the loaded chat; legacy messages for other tasks remain. Normal messages after a task line retain their author header.

## Design

- Growth: no new stored data; rows use the chat's existing loaded message window and lifetime.
- Concurrency: N/A because this only renders immutable message snapshots on Flutter's UI isolate.
- Read cost: no additional reads until an explicit tap opens the existing chat route; filter one loaded window in linear time.
- Scale: at 10x loaded messages filtering remains linear; frame build time is the first warning metric.
- Compatibility: unknown states retain title and mark without an invented word; old ship messages remain when no replacement is loaded.
- Migration + rollback: no migration; reverting restores the existing plain-text presentation.
- Audience: existing server-filtered snapshot and chat endpoints enforce access; no client-created target grants access.
- Identity: reader account id controls Answer; never the computer owner's login.
- Failure: unavailable target is readable and noninteractive; existing route reports chat read failures.
- Platforms: shared Flutter presentation for iOS and Android; simulator validation on iOS, no physical-device installation.
