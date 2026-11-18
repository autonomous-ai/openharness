// The bar's vocabulary: what the daemon tells it (rows, questions) and what its pages read (agents, notices, the talk).
// Plain data, no Flutter: the model, the cable, the demo and the pages all speak it.

/// An agent's state as the pages draw it: the rail's colour, the status word, the pet's scene.
enum AgentState { idle, working, asking, done, failed }

/// What an agent lets the bar do with it, from the daemon's `caps` letters ("svfa"; left out = all four).
class Caps {
  const Caps({this.status = true, this.voice = true, this.focus = true, this.answer = true});

  /// The daemon's letters: s status, v voice, f focus, a answer. Null (left out) reads as all four.
  factory Caps.of(String? letters) => letters == null
      ? const Caps()
      : Caps(
          status: letters.contains('s'),
          voice: letters.contains('v'),
          focus: letters.contains('f'),
          answer: letters.contains('a'));

  final bool status, voice, focus, answer;
}

/// One step of a working turn, as the agent page's row of steps shows it ("Editing" · "session.ts").
class TurnStep {
  const TurnStep(this.verb, this.detail, {this.think = false});
  final String verb, detail;

  /// A thinking step (the mockup's `k:'think'`): drawn in the lavender accent.
  final bool think;
}

/// An agent of the shown app's ring, in the ring's own order. The model owns and mutates it; pages only read it.
class Agent {
  Agent({
    required this.id,
    required this.name,
    this.engine = 'claude',
    this.host = '',
    this.caps = const Caps(),
    this.state = AgentState.idle,
    this.verb = '',
    this.activity = '',
    List<TurnStep>? steps,
    this.said = '',
    DateTime? since,
    this.turnStarted,
    this.turnSeconds,
  })  : steps = [...?steps], // its own list: the model adds and drops steps, whatever list it was made with
        since = since ?? DateTime.fromMillisecondsSinceEpoch(0);

  final String id;
  String name;

  /// "claude", "codex", or another engine (drawn with the Muse pet and the engine's own name).
  String engine;

  /// Its app's id ("" when the daemon sent none).
  String host;
  Caps caps;
  AgentState state;

  /// Working: the spinner word ("Thinking"); the status word on Overview and the large word on the agent page.
  String verb;

  /// Working: the progress sentence under the spinner word.
  String activity;

  /// Working: the turn's steps, oldest first; the page shows the last three.
  final List<TurnStep> steps;

  /// The last words worth reading: the summary of a finished turn, the open question, or the failure. "" = none.
  String said;

  /// When its state last changed: the agent page's "Done · 2m ago".
  DateTime since;

  /// Working or asking: when the turn started (the turn's clock), null when unknown.
  DateTime? turnStarted;

  /// A finished turn's final length in seconds, null when unknown.
  int? turnSeconds;
}

/// One app the daemon lists (`apps` frame): its agents and how many of them wait on the person.
class AppInfo {
  const AppInfo({required this.id, required this.name, this.count = 0, this.waiting = 0});
  final String id, name;
  final int count, waiting;
}

/// How an open question can be answered.
/// - [computer]: only on the computer (no inbox questions, or words too long to echo).
/// - [shown]: shown only, answered in the agent's own app ([Ask.app]).
/// - [plain]: a plain `answer` from the bar.
/// - [reviewed]: read (`question.read`), then `answer.reviewed` by option indexes.
enum AskPath { computer, shown, plain, reviewed }

/// Answering a question: [reading] its state (reviewed path), [ready] for the person, [sending] the answer,
/// [sent] (taken), or [failed] ([Ask.note] says why).
enum AskPhase { reading, ready, sending, sent, failed }

/// One question of a request, as the daemon's inbox holds it.
class AskItem {
  const AskItem({required this.key, required this.q, required this.options, this.multi = false, this.whole = true});

  /// Null when too long to echo (then no plain answer).
  final String? key;
  final String q;
  final List<String> options;
  final bool multi, whole;
}

/// An open question of an agent.
class Ask {
  Ask({
    required this.agentId,
    required this.requestId,
    required this.text,
    this.items = const [],
    this.permission = false,
    this.command = '',
    this.path = AskPath.computer,
    this.app = '',
    DateTime? since,
  }) : since = since ?? DateTime.fromMillisecondsSinceEpoch(0);

  final String agentId, requestId;

  /// The prompt as shown (a shown-only question's " · answer in `<App>`" tail already dropped).
  String text;
  List<AskItem> items;

  /// A permission prompt: Allow / Deny, never voice.
  bool permission;

  /// A permission prompt's command, drawn in mono ("" when none).
  String command;
  AskPath path;

  /// [AskPath.shown]: the app to answer it in.
  String app;

  /// When it arrived: Attention takes the oldest first.
  DateTime since;

  /// Where answering it stands, and the line that says so ([AskPhase.failed]: why; [AskPhase.sent]: the receipt).
  AskPhase phase = AskPhase.ready;
  String note = '';

  /// A request of several questions: the one on the card, and an option mask per question.
  int step = 0;
  List<int> choices = [];

  /// [AskPath.reviewed]: question.state's token and the read's own request id.
  String token = '';
  String fetch = '';

  /// The bar may answer it (the agent has caps `a` and the path is plain or reviewed).
  bool get answerable => path == AskPath.plain || path == AskPath.reviewed;
}

/// Why an agent takes the glass (Attention) or files a notice.
enum AttnKind { ask, done, failed }

/// Attention: who needs the person, and why.
class Attention {
  const Attention({required this.agentId, required this.kind, required this.since});
  final String agentId;
  final AttnKind kind;
  final DateTime since;
}

/// A notice in Inbox, kept after its agent leaves the ring.
class Notice {
  Notice({
    required this.agentId,
    required this.name,
    required this.engine,
    required this.app,
    required this.kind,
    required this.text,
    required this.at,
    this.unread = true,
  });
  final String agentId, name, engine, app;
  final AttnKind kind;
  final String text;
  final DateTime at;
  bool unread;
}

/// The page on the glass.
enum BarPage { overview, agent, attention, inbox, apps, ambient }

/// Why Ambient is up: all quiet, no computer on the cable, or no agents yet.
enum AmbientMood { quiet, notConnected, noAgents }

/// The mic on the agent page.
/// - [off]: closed, never opened on this page ("Tap to talk").
/// - [listening]: recording ("● Listening", the waveform, the quiet ring).
/// - [sending]: the recording is out to the computer.
/// - [closed]: nothing was heard in 4 s; the page stays ("Mic closed · tap to talk").
enum TalkPhase { off, listening, sending, closed }

/// The toast at the bar's foot: a line, and optionally the agent a tap on it opens in Attention.
class Toast {
  const Toast(this.text, {required this.until, this.agentId, this.kind});
  final String text;
  final DateTime until;
  final String? agentId;

  /// With [agentId]: why it needs the person (its colour, and the Attention a tap opens). It holds only while the agent
  /// still is what it announced.
  final AttnKind? kind;
}

// ---- what the daemon sends (the cable decodes frames into these; the demo makes them) ----

/// One agent of the ring (`agents` frame), as pro_agent_row_t.
class AgentRow {
  const AgentRow({required this.id, required this.name, this.engine = '', this.host = '', this.caps});
  final String id, name, engine, host;

  /// The daemon's letters, null when left out (all four).
  final String? caps;
}

/// How loud a finished turn is (the summary frame's `tier`).
enum SummaryTier { alert, list, silent }
