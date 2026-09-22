import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/workspace_welcome.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('visited New Tab stays current without taking terminal focus', (
    tester,
  ) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    final originalTab = app.activeSwarmId;
    final map = MemoryKeymap();
    await mount(tester, app, map);
    expect(find.byType(WorkspaceWelcome, skipOffstage: false), findsNothing);

    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    await tester.pumpAndSettle();
    final welcome = tester.element(find.byType(WorkspaceWelcome));
    await key(tester, LogicalKeyboardKey.keyW, cmd: true);
    await tester.pumpAndSettle();
    expect(app.activeSwarmId, originalTab);
    expect(find.byType(WorkspaceWelcome), findsNothing);
    expect(
      tester.element(find.byType(WorkspaceWelcome, skipOffstage: false)),
      same(welcome),
    );
    await key(tester, LogicalKeyboardKey.arrowLeft);
    expect(input.single.bytes, [27, 91, 68]);
    input.clear();

    // A retained page must still follow live keymap changes while hidden.
    map.apply('''{"bindings":[
      {"keys":"cmd+n","command":null},
      {"keys":"cmd+y","command":"agent.new"}
    ]}''');
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    await tester.pumpAndSettle();
    expect(tester.element(find.byType(WorkspaceWelcome)), same(welcome));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('welcome-agent.new')),
        matching: find.text(map.hint('agent.new')!),
      ),
      findsOneWidget,
    );
    expect(input, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });
}
