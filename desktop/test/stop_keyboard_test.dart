import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;
import 'support/stop_connection.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  late StopConnection connection;
  late AppNotifier app;
  late MemoryKeymap map;
  late SwarmProjectStore projects;
  setUp(() {
    connection = StopConnection();
    app = createApp(connectionForTest: (_) => connection);
    app.stateOf('m')!.nodeOnline = true;
    map = MemoryKeymap();
    projects = SwarmProjectStore();
  });
  tearDown(() {
    app.dispose();
    map.dispose();
    projects.dispose();
  });

  Future<void> mount(
    WidgetTester tester, {
    Size size = const Size(1280, 800),
    double scale = 1,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: KeymapProvider(
          keymap: map,
          child: SwarmScreen(
            notifier: app,
            projectStore: projects,
            nativeTabs: false,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> open(
    WidgetTester tester, {
    LogicalKeyboardKey accept = LogicalKeyboardKey.enter,
  }) async {
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> stop',
    );
    await key(tester, accept);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Stop uses safe confirmation, inline retry and one pending request across reopen',
    (tester) async {
      final input = <TerminalBinaryFrame>[];
      final retained = app.adoptSessionForTest(terminal('a0', input));
      app.adoptSessionForTest(terminal('a1', input));
      await mount(tester);
      await open(tester);
      expect(find.text('Stop Harness'), findsOneWidget);
      expect(
        find.textContaining('Close Pane keeps it running.'),
        findsOneWidget,
      );
      // The default action must leave the agent running.
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Stop Harness'), findsNothing);
      expect(connection.stops, isEmpty);
      await open(tester);
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(connection.stops, ['a1']);
      expect(find.text('Stopping…'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.stops, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Stop Harness'), findsNothing);
      await open(tester);
      expect(find.text('Stopping…'), findsOneWidget);
      expect(connection.stops, hasLength(1));
      connection.stopReplies.single.complete({
        'error': 'OFFLINE',
        'detail': 'Reconnect and retry.',
      });
      await tester.pumpAndSettle();
      expect(find.text('Stop failed: Reconnect and retry.'), findsOneWidget);
      await key(
        tester,
        LogicalKeyboardKey.enter,
      ); // Retry still starts on Cancel.
      await tester.pumpAndSettle();
      expect(find.text('Stop Harness'), findsNothing);
      expect(connection.stops, hasLength(1));
      await open(tester);
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      connection.stopReplies.last.complete({'deleted': true});
      await tester.pumpAndSettle();
      expect(find.text('Stop Harness'), findsNothing);
      expect(app.allPanes, [retained]);
      expect(app.focusedPane, same(retained));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.streamId, 'stream-a0');
      expect(input.single.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('stop honors live accept, traversal and cancel remapping', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    map.apply('''{"bindings":[
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"escape","command":null,"when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"},
      {"keys":"f6","command":"picker.complete","when":"picker"},
      {"keys":"f7","command":"picker.cancel","when":"picker"}
    ]}''');
    await mount(tester);
    await open(tester, accept: LogicalKeyboardKey.f8);
    expect(find.text('F8  select'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.text('Stop Harness'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.f6);
    await key(tester, LogicalKeyboardKey.f8);
    expect(connection.stops, ['a0']);
    map.apply('''{"bindings":[
      {"keys":"escape","command":null,"when":"picker"},
      {"keys":"f4","command":"picker.cancel","when":"picker"}
    ]}''');
    await tester.pump();
    expect(find.text('F4  close'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.text('Stop Harness'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.f4);
    await tester.pumpAndSettle();
    expect(find.text('Stop Harness'), findsNothing);
    connection.stopReplies.single.complete({'error': 'REFUSED'});
    await tester.pumpAndSettle();
    expect(app.stateOf('m')!.agents.any((agent) => agent.id == 'a0'), isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'terminal stopping names the shell and remains usable at enlarged text',
    (tester) async {
      app.stateOf('m')!.agents = [
        const Agent(
          id: 'a0',
          name: 'Build shell',
          engine: 'terminal',
          terminalAvailable: true,
        ),
      ];
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, size: const Size(480, 360), scale: 1.7);
      await open(tester);
      expect(find.text('Stop Terminal'), findsOneWidget);
      expect(find.textContaining('End this shell'), findsOneWidget);
      expect(find.text('Cancel').hitTestable(), findsOneWidget);
      expect(find.text('esc  close').hitTestable(), findsOneWidget);
      final body = tester.widget<SingleChildScrollView>(
        find.ancestor(
          of: find.textContaining('End this shell'),
          matching: find.byType(SingleChildScrollView),
        ),
      );
      expect(body.controller!.offset, 0);
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(body.controller!.offset, greaterThan(0));
      expect(find.text('Cancel').hitTestable(), findsOneWidget);
      for (
        var i = 0;
        i < 12 &&
            find
                .textContaining('Close Pane keeps it running.')
                .hitTestable()
                .evaluate()
                .isEmpty;
        i++
      ) {
        await key(tester, LogicalKeyboardKey.pageDown);
      }
      expect(
        find.textContaining('Close Pane keeps it running.').hitTestable(),
        findsOneWidget,
      );
      for (var i = 0; i < 12 && body.controller!.offset > 0; i++) {
        await key(tester, LogicalKeyboardKey.pageUp);
      }
      expect(body.controller!.offset, 0);
      expect(tester.takeException(), isNull);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.stops, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('shared agents never offer the stop command', (tester) async {
    app.adoptSessionForTest(terminal('a0', []));
    app.stateOf('m')!.machine = const Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      isShared: true,
    );
    await mount(tester);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> stop',
    );
    expect(find.byKey(const ValueKey('command:agent.stop')), findsNothing);
    expect(connection.stops, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an open confirmation cannot stop a newly replaced session', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester);
    await open(tester);
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'a0',
        name: 'Restarted',
        sessionId: 'replacement',
        engine: 'codex',
      ),
    ];
    app.notifyListeners();
    await tester.pump();
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(connection.stops, isEmpty);
    expect(find.textContaining('The agent changed.'), findsOneWidget);
    await key(
      tester,
      LogicalKeyboardKey.enter,
    ); // Cancel retains focus on error.
    await tester.pumpAndSettle();
    expect(find.text('Stop Harness'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
