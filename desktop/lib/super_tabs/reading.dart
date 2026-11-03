/// How a Swarm tab keeps itself current. The defaults: a full read every poll,
/// whether or not the tab is on screen, the first read's failure shown at
/// once, and the messages read after the state. Desktop reads with [desktop];
/// the web build turns on the rest (`lib/web/shell/web_chrome.dart`), because
/// a phone pays for every read in data, battery and main-thread time (#180's
/// report).
class SuperTabReading {
  const SuperTabReading({
    this.quietPoll,
    this.quietAfter = const Duration(seconds: 30),
    this.pausesAway = false,
    this.awayPoll,
    this.messagesWhenChanged = false,
    this.readsOnConnect = false,
    this.connectGrace = Duration.zero,
    this.retriesFirstRead = false,
    this.messagesWithState = false,
    this.drawsSaved = false,
    this.confirmsSaved = false,
    this.drawsSavedAtOnce = false,
  });

  /// Desktop's: a first open asks for the state and the open conversation at
  /// once, and a Swarm seen before asks only for what changed since, drawing
  /// nothing kept until that read has said what the reader may still see.
  static const desktop = SuperTabReading(
    awayPoll: Duration(seconds: 15),
    messagesWhenChanged: true,
    readsOnConnect: true,
    connectGrace: Duration(seconds: 10),
    retriesFirstRead: true,
    messagesWithState: true,
    drawsSaved: true,
    confirmsSaved: true,
    drawsSavedAtOnce: true,
  );

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

  /// Null polls an away Swarm as often as the one on screen. Otherwise a
  /// Swarm that is not the one on screen, or the whole app in the background,
  /// polls this often (as the web does), and reads at once when shown again.
  /// Unlike [pausesAway] it keeps reading: Desktop's badges and notices come
  /// from the Swarms it is not showing.
  final Duration? awayPoll;

  /// True reads the open conversation's messages only when its own counters
  /// say something happened there: a first read, a saved view, a message
  /// after those read, a changed reaction (spec 2026-11-02-poll-cost, Part
  /// 2). A poll whose state read moves neither then asks for the state alone,
  /// whatever else in the Swarm changed.
  final bool messagesWhenChanged;

  /// True reads at once when a machine able to serve Swarm reads connects,
  /// instead of at the next poll.
  final bool readsOnConnect;

  /// How long a first read that found no connected machine keeps the loading
  /// state before it shows the error; a machine is usually still connecting.
  final Duration connectGrace;

  /// True (Desktop) tries a first read that failed in passing again after
  /// [firstReadRetryDelays], within [connectGrace]. Its reads go through this
  /// computer's daemon, which may still be starting while the app opens: such a
  /// read used to wait for the next poll, 15 s for a Swarm not on screen, with the
  /// heading saying Reconnecting. The grace then covers any such failure, but not
  /// a settled one ([SuperTabFailure.settled]).
  final bool retriesFirstRead;

  /// The waits between tries of a first read ([retriesFirstRead]).
  static const firstReadRetryDelays = <Duration>[
    Duration(milliseconds: 500),
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 2),
    Duration(seconds: 2),
  ];

  /// True starts the saved conversation's messages read beside the first
  /// state read, instead of after it. Only the first: later reads wait for
  /// the state to say the conversation moved ([messagesWhenChanged]).
  final bool messagesWithState;

  /// True keeps the last view of each Swarm as read on this device and draws
  /// it at once on the next open, until the first read replaces it
  /// (`SuperTabSavedViews`).
  final bool drawsSaved;

  /// With [drawsSaved], true is Desktop's way with saved views: read before the
  /// first read, for it to start from, and forgetting only another account's.
  final bool confirmsSaved;

  /// With [confirmsSaved], true draws the saved view as soon as it is read,
  /// and false holds it until the first read has answered. Views are kept per
  /// account and another account's is forgotten at sign-in, so what draws is
  /// this account's own. A conversation it lost since shows until that first
  /// read answers, as on the web (Dee, task #2169).
  final bool drawsSavedAtOnce;

  /// Whether the poll adapts at all; false is Desktop's fixed period.
  bool get adapts => quietPoll != null || pausesAway;
}
