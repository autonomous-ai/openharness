import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;
import 'support/restart_connection.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

final _prompt = find.byKey(const ValueKey('agent-restart-prompt'));

void main() {
  late RestartConnection connection;
  late AppNotifier app;
  late MemoryKeymap map;
  late SwarmProjectStore projects;
  setUp(() {
    connection = RestartConnection();
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
  String id() => connection.requests.last['creationId'] as String;
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
            nativeTabs: false,
            projectStore: projects,
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
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> restart',
    );
    await key(tester, accept);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'restart starts immediately, rejoins pending work, retries inline and restores terminal input',
    (tester) async {
      final input = <TerminalBinaryFrame>[];
      final pane = app.adoptSessionForTest(terminal('a0', input));
      final original = pane.session;
      await mount(tester);
      await open(tester);
      expect(find.text('Restarting…'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.requests, hasLength(1));
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(_prompt, findsNothing);
      await open(tester);
      expect(connection.requests, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      await open(tester);
      expect(connection.requests, hasLength(1));
      connection.restartReplies.single.complete({
        'creationId': id(),
        'state': 'failed',
        'failure': {
          'code': 'AGENT_BUSY',
          'detail': 'Wait for the other operation.',
        },
      });
      await tester.pumpAndSettle();
      expect(find.text('Wait for the other operation.'), findsOneWidget);
      expect(find.text('enter  retry'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.requests, hasLength(2));
      connection.restartReplies.last.complete(restartReceipt(id()));
      await tester.pumpAndSettle();
      expect(_prompt, findsNothing);
      expect(pane.session, same(original));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('lost restart checks status and explains a fresh conversation', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester);
    await open(tester);
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_restart'),
    );
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.escape);
    await open(tester);
    expect(find.text('enter  check status'), findsOneWidget);
    expect(connection.requests, hasLength(1));
    await key(tester, LogicalKeyboardKey.enter);
    connection.checkReplies.single.complete(
      restartReceipt(id(), resumed: false),
    );
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Started a new conversation. The previous session could not be resumed.',
      ),
      findsOneWidget,
    );
    expect(find.text('enter  close'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    expect(connection.requests, hasLength(1));
    await tester.pumpAndSettle();
    expect(_prompt, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'restarting again after uncertainty requires a separate keyboard confirmation',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester);
      await open(tester);
      final previous = id();
      connection.restartReplies.single.completeError(
        const WsRequestTimeout('agent_restart'),
      );
      await tester.pumpAndSettle();
      Future<void> ask() async {
        await key(tester, LogicalKeyboardKey.tab);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('May have already restarted.'), findsOneWidget);
      }

      await ask();
      await key(tester, LogicalKeyboardKey.enter); // Cancel has initial focus.
      await tester.pumpAndSettle();
      expect(connection.requests, hasLength(1));
      await ask();
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.requests, hasLength(2));
      expect(id(), isNot(previous));
      connection.restartReplies.last.complete(restartReceipt(id()));
      await tester.pumpAndSettle();
      expect(_prompt, findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Restart Terminal starts a fresh shell without a conversation warning',
    (tester) async {
      app.stateOf('m')!.agents[0] = const Agent(
        id: 'a0',
        name: 'Shell',
        engine: 'terminal',
        terminalAvailable: true,
      );
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester);
      await open(tester);
      expect(find.text('Restart Terminal'), findsOneWidget);
      connection.restartReplies.single.complete(
        restartReceipt(id(), resumed: false),
      );
      await tester.pumpAndSettle();
      expect(_prompt, findsNothing);
      expect(find.textContaining('previous session'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('status prompt obeys live custom keys and disabled defaults', (
    tester,
  ) async {
    map.apply('''{"bindings":[
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"escape","command":null,"when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"},
      {"keys":"f7","command":"picker.cancel","when":"picker"}
    ]}''');
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester);
    await open(tester, accept: LogicalKeyboardKey.f8);
    await key(tester, LogicalKeyboardKey.escape);
    expect(_prompt, findsOneWidget);
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_restart'),
    );
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.enter);
    expect(connection.checks, isEmpty);
    await key(tester, LogicalKeyboardKey.f8);
    expect(connection.checks, hasLength(1));
    map.apply('''{"bindings":[
      {"keys":"f4","command":"picker.cancel","when":"picker"}
    ]}''');
    await tester.pump();
    expect(find.text('F4  close'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.f4);
    await tester.pumpAndSettle();
    expect(_prompt, findsNothing);
    connection.checkReplies.single.complete(restartReceipt(id()));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('enlarged short window keeps uncertainty and Escape visible', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, size: const Size(480, 360), scale: 1.7);
    await open(tester);
    expect(find.text('esc  close').hitTestable(), findsOneWidget);
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_restart'),
    );
    await tester.pumpAndSettle();
    expect(find.text('Restart not confirmed.').hitTestable(), findsOneWidget);
    expect(find.text('esc  close').hitTestable(), findsOneWidget);
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('esc  back').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
    await key(tester, LogicalKeyboardKey.escape);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(_prompt, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
