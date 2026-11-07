import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/project_choices.dart';
import 'package:harness/widgets/new_harness_form.dart';

/// The Cmd-N form picks a main project (task #4541, spec 2026-11-07-members-and-leads section 1): a project list in
/// place of the folder, worktree and branch rows and the Member or Lead pill.
class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    machines = [
      const Machine(
        machineId: 'here',
        name: 'This Mac',
        authMode: MachineAuthMode.remote,
      ),
    ];
    machineStates['here'] = MachineState(machines.first)
      ..localOnly = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
        EngineAvailability(engine: 'codex', installed: true),
      ]);
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

Future<({List<SuperTabProjectChoice> projects, String? pick})?> _list({
  String? pick = 'lamp',
}) => SuperTabProjectChoices.read(
  (method, path, {body}) async => {
    'projects': [
      {
        'id': 'lead',
        'name': 'harness',
        'about': 'The Harness app and Swarm',
        'lead': {'agentId': 'river', 'name': 'River'},
        'waiting': 12,
      },
      {
        'id': 'lamp',
        'name': 'lamp',
        'repositoryName': 'autonomous-ai/lamp-os',
        'lead': {'agentId': 'wren', 'name': 'Wren'},
        'waiting': 3,
      },
    ],
    'pick': pick,
  },
  'tab',
);

HarnessLaunchIntegration _newAgent({
  required List<AgentStart> starts,
  ({List<SuperTabProjectChoice> projects, String? pick})? choices,
  String? failed,
  bool list = true,
}) =>
    HarnessLaunchIntegration(
        creationId: 'creation',
        prepare: (machine, task, engine) async => task,
        complete: (machine, harnessId) async {},
        beforeSubmit: (machine, receipt) async {},
        engines: const ['claude', 'codex'],
        agentKind: 'member',
        ownMachinesOnly: true,
        startAgent: list ? (start) async => starts.add(start) : null,
      )
      ..projectChoices = choices
      ..projectsError = failed;

Finder _key(String k) => find.byKey(ValueKey(k));

Future<NewHarnessController> _mount(
  WidgetTester tester,
  HarnessLaunchIntegration integration, {
  Brightness brightness = Brightness.light,
  double width = 1200,
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
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid
          .buildAppTheme(brightness: brightness)
          .copyWith(platform: TargetPlatform.macOS),
      home: Scaffold(
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
  );
  await tester.pumpAndSettle();
  return box;
}

Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(_key('new-harness-field-main-project'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a Main project pill replaces the folder, worktree and branch '
      'rows and the Member or Lead pill', (tester) async {
    final choices = await _list();
    await _mount(tester, _newAgent(starts: [], choices: choices));
    for (final gone in [
      'new-harness-field-project',
      'new-harness-field-worktree',
      'new-harness-field-branch',
      'new-harness-field-agent-kind',
    ]) {
      expect(_key(gone), findsNothing, reason: gone);
    }
    // The pill names the server's pick.
    expect(
      find.descendant(
        of: _key('new-harness-field-main-project'),
        matching: find.text('lamp'),
      ),
      findsOneWidget,
    );
    expect(
      find.text('Anything for it to start with? (optional)'),
      findsOneWidget,
    );
    await _openMenu(tester);
    expect(find.text('Main project'), findsWidgets);
    final harness = _key('new-harness-main-project-lead');
    for (final text in ['harness', 'The Harness app and Swarm', '12 waiting']) {
      expect(
        find.descendant(of: harness, matching: find.text(text)),
        findsOneWidget,
        reason: text,
      );
    }
    // No purpose of its own: its repository's name.
    expect(
      find.descendant(
        of: _key('new-harness-main-project-lamp'),
        matching: find.text('autonomous-ai/lamp-os'),
      ),
      findsOneWidget,
    );
    // New project is last, and says what it means.
    expect(
      tester.getTopLeft(_key('new-harness-main-project-new')).dy,
      greaterThan(tester.getTopLeft(_key('new-harness-main-project-lamp')).dy),
    );
    expect(find.text('You lead it'), findsOneWidget);
  });

  testWidgets('a project with nothing waiting says so in words', (
    tester,
  ) async {
    await _mount(
      tester,
      _newAgent(
        starts: [],
        choices: (projects: (await _list())!.projects, pick: null),
      ),
    );
    await _openMenu(tester);
    expect(find.text('3 waiting'), findsOneWidget);
  });

  testWidgets('the server\'s pick starts picked, and a click picks another', (
    tester,
  ) async {
    final integration = _newAgent(starts: [], choices: await _list());
    await _mount(tester, integration);
    expect(integration.mainProjectId, 'lamp');
    await _openMenu(tester);
    bool picked(String id) => tester
        .widget<AppMenuItem>(_key('new-harness-main-project-$id'))
        .highlighted;
    expect(picked('lamp'), isTrue);
    expect(picked('lead'), isFalse);
    await tester.tap(_key('new-harness-main-project-lead'));
    await tester.pumpAndSettle();
    expect(integration.mainProjectId, 'lead');
    expect(
      find.descendant(
        of: _key('new-harness-field-main-project'),
        matching: find.text('harness'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('with no pick the first project is picked; with no project only '
      'New project shows, picked', (tester) async {
    final integration = _newAgent(starts: [], choices: await _list(pick: null));
    await _mount(tester, integration);
    expect(integration.mainProjectId, 'lead');
    await tester.pumpWidget(const SizedBox());
    final none = _newAgent(starts: [], choices: (projects: [], pick: null));
    await _mount(tester, none);
    expect(none.mainProjectId, kNewProjectChoice);
    expect(_key('new-harness-new-project-name'), findsOneWidget);
    await _openMenu(tester);
    expect(_key('new-harness-main-project-new'), findsOneWidget);
  });

  testWidgets('Start sends the pick once: a Member of the picked project, or '
      'the Lead of a new one by its name', (tester) async {
    final starts = <AgentStart>[];
    final box = await _mount(
      tester,
      _newAgent(starts: starts, choices: await _list()),
    );
    await box.create();
    expect(starts.single.machineId, 'here');
    expect(starts.single.engine, 'claude');
    expect(starts.single.mainProjectId, 'lamp');
    expect(starts.single.projectName, isNull);
    await tester.pumpWidget(const SizedBox());

    final again = <AgentStart>[];
    final lead = await _mount(
      tester,
      _newAgent(starts: again, choices: await _list()),
    );
    await _openMenu(tester);
    await tester.tap(_key('new-harness-main-project-new'));
    await tester.pumpAndSettle();
    await tester.enterText(_key('new-harness-new-project-name'), 'radio');
    await lead.create();
    expect(again.single.mainProjectId, isNull);
    expect(again.single.projectName, 'radio');
  });

  testWidgets('New project with no name says so and starts nothing', (
    tester,
  ) async {
    final starts = <AgentStart>[];
    final box = await _mount(
      tester,
      _newAgent(starts: starts, choices: (projects: [], pick: null)),
    );
    await box.create();
    expect(starts, isEmpty);
    expect(box.error, 'Name the project.');
  });

  testWidgets('a list that failed says so with Retry, and New project still '
      'works', (tester) async {
    var retried = 0;
    final integration = _newAgent(
      starts: [],
      failed: 'Couldn\'t load the projects.',
    )..retryProjects = () async => retried++;
    await _mount(tester, integration);
    expect(find.text('Couldn\'t load the projects.'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Retry'));
    expect(retried, 1);
    expect(_key('new-harness-new-project-name'), findsOneWidget);
  });

  testWidgets('against a backend with no list the form is today\'s, pill '
      'included', (tester) async {
    await _mount(tester, _newAgent(starts: [], list: false));
    expect(_key('new-harness-field-main-project'), findsNothing);
    expect(_key('new-harness-field-agent-kind'), findsOneWidget);
    expect(_key('new-harness-field-project'), findsOneWidget);
  });

  testWidgets('light and dark, at 1440 and 880, with nothing cut that '
      'matters', (tester) async {
    for (final brightness in Brightness.values) {
      for (final width in [1440.0, 880.0]) {
        await _mount(
          tester,
          _newAgent(starts: [], choices: await _list()),
          brightness: brightness,
          width: width,
        );
        await _openMenu(tester);
        expect(tester.takeException(), isNull);
        final count = tester.renderObject<RenderParagraph>(
          find.descendant(
            of: _key('new-harness-main-project-lead'),
            matching: find.text('12 waiting'),
          ),
        );
        expect(count.didExceedMaxLines, isFalse);
        await tester.pumpWidget(const SizedBox());
      }
    }
  });
}
