/// How a Swarm tab keeps itself current. The defaults are Desktop's: a full
/// read every poll, whether or not the tab is on screen, the first read's
/// failure shown at once, and the messages read after the state. The web
/// build turns on the rest (`lib/web/shell/web_chrome.dart`), because a phone
/// pays for every read in data, battery and main-thread time (#180's report).
class SuperTabReading {
  const SuperTabReading({
    this.quietPoll,
    this.quietAfter = const Duration(seconds: 30),
    this.pausesAway = false,
    this.readsOnConnect = false,
    this.connectGrace = Duration.zero,
    this.messagesWithState = false,
  });

  /// Null keeps a full read every poll. Otherwise, once the open conversation
  /// has had no new message and the person has done nothing for [quietAfter],
  /// the full read comes this often; the polls between only ask the open
  /// conversation for new messages and settle the person's own unsettled
  /// message, so a reply still shows within one poll.
  final Duration? quietPoll;
  final Duration quietAfter;

  /// True stops the poll while the tab is not the one on screen or the page is
  /// hidden, and reads at once when it is shown again.
  final bool pausesAway;

  /// True reads at once when a machine able to serve Swarm reads connects,
  /// instead of at the next poll.
  final bool readsOnConnect;

  /// How long a first read that found no connected machine keeps the loading
  /// state before it shows the error; a machine is usually still connecting.
  final Duration connectGrace;

  /// True starts the saved conversation's messages read beside the first
  /// state read, instead of after it.
  final bool messagesWithState;

  /// Whether the poll adapts at all; false is Desktop's fixed period.
  bool get adapts => quietPoll != null || pausesAway;
}
