// The scripted demo: a computer with three apps and their agents, inside the program. It plays
// devices/harness-max/firmware/main/demo/max_demo.c's story (demo_script.dart) at the event level: what the cable would
// decode from the daemon's frames goes straight into the model's inputs, and the model's calls are answered as the
// daemon answers them, a tick later, in the order they came.
import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../link/bar_link.dart';
import '../link/mic.dart';
import '../model/bar_model.dart';
import '../model/types.dart';
import 'demo_clock.dart';
import 'demo_script.dart';

/// A person's last touch holds the story this long.
const int kQuietMs = 60000;

/// Story time an unanswered question waits before it is answered on the computer, with its first option...
const int kUnattendedMs = 40000;

/// ...and one the bar only shows: nobody can answer it there, so its app does sooner.
const int kShownWaitMs = 12000;

/// From an answer to its question closing (the agent taking it).
const int kCloseMs = 1000;

/// From a tap that brings up another app's question to the person answering it there.
const int kOutsideMs = 6000;

/// From a send to the words reaching the agent: the computer transcribes.
const int kTranscribeMs = 600;

/// From New Harness to its agent arriving, and from there to the agent starting.
const int kCreateMs = 1500;
const int kFirstTurnMs = 500;

/// A host that stalled does not fast-forward the story through the stall: a tick moves the story at most this far...
const int kStepCapMs = 10000;

/// ...and the demo ticks at least this often, so the cap never cuts a gap the story meant.
const int kTickMs = 1000;

/// The most agents the computer runs: New Harness says so past it. The cast's eleven and three more, the room the
/// story's nine had.
const int kMaxAgents = 14;

/// Made-up levels with no mic: 20 a second, speech-like for 2.2 s, then near silence, so the model hears speech and
/// then sends by itself. A recording the model never ends is fed no longer than [kTalkMaxMs].
const int kLevelMs = 50;
const int kSpeechMs = 2200;
const int kTalkMaxMs = 60000;

enum _Ask { none, open, taken }

/// An agent on the demo's computer.
class _Agent {
  _Agent(this.id, this.name, this.engine, this.app, {this.made = false, this.recap = '', this.text = ''});
  final String id, name, engine;
  final int app;

  /// Started with New Harness: it leaves when the story starts over, so the next person finds the same nine.
  final bool made;

  /// The turn playing (null between turns), its next beat, and when that plays.
  List<Beat>? turn;
  int beat = 0, beatAt = 0, startedAt = 0;

  /// What the turn last said, told again when the bar is turned back to this agent's ring.
  String status = '', verb = '', sentence = '';

  /// The question open, or answered and about to close.
  Question? question;
  _Ask ask = _Ask.none;
  int choice = 0, serial = 0, askedStory = 0, closeAt = 0;

  /// The last summary: the history its ring brings back.
  String recap, text;

  /// A person's words, waiting for the agent to be free.
  Spoken? said;
  int saidAt = 0;

  /// The manual demo: words that started a turn, so an agent with a case ([kCase]) knows which comes next.
  int talks = 0;

  bool get idle => turn == null && ask == _Ask.none && said == null;
  DemoApp get home => kApps[app];
  bool can(String cap) => home.caps.contains(cap);
}

class DemoLink implements BarLink {
  DemoLink(this.model, {this.mic, DemoClock? clock, this.manual = false}) : clock = clock ?? RealDemoClock() {
    for (final c in kCast) {
      _agents.add(_Agent(c.id, c.name, c.engine, c.app, recap: c.recap, text: c.text));
    }
  }

  final BarModel model;
  final Mic? mic;
  final DemoClock clock;

  /// A person drives it: every agent rests at the start, the bar on Ambient, and nothing happens by itself (no story,
  /// no front change, no answer for the person, no telling again). Every case comes from words said at the bar
  /// ([kCase]).
  final bool manual;

  /// In the daemon's list order: the cast first (they never move), then the agents New Harness made.
  final List<_Agent> _agents = [];

  bool _started = false, _stopped = false;
  DemoTimer? _wake;
  int _wakeAt = 0;

  /// Inputs answering the model's calls, given at the next tick: never inside the call that asked.
  final List<void Function()> _replies = [];

  // The story: where it is in a telling, what comes next, and story time in all (it stands still while a person is
  // at the bar).
  int _storyPos = 0, _storyTotal = 0, _nextEntry = 0, _nextFront = 1, _lastTick = 0;

  /// The app in front on the computer, and the one whose ring the bar is shown. The story opens with its first app in
  /// both, so that front change is already played.
  int _front = kFront.first.app, _shown = kFront.first.app;

  /// A person's last touch at the bar (none yet: a quiet minute before the start).
  int _personAt = -kQuietMs;
  int _serial = 0;

  bool _ringOwed = false;

  /// The ring the bar was last given: the model drops the agents that leave it.
  Set<String> _ring = {};
  String _appsKey = '';

  int? _createAt;
  int _made = 0;

  /// The recording open, and which: a call about an older one finds a newer serial.
  _Agent? _talking;
  int _talkSerial = 0;
  bool _micOpen = false;
  StreamSubscription<double>? _levels;
  StreamSubscription<Uint8List>? _pcm;
  DemoTimer? _speech;

  /// Recordings sent and being transcribed, oldest first.
  final List<({_Agent agent, int at})> _heard = [];

  bool get _live => _started && !_stopped;
  int get _now => clock.nowMs;

  // ---- the link ----

  @override
  Future<void> start() async {
    if (_started) return;
    _started = true;
    _lastTick = _now; // the story counts from the greeting
    model.onLink(true, computer: kComputer, offersNew: true);
    _ringOwed = true;
    _tick();
    // All quiet on the person's demo from the first moment, not a quiet minute later; its first tap shows every app.
    if (manual) model.restNow(wakeToApps: true);
  }

  @override
  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _wake?.cancel();
    _wake = null;
    _replies.clear();
    await _endRecording();
  }

  @override
  void openAgent(String agentId) {
    if (!_live) return;
    _touched();
    final a = _find(agentId);
    if (a == null) return;
    // Its window comes up on the computer, so its app comes to the front, and the bar is shown that app's ring.
    _front = a.app;
    if (a.app != _shown) _show(a.app);
    // Brought up in its own app, where the person answers what the bar could only show.
    if (a.ask == _Ask.open && !a.can('a')) _taken(a, 0, kOutsideMs);
    _soon();
  }

  /// cableSession.ts app.pick: another app with agents is shown until the next front change; one with none, or not
  /// listed, is told the list again; the app already shown changes nothing.
  @override
  void pickApp(String appId) {
    if (!_live) return;
    _touched();
    final app = kApps.indexWhere((a) => a.id == appId);
    if (app < 0 || _count(app) == 0) {
      _reply(_pushApps);
    } else if (app != _shown) {
      _show(app);
      _soon();
    }
  }

  /// The older answer: the label chosen, by the key asked with, for the question named by requestId. No receipt; an
  /// agent the bar may not answer gets the daemon's toast instead.
  @override
  void answer(String agentId, String requestId, Map<String, String> answers) {
    if (!_live) return;
    _touched();
    final a = _find(agentId);
    if (a == null) return;
    if (!a.can('a')) {
      final line = requestId.startsWith('shown:')
          ? 'Answer it in ${a.home.name}.'
          : 'This agent is in ${a.home.name}. Answering it from the device comes in an update.';
      _reply(() => model.onToast(line));
      return;
    }
    final q = a.question;
    if (q == null || a.ask != _Ask.open || _questionId(a) != requestId) return;
    final option = q.options.indexOf(answers[q.q] ?? '');
    if (option < 0) return;
    _taken(a, option, kCloseMs);
    _soon();
  }

  @override
  void questionRead(String agentId, String requestId, String fetch) {
    if (!_live) return;
    // No touch: the bar reads every question the moment it arrives, so a read says nobody is at the bar.
    final a = _find(agentId);
    if (a == null || a.ask == _Ask.none) {
      _reply(() => model.onQuestionState(agentId, fetch, ok: false, error: 'No readable question. Check the terminal.'));
      return;
    }
    // As the daemon writes it: what it holds when the read comes.
    final id = _questionId(a), token = _token(a), items = _items(a), submitted = a.ask == _Ask.taken;
    _reply(() => model.onQuestionState(agentId, fetch,
        ok: true, requestId: id, token: token, submitted: submitted, items: items));
  }

  @override
  void answerReviewed(String agentId, String token, String fetch, List<int> choices) {
    if (!_live) return;
    _touched();
    final a = _find(agentId);
    final refusal = _refusal(a, token, choices);
    if (refusal == null && a != null && a.ask == _Ask.open) _taken(a, _bit(choices.single, a.question!), kCloseMs);
    // This computer takes it at once: never `pending`, which is another machine's.
    _reply(() => model.onAnswerReceipt(agentId, fetch, ok: refusal == null, token: token, error: refusal ?? ''));
  }

  @override
  void startTalk(String agentId) {
    if (!_live) return;
    _touched();
    // A new recording ends the one before it; one already sent is still transcribed.
    unawaited(_endRecording());
    final a = _find(agentId);
    final refusal = a == null
        ? 'Could not reach that harness. Check its connection and try again.'
        : !a.can('v')
            ? 'This agent is in ${a.home.name}. Talking to it from the device comes in an update.'
            : null;
    if (refusal != null) {
      _reply(() {
        model.onToast(refusal);
        _idleWhenDone();
      });
      return;
    }
    _talking = a;
    final serial = _talkSerial;
    _reply(() {
      if (serial != _talkSerial) return; // ended before it began
      model.onTalkLink(TalkLink.recording);
      _listen(serial);
    });
  }

  @override
  void sendTalk() {
    if (!_live) return;
    final a = _talking;
    if (a == null) return;
    _touched();
    unawaited(_endRecording());
    _heard.add((agent: a, at: _now + kTranscribeMs));
    _reply(() => model.onTalkLink(TalkLink.sending));
  }

  @override
  void cancelTalk() {
    if (!_live) return;
    _touched();
    unawaited(_endRecording());
    _reply(_idleWhenDone);
  }

  /// New Harness opens its window on the computer, where the person starts an agent: a moment later it arrives.
  @override
  void newHarness() {
    if (!_live) return;
    _touched();
    _createAt ??= _now + kCreateMs;
    _soon();
  }

  // ---- the clock ----

  void _reply(void Function() input) {
    _replies.add(input);
    _soon();
  }

  /// A tick now, unless one is already set for now.
  void _soon() {
    if (!_live || (_wake != null && _wakeAt <= _now)) return;
    _setWake(_now);
  }

  void _setWake(int at) {
    _wake?.cancel();
    _wakeAt = at;
    _wake = clock.at(at, _tick);
  }

  void _tick() {
    if (!_live) return;
    _wake = null;
    final now = _now;
    // The replies first, in the order they were written.
    final replies = List.of(_replies);
    _replies.clear();
    for (final reply in replies) {
      reply();
    }
    _hear(now);
    final createAt = _createAt;
    if (createAt != null && now >= createAt) _create();
    final from = _storyFrom();
    if (!manual && now > from) _advanceStory(min(now - from, kStepCapMs));
    _lastTick = now;
    for (final a in _agents) {
      _run(a, now);
    }
    if (_ringOwed) _pushRing();
    // A count, a waiting count or the shown app changed with no ring to carry it: `apps` alone.
    if (_appsKeyNow() != _appsKey) _pushApps();
    _setWake(_next(now));
  }

  /// When the demo next has something to do (max_demo_next_ms).
  int _next(int now) {
    if (_replies.isNotEmpty || _ringOwed) return now;
    var best = now + kTickMs;
    void soon(int at) => best = min(best, at);
    for (final h in _heard) {
      soon(h.at);
    }
    final createAt = _createAt;
    if (createAt != null) soon(createAt);
    for (final a in _agents) {
      if (a.ask == _Ask.taken) {
        soon(a.closeAt);
      } else if (a.turn != null && a.ask == _Ask.none) {
        soon(a.beatAt);
      } else if (a.turn == null && a.said != null) {
        soon(a.saidAt);
      }
    }
    if (!manual) soon(_storyFrom() + _storyWait());
    return max(best, now);
  }

  // ---- the story ----

  void _touched() => _personAt = _now;

  /// Where story time last counted to: it does not count while a person is at the bar, nor for a quiet minute after.
  int _storyFrom() => max(_lastTick, _personAt + kQuietMs);

  /// Story milliseconds until the story next does something by itself.
  int _storyWait() {
    var wait = kCycleMs - _storyPos;
    if (_nextEntry < kStory.length) wait = min(wait, kStory[_nextEntry].at - _storyPos);
    if (_nextFront < kFront.length) wait = min(wait, kFront[_nextFront].at - _storyPos);
    for (final a in _agents) {
      if (a.ask == _Ask.open) wait = min(wait, max(0, _unattended(a) - (_storyTotal - a.askedStory)));
    }
    return wait;
  }

  void _advanceStory(int dt) {
    _storyTotal += dt;
    _storyPos += dt;
    for (;;) {
      for (; _nextEntry < kStory.length && _storyPos >= kStory[_nextEntry].at; _nextEntry++) {
        final entry = kStory[_nextEntry];
        final a = _agents[entry.agent];
        if (a.idle) _startTurn(a, entry.turn, 0); // busy with a person's words: skipped this time
      }
      for (; _nextFront < kFront.length && _storyPos >= kFront[_nextFront].at; _nextFront++) {
        _toFront(kFront[_nextFront].app);
      }
      if (_storyPos < kCycleMs) break;
      _storyPos -= kCycleMs;
      _nextEntry = 0;
      _nextFront = 0;
      _forgetMade();
    }
    // Nobody at the bar to answer: it is answered on the computer, with the first option.
    for (final a in _agents) {
      if (a.ask == _Ask.open && _storyTotal - a.askedStory >= _unattended(a)) {
        a.choice = 0;
        _takeAnswer(a);
      }
    }
  }

  int _unattended(_Agent a) => a.can('a') ? kUnattendedMs : kShownWaitMs;

  /// The app in front changed and its settle is over: it ends a pick on the bar, and the bar is shown it when it has
  /// agents and is not shown already.
  void _toFront(int app) {
    if (app == _front) return;
    _front = app;
    if (app != _shown && _count(app) > 0) _show(app);
  }

  void _show(int app) {
    _shown = app;
    _ringOwed = true;
  }

  void _forgetMade() {
    final before = _agents.length;
    _agents.removeWhere((a) => a.made && a.idle);
    if (_agents.length != before) _ringOwed = true;
  }

  // ---- turns ----

  void _beginBeats(_Agent a, List<Beat> turn, int delay) {
    a.turn = turn;
    a.beat = 0;
    a.beatAt = _now + delay + turn.first.wait * 100;
  }

  void _startTurn(_Agent a, List<Beat> turn, int delay) {
    _beginBeats(a, turn, delay);
    a.startedAt = _now + delay;
    a.status = a.verb = a.sentence = '';
  }

  void _endTurn(_Agent a) {
    a.turn = null;
    a.question = null;
    a.ask = _Ask.none;
    // Words said while it was busy go next, after a breath.
    if (a.said != null) a.saidAt = max(a.saidAt, _now + 1000);
  }

  void _run(_Agent a, int now) {
    final said = a.said;
    if (a.turn == null && a.ask == _Ask.none && said != null && now >= a.saidAt) {
      a.said = null;
      _startTurn(a, said.turn, 0);
    }
    if (a.ask == _Ask.taken && now >= a.closeAt) _takeAnswer(a);
    // Bounded: beats with no wait between them all go now, and the guard stops a list that never waits.
    for (var guard = 0; guard < 16 && a.turn != null && a.ask == _Ask.none && now >= a.beatAt; guard++) {
      _play(a, now);
    }
  }

  /// One beat, as the cable decodes the daemon's frame for it (pro_cable.c): turn.activity is the spinner word, then the
  /// sentence with the clock, then the tool card.
  void _play(_Agent a, int now) {
    final turn = a.turn!;
    final b = turn[a.beat];
    switch (b.kind) {
      case BeatKind.start:
        a.status = b.text;
        model.onTurn(a.id, 'started', b.text);
      case BeatKind.act:
        a.verb = b.text;
        model.onTurn(a.id, 'verb', b.text);
        if (b.sentence.isNotEmpty) a.sentence = b.sentence;
        if (b.sentence.isNotEmpty || b.timer) {
          model.onTurn(a.id, 'activity', b.sentence, elapsedS: b.timer ? (now - a.startedAt) ~/ 1000 : -1);
        }
      case BeatKind.step:
        model.onTurn(a.id, 'step', b.text);
      case BeatKind.ask:
        a.beat++;
        _ask(a, b.question!);
        return;
      case BeatKind.done:
        model.onTurn(a.id, 'done', '');
        model.onSummary(a.id, b.text, recap: b.recap, tier: b.tier);
        a.recap = b.recap;
        a.text = b.text;
        _endTurn(a);
        return;
      case BeatKind.fail:
        model.onTurn(a.id, 'error', b.text);
        _endTurn(a);
        return;
    }
    a.beat++;
    if (a.beat < turn.length) {
      a.beatAt = now + turn[a.beat].wait * 100;
    } else {
      _endTurn(a);
    }
  }

  // ---- questions ----

  void _ask(_Agent a, Question q) {
    a.question = q;
    a.ask = _Ask.open;
    a.serial = ++_serial;
    a.askedStory = _storyTotal;
    _sendQuestion(a);
  }

  void _sendQuestion(_Agent a) {
    final items = _items(a);
    model.onQuestion(a.id, _questionId(a), items.first.q,
        items: items,
        // A shown-only question is never a permission.
        permission: a.question!.permission && a.can('a'),
        // The daemon offers the reviewed path (its welcome's question.review), as the cable tells the model.
        review: true);
  }

  /// The question as the inbox holds it. One the bar may not answer is the daemon's shown-only question
  /// (hosts/observed.ts askedLine): one prompt naming the app to answer it in, its one option that app.
  List<AskItem> _items(_Agent a) {
    final q = a.question!;
    if (a.can('a')) return [AskItem(key: q.q, q: q.q, options: q.options)];
    final app = a.home.name;
    return [AskItem(key: 'prompt', q: '${q.q} · answer in $app', options: ['In $app'])];
  }

  /// A question the bar may only show carries the daemon's shown-only prefix (cableSession.ts SHOWN_ONLY_PREFIX).
  String _questionId(_Agent a) => '${a.can('a') ? 'q-' : 'shown:'}${a.id}-${a.serial}';

  /// Names these exact contents: a new question is a new token, so an answer to the old one is refused.
  String _token(_Agent a) =>
      '${((a.serial * 2654435761) & 0xffffffff).toRadixString(16).padLeft(8, '0')}-demo-${a.id}';

  /// questionInbox.ts's checks of answer.reviewed, in the daemon's words; null when it is taken.
  String? _refusal(_Agent? a, String token, List<int> choices) {
    final current = a != null && a.ask != _Ask.none ? _token(a) : '';
    // A shown-only question is refused before anything is taken: taken, it would read as sent on the bar.
    if (a != null && current.isNotEmpty && !a.can('a')) return 'Answer it in ${a.home.name}.';
    if (a == null || current.isEmpty || current != token) return 'This question changed. Open it again.';
    if (a.ask == _Ask.taken) return null; // sent twice, taken once: the same receipt again
    if (choices.length != 1) return 'Review every answer first.';
    if (_bit(choices.single, a.question!) < 0) return 'Choose an answer from this question.';
    return null;
  }

  /// The option a single choice's mask names (one bit per option), or -1.
  int _bit(int mask, Question q) {
    for (var bit = 0; bit < q.options.length; bit++) {
      if (mask == 1 << bit) return bit;
    }
    return -1;
  }

  void _taken(_Agent a, int choice, int closeIn) {
    a.choice = choice;
    a.ask = _Ask.taken;
    a.closeAt = _now + closeIn;
  }

  /// The question closes and the agent goes on with the answer it was given: no new turn.
  void _takeAnswer(_Agent a) {
    model.onQuestionClose(a.id);
    final q = a.question!;
    final next = q.next[a.choice < q.next.length ? a.choice : 0];
    a.question = null;
    a.ask = _Ask.none;
    _beginBeats(a, next, 0);
  }

  // ---- what the bar is shown ----

  _Agent? _find(String id) {
    for (final a in _agents) {
      if (a.id == id) return a;
    }
    return null;
  }

  int _count(int app, {bool waiting = false}) =>
      _agents.where((a) => a.app == app && (!waiting || a.ask == _Ask.open)).length;

  String _appsKeyNow() =>
      [_shown, for (var i = 0; i < kApps.length; i++) '${_count(i)}/${_count(i, waiting: true)}'].join(' ');

  /// The computer's apps in a fixed order, those with no agents too (kApps), and the one whose ring the bar holds.
  void _pushApps() {
    model.onApps(kApps[_shown].id, [
      for (var i = 0; i < kApps.length; i++)
        AppInfo(id: kApps[i].id, name: kApps[i].name, count: _count(i), waiting: _count(i, waiting: true)),
    ]);
    _appsKey = _appsKeyNow();
  }

  /// The shown app's ring, after the `apps` that names it.
  void _pushRing() {
    _ringOwed = false;
    _pushApps();
    final ring = [for (final a in _agents) if (a.app == _shown) a];
    model.onAgents([
      for (final a in ring) AgentRow(id: a.id, name: a.name, engine: a.engine, host: a.home.id, caps: a.home.caps),
    ]);
    final back = [for (final a in ring) if (!_ring.contains(a.id)) a];
    _ring = {for (final a in ring) a.id};
    for (final a in back) {
      _bringBack(a);
    }
  }

  /// The bar drops the agents that leave its ring, so one that comes on it is told again what it did last (history,
  /// never news: the daemon's restore), what its turn is doing, and what it asks.
  void _bringBack(_Agent a) {
    if (a.recap.isNotEmpty) model.onSummary(a.id, a.text, recap: a.recap, restore: true);
    if (a.turn != null && a.status.isNotEmpty) {
      model.onTurn(a.id, 'started', a.status);
      if (a.verb.isNotEmpty) model.onTurn(a.id, 'verb', a.verb);
      model.onTurn(a.id, 'activity', a.sentence, elapsedS: (_now - a.startedAt) ~/ 1000);
    }
    if (a.ask == _Ask.open) _sendQuestion(a);
  }

  // ---- New Harness ----

  /// The agent arrives in Harness, whose window comes to the front, so the bar is turned to Harness's ring.
  void _create() {
    _createAt = null;
    if (_agents.length >= kMaxAgents) {
      model.onToast('The bar holds $kMaxAgents agents. Wait for one to finish.');
      return;
    }
    final project = kProjects[_made % kProjects.length];
    final engine = kEngines[_made % kEngines.length];
    _made++;
    // Named after its project, as the desktop names one; a second on the same project is told apart.
    var name = project;
    for (var k = 2; _agents.any((a) => a.name == name); k++) {
      name = '$project-$k';
    }
    final a = _Agent('ag-new-$_made', name, engine, kHarness, made: true);
    _agents.add(a);
    _front = kHarness;
    _show(kHarness);
    _startTurn(a, setUp, kFirstTurnMs);
  }

  // ---- the talk ----

  /// The mic's levels into the model while the recording is open: the board's mic when it opens, else made up.
  void _listen(int serial) {
    final m = mic;
    if (m == null) {
      _speak(serial);
      return;
    }
    unawaited(m.open().then((ok) {
      if (serial != _talkSerial || _stopped) {
        if (ok) unawaited(m.close());
        return;
      }
      if (!ok) {
        _speak(serial);
        return;
      }
      _micOpen = true;
      _levels = m.levels.listen(model.onLevel);
      // Nothing is transcribed here: the recording is drained, so a mic that keeps it for a listener keeps none.
      _pcm = m.pcm.listen((_) {});
    }, onError: (Object e) {
      debugPrint('demo: the mic did not open ($e); made-up levels instead');
      if (serial == _talkSerial && !_stopped) _speak(serial);
    }));
  }

  /// Speech-like levels for [kSpeechMs] (a syllable's swell with noise on it, 0.3..0.9), then near silence.
  void _speak(int serial) {
    final from = _now;
    final noise = Random(serial);
    void level() {
      if (serial != _talkSerial) return;
      final t = _now - from;
      if (t > kTalkMaxMs) return;
      final swell = sin(pi * t / 130).abs();
      model.onLevel(
          t < kSpeechMs ? 0.3 + 0.6 * (0.6 * swell + 0.4 * noise.nextDouble()) : 0.015 + 0.01 * noise.nextDouble());
      _speech = clock.at(_now + kLevelMs, level);
    }

    _speech = clock.at(from + kLevelMs, level);
  }

  Future<void> _endRecording() async {
    _talking = null;
    _talkSerial++;
    _speech?.cancel();
    _speech = null;
    final levels = _levels, pcm = _pcm;
    _levels = null;
    _pcm = null;
    final open = _micOpen;
    _micOpen = false;
    await levels?.cancel();
    await pcm?.cancel();
    if (open) await mic!.close();
  }

  /// The voice pipeline is idle once no recording is open and none is being sent.
  void _idleWhenDone() {
    if (_talking == null && _heard.isEmpty) model.onTalkLink(TalkLink.idle);
  }

  /// Sent recordings whose words are in: the agent takes them.
  void _hear(int now) {
    while (_heard.isNotEmpty && now >= _heard.first.at) {
      final words = _heard.removeAt(0);
      _idleWhenDone();
      _take(words.agent);
    }
  }

  /// The words reach the agent: the mockup's line for it. Said to a question the bar answers, they are its answer
  /// (never a permission prompt's, which takes Allow or Deny only); otherwise the agent works on them when it is free.
  void _take(_Agent a) {
    final q = a.question;
    if (a.ask == _Ask.open && q != null && a.can('a') && !q.permission) {
      final spoken = kSay[a.name] ?? kSayElse;
      _taken(a, spoken.option < q.options.length ? spoken.option : 0, kCloseMs);
      return;
    }
    a.said = _words(a);
    a.saidAt = _now;
  }

  /// The words for a new turn. In the manual demo an agent with a case says it and its [kSay] line by turns, the case
  /// first, so a person can play each case again.
  Spoken _words(_Agent a) {
    final kase = manual ? kCase[a.name] : null;
    if (kase == null) return kSay[a.name] ?? kSayElse;
    final first = a.talks.isEven;
    a.talks++;
    return first ? kase : kSay[a.name] ?? kSayElse;
  }
}
