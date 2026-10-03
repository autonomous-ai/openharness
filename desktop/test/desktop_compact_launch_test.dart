import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'keymap_host_test.dart' show MemoryKeymap, key;

class _CompactApp extends AppNotifier {
  _CompactApp({String machineName = 'Studio Mac'})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    final machine = Machine(
      machineId: 'm',
      name: machineName,
      authMode: MachineAuthMode.remote,
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..localOnly = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..engines.replace(const [
        EngineAvailability(
          engine: 'codex',
          installed: true,
          supportsCodexHome: true,
        ),
        EngineAvailability(engine: 'claude', installed: true),
      ]);
  }

  final launches = <Map<String, Object?>>[];
  bool missingMain = false;
  Completer<String?>? pendingLaunch;
  String? launchError = 'Fixture launch declined. Try again.';

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}
  @override
  Future<Map<String, dynamic>> readGitProject(
    String machineId,
    String path, {
    bool refresh = false,
  }) async => {
    'isGit': true,
    'branch': missingMain ? 'feature' : 'main',
    'branches': [
      if (!missingMain) {'ref': 'refs/heads/main', 'name': 'main'},
      {'ref': 'refs/heads/feature', 'name': 'feature'},
    ],
  };
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
  ) async => {'path': path ?? '/work', 'entries': []};

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
      'machine': machineId,
      'engine': engine,
      'folder': folder,
      'prompt': prompt,
      'permissions': permissionMode,
      'projectFolder': projectFolder,
    });
    return pendingLaunch?.future ?? Future.value(launchError);
  }
}

class _CompactFixture {
  _CompactFixture(this.app, this.box, this.map);
  final _CompactApp app;
  final NewHarnessController box;
  final MemoryKeymap map;
  final form = GlobalKey<NewHarnessFormState>();
  final image = GlobalKey();
  int closed = 0;
  int created = 0;

  void dispose() {
    box.dispose();
    map.dispose();
    app.dispose();
  }
}

final _surface = find.byKey(const ValueKey('new-harness-surface'));
final _task = find.byKey(const ValueKey('new-harness-task'));
final _start = find.byKey(const ValueKey('new-harness-field-start'));
final _agent = find.byKey(const ValueKey('new-harness-field-agent'));
final _machine = find.byKey(const ValueKey('new-harness-machine'));
final _close = find.byKey(const ValueKey('new-harness-close'));
final _chooser = find.byKey(const ValueKey('new-harness-chooser-surface'));

bool _focused(WidgetTester tester, Finder target) {
  final element = tester.element(target);
  var found = FocusManager.instance.primaryFocus?.context == element;
  FocusManager.instance.primaryFocus?.context?.visitAncestorElements((
    ancestor,
  ) {
    if (ancestor == element) found = true;
    return !found;
  });
  return found;
}

Future<void> _focus(WidgetTester tester, Finder target) async {
  for (var i = 0; i < 32 && !_focused(tester, target); i++) {
    await key(tester, LogicalKeyboardKey.tab);
  }
  expect(
    _focused(tester, target),
    isTrue,
    reason: '$target must be reachable with Tab',
  );
}

Future<_CompactFixture> _mount(
  WidgetTester tester, {
  String engine = 'codex',
  NewHarnessDraft? draft,
  Size size = const Size(1100, 800),
  double scale = 1,
  Brightness brightness = Brightness.dark,
  String machineName = 'Studio Mac',
  bool pending = false,
  bool missingMain = false,
  String? harnessId,
}) async {
  final app = _CompactApp(machineName: machineName);
  app.missingMain = missingMain;
  if (harnessId != null) {
    app.machineStates['m']!.dsh.replace([
      DshEntry(
        id: harnessId,
        name: 'Review Tool',
        engine: 'codex',
        description: 'Synthetic installed agent',
        installed: true,
      ),
    ]);
  }
  if (pending) app.pendingLaunch = Completer<String?>();
  final box = NewHarnessController(
    app,
    machineId: 'm',
    engine: engine,
    harnessId: harnessId,
    folder: '/work/repo',
    draft: draft,
  );
  final fixture = _CompactFixture(app, box, MemoryKeymap());
  addTearDown(fixture.dispose);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: KeymapProvider(
        keymap: fixture.map,
        child: KeymapHost(
          keymap: fixture.map,
          enabled: () => true,
          actions: const {},
          child: RepaintBoundary(
            key: fixture.image,
            child: Scaffold(
              backgroundColor: grid.AppPalette.windowBg,
              body: Stack(
                children: [
                  Positioned.fill(
                    child: GestureDetector(
                      key: const ValueKey('compact-workspace-backdrop'),
                      behavior: HitTestBehavior.opaque,
                      onTap: () =>
                          fixture.form.currentState?.dismissFromOutside(),
                      child: const SizedBox.expand(),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.all(24),
                    child: NewHarnessForm(
                      key: fixture.form,
                      controller: box,
                      desktop: true,
                      onClose: () => fixture.closed++,
                      onCreated: () => fixture.created++,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return fixture;
}

const _nativeCompactJourneys = {
  'empty composer is agent-first, wide, and ready for Return',
  'Tab visits each visible control once and wraps to New harness',
  'visible editor accepts focus without replacing its configuration (mouse=false)',
  'codex settings are direct and chooser cancellation preserves the configuration',
  'quick settings survive message editing and chooser acceptance',
  'an initially missing branch keeps Return and Escape inside the composer',
  'an agent becoming unavailable while Start is focused preserves Escape',
};

void main({bool nativeSmoke = false}) {
  void journey(String description, Future<void> Function(WidgetTester) body) {
    if (nativeSmoke && !_nativeCompactJourneys.contains(description)) return;
    testWidgets(
      description,
      body,
      timeout: nativeSmoke ? const Timeout(Duration(seconds: 45)) : null,
    );
  }

  final renderDir = Platform.environment['COMPACT_LAUNCH_RENDER_DIR'];
  setUpAll(() async {
    if (renderDir != null) await loadPreviewFonts();
  });

  Future<void> capture(
    WidgetTester tester,
    _CompactFixture fixture,
    String name,
  ) async {
    if (renderDir == null) return;
    await tester.runAsync(() async {
      final boundary =
          fixture.image.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final folder = Directory(renderDir)..createSync(recursive: true);
      await File('${folder.path}/$name.png')
          .writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  journey('empty composer is agent-first, wide, and ready for Return', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    expect(tester.getSize(_surface).width, 680);
    expect(_task, findsOneWidget);
    expect(
      tester.widget<TextField>(_task).decoration?.hintText,
      'What would you like to work on?',
    );
    expect(find.byKey(const ValueKey('new-harness-settings')), findsNothing);
    expect(find.byKey(const ValueKey('new-harness-task-toggle')), findsNothing);
    expect(
      find.byKey(const ValueKey('new-harness-field-advanced')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-approvals')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-worktree')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-model')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-profile')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-branch')),
      findsOneWidget,
    );
    expect(_machine, findsNothing);
    expect(
      tester.getTopRight(_agent).dx,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('new-harness-field-project')))
            .dx,
      ),
    );
    expect(_focused(tester, _task), isTrue);
    await capture(tester, fixture, 'composer-dark');
    expect(tester.widget<TextField>(_task).controller!.text, isEmpty);
    expect(fixture.box.task, isEmpty);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(fixture.app.launches, hasLength(1));
    expect(fixture.app.launches.single['prompt'], isNull);
    expect(fixture.app.launches.single['machine'], 'm');
    expect(fixture.app.launches.single['engine'], 'codex');
    expect(fixture.closed, 0);
  });

  journey('Tab visits each visible control once and wraps to New harness', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    for (final target in [
      find.byKey(const ValueKey('new-harness-field-model')),
      find.byKey(const ValueKey('new-harness-field-approvals')),
      find.byKey(const ValueKey('new-harness-field-profile')),
      find.byKey(const ValueKey('new-harness-field-worktree')),
      find.byKey(const ValueKey('new-harness-field-branch')),
      _close,
      _start,
      _agent,
      find.byKey(const ValueKey('new-harness-field-project')),
      _task,
    ]) {
      await key(tester, LogicalKeyboardKey.tab);
      expect(
        _focused(tester, target),
        isTrue,
        reason:
            'Expected $target, focused ${FocusManager.instance.primaryFocus?.debugLabel}',
      );
    }
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    expect(
      _focused(tester, find.byKey(const ValueKey('new-harness-field-project'))),
      isTrue,
    );
    expect(fixture.app.launches, isEmpty);
  });

  journey(
    'an initially missing branch keeps Return and Escape inside the composer',
    (tester) async {
      final fixture = await _mount(tester, missingMain: true);
      expect(fixture.box.requiredChoice?.field, NewHarnessField.branch);
      expect(tester.widget<FilledButton>(_start).onPressed, isNull);
      expect(_task, findsOneWidget);
      expect(_chooser, findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(_chooser, findsOneWidget);
      expect(fixture.box.field, NewHarnessField.branch);
      expect(fixture.app.launches, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(_chooser, findsNothing);
      expect(fixture.closed, 0);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(fixture.closed, 1);
      expect(fixture.app.launches, isEmpty);
    },
  );

  journey(
    'an agent becoming unavailable while Start is focused preserves Escape',
    (tester) async {
      final fixture = await _mount(tester, harnessId: 'fixture/review-tool');
      await _focus(tester, _start);
      expect(_focused(tester, _start), isTrue);
      expect(fixture.box.requiredChoice, isNull);
      fixture.app.machineStates['m']!.dsh.replace(const []);
      fixture.app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pumpAndSettle();
      expect(fixture.box.requiredChoice?.field, NewHarnessField.harness);
      expect(tester.widget<FilledButton>(_start).onPressed, isNull);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(fixture.closed, 1);
      expect(fixture.app.launches, isEmpty);
    },
  );

  for (final submitKey in [
    LogicalKeyboardKey.enter,
    LogicalKeyboardKey.numpadEnter,
  ]) {
    journey(
      'a promptless agent without main directs ${submitKey.keyLabel} to the branch chooser',
      (tester) async {
        final fixture = await _mount(
          tester,
          engine: 'cursor',
          missingMain: true,
        );
        expect(tester.widget<TextField>(_task).readOnly, isTrue);
        expect(fixture.box.requiredChoice?.field, NewHarnessField.branch);
        expect(tester.widget<FilledButton>(_start).onPressed, isNull);
        await key(tester, submitKey);
        await tester.pumpAndSettle();
        expect(_chooser, findsOneWidget);
        expect(fixture.box.field, NewHarnessField.branch);
        expect(fixture.app.launches, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(_chooser, findsNothing);
        expect(fixture.closed, 0);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(fixture.closed, 1);
      },
    );
  }

  for (final mouse in [true, false]) {
    journey(
      'visible editor accepts focus without replacing its configuration (mouse=$mouse)',
      (tester) async {
        final fixture = await _mount(tester);
        final controller = fixture.box;
        final project = controller.project;
        final originalWorktree = controller.worktree;
        if (mouse) {
          await tester.tap(_task);
        } else {
          await _focus(tester, _task);
        }
        await tester.pumpAndSettle();
        expect(tester.getSize(_surface).width, 680);
        expect(_focused(tester, _task), isTrue);
        expect(
          tester.widget<NewHarnessForm>(find.byType(NewHarnessForm)).controller,
          same(controller),
        );
        expect(controller.project, project);
        expect(controller.worktree, originalWorktree);
        await capture(
          tester,
          fixture,
          'composer-task-${mouse ? 'mouse' : 'keyboard'}',
        );
        await tester.enterText(_task, 'A first question');
        await _focus(tester, _agent);
        await key(tester, LogicalKeyboardKey.enter);
        await key(tester, LogicalKeyboardKey.escape);
        expect(_task, findsOneWidget);
        expect(controller.task, 'A first question');
        expect(tester.getSize(_surface).width, 680);
        expect(_focused(tester, _agent), isTrue);
        expect(fixture.app.launches, isEmpty);
      },
    );
  }

  journey(
    'visible task owns Shift-Enter and Cmd-Return submits the exact task',
    (tester) async {
      final fixture = await _mount(tester);
      await tester.enterText(_task, 'Inspect launch');
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      expect(fixture.app.launches, isEmpty);
      // macOS text insertion follows the platform editing channel after the key.
      // sendKeyEvent alone does not synthesize that operating-system edit.
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Inspect launch\n',
          selection: TextSelection.collapsed(offset: 15),
        ),
      );
      await tester.pump();
      expect(fixture.box.task, 'Inspect launch\n');
      await tester.enterText(_task, 'Inspect launch\nPreserve the settings');
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await tester.pumpAndSettle();
      expect(fixture.app.launches, hasLength(1));
      expect(
        fixture.app.launches.single['prompt'],
        'Inspect launch\nPreserve the settings',
      );
    },
  );

  journey(
    'clearing a task keeps the editor visible and preserves keyboard focus',
    (tester) async {
      final fixture = await _mount(tester);
      await tester.enterText(_task, 'Retain this draft');
      await tester.pumpAndSettle();
      expect(_task, findsOneWidget);
      expect(fixture.box.task, 'Retain this draft');
      expect(_focused(tester, _task), isTrue);
      await tester.enterText(_task, '');
      await tester.pumpAndSettle();
      expect(_task, findsOneWidget);
      expect(_focused(tester, _task), isTrue);
      expect(fixture.box.task, isEmpty);
      expect(fixture.app.launches, isEmpty);
    },
  );

  for (final engine in ['codex', 'claude', 'terminal']) {
    journey(
      '$engine settings are direct and chooser cancellation preserves the configuration',
      (tester) async {
        final fixture = await _mount(tester, engine: engine);
        final engineBefore = fixture.box.engine;
        final projectBefore = fixture.box.project;
        final model = find.byKey(const ValueKey('new-harness-field-model'));
        final approvals = find.byKey(
          const ValueKey('new-harness-field-approvals'),
        );
        final profile = find.byKey(const ValueKey('new-harness-field-profile'));
        expect(model, engine == 'terminal' ? findsNothing : findsOneWidget);
        expect(approvals, engine == 'terminal' ? findsNothing : findsOneWidget);
        expect(profile, engine == 'codex' ? findsOneWidget : findsNothing);
        expect(
          find.byKey(const ValueKey('new-harness-field-advanced')),
          findsNothing,
        );
        final target = engine == 'terminal'
            ? find.byKey(const ValueKey('new-harness-field-project'))
            : model;
        await _focus(tester, target);
        await key(tester, LogicalKeyboardKey.enter);
        expect(_chooser, findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        expect(_focused(tester, target), isTrue);
        expect(tester.getSize(_surface).width, 680);
        if (engine == 'codex') {
          await capture(tester, fixture, 'direct-settings-dark');
        }
        expect(fixture.box.engine, engineBefore);
        expect(fixture.box.project, projectBefore);
        expect(fixture.app.launches, isEmpty);
      },
    );
  }

  for (final field in ['project', 'agent', 'approvals']) {
    journey('$field chooser dismisses one level and restores its origin', (
      tester,
    ) async {
      final fixture = await _mount(tester);
      final target = find.byKey(ValueKey('new-harness-field-$field'));
      await _focus(tester, target);
      await key(tester, LogicalKeyboardKey.enter);
      expect(_chooser, findsOneWidget);
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(_chooser, findsNothing);
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(_focused(tester, target), isTrue);
      expect(fixture.closed, 0);
      expect(tester.getSize(_surface).width, 680);
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(fixture.closed, 1);
    });
  }

  journey(
    'held Return and a busy Start produce one launch, with failure recovery',
    (tester) async {
      final fixture = await _mount(tester, pending: true);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(fixture.app.launches, hasLength(1));
      expect(tester.widget<FilledButton>(_start).onPressed, isNull);
      await tester.tap(_start, warnIfMissed: false);
      await tester.pump();
      expect(fixture.app.launches, hasLength(1));
      fixture.app.pendingLaunch!.complete('Offline. Try again.');
      await tester.pumpAndSettle();
      fixture.app.pendingLaunch = null;
      expect(find.text('Offline. Try again.'), findsWidgets);
      expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
      expect(
        _focused(tester, _task),
        isTrue,
        reason:
            'Failure should leave Return ready to retry without an extra Tab',
      );
      await _focus(tester, _start);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(fixture.app.launches, hasLength(2));
      expect(fixture.box.task, isEmpty);
      expect(_task, findsOneWidget);
    },
  );

  journey('quick settings survive message editing and chooser acceptance', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    final worktree = find.byKey(const ValueKey('new-harness-field-worktree'));
    final before = fixture.box.worktree;
    await tester.tap(worktree);
    await tester.pumpAndSettle();
    expect(fixture.box.worktree, !before);
    final branch = find.byKey(const ValueKey('new-harness-field-branch'));
    await tester.tap(branch);
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.escape);
    expect(_focused(tester, branch), isTrue);
    expect(fixture.box.worktree, !before);
    await tester.enterText(_task, 'Preserve my worktree preference');
    final agent = find.byKey(const ValueKey('new-harness-field-agent'));
    await tester.tap(agent);
    await tester.pumpAndSettle();
    final claude = find.byKey(const ValueKey('new-harness-option-claude'));
    expect(claude, findsOneWidget);
    await tester.tap(claude);
    await tester.pumpAndSettle();
    expect(fixture.box.engine, 'claude');
    expect(fixture.box.task, 'Preserve my worktree preference');
    expect(fixture.box.worktree, !before);
    expect(_focused(tester, agent), isTrue);
    expect(fixture.app.launches, isEmpty);
  });

  journey('IME composition in the task blocks Return and Cmd-Return', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    await tester.tap(_task);
    await tester.pumpAndSettle();
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '選択',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 0, end: 2),
      ),
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    await key(tester, LogicalKeyboardKey.enter, cmd: true);
    expect(fixture.app.launches, isEmpty);
    expect(fixture.box.task, '選択');
    expect(_focused(tester, _task), isTrue);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '選択',
        selection: TextSelection.collapsed(offset: 2),
      ),
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter, cmd: true);
    await tester.pumpAndSettle();
    expect(fixture.app.launches, hasLength(1));
    expect(fixture.app.launches.single['prompt'], '選択');
  });

  journey('legacy expanded-settings draft restores into direct controls', (
    tester,
  ) async {
    final draft = NewHarnessDraft(
      machineId: 'm',
      engine: 'claude',
      project: const NewHarnessProject.folder('/work/repo'),
      task: '',
      permissionMode: 'ask',
      advancedOpen: true,
      worktree: false,
    );
    final fixture = await _mount(tester, draft: draft);
    expect(_task, findsOneWidget);
    expect(
      find.byKey(const ValueKey('new-harness-field-model')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-approvals')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-advanced')),
      findsNothing,
    );
    expect(tester.getSize(_surface).width, 680);
    expect(_focused(tester, _task), isTrue);
    expect(fixture.box.engine, 'claude');
    expect(fixture.box.worktree, isFalse);
    expect(fixture.box.mode, 'ask');
  });

  journey('restored and empty drafts both focus the prompt', (tester) async {
    final source = await _mount(tester);
    source.box.setTask('Draft from earlier');
    final draft = source.box.draft;
    await tester.pumpWidget(const SizedBox());
    final restored = await _mount(tester, draft: draft);
    expect(restored.box.task, 'Draft from earlier');
    expect(
      tester.widget<TextField>(_task).controller!.text,
      'Draft from earlier',
    );
    expect(_focused(tester, _task), isTrue);
    expect(tester.getSize(_surface).width, 680);
    restored.box.setTask('');
    final empty = restored.box.draft;
    await tester.pumpWidget(const SizedBox());
    final emptyFixture = await _mount(tester, draft: empty);
    expect(_task, findsOneWidget);
    expect(_focused(tester, _task), isTrue);
    expect(tester.getSize(_surface).width, 680);
    expect(emptyFixture.box.project, draft.project);
    expect(emptyFixture.box.worktree, draft.worktree);
  });

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final scale in [1.0, 1.6]) {
      journey('composer controls fit 600x520 ${brightness.name} scale=$scale', (
        tester,
      ) async {
        final fixture = await _mount(
          tester,
          size: const Size(600, 520),
          scale: scale,
          brightness: brightness,
          machineName: 'Studio Mac development workstation',
        );
        expect(tester.takeException(), isNull);
        expect(tester.getSize(_surface).width, lessThanOrEqualTo(552));
        await capture(tester, fixture, 'composer-${brightness.name}-$scale');
        await _focus(tester, _task);
        expect(_focused(tester, _task), isTrue);
        await tester.enterText(
          _task,
          'A task with enough text to wrap across the smaller window safely.',
        );
        for (final field in [
          'model',
          'approvals',
          'profile',
          'worktree',
          'branch',
        ]) {
          final control = find.byKey(ValueKey('new-harness-field-$field'));
          await _focus(tester, control);
          await tester.pumpAndSettle();
          expect(control.hitTestable(), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await _focus(tester, _start);
        expect(_start.hitTestable(), findsOneWidget);
        await capture(
          tester,
          fixture,
          'composer-filled-${brightness.name}-$scale',
        );
        expect(fixture.app.launches, isEmpty);
      });
    }
  }
}
