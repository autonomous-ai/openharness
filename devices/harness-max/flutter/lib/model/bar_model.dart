// The bar's state and its rules (spec: docs/superpowers/specs/2026-11-18-harness-max-v2-design.md, Demo V2's rules,
// ported from devices/harness-max/firmware/main/app/max_ui_*.c). The computer feeds it through the `on*` inputs, the
// person through the intents, and the app's ticker through tick(). Pages only read its fields and call intents.
import 'package:flutter/foundation.dart';

import '../link/bar_link.dart';
import 'types.dart';
import 'words.dart';

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

/// A finished turn's small note at the glass's bottom right.
const Duration kDoneNoteFor = Duration(seconds: 6);

/// A mic level at least this is speech: the C model's MAX_SPEECH_LEVEL 2 on pro_rec_level's 0..4, on this 0..1 scale.
const double kSpeechLevel = 0.5;

/// A plain line at the foot ("Sent to a", the daemon's toast) lasts as long as the Pro's notice (MAX_NOTICE_MS).
const Duration kNoticeFor = Duration(seconds: 3);

/// The reviewed path's question.read: this many tries, this far apart, before the card says there was no reply; and how
/// long an answer.reviewed's receipt may take (longer: the terminal has to take the answer first).
const int kReadTries = 3;
const Duration kReadEvery = Duration(seconds: 2);
const Duration kReceiptWait = Duration(seconds: 10);

// The ring and the apps are bounded as the daemon's own sets are (MAX_AGENTS, PRO_APPS_MAX); a turn shows its last
// three steps (MAX_STEPS).
const int _agentsMax = 32;
const int _appsMax = 16;
const int _stepsKept = 3;

/// The next question.read of a reviewed question, or when its answer's receipt is overdue.
class _Due {
  _Due(this.at);
  DateTime at;
  int reads = 0;
}

class BarModel extends ChangeNotifier {
  BarModel({BarLink? link, DateTime Function()? clock})
      : link = link ?? NullLink(),
        _clock = clock ?? DateTime.now,
        _idleFrom = (clock ?? DateTime.now)();

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

  /// A finished turn: the small note at the glass's bottom right ([Toast.agentId] who, [Toast.text] what it said).
  /// It never takes the glass; its notice waits in Inbox, unread, until the person reads it.
  Toast? doneNote;

  // ---- the model's own bookkeeping (max_model_t's fields the pages do not draw) ----

  /// The last touch or news: Ambient waits [kAmbientAfter] from it.
  DateTime _idleFrom;

  /// The agent the open recording is for (C talk_id): its "Sent to", and its question the words answer.
  String? _talkId;

  /// The last speech heard: the quiet before the automatic send counts from it.
  DateTime? _quietFrom;

  /// Names each question.read ("q1", "q2"...): a late reply to an older read is told apart from the current one's.
  int _askSerial = 0;

  /// What each asking agent asked (request, words, questions): the same question re-sent keeps its place.
  final Map<String, String> _askKeys = {};

  /// The reviewed questions' reads and receipts the clock owes, by agent id.
  final Map<String, _Due> _dues = {};

  /// Something drawn changed since the pages were last told; and the time-dependent drawing they were told of.
  bool _dirty = false;
  String _drawn = '';

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

  /// The turn's clock in whole seconds (max_secs): running while it works or asks, stopped where it was when the turn
  /// ended; null when no turn was seen start and the daemon gave no count.
  int? clockOf(Agent a) {
    if (!_running(a.state)) return a.turnSeconds;
    final from = a.turnStarted;
    if (from == null) return null;
    final s = now().difference(from).inMilliseconds ~/ 1000;
    return s < 0 ? 0 : s;
  }

  /// How long ago, as the agent page's status and Inbox's cards say it (max_fmt_ago): "just now" under a minute, then
  /// "2m ago", "3h ago", "4d ago".
  String ago(DateTime at) {
    final s = now().difference(at).inSeconds;
    if (s < 60) return 'just now';
    if (s < 3600) return '${s ~/ 60}m ago';
    if (s < 86400) return '${s ~/ 3600}h ago';
    return '${s ~/ 86400}d ago';
  }

  // ---- inputs from the computer (the cable decodes frames into these; the demo calls them) ----

  /// A welcome arrived (up) or the daemon went quiet (down). `offersNew`: the welcome offers New Harness.
  void onLink(bool up, {String computer = '', bool offersNew = false}) {
    if (up) {
      if (!connected || this.computer != computer || this.offersNew != offersNew) _dirty = true;
      connected = true;
      this.computer = computer;
      this.offersNew = offersNew;
      _settle();
      _publish();
      return;
    }
    // Everything the daemon told goes with it: an agent on the bar is a claim that it is there now. Inbox stays: what
    // happened, happened.
    final talking = talk == TalkPhase.listening || talk == TalkPhase.sending;
    if (connected || this.computer.isNotEmpty || this.offersNew || agents.isNotEmpty || apps.isNotEmpty || appsKnown ||
        asks.isNotEmpty || talking || toast?.agentId != null) {
      _dirty = true;
    }
    connected = false;
    this.computer = '';
    this.offersNew = false;
    agents.clear();
    asks.clear();
    _askKeys.clear();
    _dues.clear();
    apps.clear();
    shownApp = '';
    appsKnown = false;
    selectedId = null;
    cellPage = 0;
    if (toast?.agentId != null) toast = null;
    // The voice pipeline went with the daemon: nothing is recorded or sent, and the clock owes the talk nothing.
    _talkId = null;
    if (talking) talk = TalkPhase.off;
    _show(BarPage.ambient);
    _settle();
    _publish();
  }

  /// The ring (`agents` frame): the shown app's agents, in order. Agents that left are dropped (their notices stay).
  void onAgents(List<AgentRow> rows) {
    final before = _ringKey();
    final wasEmpty = agents.isEmpty;
    final old = {for (final a in agents) a.id: a};
    final ring = <Agent>[];
    final seen = <String>{};
    for (final r in rows) {
      if (ring.length >= _agentsMax) break;
      if (r.id.isEmpty || !seen.add(r.id)) continue;
      // An agent that stays keeps its object: its turn goes on, and pages holding it see the new ring's fields.
      final a = old[r.id] ?? Agent(id: r.id, name: r.id, since: now());
      a
        ..name = r.name.isNotEmpty ? r.name : r.id
        ..engine = r.engine
        ..host = r.host
        ..caps = Caps.of(r.caps);
      ring.add(a);
    }
    agents
      ..clear()
      ..addAll(ring);
    // A question goes with its agent.
    for (final id in [...asks.keys, ..._askKeys.keys, ..._dues.keys]) {
      if (agentById(id) == null) _dropAsk(id);
    }
    if (_ringKey() != before) _dirty = true;
    if (selectedId != null && selected == null) {
      selectedId = null; // its page goes (settle)
      _dirty = true;
    }
    final last = cellPages - 1;
    if (cellPage > last) {
      cellPage = last < 0 ? 0 : last;
      _dirty = true;
    }
    if (agents.isEmpty && !wasEmpty) {
      _show(BarPage.ambient); // nobody left: Ambient
    } else if (agents.isNotEmpty && wasEmpty) {
      _idleFrom = now(); // the first agents: Overview, and Ambient waits from now
      if (page == BarPage.ambient) _show(BarPage.overview);
    }
    _settle();
    _publish();
  }

  /// `apps`: the shown app's id and every app with agents. Comes before the ring it names.
  void onApps(String shown, List<AppInfo> rows) {
    final list = [
      for (final r in rows.take(_appsMax))
        AppInfo(
            id: r.id,
            name: r.name.isNotEmpty ? r.name : r.id,
            count: r.count < 0 ? 0 : r.count,
            waiting: r.waiting < 0 ? 0 : r.waiting),
    ];
    var same = list.length == apps.length;
    for (var i = 0; same && i < list.length; i++) {
      final a = list[i], b = apps[i];
      same = a.id == b.id && a.name == b.name && a.count == b.count && a.waiting == b.waiting;
    }
    if (shown != shownApp) cellPage = 0; // another app's agents: from their first page
    if (!appsKnown || shown != shownApp || !same) _dirty = true;
    // The computer turned the bar to the app in front, as the mockup's follow() tells it; never the first app shown,
    // never the app the person just picked here, never over a person talking.
    if (appsKnown && shown.isNotEmpty && shown != shownApp) {
      final name = list.where((a) => a.id == shown).map((a) => a.name).firstOrNull ?? shown;
      if (shown != _picked && talk != TalkPhase.listening) _notice('Following $name on your Mac');
      _picked = '';
    }
    apps
      ..clear()
      ..addAll(list);
    shownApp = shown;
    appsKnown = true;
    _publish();
  }

  /// A turn moves, as pro_app_turn: kind "started" (text: the status line), "verb" (the spinner word), "activity"
  /// (the progress sentence; elapsedS the turn's clock or -1), "step" (one tool card), "done", "error" (text: why).
  void onTurn(String agentId, String kind, String text, {int elapsedS = -1}) {
    final a = agentById(agentId);
    if (a == null) return;
    final before = _agentKey(a);
    final wasRunning = _running(a.state);
    if (!_turn(a, kind, text, elapsedS) || _agentKey(a) == before) {
      _settle();
      _publish();
      return;
    }
    _dirty = true;
    _idleFrom = now();
    if (kind == 'error') {
      _attend(a, AttnKind.failed);
    } else if (_running(a.state) && !wasRunning && page == BarPage.ambient) {
      _show(BarPage.overview);
    }
    _settle();
    _publish();
  }

  /// A finished turn's summary. `restore`: an old summary re-sent on connect (never news). `tier`: how loud.
  void onSummary(String agentId, String text,
      {String recap = '', bool restore = false, SummaryTier tier = SummaryTier.alert}) {
    final a = agentById(agentId);
    if (a == null || restore) return; // history filled back in: never news
    final before = _agentKey(a);
    // "done" is the daemon's placeholder when the turn had nothing to say: the recap speaks instead.
    final say = text.isNotEmpty && text != 'done' ? text : (recap.isNotEmpty ? recap : null);
    final failed = a.state == AgentState.failed;
    var spoke = false, card = false;
    if (failed) {
      if (a.said.isEmpty && say != null) a.said = say; // the error first; with none, what happened
    } else {
      if (a.state != AgentState.done) {
        // A live summary ends the turn.
        a.said = '';
        _setState(a, AgentState.done);
        _dropAsk(a.id);
      }
      if (tier != SummaryTier.silent && say != null) {
        a.said = say;
        spoke = true;
      }
      card = tier == SummaryTier.alert && say != null; // the loud tier takes Attention; list only shows on its page
    }
    // A summary that speaks is news even in the same words (the C model's note clock starts again).
    if (!spoke && _agentKey(a) == before) {
      _settle();
      _publish();
      return;
    }
    _dirty = true;
    _idleFrom = now();
    if (failed) {
      _inboxWords(a);
    } else if (card) {
      _attend(a, AttnKind.done);
    }
    _settle();
    _publish();
  }

  /// An agent asks: `text` the prompt, `items` its questions (empty: only the computer answers). `permission`: a
  /// permission prompt. `review`: answered through question.read then answer.reviewed.
  void onQuestion(String agentId, String requestId, String text,
      {List<AskItem> items = const [], bool permission = false, bool review = false}) {
    final a = agentById(agentId);
    if (a == null) return;
    final key = _questionKey(requestId, text, items);
    if (a.state == AgentState.asking && _askKeys[a.id] == key) return; // the same question, re-sent: it keeps its place
    _setState(a, AgentState.asking);
    a.said = text;
    _askKeys[a.id] = key;
    _dues.remove(a.id);
    final k = Ask(agentId: a.id, requestId: requestId, text: text, since: now())
      ..permission = permission && items.isNotEmpty;
    _takeItems(k, items);
    if (requestId.startsWith('shown:')) {
      // Shown only (cableSession.ts SHOWN_ONLY_PREFIX): answered in the agent's own app, which its one option names.
      k.path = AskPath.shown;
      final options = items.isEmpty ? const <String>[] : items[0].options;
      if (options.isNotEmpty && options[0].startsWith('In ')) k.app = options[0].substring(3);
    } else if (requestId.isEmpty || items.isEmpty) {
      k.path = AskPath.computer;
    } else if (review) {
      k.path = AskPath.reviewed;
      _startRead(k);
    } else {
      // A plain answer echoes every key and option: only when each came whole.
      final whole = items.every((it) => it.key != null && it.whole && it.options.isNotEmpty);
      k.path = whole ? AskPath.plain : AskPath.computer;
    }
    asks[a.id] = k;
    _dropTail(a, k);
    _dirty = true;
    _attend(a, AttnKind.ask);
    _settle();
    _publish();
  }

  /// The question was answered or withdrawn (anywhere).
  void onQuestionClose(String agentId) {
    final a = agentById(agentId);
    if (a == null || a.state != AgentState.asking) return;
    _answered(a);
    _settle();
    _publish();
  }

  /// question.state, the reply to BarLink.questionRead.
  void onQuestionState(String agentId, String fetch,
      {required bool ok,
      String requestId = '',
      String token = '',
      bool submitted = false,
      String error = '',
      List<AskItem> items = const []}) {
    final k = asks[agentId];
    // Only the read this card waits for: a late reply to an earlier read names another fetch.
    if (k == null || k.path != AskPath.reviewed || k.phase != AskPhase.reading || k.fetch != fetch) return;
    if (!ok || items.isEmpty || token.isEmpty || requestId.isEmpty) {
      k
        ..phase = AskPhase.failed
        ..note = error.isNotEmpty ? error : 'Could not load the question.';
    } else {
      _takeItems(k, items); // the daemon's own copy: what the token names
      k.token = token;
      final a = agentById(agentId);
      if (a != null) _dropTail(a, k);
      if (submitted) {
        // Taken already (another device, or a receipt that never came): it is not asked again.
        k
          ..phase = AskPhase.sent
          ..note = 'An answer was already sent. Check the terminal.';
      } else {
        k.phase = AskPhase.ready;
      }
    }
    _dirty = true;
    _settle();
    _publish();
  }

  /// The receipt of answer.reviewed.
  void onAnswerReceipt(String agentId, String fetch,
      {required bool ok, String token = '', bool pending = false, String error = ''}) {
    final a = agentById(agentId);
    final k = asks[agentId];
    if (a == null ||
        k == null ||
        k.path != AskPath.reviewed ||
        k.phase != AskPhase.sending ||
        k.fetch != fetch ||
        k.token != token) {
      return;
    }
    if (!ok) {
      k
        ..phase = AskPhase.failed
        ..note = error.isNotEmpty ? error : 'Could not confirm the answer. Check the terminal.';
      _notice(k.note);
    } else {
      _notice('Sent');
      if (pending) {
        // Taken, the terminal not done with it yet: the question's close ends it.
        k
          ..phase = AskPhase.sent
          ..note = '';
      } else {
        _answered(a);
      }
    }
    _dirty = true;
    _settle();
    _publish();
  }

  /// The computer's window moved to this agent (not a person at the bar: the page stays).
  void onFocus(String agentId) {}

  /// A line the daemon wants shown.
  void onToast(String text) {
    if (text.isEmpty) {
      // It clears its own line, never what an agent announced.
      if (toast != null && toast!.agentId == null) {
        toast = null;
        _dirty = true;
      }
    } else {
      _notice(text);
    }
    _publish();
  }

  /// The voice pipeline's state (recording, sending, idle).
  void onTalkLink(TalkLink state) {
    switch (state) {
      case TalkLink.recording:
        _setTalk(TalkPhase.listening);
      case TalkLink.sending:
        _setTalk(TalkPhase.sending);
      case TalkLink.idle:
        // Closed stays: the page keeps saying why the mic closed until the person moves on.
        if (talk == TalkPhase.listening || talk == TalkPhase.sending) _setTalk(TalkPhase.off);
    }
    _settle();
    _publish();
  }

  /// The mic's level, 0..1, about 20 times a second while recording.
  void onLevel(double level) {
    if (talk != TalkPhase.listening) return;
    final v = level.isNaN ? 0.0 : level.clamp(0.0, 1.0);
    if (levels.length >= kLevels) levels.removeRange(0, levels.length - kLevels + 1);
    levels.add(v);
    if (v >= kSpeechLevel) {
      heard = true;
      _quietFrom = now();
    }
    _updateQuiet();
    _dirty = true;
    _publish();
  }

  /// Runs the clocks: the talk's quiet send and hear timeout, Attention's 8 s end, the toast, Ambient after 60 s.
  /// The app calls it about ten times a second.
  void tick() {
    // The link's calls go after every change, so a link that answers at once sees the model settled.
    final talkCall = connected ? _talkDue() : null;
    final reads = connected ? _asksDue() : const <Ask>[];
    _settle();
    if (talk == TalkPhase.listening) _updateQuiet();
    final t = toast;
    if (t != null) {
      final announced = t.agentId;
      if (!now().isBefore(t.until) || (announced != null && !_holds(announced, t.kind))) {
        toast = null;
        _dirty = true;
      }
    }
    final d = doneNote;
    if (d != null && (!now().isBefore(d.until) || !_holds(d.agentId!, AttnKind.done))) {
      doneNote = null; // its time is up, or its agent is at work again or gone
      _dirty = true;
    }
    talkCall?.call();
    for (final k in reads) {
      link.questionRead(k.agentId, k.requestId, k.fetch);
    }
    _publish();
  }

  // ---- what the person does (pages call these) ----

  /// Any touch: the idle clock starts again.
  void touched() => _idleFrom = now();

  /// One tap on a cell: the agent page with the mic open (agent.open and a recording); a waiting agent opens
  /// Attention; an agent without voice opens its page with the mic closed.
  void tapCell(String agentId) {
    touched();
    if (_sendsFirst()) return;
    final a = agentById(agentId);
    if (a == null) return; // a cell whose agent left the ring since it was drawn opens nothing
    if (a.state == AgentState.asking) {
      _attention(a.id, AttnKind.ask); // its question first: nothing is recorded
      _publish();
      return;
    }
    _showAgent(a.id);
    final talks = _canTalk(a) && takesVoice(a);
    if (talks) _listenTo(a);
    link.openAgent(a.id);
    if (talks) link.startTalk(a.id);
    _publish();
  }

  /// A sideways swipe on Overview: the next (+1) or previous (-1) page of cells.
  void swipeCells(int dir) {
    touched();
    // While the mic is open only the agent page moves on (with what was heard); Overview rests.
    if (talk == TalkPhase.listening || page != BarPage.overview) return;
    final last = cellPages - 1;
    final p = (cellPage + dir).clamp(0, last < 0 ? 0 : last);
    if (p != cellPage) {
      cellPage = p;
      _dirty = true;
    }
    _publish();
  }

  /// The app column: Apps (only when there is another app).
  void openApps() {
    touched();
    if (_sendsFirst() || !hasOtherApps) return;
    _show(BarPage.apps);
    _publish();
  }

  /// The bell: Inbox.
  void openInbox() {
    touched();
    if (_sendsFirst()) return;
    _show(BarPage.inbox);
    _publish();
  }

  /// The agent page's Back: sends what was said (something heard) else cancels, then Overview.
  void back() {
    touched();
    final call = talk == TalkPhase.listening ? _settleTalk() : null;
    _show(BarPage.overview);
    call?.call();
    _publish();
  }

  /// A strip segment: sends or cancels as Back, then shows that agent with the mic closed.
  void tapSegment(String agentId) {
    touched();
    final a = agentById(agentId);
    // A segment whose agent left the ring since it was drawn is no segment: bare glass.
    final real = page == BarPage.agent && a != null;
    if (talk == TalkPhase.listening && !real) {
      _sendsFirst();
      return;
    }
    if (!real) return;
    final call = talk == TalkPhase.listening ? _settleTalk() : null;
    _showAgent(a.id);
    call?.call();
    _publish();
  }

  /// A sideways swipe on the agent page: the next (+1) or previous (-1) agent, as tapSegment.
  void swipeAgent(int dir) {
    touched();
    final a = selected;
    if (page != BarPage.agent || agents.length < 2 || a == null) return;
    final call = talk == TalkPhase.listening ? _settleTalk() : null;
    _showAgent(agents[(agents.indexOf(a) + dir) % agents.length].id); // round the ring's ends
    call?.call();
    _publish();
  }

  /// The agent page's body: sends at once while listening; opens the mic when it is off or closed.
  void tapBody() {
    touched();
    if (_sendsFirst()) return;
    final a = page == BarPage.agent ? selected : null;
    if (a == null) return;
    if (_canTalk(a) && takesVoice(a)) {
      _listenTo(a);
      link.startTalk(a.id);
    } else {
      link.openAgent(a.id); // the bar cannot listen for it now: "Talk to it in <App>"
    }
    _publish();
  }

  /// The band's X: stop and send nothing.
  void cancelTalk() {
    touched();
    if (talk != TalkPhase.listening) return;
    final said = heard;
    _setTalk(TalkPhase.off);
    _notice(said ? 'Cancelled, nothing sent' : 'Mic closed');
    link.cancelTalk();
    _publish();
  }

  /// Attention: an option of the card's question.
  void choose(int option) {
    touched();
    if (_sendsFirst()) return;
    final card = _card();
    if (card == null) return;
    final (a, k) = card;
    final it = k.items[k.step];
    if (k.phase != AskPhase.ready || option < 0 || option >= it.options.length) return;
    if (it.multi) {
      k.choices[k.step] ^= 1 << option;
      _dirty = true;
      _publish();
      return;
    }
    k.choices[k.step] = 1 << option; // one tap is the answer
    _advance(a, k);
  }

  /// Attention on a permission prompt: Allow or Deny.
  void allow() => _permit(true);
  void deny() => _permit(false);

  /// Attention's "Say it": the agent page with the mic open.
  void sayIt() {
    touched();
    if (_sendsFirst()) return;
    final at = attention;
    if (page != BarPage.attention || at == null || at.kind != AttnKind.ask) return;
    final a = agentById(at.agentId);
    // A permission prompt takes Allow or Deny only, and an answer on its way no words.
    if (a == null || !_canTalk(a) || !takesVoice(a)) return;
    _showAgent(a.id);
    _listenTo(a);
    link.startTalk(a.id);
    _publish();
  }

  /// Attention outside its buttons (or a question the bar cannot answer): agent.open, the toast "`<name>` is up in
  /// `<App>`", Overview.
  void away() {
    touched();
    if (_sendsFirst()) return;
    final at = attention;
    if (page != BarPage.attention || at == null) return;
    final a = agentById(at.agentId);
    if (a == null) {
      _show(BarPage.overview);
      _publish();
      return;
    }
    _bringUp(a.id, a.name, appOf(a));
  }

  /// An Inbox card.
  void tapNotice(Notice notice) {
    touched();
    if (_sendsFirst() || page != BarPage.inbox) return;
    if (!connected) {
      _notice('Not connected'); // nobody to bring it up
      _publish();
      return;
    }
    // A question still open that the bar answers is its Attention; anything else is brought up on the computer, under
    // the name and app the notice kept (its agent may have left the ring).
    final a = agentById(notice.agentId);
    if (a != null && a.state == AgentState.asking && takesAnswers(a)) {
      _attention(a.id, AttnKind.ask);
      _publish();
      return;
    }
    _bringUp(notice.agentId, notice.name, notice.app);
  }

  /// Inbox's or Apps' Close: Overview (leaving Inbox marks every notice read).
  void closeList() {
    touched();
    if (_sendsFirst()) return;
    _show(BarPage.overview);
    _publish();
  }

  /// An app card: app.pick, then Overview.
  void pickApp(String appId) {
    touched();
    // A card acts only while Apps is up: a tap can land between a change and the redraw.
    if (_sendsFirst() || page != BarPage.apps || !apps.any((a) => a.id == appId)) return;
    _show(BarPage.overview); // the daemon turns to it, and its next `apps` names it shown
    _picked = appId;
    link.pickApp(appId);
    _publish();
  }

  /// The "+ New" card: New Harness on the computer.
  void newHarness() {
    touched();
    if (_sendsFirst() || !connected || !offersNew) return;
    _notice(computer.isNotEmpty ? 'New Harness is up on $computer' : 'New Harness is up');
    _show(BarPage.overview);
    link.newHarness();
    _publish();
  }

  /// A tap on Ambient: Overview.
  void wake() {
    touched();
    if (_sendsFirst()) return;
    _show(BarPage.overview);
    _publish();
  }

  /// A tap on a finished turn's note: its agent's page to read what it did (the mic closed), its notice read. Words
  /// being said go first, as a strip segment sends them; an agent gone from the ring leaves Inbox, where it still is.
  void tapDoneNote() {
    touched();
    final n = doneNote;
    final id = n?.agentId;
    if (n == null || id == null) return;
    doneNote = null;
    _dirty = true;
    final call = talk == TalkPhase.listening ? _settleTalk() : null;
    if (agentById(id) == null) {
      _show(BarPage.inbox);
    } else {
      for (final x in inbox) {
        if (x.kind == AttnKind.done && x.agentId == id) x.unread = false;
      }
      _showAgent(id);
    }
    call?.call();
    _publish();
  }

  /// A tap on the toast: Attention for its agent, when it names one.
  void tapToast() {
    touched();
    final t = toast;
    // The words go first (a tap never loses them); the toast's Attention then, while its agent still is what it
    // announced. Read before the send: "Sent to" takes the toast's place.
    final call = talk == TalkPhase.listening ? _sendOnward() : null;
    final id = t?.agentId;
    if (t != null && id != null && now().isBefore(t.until) && _holds(id, t.kind)) {
      _attention(id, t.kind ?? AttnKind.ask);
    }
    call?.call();
    _publish();
  }

  /// Attention on a reviewed question whose read or answer failed: read it again, under a new name.
  void reload() {
    touched();
    if (_sendsFirst()) return;
    final card = _card();
    if (card == null) return;
    final (_, k) = card;
    if (k.path != AskPath.reviewed || k.phase != AskPhase.failed) return;
    _startRead(k);
    _dirty = true;
    _publish();
  }

  /// Attention on a question of several choices: Send them (it needs one).
  void sendChoices() {
    touched();
    if (_sendsFirst()) return;
    final card = _card();
    if (card == null) return;
    final (a, k) = card;
    if (k.phase != AskPhase.ready || k.choices[k.step] == 0) return;
    _advance(a, k);
  }

  /// Attention on a request of several questions: back to the one before, its choice kept.
  void stepBack() {
    touched();
    if (_sendsFirst()) return;
    final card = _card();
    if (card == null) return;
    final (_, k) = card;
    if (k.phase != AskPhase.ready || k.step == 0) return;
    k.step--;
    _dirty = true;
    _publish();
  }

  /// Pages call this after changing fields directly in fixtures and tests.
  void changed() => notifyListeners();

  // ---- the rules (max_ui_model.c, max_ui_ask.c, max_ui_touch.c) ----

  static bool _running(AgentState s) => s == AgentState.working || s == AgentState.asking;

  /// Tells the pages, once, when something they draw changed: a field, or what the time alone moves (max_time_key).
  void _publish() {
    final key = _timeKey();
    if (!_dirty && key == _drawn) return;
    _dirty = false;
    _drawn = key;
    notifyListeners();
  }

  /// What is drawn from the clock: the agent page's turn clock or "ago", Inbox's "ago"s, the recording's band (its
  /// frames, 100 ms apart, as MAX_TALK_FRAME_MS), and Ambient's clock face.
  String _timeKey() {
    final b = StringBuffer(page.index);
    final a = page == BarPage.agent ? selected : null;
    if (a != null) b.write('|${_running(a.state) ? clockOf(a) : ago(a.since)}');
    if (page == BarPage.inbox) {
      for (final n in inbox) {
        b.write('|${ago(n.at)}');
      }
    }
    final from = talkStarted;
    if (talk == TalkPhase.listening && from != null) b.write('|t${now().difference(from).inMilliseconds ~/ 100}');
    if (page == BarPage.ambient) b.write('|${now().hour}:${now().minute}');
    return b.toString();
  }

  /// What a turn's feed can change on an agent: changed or not decides whether it is news.
  String _agentKey(Agent a) => [
        a.state.index,
        a.verb,
        a.activity,
        a.said,
        a.since.microsecondsSinceEpoch,
        a.turnStarted?.microsecondsSinceEpoch,
        a.turnSeconds,
        asks.containsKey(a.id),
        _askKeys[a.id],
        for (final s in a.steps) '${s.verb}\u0001${s.detail}',
      ].join('\u0000');

  String _ringKey() => [
        for (final a in agents)
          '${a.id}\u0001${a.name}\u0001${a.engine}\u0001${a.host}\u0001'
              '${a.caps.status}${a.caps.voice}${a.caps.focus}${a.caps.answer}',
      ].join('\u0000');

  static String _questionKey(String requestId, String text, List<AskItem> items) => [
        requestId,
        text,
        for (final it in items) '${it.key}\u0001${it.q}\u0001${it.options.join('\u0002')}\u0001${it.multi}',
      ].join('\u0000');

  /// A state change stops the turn's clock where it is when the turn ends, and drops it when a turn not seen start
  /// begins (until the daemon says how long it has run).
  void _setState(Agent a, AgentState st) {
    final was = _running(a.state), will = _running(st);
    if (was && !will) {
      a.turnSeconds = clockOf(a);
      a.turnStarted = null;
    }
    if (!was && will) {
      a.turnStarted = null;
      a.turnSeconds = null;
    }
    if (a.state != st) a.since = now();
    a.state = st;
  }

  /// One turn feed on its agent (max_ui_model.c turn()); false when the kind says nothing.
  bool _turn(Agent a, String kind, String text, int elapsedS) {
    switch (kind) {
      case 'started':
        // An agent in another app waiting on its app's prompt: the daemon shows the wait as a question (shown only)
        // and as this start's line (devices.ts showWaits). The same wait, so it keeps its question; the close ends it.
        if (a.state == AgentState.asking && asks[a.id]?.path == AskPath.shown) {
          a.activity = text;
          return true;
        }
        _setState(a, AgentState.working);
        a
          ..turnStarted = now()
          ..turnSeconds = null
          ..activity = text
          ..verb = ''
          ..said = '';
        a.steps.clear();
        _dropAsk(a.id);
        return true;
      case 'done':
        if (a.state != AgentState.done) a.said = ''; // the summary that follows says what it did
        _setState(a, AgentState.done);
        _dropAsk(a.id);
        return true;
      case 'error':
        _setState(a, AgentState.failed);
        a.said = text;
        _dropAsk(a.id);
        return true;
    }
    // Progress waits while the agent asks: only turn.started or the question's close ends a question.
    if (a.state == AgentState.asking) return false;
    switch (kind) {
      case 'verb':
        _setState(a, AgentState.working);
        final w = _verbOf(text);
        if (w.isNotEmpty) a.verb = w;
        return true;
      case 'activity':
        _setState(a, AgentState.working);
        // An empty reading says nothing: the daemon sends one when the terminal shows no footer.
        if (text.isNotEmpty) a.activity = text;
        if (elapsedS >= 0 && clockOf(a) != elapsedS) a.turnStarted = now().subtract(Duration(seconds: elapsedS));
        return true;
      case 'step':
        if (text.isEmpty) return false;
        _setState(a, AgentState.working);
        _pushStep(a, text);
        return true;
    }
    return false;
  }

  /// The spinner word without its dots ("Infusing..." reads "Infusing").
  static String _verbOf(String text) {
    var w = text.trim();
    if (w.endsWith('...')) {
      w = w.substring(0, w.length - 3);
    } else if (w.endsWith('…')) {
      w = w.substring(0, w.length - 1);
    }
    return w.trimRight();
  }

  /// A tool step ("Edit · session.ts", or a verb alone): newest last, a repeat moved to the end, the last few kept.
  void _pushStep(Agent a, String text) {
    final at = text.indexOf(' · ');
    final step = at >= 0 ? TurnStep(text.substring(0, at), text.substring(at + 3)) : TurnStep(text, '');
    a.steps.removeWhere((s) => s.verb == step.verb && s.detail == step.detail);
    a.steps.add(step);
    if (a.steps.length > _stepsKept) a.steps.removeRange(0, a.steps.length - _stepsKept);
  }

  /// Takes a question's items: the card starts on its first, nothing chosen.
  void _takeItems(Ask k, List<AskItem> items) {
    k
      ..items = List.of(items)
      ..step = 0
      ..choices = List.filled(items.length, 0);
    if (k.permission && items.isNotEmpty) k.command = commandOf(items[0].q);
  }

  /// A question the bar does not answer shows "Answer it in `<App>`" under its words, so the daemon's own " · answer in
  /// `<App>`" tail goes from them (max_ui_card.c): not twice on one glass. The agent's `said` and Inbox keep the words.
  void _dropTail(Agent a, Ask k) {
    if (takesAnswers(a)) return;
    k.text = dropAnswerTail(k.text);
    k.items = [
      for (final it in k.items)
        AskItem(key: it.key, q: dropAnswerTail(it.q), options: it.options, multi: it.multi, whole: it.whole),
    ];
  }

  /// Reads the question (again) under a new name: the next tick sends it.
  void _startRead(Ask k) {
    k
      ..phase = AskPhase.reading
      ..fetch = 'q${++_askSerial}'
      ..note = '';
    _dues[k.agentId] = _Due(now());
  }

  void _dropAsk(String id) {
    asks.remove(id);
    _askKeys.remove(id);
    _dues.remove(id);
  }

  /// Answered, here or elsewhere: the turn and its clock go on (the state is set as it is, its time kept).
  void _answered(Agent a) {
    _dropAsk(a.id);
    a
      ..state = AgentState.working
      ..said = '';
    _dirty = true;
  }

  /// Puts a page up; leaving Inbox marks every notice read, and "Mic closed" belongs to the page it closed on.
  void _show(BarPage p) {
    if (p != BarPage.attention && attention != null) {
      attention = null;
      _dirty = true;
    }
    if (page == p) return;
    if (page == BarPage.inbox) {
      for (final n in inbox) {
        n.unread = false;
      }
    }
    if (talk == TalkPhase.closed) talk = TalkPhase.off;
    page = p;
    _dirty = true;
  }

  void _showAgent(String id) {
    if (selectedId != id && talk == TalkPhase.closed) talk = TalkPhase.off;
    selectedId = id;
    _show(BarPage.agent);
    _dirty = true;
  }

  /// The agent still is what Attention or the toast announced (asking, done, failed).
  bool _holds(String id, AttnKind? kind) {
    final a = agentById(id);
    if (a == null) return false;
    return switch (kind) {
      AttnKind.ask => a.state == AgentState.asking,
      AttnKind.done => a.state == AgentState.done,
      AttnKind.failed => a.state == AgentState.failed,
      null => true,
    };
  }

  void _attention(String id, AttnKind kind) {
    attention = Attention(agentId: id, kind: kind, since: now());
    if (toast?.agentId == id) toast = null; // what it announced is up now
    _show(BarPage.attention);
    _dirty = true;
  }

  /// An agent that asks with no answer on its way waits for a person.
  bool _waits(Agent a) {
    if (a.state != AgentState.asking) return false;
    final k = asks[a.id];
    return k == null || (k.phase != AskPhase.sending && k.phase != AskPhase.sent);
  }

  /// The question that has waited longest (but `except`'s) takes Attention; with none, Overview.
  void _nextQuestion(String except) {
    Agent? best;
    for (final a in agents) {
      if (!_waits(a) || a.id == except) continue;
      if (best == null || _askSince(a).isBefore(_askSince(best))) best = a;
    }
    if (best != null) {
      _attention(best.id, AttnKind.ask);
    } else {
      _show(BarPage.overview);
    }
  }

  DateTime _askSince(Agent a) => asks[a.id]?.since ?? a.since;

  /// An event that needs the person (max_attend): an unread notice always; Attention, unless a person talks (then the
  /// toast and the bell only) or another agent's question holds it (this one waits its turn, a turn's end stays in
  /// Inbox).
  void _attend(Agent a, AttnKind kind) {
    _idleFrom = now();
    _inboxAdd(a, kind);
    if (kind == AttnKind.done) {
      // A finished turn never takes the glass (the owner's call, 18 Nov): the small note at the bottom right, over
      // whatever is up, talk or not; its notice stays unread in Inbox.
      doneNote = Toast(a.said, until: now().add(kDoneNoteFor), agentId: a.id, kind: AttnKind.done);
      _dirty = true;
      return;
    }
    if (talk == TalkPhase.listening || talk == TalkPhase.sending) {
      final why = switch (kind) { AttnKind.ask => 'asks', AttnKind.done => 'is done', AttnKind.failed => 'failed' };
      toast = Toast(a.said.isEmpty ? '${a.name} $why' : '${a.name} $why · ${a.said}',
          until: now().add(kToastFor), agentId: a.id, kind: kind);
      if (page == BarPage.ambient) _show(BarPage.overview);
      _dirty = true;
      return;
    }
    final at = attention;
    if (page == BarPage.attention &&
        at != null &&
        at.kind == AttnKind.ask &&
        at.agentId != a.id &&
        _holds(at.agentId, AttnKind.ask)) {
      return;
    }
    _attention(a.id, kind);
  }

  /// The notice's words: the question, or what the turn said. The same notice again (a question re-sent after the link
  /// came back) moves up, unread again, instead of filing twice.
  void _inboxAdd(Agent a, AttnKind kind) {
    final text = a.said;
    final j = inbox.indexWhere((n) => n.kind == kind && n.agentId == a.id && n.text == text);
    if (j >= 0) {
      inbox.removeAt(j);
    } else if (inbox.length >= kInboxMax) {
      inbox.removeLast(); // full: the oldest goes
    }
    inbox.insert(
        0,
        Notice(
            agentId: a.id,
            name: a.name,
            engine: a.engine,
            app: appOf(a), // kept: the agent may leave the ring before it is read
            kind: kind,
            text: text,
            at: now()));
    _dirty = true;
  }

  /// A failure that came without words: its summary fills the newest notice of it.
  void _inboxWords(Agent a) {
    final i = inbox.indexWhere((n) => n.kind == AttnKind.failed && n.agentId == a.id);
    if (i < 0 || inbox[i].text.isNotEmpty) return;
    final n = inbox[i];
    inbox[i] = Notice(
        agentId: n.agentId,
        name: n.name,
        engine: n.engine,
        app: n.app,
        kind: n.kind,
        text: a.said,
        at: n.at,
        unread: n.unread);
    _dirty = true;
  }

  /// Overview with nothing working or waiting and nobody talking: Ambient comes [kAmbientAfter] after the last touch or
  /// news.
  bool _ambientWaits() =>
      page == BarPage.overview &&
      (talk == TalkPhase.off || talk == TalkPhase.closed) &&
      !agents.any((a) => _running(a.state));

  /// The page follows what it shows: Attention whose agent moved on gives way to the next question (else Overview), a
  /// turn's end goes after [kAttentionEnd], the agent page goes with its agent, and an idle Overview turns Ambient.
  void _settle() {
    final at = attention;
    if (page == BarPage.attention) {
      if (at == null || !_holds(at.agentId, at.kind)) {
        _nextQuestion(at?.agentId ?? '');
      } else if (at.kind != AttnKind.ask && !now().isBefore(at.since.add(kAttentionEnd))) {
        _show(BarPage.overview);
      }
    } else if (page == BarPage.agent && selected == null) {
      _show(BarPage.overview);
    }
    if (_ambientWaits() && !now().isBefore(_idleFrom.add(kAmbientAfter))) _show(BarPage.ambient);
    final m = !connected
        ? AmbientMood.notConnected
        : agents.isEmpty
            ? AmbientMood.noAgents
            : AmbientMood.quiet;
    if (m != mood) {
      mood = m;
      _dirty = true;
    }
  }

  /// The app the person picked on Apps, until the daemon turns to it: that turn is theirs, not news.
  String _picked = '';

  void _notice(String text) {
    toast = Toast(text, until: now().add(kNoticeFor));
    _dirty = true;
  }

  /// The person brings the agent up on the computer (the daemon turns to its app), and the bar says where.
  void _bringUp(String id, String name, String app) {
    _notice(app.isNotEmpty ? '$name is up in $app' : '$name is up');
    _show(BarPage.overview);
    link.openAgent(id);
    _publish();
  }

  // ---- the talk ----

  /// The bar may record for this agent now: the link is up, nothing is recorded or sent, and the agent is neither on a
  /// permission prompt (Allow or Deny only) nor waiting on an answer that is on its way or in. Whether the agent takes
  /// voice at all is [takesVoice].
  bool _canTalk(Agent a) {
    if (!connected || (talk != TalkPhase.off && talk != TalkPhase.closed)) return false;
    final k = a.state == AgentState.asking ? asks[a.id] : null;
    return k == null || (!k.permission && k.phase != AskPhase.sending && k.phase != AskPhase.sent);
  }

  void _listenTo(Agent a) {
    _talkId = a.id;
    _setTalk(TalkPhase.listening);
  }

  void _setTalk(TalkPhase p) {
    if (talk == p) return;
    if (p == TalkPhase.listening) {
      // A new recording: its clock, and nothing heard yet.
      talkStarted = now();
      _quietFrom = talkStarted;
      heard = false;
      quiet = 0;
      levels.clear();
    }
    talk = p;
    _dirty = true;
  }

  void _updateQuiet() {
    final from = _quietFrom;
    final q = heard && from != null
        ? (now().difference(from).inMicroseconds / kSilenceSend.inMicroseconds).clamp(0.0, 1.0)
        : 0.0;
    if (q != quiet) {
      quiet = q;
      _dirty = true;
    }
  }

  /// What was recorded goes, and the toast names who to. Returns the link's call, made once the model has settled.
  void Function() _sendTalk() {
    final id = _talkId;
    if (id != null) {
      final a = agentById(id);
      _notice(a != null ? 'Sent to ${a.name}' : 'Sent');
    }
    _setTalk(TalkPhase.sending);
    return () => link.sendTalk();
  }

  /// Sent by a tap or by the clock: words to an agent that asked are its answer, so the question waiting longest takes
  /// the glass, as after a tapped answer; else Overview.
  void Function() _sendOnward() {
    final a = agentById(_talkId);
    if (a != null && a.state == AgentState.asking) {
      _nextQuestion(a.id);
    } else if (_talkId != null) {
      _show(BarPage.overview);
    }
    return _sendTalk();
  }

  /// The person moved on while it recorded (Back, the strip, a swipe, its agent gone): what was heard goes, else
  /// nothing.
  void Function() _settleTalk() {
    if (heard) return _sendTalk();
    _setTalk(TalkPhase.off);
    return () => link.cancelTalk();
  }

  /// While the mic is open the page is its send: any tap that is not X, Back, the strip or a swipe sends it now, and
  /// does nothing else (C recording_tap).
  bool _sendsFirst() {
    if (talk != TalkPhase.listening) return false;
    _sendOnward()();
    _publish();
    return true;
  }

  /// The clock's side of a recording: speech then quiet sends it, nothing heard closes the mic (the page stays), and
  /// an agent gone from the ring takes its page with it.
  void Function()? _talkDue() {
    if (talk != TalkPhase.listening) return null;
    final id = _talkId;
    if (id != null && agentById(id) == null) {
      // Its page went with it. Only that page: a ring that emptied has put Ambient up, and an empty Overview is not
      // where the person was.
      if (page == BarPage.agent) _show(BarPage.overview);
      return _settleTalk();
    }
    final t = now();
    if (heard) {
      final from = _quietFrom ?? t;
      return t.isBefore(from.add(kSilenceSend)) ? null : _sendOnward();
    }
    final from = talkStarted ?? t;
    if (t.isBefore(from.add(kHearTimeout))) return null;
    _notice('Mic closed · tap to talk');
    _setTalk(TalkPhase.closed);
    return () => link.cancelTalk();
  }

  // ---- answering ----

  /// The reads the clock owes now, and the receipts overdue: three reads 2 s apart, then the card says there was no
  /// reply; an answer whose receipt never came fails, never sent again (the daemon takes one answer a token).
  List<Ask> _asksDue() {
    final reads = <Ask>[];
    final t = now();
    for (final k in asks.values) {
      final reviewedSending = k.phase == AskPhase.sending && k.path == AskPath.reviewed;
      if (k.phase != AskPhase.reading && !reviewedSending) continue;
      // A question set up by hand (fixtures) has no clock yet: it starts from now.
      final d = _dues.putIfAbsent(k.agentId, () => _Due(reviewedSending ? t.add(kReceiptWait) : t));
      if (t.isBefore(d.at)) continue;
      if (reviewedSending) {
        k
          ..phase = AskPhase.failed
          ..note = 'No reply. Check the terminal.';
        _dirty = true;
      } else if (d.reads >= kReadTries) {
        k
          ..phase = AskPhase.failed
          ..note = 'No reply. Check Harness on your computer.';
        _dirty = true;
      } else {
        d
          ..reads += 1
          ..at = t.add(kReadEvery);
        reads.add(k);
      }
    }
    return reads;
  }

  /// The card on Attention, when the bar answers it: its agent and its question.
  (Agent, Ask)? _card() {
    final at = attention;
    if (page != BarPage.attention || at == null || at.kind != AttnKind.ask) return null;
    final a = agentById(at.agentId);
    final k = asks[at.agentId];
    if (a == null || k == null || a.state != AgentState.asking || !takesAnswers(a) || k.step >= k.items.length) {
      return null;
    }
    if (k.choices.length != k.items.length) k.choices = List.filled(k.items.length, 0);
    return (a, k);
  }

  void _permit(bool yes) {
    touched();
    if (_sendsFirst()) return;
    final card = _card();
    if (card == null) return;
    final (a, k) = card;
    // Without both a yes and a no there are no Allow and Deny: its options answer as they are.
    final pair = k.permission && k.phase == AskPhase.ready ? allowDeny(k.items[k.step]) : null;
    if (pair == null) return;
    k.choices[k.step] = 1 << (yes ? pair.allow : pair.deny);
    _advance(a, k);
  }

  /// The question answered: the next one of the request, or the answer goes.
  void _advance(Agent a, Ask k) {
    if (k.step + 1 < k.items.length) {
      k.step++;
      _dirty = true;
      _publish();
      return;
    }
    _submit(a, k);
  }

  void _submit(Agent a, Ask k) {
    final void Function() call;
    if (k.path == AskPath.reviewed) {
      // Under the read's token and name; the receipt ends it, refuses it, or is overdue after kReceiptWait.
      k.phase = AskPhase.sending;
      _dues[a.id] = _Due(now().add(kReceiptWait));
      final token = k.token, fetch = k.fetch, choices = List.of(k.choices);
      call = () => link.answerReviewed(a.id, token, fetch, choices);
    } else {
      // A plain answer has no receipt: handed to the link, it is sent. Each key with its chosen options, joined as the
      // daemon joins a multi-select.
      final answers = <String, String>{
        for (var i = 0; i < k.items.length; i++)
          k.items[i].key ?? '': [
            for (var j = 0; j < k.items[i].options.length; j++)
              if (k.choices[i] & (1 << j) != 0) k.items[i].options[j],
          ].join(', '),
      };
      k
        ..phase = AskPhase.sent
        ..note = '';
      _notice('Sent');
      final requestId = k.requestId;
      call = () => link.answer(a.id, requestId, answers);
    }
    _dirty = true;
    // Answered on Attention: the question that has waited longest takes it, else Overview.
    if (page == BarPage.attention && attention?.agentId == a.id) _nextQuestion(a.id);
    call();
    _publish();
  }
}
