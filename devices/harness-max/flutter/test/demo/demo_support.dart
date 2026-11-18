// What the demo's tests share: a clock run by hand, a model that records what the demo tells it, and a mic to feed.
import 'dart:async';
import 'dart:typed_data';

import 'package:harness_max_bar/demo/demo_clock.dart';
import 'package:harness_max_bar/demo/demo_link.dart';
import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/link/mic.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

/// A clock that moves only when the test says, running each timer at its own time, in order.
class ManualDemoClock implements DemoClock {
  int _now = 0;
  int _order = 0;
  final List<_ManualTimer> _timers = [];

  @override
  int get nowMs => _now;

  @override
  DemoTimer at(int ms, void Function() fn) {
    final t = _ManualTimer(ms, _order++, fn);
    _timers.add(t);
    return t;
  }

  /// Timers set and not yet run or cancelled.
  int get pending => _timers.where((t) => !t.cancelled).length;

  /// Moves the clock [ms] on, running every timer due by then (those the run sets too).
  void advance(int ms) {
    final end = _now + ms;
    for (;;) {
      _timers.removeWhere((t) => t.cancelled);
      _ManualTimer? next;
      for (final t in _timers) {
        if (t.at > end) continue;
        if (next == null || t.at < next.at || (t.at == next.at && t.order < next.order)) next = t;
      }
      if (next == null) break;
      _timers.remove(next);
      if (next.at > _now) _now = next.at;
      next.fn();
    }
    _now = end;
  }
}

class _ManualTimer implements DemoTimer {
  _ManualTimer(this.at, this.order, this.fn);
  final int at, order;
  final void Function() fn;
  bool cancelled = false;

  @override
  void cancel() => cancelled = true;
}

/// One input the demo gave the model, and when.
class Seen {
  Seen(this.at, this.type, {this.agent = '', this.text = '', this.data = const {}});
  final int at;

  /// link, apps, agents, `turn.<kind>`, summary, question, question.close, question.state, answer.receipt, toast, talk,
  /// level, focus.
  final String type;
  final String agent, text;
  final Map<String, Object?> data;

  Object? operator [](String key) => data[key];

  @override
  String toString() => '$at $type $agent "$text" $data';
}

/// A model that only records its inputs: the demo is tested on what it says, not on what a model makes of it.
class RecordingModel extends BarModel {
  RecordingModel(this._now);
  final int Function() _now;
  final List<Seen> seen = [];

  void _add(String type, {String agent = '', String text = '', Map<String, Object?> data = const {}}) =>
      seen.add(Seen(_now(), type, agent: agent, text: text, data: data));

  @override
  void onLink(bool up, {String computer = '', bool offersNew = false}) =>
      _add('link', text: computer, data: {'up': up, 'offersNew': offersNew});

  @override
  void onApps(String shown, List<AppInfo> rows) => _add('apps', text: shown, data: {'rows': rows});

  @override
  void onAgents(List<AgentRow> rows) => _add('agents', text: rows.map((r) => r.name).join(','), data: {'rows': rows});

  @override
  void onTurn(String agentId, String kind, String text, {int elapsedS = -1}) =>
      _add('turn.$kind', agent: agentId, text: text, data: {'elapsed': elapsedS});

  @override
  void onSummary(String agentId, String text,
          {String recap = '', bool restore = false, SummaryTier tier = SummaryTier.alert}) =>
      _add('summary', agent: agentId, text: text, data: {'recap': recap, 'restore': restore, 'tier': tier});

  @override
  void onQuestion(String agentId, String requestId, String text,
          {List<AskItem> items = const [], bool permission = false, bool review = false}) =>
      _add('question', agent: agentId, text: text,
          data: {'id': requestId, 'items': items, 'permission': permission, 'review': review});

  @override
  void onQuestionClose(String agentId) => _add('question.close', agent: agentId);

  @override
  void onQuestionState(String agentId, String fetch,
          {required bool ok,
          String requestId = '',
          String token = '',
          bool submitted = false,
          String error = '',
          List<AskItem> items = const []}) =>
      _add('question.state', agent: agentId, text: fetch, data: {
        'ok': ok,
        'id': requestId,
        'token': token,
        'submitted': submitted,
        'error': error,
        'items': items,
      });

  @override
  void onAnswerReceipt(String agentId, String fetch,
          {required bool ok, String token = '', bool pending = false, String error = ''}) =>
      _add('answer.receipt', agent: agentId, text: fetch,
          data: {'ok': ok, 'token': token, 'pending': pending, 'error': error});

  @override
  void onFocus(String agentId) => _add('focus', agent: agentId);

  @override
  void onToast(String text) => _add('toast', text: text);

  @override
  void onTalkLink(TalkLink state) => _add('talk', text: state.name);

  @override
  void onLevel(double level) => _add('level', data: {'level': level});
}

/// A mic the test feeds by hand.
class FakeMic implements Mic {
  FakeMic({this.opens = true});
  final bool opens;
  final StreamController<double> levelsIn = StreamController<double>.broadcast();
  late final StreamController<Uint8List> pcmIn =
      StreamController<Uint8List>.broadcast(onListen: () => pcmListening = true, onCancel: () => pcmListening = false);
  int opened = 0, closed = 0;

  /// Someone takes the recording (a mic that keeps it for a listener keeps nothing).
  bool pcmListening = false;

  @override
  int get sampleRate => 16000;

  @override
  Future<bool> open() async {
    opened++;
    return opens;
  }

  @override
  Stream<Uint8List> get pcm => pcmIn.stream;

  @override
  Stream<double> get levels => levelsIn.stream;

  @override
  Future<void> close() async => closed++;
}

/// The demo on a hand-run clock, with a recording model.
class Demo {
  Demo({Mic? mic, bool manual = false}) {
    model = RecordingModel(() => clock.nowMs);
    link = DemoLink(model, mic: mic, clock: clock, manual: manual);
    model.link = link;
  }

  final ManualDemoClock clock = ManualDemoClock();
  late final RecordingModel model;
  late final DemoLink link;

  Future<void> start() => link.start();

  int get now => clock.nowMs;
  List<Seen> get seen => model.seen;

  /// Runs the clock [ms] on (0: what is due now, as the replies to a call).
  void run(int ms) => clock.advance(ms);

  /// Runs the clock to [at] ms since the start.
  void runTo(int at) => clock.advance(at - clock.nowMs);

  void forget() => model.seen.clear();

  Iterable<Seen> all(String type, {String? agent, String? text}) => seen.where(
      (s) => s.type == type && (agent == null || s.agent == agent) && (text == null || s.text == text));

  int count(String type, {String? agent, String? text}) => all(type, agent: agent, text: text).length;

  Seen? first(String type, {String? agent, String? text}) {
    for (final s in all(type, agent: agent, text: text)) {
      return s;
    }
    return null;
  }

  /// Runs in 10 ms steps until [type] arrives (for [agent]), at most [ms]; that input.
  Seen runUntil(String type, {String? agent, String? text, int ms = 200000}) {
    final from = seen.length;
    for (var waited = 0; waited <= ms; waited += 10) {
      for (var i = from; i < seen.length; i++) {
        final s = seen[i];
        if (s.type == type && (agent == null || s.agent == agent) && (text == null || s.text == text)) return s;
      }
      run(10);
    }
    throw StateError('no $type${agent == null ? '' : ' for $agent'} in $ms ms');
  }
}

/// Lets the futures the demo started (the mic opening) finish.
Future<void> settle() => Future<void>.delayed(Duration.zero);
