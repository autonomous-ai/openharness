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
import 'package:harness/widgets/rename_agent_dialog.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;
import 'keymap_runtime_test.dart' show native;
import 'support/rename_connection.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

final _agent = find.byKey(const Key('agent-rename-input'));
final _tab = find.byKey(const Key('tab-rename-input'));
final _search = find.byKey(const ValueKey('swarm-search-input'));
TextField field(WidgetTester tester, Finder finder) =>
    tester.widget<TextField>(finder);

Future<void> command(WidgetTester tester, String query) async {
  await key(tester, LogicalKeyboardKey.keyP, cmd: true);
  await tester.enterText(_search, '> $query');
  await key(tester, LogicalKeyboardKey.enter);
  await tester.pumpAndSettle();
}

void main() {
  late RenameConnection connection;
  late AppNotifier app;
  late MemoryKeymap map;
  late SwarmProjectStore projects;
  setUp(() {
    connection = RenameConnection();
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
    bool nativeTabs = false,
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
            nativeTabs: nativeTabs,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'command rename targets the focused agent, retries and rejoins without leaking input',
    (tester) async {
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      final pane = app.adoptSessionForTest(terminal('a1', input));
      await mount(tester);
      await command(tester, 'rename agent');
      expect(field(tester, _agent).focusNode!.hasPrimaryFocus, isTrue);
      expect(
        field(tester, _agent).controller!.selection,
        const TextSelection(baseOffset: 0, extentOffset: 7),
      );
      tester.testTextInput.enterText('Fix parser');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(connection.renames.single, {
        'agentId': 'a1',
        'name': 'Fix parser',
      });
      expect(field(tester, _agent).readOnly, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      await command(tester, 'rename agent');
      expect(field(tester, _agent).controller!.text, 'Fix parser');
      expect(field(tester, _agent).readOnly, isTrue);
      expect(connection.renames, hasLength(1));
      connection.replies.single.complete({
        'error': 'REFUSED',
        'detail': 'Reconnect and retry.',
      });
      await tester.pumpAndSettle();
      expect(find.text('Rename failed: Reconnect and retry.'), findsOneWidget);
      expect(field(tester, _agent).focusNode!.hasPrimaryFocus, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      connection.replies.last.complete({
        'agent': {'name': 'Fix parser · saved'},
      });
      await tester.pumpAndSettle();
      expect(_agent, findsNothing);
      expect(pane.session!.agentName, 'Fix parser · saved');
      expect(app.focusedPane, same(pane));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.streamId, 'stream-a1');
      expect(input.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'live custom rename keys, disabled defaults and composition keep ownership',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      map.apply('''{"bindings":[
      {"keys":"f2","command":"agent.rename","when":"terminal"},
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"escape","command":null,"when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"},
      {"keys":"f7","command":"picker.cancel","when":"picker"}
    ]}''');
      await mount(tester);
      await key(tester, LogicalKeyboardKey.f2);
      await tester.pumpAndSettle();
      expect(find.text('F8  save'), findsOneWidget);
      tester.testTextInput.enterText('Updated');
      final editor = field(tester, _agent).controller!;
      editor.value = editor.value.copyWith(
        composing: const TextRange(start: 0, end: 7),
      );
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(editor.value.composing, const TextRange(start: 0, end: 7));
      expect(_agent, findsOneWidget);
      expect(connection.renames, isEmpty);
      editor.clearComposing();
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(connection.renames, isEmpty);
      expect(_agent, findsOneWidget);
      map.apply('''{"bindings":[
      {"keys":"f10","command":"picker.accept","when":"picker"},
      {"keys":"f4","command":"picker.cancel","when":"picker"}
    ]}''');
      await tester.pump();
      expect(find.text('F10  save'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.f10);
      connection.replies.single.complete({});
      await tester.pumpAndSettle();
      await command(tester, 'rename tab');
      expect(field(tester, _tab).focusNode!.hasPrimaryFocus, isTrue);
      expect(find.text('F10  save'), findsOneWidget);
      tester.testTextInput.enterText('Named tab');
      await key(tester, LogicalKeyboardKey.f10);
      expect(app.activeSwarm.name, 'Named tab');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'native Rename Tab acknowledges visible input before waiting for its value',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, nativeTabs: true);
      final opened = native(tester, 'renameActive');
      await tester.pumpAndSettle();
      await opened;
      expect(field(tester, _tab).focusNode!.hasPrimaryFocus, isTrue);
      tester.testTextInput.enterText('Native rename');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(app.activeSwarm.name, 'Native rename');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('agent rename is unavailable without an owned listed agent', (
    tester,
  ) async {
    await mount(tester);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.enterText(_search, '> rename agent');
    expect(find.byKey(const ValueKey('command:agent.rename')), findsNothing);
    await key(tester, LogicalKeyboardKey.escape);
    app.adoptSessionForTest(terminal('a0', []));
    final state = app.stateOf('m')!;
    state.machine = const Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      isShared: true,
    );
    app.notifyListeners();
    await tester.pump();
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.enterText(_search, '> rename agent');
    expect(find.byKey(const ValueKey('command:agent.rename')), findsNothing);
    expect(connection.renames, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a prompt never reselects text after the user starts typing', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  showAgentRenameDialog(context, app, 'm', 'a0', 'Agent 0'),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    expect(field(tester, _agent).focusNode!.hasPrimaryFocus, isTrue);
    tester.testTextInput.enterText('First keystrokes');
    await tester.pump(const Duration(milliseconds: 150));
    expect(field(tester, _agent).controller!.selection.isCollapsed, isTrue);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'large-text rename retains input and retry keys in a short window',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, size: const Size(480, 360), scale: 1.7);
      await command(tester, 'rename agent');
      tester.testTextInput.enterText('');
      await key(tester, LogicalKeyboardKey.enter);
      expect(find.text('Name cannot be empty'), findsOneWidget);
      expect(_agent.hitTestable(), findsOneWidget);
      expect(find.text('esc  close').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('double-click rename retains typing through terminal updates', (
    tester,
  ) async {
    final input = <TerminalBinaryFrame>[];
    final pane = app.adoptSessionForTest(terminal('a0', input));
    await mount(tester);
    final title = find.text('Session a0');
    await tester.tap(title);
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tap(title);
    await tester.pump();
    expect(field(tester, _agent).focusNode!.hasPrimaryFocus, isTrue);
    tester.testTextInput.enterText('Typed immediately');
    pane.session!.terminal.write('Background output\r\n');
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 150));
    expect(field(tester, _agent).controller!.selection.isCollapsed, isTrue);
    expect(field(tester, _agent).focusNode!.hasPrimaryFocus, isTrue);
    await key(tester, LogicalKeyboardKey.enter);
    connection.replies.single.complete({});
    await tester.pumpAndSettle();
    expect(pane.session!.agentName, 'Typed immediately');
    expect(input, isEmpty);
    await key(tester, LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 20));
    expect(input.single.bytes, [27, 91, 68]);
    await tester.pumpWidget(const SizedBox());
  });
}
