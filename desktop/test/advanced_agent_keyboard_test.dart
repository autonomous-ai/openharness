import 'support/launch_menu.dart';

import 'package:harness/widgets/new_harness_form.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/agent_picker.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final launches = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') {
      return {
        'engines': [
          for (final engine in ['claude', 'codex', 'opencode'])
            {'engine': engine, 'installed': true},
        ],
      };
    }
    if (type == 'agent_create') {
      launches.add(payload);
      return {'error': 'Recorded without creating an agent'};
    }
    return {};
  }
}

Future<_Connection> _open(WidgetTester tester, {MemoryKeymap? keymap}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  final connection = _Connection();
  final app = createApp(connectionForTest: (_) => connection);
  app.machineStates['m']!.nodeOnline = true;
  addTearDown(app.dispose);
  Widget opener() => Builder(
    builder: (context) => Scaffold(
      body: TextButton(
        onPressed: () => showNewAgentDialog(
          context,
          app,
          'm',
          source: 'test',
          initialEngine: 'codex',
          initialFolder: '/work/project',
        ),
        child: const Text('Open'),
      ),
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      home: keymap == null
          ? opener()
          : KeymapProvider(
              keymap: keymap,
              child: KeymapHost(
                keymap: keymap,
                enabled: () => false,
                actions: const {},
                child: opener(),
              ),
            ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
  await openAgentSearch(tester);
  return connection;
}

void main() {
  testWidgets('configured page keys still scroll the agent preview', (
    tester,
  ) async {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final connection = await _open(tester, keymap: map);
    final input = tester.widget<TextField>(agentSearch);
    final editing = input.controller!.value;
    await key(tester, LogicalKeyboardKey.slash, ctrl: true);
    final preview = find.byKey(const ValueKey('new-agent-agent-preview'));
    final scroll = tester
        .state<ScrollableState>(
          find.descendant(of: preview, matching: find.byType(Scrollable)).first,
        )
        .position;
    await key(tester, LogicalKeyboardKey.pageDown);
    expect(scroll.pixels, greaterThan(0));
    await key(tester, LogicalKeyboardKey.pageUp);
    expect(scroll.pixels, 0);
    expect(input.controller!.value, editing);
    expect(input.focusNode!.hasFocus, isTrue);
    expect(connection.launches, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  for (final mapped in [false, true]) {
    testWidgets(
      'modified Enter chooses the visible agent without launching the form (keymap: $mapped)',
      (tester) async {
        final map = mapped ? MemoryKeymap() : null;
        if (map != null) addTearDown(map.dispose);
        final connection = await _open(tester, keymap: map);
        await tester.enterText(agentSearch, 'opencode');
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter, cmd: true);
        await tester.pumpAndSettle();
        expect(connection.launches, isEmpty);
        expect(agentSearch, findsNothing);
        expect(
          tester
              .widget<AgentPicker>(
                find.byKey(const Key('new-agent-agent-picker')),
              )
              .value,
          'opencode',
        );
        expect(find.byType(AlertDialog), findsOneWidget);
        // On macOS Ctrl-Enter also belongs to the open picker, even though
        // the form accepts it as an alternative creation shortcut.
        await openAgentSearch(tester);
        await tester.enterText(agentSearch, 'claude');
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter, ctrl: true);
        await tester.pumpAndSettle();
        expect(connection.launches, isEmpty);
        if (agentSearch.evaluate().isEmpty) await openAgentSearch(tester);
        final editor = tester.widget<TextField>(agentSearch);
        final chosen = tester
            .widget<AgentPicker>(
              find.byKey(const Key('new-agent-agent-picker')),
            )
            .value;
        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: 'co',
            selection: TextSelection.collapsed(offset: 2),
            composing: TextRange(start: 0, end: 2),
          ),
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter, cmd: true);
        await key(tester, LogicalKeyboardKey.enter, ctrl: true);
        await key(tester, LogicalKeyboardKey.escape);
        expect(agentSearch, findsOneWidget);
        expect(editor.focusNode!.hasPrimaryFocus, isTrue);
        expect(connection.launches, isEmpty);
        expect(
          tester
              .widget<AgentPicker>(
                find.byKey(const Key('new-agent-agent-picker')),
              )
              .value,
          chosen,
        );
        await tester.pumpWidget(const SizedBox());
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

  testWidgets('advanced search uses live remapped keys and hints', (
    tester,
  ) async {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    map.apply('''{"bindings":[
      {"keys":"ctrl+slash","command":null,"when":"picker"},
      {"keys":"f6","command":"picker.toggle_preview","when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"}
    ]}''');
    final connection = await _open(tester, keymap: map);
    await tester.enterText(agentSearch, 'opencode');
    await tester.pump();
    final preview = find.byKey(const ValueKey('new-agent-agent-preview'));
    await key(tester, LogicalKeyboardKey.slash, ctrl: true);
    expect(preview, findsNothing);
    await key(tester, LogicalKeyboardKey.f6);
    expect(preview, findsOneWidget);
    expect(
      find.textContaining(RegExp('f6  preview', caseSensitive: false)),
      findsOneWidget,
    );
    final editor = tester.widget<TextField>(agentSearch);
    expect(editor.controller!.text, 'opencode');
    expect(editor.focusNode!.hasPrimaryFocus, isTrue);

    map.apply('''{"bindings":[
      {"keys":"ctrl+slash","command":null,"when":"picker"},
      {"keys":"f7","command":"picker.toggle_preview","when":"picker"},
      {"keys":"f8","command":"picker.accept","when":"picker"}
    ]}''');
    await tester.pump();
    expect(
      find.textContaining(RegExp('f7  preview', caseSensitive: false)),
      findsOneWidget,
    );
    await key(tester, LogicalKeyboardKey.f7);
    expect(preview, findsNothing);
    await key(tester, LogicalKeyboardKey.f8);
    expect(agentSearch, findsNothing);
    expect(connection.launches, isEmpty);
    expect(
      tester
          .widget<AgentPicker>(find.byKey(const Key('new-agent-agent-picker')))
          .value,
      'opencode',
    );
    map.apply('''{"bindings":[
      {"keys":"cmd+enter","command":null,"when":"picker"}
    ]}''');
    await openAgentSearch(tester);
    await key(tester, LogicalKeyboardKey.enter, cmd: true);
    expect(agentSearch, findsOneWidget);
    expect(connection.launches, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the workspace carries picker bindings into advanced options', (
    tester,
  ) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.machineStates['m']!.nodeOnline = true;
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    await key(tester, LogicalKeyboardKey.period, cmd: true);
    await tester.pumpAndSettle();
    await openLaunchRow(tester, 'agent');
    final input = find.byKey(const ValueKey('new-harness-query'));
    await tester.enterText(input, 'opencode');
    await tester.pump();
    // Ctrl-M is a configured picker alias, absent from the fallback shortcuts.
    await key(tester, LogicalKeyboardKey.keyM, ctrl: true);
    expect(harnessChoicesActive(tester), isFalse);
    expect(
      tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller
          .engine,
      'opencode',
    );
    expect(connection.launches, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an open agent picker follows resizing and enlarged text', (
    tester,
  ) async {
    await _open(tester);
    await tester.enterText(agentSearch, 'code');
    await tester.pump();
    await key(tester, LogicalKeyboardKey.arrowDown);
    await key(tester, LogicalKeyboardKey.slash, ctrl: true);
    final editor = tester.widget<TextField>(agentSearch);
    final value = editor.controller!.value;
    for (final (size, scale) in [
      (const Size(600, 800), 1.7),
      (const Size(700, 420), 1.0),
      (const Size(1280, 800), 1.0),
    ]) {
      tester.view.physicalSize = size;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpAndSettle();
      final panel = tester.getRect(
        find.byKey(const Key('new-agent-agent-panel')),
      );
      final bar = tester.getRect(agentBar);
      expect(panel.left, greaterThanOrEqualTo(0));
      expect(panel.right, lessThanOrEqualTo(size.width));
      expect(panel.bottom, lessThanOrEqualTo(size.height));
      expect(panel.width, closeTo(bar.width, 1));
      expect(editor.controller!.value, value);
      expect(editor.focusNode!.hasPrimaryFocus, isTrue);
      expect(tester.takeException(), isNull);
    }
    await tester.pumpWidget(const SizedBox());
  });
}
