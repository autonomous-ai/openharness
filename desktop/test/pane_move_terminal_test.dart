import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('renderer focus changes focus without claiming terminals', (
    tester,
  ) async {
    final app = createApp();
    final sent = <String>[];
    final sessions = [
      for (var i = 0; i < 2; i++)
        TerminalSession(
            machineId: 'm',
            agentId: 'a$i',
            agentName: 'Agent $i',
            engineId: 'codex',
            send: (type, _) async {
              sent.add(type);
              return true;
            },
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-$i',
    ];
    final first = app.adoptSessionForTest(sessions.first);
    final second = app.adoptSessionForTest(sessions.last);
    app.focusPane(first.id);
    app.stateOf('m')!
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true;
    try {
      await mount(tester, app);
      sessions.last.status = TerminalSessionStatus.takenOver;
      sent.clear();
      tester
          .widget<TerminalPanel>(
            find.byWidgetPredicate(
              (w) => w is TerminalPanel && w.session == sessions.last,
            ),
          )
          .onRendererFocus!();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(app.focusedPane, same(second));
      expect(app.paneFocusByUser, isFalse);
      expect(sessions.last.status, TerminalSessionStatus.takenOver);
      expect(sent.where((type) => type == 'terminal_open'), isEmpty);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'Cmd-Shift-M keeps the stream and does not reclaim destination terminals',
    (tester) async {
      final app = createApp();
      final sent = <String>[];
      TerminalSession session(String id) =>
          TerminalSession(
              machineId: 'm',
              agentId: id,
              agentName: id,
              engineId: 'codex',
              send: (type, _) async {
                sent.add('$id:$type');
                return true;
              },
              sendBinary: (_) async => true,
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'stream-$id';
      final moving = session('a0');
      moving.terminal.write('preserve this output');
      final pane = app.adoptSessionForTest(moving);
      final source = app.activeSwarm;
      app.newSwarm(name: 'Destination');
      final destination = app.activeSwarm;
      final other = session('a1')..status = TerminalSessionStatus.takenOver;
      app.adoptSessionForTest(other);
      app.selectSwarm(source.id);
      app.stateOf('m')!
        ..nodeOnline = true
        ..terminalCapabilityAvailable = true;
      try {
        await mount(tester, app);
        final panel = find.byWidgetPredicate(
          (w) => w is TerminalPanel && w.session == moving,
        );
        final before = tester.state(panel);
        sent.clear();

        await chord(tester, LogicalKeyboardKey.keyM, shift: true);
        await tester.pump(const Duration(milliseconds: 300));
        await tester.tap(find.text('Destination').last);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));

        expect(app.activeSwarm, same(destination));
        expect(destination.panes, contains(same(pane)));
        expect(pane.session, same(moving));
        expect(tester.state(panel), same(before));
        expect(
          moving.terminal.buffer.getText(),
          contains('preserve this output'),
        );
        expect(
          sent.where(
            (type) =>
                type.endsWith('terminal_open') ||
                type.endsWith('terminal_close'),
          ),
          isEmpty,
        );
        expect(other.status, TerminalSessionStatus.takenOver);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}
