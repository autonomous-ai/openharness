import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/onboarding_card.dart';

import 'keymap_host_test.dart' show key;
import 'support/model_manager.dart';
import 'swarm_screen_test.dart' show terminal;

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
  Future<void> mount(WidgetTester tester) async {
    journey = WorkspaceOnboarding();
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: false,
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
