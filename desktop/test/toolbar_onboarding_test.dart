import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/onboarding_card.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/model_manager.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore;

class _App extends ModelManagerTestApp {
  _App() : super(ModelManagerConnection()) {
    currentUser = const CurrentUserProfile(email: 'review@example.test');
    machineStates.remove('other');
    machines = [stateOf('m')!.machine];
    stateOf('m')!.nodeOnline = true;
  }
  String? password;
  int refreshes = 0;
  final connections = <String>[];
  @override
  Future<void> retryMachines() async {
    refreshes++;
  }

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      RemotePasswordStatus(hasPassword: password != null);
  @override
  Future<RemotePasswordSetResult> setRemotePassword(String value) async {
    password = value;
    return const RemotePasswordSetResult();
  }

  @override
  Future<String?> connectWithPassword(
    String id,
    String value, {
    void Function(String stage)? onProgress,
  }) async {
    if (value != '123456') return 'Incorrect password. Try again.';
    connections.add(id);
    stateOf(id)!
      ..needsLink = false
      ..connectionStatus = ConnectionStatus.connected;
    notifyListeners();
    return null;
  }
}

void main() {
  late _App app;
  late WorkspaceOnboarding journey;
  setUp(() {
    final previous = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = previous);
    app = _App();
  });
  tearDown(() {
    app.dispose();
    journey.dispose();
  });
  Future<void> mount(
    WidgetTester tester, {
    AppKeymap? keymap,
    bool native = false,
    MemoryStore? storage,
  }) async {
    journey = WorkspaceOnboarding(storage: storage);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => keymap == null
            ? child!
            : KeymapProvider(keymap: keymap, child: child!),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: native,
          onboarding: journey,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> tap(WidgetTester tester, Finder finder) async {
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  void localHarness() {
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'work',
        name: 'My project',
        engine: 'codex',
        terminalAvailable: true,
      ),
    ];
    app.adoptSessionForTest(terminal('work', []));
  }

  for (var completed = 1; completed <= 3; completed++) {
    testWidgets(
      'returning welcome restores $completed completed steps with working actions',
      (tester) async {
        final storage = MemoryStore();
        final previous = WorkspaceOnboarding(storage: storage);
        previous.sync(
          scope: 'account:review@example.test',
          observed: OnboardingStep.values.take(completed).toSet(),
          otherComputer: false,
          modelsAvailable: true,
        );
        await tester.pump();
        expect(previous.loaded, isTrue);
        await previous.flush();
        previous.dispose();

        // A new tracker and screen restore only saved history; no harnesses
        // are open to supply these milestones again.
        await mount(tester, storage: storage);
        expect(app.allPanes, isEmpty);
        expect(journey.scope, 'account:review@example.test');
        expect(
          OnboardingStep.values.where(journey.completed),
          OnboardingStep.values.take(completed),
        );
        if (completed < 3) {
          expect(find.text('Harness like a boss.'), findsOneWidget);
          for (final (index, step) in OnboardingStep.values.indexed) {
            expect(
              tester
                  .widget<Text>(
                    find.byKey(ValueKey('welcome-progress-${step.name}')),
                  )
                  .data,
              index < completed ? '✓' : '○',
            );
          }
        } else {
          expect(find.text('Follow your curiosity.'), findsOneWidget);
          expect(find.text('○'), findsNothing);
          expect(find.text('✓'), findsNothing);
        }

        final destinations = completed < 3
            ? ['agent.new', 'machines.list', 'models.list']
            : ['agent.new', 'agent.open', 'app.store'];
        for (final command in destinations) {
          await tap(tester, find.byKey(ValueKey('welcome-$command')));
          switch (command) {
            case 'agent.new':
              expect(find.byType(NewHarnessForm), findsOneWidget);
            case 'machines.list':
              expect(
                find.byKey(const ValueKey('machines-panel')),
                findsOneWidget,
              );
            case 'models.list':
              expect(find.byType(ModelsPanel), findsOneWidget);
            case 'agent.open':
              expect(
                find.byKey(const ValueKey('swarm-search-input')),
                findsOneWidget,
              );
            case 'app.store':
              expect(app.activeSwarm.isStore, isTrue);
          }
          if (command == 'app.store') {
            await key(tester, LogicalKeyboardKey.keyT, cmd: true);
          } else {
            await key(tester, LogicalKeyboardKey.escape);
          }
          await tester.pumpAndSettle();
        }
        for (final shortcut in [
          LogicalKeyboardKey.keyN,
          if (completed == 3) ...[
            LogicalKeyboardKey.keyO,
            LogicalKeyboardKey.keyS,
          ],
          LogicalKeyboardKey.keyM,
          LogicalKeyboardKey.keyI,
        ]) {
          await key(tester, shortcut, cmd: true);
          await tester.pumpAndSettle();
          if (shortcut == LogicalKeyboardKey.keyN) {
            expect(find.byType(NewHarnessForm), findsOneWidget);
          } else if (shortcut == LogicalKeyboardKey.keyO) {
            expect(
              find.byKey(const ValueKey('swarm-search-input')),
              findsOneWidget,
            );
          } else if (shortcut == LogicalKeyboardKey.keyS) {
            expect(app.activeSwarm.isStore, isTrue);
          } else if (shortcut == LogicalKeyboardKey.keyM) {
            expect(
              find.byKey(const ValueKey('machines-panel')),
              findsOneWidget,
            );
          } else {
            expect(find.byType(ModelsPanel), findsOneWidget);
          }
          await key(
            tester,
            shortcut == LogicalKeyboardKey.keyS
                ? LogicalKeyboardKey.keyT
                : LogicalKeyboardKey.escape,
            cmd: shortcut == LogicalKeyboardKey.keyS,
          );
          await tester.pumpAndSettle();
        }
        expect(
          OnboardingStep.values.where(journey.completed),
          OnboardingStep.values.take(completed),
          reason:
              'Opening or cancelling actions must not change saved progress.',
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  for (final native in [false, true]) {
    testWidgets(
      'welcome clicks and keyboard open real panels (native=$native)',
      (tester) async {
        await mount(tester, native: native);
        final models = find.byType(ModelsPanel);
        final machines = find.byKey(const ValueKey('machines-panel'));
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        expect(models, findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        expect(models, findsNothing);

        if (!native) {
          await tap(tester, find.byTooltip('Harnesses'));
          expect(find.byKey(const ValueKey('session-manager')), findsOneWidget);
          await key(tester, LogicalKeyboardKey.keyI, cmd: true);
          await tester.pumpAndSettle();
          expect(find.byKey(const ValueKey('session-manager')), findsNothing);
          expect(models, findsOneWidget);
          await key(tester, LogicalKeyboardKey.escape);
          await tester.pumpAndSettle();
        }

        await tap(tester, find.byKey(const ValueKey('welcome-models.list')));
        expect(models, findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyM, cmd: true);
        await tester.pumpAndSettle();
        expect(models, findsNothing);
        expect(machines, findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        expect(machines, findsNothing);
        expect(models, findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyN, cmd: true);
        await tester.pumpAndSettle();
        expect(models, findsNothing);
        expect(find.byType(NewHarnessForm), findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await tap(tester, find.byKey(const ValueKey('welcome-machines.list')));
        expect(machines, findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await tap(tester, find.byKey(const ValueKey('welcome-agent.new')));
        expect(find.byType(NewHarnessForm), findsOneWidget);
        expect(OnboardingStep.values.any(journey.completed), isFalse);
        expect(app.actions, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('Models shortcut, welcome hint and toolbar follow a live remap', (
    tester,
  ) async {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    await mount(tester, keymap: map);
    expect(find.byTooltip('Models ⌘I'), findsOneWidget);
    map.apply('''{"bindings":[
      {"keys":"cmd+i","command":null},
      {"keys":"cmd+u","command":"models.list"}
    ]}''');
    await tester.pumpAndSettle();
    expect(find.byTooltip('Models ⌘U'), findsOneWidget);
    expect(find.text('⌘U'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.keyI, cmd: true);
    expect(find.byType(ModelsPanel), findsNothing);
    await key(tester, LogicalKeyboardKey.keyU, cmd: true);
    await tester.pumpAndSettle();
    expect(find.byType(ModelsPanel), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> Open Models',
    );
    await tester.pumpAndSettle();
    expect(find.text('Open Models'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(ModelsPanel), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'completed welcome switches on New Tab and everyday clicks open their destinations',
    (tester) async {
      await mount(tester);
      journey.sync(
        scope: journey.scope!,
        observed: OnboardingStep.values.toSet(),
        otherComputer: true,
        modelsAvailable: true,
      );
      await tester.pumpAndSettle();
      expect(find.text('✓'), findsNWidgets(3));
      expect(find.text('Harness like a boss.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await tester.pumpAndSettle();
      expect(find.text('Follow your curiosity.'), findsOneWidget);
      expect(find.text('✓'), findsNothing);
      await tap(tester, find.byKey(const ValueKey('welcome-agent.open')));
      expect(find.byKey(const ValueKey('swarm-search-input')), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tap(tester, find.byKey(const ValueKey('welcome-app.store')));
      expect(app.activeSwarm.isStore, isTrue);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.keyS, cmd: true);
      await tester.pumpAndSettle();
      expect(app.activeSwarm.isStore, isTrue);
      await key(tester, LogicalKeyboardKey.keyI, cmd: true);
      await tester.pumpAndSettle();
      expect(find.byType(ModelsPanel), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'first invitation opens real creation and survives merely viewing',
    (tester) async {
      await mount(tester);
      expect(
        find.byKey(const ValueKey('onboarding-harnesses-dot')),
        findsOneWidget,
      );
      await tap(tester, find.byTooltip('Harnesses'));
      expect(find.text('Run your first harness'), findsOneWidget);
      expect(journey.completed(OnboardingStep.harnesses), isFalse);
      expect(
        find.byKey(const ValueKey('onboarding-harnesses-dot')),
        findsNothing,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tap(tester, find.byTooltip('Harnesses'));
      await tap(tester, find.text('New harness'));
      expect(find.byKey(const ValueKey('session-manager')), findsNothing);
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final hasPassword in [false, true]) {
    testWidgets(
      'Machines guides access to existing work (password=$hasPassword)',
      (tester) async {
        localHarness();
        if (hasPassword) app.password = '123456';
        await mount(tester);
        expect(journey.next, OnboardingStep.machines);
        await tap(tester, find.byKey(const ValueKey('swarm-machines-button')));
        await tap(tester, find.text('Set up access'));
        expect(find.text('On your other computer'), findsOneWidget);
        expect(find.textContaining('Connect to This Mac.'), findsOneWidget);
        if (!hasPassword) {
          final field = find.byType(TextField);
          expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
          await tester.enterText(field, '123456');
          await tap(tester, find.text('Save'));
        }
        expect(app.password, '123456');
        expect(find.text('Change password'), findsOneWidget);
        expect(journey.completed(OnboardingStep.machines), isFalse);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('second computer connects then opens only the source harnesses', (
    tester,
  ) async {
    const source = Machine(
      machineId: 'source',
      name: 'M2',
      authMode: MachineAuthMode.remote,
    );
    app.machineStates['source'] = MachineState(source)
      ..nodeOnline = true
      ..needsLink = true
      ..agents = const [
        Agent(
          id: 'existing',
          name: 'Existing work',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
    app.machines = [...app.machines, source];
    app.stateOf('m')!.agents = const [
      Agent(id: 'unrelated', name: 'Work on this computer', engine: 'codex'),
    ];
    await mount(tester);
    expect(journey.next, OnboardingStep.machines);
    await tap(tester, find.byKey(const ValueKey('swarm-machines-button')));
    await tap(tester, find.text('Connect to M2'));
    final field = find.descendant(
      of: find.byKey(const ValueKey('machines-panel')),
      matching: find.byType(TextField),
    );
    await tester.enterText(field, 'wrong');
    await tap(tester, find.text('Connect'));
    expect(find.text('Incorrect password. Try again.'), findsOneWidget);
    await tester.enterText(field, '123456');
    await tap(tester, find.text('Connect'));
    expect(app.connections, ['source']);
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
    expect(find.text('Harnesses · M2'), findsOneWidget);
    expect(find.text('Existing work'), findsWidgets);
    expect(find.text('Work on this computer'), findsNothing);
    expect(journey.completed(OnboardingStep.machines), isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'an offline source offers recovery before asking for its password',
    (tester) async {
      const source = Machine(
        machineId: 'source',
        name: 'M2',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['source'] = MachineState(source)
        ..nodeOnline = false
        ..needsLink = true;
      app.machines = [...app.machines, source];
      await mount(tester);
      expect(journey.next, OnboardingStep.machines);
      await tap(tester, find.byKey(const ValueKey('swarm-machines-button')));
      expect(
        find.text('Open Harness on M2, then check again.'),
        findsOneWidget,
      );
      expect(find.text('Set up access'), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('machines-panel')),
          matching: find.byType(TextField),
        ),
        findsNothing,
      );
      await tap(tester, find.text('Check again'));
      expect(app.refreshes, 1);
      app.stateOf('source')!.nodeOnline = true;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.text('Connect to M2'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'skipping Machines offers Models; explore selects Local without starting a download',
    (tester) async {
      localHarness();
      await app.modelManager.refresh();
      await mount(tester);
      await tap(tester, find.byKey(const ValueKey('swarm-machines-button')));
      await tap(tester, find.byTooltip('Dismiss suggestion'));
      expect(journey.next, OnboardingStep.models);
      expect(
        find.byKey(const ValueKey('onboarding-models-dot')),
        findsOneWidget,
      );
      await tap(tester, find.byKey(const ValueKey('swarm-models-button')));
      expect(find.byType(ModelsPanel), findsOneWidget);
      expect(find.byType(OnboardingCard), findsOneWidget);
      expect(find.text('Power a harness with local AI'), findsOneWidget);
      await tap(tester, find.text('Explore local models'));
      expect(find.text('Qwen3.8-27B'), findsOneWidget);
      expect(app.actions, isEmpty);
      expect(journey.completed(OnboardingStep.models), isFalse);
      expect(app.panes.single.agentId, 'work');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
