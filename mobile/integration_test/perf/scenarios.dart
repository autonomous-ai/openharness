import 'dart:io' show Platform;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/find_row.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:xterm/xterm.dart';

import 'claude_output.dart';
import 'fixture.dart';
import 'frames.dart';
import 'gestures.dart';
import 'perf_binding.dart';
import 'stream.dart';
import 'timeline.dart';

/// What to run, from `--dart-define`s — see `integration_test/README.md`.
class PerfOptions {
  const PerfOptions({
    required this.scenarios,
    required this.samples,
    required this.warmups,
    required this.streamSeconds,
    required this.trace,
  });

  factory PerfOptions.fromEnvironment() {
    const only = String.fromEnvironment('PERF_SCENARIOS');
    return PerfOptions(
      scenarios: only.isEmpty
          ? null
          : only.split(',').map((s) => s.trim()).toSet(),
      samples: const int.fromEnvironment('PERF_SAMPLES', defaultValue: 35),
      warmups: const int.fromEnvironment('PERF_WARMUPS', defaultValue: 5),
      streamSeconds: const int.fromEnvironment(
        'PERF_STREAM_SECONDS',
        defaultValue: 10,
      ),
      trace: const bool.fromEnvironment('PERF_TRACE', defaultValue: true),
    );
  }

  /// Null runs everything.
  final Set<String>? scenarios;
  final int samples;
  final int warmups;
  final int streamSeconds;
  final bool trace;

  bool wants(String name) =>
      scenarios == null || scenarios!.any((s) => name.startsWith(s));
}

/// One interaction observation, the desktop benchmark's row: dispatch, the
/// frame before it, the first frame that shows the result and the frame at
/// which it has finished arriving.
class _Observation {
  _Observation({
    required this.operation,
    required this.load,
    required this.measured,
    required this.began,
    required this.dispatched,
    required this.previousFrame,
    required this.firstFrame,
    required this.readyFrame,
    this.extra = const {},
  });

  final String operation;
  final String load;
  final bool measured;
  final int began;
  final int dispatched;
  final int previousFrame;
  final int firstFrame;
  final int readyFrame;
  final Map<String, Object?> extra;
  final Map<String, int> derived = {};

  void derive(FrameClock clock, {int? readyBegan}) {
    final previous = clock.byNumber[previousFrame]!;
    final first = clock.byNumber[firstFrame]!;
    final ready = clock.byNumber[readyFrame]!;
    int rasterWall(ui.FrameTiming t) =>
        t.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime);
    derived['dispatchMicros'] = dispatched - began;
    derived['firstRasterMicros'] = rasterWall(first) - began;
    derived['readyRasterMicros'] = rasterWall(ready) - (readyBegan ?? began);
    derived['buildMicros'] = first.buildDuration.inMicroseconds;
    derived['rasterMicros'] = first.rasterDuration.inMicroseconds;
    derived['previousBuildMicros'] = previous.buildDuration.inMicroseconds;
    derived['dispatchAfterPreviousVsyncMicros'] =
        began - FrameClock.wall(previous, ui.FramePhase.vsyncStart);
    derived['waitForBuildMicros'] =
        FrameClock.wall(first, ui.FramePhase.buildStart) - began;
    derived['buildStartToRasterMicros'] =
        first.timestampInMicroseconds(ui.FramePhase.rasterFinish) -
        first.timestampInMicroseconds(ui.FramePhase.buildStart);
    derived['framesToReady'] = readyFrame - firstFrame;
    if (derived['firstRasterMicros']! < 0) {
      throw StateError('$operation: raster finished before dispatch');
    }
  }

  Map<String, Object?> toJson() => {
    'operation': operation,
    'load': load,
    'phase': measured ? 'measured' : 'warmup',
    'startedWallMicros': began,
    'previousFrame': previousFrame,
    'firstFrame': firstFrame,
    'readyFrame': readyFrame,
    ...derived,
    ...extra,
  };
}

/// The phone benchmark: production widgets, a synthetic account, frames timed
/// by the engine. See `docs/performance/2026-09-26-mobile-baseline.md`.
class PerfSuite {
  PerfSuite(this.tester, this.binding, this.options);

  final WidgetTester tester;
  final PerfBinding binding;
  final PerfOptions options;

  late final PerfFixture fixture = PerfFixture.create();
  final FrameClock clock = FrameClock();
  late final Touches touches = Touches(binding);
  final GlobalKey<FocusHostState> _host = GlobalKey();
  final List<NavigatorObserver> _observers = [];

  final Map<String, Object?> scenarios = {};
  final Map<String, Object?> traces = {};
  final Map<String, String> failures = {};
  final List<Map<String, Object?>> observations = [];
  late final Map<String, ClaudeOutput> _outputs;
  final Map<String, Object?> terminalInfo = {};

  static const _a = 'agent-a';
  static const _b = 'agent-b';

  FixtureTerminal get _terminalA => fixture.terminals[_a]!;

  Future<void> run() async {
    final startedAt = DateTime.now();
    // Synthetic touches do not reset the idle timer; a lock would suspend the
    // app mid-run.
    await WakelockPlus.enable();
    await _mountFocus();
    await _seed();
    await _step('idle', _idle);
    await _step(
      'stream_redraw',
      () => _stream('stream_redraw', StreamLoad.redraw),
    );
    await _step(
      'stream_append',
      () => _stream('stream_append', StreamLoad.append),
    );
    await _step('scroll_read', _scroll);
    // Find opens by a swipe only: a tap on the title is its menu now.
    await _step('find_open_swipe', _findOpenSwipe);
    await _step('mic_tap', () => _micTap(idle: true));
    await _step('mic_tap_streaming', () => _micTap(idle: false));
    await _step('new_open_swipe', _newOpenSwipe);
    await _step('find_switch', _findSwitch);
    if (options.trace) {
      await _step('trace_idle', _traceIdle);
      await _step(
        'trace_stream_redraw',
        () => _traceStream('stream_redraw', StreamLoad.redraw),
      );
      await _step(
        'trace_stream_append',
        () => _traceStream('stream_append', StreamLoad.append),
      );
      await _step('trace_find_open_tap', _traceFindOpen);
    }
    await _step('control_panel_redraw', _controlPanel);
    final finishedAt = DateTime.now();
    await WakelockPlus.disable();
    binding.reportData = {
      'schema': 1,
      'kind': 'mobile_framework_dispatch_to_raster',
      'success': failures.isEmpty,
      'failures': failures,
      'metadata': {
        ..._metadata(),
        'startedAt': startedAt.toIso8601String(),
        'finishedAt': finishedAt.toIso8601String(),
        'samplesPerOperation': options.samples,
        'warmupsPerOperation': options.warmups,
        'streamWindowSeconds': options.streamSeconds,
        'scenarioFilter': options.scenarios?.toList(),
        'terminal': terminalInfo,
        // After seeding: a steady terminal sends none, and a resize would put
        // a SIGWINCH and a keyframe into what is being measured.
        'resizesSentWhileMeasuring': {
          for (final t in fixture.terminals.values) t.agentId: t.resizes,
        },
        'skippedUnrequestedVsyncs': binding.skippedVsyncs,
      },
      'scenarios': scenarios,
      'traces': traces,
      'observations': observations,
    };
    clock.dispose();
  }

  Map<String, Object?> _metadata() {
    final view = binding.platformDispatcher.implicitView!;
    return {
      'buildMode': kReleaseMode
          ? 'release'
          : kProfileMode
          ? 'profile'
          : 'debug',
      'os': Platform.operatingSystem,
      'osVersion': Platform.operatingSystemVersion,
      'dart': Platform.version,
      'processors': Platform.numberOfProcessors,
      'physicalSize': [view.physicalSize.width, view.physicalSize.height],
      'devicePixelRatio': view.devicePixelRatio,
      'logicalSize': [
        view.physicalSize.width / view.devicePixelRatio,
        view.physicalSize.height / view.devicePixelRatio,
      ],
      'displayRefreshRate': view.display.refreshRate,
      'terminalFontSize': terminalFontStore.size,
      'terminalFontFamily': terminalFontStore.family.label,
    };
  }

  Future<void> _step(String name, Future<void> Function() body) async {
    if (!options.wants(name)) return;
    debugPrint('[perf] $name');
    try {
      await body();
    } catch (error, stack) {
      failures[name] = '$error\n$stack';
      debugPrint('[perf] $name FAILED: $error\n$stack');
      // Leave the screen as the next scenario expects it.
      await _recover();
    }
  }

  Future<void> _recover() async {
    try {
      fixture.voice.clear();
      await tester.pumpWidget(const SizedBox.shrink());
      await _settle(frames: 3);
      await _mountFocus();
    } catch (error) {
      debugPrint('[perf] recovery failed: $error');
    }
  }

  Future<void> _settle({int frames = 2, Duration pause = Duration.zero}) async {
    for (var i = 0; i < frames; i++) {
      await nextFrame();
    }
    if (pause > Duration.zero) await Future<void>.delayed(pause);
  }

  Future<void> _mountFocus([String agentId = _a]) async {
    await tester.pumpWidget(
      perfApp(
        FocusHost(key: _host, fixture: fixture, initialAgentId: agentId),
        observers: _observers,
      ),
    );
    await _settle(frames: 6, pause: const Duration(milliseconds: 300));
    await _untilFrame(
      () => findElement((w) => w is TerminalView) != null,
      what: 'the terminal to mount',
    );
  }

  /// Seeds both terminals the way an attach goes: a first keyframe at the
  /// machine's size, the phone's `terminal_resize` for the grid its view
  /// actually has, and a keyframe back at that size carrying the history.
  ///
  /// ⚠️ **The grid comes from the resize, not from the emulator.** The phone
  /// never resizes its xterm locally — it keeps the machine's size until the
  /// machine redraws at the size asked for — so `terminal.viewWidth` reads the
  /// FIRST keyframe's 80×24 however narrow the phone is.
  Future<void> _seed() async {
    final session = _terminalA.session;
    await _terminalA.keyframe(
      ClaudeOutput(cols: 80).keyframe(20),
      cols: 80,
      rows: 24,
    );
    await _untilFrame(
      () => _terminalA.lastResize != null,
      what: 'the phone to ask for its grid',
    );
    final (cols, rows) = _terminalA.lastResize!;
    _outputs = {};
    for (final id in [_a, _b]) {
      final output = ClaudeOutput(cols: cols, seed: id.hashCode);
      await fixture.terminals[id]!.keyframe(
        output.keyframe(2000),
        cols: cols,
        rows: rows,
      );
      _outputs[id] = output;
    }
    await _settle(frames: 6, pause: const Duration(milliseconds: 800));
    if (!session.hasRenderedFrame) throw StateError('No keyframe rendered');
    final initialResizes = {
      for (final t in fixture.terminals.values) t.agentId: t.resizes,
    };
    for (final t in fixture.terminals.values) {
      t.resizes = 0;
    }
    terminalInfo.addAll({
      'cols': cols,
      'rows': rows,
      'seededTranscriptLines': 2000,
      'retainedPhysicalRowsAfterSeed': session.terminal.buffer.lines.length,
      'resizesWhileSeeding': initialResizes,
    });
  }

  Future<int> _untilFrame(
    bool Function() done, {
    required String what,
    Duration limit = const Duration(seconds: 3),
  }) async {
    final watch = Stopwatch()..start();
    while (true) {
      final frame = await nextFrame();
      if (done()) return frame;
      if (watch.elapsed > limit) {
        throw StateError('Timed out waiting for $what');
      }
    }
  }

  // ---------------------------------------------------------------- windows

  Future<void> _idle() async {
    await _settle(frames: 2, pause: const Duration(seconds: 1));
    final start = wallMicros();
    await Future<void>.delayed(const Duration(seconds: 3));
    final end = wallMicros();
    await clock.settleUntil(end);
    scenarios['idle'] = {
      'description':
          'Focus on a rendered terminal, nothing streaming, no input: what the '
          'app draws on its own.',
      'frames': frameStats(
        clock.between(start, end),
        windowMicros: end - start,
      ),
    };
  }

  Future<void> _stream(String name, StreamLoad load) async {
    final pump = OutputPump(_terminalA, _outputs[_a]!, load)..start();
    try {
      await Future<void>.delayed(const Duration(seconds: 2));
      final start = wallMicros();
      await Future<void>.delayed(Duration(seconds: options.streamSeconds));
      final end = wallMicros();
      await pump.stop();
      await clock.settleUntil(end);
      scenarios[name] = {
        'description': load == StreamLoad.redraw
            ? 'Terminal at the bottom while Claude Code\'s 8-row live region is '
                  'erased and redrawn in place at 20 Hz.'
            : 'Terminal at the bottom while ~60 long lines/s of prose append '
                  'above the live region (3 lines per burst at 20 Hz).',
        'frames': frameStats(
          clock.between(start, end),
          windowMicros: end - start,
        ),
        'output': pump.window(start, end),
        'sessionTakeShare':
            pump.takes
                .where((t) => t.atWall >= start && t.atWall < end)
                .fold<int>(0, (a, t) => a + t.micros) /
            (end - start),
        'retainedPhysicalRows': _terminalA.session.terminal.buffer.lines.length,
      };
    } finally {
      await pump.stop();
    }
  }

  ScrollableState _terminalScrollable() {
    final view = findElement((w) => w is TerminalView)!;
    ScrollableState? found;
    void visit(Element element) {
      if (found != null) return;
      if (element is StatefulElement && element.state is ScrollableState) {
        found = element.state as ScrollableState;
        return;
      }
      element.visitChildElements(visit);
    }

    view.visitChildElements(visit);
    return found!;
  }

  Future<void> _scroll() async {
    final pump = OutputPump(_terminalA, _outputs[_a]!, StreamLoad.redraw)
      ..start();
    try {
      await Future<void>.delayed(const Duration(seconds: 1));
      final scrollable = _terminalScrollable();
      final position = scrollable.position;
      final view = findElement((w) => w is TerminalView)!;
      final box = view.renderObject! as RenderBox;
      final origin = box.localToGlobal(Offset.zero);
      final startPixels = position.pixels;
      var minPixels = startPixels;
      final start = wallMicros();
      var flingsBack = 0;
      var flingsForward = 0;
      // Back through the scrollback: flicks the way a thumb reads upward — a
      // flick every quarter second, each carrying the last one's momentum.
      while (flingsBack < 30 &&
          position.pixels > position.minScrollExtent + 1) {
        final finger = touches.down(
          origin + Offset(box.size.width / 2, box.size.height * 0.3),
        );
        await glide(finger, const Offset(0, 360), steps: 8);
        finger.up();
        flingsBack++;
        await Future<void>.delayed(const Duration(milliseconds: 250));
        if (position.pixels < minPixels) minPixels = position.pixels;
      }
      await Future<void>.delayed(const Duration(milliseconds: 600));
      if (position.pixels < minPixels) minPixels = position.pixels;
      final reachedTop = position.pixels <= position.minScrollExtent + 1;
      // Then a slow read forward: drags that follow the finger.
      for (var i = 0; i < 6; i++) {
        final finger = touches.down(
          origin + Offset(box.size.width / 2, box.size.height * 0.7),
        );
        await glide(
          finger,
          const Offset(0, -300),
          steps: 30,
          interval: const Duration(milliseconds: 16),
        );
        await Future<void>.delayed(const Duration(milliseconds: 60));
        finger.up();
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
      // And back to the bottom, flicking.
      while (flingsForward < 30 &&
          position.pixels < position.maxScrollExtent - 1) {
        final finger = touches.down(
          origin + Offset(box.size.width / 2, box.size.height * 0.7),
        );
        await glide(finger, const Offset(0, -360), steps: 8);
        finger.up();
        flingsForward++;
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
      await Future<void>.delayed(const Duration(milliseconds: 800));
      final end = wallMicros();
      await pump.stop();
      await clock.settleUntil(end);
      scenarios['scroll_read'] = {
        'description':
            'Flicks back through the whole scrollback, six slow drags forward, '
            'and flicks back to the bottom, while the live region redraws at '
            '20 Hz.',
        'frames': frameStats(
          clock.between(start, end),
          windowMicros: end - start,
        ),
        'output': pump.window(start, end),
        'scroll': {
          'startPixels': startPixels,
          'minPixelsReached': minPixels,
          'distanceBackPx': startPixels - minPixels,
          'reachedTop': reachedTop,
          'flicksBack': flingsBack,
          'flicksForward': flingsForward,
          'endPixels': position.pixels,
          'maxScrollExtent': position.maxScrollExtent,
          'retainedPhysicalRows':
              _terminalA.session.terminal.buffer.lines.length,
        },
      };
    } finally {
      await pump.stop();
    }
    // The scroll folded the header away, and only a scroll the other way
    // brings it back. The next scenarios tap it, so they start from a fresh
    // page — the same terminal, remounted at the bottom.
    await tester.pumpWidget(const SizedBox.shrink());
    await _settle(frames: 2);
    await _mountFocus();
  }

  // ----------------------------------------------------------- interactions

  /// Runs [sample] for the warmups and the measured observations, then joins
  /// their frames to FrameTiming and summarizes.
  Future<void> _series(
    String name,
    String load,
    Future<_Observation> Function(bool measured) sample, {
    String? description,
  }) async {
    final rows = <_Observation>[];
    for (var i = -options.warmups; i < options.samples; i++) {
      rows.add(await sample(i >= 0));
    }
    await clock.waitFor([
      for (final row in rows) ...[
        row.previousFrame,
        row.firstFrame,
        row.readyFrame,
      ],
    ]);
    for (final row in rows) {
      final readyBegan = row.extra['readyBeganWallMicros'] as int?;
      row.derive(clock, readyBegan: readyBegan);
    }
    final measured = rows.where((r) => r.measured).toList();
    Map<String, num> dist(String key) =>
        distribution([for (final r in measured) r.derived[key]!]);
    scenarios[name] = {
      'description': ?description,
      'operation': rows.first.operation,
      'load': load,
      'measured': measured.length,
      'warmups': rows.length - measured.length,
      for (final key in [
        'firstRasterMicros',
        'readyRasterMicros',
        'dispatchMicros',
        'buildMicros',
        'rasterMicros',
        'waitForBuildMicros',
        'buildStartToRasterMicros',
        'dispatchAfterPreviousVsyncMicros',
        'previousBuildMicros',
      ])
        key.replaceAll('Micros', 'Ms'): dist(key),
      'framesToReady': distribution([
        for (final r in measured) r.derived['framesToReady']! * 1000,
      ]),
    };
    observations.addAll(rows.map((r) => r.toJson()));
  }

  Element _find(bool Function(Widget) matches, String what) =>
      findElement(matches) ?? (throw StateError('No $what on screen'));

  bool _overlayUp() => findElement((w) => w is TerminalSearchOverlay) != null;

  Future<int> _untilOverlayOpen() => _untilFrame(() {
    final overlay = findElement((w) => w is TerminalSearchOverlay);
    return overlay != null &&
        (overlay.widget as TerminalSearchOverlay).animation.status ==
            AnimationStatus.completed;
  }, what: 'Find to finish opening');

  /// Opens Find the way a person does — a swipe right on the terminal — and waits for it.
  Future<void> _openFindBySwipe() async {
    final view = _find((w) => w is TerminalView, 'terminal');
    final box = view.renderObject! as RenderBox;
    final finger = touches.down(
      box.localToGlobal(Offset(box.size.width * 0.2, box.size.height * 0.5)),
    );
    await nextFrame();
    finger.moveBy(const Offset(30, 0));
    await nextFrame();
    finger.moveBy(const Offset(20, 0));
    await glide(finger, const Offset(220, 0), steps: 11);
    finger.up();
    await _untilOverlayOpen();
  }

  Future<void> _closeFind() async {
    final overlay = findElement((w) => w is TerminalSearchOverlay);
    if (overlay == null) return;
    (overlay.widget as TerminalSearchOverlay).onClose();
    await _untilFrame(() => !_overlayUp(), what: 'Find to close');
    await _settle(frames: 2, pause: const Duration(milliseconds: 120));
  }

  /// A tap: down, one frame, up — timed from the up, which is where a tap
  /// fires. Answers (previous frame, began, dispatched).
  Future<(int, int, int)> _tap(Offset point) async {
    final finger = touches.down(point);
    await nextFrame();
    final previous = await nextFrame();
    final began = finger.up();
    return (previous, began, wallMicros());
  }

  Future<void> _findOpenSwipe() async {
    final dragWindows = <(int, int)>[];
    await _series(
      'find_open_swipe',
      'idle',
      description:
          'Swipe right on the terminal: from the move that crosses touch slop '
          'to the first frame with Find built under the finger (first), and '
          'from the release to the frame its settle animation completes '
          '(ready).',
      (measured) async {
        await _settle(frames: 2, pause: const Duration(milliseconds: 150));
        final view = _find((w) => w is TerminalView, 'terminal');
        final box = view.renderObject! as RenderBox;
        final point = box.localToGlobal(
          Offset(box.size.width * 0.2, box.size.height * 0.5),
        );
        final finger = touches.down(point);
        await nextFrame();
        // Past touch slop: the drag is accepted here, and with the default
        // DragStartBehavior.start acceptance reports a start and NO update —
        // it is the next move that reaches `_onSwipeUpdate` and opens Find.
        finger.moveBy(const Offset(30, 0));
        final previous = await nextFrame();
        final began = finger.moveBy(const Offset(20, 0));
        final dispatched = wallMicros();
        final first = await _untilFrame(
          _overlayUp,
          what: 'Find under the finger',
        );
        await glide(finger, const Offset(220, 0), steps: 11);
        final released = finger.up();
        if (measured) dragWindows.add((began, released));
        final ready = await _untilOverlayOpen();
        await _closeFind();
        return _Observation(
          operation: 'find_open_swipe',
          load: 'idle',
          measured: measured,
          began: began,
          dispatched: dispatched,
          previousFrame: previous,
          firstFrame: first,
          readyFrame: ready,
          extra: {'readyBeganWallMicros': released},
        );
      },
    );
    final frames = [
      for (final (start, end) in dragWindows) ...clock.between(start, end),
    ];
    final dragMicros = dragWindows.fold<int>(0, (a, w) => a + w.$2 - w.$1);
    (scenarios['find_open_swipe']!
        as Map<String, Object?>)['framesWhileDragging'] = frameStats(
      frames,
      windowMicros: dragMicros,
    );
  }

  Element _mic() =>
      _find((w) => w is VoiceMicButton && w.onPressed != null, 'live mic');

  Future<void> _micTap({required bool idle}) async {
    final pump = idle
        ? null
        : (OutputPump(_terminalA, _outputs[_a]!, StreamLoad.redraw)..start());
    try {
      if (pump != null) await Future<void>.delayed(const Duration(seconds: 1));
      await _series(
        idle ? 'mic_tap' : 'mic_tap_streaming',
        idle ? 'idle' : 'redraw',
        description:
            'Tap on the mic orb: first frame whose mic shows the listening face '
            '(fake recorder, opens instantly). Ready = the same frame.',
        (measured) async {
          await _settle(frames: 2, pause: const Duration(milliseconds: 200));
          final mic = _mic();
          final (previous, began, dispatched) = await _tap(
            touches.centerOf(mic),
          );
          bool listening() => findElements((w) => w is VoiceMicButton).any(
            (e) => (e.widget as VoiceMicButton).face == VoiceMicFace.listening,
          );
          final first = await _untilFrame(listening, what: 'the mic to listen');
          fixture.voice.clear();
          await _untilFrame(() => !listening(), what: 'the mic to rest');
          await _settle(frames: 2, pause: const Duration(milliseconds: 250));
          return _Observation(
            operation: 'mic_tap',
            load: idle ? 'idle' : 'redraw',
            measured: measured,
            began: began,
            dispatched: dispatched,
            previousFrame: previous,
            firstFrame: first,
            readyFrame: first,
          );
        },
      );
    } finally {
      await pump?.stop();
    }
  }

  Future<void> _newOpenSwipe() async {
    await _series(
      'new_open_swipe',
      'idle',
      description:
          'Swipe left on the terminal (the release opens it): first frame with '
          'NewAgentPage built, and the frame its Cupertino push transition '
          'completes.',
      (measured) async {
        await _settle(frames: 2, pause: const Duration(milliseconds: 150));
        final view = _find((w) => w is TerminalView, 'terminal');
        final box = view.renderObject! as RenderBox;
        final point = box.localToGlobal(
          Offset(box.size.width * 0.8, box.size.height * 0.5),
        );
        final finger = touches.down(point);
        await nextFrame();
        finger.moveBy(const Offset(-30, 0));
        await glide(finger, const Offset(-90, 0), steps: 5);
        final previous = await nextFrame();
        final began = finger.up();
        final dispatched = wallMicros();
        bool open() => findElement((w) => w is NewAgentPage) != null;
        final first = await _untilFrame(open, what: 'the new-agent page');
        final page = _find((w) => w is NewAgentPage, 'new-agent page');
        final route = ModalRoute.of(page)!;
        final ready = await _untilFrame(
          () => route.animation!.isCompleted,
          what: 'the new-agent push to finish',
        );
        Navigator.of(page).pop();
        await _untilFrame(() => !open(), what: 'the new-agent page to go');
        await _settle(frames: 2, pause: const Duration(milliseconds: 200));
        return _Observation(
          operation: 'new_open_swipe',
          load: 'idle',
          measured: measured,
          began: began,
          dispatched: dispatched,
          previousFrame: previous,
          firstFrame: first,
          readyFrame: ready,
        );
      },
    );
  }

  Future<void> _findSwitch() async {
    await _series(
      'find_switch',
      'idle',
      description:
          'With Find open on one agent, tap the other agent\'s row: first frame '
          'showing the other agent\'s TerminalPage with its terminal. Both '
          'terminals are attached and rendered beforehand; the switch is the '
          'shell\'s onOpenAgent rebuilding the home screen in place.',
      (measured) async {
        final from = _host.currentState!.agentId;
        final to = from == _a ? _b : _a;
        await _settle(frames: 2, pause: const Duration(milliseconds: 150));
        await _openFindBySwipe();
        await _settle(frames: 2, pause: const Duration(milliseconds: 150));
        final row = _find(
          (w) =>
              w is FindRow &&
              w.title == perfAgents.firstWhere((agent) => agent.$1 == to).$2,
          'row for $to',
        );
        final (previous, began, dispatched) = await _tap(touches.centerOf(row));
        final target = fixture.terminals[to]!.session;
        bool switched() =>
            _host.currentState!.agentId == to &&
            findElement(
                  (w) =>
                      w is TerminalView &&
                      identical(w.terminal, target.terminal),
                ) !=
                null;
        final first = await _untilFrame(switched, what: 'the switch to $to');
        await _settle(frames: 2, pause: const Duration(milliseconds: 200));
        return _Observation(
          operation: 'find_switch',
          load: 'idle',
          measured: measured,
          began: began,
          dispatched: dispatched,
          previousFrame: previous,
          firstFrame: first,
          readyFrame: first,
          extra: {'from': from, 'to': to},
        );
      },
    );
    if (_host.currentState?.agentId != _a) {
      _host.currentState!.show(_a);
      await _settle(frames: 3, pause: const Duration(milliseconds: 300));
    }
  }

  // --------------------------------------------------------------- traces

  Future<Map<String, Object?>> _traced(Future<void> Function() action) async {
    debugProfileBuildsEnabled = true;
    debugProfileLayoutsEnabled = true;
    debugProfilePaintsEnabled = true;
    try {
      final timeline = await binding.traceTimeline(
        action,
        streams: const ['Dart', 'Embedder', 'GC'],
      );
      final events = [
        for (final event in timeline.traceEvents ?? const [])
          if (event.json != null) Map<String, dynamic>.from(event.json!),
      ];
      return summarizeTimeline(events);
    } finally {
      debugProfileBuildsEnabled = false;
      debugProfileLayoutsEnabled = false;
      debugProfilePaintsEnabled = false;
    }
  }

  Future<void> _traceIdle() async {
    await _settle(frames: 2, pause: const Duration(seconds: 1));
    traces['idle'] = {
      'description':
          '3 s of the idle page, per-widget events on: anything built or '
          'painted here is drawing with nothing to show.',
      ...await _traced(() => Future<void>.delayed(const Duration(seconds: 3))),
    };
  }

  Future<void> _traceStream(String name, StreamLoad load) async {
    final pump = OutputPump(_terminalA, _outputs[_a]!, load)..start();
    try {
      await Future<void>.delayed(const Duration(seconds: 1));
      traces[name] = {
        'description':
            '3 s of $name with per-widget build, layout and paint events on '
            '(which cost time themselves — these are rankings, not timings).',
        ...await _traced(
          () => Future<void>.delayed(const Duration(seconds: 3)),
        ),
      };
    } finally {
      await pump.stop();
    }
  }

  Future<void> _traceFindOpen() async {
    await _settle(frames: 2, pause: const Duration(milliseconds: 200));
    traces['find_open_tap'] = {
      'description':
          'Five Find opens by tap and their closes, per-widget events on.',
      ...await _traced(() async {
        for (var i = 0; i < 5; i++) {
          await _openFindBySwipe();
          await _closeFind();
        }
      }),
    };
  }

  // -------------------------------------------------------------- control

  /// The same redraw load on the bare [TerminalPanel] — no header, no floating
  /// mic glass, no page — so the page's own share of each frame can be read off
  /// the difference from `stream_redraw`.
  Future<void> _controlPanel() async {
    await tester.pumpWidget(
      perfApp(
        Scaffold(
          body: SafeArea(
            bottom: false,
            child: TerminalPanel(
              notifier: fixture.notifier,
              session: _terminalA.session,
              focused: false,
            ),
          ),
        ),
      ),
    );
    await _settle(frames: 6, pause: const Duration(milliseconds: 500));
    await _stream('control_panel_redraw', StreamLoad.redraw);
    (scenarios['control_panel_redraw']!
            as Map<String, Object?>)['description'] =
        'Control: stream_redraw\'s load on a bare TerminalPanel in a Scaffold '
        '(no TerminalPage chrome: header, mic orb and its blur, swipe layer).';
    await tester.pumpWidget(const SizedBox.shrink());
    await _settle(frames: 2);
  }
}
