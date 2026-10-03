import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show output, terminalView;

void main() {
  testWidgets(
    'a tall captured screen keeps its latest rows in a new smaller pane',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      app.adoptSessionForTest(session);
      await mount(tester, app);
      final snapshot = StringBuffer(
        '\x1bc\x1b[?1049l\x1b[?25l\x1b[?7l\x1b[H\x1b[2J',
      );
      for (var i = 0; i < 500; i++) {
        snapshot.write('Earlier output $i\x1b[0m\r\n');
      }
      snapshot.write('${'\r\n' * 100}\x1b[H\x1b[2J');
      for (var row = 1; row <= 100; row++) {
        snapshot.write('\x1b[$row;1HCurrent output $row\x1b[0m');
      }
      snapshot.write('\x1b[1;1H\x1b[?7h\x1b[?25l');
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: session.streamId!,
          seq: 0,
          compressed: false,
          cols: 120,
          rows: 100,
          bytes: utf8.encode(snapshot.toString()),
        ),
      );
      expect(session.terminal.buffer.getText(), contains('Current output 100'));
      final requested = <(int, int)>[];
      final resize = session.terminal.onResize;
      session.terminal.onResize = (cols, rows, width, height) {
        requested.add((cols, rows));
        resize?.call(cols, rows, width, height);
      };
      await tester.pump();
      expect(session.terminal.buffer.getText(), contains('Current output 100'));
      expect(
        session.terminal.viewHeight,
        100,
        reason: 'The remote screen stays intact until its resized replacement arrives',
      );
      expect(requested, hasLength(1));
      expect(requested.single.$2, lessThan(100));
      final scroll = terminalView(tester, session).widget.scrollController!;
      expect(scroll.offset, scroll.position.maxScrollExtent);
      for (var i = 0; i < 5; i++) {
        session.terminal.write('\x1b[1;1HWorking');
        await tester.pump();
      }
      expect(
        requested,
        hasLength(1),
        reason: 'Output does not repeat the resize request',
      );
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: session.streamId!,
          seq: 1,
          compressed: false,
          cols: requested.single.$1,
          rows: requested.single.$2,
          bytes: utf8.encode('Resized output\r\nLatest response'),
        ),
      );
      await tester.pump();
      expect(session.terminal.viewHeight, requested.single.$2);
      expect(session.terminal.buffer.getText(), contains('Latest response'));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
  testWidgets(
    'incremental project loading and layout changes keep fresh views at the latest output',
    (tester) async {
      final app = createApp();
      final sessions = [for (var i = 0; i < 5; i++) terminal('a$i', [])];
      final history = List.generate(500, (i) => 'Output line $i\r\n').join();
      app.adoptSessionForTest(sessions.first);
      await mount(tester, app);
      tester.view.physicalSize = const Size(2000, 1240);
      await output(sessions.first, 0, history, keyframe: true);
      await tester.pump();
      for (final session in sessions.skip(1)) {
        app.adoptSessionForTest(session);
        await tester.pump();
        await output(session, 0, history, keyframe: true);
        await tester.pump();
      }
      app.setPreset(5, PanePreset.cols4);
      await tester.pump();
      for (final session in sessions) {
        final scroll = terminalView(tester, session).widget.scrollController!;
        expect(scroll.offset, scroll.position.maxScrollExtent);
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
  for (final delayed in [false, true]) {
    testWidgets(
      'five fresh agent views start at the latest output (delayed=$delayed)',
      (tester) async {
        final app = createApp();
        final sessions = [for (var i = 0; i < 5; i++) terminal('a$i', [])];
        final history = List.generate(500, (i) => 'Output line $i\r\n').join();
        for (final session in sessions) {
          if (!delayed) session.terminal.write(history);
          app.adoptSessionForTest(session);
        }
        await mount(tester, app);
        if (delayed) {
          for (final session in sessions) {
            await output(session, 0, history, keyframe: true);
          }
          await tester.pump();
        }
        for (final session in sessions) {
          final scroll = terminalView(tester, session).widget.scrollController!;
          expect(scroll.position.maxScrollExtent, greaterThan(0));
          expect(scroll.offset, scroll.position.maxScrollExtent);
        }
        // Reopening an agent reveals current output in each retained view.
        final first = terminalView(tester, sessions.first);
        final scroll = first.widget.scrollController!;
        scroll.jumpTo(100);
        await tester.pump();
        final original = app.activeSwarmId;
        app.newSwarm();
        await tester.pump();
        app.selectSwarm(original);
        await tester.pump();
        expect(terminalView(tester, sessions.first), same(first));
        expect(scroll.offset, scroll.position.maxScrollExtent);
        expect(find.byType(TerminalView), findsNWidgets(5));
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }
  testWidgets(
    'a fresh hidden terminal follows its keyframe when its tab is opened',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      app.adoptSessionForTest(session);
      final original = app.activeSwarmId;
      await mount(tester, app);
      app.newSwarm();
      await tester.pump();
      final history = List.generate(500, (i) => 'Output line $i\r\n').join();
      await output(session, 0, history, keyframe: true);
      await tester.pump();
      app.selectSwarm(original);
      await tester.pump();
      final scroll = terminalView(tester, session).widget.scrollController!;
      expect(scroll.position.maxScrollExtent, greaterThan(0));
      expect(scroll.offset, scroll.position.maxScrollExtent);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('a relayout reveals the latest output in every pane', (
    tester,
  ) async {
    final app = createApp();
    final sessions = [for (var i = 0; i < 4; i++) terminal('a$i', [])];
    final history = List.generate(500, (i) => 'Output line $i\r\n').join();
    for (final session in sessions) {
      session.terminal.write(history);
      app.adoptSessionForTest(session);
    }
    await mount(tester, app);
    final reading = terminalView(
      tester,
      sessions.first,
    ).widget.scrollController!;
    reading.jumpTo(100);
    await tester.pump();
    final before = terminalView(tester, sessions.first).renderTerminal.size;
    app.setPreset(4, PanePreset.mainAndStack);
    await tester.pump();
    expect(app.presetFor(4), PanePreset.mainAndStack);
    expect(
      terminalView(tester, sessions.first).renderTerminal.size,
      isNot(before),
    );
    expect(reading.offset, reading.position.maxScrollExtent);
    for (final session in sessions.skip(1)) {
      final scroll = terminalView(tester, session).widget.scrollController!;
      expect(scroll.offset, scroll.position.maxScrollExtent);
    }
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
