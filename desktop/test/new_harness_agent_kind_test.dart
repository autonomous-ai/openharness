import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;

/// Four machines of the person's view: this computer, another of their own,
/// one another account shares with them, and a Harness Team account.
class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    MachineState add(Machine machine, {bool local = false}) =>
        machineStates[machine.machineId] = MachineState(machine)
          ..localOnly = local
          ..connectionStatus = ConnectionStatus.connected
          ..agentLoadStatus = AgentLoadStatus.loaded
          ..engines.replace(const [
            EngineAvailability(engine: 'claude', installed: true),
            EngineAvailability(engine: 'codex', installed: true),
          ]);
    machines = [
      const Machine(
        machineId: 'here',
        name: 'This Mac',
        authMode: MachineAuthMode.remote,
      ),
      const Machine(
        machineId: 'studio',
        name: 'Studio',
        authMode: MachineAuthMode.remote,
      ),
      const Machine(
        machineId: 'guest',
        name: 'Ken’s Mac',
        authMode: MachineAuthMode.remote,
        machineShare: MachineShare(
          ownerName: 'Ken',
          ownerEmail: 'ken@example.com',
          via: 'email',
          added: true,
        ),
      ),
      const Machine(
        machineId: 'team',
        name: 'Studio · Team',
        authMode: MachineAuthMode.remote,
        sessionKind: 'team',
      ),
    ];
    add(machines[0], local: true);
    for (final machine in machines.skip(1)) {
      add(machine);
    }
  }

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(
    String machineId, {
    bool force = false,
    bool userAction = false,
  }) async {}

  @override
  Future<GridModels> refreshGridModels(
    String machineId, {
    bool userAction = false,
  }) async => const GridModels.unreachable();

  @override
  Future<Map<String, dynamic>> readGitProject(
    String machineId,
    String path, {
    bool refresh = false,
  }) async => {'isGit': false};

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': []};
}

HarnessLaunchIntegration _newAgent() => HarnessLaunchIntegration(
  creationId: 'creation',
  prepare: (machine, task, engine) async => task,
  complete: (machine, harnessId) async {},
  beforeSubmit: (machine, receipt) async {},
  engines: const ['claude', 'codex'],
  agentKind: 'member',
  ownMachinesOnly: true,
);

final _kind = find.byKey(const ValueKey('new-harness-field-agent-kind'));
final _machine = find.byKey(const ValueKey('new-harness-field-machine'));
Finder _machineOption(String id) =>
    find.byKey(ValueKey('new-harness-machine-option-$id'));

Future<({NewHarnessController box, GlobalKey image})> _mount(
  WidgetTester tester, {
  HarnessLaunchIntegration? integration,
  Brightness brightness = Brightness.dark,
}) async {
  final app = _App();
  final box = NewHarnessController(
    app,
    machineId: 'here',
    engine: 'claude',
    folder: '/work/site',
    integration: integration,
  );
  addTearDown(() {
    box.dispose();
    app.dispose();
  });
  tester.view.physicalSize = const Size(1200, 700);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final image = GlobalKey();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid
          .buildAppTheme(brightness: brightness)
          .copyWith(platform: TargetPlatform.macOS),
      home: RepaintBoundary(
        key: image,
        child: Scaffold(
          backgroundColor: grid.AppPalette.windowBg,
          body: Padding(
            padding: const EdgeInsets.all(24),
            child: NewHarnessForm(
              controller: box,
              desktop: true,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (box: box, image: image);
}

void main() {
  final renderDir = Platform.environment['COMPOSER_LAYOUT_RENDER_DIR'];
  setUpAll(() async {
    if (renderDir != null) await loadPreviewFonts();
  });

  Future<void> capture(WidgetTester tester, GlobalKey key, String name) async {
    if (renderDir == null) return;
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final directory = Directory(renderDir)..createSync(recursive: true);
      await File('${directory.path}/$name.png')
          .writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  // Task #4196 (anh Dee, 11-07): + New agent is Cmd-N with one more choice.
  for (final brightness in Brightness.values) {
    testWidgets('New agent: Agent or Product Manager, ${brightness.name}', (
      tester,
    ) async {
      final integration = _newAgent();
      final mounted = await _mount(
        tester,
        integration: integration,
        brightness: brightness,
      );
      final project = tester.getRect(
        find.byKey(const ValueKey('new-harness-field-project')),
      );
      expect(_kind, findsOneWidget);
      expect(
        find.descendant(of: _kind, matching: find.text('Agent')),
        findsOneWidget,
      );
      final kind = tester.getRect(_kind);
      expect(
        kind.top >= project.bottom ||
            (kind.center.dy - project.center.dy).abs() <= 1 &&
                kind.left > project.right,
        isTrue,
        reason: 'The choice comes after the project, in reading order',
      );
      await capture(
        tester,
        mounted.image,
        'new-agent-member-${brightness.name}',
      );

      await tester.tap(_kind);
      await tester.pumpAndSettle();
      expect(find.text('Leads a project and its crew'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('new-harness-agent-kind-lead')),
      );
      await tester.pumpAndSettle();
      expect(integration.agentKind, 'lead');
      expect(
        find.descendant(of: _kind, matching: find.text('Product Manager')),
        findsOneWidget,
      );
      await capture(tester, mounted.image, 'new-agent-lead-${brightness.name}');
    });
  }

  testWidgets('New agent offers only the person’s own computers', (
    tester,
  ) async {
    final mounted = await _mount(tester, integration: _newAgent());
    expect(mounted.box.machineChoices.map((m) => m.id), ['here', 'studio']);
    await tester.tap(_machine);
    await tester.pumpAndSettle();
    expect(_machineOption('here'), findsOneWidget);
    expect(_machineOption('studio'), findsOneWidget);
    expect(_machineOption('guest'), findsNothing);
    expect(_machineOption('team'), findsNothing);
  });

  testWidgets('the choice is locked once its request is sent', (tester) async {
    final integration = _newAgent()..agentKindLocked = true;
    await _mount(tester, integration: integration);
    await tester.tap(_kind);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('new-harness-agent-kind-lead')),
      findsNothing,
    );
    expect(integration.agentKind, 'member');
  });

  testWidgets('plain Cmd-N has no choice and keeps every computer', (
    tester,
  ) async {
    final mounted = await _mount(tester);
    expect(_kind, findsNothing);
    expect(
      mounted.box.machineChoices.map((m) => m.id),
      containsAll(['here', 'studio', 'guest', 'team']),
    );
  });
}
