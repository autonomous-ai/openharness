import 'dart:async';

import 'package:flutter/widgets.dart';

import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/daemon_lines.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';

/// What the daemon watches on this phone, read off the app's own state.
///
/// - **need**: a harness the machine says is waiting on you, or a question
///   dialog read off a terminal on screen ([DaemonHostState.noteQuestion]):
///   the machine's own question frame never reaches a phone on the relay.
/// - **work**: a harness mid-turn.
/// - **fail**: a harness open here that failed to start. A machine asleep or
///   out of reach is not a failure (`daemons/README.md`, Moods).
({DaemonWatch watch, DaemonFacts facts}) observeDaemon(
  AppNotifier app, {
  Map<String, ({String who, String q})> onScreen = const {},
}) {
  final entries = agentIndex(app);
  final needs = <String>{};
  final waiting = <({String who, String? q})>[];
  final waitingAgents = <String>{};
  final working = <String>{};
  final workingNames = <String>[];
  for (final e in entries) {
    final key = '${e.machineId}/${e.agent.id}';
    final question = app.questionFor(e.machineId, e.agent.id);
    if (question != null) {
      needs.add('$key#${question.requestId}');
      waitingAgents.add(key);
      waiting.add((
        who: e.agent.displayName,
        q: question.prompt.trim().isEmpty ? null : question.prompt.trim(),
      ));
    }
    if (e.isWorking) {
      working.add(key);
      workingNames.add(e.agent.displayName);
    }
  }
  // Dialogs read off a terminal on screen, unless the machine already said so.
  for (final MapEntry(:key, :value) in onScreen.entries) {
    final agent = key.split('#').first;
    if (waitingAgents.contains(agent)) continue;
    needs.add(key);
    waitingAgents.add(agent);
    waiting.add((who: value.who, q: value.q.isEmpty ? null : value.q));
  }
  final failing = <String>{};
  final failingNames = <String>[];
  for (final pane in app.allPanes) {
    final agentId = pane.agentId;
    if (agentId == null) continue;
    final agent = app
        .stateOf(pane.machineId)
        ?.agents
        .where((a) => a.id == agentId)
        .firstOrNull;
    if (agent == null || agent.launchState != 'failed') continue;
    if (failing.add('${pane.machineId}/$agentId')) {
      failingNames.add(agent.displayName);
    }
  }
  return (
    watch: DaemonWatch(needs: needs, working: working, failing: failing),
    facts: DaemonFacts(
      waiting: waiting,
      working: workingNames,
      failing: failingNames,
      harnesses: entries.where((e) => !e.agent.isStopped).length,
    ),
  );
}

/// The daemon for everything under the signed-in shell: one face, shared by
/// every chip (a pager builds one header per page), fed from the app.
class DaemonHost extends StatefulWidget {
  const DaemonHost({
    super.key,
    required this.notifier,
    required this.child,
    this.now,
  });

  final AppNotifier notifier;
  final Widget child;

  /// The clock (tests: a day before a drop's release).
  final DateTime Function()? now;

  @override
  State<DaemonHost> createState() => DaemonHostState();
}

class DaemonHostState extends State<DaemonHost> with WidgetsBindingObserver {
  late final DaemonFace face = DaemonFace(widget.notifier.zoo, now: widget.now);
  DaemonFacts _facts = const DaemonFacts();
  final _onScreen = <Object, ({String key, String who, String q})>{};
  bool _foreground = true;

  AppNotifier get app => widget.notifier;
  ZooClient get zoo => app.zoo;

  /// The facts behind the line the daemon says now.
  DaemonFacts get facts => _facts;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    app.addListener(_sync);
    app.sessionPreviews.addListener(face.pulse);
    _sync();
    unawaited(app.daemonHabits.noteDay());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _environment();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (foreground == _foreground) return;
    _foreground = foreground;
    _environment();
    if (foreground) unawaited(app.daemonHabits.noteDay());
  }

  void _environment() => face.setEnvironment(
    foreground: _foreground,
    reduceMotion: MediaQuery.maybeDisableAnimationsOf(context) ?? false,
  );

  void _sync() {
    if (!mounted) return;
    final seen = observeDaemon(
      app,
      onScreen: {for (final q in _onScreen.values) q.key: (who: q.who, q: q.q)},
    );
    _facts = seen.facts;
    face.sync(seen.watch);
    app.daemonHabits.observeOnline([
      for (final machine in app.machines)
        if (app.stateOf(machine.machineId)?.nodeOnline == true)
          machine.machineId,
    ]);
  }

  /// A terminal page read a question dialog off its own screen, or saw it go
  /// ([key] null). [owner] is the page, so a page going takes its report.
  void noteQuestion(
    Object owner, {
    required String machineId,
    required String agentId,
    String? key,
    String who = '',
    String question = '',
  }) {
    final before = _onScreen[owner];
    if (key == null) {
      if (_onScreen.remove(owner) != null) _sync();
      return;
    }
    final next = (
      key: '$machineId/$agentId#pane:$key',
      who: who,
      q: question.trim(),
    );
    if (before == next) return;
    _onScreen[owner] = next;
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    app.removeListener(_sync);
    app.sessionPreviews.removeListener(face.pulse);
    face.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      DaemonScope(host: this, child: widget.child);
}

/// Where a chip, a sheet or a terminal page finds the daemon.
class DaemonScope extends InheritedWidget {
  const DaemonScope({super.key, required this.host, required super.child});

  final DaemonHostState host;

  /// Null outside the signed-in shell — tests of a lone page, and the login
  /// screen — where nothing daemon-shaped is drawn.
  static DaemonHostState? maybeOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<DaemonScope>()?.host;

  @override
  bool updateShouldNotify(DaemonScope oldWidget) => oldWidget.host != host;
}
