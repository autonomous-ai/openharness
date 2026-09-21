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
import 'support/fork_connection.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

final _task = find.byKey(const ValueKey('fork-task'));
final _name = find.byKey(const ValueKey('fork-name'));
TextField field(WidgetTester tester, Finder finder) =>
    tester.widget<TextField>(finder);

// The fixture has no new PTY transport. Verify receipt/UI completion without
// waiting for the new pane's intentionally ongoing attachment animation.
Future<void> pumpForkReceipt(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 120));
}

void main() {
  late ForkConnection connection;
  late AppNotifier app;
  late MemoryKeymap map;
  late SwarmProjectStore projects;
  setUp(() {
    connection = ForkConnection();
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
      '> fork',
    );
    await key(tester, accept);
    await tester.pumpAndSettle();
  }

  String getId() => connection.forks.last['creationId'] as String;

  testWidgets(
    'fork keeps its draft, task focus, pending request and inline retry',
    (tester) async {
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      await mount(tester);
      await open(tester);
      expect(field(tester, _task).focusNode!.hasPrimaryFocus, isTrue);
      expect(field(tester, _name).controller!.text, 'Agent 0 - fork');
      tester.testTextInput.enterText('  keep\n  indentation  ');
      await key(tester, LogicalKeyboardKey.escape);
      await open(tester);
      expect(field(tester, _task).controller!.text, '  keep\n  indentation  ');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(connection.forks.single['prompt'], '  keep\n  indentation  ');
      expect(field(tester, _task).readOnly, isTrue);
      expect(field(tester, _task).focusNode!.hasPrimaryFocus, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.forks, hasLength(1));
      await key(tester, LogicalKeyboardKey.escape);
      await open(tester);
      expect(find.text('Waiting for fork…'), findsOneWidget);
      expect(connection.forks, hasLength(1));
      connection.forkReplies.single.complete({
        'creationId': getId(),
        'state': 'failed',
        'failure': {'code': 'BUSY', 'detail': 'Wait for the turn to finish.'},
      });
      await tester.pumpAndSettle();
      expect(find.text('Wait for the turn to finish.'), findsOneWidget);
      expect(field(tester, _task).readOnly, isFalse);
      expect(field(tester, _task).focusNode!.hasPrimaryFocus, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      connection.forkReplies.last.complete(forkReceipt(getId()));
      await pumpForkReceipt(tester);
      expect(_task, findsNothing);
      expect(app.focusedPane!.agentId, 'forked');
      expect(input, isEmpty);
      app.focusPane(app.panes.first.id, reveal: true);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'lost fork reply locks its draft and Enter checks the same receipt',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester);
      await open(tester);
      tester.testTextInput.enterText('another approach');
      await key(tester, LogicalKeyboardKey.enter);
      final id = getId();
      connection.forkReplies.single.completeError(
        const WsRequestTimeout('agent_fork'),
      );
      await tester.pumpAndSettle();
      expect(find.text('enter  check status'), findsOneWidget);
      expect(field(tester, _task).readOnly, isTrue);
      await key(tester, LogicalKeyboardKey.escape);
      await open(tester);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.checks, [
        {'creationId': id},
      ]);
      expect(connection.forks, hasLength(1));
      connection.checkReplies.single.complete(
        forkReceipt(id, level: 'handoff'),
      );
      await pumpForkReceipt(tester);
      expect(_task, findsNothing);
      expect(find.textContaining('handoff summary'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a new fork after uncertainty is a separate explicit action', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester);
    await open(tester);
    await key(tester, LogicalKeyboardKey.enter);
    final oldId = getId();
    connection.forkReplies.single.complete({
      'creationId': oldId,
      'state': 'unconfirmed',
    });
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('fork-start-another')));
    await tester.pumpAndSettle();
    expect(connection.forks, hasLength(1));
    expect(field(tester, _task).readOnly, isFalse);
    expect(
      find.textContaining('previous fork may already exist'),
      findsOneWidget,
    );
    await key(tester, LogicalKeyboardKey.enter);
    expect(getId(), isNot(oldId));
    connection.forkReplies.last.complete(forkReceipt(getId()));
    await pumpForkReceipt(tester);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'fork respects custom keys, composition, line editing and disabled defaults',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      map.apply('''{"bindings":[
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"escape","command":null,"when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"},
      {"keys":"f6","command":"picker.complete","when":"picker"},
      {"keys":"f10","command":"picker.add_here","when":"picker"},
      {"keys":"f7","command":"picker.cancel","when":"picker"}
    ]}''');
      await mount(tester);
      await open(tester, accept: LogicalKeyboardKey.f8);
      tester.testTextInput.enterText('Fix parser edge');
      final editor = field(tester, _task).controller!;
      editor.value = editor.value.copyWith(
        composing: const TextRange(start: 0, end: 3),
      );
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.f10);
      expect(editor.text, 'Fix parser edge');
      expect(connection.forks, isEmpty);
      editor.clearComposing();
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(connection.forks, isEmpty);
      expect(_task, findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
      expect(editor.text, 'Fix parser ');
      await key(tester, LogicalKeyboardKey.enter, alt: true);
      expect(editor.text, 'Fix parser \n');
      await key(tester, LogicalKeyboardKey.f10);
      expect(connection.forks.single['prompt'], 'Fix parser \n');
      map.apply(
        '''{"bindings":[{"keys":"f4","command":"picker.cancel","when":"picker"}]}''',
      );
      await tester.pump();
      expect(find.text('F4  close'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.f4);
      await tester.pumpAndSettle();
      expect(_task, findsNothing);
      connection.forkReplies.single.complete(forkReceipt(getId()));
      await pumpForkReceipt(tester);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('name validation and native Next retain editing ownership', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester);
    await open(tester);
    await tester.enterText(_name, '');
    await key(tester, LogicalKeyboardKey.enter, cmd: true);
    expect(find.text('Name cannot be empty'), findsOneWidget);
    expect(field(tester, _name).focusNode!.hasPrimaryFocus, isTrue);
    tester.testTextInput.enterText('Separate idea');
    await tester.testTextInput.receiveAction(TextInputAction.next);
    await tester.pump();
    expect(field(tester, _task).focusNode!.hasPrimaryFocus, isTrue);
    tester.testTextInput.enterText('first');
    await key(tester, LogicalKeyboardKey.enter, alt: true);
    expect(field(tester, _task).controller!.text, 'first\n');
    await key(tester, LogicalKeyboardKey.keyP, ctrl: true);
    expect(field(tester, _task).focusNode!.hasPrimaryFocus, isTrue);
    expect(field(tester, _task).controller!.selection.baseOffset, lessThan(6));
    await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
    expect(field(tester, _task).controller!.selection.baseOffset, 6);
    await key(tester, LogicalKeyboardKey.enter);
    expect(connection.forks.single['name'], 'Separate idea');
    connection.forkReplies.single.complete(forkReceipt(getId()));
    await pumpForkReceipt(tester);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('fork prompt works at enlarged text and retains pending Escape', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, size: const Size(480, 360), scale: 1.7);
    await open(tester);
    expect(field(tester, _task).focusNode!.hasPrimaryFocus, isTrue);
    expect(find.text('esc  close').hitTestable(), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    connection.forkReplies.single.completeError(
      const WsRequestTimeout('agent_fork'),
    );
    await tester.pumpAndSettle();
    expect(find.text('esc  close').hitTestable(), findsOneWidget);
    expect(find.text('Fork may already exist.').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(_task, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  for (final shared in [true, false]) {
    testWidgets(
      'fork is absent for ${shared ? 'shared' : 'unsupported'} agents',
      (tester) async {
        app.adoptSessionForTest(terminal('a0', []));
        if (shared) {
          app.stateOf('m')!.machine = const Machine(
            machineId: 'm',
            authMode: MachineAuthMode.remote,
            isShared: true,
          );
        } else {
          app.stateOf('m')!.agents = [
            const Agent(id: 'a0', name: 'Shell', engine: 'terminal'),
          ];
        }
        await mount(tester);
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> fork',
        );
        expect(find.byKey(const ValueKey('command:agent.fork')), findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
