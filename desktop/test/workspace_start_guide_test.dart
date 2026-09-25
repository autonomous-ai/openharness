import 'support/open_harness.dart';

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_native.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/harness_customize_pane.dart';
import 'package:harness/settings/appearance/wallpaper_section.dart';
import 'package:harness/widgets/workspace_start_guide.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/launch_menu.dart';
import 'swarm_screen_test.dart' show terminal;

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
      ..localEndpoint = LocalCliEndpoint(
        computerId: 'test-computer',
        wsUri: Uri.parse('ws://fixture.invalid'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
      )
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }
  List<String> installed = ['codex'];
  Completer<String?>? creation;
  final input = <TerminalBinaryFrame>[];
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
    GridModel? model,
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
    final failure = await creation?.future;
    if (failure != null) return failure;
    machineStates[machineId]!.agents = [
      Agent(
        id: 'first',
        name: 'First harness',
        engine: engine,
        terminalAvailable: true,
      ),
    ];
    adoptSessionForTest(terminal('first', input)..engineId = engine);
    notifyListeners();
    return null;
  }
}

Future<void> _mount(
  WidgetTester tester,
  _FirstApp app, {
  bool nativeTabs = false,
  WorkspaceOnboarding? onboarding,
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
        onboarding: onboarding,
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 150));
}

void main() {
  Future<void> chooseProject(WidgetTester tester) async {
    await openLaunchRow(tester, 'agent');
    await typeHarnessQuery(tester, 'Codex');
    await key(tester, LogicalKeyboardKey.enter);
    await openLaunchRow(tester, 'project');
    await tester.tap(
      find.byKey(
        ValueKey('new-harness-option-${NewHarnessController.newProjectId}'),
      ),
    );
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.enter);
    await typeHarnessQuery(tester, 'first-project');
    await key(tester, LogicalKeyboardKey.enter);
  }

  setUp(() {
    newHarnessOpensInBox = true;
  });
  tearDown(() => newHarnessOpensInBox = false);

  for (final keyboard in [false, true]) {
    testWidgets(
      'first welcome starts one usable harness and records progress (keyboard=$keyboard)',
      (tester) async {
        final app = _FirstApp()
          ..installed = keyboard ? [] : ['claude', 'codex'];
        final journey = WorkspaceOnboarding();
        addTearDown(app.dispose);
        addTearDown(journey.dispose);
        await _mount(tester, app, onboarding: journey);
        expect(find.text('Follow your curiosity.'), findsOneWidget);
        expect(find.text('○'), findsNothing);
        expect(app.panes, isEmpty);

        if (keyboard) {
          await key(tester, LogicalKeyboardKey.keyN, cmd: true);
        } else {
          await tester.tap(find.byKey(const ValueKey('welcome-agent.new')));
        }
        await tester.pumpAndSettle();
        expect(find.byType(NewHarnessForm), findsOneWidget);
        expect(app.launches, isEmpty);
        expect(journey.completed(OnboardingStep.harnesses), isFalse);
        await chooseProject(tester);
        if (keyboard) {
          await startHarness(tester);
        } else {
          await tester.tap(
            find.byKey(const ValueKey('new-harness-field-start')),
          );
        }
        await tester.pumpAndSettle();
        expect(app.launches, hasLength(1));
        expect(app.launches.single.project?.folderName, 'first-project');
        expect(find.byType(NewHarnessForm), findsNothing);
        expect(find.byType(TerminalView), findsOneWidget);
        expect(
          tester.widget<TerminalView>(find.byType(TerminalView)).readOnly,
          isFalse,
        );
        expect(app.focusedPane?.session?.acceptsInput, isTrue);
        expect(journey.completed(OnboardingStep.harnesses), isTrue);
        expect(journey.completed(OnboardingStep.machines), isFalse);
        expect(journey.completed(OnboardingStep.models), isFalse);
        expect(app.input, isEmpty);
        // The launch action must hand focus to the terminal without a click.
        expect(
          tester
              .widget<TerminalView>(find.byType(TerminalView))
              .focusNode!
              .hasFocus,
          isTrue,
        );
        expect(tester.testTextInput.hasAnyClients, isTrue);
        tester.testTextInput.enterText('h');
        await tester.pump();
        expect(app.input.single.bytes, [104]);

        await key(tester, LogicalKeyboardKey.keyT, cmd: true);
        await tester.pumpAndSettle();
        expect(find.byType(WorkspaceWelcome), findsOneWidget);
        expect(find.text('Follow your curiosity.'), findsOneWidget);
        expect(find.text('✓'), findsNothing);
        expect(find.text('○'), findsNothing);
        expect(app.launches, hasLength(1));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('a failed first start stays actionable and retries once', (
    tester,
  ) async {
    final app = _FirstApp()..creation = Completer<String?>();
    final journey = WorkspaceOnboarding();
    addTearDown(app.dispose);
    addTearDown(journey.dispose);
    await _mount(tester, app, onboarding: journey);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    await tester.pumpAndSettle();
    final start = find.byKey(const ValueKey('new-harness-field-start'));
    await chooseProject(tester);
    await startHarness(tester);
    await tester.pump();
    expect(find.text('Starting harness…'), findsOneWidget);
    await tester.tap(start);
    await key(tester, LogicalKeyboardKey.enter);
    expect(app.launches, hasLength(1));
    expect(app.panes, isEmpty);
    expect(journey.completed(OnboardingStep.harnesses), isFalse);

    app.creation!.complete('Could not start the harness. Try again.');
    await tester.pumpAndSettle();
    expect(
      find.text('Could not start the harness. Try again.'),
      findsOneWidget,
    );
    expect(find.byType(NewHarnessForm), findsOneWidget);
    expect(journey.completed(OnboardingStep.harnesses), isFalse);
    final project = app.launches.single.project;
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(find.text('Follow your curiosity.'), findsOneWidget);
    expect(find.text('○'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('welcome-agent.new')));
    await tester.pumpAndSettle();
    app.creation = null;
    await chooseProject(tester);
    await tester.tap(start);
    await tester.pumpAndSettle();
    expect(app.launches, hasLength(2));
    expect(app.launches.last.project?.name, project?.name);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(find.byType(TerminalView), findsOneWidget);
    expect(journey.completed(OnboardingStep.harnesses), isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('welcome and New Tab stay quiet until an action is chosen', (
    tester,
  ) async {
    final app = _FirstApp();
    addTearDown(app.dispose);
    await _mount(tester, app);
    final search = find.byKey(const ValueKey('swarm-search-input'));
    expect(find.byType(WorkspaceWelcome), findsOneWidget);
    expect(find.text('Follow your curiosity.'), findsOneWidget);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(search, findsNothing);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    expect(find.byType(NewHarnessForm), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.byType(NewHarnessForm), findsNothing);
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    final tab = app.activeSwarmId;
    expect(find.byType(WorkspaceWelcome), findsOneWidget);
    expect(find.text('Follow your curiosity.'), findsOneWidget);
    expect(search, findsNothing);
    await openHarnessPicker(tester);
    await tester.pump();
    expect(search, findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(app.activeSwarmId, tab);
    expect(search, findsNothing);
    await tester.tap(find.byKey(const ValueKey('welcome-agent.new')));
    await tester.pump();
    expect(find.byType(NewHarnessForm), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(app.activeSwarmId, tab);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(app.launches, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Command-O opens harnesses and Command-O opens commands', (
    tester,
  ) async {
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
    await _mount(tester, app);
    expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
    await openHarnessPicker(tester);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(find.byKey(const ValueKey('swarm-search-input')), findsOneWidget);
    expect(find.text('Existing work'), findsOneWidget);
    expect(find.byType(WorkspaceWelcome), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    app.notifyListeners();
    await tester.pump();
    expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    final input = tester.widget<TextField>(
      find.byKey(const ValueKey('swarm-search-input')),
    );
    expect(input.controller!.text, '>');
    expect(input.controller!.selection.baseOffset, 1);
    expect(find.text('Existing work'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('restored work keeps its focused pane', (tester) async {
    final app = _FirstApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    await _mount(tester, app);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(app.focusedPane, same(pane));
    await tester.pumpWidget(const SizedBox());
  });

  for (final native in [false, true]) {
    testWidgets(
      'welcome review uses New Tab and preserves live work (native=$native)',
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
        await _mount(tester, app, nativeTabs: native);
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
        expect(welcome.isNewTabPage, isTrue);
        expect(app.swarms, [first, second, welcome]);
        expect(app.allPanes, [pane, other]);
        expect(find.byType(WorkspaceWelcome).hitTestable(), findsOneWidget);
        expect(find.byType(NewHarnessForm), findsNothing);
        expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
        await openHarnessPicker(tester);
        expect(
          find.byKey(const ValueKey('swarm-search-input')),
          findsOneWidget,
        );
        void expectGuideFixed(Finder dock) {
          final drawing = tester.getRect(
            find.byKey(const ValueKey('workspace-welcome-text')).last,
          );
          expect(drawing.top, greaterThanOrEqualTo(0));
          expect(
            drawing.center,
            tester.getRect(find.byType(WorkspaceWelcome).last).center,
          );
          expect(dock, findsOneWidget);
          expect(tester.takeException(), isNull);
        }

        final searchDock = find.byKey(const ValueKey('swarm-search-results'));
        expectGuideFixed(searchDock);
        tester.view.physicalSize = const Size(960, 640);
        await tester.pump();
        expectGuideFixed(searchDock);
        expect(tester.state<TerminalViewState>(view), same(renderer));
        expect(app.launches, isEmpty);

        await key(tester, LogicalKeyboardKey.keyN, cmd: true);
        await tester.pump(const Duration(milliseconds: 150));
        expect(find.byType(NewHarnessForm), findsOneWidget);
        expectGuideFixed(find.byKey(const ValueKey('new-harness-form')));
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pump();
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

  testWidgets('welcome text and wallpaper stay fixed when either dock opens', (
    tester,
  ) async {
    final app = _FirstApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      Agent(id: 'saved', name: 'Robot arm', engine: 'claude'),
    ];
    await _mount(tester, app);
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    await tester.pumpAndSettle();
    final page = find.byType(WorkspaceWelcome).last;
    final tagline = find.byKey(const ValueKey('workspace-welcome-text')).last;
    final textRect = tester.getRect(tagline);
    final wallpaper = find.byKey(const ValueKey('welcome-wallpaper')).last;
    final wallpaperRect = tester.getRect(wallpaper);
    void expectCentered() {
      expect(tester.getRect(tagline), textRect);
      expect(tester.getRect(wallpaper), wallpaperRect);
      expect(tester.getCenter(tagline), tester.getRect(page).center);
      expect(
        find.descendant(of: page, matching: find.byType(Image)),
        findsNothing,
      );
    }

    expectCentered();

    final search = find.byKey(const ValueKey('swarm-search-input'));
    expect(search, findsNothing);
    await openHarnessPicker(tester);
    await tester.enterText(search, 'nothing matches');
    await tester.pumpAndSettle();
    expectCentered();

    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    await tester.pumpAndSettle();
    expect(find.byType(NewHarnessForm), findsOneWidget);
    expectCentered();
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expectCentered();
    await tester.tap(find.byKey(const ValueKey('welcome-customize')));
    await tester.pumpAndSettle();
    expect(find.byType(HarnessCustomizePane), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('customize-wallpaper')));
    await tester.pumpAndSettle();
    expect(find.byType(WallpaperSection), findsOneWidget);
    expectCentered();
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(HarnessCustomizePane), findsNothing);
    expectCentered();
    await tester.pumpWidget(const SizedBox());
  });

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
      await _mount(tester, app);
      final name = hasHarnesses ? 'welcome-existing' : 'welcome-new';
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
        for (final (size, name) in [
          (const Size(1280, 800), 'new-tab'),
          (const Size(960, 640), 'new-tab-compact'),
        ]) {
          tester.view.physicalSize = size;
          await tester.pumpAndSettle();
          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(Uri.file('$output/$name.png')),
          );
        }
      }
      await tester.pumpWidget(const SizedBox());
    }
  });
}
