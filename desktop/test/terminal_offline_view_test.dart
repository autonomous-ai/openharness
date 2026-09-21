import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_composer.dart';
import 'package:harness/widgets/terminal_find_bar.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show findField, finishFind, terminalView;

void main() {
  testWidgets(
    'offline output keeps its renderer, scroll, selection and Find across tabs',
    (tester) async {
      final app = createApp();
      final machine = app.machineStates['m']!..nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      session.terminal.write(
        List.generate(180, (i) => 'Retained marker $i\r\n').join(),
      );
      final pane = app.adoptSessionForTest(session);
      final first = app.activeSwarmId;
      await mount(tester, app);
      final view = terminalView(tester, session);
      final scroll = view.widget.scrollController!;
      scroll.jumpTo(80);
      final selection = session.terminal.buffer.createAnchor(0, 1);
      final end = session.terminal.buffer.createAnchor(8, 1);
      view.widget.controller!.setSelection(selection, end);
      await tester.pump();
      final size = tester.getSize(find.byType(TerminalView));
      session.transportLost('Connection interrupted');
      machine.nodeOnline = false;
      app.dismissError();
      await tester.pump();
      expect(terminalView(tester, session), same(view));
      expect(scroll.offset, 80);
      expect(tester.getSize(find.byType(TerminalView)), size);
      expect(view.widget.controller!.selection, isNotNull);
      expect(find.text('Offline'), findsOneWidget);
      expect(find.text('TERMINAL FROZEN'), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyF);
      await tester.enterText(findField, 'marker');
      await finishFind(tester);
      expect(
        tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!
            .count,
        180,
      );
      app.newSwarm();
      await tester.pump();
      app.selectSwarm(first);
      await tester.pump();
      await finishFind(tester);
      expect(pane.session, same(session));
      expect(terminalView(tester, session), same(view));
      expect(session.status, TerminalSessionStatus.error);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(scroll.offset, 80);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input, isEmpty);
      await app.selectAgent('m', 'a0');
      expect(
        pane.session,
        same(session),
        reason: 'An unavailable retry must not discard retained output',
      );
      machine.nodeOnline = true;
      app.dismissError();
      await tester.pump();
      expect(terminalView(tester, session), same(view));
      expect(find.text('Reconnect'), findsOneWidget);
      expect(session.status, TerminalSessionStatus.error);
      await tester.pumpWidget(const SizedBox());
      selection.dispose();
      end.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'availability changes preserve an unsent composer draft and disable input',
    (tester) async {
      final app = createApp();
      final machine = app.machineStates['m']!..nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final pane = app.adoptSessionForTest(session)..composerVisible = true;
      await mount(tester, app);
      final field = find.descendant(
        of: find.byType(TerminalComposer),
        matching: find.byType(TextField),
      );
      await tester.enterText(field, 'Unsent instructions');
      final text = tester.widget<TextField>(field).controller!;
      final renderer = terminalView(tester, session);
      final size = tester.getSize(find.byType(TerminalView));
      machine.nodeOnline = false;
      app.dismissError();
      await tester.pump();
      expect(tester.widget<TextField>(field).controller, same(text));
      expect(text.text, 'Unsent instructions');
      expect(tester.widget<TextField>(field).enabled, isFalse);
      expect(terminalView(tester, session), same(renderer));
      expect(tester.getSize(find.byType(TerminalView)), size);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input, isEmpty);
      app.machineStates.remove('m');
      app.dismissError();
      await tester.pump();
      expect(tester.widget<TextField>(field).controller, same(text));
      expect(find.text('Unavailable'), findsOneWidget);
      app.machineStates['m'] = machine..nodeOnline = true;
      machine.needsLink = true;
      app.dismissError();
      await tester.pump();
      expect(find.text('Link required'), findsOneWidget);
      expect(pane.session, same(session));
      expect(tester.widget<TextField>(field).enabled, isFalse);
      machine.needsLink = false;
      app.dismissError();
      await tester.pump();
      expect(tester.widget<TextField>(field).enabled, isTrue);
      expect(text.text, 'Unsent instructions');
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
