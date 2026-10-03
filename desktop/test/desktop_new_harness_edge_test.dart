import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/first_task.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;

const _toolId = 'autonomous/review-tool';

DshEntry _tool({bool installed = false, String id = _toolId}) => DshEntry(
  id: id,
  name: id == _toolId ? 'Review Tool' : 'Tool ${id.split('/').last}',
  engine: 'codex',
  engines: const ['codex', 'claude'],
  description: 'A development environment',
  installed: installed,
);

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    final state = MachineState(
      const Machine(
        machineId: 'machine',
        name: 'Studio Mac',
        authMode: MachineAuthMode.remote,
      ),
    )..localOnly = true;
    state.engines.replace(const [
      EngineAvailability(
        engine: 'codex',
        installed: true,
        supportsCodexHome: true,
      ),
      EngineAvailability(engine: 'claude', installed: true),
    ]);
    state.dsh.replace([_tool()]);
    machineStates['machine'] = state;
  }

  final installs = <String>[];
  final launches = <Map<String, Object?>>[];
  Completer<String?>? pendingInstall;

  @override
  Future<Map<String, dynamic>> readGitProject(
    String machineId,
    String path, {
    bool refresh = false,
  }) async => {'isGit': false};

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {
    'profiles': [
      {'path': '/profiles/work', 'label': 'Work'},
    ],
  };

  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) async => {'path': path ?? '/Users/dev', 'entries': []};

  @override
  Future<String?> installDsh(
    String machineId,
    String id, {
    bool trustUnverified = false,
  }) async {
    installs.add(id);
    final state = machineStates[machineId]!;
    state.dsh.runs.remove(id);
    narrate('clone');
    final error = await (pendingInstall?.future ?? Future.value(null));
    if (error == null) {
      if (state.dsh.runs[id]?.done != true) narrate('done');
      state.dsh.replace([_tool(installed: true)]);
    } else {
      state.dsh.failInstall(id, error);
    }
    notifyListeners();
    return error;
  }

  void narrate(String phase, {String? line, String? code, DateTime? at}) {
    machineStates['machine']!.dsh.applyInstall(
      DshInstallProgress(id: _toolId, phase: phase, line: line, code: code),
      now: at,
    );
    notifyListeners();
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    GridModel? model,
    String? prompt,
    String? name,
    String? agent,
    ProjectFolderRequest? projectFolder,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
    HarnessPlacement? placement,
  }) async {
    launches.add({
      'engine': engine,
      'dsh': dsh,
      'prompt': prompt,
      'projectFolder': projectFolder,
    });
    return 'Synthetic launch boundary';
  }
}

class _Fixture {
  _Fixture(this.app, this.box, this.map);
  final _App app;
  final NewHarnessController box;
  final MemoryKeymap map;
  int closes = 0;
}

Future<_Fixture> _mount(
  WidgetTester tester, {
  String? harness,
  String engine = 'codex',
  bool withKeymap = true,
  bool pendingInstall = false,
  Size size = const Size(1000, 800),
  double scale = 1,
  List<DshEntry>? catalog,
  NewHarnessDraft? draft,
}) async {
  final app = _App();
  if (catalog != null) app.machineStates['machine']!.dsh.replace(catalog);
  if (pendingInstall) app.pendingInstall = Completer<String?>();
  final box = NewHarnessController(
    app,
    machineId: 'machine',
    engine: engine,
    harnessId: harness,
    folder: '/work/repo',
    draft: draft,
    offersStore: true,
  );
  final map = MemoryKeymap();
  final fixture = _Fixture(app, box, map);
  addTearDown(app.dispose);
  addTearDown(box.dispose);
  addTearDown(map.dispose);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final form = NewHarnessForm(
    controller: box,
    desktop: true,
    onClose: () => fixture.closes++,
    onCreated: () => fail('Synthetic fixture must not start a real session'),
  );
  await tester.pumpWidget(
    MaterialApp(
      theme: grid
          .buildAppTheme(brightness: Brightness.dark)
          .copyWith(platform: TargetPlatform.macOS),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: Scaffold(
        body: withKeymap
            ? KeymapProvider(
                keymap: map,
                child: KeymapHost(
                  keymap: map,
                  enabled: () => true,
                  actions: const {},
                  child: form,
                ),
              )
            : form,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return fixture;
}

final _task = find.byKey(const ValueKey('new-harness-task'));
final _query = find.byKey(const ValueKey('new-harness-query'));
final _start = find.byKey(const ValueKey('new-harness-field-start'));
final _install = find.byKey(const ValueKey('new-harness-install'));

void main() {
  testWidgets(
    'desktop setup narrates every stage before a single launch attempt',
    (tester) async {
      final fixture = await _mount(
        tester,
        harness: _toolId,
        pendingInstall: true,
      );
      await tester.enterText(_task, 'Build the dashboard');
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await tester.pump();
      expect(fixture.app.installs, [_toolId]);
      expect(_install, findsOneWidget);
      expect(find.text('Setting up Review Tool'), findsOneWidget);
      expect(find.text('Download harness'), findsOneWidget);
      expect(find.text('Set up tools'), findsOneWidget);
      expect(find.text('Check requirements'), findsOneWidget);
      expect(tester.widget<FilledButton>(_start).onPressed, isNull);
      final began = fixture.box.installRun!.phases.first.at;
      fixture.app.narrate(
        'setup',
        line: 'Preparing the development environment',
        at: began.add(const Duration(seconds: 75)),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('1:15'), findsOneWidget);
      expect(
        find.text('Preparing the development environment'),
        findsOneWidget,
      );
      fixture.app.narrate(
        'doctor',
        line: 'Checking the tools',
        at: began.add(const Duration(seconds: 95)),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Checking the tools'), findsOneWidget);
      fixture.app.narrate('done', at: began.add(const Duration(seconds: 100)));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Review Tool is ready'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(fixture.app.installs, hasLength(1));
      fixture.app.pendingInstall!.complete(null);
      await tester.pumpAndSettle();
      expect(fixture.app.launches, hasLength(1));
      expect(fixture.app.launches.single['prompt'], 'Build the dashboard');
      expect(_install, findsNothing);
      expect(fixture.box.task, 'Build the dashboard');
      expect(tester.takeException(), isNull);
    },
  );

  for (final (code, detail, expected) in [
    ('DSH_BUSY', 'Another install owns the lock', 'Wait for it to finish.'),
    (
      'DOCTOR_FAILED',
      'miss uv',
      'curl -LsSf https://astral.sh/uv/install.sh | sh',
    ),
  ]) {
    testWidgets('desktop $code remains readable and retry preserves the task', (
      tester,
    ) async {
      final fixture = await _mount(
        tester,
        harness: _toolId,
        pendingInstall: true,
        size: const Size(500, 620),
        scale: 1.3,
      );
      await tester.enterText(_task, 'Keep this task while setting up');
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await tester.pump();
      fixture.app.narrate('setup');
      fixture.app.narrate('failed', code: code);
      fixture.app.pendingInstall!.complete(detail);
      await tester.pumpAndSettle();
      expect(fixture.app.launches, isEmpty);
      expect(find.text('Review Tool could not be installed'), findsOneWidget);
      expect(find.text(expected), findsOneWidget);
      expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
      fixture.app.pendingInstall = Completer<String?>();
      await tester.ensureVisible(_start);
      await tester.tap(_start);
      await tester.pump();
      expect(fixture.app.installs, hasLength(2));
      fixture.app.pendingInstall!.complete(null);
      await tester.pumpAndSettle();
      expect(
        fixture.app.launches.single['prompt'],
        'Keep this task while setting up',
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'oversized task explains the limit and becomes launchable after editing',
    (tester) async {
      final fixture = await _mount(tester);
      await tester.enterText(_task, 'x' * (kFirstTaskMaxLength + 1));
      await tester.pumpAndSettle();
      expect(fixture.box.taskTooLong, isTrue);
      expect(find.text('Your message is too long.'), findsOneWidget);
      expect(fixture.box.error, contains('${kFirstTaskMaxLength + 1}'));
      expect(tester.widget<FilledButton>(_start).onPressed, isNull);
      await tester.enterText(_task, 'A short task');
      await tester.pumpAndSettle();
      expect(fixture.box.error, isNull);
      expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
      expect(fixture.app.launches, isEmpty);
    },
  );

  testWidgets(
    'standalone desktop composer submits on Return and closes with Escape',
    (tester) async {
      final fixture = await _mount(tester, withKeymap: false);
      await tester.enterText(_task, 'A fallback keyboard task');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(fixture.app.launches, hasLength(1));
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await tester.pumpAndSettle();
      expect(fixture.app.launches, hasLength(2));
      await key(tester, LogicalKeyboardKey.escape);
      expect(fixture.closes, 1);
    },
  );

  for (final withKeymap in [false, true]) {
    testWidgets(
      'Repo machine keyboard traversal works with keymap=$withKeymap',
      (tester) async {
        final fixture = await _mount(tester, withKeymap: withKeymap);
        await tester.tap(
          find.byKey(const ValueKey('new-harness-field-project')),
        );
        await tester.pumpAndSettle();
        final machine = find.byKey(const ValueKey('new-harness-repo-machine'));
        bool queryFocused() =>
            tester.widget<TextField>(_query).focusNode!.hasFocus;
        expect(queryFocused(), isTrue);
        await key(tester, LogicalKeyboardKey.tab);
        expect(queryFocused(), isFalse);
        await key(tester, LogicalKeyboardKey.tab, shift: true);
        expect(queryFocused(), isTrue);
        await key(tester, LogicalKeyboardKey.tab);
        expect(tester.widget<DesktopPill>(machine).focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.arrowRight);
        await tester.pumpAndSettle();
        final choice = find.byKey(
          const ValueKey('new-harness-machine-option-machine'),
        );
        expect(choice, findsOneWidget);
        tester
            .state<NewHarnessFormState>(find.byType(NewHarnessForm))
            .dismissFromOutside();
        await tester.pumpAndSettle();
        expect(choice, findsNothing);
        expect(_query, findsOneWidget);
        // Repeated activation toggles the cascade without closing Repo.
        await tester.tap(machine);
        await tester.pumpAndSettle();
        expect(choice, findsOneWidget);
        tester.widget<DesktopPill>(machine).onPressed!();
        await tester.pumpAndSettle();
        expect(choice, findsNothing);
        await key(tester, LogicalKeyboardKey.tab);
        await tester.pumpAndSettle();
        expect(_query, findsNothing);
        expect(fixture.closes, 0);
        expect(fixture.app.launches, isEmpty);
      },
    );
  }

  testWidgets('Repo refuses a machine that vanished before a menu click', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    fixture.app.machineStates['other'] = MachineState(
      const Machine(
        machineId: 'other',
        name: 'Other Mac',
        authMode: MachineAuthMode.remote,
      ),
    )..nodeOnline = true;
    fixture.app.notifyListeners();
    await tester.tap(find.byKey(const ValueKey('new-harness-field-project')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('new-harness-repo-machine')));
    await tester.pumpAndSettle();
    final choice = find.byKey(
      const ValueKey('new-harness-machine-option-other'),
    );
    expect(choice, findsOneWidget);
    fixture.app.machineStates.remove('other');
    await tester.tap(choice);
    await tester.pumpAndSettle();
    expect(fixture.box.machineId, 'machine');
    expect(fixture.box.error, 'This machine is no longer available.');
    expect(fixture.app.launches, isEmpty);
  });

  testWidgets('Escape closes the chooser before the composer close button', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    await tester.tap(find.byKey(const ValueKey('new-harness-field-project')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('new-harness-repo-machine')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('new-harness-machine-option-machine')),
      findsOneWidget,
    );
    expect(fixture.box.field, NewHarnessField.projectMenu);
    fixture.box.warn('Choose an installed agent to continue.');
    await tester.pumpAndSettle();
    expect(find.text('Choose an installed agent to continue.'), findsWidgets);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(fixture.box.field, NewHarnessField.projectMenu);
    expect(_query, findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(_query, findsNothing);
    expect(fixture.closes, 0);
    await tester.tap(find.byKey(const ValueKey('new-harness-close')));
    expect(fixture.closes, 1);
  });

  testWidgets('Change machine backs to the same nested folder prompt', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    fixture.app.machineStates['other'] = MachineState(
      const Machine(
        machineId: 'other',
        name: 'Other Mac',
        authMode: MachineAuthMode.remote,
      ),
    )..localOnly = true;
    fixture.app.notifyListeners();
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('new-harness-field-project')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(
        const ValueKey(
          'new-harness-option-${NewHarnessController.existingProjectId}',
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(_query, '~developer');
    await tester.pumpAndSettle();
    final changeMachine = find.byKey(
      const ValueKey(
        'new-harness-option-${NewHarnessController.changeMachineId}',
      ),
    );
    final chooserBounds = tester.getRect(
      find.byKey(const ValueKey('new-harness-chooser-surface')),
    );
    final rowBounds = tester.getRect(changeMachine);
    expect(
      rowBounds.bottom,
      lessThanOrEqualTo(chooserBounds.bottom),
      reason: 'Both folder actions must fit: $rowBounds in $chooserBounds.',
    );
    await tester.tap(changeMachine);
    await tester.pumpAndSettle();
    expect(fixture.box.field, NewHarnessField.machine);
    await tester.tap(find.byKey(const ValueKey('new-harness-chooser-back')));
    await tester.pumpAndSettle();
    expect(fixture.box.field, NewHarnessField.project);
    expect(fixture.closes, 0);
    expect(fixture.app.launches, isEmpty);
  });

  testWidgets(
    'clicking the composer outside its chooser preserves the draft and dialog',
    (tester) async {
      final fixture = await _mount(tester);
      await tester.enterText(_task, 'Keep my review notes');
      await tester.tap(find.byKey(const ValueKey('new-harness-field-project')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-harness-repo-machine')));
      await tester.pumpAndSettle();
      final surface = tester.getRect(
        find.byKey(const ValueKey('new-harness-surface')),
      );
      final chooser = tester.getRect(
        find.byKey(const ValueKey('new-harness-chooser-surface')),
      );
      final outside = surface.topLeft + const Offset(12, 12);
      expect(chooser.contains(outside), isFalse);
      await tester.tapAt(outside);
      await tester.pumpAndSettle();
      expect(_query, findsOneWidget);
      await tester.tapAt(outside);
      await tester.pumpAndSettle();
      expect(_query, findsNothing);
      expect(fixture.closes, 0);
      expect(fixture.box.task, 'Keep my review notes');
      expect(fixture.box.machineId, 'machine');
      expect(fixture.app.launches, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'large desktop catalogs page through native rows without launching',
    (tester) async {
      final fixture = await _mount(
        tester,
        catalog: [for (var i = 0; i < 80; i++) _tool(id: 'autonomous/tool-$i')],
      );
      await tester.tap(find.byKey(const ValueKey('new-harness-field-agent')));
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(fixture.box.cursor, greaterThan(0));
      await key(tester, LogicalKeyboardKey.pageUp);
      expect(fixture.app.launches, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'clone drafts carry the exact repository preparation into launch options',
    (tester) async {
      final repository = GitHubRepository.parse('openai/codex')!;
      final fixture = await _mount(
        tester,
        draft: NewHarnessDraft(
          machineId: 'machine',
          engine: 'codex',
          project: NewHarnessProject.clone(repository),
          task: 'Review this repository',
          permissionMode: 'full',
        ),
      );
      expect(fixture.box.projectFolderRequest!.repository!.url, repository.url);
      expect(fixture.box.task, 'Review this repository');
      expect(fixture.app.launches, isEmpty);
    },
  );

  testWidgets(
    'terminal selection keeps a task draft and explains its later return',
    (tester) async {
      final fixture = await _mount(tester);
      await tester.enterText(_task, 'Keep this for an agent');
      await tester.tap(find.byKey(const ValueKey('new-harness-field-agent')));
      await tester.pumpAndSettle();
      await tester.enterText(_query, 'terminal');
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('new-harness-option-terminal')),
      );
      await tester.pumpAndSettle();
      expect(fixture.box.engine, 'terminal');
      expect(
        find.text('Your task is kept when you switch agents.'),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(_task).readOnly, isTrue);
      expect(_query, findsNothing);
      await tester.tap(find.byKey(const ValueKey('new-harness-field-agent')));
      await tester.pumpAndSettle();
      await tester.enterText(_query, 'codex');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-harness-option-codex')));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(_task).controller!.text,
        'Keep this for an agent',
      );
      expect(tester.widget<TextField>(_task).readOnly, isFalse);
      expect(fixture.app.launches, isEmpty);
    },
  );

  testWidgets('direct profile chooser stays visible at enlarged text', (
    tester,
  ) async {
    final fixture = await _mount(
      tester,
      size: const Size(760, 700),
      scale: 1.5,
    );
    final profile = find.byKey(const ValueKey('new-harness-field-profile'));
    await tester.ensureVisible(profile);
    await tester.tap(profile);
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<Semantics>(find.byKey(const ValueKey('new-harness-choices')))
          .properties
          .label,
      'Codex profile',
    );
    expect(find.text('Codex profile'), findsNothing);
    expect(
      find.byKey(const ValueKey('new-harness-chooser-surface')).hitTestable(),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await key(tester, LogicalKeyboardKey.escape);
    expect(fixture.closes, 0);
  });
}
