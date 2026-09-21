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
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_native.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/first_harness_launch.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/new_tab_wallpaper.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/workspace_start_guide.dart';
import 'package:xterm/xterm.dart';

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
  void reviewWallpaper(NewTabWallpaper wallpaper) {
    activeSwarm.wallpaper = wallpaper;
    notifyListeners();
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
  FirstHarnessLaunch entry, {
  bool nativeTabs = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: nativeTabs,
        firstLaunch: entry,
      ),
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
      expect(find.text('New Harness'), findsOneWidget);
      expect(find.text('New Tab'), findsOneWidget);
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

  for (final native in [false, true]) {
    testWidgets(
      'onboarding review reuses a welcome tab and preserves live work (native=$native)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (_) async => true,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = _FirstApp();
        addTearDown(app.dispose);
        app.machineStates['m']!.agents = [
          for (final id in ['a0', 'a1'])
            Agent(
              id: id,
              name: 'Work $id',
              engine: 'codex',
              terminalAvailable: true,
            ),
        ];
        final first = app.activeSwarm;
        app.renameSwarm(first.id, 'Work');
        final session = terminal('a0', [])
          ..terminal.write('Keep this output\r\n');
        final pane = app.adoptSessionForTest(session);
        app.newSwarm(name: 'Research');
        final second = app.activeSwarm;
        final other = app.adoptSessionForTest(terminal('a1', []));
        app.selectSwarm(first.id);
        await _mount(tester, app, FirstHarnessLaunch(), nativeTabs: native);
        final view = find.byWidgetPredicate(
          (widget) =>
              widget is TerminalView && widget.terminal == session.terminal,
          skipOffstage: false,
        );
        final renderer = tester.state<TerminalViewState>(view);
        await tester.tap(view.hitTestable());
        await tester.pump();

        Future<void> review() async {
          if (native) {
            tester.binding.defaultBinaryMessenger.handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                const MethodCall('keymapCommand', {
                  'command': 'app.onboarding_review',
                }),
              ),
              (_) {},
            );
            await tester.pump();
          } else {
            await key(
              tester,
              LogicalKeyboardKey.keyO,
              cmd: true,
              alt: true,
              shift: true,
            );
          }
          await tester.pump(const Duration(milliseconds: 150));
        }

        await review();
        final welcome = app.activeSwarm;
        expect(welcome.name, 'Welcome');
        expect(app.swarms, [first, second, welcome]);
        expect(app.allPanes, [pane, other]);
        expect(find.byType(WorkspaceStartGuide).hitTestable(), findsOneWidget);
        expect(find.byType(NewHarnessBox), findsNothing);
        expect(
          find.byKey(const ValueKey('swarm-search-input')),
          findsOneWidget,
        );
        void expectGuideAboveDock(Finder dock) {
          final drawing = tester.getRect(
            find.byKey(const ValueKey('workspace-welcome-diagram')).last,
          );
          final shortcuts = tester.getRect(
            find.byKey(const ValueKey('workspace-all-shortcuts')).last,
          );
          expect(drawing.top, greaterThanOrEqualTo(0));
          expect(drawing.bottom, lessThanOrEqualTo(tester.getTopLeft(dock).dy));
          expect(
            shortcuts.bottom,
            lessThanOrEqualTo(tester.getTopLeft(dock).dy),
          );
          expect(tester.takeException(), isNull);
        }

        final searchDock = find.byKey(const ValueKey('swarm-search-results'));
        expectGuideAboveDock(searchDock);
        tester.view.physicalSize = const Size(960, 640);
        await tester.pump();
        expectGuideAboveDock(searchDock);
        expect(tester.state<TerminalViewState>(view), same(renderer));
        expect(app.launches, isEmpty);

        await key(tester, LogicalKeyboardKey.keyN, cmd: true);
        await tester.pump(const Duration(milliseconds: 150));
        expect(find.byType(NewHarnessBox), findsOneWidget);
        expectGuideAboveDock(find.byKey(const ValueKey('new-harness-box')));
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pump();
        await review();
        expect(
          find.byKey(const ValueKey('swarm-search-input')),
          findsOneWidget,
        );
        expect(app.activeSwarm, same(welcome));
        expect(app.swarms, [first, second, welcome]);
        app.selectSwarm(first.id);
        await tester.pump();
        await review();
        expect(app.activeSwarm, same(welcome));
        expect(app.swarms, [first, second, welcome]);

        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.keyW, cmd: true);
        await tester.pump();
        expect(app.swarms, [first, second]);
        app.selectSwarm(first.id);
        await tester.pump();
        expect(app.focusedPane, same(pane));
        expect(pane.session, same(session));
        expect(tester.state<TerminalViewState>(view), same(renderer));
        expect(
          session.terminal.buffer.lines[0].getText(),
          contains('Keep this output'),
        );
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('reviewing Welcome with no harnesses reopens New Harness', (
    tester,
  ) async {
    final app = _FirstApp();
    addTearDown(app.dispose);
    await _mount(tester, app, FirstHarnessLaunch());
    await key(tester, LogicalKeyboardKey.escape);
    for (var visit = 0; visit < 2; visit++) {
      await key(
        tester,
        LogicalKeyboardKey.keyO,
        cmd: true,
        alt: true,
        shift: true,
      );
      await tester.pump(const Duration(milliseconds: 150));
      expect(app.activeSwarm.name, 'Welcome');
      expect(app.swarms.where((tab) => tab.name == 'Welcome'), hasLength(1));
      expect(find.byType(NewHarnessBox), findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
      expect(
        tester
            .getBottomRight(
              find.byKey(const ValueKey('workspace-welcome-diagram')).last,
            )
            .dy,
        lessThanOrEqualTo(
          tester.getTopLeft(find.byKey(const ValueKey('new-harness-box'))).dy,
        ),
      );
      expect(app.launches, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump();
    }
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'onboarding review key is native-exported but absent from help and practice',
    (tester) async {
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final contexts = nativeKeymapSnapshot(map)['contexts'] as Map;
      for (final context in ['workspace', 'terminal']) {
        final binding = (contexts[context] as List).cast<Map>().singleWhere(
          (binding) => binding['command'] == 'app.onboarding_review',
        );
        expect(binding['keys'], ['alt+cmd+shift+o']);
      }
      expect(
        keyboardLessons(map)
            .any((lesson) => lesson.command == 'app.onboarding_review'),
        isFalse,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: KeymapProvider(
            keymap: map,
            child: Builder(
              builder: (context) {
                expect(
                  effectiveShortcutRows(
                    context,
                    KeymapContext.workspace,
                  ).any((row) => row.label == 'Review onboarding'),
                  isFalse,
                );
                return const SizedBox();
              },
            ),
          ),
        ),
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

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

  testWidgets(
    'New Tab artwork and caption stay fixed while filtering and editing the dock',
    (tester) async {
      final app = _FirstApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [
        Agent(id: 'saved', name: 'Robot arm', engine: 'claude'),
      ];
      await _mount(tester, app, FirstHarnessLaunch());
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await tester.pumpAndSettle();
      final page = find.byKey(const ValueKey('new-tab-start-page'));
      final tagline = find.byKey(const ValueKey('new-tab-tagline'));
      final wallpaper = app.activeSwarm.wallpaper;
      final bounds = tester.getRect(page);
      final center = tester.getCenter(tagline);
      expect(center, bounds.center);

      final search = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(search, 'nothing matches');
      await tester.pumpAndSettle();
      expect(tester.getRect(page), bounds);
      expect(tester.getCenter(tagline), center);
      expect(app.activeSwarm.wallpaper, wallpaper);

      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await tester.pumpAndSettle();
      expect(find.byType(NewHarnessBox), findsOneWidget);
      expect(tester.getRect(page), bounds);
      expect(tester.getCenter(tagline), center);
      expect(app.activeSwarm.wallpaper, wallpaper);
      expect(
        tester.getRect(find.byType(NewHarnessBox)).top,
        greaterThan(tester.getRect(tagline).bottom),
      );
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
    for (final hasHarnesses in [false, true]) {
      final app = _FirstApp();
      addTearDown(app.dispose);
      if (hasHarnesses) {
        app.machineStates['m']!.agents = [
          for (var index = 0; index < 20; index++)
            Agent(
              id: 'saved-$index',
              name: 'Existing harness $index',
              engine: 'codex',
              terminalAvailable: true,
            ),
        ];
      }
      await _mount(tester, app, FirstHarnessLaunch());
      final name = hasHarnesses ? 'welcome-search' : 'first-harness';
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$output/$name.png')),
      );
      tester.view.physicalSize = const Size(960, 640);
      await tester.pump();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$output/$name-compact.png')),
      );
      if (hasHarnesses) {
        await key(tester, LogicalKeyboardKey.keyT, cmd: true);
        for (final wallpaper in NewTabWallpaper.values) {
          app.reviewWallpaper(wallpaper);
          await tester.pump();
          await tester.runAsync(
            () => precacheImage(
              AssetImage(wallpaper.asset),
              tester.element(find.byType(NewTabStartPage).first),
            ),
          );
          for (final (size, name) in [
            (const Size(1280, 800), 'new-tab'),
            (const Size(960, 640), 'new-tab-compact'),
          ]) {
            tester.view.physicalSize = size;
            await tester.pumpAndSettle();
            await expectLater(
              find.byType(MaterialApp),
              matchesGoldenFile(
                Uri.file('$output/$name-${wallpaper.name}.png'),
              ),
            );
          }
        }
      }
      await tester.pumpWidget(const SizedBox());
    }
  });
}
