// The bar's state and its rules (spec: docs/superpowers/specs/2026-11-18-harness-max-v2-design.md, Demo V2's rules,
// ported from devices/harness-max/firmware/main/app/max_ui_*.c). The computer feeds it through the `on*` inputs, the
// person through the intents, and the app's ticker through tick(). Pages only read its fields and call intents.
import 'package:flutter/foundation.dart';

import '../link/bar_link.dart';
import 'types.dart';

/// Cells on one Overview page, segments on the agent page's strip, notices kept.
const int kCells = 5;
const int kSegments = 6;
const int kInboxMax = 12;
const int kLevels = 48;

/// The talk's timing: nothing heard closes the mic; quiet after speech sends.
const Duration kHearTimeout = Duration(milliseconds: 4000);
const Duration kSilenceSend = Duration(milliseconds: 1600);

/// Ambient after a minute untouched; a done or failed Attention returns by itself; a toast's life.
const Duration kAmbientAfter = Duration(seconds: 60);
const Duration kAttentionEnd = Duration(seconds: 8);
const Duration kToastFor = Duration(seconds: 5);

class BarModel extends ChangeNotifier {
  BarModel({BarLink? link, DateTime Function()? clock})
      : link = link ?? NullLink(),
        _clock = clock ?? DateTime.now;

  /// Where intents go. Set after construction when the link needs the model (CableLink(model)).
  BarLink link;
  final DateTime Function() _clock;
  DateTime now() => _clock();

  // ---- what the pages read ----

  /// A computer is on the cable (a welcome arrived and it has not gone quiet), and its name.
  bool connected = false;
  String computer = '';

  /// The computer offers New Harness: Apps shows "+ New".
  bool offersNew = false;

  BarPage page = BarPage.ambient;
  AmbientMood mood = AmbientMood.notConnected;

  /// The shown app's ring, in the daemon's order (an agent keeps its place).
  final List<Agent> agents = [];

  /// Every app with agents (`apps` frame), and the shown one's id. [appsKnown]: an `apps` frame arrived; without one
  /// (an older daemon) the app column shows the computer's name and there is no Apps page.
  final List<AppInfo> apps = [];
  String shownApp = '';
  bool appsKnown = false;

  /// Overview's page of cells.
  int cellPage = 0;

  /// The agent page's agent (null: none, or it left the ring).
  String? selectedId;

  /// Attention's agent and why; null when Attention is not up.
  Attention? attention;

  /// Open questions, by agent id.
  final Map<String, Ask> asks = {};

  /// Inbox, newest first, at most [kInboxMax].
  final List<Notice> inbox = [];

  /// The talk on the agent page.
  TalkPhase talk = TalkPhase.off;
  DateTime? talkStarted;

  /// Speech was heard in this recording.
  bool heard = false;

  /// 0..1: how far the quiet before the automatic send has run (the ring around "Tap to send").
  double quiet = 0;

  /// The mic's last [kLevels] levels, 0..1, oldest first: the waveform.
  final List<double> levels = [];

  /// The line at the bar's foot ("Sent to auth-refactor").
  Toast? toast;

  // ---- reads (as max_ui_nav.c) ----

  Agent? agentById(String? id) {
    if (id == null) return null;
    for (final a in agents) {
      if (a.id == id) return a;
    }
    return null;
  }

  Agent? get selected => agentById(selectedId);
  Ask? askOf(String id) => asks[id];

  int get cellPages => (agents.length + kCells - 1) ~/ kCells;

  /// The cells on Overview's current page.
  List<Agent> get cells {
    final from = cellPage * kCells;
    if (from >= agents.length) return const [];
    return agents.sublist(from, (from + kCells).clamp(0, agents.length));
  }

  /// A page of cells holds an agent that waits (its dot is yellow).
  bool pageWaits(int page) {
    for (var i = page * kCells; i >= 0 && i < agents.length && i < (page + 1) * kCells; i++) {
      if (agents[i].state == AgentState.asking) return true;
    }
    return false;
  }

  /// The strip's window: it keeps the selected agent in it, as near its middle as the ring's ends allow, so it shifts
  /// by one as the person browses rather than jumping a page.
  List<Agent> get segments {
    final sel = selected;
    final at = sel == null ? 0 : agents.indexOf(sel);
    var from = at - kSegments ~/ 2;
    if (from > agents.length - kSegments) from = agents.length - kSegments;
    if (from < 0) from = 0;
    return agents.sublist(from, (from + kSegments).clamp(0, agents.length));
  }

  int get unread => inbox.where((n) => n.unread).length;

  AppInfo? get shown {
    if (shownApp.isEmpty) return null;
    for (final a in apps) {
      if (a.id == shownApp) return a;
    }
    return null;
  }

  /// The app column's name: the shown app's, else the computer's.
  String get appLabel {
    final app = shown;
    if (app != null && app.name.isNotEmpty) return app.name;
    return computer.isNotEmpty ? computer : 'Harness';
  }

  /// The app an agent lives in, for "Answer it in `<App>`".
  String appOf(Agent? a) {
    final app = shown;
    if (app != null && app.name.isNotEmpty) return app.name;
    return a?.host ?? '';
  }

  /// There is another app to pick (the app column's grid glyph, and its tap opens Apps).
  bool get hasOtherApps => appsKnown && apps.any((a) => a.id != shownApp);

  /// The bar answers this agent's open question (caps `a`, and a question the inbox holds).
  bool takesAnswers(Agent? a) {
    if (a == null || !a.caps.answer) return false;
    return asks[a.id]?.answerable ?? false;
  }

  bool takesVoice(Agent? a) => a != null && a.caps.voice;

  /// The status word under a cell's name and on the agent page.
  String statusWord(Agent a) => switch (a.state) {
        AgentState.asking => 'Needs you',
        AgentState.working => a.verb.isNotEmpty ? a.verb : 'Working',
        AgentState.done => 'Done',
        AgentState.failed => 'Failed',
        AgentState.idle => 'Resting',
      };

  // ---- inputs from the computer (the cable decodes frames into these; the demo calls them) ----

  /// A welcome arrived (up) or the daemon went quiet (down). `offersNew`: the welcome offers New Harness.
  void onLink(bool up, {String computer = '', bool offersNew = false}) => throw UnimplementedError();

  /// The ring (`agents` frame): the shown app's agents, in order. Agents that left are dropped (their notices stay).
  void onAgents(List<AgentRow> rows) => throw UnimplementedError();

  /// `apps`: the shown app's id and every app with agents. Comes before the ring it names.
  void onApps(String shown, List<AppInfo> rows) => throw UnimplementedError();

  /// A turn moves, as pro_app_turn: kind "started" (text: the status line), "verb" (the spinner word), "activity"
  /// (the progress sentence; elapsedS the turn's clock or -1), "step" (one tool card), "done", "error" (text: why).
  void onTurn(String agentId, String kind, String text, {int elapsedS = -1}) => throw UnimplementedError();

  /// A finished turn's summary. `restore`: an old summary re-sent on connect (never news). `tier`: how loud.
  void onSummary(String agentId, String text,
          {String recap = '', bool restore = false, SummaryTier tier = SummaryTier.alert}) =>
      throw UnimplementedError();

  /// An agent asks: `text` the prompt, `items` its questions (empty: only the computer answers). `permission`: a
  /// permission prompt. `review`: answered through question.read then answer.reviewed.
  void onQuestion(String agentId, String requestId, String text,
          {List<AskItem> items = const [], bool permission = false, bool review = false}) =>
      throw UnimplementedError();

  /// The question was answered or withdrawn (anywhere).
  void onQuestionClose(String agentId) => throw UnimplementedError();

  /// question.state, the reply to BarLink.questionRead.
  void onQuestionState(String agentId, String fetch,
          {required bool ok,
          String requestId = '',
          String token = '',
          bool submitted = false,
          String error = '',
          List<AskItem> items = const []}) =>
      throw UnimplementedError();

  /// The receipt of answer.reviewed.
  void onAnswerReceipt(String agentId, String fetch,
          {required bool ok, String token = '', bool pending = false, String error = ''}) =>
      throw UnimplementedError();

  /// The computer's window moved to this agent (not a person at the bar: the page stays).
  void onFocus(String agentId) => throw UnimplementedError();

  /// A line the daemon wants shown.
  void onToast(String text) => throw UnimplementedError();

  /// The voice pipeline's state (recording, sending, idle).
  void onTalkLink(TalkLink state) => throw UnimplementedError();

  /// The mic's level, 0..1, about 20 times a second while recording.
  void onLevel(double level) => throw UnimplementedError();

  /// Runs the clocks: the talk's quiet send and hear timeout, Attention's 8 s end, the toast, Ambient after 60 s.
  /// The app calls it about ten times a second.
  void tick() => throw UnimplementedError();

  // ---- what the person does (pages call these) ----

  /// Any touch: the idle clock starts again.
  void touched() => throw UnimplementedError();

  /// One tap on a cell: the agent page with the mic open (agent.open and a recording); a waiting agent opens
  /// Attention; an agent without voice opens its page with the mic closed.
  void tapCell(String agentId) => throw UnimplementedError();

  /// A sideways swipe on Overview: the next (+1) or previous (-1) page of cells.
  void swipeCells(int dir) => throw UnimplementedError();

  /// The app column: Apps (only when there is another app).
  void openApps() => throw UnimplementedError();

  /// The bell: Inbox.
  void openInbox() => throw UnimplementedError();

  /// The agent page's Back: sends what was said (something heard) else cancels, then Overview.
  void back() => throw UnimplementedError();

  /// A strip segment: sends or cancels as Back, then shows that agent with the mic closed.
  void tapSegment(String agentId) => throw UnimplementedError();

  /// A sideways swipe on the agent page: the next (+1) or previous (-1) agent, as tapSegment.
  void swipeAgent(int dir) => throw UnimplementedError();

  /// The agent page's body: sends at once while listening; opens the mic when it is off or closed.
  void tapBody() => throw UnimplementedError();

  /// The band's X: stop and send nothing.
  void cancelTalk() => throw UnimplementedError();

  /// Attention: an option of the card's question.
  void choose(int option) => throw UnimplementedError();

  /// Attention on a permission prompt: Allow or Deny.
  void allow() => throw UnimplementedError();
  void deny() => throw UnimplementedError();

  /// Attention's "Say it": the agent page with the mic open.
  void sayIt() => throw UnimplementedError();

  /// Attention outside its buttons (or a question the bar cannot answer): agent.open, the toast "`<name>` is up in
  /// `<App>`", Overview.
  void away() => throw UnimplementedError();

  /// An Inbox card.
  void tapNotice(Notice notice) => throw UnimplementedError();

  /// Inbox's or Apps' Close: Overview (leaving Inbox marks every notice read).
  void closeList() => throw UnimplementedError();

  /// An app card: app.pick, then Overview.
  void pickApp(String appId) => throw UnimplementedError();

  /// The "+ New" card: New Harness on the computer.
  void newHarness() => throw UnimplementedError();

  /// A tap on Ambient: Overview.
  void wake() => throw UnimplementedError();

  /// A tap on the toast: Attention for its agent, when it names one.
  void tapToast() => throw UnimplementedError();

  /// Pages call this after changing fields directly in fixtures and tests.
  void changed() => notifyListeners();
}
