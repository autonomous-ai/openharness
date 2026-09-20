import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/first_harness_launch.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/workspace_start_guide.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'swarm_screen_test.dart' show terminal;

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _FirstApp extends AppNotifier {
  _FirstApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    status = AppStatus.authenticated;
    const local = Machine(
      machineId: 'm',
      name: 'This Mac',
      authMode: MachineAuthMode.remote,
    );
    machines = [local];
    machineStates['m'] = MachineState(local)
      ..localOnly = true
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }
  Completer<void>? detection;
  List<String> installed = ['codex'];
  final launches =
      <
        ({
          String engine,
          ProjectFolderRequest? project,
          HarnessPlacement? placement,
        })
      >[];
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {
    await detection?.future;
    machineStates[machineId]!.engines.replace([
      for (final engine in ['claude', 'codex', 'opencode'])
        EngineAvailability(
          engine: engine,
          installed: installed.contains(engine),
        ),
    ]);
    notifyListeners();
  }

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}
  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) async => {'path': path ?? '/Users/developer', 'entries': []};
  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    ProjectFolderRequest? projectFolder,
    bool bypassPermission = true,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
    HarnessPlacement? placement,
  }) async {
    launches.add((
      engine: engine,
      project: projectFolder,
      placement: placement,
    ));
    adoptSessionForTest(terminal('first', []));
    return null;
  }
}

Future<void> _mount(
  WidgetTester tester,
  _FirstApp app,
  FirstHarnessLaunch entry,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(notifier: app, nativeTabs: false, firstLaunch: entry),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 150));
}

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  test(
    'a decision made during preference loading survives and persists',
    () async {
      final storage = _Memory();
      final first = FirstHarnessLaunch(storage: storage);
      final loading = first.load();
      first.handle();
      await loading;
      await first.flush();
      expect(first.handled, isTrue);
      final again = FirstHarnessLaunch(storage: storage);
      await again.load();
      expect(again.handled, isTrue);
    },
  );

  testWidgets(
    'first entry detects the installed agent and starts once on Enter',
    (tester) async {
      final app = _FirstApp()..detection = Completer<void>();
      addTearDown(app.dispose);
      final entry = FirstHarnessLaunch();
      await _mount(tester, app, entry);
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      expect(box.detectingAgent, isTrue);
      expect(find.text('Start'), findsOneWidget);
      expect(find.text('Detecting installed agents…'), findsOneWidget);
      final start = find.byKey(const ValueKey('new-harness-field-create'));
      expect(tester.widget<InkWell>(start).onTap, isNull);
      await tester.tap(start);
      await tester.pump();
      expect(app.launches, isEmpty);
      expect(box.projectLabel, startsWith('~/harnesses/claude-'));
      expect(box.projectFolderRequest!.isGenerated, isTrue);
      expect(app.launches, isEmpty);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.launches, isEmpty);
      app.detection!.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      expect(box.engine, 'codex');
      expect(find.text('Start'), findsOneWidget);
      expect(find.text('New Harness / New Tab'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.launches, hasLength(1));
      expect(app.launches.single.engine, 'codex');
      expect(app.launches.single.project!.name, startsWith('codex-'));
      expect(app.launches.single.project!.isGenerated, isTrue);
      expect(app.launches.single.placement, HarnessPlacement.newTab);
      expect(find.byType(NewHarnessBox), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Escape stays dismissed during a visit; reopening offers the starter',
    (tester) async {
      final app = _FirstApp();
      addTearDown(app.dispose);
      final storage = _Memory();
      final entry = FirstHarnessLaunch(storage: storage);
      await _mount(tester, app, entry);
      expect(find.byType(NewHarnessBox), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await app.probeEngines('m');
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(NewHarnessBox), findsNothing);
      expect(find.byType(WorkspaceStartGuide), findsOneWidget);
      await entry.flush();
      await tester.pumpWidget(const SizedBox());
      await _mount(tester, app, FirstHarnessLaunch(storage: storage));
      expect(find.byType(NewHarnessBox), findsOneWidget);
      expect(
        find.text('⌘/  All Keyboard Shortcuts').hitTestable(),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.slash, cmd: true);
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'an empty tab with an existing harness opens search once per visit',
    (tester) async {
      final app = _FirstApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [
        Agent(
          id: 'saved',
          engine: 'codex',
          name: 'Existing work',
          terminalAvailable: true,
        ),
      ];
      await _mount(tester, app, FirstHarnessLaunch());
      expect(find.byType(NewHarnessBox), findsNothing);
      expect(find.byKey(const ValueKey('swarm-search-input')), findsOneWidget);
      expect(find.text('Existing work'), findsOneWidget);
      expect(find.byType(WorkspaceStartGuide).hitTestable(), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      app.notifyListeners();
      await tester.pump();
      expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('restored work bypasses the automatic starter', (tester) async {
    final app = _FirstApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final entry = FirstHarnessLaunch();
    await _mount(tester, app, entry);
    expect(find.byType(NewHarnessBox), findsNothing);
    expect(app.focusedPane, same(pane));
    expect(entry.handled, isTrue);
    await tester.pumpWidget(const SizedBox());
  });

  test('installed saved preference wins; explicit editing wins over late discovery', () async {
    final app = _FirstApp()..installed = ['claude', 'codex'];
    addTearDown(app.dispose);
    await app.agentPreference.select('codex');
    final first = NewHarnessController(
      app,
      machineId: 'm',
      firstRun: true,
      autoProject: true,
    );
    await Future<void>.delayed(Duration.zero);
    expect(first.engine, 'codex');
    first.dispose();
    app.detection = Completer<void>();
    final second = NewHarnessController(
      app,
      machineId: 'm',
      firstRun: true,
      autoProject: true,
    );
    second.focusField(NewHarnessField.agent);
    second.setQuery('Claude');
    second.accept();
    app.detection!.complete();
    await Future<void>.delayed(Duration.zero);
    expect(second.engine, 'claude');
    second.dispose();
  });

  testWidgets(
    'the keyboard drawing follows remaps and fits narrow, scaled layouts',
    (tester) async {
      final map = MemoryKeymap()
        ..apply(
          '{"bindings":[{"keys":"cmd+t","command":null},{"keys":"cmd+y","command":"swarm.new"}]}',
        );
      addTearDown(map.dispose);
      final calls = <String>[];
      for (final brightness in Brightness.values) {
        for (final size in [const Size(1280, 800), const Size(390, 650)]) {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = size;
          await tester.pumpWidget(
            MaterialApp(
              theme: grid.buildAppTheme(brightness: brightness),
              home: MediaQuery(
                data: MediaQueryData(
                  size: size,
                  textScaler: TextScaler.linear(size.width < 500 ? 1.8 : 1),
                ),
                child: KeymapProvider(
                  keymap: map,
                  child: WorkspaceStartGuide(
                    onShortcuts: () => calls.add('keys'),
                  ),
                ),
              ),
            ),
          );
          expect(tester.takeException(), isNull);
          final tab = find.text('⌘Y  New Tab');
          expect(tab, findsOneWidget);
          await tester.tap(tab);
          expect(
            calls,
            isEmpty,
            reason: 'Annotations explain shortcuts without acting as buttons',
          );
          expect(find.byType(TextButton), findsOneWidget);
        }
      }
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      await tester.pumpWidget(const SizedBox());
    },
  );

  final output = Platform.environment['GUIDE_RENDER_DIR'];
  testWidgets('render first entry guide', skip: output == null, (tester) async {
    await tester.runAsync(() async {
      for (final family in [
        'Menlo',
        'monospace',
        '.AppleSystemUIFontMonospaced',
      ]) {
        final loader = FontLoader(family);
        final bytes = await File('/System/Library/Fonts/Menlo.ttc')
            .readAsBytes();
        loader.addFont(Future.value(ByteData.view(bytes.buffer)));
        await loader.load();
      }
    });
    final app = _FirstApp();
    addTearDown(app.dispose);
    await _mount(tester, app, FirstHarnessLaunch());
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile(Uri.file('$output/first-harness.png')),
    );
    await tester.pumpWidget(const SizedBox());
  });
}
