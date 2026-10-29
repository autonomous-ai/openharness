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
    this.messagesWithState = false,
    this.drawsSaved = false,
    this.confirmsSaved = false,
  });

  /// Desktop's: a first open asks for the state and the open conversation at
  /// once, and a Swarm seen before asks only for what changed since, drawing
  /// nothing kept until that read has said what the reader may still see.
  static const desktop = SuperTabReading(
    awayPoll: Duration(seconds: 15),
    messagesWhenChanged: true,
    messagesWithState: true,
    drawsSaved: true,
    confirmsSaved: true,
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

  /// True reads the open conversation's messages only when something may
  /// have happened: a first read, a push, a state that moved since they were
  /// read, a message waiting for its receipt. A poll whose state read finds
  /// nothing new then asks for the state alone.
  final bool messagesWhenChanged;

  /// True reads at once when a machine able to serve Swarm reads connects,
  /// instead of at the next poll.
  final bool readsOnConnect;

  /// How long a first read that found no connected machine keeps the loading
  /// state before it shows the error; a machine is usually still connecting.
  final Duration connectGrace;

  /// True starts the saved conversation's messages read beside the first
  /// state read, instead of after it.
  final bool messagesWithState;

  /// True keeps the last view of each Swarm as read on this device and draws
  /// it at once on the next open, until the first read replaces it
  /// (`SuperTabSavedViews`).
  final bool drawsSaved;

  /// With [drawsSaved], true holds a saved view's parts for the first read
  /// to start from but draws them only once that read has answered, so a
  /// conversation the reader lost since is never on screen.
  final bool confirmsSaved;

  /// Whether the poll adapts at all; false is Desktop's fixed period.
  bool get adapts => quietPoll != null || pausesAway;
}
