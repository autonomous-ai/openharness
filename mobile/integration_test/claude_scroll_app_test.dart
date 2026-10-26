// What it is waiting for goes to the console: the run is watched from it.
// ignore_for_file: avoid_print

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/main.dart' as app;
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:xterm/xterm.dart' show Terminal, TerminalView;
// The mirror is not exported; what it knows of the rows above is read off it.
// ignore: implementation_imports
import 'package:xterm/src/ui/render.dart' show RenderTerminal;

import 'claude_scroll/bench.dart';
import 'perf/frames.dart';
import 'perf/perf_binding.dart';

/// Claude Code's fullscreen scroll in the REAL app, end to end: this phone's
/// own sign-in, its own computers over the real link, and one of the owner's
/// own Claude Code agents — `CLAUDE_AGENT_NAME`, by its name. The same
/// scenarios and measures as `claude_scroll_test.dart`.
///
/// ⚠️ **It is a real agent on a real computer.** Opening it from the phone takes
/// its pane over at the phone's size, as opening it by hand does, and the
/// scroll sends it wheel events and Page Up/Down — nothing is typed. Pick one
/// that is idle.
///
///     flutter build ios --profile --target=integration_test/claude_scroll_app_test.dart \
///       --dart-define=CLAUDE_AGENT_NAME="Mobile features"
///     flutter drive --profile --no-dds --keep-app-running \
///       --use-application-binary=build/ios/iphoneos/Runner.app \
///       --driver=test_driver/claude_scroll_driver.dart \
///       --target=integration_test/claude_scroll_app_test.dart -d <phone>
///
/// The phone must be signed in already: this never signs in. Like every
/// benchmark here it replaces the app on the phone; reinstall the app after.
void main() {
  final binding = PerfBinding()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.benchmarkLive;
  final options = ClaudeScrollOptions.fromEnvironment();
  // Tried in turn: the first with a long enough transcript is measured.
  const agentNames = String.fromEnvironment(
    'CLAUDE_AGENT_NAME',
    defaultValue: 'Mobile features',
  );

  testWidgets('Claude Code scroll in the real app', (tester) async {
    final bench = ClaudeScrollBench(
      tester,
      binding,
      options,
      openInApp: () => _openAgent(agentNames.split(',')),
      beforeScenario: _holdTerminal,
    );
    try {
      await bench.run();
    } finally {
      bench.dispose();
      binding.reportData = {...bench.results, 'agent': _chosen};
    }
    if (bench.failures.isNotEmpty) {
      fail('Scenarios failed: ${bench.failures}');
    }
  }, timeout: const Timeout(Duration(minutes: 15)));
}

/// The rows above the screen a measured agent must have — known, fetched
/// ahead — for flicks to measure more than the top of its transcript.
const _rowsWanted = 300;

/// The agent measured, and what each one tried had above its screen.
Map<String, Object?> _chosen = {};

/// The app, computer and agent [_openAgent] opened.
(AppNotifier, String, String)? _held;

/// The phone drives the terminal, as a person picking it up does: one another
/// app holds only shows here, and takes nothing typed — a scroll included —
/// until "Take control" (`TerminalPage._takeControl`). Taken again if the
/// computer took it back meanwhile.
Future<void> _holdTerminal() async {
  final (notifier, machineId, agentId) = _held!;
  final session = notifier.paneOfAgent(machineId, agentId)?.session;
  if (session != null && session.acceptsInput) return;
  print(
    '[scroll] not holding the terminal (status ${session?.status.name}, '
    'watching ${session?.watching}) — taking control',
  );
  await notifier.selectAgent(machineId, agentId);
  await _until('control of the terminal', () {
    final now = notifier.paneOfAgent(machineId, agentId)?.session;
    return now != null && now.acceptsInput ? true : null;
  }, seconds: 30);
  await _wait(1500);
}

Future<void> _wait(int ms) => Future<void>.delayed(Duration(milliseconds: ms));

/// Waits — frames drawn meanwhile — for [found] to answer, up to [seconds].
Future<T> _until<T extends Object>(
  String what,
  T? Function() found, {
  int seconds = 90,
}) async {
  final watch = Stopwatch()..start();
  var said = -1;
  while (watch.elapsed.inSeconds < seconds) {
    final value = found();
    if (value != null) return value;
    if (watch.elapsed.inSeconds ~/ 10 != said) {
      said = watch.elapsed.inSeconds ~/ 10;
      print('[scroll] waiting for $what (${watch.elapsed.inSeconds}s)');
    }
    await _wait(200);
    await nextFrame();
  }
  throw StateError('never got $what in ${seconds}s');
}

/// The app started as on a tap of its icon; each of [agentNames] on this
/// phone's computers opened in turn on the home screen and left to fetch
/// ahead, until one has [_rowsWanted] rows above its screen — else the one
/// with most. Answers how to read the chosen agent's emulator.
Future<Terminal Function()> _openAgent(List<String> agentNames) async {
  unawaited(app.main());
  final shell = await _until('the app signed in', () {
    if (findElement((w) => w is PhoneWelcome) != null) {
      throw StateError('the phone is signed out: sign in by hand first');
    }
    return findElement((w) => w is PhoneShell);
  });
  final notifier = (shell.widget as PhoneShell).notifier;
  final tried = <String, int>{};
  (String, String, String)? chosen;
  var chosenRows = -1;
  for (final name in agentNames.map((n) => n.trim())) {
    final (machineId, agentId) = await _until('agent "$name"', () {
      for (final entry in notifier.machineStates.entries) {
        for (final agent in entry.value.agents) {
          if (agent.name == name && agent.engine == 'claude') {
            return (entry.key, agent.id);
          }
        }
      }
      return null;
    }, seconds: 60);
    final terminal = await _show(notifier, name, machineId, agentId);
    // Time to fetch the rows above, as it does for anyone who opens it.
    await _wait(8000);
    final above = _rowsAbove(terminal());
    tried[name] = above;
    print('[scroll] "$name" · $above rows known above the screen');
    if (above > chosenRows) {
      chosenRows = above;
      chosen = (name, machineId, agentId);
    }
    if (above >= _rowsWanted) break;
  }
  final (name, machineId, agentId) = chosen!;
  _chosen = {'name': name, 'rowsAbove': chosenRows, 'tried': tried};
  final (_, heldMachine, heldAgent) = _held!;
  final terminal = heldMachine == machineId && heldAgent == agentId
      ? () => notifier.paneOfAgent(machineId, agentId)!.session!.terminal
      : await _show(notifier, name, machineId, agentId);
  print('[scroll] measuring "$name" · tried $tried');
  return terminal;
}

/// [agentId] opened on the home screen, as a tap on it does, its terminal
/// taken and the keyboard put away as a reader puts it away.
Future<Terminal Function()> _show(
  AppNotifier notifier,
  String name,
  String machineId,
  String agentId,
) async {
  print('[scroll] opening "$name" ($agentId) on $machineId');
  final scope = await _until(
    'the shell',
    () => findElement((w) => w is PhoneShellScope),
  );
  Element? below;
  scope.visitChildElements((child) => below ??= child);
  PhoneShellScope.maybeOf(below!)!.onOpenAgent(machineId, agentId);
  await _until(
    'its terminal',
    () =>
        notifier.paneOfAgent(machineId, agentId)?.session == null ? null : true,
  );
  _held = (notifier, machineId, agentId);
  await _holdTerminal();
  // A reader reads with the keyboard down: the grid is the taller one.
  await _wait(2500);
  FocusManager.instance.primaryFocus?.unfocus();
  await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
  await _wait(2500);
  Terminal terminal() =>
      notifier.paneOfAgent(machineId, agentId)!.session!.terminal;
  final status = notifier.machineStates[machineId]?.connectionStatus;
  print(
    '[scroll] "$name" open · ${terminal().viewWidth}x${terminal().viewHeight}'
    ' · ${status?.name}',
  );
  return terminal;
}

/// Rows of [terminal]'s agent the mirror knows above the screen.
int _rowsAbove(Terminal terminal) {
  RenderTerminal? render;
  void visit(Element element) {
    if (render != null) return;
    if (element.widget case TerminalView(:final terminal)
        when identical(terminal, terminal)) {}
    final object = element.renderObject;
    if (object is RenderTerminal) {
      render = object;
      return;
    }
    element.visitChildElements(visit);
  }

  final view = findElement(
    (w) => w is TerminalView && identical(w.terminal, terminal),
  );
  view?.visitChildElements(visit);
  final mirror = render?.debugRemoteScrollMirror;
  if (mirror == null) return 0;
  var rows = 0;
  for (
    var row = mirror.display.round() + mirror.top - 1;
    mirror.rowAt(row) != null;
    row--
  ) {
    rows++;
  }
  return rows;
}
