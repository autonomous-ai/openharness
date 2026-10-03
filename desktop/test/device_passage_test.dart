import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show output;

Map<String, dynamic> command(
  String op,
  int revision, {
  String agent = 'a0',
  Map<String, dynamic> extra = const {},
}) => {
  'requestId': 'request-$revision',
  'selectionId': 'selection-one',
  'agentId': agent,
  'machineId': 'm',
  'revision': revision,
  'op': op,
  ...extra,
};

void main() {
  testWidgets('a covered terminal cannot be selected through a dialog', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, 'Private work under a picker\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    try {
      await mount(tester, app);
      final context = tester.element(find.byType(TerminalView));
      final dialog = showDialog<void>(
        context: context,
        builder: (_) => const AlertDialog(content: TextField(autofocus: true)),
      );
      await tester.pumpAndSettle();
      expect(app.selectDevicePassage('m', command('begin', 1))!['ok'], isFalse);
      Navigator.of(context).pop();
      await dialog;
      await tester.pumpAndSettle();
      expect(app.selectDevicePassage('m', command('begin', 1))!['ok'], isTrue);
      expect(input, isEmpty);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'device chooses, extends, pins and cancels text without agent input',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(
        session,
        0,
        List.generate(30, (i) => 'line $i: a useful sentence').join('\r\n'),
        keyframe: true,
      );
      app.adoptSessionForTest(session);
      try {
        await mount(tester, app);
        final first = app.selectDevicePassage('m', command('begin', 1))!;
        expect(first, containsPair('ok', true));
        expect(first['excerpt'], contains('useful sentence'));
        await tester.pump();
        expect(find.text('Device: choose a line'), findsOneWidget);
        expect(
          app.selectDevicePassage(
            'm',
            command('extend', 2, extra: {'extend': true}),
          )!['ok'],
          isTrue,
        );
        final moved = app.selectDevicePassage(
          'm',
          command('step', 3, extra: {'delta': 2}),
        )!;
        expect(moved['rows'], 3);
        final pinned = app.selectDevicePassage('m', command('pin', 4))!;
        expect((pinned['text'] as String).split('\n'), hasLength(3));
        await tester.pump();
        expect(find.text('3 lines attached to voice'), findsOneWidget);
        app.selectDevicePassage('m', command('cancel', 5));
        await tester.pump();
        expect(find.text('3 lines attached to voice'), findsNothing);
        expect(input, isEmpty);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets('Escape cancels locally and a changed stream cannot be quoted', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, 'Read this without typing\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    try {
      await mount(tester, app);
      expect(app.selectDevicePassage('m', command('begin', 1))!['ok'], isTrue);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(app.selectDevicePassage('m', command('pin', 2))!['ok'], isFalse);
      expect(input, isEmpty);
      app.selectDevicePassage('m', command('begin', 1));
      session.streamId = 'replacement';
      expect(app.selectDevicePassage('m', command('pin', 2))!['ok'], isFalse);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'another pane, machine, background window and stale revision cannot select',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(session, 0, 'Target text\r\n', keyframe: true);
      app.adoptSessionForTest(session);
      try {
        await mount(tester, app);
        expect(
          app.selectDevicePassage('m', command('begin', 1, agent: 'a1'))!['ok'],
          isFalse,
        );
        expect(app.selectDevicePassage('other', command('begin', 1)), isNull);
        app.foreground.value = false;
        expect(
          app.selectDevicePassage('m', command('begin', 1))!['ok'],
          isFalse,
        );
        app.foreground.value = true;
        expect(
          app.selectDevicePassage('m', command('begin', 1))!['ok'],
          isTrue,
        );
        expect(
          app.selectDevicePassage(
            'm',
            command('step', 1, extra: {'delta': 1}),
          )!['ok'],
          isFalse,
        );
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}
