import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/remote_scroll_physics.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_typography.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:xterm/xterm.dart';
// The mirror and the render object are not exported; the benchmark reads where
// the rows are drawn from them.
// ignore: implementation_imports
import 'package:xterm/src/ui/render.dart';
// ignore: implementation_imports
import 'package:xterm/src/utils/input_trace.dart';

import '../perf/frames.dart';
import '../perf/gestures.dart';
import '../perf/perf_binding.dart';
import 'program.dart';

/// What to run, from `--dart-define`s — see `integration_test/README.md`.
class ClaudeScrollOptions {
  const ClaudeScrollOptions({
    required this.program,
    required this.port,
    required this.bridgeDelayMs,
    required this.fakeOneWayMs,
    required this.fakeDrawMs,
    required this.rounds,
    required this.scenarios,
  });

  factory ClaudeScrollOptions.fromEnvironment() {
    const only = String.fromEnvironment('CLAUDE_SCROLL_SCENARIOS');
    return ClaudeScrollOptions(
      program: const String.fromEnvironment(
        'CLAUDE_SCROLL_PROGRAM',
        defaultValue: 'fake',
      ),
      port: const int.fromEnvironment('CLAUDE_BRIDGE_PORT', defaultValue: 8765),
      bridgeDelayMs: const int.fromEnvironment('CLAUDE_BRIDGE_DELAY_MS'),
      fakeOneWayMs: const int.fromEnvironment(
        'CLAUDE_FAKE_ONE_WAY_MS',
        defaultValue: 30,
      ),
      fakeDrawMs: const int.fromEnvironment(
        'CLAUDE_FAKE_DRAW_MS',
        defaultValue: 40,
      ),
      rounds: const int.fromEnvironment(
        'CLAUDE_SCROLL_ROUNDS',
        defaultValue: 3,
      ),
      scenarios: only.isEmpty
          ? null
          : only.split(',').map((s) => s.trim()).toSet(),
    );
  }

  final String program;
  final int port;
  final int bridgeDelayMs;
  final int fakeOneWayMs;
  final int fakeDrawMs;
  final int rounds;
  final Set<String>? scenarios;

  bool wants(String name) =>
      scenarios == null || scenarios!.any((s) => name.startsWith(s));

  Map<String, Object?> toJson() => {
    'program': program,
    'port': program == 'live' ? port : null,
    'bridgeDelayMs': program == 'live' ? bridgeDelayMs : null,
    'fakeOneWayMs': program == 'fake' ? fakeOneWayMs : null,
    'fakeDrawMs': program == 'fake' ? fakeDrawMs : null,
    'rounds': rounds,
  };
}

/// One frame's look at the scroll: where the finger (or its fling) has the
/// scrollable, and where the rows that scroll are drawn — both in rows.
class _Sample {
  _Sample(
    this.wall,
    this.frame,
    this.pixels,
    this.content,
    this.active, {
    this.bottom,
    this.top,
    this.remote,
    this.generation = 0,
  });

  final int wall;
  final int frame;
  final double pixels;

  /// The document row drawn at the top of the rows that scroll — the mirror's
  /// while it draws them, else the program's own — or null: nothing to say.
  final double? content;
  final bool active;

  /// Where the transcript's newest and oldest rows put the content — the fake
  /// program knows both; for a real one, the oldest once a page up has gone
  /// nowhere.
  final double? bottom;
  final double? top;

  /// The document row at the top of the program's own screen.
  final double? remote;

  /// Which numbering [content] is in: a new mirror, or one whose document
  /// started again, numbers its rows afresh — not the rows moving.
  final int generation;
}

/// Claude Code's fullscreen scroll on the phone, measured against what a native
/// list does: the rows move exactly as far as the finger, every frame, and
/// stop when it does.
class ClaudeScrollBench {
  /// [openInApp], when given, opens a real agent's terminal in the real app
  /// and answers how to read its emulator — which a keyframe replaces — in
  /// place of the benchmark's own view over a program it runs.
  ClaudeScrollBench(
    this.tester,
    this.binding,
    this.options, {
    this.openInApp,
    this.beforeScenario,
  });

  final WidgetTester tester;
  final PerfBinding binding;
  final ClaudeScrollOptions options;
  final Future<Terminal Function()> Function()? openInApp;

  /// Run before each scenario's gestures — in the app, holding the terminal.
  final Future<void> Function()? beforeScenario;

  final results = <String, Object?>{};
  final failures = <String, String>{};
  final _samples = <_Sample>[];
  final _traces = <(int, String)>[];
  late final FrameClock _clock;
  late final Touches _touches;
  ScrollProgram? _program;
  final _terminal = Terminal(maxLines: 1000);

  /// The app's own emulator of the agent, when [openInApp] opened one.
  Terminal Function()? _appTerminal;

  Terminal get _screen => _appTerminal?.call() ?? _terminal;
  final _controller = TerminalController();
  var _memory = RemoteScrollMemory();
  var _viewKey = UniqueKey();
  bool _sampling = false;

  /// What [_sample] reads every frame, found once per measurement: the view
  /// is small, but a tree walk inside the frames being timed is still work.
  ScrollableState? _scrollState;
  RenderTerminal? _renderTerminal;

  /// The mirror last sampled, and how many have been: a new one numbers its
  /// rows afresh.
  Object? _lastMirror;
  int _mirrors = 0;

  Future<void> run() async {
    await WakelockPlus.enable();
    _clock = FrameClock();
    _touches = Touches(binding);
    xtermInputTrace = (message) {
      if (message.startsWith('mirror:')) _traces.add((wallMicros(), message));
    };
    SchedulerBinding.instance.addPersistentFrameCallback(_sample);
    try {
      final open = openInApp;
      if (open != null) {
        _appTerminal = await open();
      } else {
        await _mount();
        final program = _program = _makeProgram();
        _terminal.onOutput = program.input;
        await program.start(_terminal);
      }
      await _waitForPrompt();
      results['grid'] = '${_screen.viewWidth}x${_screen.viewHeight}';
      results['refreshRate'] =
          ui.PlatformDispatcher.instance.views.first.display.refreshRate;
      final rounds = <Map<String, Object?>>[];
      for (var round = 0; round < options.rounds; round++) {
        rounds.add(await _round(round));
      }
      results['rounds'] = rounds;
      results['summary'] = _summarize(rounds);
      results['programAfter'] = _program?.describe() ?? {'program': 'app'};
    } finally {
      xtermInputTrace = null;
      _clock.dispose();
      await WakelockPlus.disable();
    }
    results['options'] = options.toJson();
    results['failures'] = failures;
    results['success'] = failures.isEmpty;
  }

  void dispose() {
    _program?.dispose();
  }

  ScrollProgram _makeProgram() {
    if (options.program == 'live') {
      return LiveClaudeCode(options.port, extraDelayMs: options.bridgeDelayMs);
    }
    return FakeClaudeCode(
      oneWay: Duration(milliseconds: options.fakeOneWayMs),
      draw: Duration(milliseconds: options.fakeDrawMs),
    );
  }

  /// The terminal as the phone shows Claude Code: its own font, no app scaling,
  /// and the alternate screen's scroll as `TerminalPanel` sets it up.
  Future<void> _mount() async {
    final choice = TerminalFontChoice.defaultOn(TerminalFontHost.current);
    final style = TerminalStyle(
      fontSize: terminalFontSize,
      fontFamily: choice.fontFamily,
      fontFamilyFallback: choice.fontFamilyFallback,
    );
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          backgroundColor: Colors.black,
          body: SafeArea(
            child: TerminalView(
              _terminal,
              key: _viewKey,
              controller: _controller,
              textStyle: style,
              textScaler: TextScaler.noScaling,
              autofocus: false,
              altBufferScrollPhysics: const RemoteScrollPhysics(),
              altBufferScrollPaced: true,
              altBufferScrollAnimated: true,
              altBufferScrollMirror: true,
              altBufferScrollPageKeys: true,
              altBufferScrollMemory: _memory,
            ),
          ),
        ),
      ),
    );
    await _frames(3);
  }

  /// A new view and a new memory: the next scroll is the first this agent's
  /// terminal has seen, as on opening it.
  Future<void> _remount() async {
    _memory = RemoteScrollMemory();
    _viewKey = UniqueKey();
    await _mount();
  }

  Future<void> _frames(int count) async {
    for (var i = 0; i < count; i++) {
      await nextFrame();
    }
  }

  Future<void> _wait(int ms) =>
      Future<void>.delayed(Duration(milliseconds: ms));

  Future<void> _waitForPrompt() async {
    final watch = Stopwatch()..start();
    while (watch.elapsed < const Duration(seconds: 90)) {
      final screen = _screen;
      final lines = screen.buffer.lines;
      final ready =
          screen.isUsingAltBuffer &&
          [
            for (var i = 0; i < screen.viewHeight && i < lines.length; i++)
              lines[i].getText(),
          ].any((text) => text.trimLeft().startsWith('❯')) &&
          _scrollable() != null;
      if (ready) {
        results['readyMs'] = watch.elapsedMilliseconds;
        await _wait(1500);
        return;
      }
      await _wait(100);
      await nextFrame();
    }
    throw StateError('Claude Code never showed its prompt');
  }

  /// The view of the terminal measured — in the app, the one showing the
  /// agent, not a neighbour the pager built ahead.
  Element? _view() => findElement(
    (w) =>
        w is TerminalView &&
        (openInApp == null || identical(w.terminal, _screen)),
  );

  ScrollableState? _scrollable() {
    final view = _view();
    if (view == null) return null;
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
    return found;
  }

  RenderTerminal? _render() {
    final view = _view();
    if (view == null) return null;
    RenderTerminal? found;
    void visit(Element element) {
      if (found != null) return;
      if (element.renderObject is RenderTerminal) {
        found = element.renderObject! as RenderTerminal;
        return;
      }
      element.visitChildElements(visit);
    }

    view.visitChildElements(visit);
    return found;
  }

  void _sample(Duration _) {
    if (!_sampling) return;
    final position = _scrollState?.position;
    final render = _renderTerminal;
    if (position == null || render == null) return;
    final mirror = render.debugRemoteScrollMirror;
    final lineHeight = render.lineHeight;
    double? content;
    double? bottom;
    double? top;
    double? remote;
    var active = false;
    if (mirror != null && lineHeight > 0) {
      active = mirror.isActive;
      final at = mirror.display + mirror.offset / lineHeight;
      remote = at;
      content = active ? mirror.display : at;
      final program = _program;
      if (program is FakeClaudeCode) {
        bottom = at + program.rowsBelow;
        top = at - program.rowsAbove;
      } else {
        final first = mirror.debugTranscriptTop;
        if (first != null) top = (first - mirror.top).toDouble();
      }
    }
    if (!identical(mirror, _lastMirror)) {
      _lastMirror = mirror;
      _mirrors++;
    }
    _samples.add(
      _Sample(
        wallMicros(),
        currentFrameNumber(),
        position.pixels / math.max(1, lineHeight),
        content,
        active,
        bottom: bottom,
        top: top,
        remote: remote,
        generation: _mirrors * 100000 + (mirror?.debugRenumbered ?? 0),
      ),
    );
  }

  Offset _at(double heightShare) {
    final view = _view()!;
    final box = view.renderObject! as RenderBox;
    return box.localToGlobal(
      Offset(box.size.width / 2, box.size.height * heightShare),
    );
  }

  Future<Map<String, Object?>> _round(int round) async {
    final scenarios = <String, Object?>{};
    // Every round from the newest row, as an agent is opened, and the first
    // scroll on a freshly opened terminal: nothing known yet. The app's own
    // terminal is opened once — its first round's first drag is the cold one.
    if (openInApp == null) {
      final program = _program;
      if (program is FakeClaudeCode) program.scrollToBottom();
      await _remount();
    }
    await _wait(2000);
    if (options.wants('first_drag')) {
      scenarios['first_drag'] = await _measure('first_drag', () async {
        await _drag(fromShare: 0.35, dy: 260, steps: 26);
      });
    }
    await _wait(1800);
    if (options.wants('read_drag')) {
      scenarios['read_drag'] = await _measure('read_drag', () async {
        for (var i = 0; i < 5; i++) {
          await _drag(fromShare: 0.3, dy: 300, steps: 30);
          await _wait(200);
        }
      });
    }
    // A screen read before the thumb goes looking further back.
    await _wait(4000);
    if (options.wants('flick_up')) {
      scenarios['flick_up'] = await _measure('flick_up', () async {
        for (var i = 0; i < 8; i++) {
          await _flick(fromShare: 0.3, dy: 340);
          await _wait(260);
        }
      });
    }
    // And on at once, into rows nobody has fetched: as fast as the program
    // brings them, at best.
    await _wait(300);
    if (options.wants('flick_deep')) {
      scenarios['flick_deep'] = await _measure('flick_deep', () async {
        for (var i = 0; i < 6; i++) {
          await _flick(fromShare: 0.3, dy: 340);
          await _wait(260);
        }
      });
    }
    await _wait(1800);
    if (options.wants('flick_down')) {
      scenarios['flick_down'] = await _measure('flick_down', () async {
        for (var i = 0; i < 16; i++) {
          await _flick(fromShare: 0.7, dy: -340);
          await _wait(260);
        }
      });
    }
    await _wait(1200);
    return {'round': round, ...scenarios};
  }

  /// A finger that follows the content: [dy] logical pixels in [steps] moves a
  /// frame apart, then held a moment so it lifts with no fling.
  Future<void> _drag({
    required double fromShare,
    required double dy,
    required int steps,
  }) async {
    // A move each refresh, as a finger is sampled — 120 times a second on a
    // 120 Hz phone — over the time [steps] moves 16 ms apart would take.
    final interval = Duration(microseconds: _budgetMicros);
    final moves = (steps * 16000 / _budgetMicros).round();
    final finger = _touches.down(_at(fromShare));
    await glide(finger, Offset(0, dy), steps: moves, interval: interval);
    await _wait(120);
    finger.up();
  }

  /// A thumb's flick: [dy] in eight moves 8 ms apart, lifted moving.
  Future<void> _flick({required double fromShare, required double dy}) async {
    final finger = _touches.down(_at(fromShare));
    await glide(finger, Offset(0, dy), steps: 8);
    finger.up();
  }

  Future<Map<String, Object?>> _measure(
    String name,
    Future<void> Function() gesture,
  ) async {
    await beforeScenario?.call();
    _samples.clear();
    final tracesFrom = _traces.length;
    _scrollState = _scrollable();
    _renderTerminal = _render();
    _sampling = true;
    final start = wallMicros();
    try {
      await gesture();
      // The fling runs out, the screen settles, the program comes back.
      await _waitUntilStill();
    } catch (error) {
      failures[name] = '$error';
    }
    final end = wallMicros();
    _sampling = false;
    await _clock.settleUntil(end);
    final frames = _clock.between(start, end);
    final first = _samples.isEmpty ? start : _samples.first.wall;
    String? fixed(double? value) => value?.toStringAsFixed(2);
    return {
      'frames': _frameSummary(frames, end - start),
      'follow': _follow(List.of(_samples)),
      // Every frame: [ms since the first, finger row, content row, drawn from
      // the mirror, the transcript's newest row there, the program's row].
      'samples': [
        for (final s in _samples)
          [
            (s.wall - first) ~/ 1000,
            fixed(s.pixels),
            fixed(s.content),
            s.active ? 1 : 0,
            fixed(s.bottom),
            fixed(s.remote),
          ],
      ],
      'trace': [
        for (final (at, line) in _traces.skip(tracesFrom).take(600))
          '${(at - first) ~/ 1000} $line',
      ],
      'mirror': [
        for (final (_, line) in _traces.skip(tracesFrom))
          if (line.startsWith('mirror: done') ||
              line.contains('not placed') ||
              line.contains('did not come back') ||
              line.contains('drawing from the document') ||
              line.contains('starting again'))
            line,
      ],
    };
  }

  /// Until nothing has moved for 600 ms, the mirror is drawing live again, or
  /// 6 s have gone by.
  Future<void> _waitUntilStill() async {
    final watch = Stopwatch()..start();
    var stillSince = watch.elapsedMilliseconds;
    double? lastPixels;
    double? lastContent;
    while (watch.elapsedMilliseconds < 6000) {
      await _wait(50);
      await nextFrame();
      final position = _scrollState?.position;
      final mirror = _renderTerminal?.debugRemoteScrollMirror;
      final pixels = position?.pixels;
      final content = mirror?.display;
      if (pixels != lastPixels || content != lastContent) {
        stillSince = watch.elapsedMilliseconds;
      }
      lastPixels = pixels;
      lastContent = content;
      final active = mirror?.isActive ?? false;
      if (!active && watch.elapsedMilliseconds - stillSince > 600) return;
    }
  }

  /// One refresh of this phone's display: 8.3 ms on a 120 Hz Android, 16.7
  /// on the iPhone 14.
  int get _budgetMicros {
    final rate = ui.PlatformDispatcher.instance.views.first.display.refreshRate;
    return rate > 0 ? (1e6 / rate).round() : frameBudgetMicros;
  }

  Map<String, Object?> _frameSummary(List<ui.FrameTiming> frames, int window) {
    final stats = frameStats(
      frames,
      windowMicros: window,
      budgetMicros: _budgetMicros,
    );
    stats.remove('raw');
    stats.remove('rawColumns');
    return stats;
  }

  /// Frame by frame, how far the rows moved against how far the finger did.
  Map<String, Object?> _follow(List<_Sample> samples) {
    final errors = <int>[];
    var fingerRows = 0.0;
    var contentRows = 0.0;
    var stalls = 0;
    var jumps = 0;
    var moving = 0;
    var atEnd = 0;
    var renumbered = 0;
    var activeFrames = 0;
    var afterStopRows = 0.0;
    int? firstActiveMs;
    int? lastFingerMoveIndex;
    for (var i = 1; i < samples.length; i++) {
      final a = samples[i - 1];
      final b = samples[i];
      final finger = b.pixels - a.pixels;
      if (finger.abs() > 0.001) lastFingerMoveIndex = i;
    }
    for (var i = 1; i < samples.length; i++) {
      final a = samples[i - 1];
      final b = samples[i];
      if (b.active) {
        activeFrames++;
        firstActiveMs ??= ((b.wall - samples.first.wall) / 1000).round();
      }
      final ca = a.content;
      final cb = b.content;
      if (ca == null || cb == null) continue;
      if (a.generation != b.generation) {
        renumbered++;
        continue;
      }
      final finger = b.pixels - a.pixels;
      final content = cb - ca;
      final stopped = lastFingerMoveIndex != null && i > lastFingerMoveIndex;
      if (stopped) {
        afterStopRows += content.abs();
        continue;
      }
      if (finger.abs() < 0.001 && content.abs() < 0.001) continue;
      // At an end of the transcript a native list stops too.
      final bottom = b.bottom;
      final top = b.top;
      if (bottom != null && finger > 0 && cb >= bottom - 0.05 ||
          top != null && finger < 0 && cb <= top + 0.05) {
        atEnd++;
        continue;
      }
      moving++;
      fingerRows += finger;
      contentRows += content;
      final error = (content - finger).abs();
      errors.add((error * 1000).round());
      if (finger.abs() >= 0.25 && content.abs() < 0.05) stalls++;
      // Further than the finger by two rows or more, or the other way: a
      // lurch. Short of it is a screen waiting for rows, counted above.
      if (content * finger < 0 && content.abs() >= 1 ||
          content.abs() - finger.abs() >= 2) {
        jumps++;
      }
    }
    errors.sort();
    double at(double q) =>
        errors.isEmpty ? 0 : errors[(errors.length * q).ceil() - 1] / 1000;
    return {
      'movingFrames': moving,
      'framesAtAnEnd': atEnd,
      // The document started again (a keyframe, a frame not placed): the
      // screen may have jumped there by an amount this cannot tell.
      'renumbered': renumbered,
      'mirrorFrames': activeFrames,
      'firstMirrorFrameMs': firstActiveMs,
      'fingerRows': _round2(fingerRows),
      'contentRows': _round2(contentRows),
      // Rows the finger moved that the content never did — what was let go at
      // the edge of what is known, and the lead of a fling over the screen.
      'rowsBehind': _round2((fingerRows - contentRows).abs()),
      'errorRowsP50': at(.5),
      'errorRowsP95': at(.95),
      'errorRowsMax': at(1),
      'stalledFrames': stalls,
      'jumpFrames': jumps,
      // Moved after the finger and its fling had stopped: the glide to a whole
      // row is under one; more is the screen moving by itself.
      'rowsAfterStop': _round2(afterStopRows),
    };
  }

  static double _round2(double value) => (value * 100).round() / 100;

  /// Every round's scenarios pooled: their medians, side by side.
  Map<String, Object?> _summarize(List<Map<String, Object?>> rounds) {
    final out = <String, Object?>{};
    final names = <String>{
      for (final round in rounds) ...round.keys.where((k) => k != 'round'),
    };
    for (final name in names) {
      final follows = [
        for (final round in rounds)
          if (round[name] case {'follow': final Map<String, Object?> follow})
            follow,
      ];
      final frames = [
        for (final round in rounds)
          if (round[name] case {'frames': final Map<String, Object?> frames})
            frames,
      ];
      num median(Iterable<num> values) {
        final sorted = values.toList()..sort();
        return sorted.isEmpty ? 0 : sorted[sorted.length ~/ 2];
      }

      num pick(Map<String, Object?> map, String key) => (map[key] as num?) ?? 0;
      out[name] = {
        for (final key in [
          'fingerRows',
          'contentRows',
          'rowsBehind',
          'errorRowsP50',
          'errorRowsP95',
          'errorRowsMax',
          'stalledFrames',
          'jumpFrames',
          'rowsAfterStop',
          'firstMirrorFrameMs',
        ])
          key: median(follows.map((f) => pick(f, key))),
        'framesOverBudget': median(
          frames.map(
            (f) => pick(
              f['framesOverBudget']! as Map<String, Object?>,
              'totalSpan',
            ),
          ),
        ),
        'buildP95Ms': median(
          frames.map(
            (f) => pick(f['buildMs']! as Map<String, Object?>, 'p95Ms'),
          ),
        ),
        'rasterP95Ms': median(
          frames.map(
            (f) => pick(f['rasterMs']! as Map<String, Object?>, 'p95Ms'),
          ),
        ),
      };
    }
    return out;
  }
}
