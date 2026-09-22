// Release renderer benchmark using Flutter's keyboard dispatcher. This does
// not synthesize OS input or claim native event delivery/physical latency.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shortcuts/shortcuts_browser.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/swarm_search_input.dart';
import 'package:harness/widgets/terminal_find_bar.dart';
import 'package:harness/widgets/workspace_welcome.dart';

typedef _Key = (LogicalKeyboardKey, PhysicalKeyboardKey);
const _escape = (LogicalKeyboardKey.escape, PhysicalKeyboardKey.escape);
const _enter = (LogicalKeyboardKey.enter, PhysicalKeyboardKey.enter);

void _key(_Key key, {bool command = true, bool shift = false}) {
  final keyboard = HardwareKeyboard.instance;
  void event(_Key key, bool down) {
    final time = Duration(microseconds: DateTime.now().microsecondsSinceEpoch);
    final event = down
        ? KeyDownEvent(physicalKey: key.$2, logicalKey: key.$1, timeStamp: time)
        : KeyUpEvent(physicalKey: key.$2, logicalKey: key.$1, timeStamp: time);
    // HardwareKeyboard updates modifier state. The framework's normal
    // KeyEventManager then forwards the same event to FocusManager; invoking
    // only HardwareKeyboard skips shortcut and focused-widget dispatch.
    keyboard.handleKeyEvent(event);
    // ignore: deprecated_member_use
    ServicesBinding.instance.keyEventManager.keyMessageHandler?.call(
      // ignore: deprecated_member_use
      KeyMessage([event], null),
    );
  }

  const meta = (LogicalKeyboardKey.metaLeft, PhysicalKeyboardKey.metaLeft);
  const shiftKey = (
    LogicalKeyboardKey.shiftLeft,
    PhysicalKeyboardKey.shiftLeft,
  );
  if (command) event(meta, true);
  if (shift) event(shiftKey, true);
  event(key, true);
  event(key, false);
  if (shift) event(shiftKey, false);
  if (command) event(meta, false);
}

Future<int> _frame() async {
  final done = Completer<int>();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    done.complete(ui.PlatformDispatcher.instance.frameData.frameNumber);
  });
  WidgetsBinding.instance.scheduleFrame();
  final number = await done.future;
  // Focus requested by a widget's post-frame callback is applied in a
  // microtask. Let the framework complete it before sending another key.
  await Future<void>.delayed(Duration.zero);
  return number;
}

Element? _find(bool Function(Widget) matches) {
  Element? found;
  void visit(Element element) {
    if (found != null) return;
    if (element.widget case Offstage(offstage: true)) return;
    if (matches(element.widget)) {
      found = element;
    } else {
      element.visitChildElements(visit);
    }
  }

  WidgetsBinding.instance.rootElement!.visitChildElements(visit);
  return found;
}

Map<String, num> _distribution(List<int> values) {
  values.sort();
  double at(double p) => values[(values.length * p).ceil() - 1] / 1000;
  return {
    'samples': values.length,
    'p50Ms': at(.5),
    'p95Ms': at(.95),
    'p99Ms': at(.99),
    'maxMs': values.last / 1000,
  };
}

Future<void> runFlutterDispatchBenchmark(
  AppNotifier app,
  String output,
  Map<String, Object?> metadata,
  Map<int, ui.FrameTiming> timings,
) async {
  final rows = <Map<String, Object?>>[];
  final operations = <(String, _Key, bool Function(Widget))>[
    (
      'cmd_n',
      (LogicalKeyboardKey.keyN, PhysicalKeyboardKey.keyN),
      (w) => w is NewHarnessBox,
    ),
    (
      'cmd_o',
      (LogicalKeyboardKey.keyO, PhysicalKeyboardKey.keyO),
      (w) => w is SwarmSearchInput && w.search != null,
    ),
    (
      'cmd_p',
      (LogicalKeyboardKey.keyP, PhysicalKeyboardKey.keyP),
      (w) => w is SwarmSearchInput && w.search?.isCommandMode == true,
    ),
    (
      'cmd_comma',
      (LogicalKeyboardKey.comma, PhysicalKeyboardKey.comma),
      (w) => w is SettingsScreen,
    ),
    (
      'cmd_slash',
      (LogicalKeyboardKey.slash, PhysicalKeyboardKey.slash),
      (w) => w is ShortcutsBrowser,
    ),
    (
      'cmd_f',
      (LogicalKeyboardKey.keyF, PhysicalKeyboardKey.keyF),
      (w) => w is TerminalFindBar,
    ),
  ];
  for (final (operation, key, matches) in operations) {
    for (var sample = -5; sample < 40; sample++) {
      final previousFrame = await _frame();
      final began = DateTime.now().microsecondsSinceEpoch;
      _key(key);
      final dispatched = DateTime.now().microsecondsSinceEpoch;
      final firstFrame = await _frame();
      final element = _find(matches);
      if (element == null) {
        throw StateError('$operation did not open its expected surface');
      }
      var readyFrame = firstFrame;
      // A translucent first frame is not a fully available dialog. Include
      // the route animation in ready time and retain first-frame time too.
      final route = ModalRoute.of(element);
      while (route?.animation?.isCompleted == false) {
        if (DateTime.now().microsecondsSinceEpoch - began > 2000000) {
          throw StateError('$operation did not finish opening');
        }
        readyFrame = await _frame();
      }
      rows.add({
        'operation': operation,
        'phase': sample < 0 ? 'warmup' : 'measured',
        'startedWallMicros': began,
        'dispatchMicros': dispatched - began,
        'previousFrame': previousFrame,
        'firstFrame': firstFrame,
        'readyFrame': readyFrame,
      });
      // With no inherited project, Cmd-N starts on the project question.
      // Escape first returns to its launch summary, then closes the box.
      if (element.widget case NewHarnessBox(:final controller)) {
        for (
          var step = 0;
          step < 8 && controller.field != NewHarnessField.launch;
          step++
        ) {
          _key(_escape, command: false);
          await _frame();
        }
      }
      _key(_escape, command: false);
      for (var frame = 0; frame < 120 && _find(matches) != null; frame++) {
        await _frame();
      }
      if (_find(matches) != null) {
        throw StateError(
          '$operation did not dismiss; focus ${FocusManager.instance.primaryFocus}; '
          'creation field ${(_find((w) => w is NewHarnessBox)?.widget as NewHarnessBox?)?.controller.field}',
        );
      }
    }
  }
  // Cmd+T creates a blank tab; Escape does not close that tab. Validate both
  // its first welcome frame and the Cmd+W return to the retained workspace.
  for (var sample = -5; sample < 40; sample++) {
    final previousFrame = await _frame();
    final previousTab = app.activeSwarmId;
    final previousCount = app.swarms.length;
    final began = DateTime.now().microsecondsSinceEpoch;
    _key((LogicalKeyboardKey.keyT, PhysicalKeyboardKey.keyT));
    final dispatched = DateTime.now().microsecondsSinceEpoch;
    final frame = await _frame();
    if (app.activeSwarmId == previousTab ||
        app.swarms.length != previousCount + 1 ||
        app.panes.isNotEmpty ||
        _find((widget) => widget is WorkspaceWelcome) == null) {
      throw StateError('Cmd+T did not create its welcome tab');
    }
    rows.add({
      'operation': 'cmd_t',
      'phase': sample < 0 ? 'warmup' : 'measured',
      'startedWallMicros': began,
      'dispatchMicros': dispatched - began,
      'previousFrame': previousFrame,
      'firstFrame': frame,
      'readyFrame': frame,
    });
    _key((LogicalKeyboardKey.keyW, PhysicalKeyboardKey.keyW));
    await _frame();
    if (app.swarms.length != previousCount ||
        _find((widget) => widget is WorkspaceWelcome) != null) {
      throw StateError('Cmd+W did not close the benchmark welcome tab');
    }
    // Closing selects the adjacent tab; return to the exact starting context.
    app.selectSwarm(previousTab, attachPending: false);
    await _frame();
    if (app.activeSwarmId != previousTab || app.panes.isEmpty) {
      throw StateError('Cmd+T did not restore the original workspace');
    }
  }
  for (final operation in ['tab', 'focus', 'zoom']) {
    for (var sample = -5; sample < 40; sample++) {
      if (operation == 'focus') app.focusPaneByIndex(0);
      final previousFrame = await _frame();
      final previousTab = app.activeSwarmId;
      final began = DateTime.now().microsecondsSinceEpoch;
      if (operation == 'tab') {
        _key((
          LogicalKeyboardKey.bracketRight,
          PhysicalKeyboardKey.bracketRight,
        ), shift: true);
      } else if (operation == 'focus') {
        _key((LogicalKeyboardKey.arrowRight, PhysicalKeyboardKey.arrowRight));
      } else {
        _key(_enter);
      }
      final dispatched = DateTime.now().microsecondsSinceEpoch;
      final frame = await _frame();
      final success = operation == 'tab'
          ? previousTab != app.activeSwarmId
          : operation == 'focus'
          ? app.focusedPaneId == app.panes[1].id
          : app.zoomedPaneId != null;
      if (!success) {
        throw StateError('$operation did not reach its expected state');
      }
      rows.add({
        'operation': operation,
        'phase': sample < 0 ? 'warmup' : 'measured',
        'startedWallMicros': began,
        'dispatchMicros': dispatched - began,
        'previousFrame': previousFrame,
        'firstFrame': frame,
        'readyFrame': frame,
      });
      if (operation == 'zoom') {
        _key(_enter);
        await _frame();
        if (app.zoomedPaneId != null) throw StateError('Zoom did not restore');
      }
    }
  }
  for (
    var attempt = 0;
    attempt < 30 && rows.any((row) => !timings.containsKey(row['readyFrame']));
    attempt++
  ) {
    await _frame();
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  for (final row in rows) {
    final previous = timings[row['previousFrame']];
    final first = timings[row['firstFrame']];
    final ready = timings[row['readyFrame']];
    if (previous == null || first == null || ready == null) {
      throw StateError('Missing exact frame timings');
    }
    final began = row['startedWallMicros'] as int;
    row['firstRasterMicros'] =
        first.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime) -
        began;
    row['readyRasterMicros'] =
        ready.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime) -
        began;
    row['buildMicros'] = first.buildDuration.inMicroseconds;
    row['rasterMicros'] = first.rasterDuration.inMicroseconds;
    // The preceding frame can move dispatch within the refresh interval.
    // Preserve that phase and split waiting from work on the requested frame.
    int wallTime(ui.FrameTiming timing, ui.FramePhase phase) =>
        timing.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime) -
        timing.timestampInMicroseconds(ui.FramePhase.rasterFinish) +
        timing.timestampInMicroseconds(phase);
    row['previousBuildMicros'] = previous.buildDuration.inMicroseconds;
    row['dispatchAfterPreviousVsyncMicros'] =
        began - wallTime(previous, ui.FramePhase.vsyncStart);
    row['waitForBuildMicros'] =
        wallTime(first, ui.FramePhase.buildStart) - began;
    row['buildStartToRasterMicros'] =
        first.timestampInMicroseconds(ui.FramePhase.rasterFinish) -
        first.timestampInMicroseconds(ui.FramePhase.buildStart);
    if ((row['firstRasterMicros'] as int) < 0) {
      throw StateError('Invalid frame timestamp');
    }
  }
  final names = rows.map((row) => row['operation']).toSet();
  await File(output).writeAsString(
    const JsonEncoder.withIndent('  ').convert({
      'success': true,
      'kind': 'native_release_flutter_dispatch_to_raster',
      'metadata': metadata,
      'terminals': app.allPanes.length,
      'summaries': [
        for (final name in names)
          {
            'operation': name,
            for (final metric in [
              'dispatchMicros',
              'firstRasterMicros',
              'readyRasterMicros',
              'buildMicros',
              'rasterMicros',
              'previousBuildMicros',
              'dispatchAfterPreviousVsyncMicros',
              'waitForBuildMicros',
              'buildStartToRasterMicros',
            ])
              metric: _distribution([
                for (final row in rows)
                  if (row['operation'] == name && row['phase'] == 'measured')
                    row[metric] as int,
              ]),
          },
      ],
      'samples': rows,
    }),
  );
}
