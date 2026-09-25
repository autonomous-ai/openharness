import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_preference.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/harness_catalog.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/agent_picker.dart';
import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

class _DelayedPreferences extends MemoryStore {
  final ready = Completer<void>();
  @override
  Future<String?> read(String key) async {
    await ready.future;
    return super.read(key);
  }
}

Future<void> openDialog(
  WidgetTester tester,
  AppNotifier app, {
  String? engine,
  ProjectFolderRequest? project,
  ValueChanged<NewHarnessDraft>? onBack,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1300, 1100);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => showNewAgentDialog(
              context,
              app,
              'm',
              source: 'test',
              initialEngine: engine,
              initialFolder: project == null ? '/work/scene' : null,
              initialProjectFolder: project,
              onBack: onBack,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

String dialogEngine(WidgetTester tester) => tester
    .widget<AgentPicker>(find.byKey(const Key('new-agent-agent-picker')))
    .value;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  List<String> engines = ['claude', 'codex'];
  final creates = <Map<String, dynamic>>[];
  bool installed = true;
  bool legacyInstall = false;
  Completer<void>? catalogGate;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'dsh_list') {
      await catalogGate?.future;
      return {
        'dsh': [
          {
            'id': 'autonomous/blender',
            'name': 'Blender',
            'engine': 'claude',
            'engines': engines,
            'installed': installed,
          },
          {
            'id': 'acme/legacy',
            'name': 'Legacy',
            'engine': 'claude',
            'installed': true,
          },
        ],
      };
    }
    if (type == 'dsh_install') {
      installed = true;
      if (legacyInstall) {
        engines = ['claude'];
      }
      return {'ok': true, 'id': payload['id']};
    }
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'git_project_info') return {'isGit': false};
    if (type == 'fs_list_dir') return {'path': '/home/user', 'entries': []};
    if (type == 'agent_create') {
      creates.add(Map.of(payload));
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {
          'id': 'created',
          'name': 'Blender',
          'engine': payload['engine'],
          'dsh': payload['dsh'],
        },
      };
    }
    return {};
  }
}

void choose(NewHarnessController box, NewHarnessField field, String id) {
  box.focusField(field);
  box.accept(box.options.singleWhere((option) => option.id == id));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('malformed preferences preserve a valid legacy engine and discard mixed histories', () async {
    final store = MemoryStore();
    store.values['new_agent_engine'] = 'codex';
    store.values['new_harness_preferences_v1'] = jsonEncode({
      'engine': 'autonomous/blender',
      'harness': 'codex',
      'agents': ['codex', 'autonomous/blender', 7, '', 'codex'],
      'harnesses': 'broken',
      'enginesByHarness': {
        'autonomous/blender': 'autonomous/typst',
        'coding': 'claude',
        'bad': false,
      },
    });
    final prefs = AgentPreference(store);
    await prefs.load();
    expect(prefs.value, 'codex');
    expect(prefs.harness, isNull);
    expect(prefs.recent, ['codex']);
    expect(prefs.recentHarnesses, isEmpty);
    expect(prefs.engineFor('autonomous/blender'), isNull);
    expect(prefs.engineFor(null), 'claude');
    await prefs.select('autonomous/blender');
    final restored = AgentPreference(store);
    await restored.load();
    expect(restored.harness, 'autonomous/blender');
    expect(restored.value, 'codex');
  });

  test('harness changes rename only generated projects and reject stale agent options', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    seedMixedAgents(app);
    addTearDown(app.dispose);
    await app.probeDsh('m', force: true);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      autoProject: true,
    );
    addTearDown(box.dispose);
    choose(box, NewHarnessField.harness, 'autonomous/blender');
    expect(box.project.generated!.name, startsWith('blender-'));
    box.focusField(NewHarnessField.agent);
    box.accept(const NewHarnessOption(id: 'terminal', title: 'Terminal'));
    expect(box.error, contains('compatible with Blender'));
    expect(box.engine, 'codex');
    box.toggleAdvanced();
    box.openLaunchSetting(NewHarnessField.mode);
    box.setQuery('ask');
    box.toggleAdvanced();
    expect(box.field, NewHarnessField.launch);
    expect(box.query, isEmpty);
    expect(box.advancedOpen, isFalse);
    box.setFolder('/work/custom');
    choose(box, NewHarnessField.harness, 'codex');
    expect(box.project.folder, '/work/custom');
  });

  testWidgets(
    'dialog applies a remembered agent when the catalog arrives late',
    (tester) async {
      final connection = _Connection()..catalogGate = Completer<void>();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.agentPreference.remember(
        'codex',
        harnessId: 'autonomous/blender',
      );
      await openDialog(tester, app, engine: 'autonomous/blender');
      expect(dialogEngine(tester), 'claude');
      connection.catalogGate!.complete();
      await tester.pumpAndSettle();
      expect(dialogEngine(tester), 'codex');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'dialog restores late preferences and returns the separate selection in its draft',
    (tester) async {
      final store = _DelayedPreferences();
      store.values['new_harness_preferences_v1'] = jsonEncode({
        'engine': 'codex',
        'harness': 'autonomous/blender',
        'agents': ['codex'],
        'harnesses': ['autonomous/blender'],
        'enginesByHarness': {'autonomous/blender': 'codex'},
        'advancedOpen': true,
      });
      final connection = _Connection();
      final app = createApp(store: store, connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      NewHarnessDraft? draft;
      await openDialog(tester, app, onBack: (value) => draft = value);
      store.ready.complete();
      await tester.pumpAndSettle();
      expect(dialogEngine(tester), 'codex');
      expect(
        tester
            .widget<AgentPicker>(
              find.byKey(const Key('new-agent-harness-picker')),
            )
            .value,
        'autonomous/blender',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(draft!.harnessId, 'autonomous/blender');
      expect(draft!.engine, 'codex');
      expect(draft!.advancedOpen, isTrue);
    },
  );

  testWidgets(
    'dialog refuses an engine that becomes incompatible during installation',
    (tester) async {
      final connection = _Connection()
        ..installed = false
        ..legacyInstall = true;
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.probeDsh('m', force: true);
      await openDialog(tester, app, engine: 'autonomous/blender');
      await chooseAgent(tester, 'codex');
      final submit = find.byKey(const ValueKey('create-agent-submit'));
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pumpAndSettle();
      expect(find.textContaining('does not support Codex'), findsOneWidget);
      expect(dialogEngine(tester), 'codex');
      expect(connection.creates, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'dialog previews Coding and engines, updates generated projects, and opens the Store',
    (tester) async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.probeDsh('m', force: true);
      NewHarnessDraft? draft;
      await openDialog(
        tester,
        app,
        engine: 'autonomous/blender',
        project: ProjectFolderRequest.generated(
          label: 'Blender',
          at: DateTime(2026),
        ),
        onBack: (value) => draft = value,
      );
      await chooseHarness(tester, NewHarnessController.codingId);
      await openHarnessSearch(tester);
      await tester.enterText(harnessSearch, 'Coding');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.slash);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('new-agent-harness-preview')),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await openAgentSearch(tester);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.slash);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      for (final engine in ['codex', 'terminal']) {
        await tester.enterText(agentSearch, engine);
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('new-agent-agent-preview')),
          findsOneWidget,
        );
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      final browse = find.text('Browse Harness Store…');
      await tester.ensureVisible(browse);
      await tester.tap(browse);
      await tester.pumpAndSettle();
      expect(app.activeSwarm.isStore, isTrue);
      expect(draft!.harnessId, isNull);
      expect(draft!.project.generated!.name, startsWith('claude-code-'));
    },
  );

  testWidgets(
    'picker choices retain the correct visual identity independently of their layout',
    (tester) async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await openDialog(tester, app);
      final harnesses = tester
          .widget<AgentPicker>(
            find.byKey(const Key('new-agent-harness-picker')),
          )
          .choices;
      final agents = tester
          .widget<AgentPicker>(find.byKey(const Key('new-agent-agent-picker')))
          .choices;
      final coding = harnesses.singleWhere(
        (choice) => choice.id == NewHarnessController.codingId,
      );
      final codex = agents.singleWhere((choice) => choice.id == 'codex');
      final terminal = agents.singleWhere((choice) => choice.id == 'terminal');
      expect(agents.every((choice) => !choice.id.contains('/')), isTrue);
      await tester.pumpWidget(
        MaterialApp(
          home: Row(
            children: [coding.mark(28), codex.mark(28), terminal.mark(28)],
          ),
        ),
      );
      expect(find.byType(Icon), findsWidgets);
      expect(
        tester
            .widgetList<EngineMark>(find.byType(EngineMark))
            .map((mark) => mark.engine),
        ['codex', 'terminal'],
      );
    },
  );

  testWidgets(
    'inline Advanced settings work by keyboard and by clicking their rows',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/scene',
      );
      addTearDown(box.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1100, 800);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              onClose: () {},
              onNeedsForm: () {},
              onCreated: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final name in ['mode', 'profile']) {
        box.focusField(NewHarnessField.launch);
        await tester.pump();
        await openLaunchRow(tester, name);
        expect(box.field.name, name);
        box.focusField(NewHarnessField.launch);
        await tester.pump();
        await tester.tap(
          find.byKey(
            ValueKey(
              'new-harness-field-${name == 'mode' ? 'approvals' : name}',
            ),
          ),
        );
        await tester.pump();
        expect(box.field.name, name);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'wide dock exposes engines beyond six rows and scrolls a long harness catalog',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      app.machineStates['m']!.dsh.replace([
        for (var i = 0; i < 50; i++)
          DshEntry(
            id: 'review/harness-$i',
            name: 'Harness $i',
            engine: 'claude',
            installed: true,
          ),
      ]);
      addTearDown(app.dispose);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/scene',
        offersStore: true,
      );
      addTearDown(box.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1100, 800);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              onClose: () {},
              onCreated: () {},
              onNeedsForm: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openLaunchRow(tester, 'agent');
      for (var i = 0; i < 30 && box.selected?.id != 'agy'; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
      }
      expect(
        find.byKey(const ValueKey('new-harness-option-agy')).hitTestable(),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(box.engine, 'agy');
      await openLaunchRow(tester, 'harness');
      for (
        var i = 0;
        i < box.options.length &&
            box.selected?.id != NewHarnessController.storeId;
        i++
      ) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
      }
      expect(
        find
            .byKey(
              const ValueKey(
                'new-harness-option-${NewHarnessController.storeId}',
              ),
            )
            .hitTestable(),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'legacy mixed history splits without moving or deleting its storage',
    () async {
      final store = MemoryStore();
      store.values.addAll({
        'new_agent_engine': 'autonomous/blender',
        'new_agent_recent':
            'autonomous/blender\ncodex\nautonomous/typst\nclaude',
      });
      final prefs = AgentPreference(store);
      await prefs.load();
      expect(prefs.harness, 'autonomous/blender');
      expect(prefs.recent, ['codex', 'claude']);
      expect(prefs.recentHarnesses.toSet(), {
        'autonomous/blender',
        'autonomous/typst',
      });
      await prefs.remember('codex', harnessId: 'autonomous/blender');
      await prefs.setAdvanced(true);
      await prefs.remember('claude');
      final restored = AgentPreference(store);
      await restored.load();
      expect(restored.harness, isNull);
      expect(restored.engineFor('autonomous/blender'), 'codex');
      expect(restored.engineFor(null), 'claude');
      expect(restored.advancedOpen, isTrue);
      expect(restored.recent, ['claude', 'codex']);
      expect(store.values['new_agent_engine'], 'autonomous/blender');
    },
  );

  test('old daemons and installed aliases determine compatibility', () {
    final old = DshEntry.fromJson({
      'id': 'local/ollama',
      'name': 'Ollama',
      'engine': 'codex',
      'installed': true,
    })!;
    final current = DshEntry.fromJson({
      'id': 'autonomous/ollama',
      'name': 'Ollama',
      'engine': 'codex',
      'engines': ['codex', 'claude'],
    })!;
    expect(old.supportedEngines, ['codex']);
    expect(currentHarnessCatalog([old, current]).single.supportedEngines, [
      'codex',
    ]);
  });

  test('agent changes preserve harness and launch the exact pair', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    seedMixedAgents(app);
    addTearDown(app.dispose);
    await app.probeDsh('m', force: true);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'autonomous/blender',
      folder: '/work/scene',
    );
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.agent);
    expect(box.options.map((row) => row.id).toSet(), {'claude', 'codex'});
    choose(box, NewHarnessField.agent, 'codex');
    expect(box.harnessId, 'autonomous/blender');
    expect(box.draft.engine, 'codex');
    expect(box.draft.harnessId, 'autonomous/blender');
    expect(await box.create(), NewHarnessOutcome.created);
    expect(connection.creates.single, containsPair('engine', 'codex'));
    expect(
      connection.creates.single,
      containsPair('dsh', 'autonomous/blender'),
    );
    await Future<void>.delayed(Duration.zero);
    expect(app.agentPreference.engineFor('autonomous/blender'), 'codex');
    expect(app.agentPreference.recent, isNot(contains('autonomous/blender')));
  });

  test(
    'Coding removes only the package choice and restores all engines',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.probeDsh('m', force: true);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'autonomous/blender',
        folder: '/work/scene',
      );
      addTearDown(box.dispose);
      choose(box, NewHarnessField.harness, 'codex');
      expect(box.harnessId, isNull);
      box.focusField(NewHarnessField.agent);
      expect(box.options.any((row) => row.id == 'opencode'), isTrue);
      expect(box.options.any((row) => row.id.contains('/')), isFalse);
      choose(box, NewHarnessField.agent, 'codex');
      expect(await box.create(), NewHarnessOutcome.created);
      expect(connection.creates.single.containsKey('dsh'), isFalse);
      expect(box.project.folder, '/work/scene');
    },
  );

  for (final userChooses in [false, true]) {
    test(
      'late catalog restores a remembered engine unless a user chose (chosen=$userChooses)',
      () async {
        final gate = Completer<void>();
        final connection = _Connection()..catalogGate = gate;
        final app = createApp(connectionForTest: (_) => connection);
        seedMixedAgents(app);
        addTearDown(app.dispose);
        await app.agentPreference.remember(
          'codex',
          harnessId: 'autonomous/blender',
        );
        final box = NewHarnessController(
          app,
          machineId: 'm',
          engine: 'autonomous/blender',
          folder: '/work/scene',
        );
        addTearDown(box.dispose);
        await Future<void>.delayed(Duration.zero);
        if (userChooses) choose(box, NewHarnessField.agent, 'claude');
        gate.complete();
        await app.probeDsh('m');
        await Future<void>.delayed(Duration.zero);
        expect(box.harnessId, 'autonomous/blender');
        expect(box.engine, userChooses ? 'claude' : 'codex');
      },
    );
  }

  test('late installed compatibility refuses a stale pair without substituting an agent', () async {
    final connection = _Connection()
      ..installed = false
      ..legacyInstall = true;
    final app = createApp(connectionForTest: (_) => connection);
    seedMixedAgents(app);
    addTearDown(app.dispose);
    await app.probeDsh('m', force: true);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'autonomous/blender',
      folder: '/work/scene',
    );
    addTearDown(box.dispose);
    choose(box, NewHarnessField.agent, 'codex');
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.error, contains('does not support Codex'));
    expect(connection.creates, isEmpty);
    expect(box.engine, 'codex');
    expect(box.harnessId, 'autonomous/blender');
    box.focusField(NewHarnessField.agent);
    expect(box.options.map((row) => row.id), ['claude']);
  });

  for (final (layout, viewport) in [
    ('wide', const Size(1100, 720)),
    ('compact', const Size(600, 720)),
  ]) {
    testWidgets(
      '$layout form keeps Agent and Project visible and expands Advanced inline',
      (tester) async {
        final renderDir = Platform.environment['HARNESS_LAUNCH_RENDER_DIR'];
        if (renderDir != null) await tester.runAsync(loadPreviewFonts);
        final connection = _Connection();
        final app = createApp(connectionForTest: (_) => connection);
        seedMixedAgents(app);
        addTearDown(app.dispose);
        final box = NewHarnessController(
          app,
          machineId: 'm',
          engine: 'autonomous/blender',
          folder: '/work/scene',
          offersStore: true,
        );
        addTearDown(box.dispose);
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = viewport;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: ThemeData.dark(),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 1000,
                  height: 480,
                  child: NewHarnessForm(
                    controller: box,
                    onClose: () {},
                    onCreated: () {},
                    onNeedsForm: () => fail('Advanced must stay inline'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        for (final row in ['agent', 'project']) {
          expect(
            find.byKey(ValueKey('new-harness-field-$row')).hitTestable(),
            findsOneWidget,
          );
        }
        expect(
          find.byKey(const ValueKey('new-harness-field-worktree')),
          findsNothing,
        );
        await tester.tap(find.byKey(const ValueKey('new-harness-field-agent')));
        await tester.pump();
        expect(find.text('Browse Harness Store'), findsOneWidget);
        if (renderDir != null) {
          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(
              Uri.file('$renderDir/$layout-harness-picker.png'),
            ),
          );
        }
        await typeHarnessQuery(tester, 'Blender');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(find.text('Browse Harness Store'), findsNothing);
        expect(box.options.map((row) => row.id).toSet(), {'codex', 'claude'});
        await openLaunchRow(tester, 'advanced');
        await tester.pump();
        expect(
          find.byKey(const ValueKey('new-harness-field-machine')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('new-harness-field-approvals')),
          findsOneWidget,
        );
        if (renderDir != null) {
          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(Uri.file('$renderDir/$layout-agent-picker.png')),
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(milliseconds: 200));
      },
    );
  }
}
