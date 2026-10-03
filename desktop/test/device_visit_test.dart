import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

Map<String, dynamic> visit(
  String op, {
  String id = 'visit-one',
  String from = 'a0',
  String target = 'a1',
}) => {
  'requestId': 'request-$op',
  'visitId': id,
  'op': op,
  'expiresAt': DateTime.now().millisecondsSinceEpoch + 2000,
  'fromMachineId': 'm',
  'fromAgentId': from,
  'machineId': 'm',
  'agentId': target,
};

void main() {
  testWidgets('latest output keeps a reading return through repeated peeks', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    session.terminal.write(
      List.generate(200, (i) => 'Reading line $i\r\n').join(),
    );
    final pane = app.adoptSessionForTest(session);
    try {
      await mount(tester, app);
      final finder = find.byWidgetPredicate(
        (w) => w is TerminalView && w.terminal == session.terminal,
      );
      final renderer = tester.state(finder);
      final scroll = tester.widget<TerminalView>(finder).scrollController!;
      scroll.jumpTo(180.5);
      await tester.pump();
      final before = scroll.offset;
      final peek = visit('latest', target: 'a0');
      expect(app.visitFromDevice('m', peek), containsPair('active', true));
      await tester.pump();
      expect(scroll.offset, closeTo(scroll.position.maxScrollExtent, .01));
      session.terminal.write('New output while following\r\n');
      await tester.pump();
      expect(scroll.offset, closeTo(scroll.position.maxScrollExtent, .01));
      // A second Latest is part of the same excursion, not a new bookmark.
      expect(app.visitFromDevice('m', peek)!['ok'], isTrue);
      await tester.pump();
      final back = app.visitFromDevice('m', visit('back'))!;
      expect(back['ok'], isTrue);
      expect(back, isNot(contains('note')));
      await tester.pump();
      expect(scroll.offset, closeTo(before, .01));
      session.terminal.write('New output after returning\r\n');
      await tester.pump();
      expect(scroll.offset, closeTo(before, .01));
      expect(app.focusedPane, same(pane));
      expect(tester.state(finder), same(renderer));
      expect(input, isEmpty);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets('latest then another alert still returns to the original line', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final input = <TerminalBinaryFrame>[];
    final a = terminal('a0', input), b = terminal('a1', input);
    for (final session in [a, b]) {
      session.terminal.write(List.generate(160, (i) => 'line $i\r\n').join());
      app.adoptSessionForTest(session);
    }
    await app.focusAgentFromDevice('m', 'a0');
    try {
      await mount(tester, app);
      final finder = find.byWidgetPredicate(
        (w) => w is TerminalView && w.terminal == a.terminal,
      );
      final scroll = tester.widget<TerminalView>(finder).scrollController!;
      scroll.jumpTo(240.25);
      await tester.pump();
      expect(
        app.visitFromDevice('m', visit('latest', target: 'a0'))!['ok'],
        isTrue,
      );
      await tester.pump();
      expect(app.visitFromDevice('m', visit('open'))!['ok'], isTrue);
      await tester.pump();
      expect(
        app.visitFromDevice('m', visit('latest', from: 'a1'))!['ok'],
        isTrue,
      );
      await tester.pump();
      expect(app.visitFromDevice('m', visit('back'))!['ok'], isTrue);
      await tester.pump();
      expect(app.focusedPane!.agentId, 'a0');
      expect(scroll.offset, closeTo(240.25, .01));
      expect(input, isEmpty);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'latest refuses stale recipients and application-owned scrolling',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      session.terminal.write(List.generate(160, (i) => 'line $i\r\n').join());
      app.adoptSessionForTest(session);
      app.adoptSessionForTest(terminal('a1', input));
      await app.focusAgentFromDevice('m', 'a0');
      try {
        await mount(tester, app);
        final finder = find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == session.terminal,
        );
        final scroll = tester.widget<TerminalView>(finder).scrollController!;
        scroll.jumpTo(200);
        await tester.pump();
        expect(app.visitFromDevice('m', visit('latest'))!['ok'], isFalse);
        expect(
          app.visitFromDevice('m', {
            ...visit('latest', target: 'a0'),
            'expiresAt': 0,
          })!['ok'],
          isFalse,
        );
        expect(scroll.offset, closeTo(200, .01));
        expect(app.focusedPane!.agentId, 'a0');
        session.terminal.write('\x1b[?1049hApplication-owned screen');
        await tester.pump();
        final reply = app.visitFromDevice('m', visit('latest', target: 'a0'))!;
        expect(reply['ok'], isFalse);
        expect(reply['active'], isFalse);
        expect(reply['error'], contains('scrollback'));
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'cross-machine return stays with its window and survives a target disconnect',
    (tester) async {
      final app = createApp(connected: true);
      const machine = Machine(
        machineId: 'remote',
        authMode: MachineAuthMode.remote,
        name: 'Remote',
      );
      app.machines.add(machine);
      app.machineStates['remote'] = MachineState(machine)
        ..nodeOnline = false
        ..agents = [
          Agent(
            id: 'help',
            name: 'Needs help',
            engine: 'codex',
            terminalAvailable: true,
          ),
        ];
      final origin = app.adoptSessionForTest(terminal('a0', []));
      app.newSwarm();
      final input = <TerminalBinaryFrame>[];
      final remote =
          TerminalSession(
              machineId: 'remote',
              agentId: 'help',
              agentName: 'Needs help',
              engineId: 'codex',
              send: (_, _) async => true,
              sendBinary: (frame) async {
                input.add(frame);
                return true;
              },
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'remote-stream';
      app.adoptSessionForTest(remote);
      await app.focusAgentFromDevice('m', 'a0');
      try {
        await mount(tester, app);
        final opened = app.visitFromDevice('m', {
          ...visit('open'),
          'machineId': 'remote',
          'agentId': 'help',
        })!;
        expect(opened, containsPair('ok', true));
        await tester.pump();
        expect(app.focusedPane!.machineId, 'remote');
        expect(app.visitFromDevice('remote', visit('back'))!['ok'], isFalse);
        // An offline visit must still offer a way back; it cannot require a
        // healthy terminal attachment before releasing the original bookmark.
        remote.transportLost('Fixture disconnected');
        await tester.pump();
        expect(app.visitFromDevice('m', visit('back'))!['ok'], isTrue);
        await tester.pump();
        expect(app.focusedPane, same(origin));
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets('return never reopens a closed origin or a replaced tile', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final origin = app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    await app.focusAgentFromDevice('m', 'a0');
    try {
      await mount(tester, app);
      expect(app.visitFromDevice('m', visit('open'))!['ok'], isTrue);
      await tester.pump();
      await app.closePane(origin.id);
      await tester.pump();
      final count = app.allPanes.length;
      final reply = app.visitFromDevice('m', visit('back'))!;
      expect(reply['ok'], isFalse);
      expect(reply['error'], contains('closed'));
      expect(app.allPanes.length, count);
      expect(app.focusedPane!.agentId, 'a1');
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'visit and return retain the pane and reading line after output',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final a = terminal('a0', input), b = terminal('a1', input);
      a.terminal.write(
        List.generate(200, (i) => 'original line $i\r\n').join(),
      );
      b.terminal.write('Please inspect the result.\r\n');
      final origin = app.adoptSessionForTest(a);
      final originTab = app.activeSwarmId;
      app.newSwarm();
      app.adoptSessionForTest(b);
      final targetTab = app.activeSwarmId;
      app.selectSwarm(originTab);
      try {
        await mount(tester, app);
        final finder = find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == a.terminal,
        );
        final renderer = tester.state(finder);
        final view = tester.widget<TerminalView>(finder);
        view.scrollController!.jumpTo(180);
        await tester.pump();
        final pixel = view.scrollController!.offset;
        final count = app.allPanes.length;
        expect(
          app.visitFromDevice('m', visit('open')),
          containsPair('active', true),
        );
        await tester.pump();
        expect(app.activeSwarmId, targetTab);
        expect(app.focusedPane!.agentId, 'a1');
        a.terminal.write('arrived during visit\r\n');
        await tester.pump();
        final result = app.visitFromDevice('m', visit('back'))!;
        expect(result, containsPair('ok', true));
        expect(result, isNot(contains('note')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(app.focusedPane, same(origin));
        expect(app.activeSwarmId, originTab);
        expect(tester.state(finder), same(renderer));
        expect(view.scrollController!.offset, closeTo(pixel, .01));
        expect(app.allPanes.length, count);
        expect(app.paneFocusByUser, isFalse);
        expect(input, isEmpty);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'visiting several alerts returns to the original work, never the last alert',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      for (var i = 0; i < 3; i++) {
        app.adoptSessionForTest(terminal('a$i', input));
      }
      await app.focusAgentFromDevice('m', 'a0');
      try {
        await mount(tester, app);
        expect(app.visitFromDevice('m', visit('open'))!['ok'], isTrue);
        await tester.pump();
        expect(
          app.visitFromDevice(
            'm',
            visit('open', from: 'a1', target: 'a2'),
          )!['ok'],
          isTrue,
        );
        await tester.pump();
        expect(app.visitFromDevice('m', visit('back'))!['ok'], isTrue);
        await tester.pump();
        expect(app.focusedPane!.agentId, 'a0');
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets('dialogs and stale commands cannot navigate behind a picker', (
    tester,
  ) async {
    final app = createApp(connected: true);
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    await app.focusAgentFromDevice('m', 'a0');
    try {
      await mount(tester, app);
      final context = tester.element(find.byType(TerminalView).first);
      final dialog = showDialog<void>(
        context: context,
        builder: (_) => const AlertDialog(content: TextField(autofocus: true)),
      );
      await tester.pumpAndSettle();
      expect(app.visitFromDevice('m', visit('open'))!['ok'], isFalse);
      expect(app.focusedPane!.agentId, 'a0');
      Navigator.of(context).pop();
      await dialog;
      await tester.pumpAndSettle();
      expect(
        app.visitFromDevice('m', {...visit('open'), 'expiresAt': 0})!['ok'],
        isFalse,
      );
      expect(
        app.visitFromDevice('m', visit('open', from: 'a9'))!['ok'],
        isFalse,
      );
      expect(app.visitFromDevice('m', visit('open'))!['ok'], isTrue);
      await tester.pump();
      await app.focusAgentFromDevice('m', 'a0');
      await tester.pump();
      expect(app.visitFromDevice('m', visit('back'))!['ok'], isFalse);
      expect(app.focusedPane!.agentId, 'a0');
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'a replaced stream returns to its pane without claiming its old text',
    (tester) async {
      final app = createApp(connected: true);
      final a = terminal('a0', []);
      app.adoptSessionForTest(a);
      app.adoptSessionForTest(terminal('a1', []));
      await app.focusAgentFromDevice('m', 'a0');
      try {
        await mount(tester, app);
        expect(app.visitFromDevice('m', visit('open'))!['ok'], isTrue);
        await tester.pump();
        a.streamId = 'new-stream';
        final result = app.visitFromDevice('m', visit('back'))!;
        expect(result['ok'], isTrue);
        expect(result['note'], contains('no longer available'));
        await tester.pump();
        expect(app.focusedPane!.agentId, 'a0');
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}
