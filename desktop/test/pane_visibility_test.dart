import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/pane_split_edges.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets(
    'tab switches suspend terminals without rebuilding outgoing pane controls',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final firstSession = terminal('a0', input);
      app.adoptSessionForTest(firstSession);
      app.adoptSessionForTest(terminal('a1', input));
      final first = app.activeSwarmId;
      app.newSwarm();
      app.adoptSessionForTest(terminal('a2', input));
      app.adoptSessionForTest(terminal('a3', input));
      final second = app.activeSwarmId;
      await mount(tester, app);
      app.selectSwarm(first);
      await tester.pumpAndSettle();

      final firstPanel = find.byWidgetPredicate(
        (widget) => widget is TerminalPanel && widget.session == firstSession,
        skipOffstage: false,
      );
      final controls = find
          .ancestor(of: firstPanel, matching: find.byType(PaneSplitEdges))
          .evaluate()
          .single;
      final view = tester.state<TerminalViewState>(
        find.byWidgetPredicate(
          (widget) =>
              widget is TerminalView &&
              widget.terminal == firstSession.terminal,
        ),
      );
      var outgoingControlBuilds = 0;
      debugOnRebuildDirtyWidget = (element, _) {
        if (identical(element, controls)) outgoingControlBuilds++;
      };
      try {
        app.selectSwarm(second);
        await tester.pump();
      } finally {
        debugOnRebuildDirtyWidget = null;
      }
      expect(outgoingControlBuilds, 0);
      expect(tester.widget<TerminalPanel>(firstPanel).visible, isFalse);
      expect(view.widget.renderingEnabled, isFalse);
      expect(view.widget.focusNode!.hasFocus, isFalse);

      firstSession.terminal.write('output while parked');
      expect(view.renderTerminal.debugNeedsLayout, isFalse);
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.enterText('x');
      await tester.idle();
      expect(input.single.streamId, 'stream-a3');
      expect(String.fromCharCodes(input.single.bytes), 'x');

      await app.handleEventForTest('m', {
        'type': 'agent_renamed',
        'payload': {'agentId': 'a0', 'name': 'Renamed while parked'},
      });
      app.selectSwarm(first);
      await tester.pumpAndSettle();
      expect(tester.widget<TerminalPanel>(firstPanel).visible, isTrue);
      expect(view.widget.renderingEnabled, isTrue);
      expect(find.text('Renamed while parked'), findsOneWidget);
      expect(
        firstSession.terminal.buffer.getText(),
        contains('output while parked'),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
