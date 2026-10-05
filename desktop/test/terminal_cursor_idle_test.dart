import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'support/periodic_timer_probe.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

Future<void> output(
  TerminalSession session,
  int sequence,
  String text, {
  bool keyframe = false,
}) => session.handleBinary(
  TerminalBinaryFrame(
    kind: keyframe ? TerminalBinaryKind.keyframe : TerminalBinaryKind.output,
    streamId: session.streamId!,
    seq: sequence,
    bytes: utf8.encode(text),
    compressed: false,
    cols: keyframe ? 80 : null,
    rows: keyframe ? 24 : null,
  ),
);

class _CursorFixture {
  final AppNotifier app = createApp();
  final session = ValueNotifier(terminal('a0', []));
  final visible = ValueNotifier(true);
  final readOnly = ValueNotifier(false);
  final tickers = ValueNotifier(true);
  final probe = PeriodicTimerProbe();
  final sessions = <TerminalSession>[];
  final pixels = GlobalKey();

  TerminalSession get current => session.value;

  TerminalViewState view(WidgetTester tester) =>
      tester.state<TerminalViewState>(find.byType(TerminalView));

  Future<void> mount(WidgetTester tester) async {
    sessions.add(current);
    await output(current, 0, 'Prompt\x1b[?25l', keyframe: true);
    await tester.pumpWidget(
      MaterialApp(
        home: RepaintBoundary(
          key: pixels,
          child: ListenableBuilder(
            listenable: Listenable.merge([session, visible, readOnly, tickers]),
            builder: (_, _) => TickerMode(
              enabled: tickers.value,
              child: AnimatedBuilder(
                animation: current,
                builder: (_, _) => TerminalPanel(
                  notifier: app,
                  session: current,
                  focused: true,
                  showHeader: false,
                  visible: visible.value,
                  readOnly: readOnly.value,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await focus(tester);
  }

  Future<void> focus(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 100));
    view(tester).widget.focusNode!.requestFocus();
    await tester.pump();
    expect(view(tester).widget.focusNode!.hasFocus, isTrue);
  }

  Future<Color> cursorPixel(WidgetTester tester) async {
    final boundary =
        pixels.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final render = view(tester).renderTerminal;
    final point = boundary.globalToLocal(
      render.localToGlobal(
        render.cursorOffset + render.cellSize.center(Offset.zero),
      ),
    );
    return (await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 1);
      try {
        final bytes = (await image.toByteData(
          format: ui.ImageByteFormat.rawRgba,
        ))!;
        final offset = (point.dy.floor() * image.width + point.dx.floor()) * 4;
        return Color.fromARGB(
          bytes.getUint8(offset + 3),
          bytes.getUint8(offset),
          bytes.getUint8(offset + 1),
          bytes.getUint8(offset + 2),
        );
      } finally {
        image.dispose();
      }
    }))!;
  }

  Future<void> dispose(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    for (final item in sessions) {
      item.dispose();
    }
    app.dispose();
    session.dispose();
    visible.dispose();
    readOnly.dispose();
    tickers.dispose();
    expect(probe.active, 0);
  }
}

Future<void> _withCursor(
  WidgetTester tester,
  Future<void> Function(_CursorFixture fixture) body,
) async {
  final fixture = _CursorFixture();
  await fixture.probe.run(() async {
    try {
      await fixture.mount(tester);
      await body(fixture);
    } finally {
      await fixture.dispose(tester);
    }
  });
}

void main() {
  testWidgets('a remotely hidden cursor has no local blink timer', (
    tester,
  ) async {
    final probe = PeriodicTimerProbe();
    await probe.run(() async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final session = terminal('a0', []);
      await output(session, 0, 'Idle prompt\x1b[?25l', keyframe: true);
      app.adoptSessionForTest(session);
      await tester.pumpWidget(
        MaterialApp(
          home: PaneGrid(
            notifier: app,
            swarmMode: true,
            empty: const SizedBox(),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final view = tester.state<TerminalViewState>(find.byType(TerminalView));
      view.widget.focusNode!.requestFocus();
      await tester.pump();
      expect(view.widget.focusNode!.hasFocus, isTrue);
      expect(session.acceptsInput, isTrue);
      expect(session.terminal.cursorVisibleMode, isFalse);
      final timers = probe.active;
      final before = probe.callbacks;
      for (var tick = 0; tick < 10; tick++) {
        await tester.pump(const Duration(milliseconds: 500));
      }
      final callbacks = probe.callbacks - before;
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      debugPrint('HIDDEN_CURSOR_IDLE timers=$timers callbacks=$callbacks/5s');
      expect(timers, 0);
      expect(callbacks, 0);
      expect(probe.active, 0);
    });
  });

  testWidgets(
    'remote hide/show controls the clock and painted cursor',
    (tester) => _withCursor(tester, (fixture) async {
      final session = fixture.current;
      final background = await fixture.cursorPixel(tester);
      expect(fixture.probe.active, 0);
      await output(session, 1, '\x1b[?25h');
      await tester.pump();
      expect(fixture.probe.active, 1);
      expect(session.terminal.cursorVisibleMode, isTrue);
      final cursor = await fixture.cursorPixel(tester);
      expect(cursor, isNot(background));
      await tester.pump(const Duration(milliseconds: 500));
      expect(session.terminal.cursorVisibleMode, isFalse);
      expect(await fixture.cursorPixel(tester), background);

      // Hiding while the local blink is dark must still stop its timer.
      await output(session, 2, '\x1b[?25l');
      await tester.pump();
      expect(fixture.probe.active, 0);
      final callbacks = fixture.probe.callbacks;
      await tester.pump(const Duration(milliseconds: 1100));
      expect(fixture.probe.callbacks, callbacks);
      expect(await fixture.cursorPixel(tester), background);

      // A split escape sequence takes effect only when it is complete.
      await output(session, 3, '\x1b[?2');
      expect(fixture.probe.active, 0);
      await output(session, 4, '5h');
      await tester.pump();
      expect(fixture.probe.active, 1);
      expect(await fixture.cursorPixel(tester), cursor);
    }),
  );

  for (final gate in ['window', 'ticker', 'pane', 'read only', 'focus']) {
    testWidgets(
      'remote show respects $gate eligibility',
      (tester) => _withCursor(tester, (fixture) async {
        switch (gate) {
          case 'window':
            tester.binding.handleAppLifecycleStateChanged(
              AppLifecycleState.inactive,
            );
          case 'ticker':
            fixture.tickers.value = false;
          case 'pane':
            fixture.visible.value = false;
          case 'read only':
            fixture.readOnly.value = true;
          case 'focus':
            fixture.view(tester).widget.focusNode!.unfocus();
        }
        try {
          await tester.pump();
          await output(fixture.current, 1, '\x1b[?25h');
          await tester.pump(const Duration(milliseconds: 1100));
          expect(fixture.probe.active, 0);
          expect(fixture.current.terminal.cursorVisibleMode, isTrue);
        } finally {
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.resumed,
          );
          fixture.tickers.value = true;
          fixture.visible.value = true;
          fixture.readOnly.value = false;
        }
        await fixture.focus(tester);
        // Native rebuilds run in the engine's callback zone, outside the
        // timer probe's zone. Check the actual resumed blink, not whether that
        // particular clock was created inside the probe.
        expect(fixture.current.terminal.cursorVisibleMode, isTrue);
        await tester.pump(const Duration(milliseconds: 550));
        expect(fixture.current.terminal.cursorVisibleMode, isFalse);
        await output(fixture.current, 2, '\x1b[?25l');
        await tester.pump();
        expect(fixture.probe.active, 0);
      }),
    );
  }

  testWidgets(
    'replacing a session moves the cursor visibility listener',
    (tester) => _withCursor(tester, (fixture) async {
      final previous = fixture.current;
      await output(previous, 1, '\x1b[?25h');
      expect(fixture.probe.active, 1);
      final replacement = terminal('a1', []);
      fixture.sessions.add(replacement);
      await output(replacement, 0, 'Replacement\x1b[?25l', keyframe: true);
      fixture.session.value = replacement;
      await fixture.focus(tester);
      expect(fixture.probe.active, 0);

      await output(previous, 2, '\x1b[?25l');
      await output(previous, 3, '\x1b[?25h');
      expect(fixture.probe.active, 0);
      await output(replacement, 1, '\x1b[?25h');
      expect(fixture.probe.active, 1);

      await tester.pumpWidget(const SizedBox());
      expect(fixture.probe.active, 0);
      await output(replacement, 2, '\x1b[?25l');
      await output(replacement, 3, '\x1b[?25h');
      expect(fixture.probe.active, 0);
      expect(tester.takeException(), isNull);
    }),
  );

  testWidgets(
    'replacement keyframes reconcile visibility without extra clocks',
    (tester) => _withCursor(tester, (fixture) async {
      final session = fixture.current;
      await output(session, 1, 'Reconnected\x1b[?25h', keyframe: true);
      await tester.pump();
      await fixture.focus(tester);
      expect(fixture.view(tester).widget.terminal, same(session.terminal));
      expect(fixture.probe.active, 1);
      await tester.pump(const Duration(milliseconds: 500));
      expect(session.terminal.cursorVisibleMode, isFalse);
      await output(session, 2, 'New screen\x1b[?25l', keyframe: true);
      await tester.pump();
      expect(fixture.probe.active, 0);
      expect(session.terminal.cursorVisibleMode, isFalse);
      expect(session.terminal.buffer.getText(), contains('New screen'));
    }),
  );
}
