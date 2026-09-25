import 'support/workspace_tools.dart';
import 'support/resource_picker.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/terminal/terminal_session.dart';
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

  Future<void> localHarness() async {
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'work',
        name: 'My project',
        engine: 'codex',
        terminalAvailable: true,
      ),
    ];
    app.adoptSessionForTest(terminal('work', []));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'work',
    });
  }

  testWidgets('egg hint disappears and does not repeat on a new tab', (
    tester,
  ) async {
    await mount(tester, storage: MemoryStore());
    expect(
      find.byKey(const ValueKey('companion-arrival-hint')),
      findsOneWidget,
    );
    expect(journey.completedCount, 0);
    await tester.pump(const Duration(seconds: 6));
    expect(find.byKey(const ValueKey('companion-arrival-hint')), findsNothing);
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('companion-arrival-hint')), findsNothing);
    expect(journey.needsCompanionHint, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'discovery notice keeps work feedback and hatches without taking focus',
    (tester) async {
      await mount(tester);
      final messenger = ScaffoldMessenger.of(
        tester.element(find.byType(SwarmScreen)),
      );
      messenger.showSnackBar(
        const SnackBar(
          duration: Duration(minutes: 1),
          content: Text('Work needs your attention.'),
        ),
      );
      final focus = FocusManager.instance.primaryFocus;
      journey.sync(
        scope: journey.scope!,
        observed: WorkspaceOnboarding.hatchSteps.toSet(),
        otherComputer: true,
        modelsAvailable: false,
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('Work needs your attention.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('companion-discovery-notice')),
        findsOneWidget,
      );
      expect(FocusManager.instance.primaryFocus, same(focus));
      await tester.tap(find.text('[ hatch ]'));
      await tester.pump();
      expect(journey.companion, isNotNull);
      expect(
        find.byKey(const ValueKey('companion-discovery-notice')),
        findsNothing,
      );
      expect(find.text('Hatch your companion'), findsNothing);
      expect(find.text('Work needs your attention.'), findsOneWidget);
      expect(FocusManager.instance.primaryFocus, same(focus));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'three discoveries hatch directly from the egg without moving focus or requiring a model',
    (tester) async {
      await mount(tester);
      journey.sync(
        scope: journey.scope!,
        observed: WorkspaceOnboarding.hatchSteps.toSet(),
        otherComputer: true,
        modelsAvailable: false,
      );
      await tester.pumpAndSettle();
      expect(journey.completed(OnboardingStep.models), isFalse);
      final button = find.byKey(const ValueKey('companion-tab-button'));
      final before = tester.getRect(button);
      final focus = FocusManager.instance.primaryFocus;
      await tester.tap(button);
      await tester.pump();
      expect(journey.companion, isNotNull);
      expect(find.text('Hatch your companion'), findsNothing);
      expect(FocusManager.instance.primaryFocus, same(focus));
      await tester.pump(const Duration(seconds: 3));
      expect(tester.getRect(button), before);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'symbol opens onboarding at the far right and preserves shortcuts',
    (tester) async {
      await mount(tester);
      final button = find.byKey(const ValueKey('companion-tab-button'));
      expect(find.text(CompanionController.egg), findsOneWidget);
      expect(find.text('Hatch a companion'), findsNothing);
      expect(
        tester.getRect(button).left,
        greaterThan(
          tester
              .getRect(find.byKey(const ValueKey('workspace-pane-context')))
              .right,
        ),
      );
      await tap(tester, button);
      expect(find.text('Hatch your companion'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Hatch your companion'), findsNothing);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> Terminal companion',
      );
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Hatch your companion'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tap(tester, button);
      await tap(tester, find.byKey(const ValueKey('companion-step-harnesses')));
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(find.text('Hatch your companion'), findsNothing);
      expect(journey.completedCount, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'unlocks require completed work; agent and model switches are not new harnesses',
    (tester) async {
      app.inventory = const GridModels(
        gridName: 'home',
        models: [GridModel(id: 'qwen', node: 'm')],
      );
      await app.modelManager.refresh();
      await mount(tester);
      app.stateOf('m')!.agents = const [
        Agent(
          id: 'work',
          name: 'Work',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
      app.adoptSessionForTest(terminal('work', []));
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(journey.completedCount, 0);
      await app.handleMachineEventForTest('m', {
        'type': 'turn_started',
        'agentId': 'work',
      });
      await tester.pumpAndSettle();
      expect(journey.completedCount, 0);
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'work',
      });
      await tester.pumpAndSettle();
      expect(journey.completedCount, 1);
      expect(find.text('1/4'), findsNothing);
      app.stateOf('m')!.agents = const [
        Agent(
          id: 'work',
          name: 'Work',
          engine: 'claude',
          gridModel: 'qwen',
          terminalAvailable: true,
        ),
      ];
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(journey.completed(OnboardingStep.models), isFalse);
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'work',
      });
      await tester.pumpAndSettle();
      expect(journey.completed(OnboardingStep.models), isTrue);
      expect(journey.completed(OnboardingStep.store), isFalse);
      app.stateOf('m')!.agents = const [
        Agent(
          id: 'work',
          name: 'Work',
          engine: 'claude',
          dsh: 'autonomous/kicad',
          terminalAvailable: true,
        ),
      ];
      for (final extra in [
        {'subagent': true},
        {
          'payload': {'error': 'failed'},
        },
      ]) {
        await app.handleMachineEventForTest('m', {
          'type': 'turn_ended',
          'agentId': 'work',
          ...extra,
        });
        await tester.pumpAndSettle();
        expect(journey.completed(OnboardingStep.store), isFalse);
      }
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'work',
      });
      await tester.pumpAndSettle();
      expect(journey.completed(OnboardingStep.store), isTrue);
      expect(journey.completedCount, 2);
      expect(find.text('2/3'), findsNothing);
      // A real remote turn earns the remaining milestone.
      const remote = Machine(
        machineId: 'r',
        name: 'Remote',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['r'] = MachineState(remote)
        ..agents = const [
          Agent(id: 'remote', name: 'Remote work', engine: 'codex'),
        ];
      final remoteSession = TerminalSession(
        machineId: 'r',
        agentId: 'remote',
        agentName: 'Remote work',
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      );
      app.adoptSessionForTest(remoteSession);
      await app.handleMachineEventForTest('r', {
        'type': 'turn_ended',
        'agentId': 'remote',
      });
      await tester.pumpAndSettle();
      expect(journey.complete, isTrue);
      expect(find.byKey(const ValueKey('onboarding-progress')), findsNothing);
      expect(
        find.byKey(const ValueKey('onboarding-harnesses-complete')),
        findsNothing,
      );
      expect(find.text('Your companion is ready.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('workspace-status-bar')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('companion-tab-button')),
        findsOneWidget,
      );
      await tap(tester, find.text('[ hatch ]'));
      expect(journey.companion, isNotNull);
      expect(find.text('Hatch your companion'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (var completed = 0; completed <= 4; completed++) {
    testWidgets(
      'welcome has the same working actions with $completed saved steps',
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
        expect(find.text('Harness like a boss.'), findsOneWidget);
        expect(find.text('○'), findsNothing);
        expect(find.text('✓'), findsNothing);
        expect(find.byType(NewHarnessForm), findsNothing);
        expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
        for (final hint in ['⌘N', '⌘P', '⌘I', '⌘M', '⌘S']) {
          expect(find.text(hint), findsOneWidget);
        }

        final destinations = [
          'agent.new',
          'harnesses.list',
          'models.list',
          'machines.list',
          'app.store',
        ];
        for (final command in destinations) {
          await tap(tester, find.byKey(ValueKey('welcome-$command')));
          switch (command) {
            case 'agent.new':
              expect(find.byType(NewHarnessForm), findsOneWidget);
            case 'harnesses.list':
              expect(resourceScope(''), findsOneWidget);
            case 'models.list':
              expect(resourceScope(':'), findsOneWidget);
            case 'machines.list':
              expect(resourceScope('@'), findsOneWidget);
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
          LogicalKeyboardKey.keyP,
          LogicalKeyboardKey.keyS,
          LogicalKeyboardKey.keyM,
          LogicalKeyboardKey.keyI,
        ]) {
          await key(tester, shortcut, cmd: true);
          await tester.pumpAndSettle();
          if (shortcut == LogicalKeyboardKey.keyN) {
            expect(find.byType(NewHarnessForm), findsOneWidget);
          } else if (shortcut == LogicalKeyboardKey.keyP) {
            expect(
              find.byKey(const ValueKey('swarm-search-input')),
              findsOneWidget,
            );
          } else if (shortcut == LogicalKeyboardKey.keyS) {
            expect(app.activeSwarm.isStore, isTrue);
          } else if (shortcut == LogicalKeyboardKey.keyM) {
            expect(resourceScope('@'), findsOneWidget);
          } else {
            expect(resourceScope(':'), findsOneWidget);
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
        final models = resourceScope(':');
        final machines = resourceScope('@');
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        expect(models, findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        expect(models, findsNothing);

        if (!native) {
          await openWorkspaceTool(tester, 'harnesses');
          expect(resourceScope(''), findsOneWidget);
          await key(tester, LogicalKeyboardKey.keyI, cmd: true);
          await tester.pumpAndSettle();
          expect(resourceScope(''), findsNothing);
          expect(models, findsOneWidget);
          await key(tester, LogicalKeyboardKey.escape);
          await tester.pumpAndSettle();
        }

        await tap(tester, find.byKey(const ValueKey('welcome-harnesses.list')));
        expect(resourceScope(''), findsOneWidget);
        await key(tester, LogicalKeyboardKey.keyM, cmd: true);
        await tester.pumpAndSettle();
        expect(resourceScope(''), findsNothing);
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
        await tap(tester, find.byKey(const ValueKey('welcome-app.store')));
        expect(app.activeSwarm.isStore, isTrue);
        await key(tester, LogicalKeyboardKey.keyT, cmd: true);
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

  testWidgets('Models shortcut follows a live remap', (tester) async {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    await mount(tester, keymap: map);
    expect(find.byTooltip('Models'), findsOneWidget);
    expect(find.byTooltip('Models ⌘I'), findsNothing);
    map.apply('''{"bindings":[
      {"keys":"cmd+i","command":null},
      {"keys":"cmd+u","command":"models.list"}
    ]}''');
    await tester.pumpAndSettle();
    expect(find.byTooltip('Models ⌘U'), findsNothing);
    await key(tester, LogicalKeyboardKey.keyI, cmd: true);
    expect(resourceScope(':'), findsNothing);
    await key(tester, LogicalKeyboardKey.keyU, cmd: true);
    await tester.pumpAndSettle();
    expect(resourceScope(':'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> Open Models',
    );
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('command:models.list')),
        matching: find.text('Open Models'),
      ),
      findsOneWidget,
    );
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(resourceScope(':'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'progress changes keep the same welcome on this and the next tab',
    (tester) async {
      await mount(tester);
      journey.sync(
        scope: journey.scope!,
        observed: OnboardingStep.values.toSet(),
        otherComputer: true,
        modelsAvailable: true,
      );
      await tester.pumpAndSettle();
      expect(find.text('✓'), findsNothing);
      expect(find.text('Harness like a boss.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await tester.pumpAndSettle();
      expect(find.text('Harness like a boss.'), findsOneWidget);
      expect(find.text('✓'), findsNothing);
      await tap(tester, find.byKey(const ValueKey('welcome-harnesses.list')));
      expect(resourceScope(''), findsOneWidget);
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
      expect(resourceScope(':'), findsOneWidget);
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
        findsNothing,
      );
      await openWorkspaceTool(tester, 'harnesses');
      expect(find.text('New Harness'), findsNothing);
      expect(journey.completed(OnboardingStep.harnesses), isFalse);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await openWorkspaceTool(tester, 'harnesses');
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      expect(resourceScope(''), findsNothing);
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final hasPassword in [false, true]) {
    testWidgets(
      'Machines guides access to existing work (password=$hasPassword)',
      (tester) async {
        await localHarness();
        if (hasPassword) app.password = '123456';
        await mount(tester);
        expect(journey.next, OnboardingStep.machines);
        await openWorkspaceTool(tester, 'machines');
        await selectResource(tester, 'machine:m');
        await tap(
          tester,
          find.byKey(
            const ValueKey('resource-action:picker.resource_settings'),
          ),
        );
        expect(resourceScope('@'), findsOneWidget);
        if (!hasPassword) {
          final field = find.byKey(const Key('remote-password-field'));
          expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
          await tester.enterText(field, '123456');
          await tester.enterText(
            find.byKey(const Key('remote-password-confirm-field')),
            '123456',
          );
          await tap(tester, find.byKey(const ValueKey('machine-form:Save')));
        }
        expect(app.password, '123456');
        expect(find.text('Set password'), findsNothing);
        expect(
          find.byKey(const ValueKey('make-available-password')),
          findsNothing,
        );
        expect(journey.completed(OnboardingStep.machines), isFalse);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'second computer connects inline, then its work opens from search',
    (tester) async {
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
      await openWorkspaceTool(tester, 'machines');
      await selectResource(tester, 'machine:source');
      await tap(
        tester,
        find.byKey(const ValueKey('resource-action:picker.resource_connect')),
      );
      final field = find.byKey(const ValueKey('remote-password-connect-field'));
      await tester.enterText(field, 'wrong');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Incorrect password. Try again.'), findsOneWidget);
      await tester.enterText(field, '123456');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.connections, ['source']);
      expect(resourceScope('@'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(resourceScope('@'), findsOneWidget);
      expect(app.panes, isEmpty);
      await tester.enterText(resourceField, 'Existing work');
      await tester.pumpAndSettle();
      expect(find.text('Existing work'), findsWidgets);
      expect(find.text('Work on this computer'), findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.panes.single.agentId, 'existing');
      expect(journey.completed(OnboardingStep.machines), isTrue);
      expect(journey.completed(OnboardingStep.harnesses), isFalse);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

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
      await openWorkspaceTool(tester, 'machines');
      await selectResource(tester, 'machine:source');
      expect(find.text('Offline'), findsOneWidget);
      expect(find.text('Link'), findsNothing);
      await runResourceCommand(tester, 'Refresh machines');
      expect(app.refreshes, 1);
      app.stateOf('source')!.nodeOnline = true;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('resource-action:picker.resource_connect')),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'skipping Machines offers Store; local models remain available without a download',
    (tester) async {
      await localHarness();
      await app.modelManager.refresh();
      await mount(tester);
      await openWorkspaceTool(tester, 'machines');
      journey.dismiss(OnboardingStep.machines);
      await tester.pump();
      expect(journey.next, OnboardingStep.store);
      expect(find.byKey(const ValueKey('onboarding-models-dot')), findsNothing);
      await openWorkspaceTool(tester, 'models');
      expect(resourceScope(':'), findsOneWidget);
      expect(find.byType(OnboardingCard), findsNothing);
      await tester.enterText(resourceField, ':local');
      await tester.pump();
      expect(find.text('Qwen3.8-27B'), findsOneWidget);
      expect(app.actions, isEmpty);
      expect(journey.completed(OnboardingStep.models), isFalse);
      expect(app.panes.single.agentId, 'work');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
