import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'device_passage_test.dart' show command;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show output;

void main() {
  testWidgets(
    'spoken lookup steps matches and pins literal output without input',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(
        session,
        0,
        'first error [x]\r\nsecond ERROR [x]\r\nthird error x\r\n',
        keyframe: true,
      );
      app.adoptSessionForTest(session);
      try {
        await mount(tester, app);
        expect(app.selectDevicePassage('m', command('begin', 1))!['ok'], true);
        final searching = app.searchDevicePassage(
          'm',
          command('search', 2, extra: {'query': 'error [x]'}),
        );
        await tester.pumpAndSettle();
        final found = (await searching)!;
        expect(found, containsPair('ok', true));
        expect(found['matches'], 2);
        expect(found['query'], 'error [x]');
        final next = app.searchDevicePassage(
          'm',
          command('match', 3, extra: {'delta': 1}),
        );
        await tester.pumpAndSettle();
        final moved = (await next)!;
        expect(moved['ok'], true);
        expect(moved['match'], found['match'] == 1 ? 2 : 1);
        final pinned = app.selectDevicePassage('m', command('pin', 4))!;
        expect(pinned['ok'], true);
        expect((pinned['text'] as String).toLowerCase(), contains('error [x]'));
        expect(pinned.containsKey('query'), false);
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'zero matches can be searched again and line mode keeps the passage',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(session, 0, 'a remembered phrase\r\n', keyframe: true);
      app.adoptSessionForTest(session);
      try {
        await mount(tester, app);
        app.selectDevicePassage('m', command('begin', 1));
        final missing = app.searchDevicePassage(
          'm',
          command('search', 2, extra: {'query': 'absent'}),
        );
        await tester.pumpAndSettle();
        expect(await missing, containsPair('matches', 0));
        expect(find.text('Find "absent" · 0/0'), findsOneWidget);
        expect(app.selectDevicePassage('m', command('pin', 3))!['ok'], false);
        // A rejected pin on an empty match does not advance the local cursor.
        final retry = app.searchDevicePassage(
          'm',
          command('search', 3, extra: {'query': 'remembered'}),
        );
        await tester.pumpAndSettle();
        expect(await retry, containsPair('matches', 1));
        final lines = app.selectDevicePassage('m', command('lines', 4))!;
        expect(lines['ok'], true);
        expect(lines.containsKey('query'), false);
        expect(lines['excerpt'], 'a remembered phrase');
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'cancel, focus, stream, stale revision and covering picker reject lookup',
    (tester) async {
      final app = createApp(connected: true);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(
        session,
        0,
        List.generate(1000, (i) => 'log $i').join('\r\n'),
        keyframe: true,
      );
      app.adoptSessionForTest(session);
      try {
        await mount(tester, app);
        app.selectDevicePassage('m', command('begin', 1));
        final pending = app.searchDevicePassage(
          'm',
          command('search', 2, extra: {'query': 'log'}),
        );
        app.selectDevicePassage('m', command('cancel', 3));
        await tester.pumpAndSettle();
        expect(await pending, containsPair('ok', false));
        expect(
          tester
              .widget<TerminalView>(find.byType(TerminalView))
              .controller!
              .highlights,
          isEmpty,
        );
        app.selectDevicePassage('m', command('begin', 1));
        expect(
          await app.searchDevicePassage(
            'm',
            command('search', 1, extra: {'query': 'log'}),
          ),
          containsPair('ok', false),
        );
        app.foreground.value = false;
        expect(
          await app.searchDevicePassage(
            'm',
            command('search', 2, extra: {'query': 'log'}),
          ),
          containsPair('ok', false),
        );
        app.foreground.value = true;
        final context = tester.element(find.byType(TerminalView));
        final dialog = showDialog<void>(
          context: context,
          builder: (_) =>
              const AlertDialog(content: TextField(autofocus: true)),
        );
        await tester.pumpAndSettle();
        expect(
          await app.searchDevicePassage(
            'm',
            command('search', 2, extra: {'query': 'log'}),
          ),
          containsPair('ok', false),
        );
        Navigator.of(context).pop();
        await dialog;
        await tester.pumpAndSettle();
        session.streamId = 'new-stream';
        expect(
          await app.searchDevicePassage(
            'm',
            command('search', 2, extra: {'query': 'log'}),
          ),
          containsPair('ok', false),
        );
        expect(input, isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}
