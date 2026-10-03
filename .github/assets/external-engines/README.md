# External session take-over

`take-over-grok.png` is a Flutter widget rendering of `askTakeOver` with a synthetic busy Grok
conversation, title and machine name. It shows the engine-specific wording: resuming Grok waits
for the person's next message. No real session or account appears in the image.

The behavior is covered by `desktop/test/take_over_dialog_test.dart`.
