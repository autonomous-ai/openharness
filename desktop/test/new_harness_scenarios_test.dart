import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:harness/core/dsh_catalog.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show key;
import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection(String machine)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machine,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final starts = <Map<String, dynamic>>[];
  Completer<Map<String, dynamic>>? starting;
  var failStart = false;
  var loseReply = false;
  var profileReads = 0;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {
          'engines': [
            {'engine': 'codex', 'installed': true, 'supportsCodexHome': true},
            {'engine': 'claude', 'installed': true},
          ],
        };
      case 'dsh_list':
        return {'dsh': []};
      case 'fs_list_dir':
        return {
          'path': payload['path'] ?? '/home/test',
          'entries': [
            if (payload['path'] == '/work')
              {'name': 'my project', 'isDir': true},
          ],
        };
      case 'codex_profiles_list':
        profileReads++;
        return {
          'profiles': [
            {'path': '/profiles/work', 'label': 'Work'},
          ],
        };
      case 'agent_create':
        starts.add(Map.of(payload));
        if (starting != null) return starting!.future;
        if (loseReply) {
          loseReply = false;
          throw const WsRequestTimeout('agent_create');
        }
        if (failStart) {
          return {
            'creationId': payload['creationId'],
            'state': 'failed',
            'failure': {
              'code': 'START_FAILED',
              'detail': 'Fixture launch refused',
            },
          };
        }
        return created(payload);
      case 'agent_create_status':
        return created(payload);
      default:
        return {};
    }
  }

  Map<String, dynamic> created(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': {'id': 'created', 'name': 'Created', 'engine': 'codex'},
  };
}

const _git = {
  'isGit': true,
  'branch': 'main',
  'defaultRef': 'refs/remotes/origin/main',
  'branches': [
    {'ref': 'refs/heads/main', 'name': 'main'},
    {
      'ref': 'refs/heads/feature',
      'name': 'feature',
      'worktree': '/work/feature',
    },
    {
      'ref': 'refs/remotes/origin/release',
      'name': 'origin/release',
      'remote': true,
    },
  ],
};

class _Scenario {
  late final AppNotifier app;
  late final NewHarnessController box;
  final connections = <String, _Connection>{};
  int closes = 0, creates = 0, stores = 0, links = 0;
}

Future<_Scenario> _mount(
  WidgetTester tester, {
  String engine = 'codex',
  Size size = const Size(1000, 700),
  double scale = 1,
  bool git = true,
  bool editProject = true,
  Future<Map<String, dynamic>>? gitReply,
  FutureOr<void> Function(_Scenario)? onBrowse,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final scenario = _Scenario();
  scenario.app = createApp(
    connectionForTest: (machine) =>
        scenario.connections.putIfAbsent(machine, () => _Connection(machine)),
  );
  seedMixedAgents(scenario.app);
  scenario.app.machineStates['m']!.localOnly = true;
  scenario.app.gitProjectReaderForTest = (_, _) async =>
      gitReply ?? (git ? _git : {'isGit': false});
  await scenario.app.projectHistory.select('m', '/work/a-unique-parent/repo');
  scenario.box = NewHarnessController(
    scenario.app,
    machineId: 'm',
    engine: engine,
    offersStore: true,
    folder: '/work/repo',
  );
  addTearDown(scenario.app.dispose);
  addTearDown(scenario.box.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData.dark(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: Scaffold(
        body: RepaintBoundary(
          key: const ValueKey('cmd-n-fixture'),
          child: NewHarnessForm(
            controller: scenario.box,
            onClose: () => scenario.closes++,
            onCreated: () => scenario.creates++,
            onStore: () => scenario.stores++,
            onLinkProfile: () => scenario.links++,
            onBrowse: () => onBrowse?.call(scenario),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  if (editProject) {
    await openLaunchRow(tester, 'project');
  }
  return scenario;
}

Finder _option(String id) => find.byKey(ValueKey('new-harness-option-$id'));
Finder _field(String id) => find.byKey(ValueKey('new-harness-field-$id'));

void main() {
  if (const String.fromEnvironment('CMD_N_REVIEW').isNotEmpty) {
    setUpAll(loadPreviewFonts);
  }
  Future<void> capture(WidgetTester tester, String name) async {
    const output = String.fromEnvironment('CMD_N_REVIEW');
    if (output.isEmpty) return;
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(const ValueKey('cmd-n-fixture')),
    );
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 1);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      final directory = Directory(output)..createSync(recursive: true);
      await File('${directory.path}/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets(
    'Cmd-N opens Agent, Project and Options with Enter ready to launch',
    (tester) async {
      final scenario = await _mount(
        tester,
        editProject: false,
        git: false,
        size: const Size(1000, 420),
      );
      expect(_field('agent'), findsOneWidget);
      expect(_field('project'), findsOneWidget);
      expect(_field('advanced'), findsOneWidget);
      for (final name in [
        'machine',
        'model',
        'branch',
        'worktree',
        'approvals',
        'profile',
      ]) {
        expect(_field(name), findsNothing);
      }
      expect(
        tester.widget<Semantics>(_field('start')).properties.selected,
        isTrue,
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.byKey(const ValueKey('new-harness-summary')), findsNothing);
      expect(find.text('M2:/work/repo'), findsOneWidget);
      expect(scenario.connections.values.expand((c) => c.starts), isEmpty);
      await capture(tester, 'rest');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(scenario.creates, 1);
      expect(scenario.connections['m']!.starts, hasLength(1));
    },
  );

  testWidgets(
    'specialized agents choose a compatible remembered runner in the same pane',
    (tester) async {
      final scenario = await _mount(tester, editProject: false);
      scenario.app.machineStates['m']!.dsh.replace(const [
        DshEntry(
          id: 'autonomous/blender',
          name: 'Blender',
          engine: 'claude',
          engines: ['codex', 'claude'],
          installed: true,
        ),
      ]);
      await scenario.app.agentPreference.remember(
        'claude',
        harnessId: 'autonomous/blender',
      );
      await openLaunchRow(tester, 'agent');
      expect(scenario.box.options.any((o) => o.title == 'Code'), isFalse);
      await typeHarnessQuery(tester, 'blender');
      final query = find.byKey(const ValueKey('new-harness-query'));
      final queryTop = tester.getTopLeft(query).dy;
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.field, NewHarnessField.agent);
      expect(scenario.box.options.map((o) => o.id).toSet(), {
        'claude',
        'codex',
      });
      expect(scenario.box.selected!.id, 'claude');
      expect(
        tester.widget<TextField>(query).decoration!.hintText,
        'Run Blender with',
      );
      expect(tester.getTopLeft(query).dy, queryTop);
      expect(find.text('Run Blender with'), findsOneWidget);
      await capture(tester, 'blender');
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(harnessChoicesActive(tester), isFalse);
      await openLaunchRow(tester, 'agent');
      await typeHarnessQuery(tester, 'blender');
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      expect(scenario.box.field, NewHarnessField.harness);
      expect(harnessChoicesActive(tester), isTrue);
      await typeHarnessQuery(tester, 'blender');
      await key(tester, LogicalKeyboardKey.enter);
      await typeHarnessQuery(tester, 'codex');
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.launchAgentLabel, 'Blender · Codex');
      expect(harnessChoicesActive(tester), isFalse);
      for (final label in ['Agent', 'Project', 'Options']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(find.text('Agent default'), findsNothing);
      await capture(tester, 'blender-form');
      await openLaunchRow(tester, 'agent');
      await typeHarnessQuery(tester, 'Claude Code');
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.harnessId, isNull);
      expect(scenario.box.engine, 'claude');
      expect(harnessChoicesActive(tester), isFalse);
      expect(scenario.creates, 0);
    },
  );

  testWidgets(
    'Project searches machine and folder together and applies both only on Enter',
    (tester) async {
      final scenario = await _mount(tester, editProject: false);
      await scenario.app.projectHistory.select('studio', '/work/repo');
      await openLaunchRow(tester, 'project');
      expect(
        scenario.box.options.firstWhere((o) => !o.synthetic).machineId,
        'm',
      );
      await capture(tester, 'projects');
      await typeHarnessQuery(tester, 'Office repo');
      expect(scenario.box.selected!.machineId, 'studio');
      expect(scenario.box.machineId, 'm');
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.machineId, 'studio');
      expect(scenario.box.project.folder, '/work/repo');
      expect(scenario.box.launchProjectLabel, 'iMac · Office:/work/repo');
      await openLaunchRow(tester, 'project');
      await typeHarnessQuery(tester, 'build');
      expect(scenario.box.selected!.enabled, isFalse);
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.machineId, 'studio');
      expect(scenario.box.error, 'Offline');
      scenario.app.machineStates['build']!.nodeOnline = true;
      scenario.app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      expect(scenario.box.selected!.enabled, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.machineId, 'build');
      expect(scenario.creates, 0);
      await tester.pumpAndSettle();
    },
  );

  testWidgets('paging before the first choices frame keeps the saved agent', (
    tester,
  ) async {
    final scenario = await _mount(tester, editProject: false);
    await focusLaunchRow(tester, 'agent');
    final engine = scenario.box.engine;
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
    await tester.pumpAndSettle();
    expect(harnessChoicesActive(tester), isTrue);
    expect(scenario.box.selected, isNotNull);
    expect(scenario.box.engine, engine);
    expect(scenario.creates, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'page keys move choices and Space toggles Worktree without launching',
    (tester) async {
      final scenario = await _mount(tester);
      await openLaunchRow(tester, 'agent');
      final engine = scenario.box.engine;
      final cursor = scenario.box.cursor;
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(scenario.box.cursor, greaterThan(cursor));
      await key(tester, LogicalKeyboardKey.pageUp);
      expect(scenario.box.cursor, cursor);
      await key(tester, LogicalKeyboardKey.space);
      expect(scenario.box.engine, engine);
      await focusLaunchRow(tester, 'worktree');
      final original = scenario.box.worktree;
      await key(tester, LogicalKeyboardKey.space);
      expect(scenario.box.worktree, !original);
      await key(tester, LogicalKeyboardKey.space);
      expect(scenario.box.worktree, original);
      expect(scenario.creates, 0);
    },
  );

  for (final action in [
    NewHarnessController.newProjectId,
    NewHarnessController.existingProjectId,
    NewHarnessController.repositoryId,
  ]) {
    testWidgets(
      '$action defaults its machine chooser to local and Escape retraces the steps',
      (tester) async {
        final scenario = await _mount(tester, editProject: false);
        await openLaunchRow(tester, 'project');
        await typeHarnessQuery(tester, 'Office helmet');
        await key(tester, LogicalKeyboardKey.enter);
        expect(scenario.box.machineId, 'studio');
        await openLaunchRow(tester, 'project');
        await tester.tap(_option(action));
        await tester.pumpAndSettle();
        expect(scenario.box.field, NewHarnessField.machine);
        expect(scenario.box.machineId, 'studio');
        expect(scenario.box.selected!.id, 'm');
        await key(tester, LogicalKeyboardKey.enter);
        expect(scenario.box.machineId, 'm');
        expect(scenario.box.field, switch (action) {
          NewHarnessController.newProjectId => NewHarnessField.projectName,
          NewHarnessController.repositoryId =>
            NewHarnessField.projectRepository,
          _ => NewHarnessField.project,
        });
        await key(tester, LogicalKeyboardKey.escape);
        expect(scenario.box.field, NewHarnessField.machine);
        await key(tester, LogicalKeyboardKey.escape);
        expect(scenario.box.field, NewHarnessField.projectMenu);
        expect(harnessChoicesActive(tester), isTrue);
        expect(scenario.creates, 0);
        await tester.pumpAndSettle();
      },
    );
  }

  for (final (size, scale) in [
    (const Size(520, 520), 1.0),
    (const Size(1400, 900), 2.0),
  ]) {
    testWidgets('minimal opening stays on the terminal grid at $size, $scale', (
      tester,
    ) async {
      await _mount(tester, size: size, scale: scale, editProject: false);
      expect(
        tester.getSize(_field('agent')).height,
        tester.getSize(_field('project')).height,
      );
      await capture(tester, 'rest-${size.width.toInt()}');
      await openLaunchRow(tester, 'agent');
      expect(harnessChoicesActive(tester), isTrue);
      expect(find.byType(Icon), findsNothing);
      await capture(tester, 'agents-${size.width.toInt()}');
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('accessibility clicks activate fields like pointer clicks', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final scenario = await _mount(tester);
    void activate(String name) {
      final node = tester.getSemantics(_field(name));
      node.owner!.performAction(node.id, SemanticsAction.tap);
    }

    expect(scenario.box.worktree, isTrue);
    await focusLaunchRow(tester, 'worktree');
    activate('worktree');
    await tester.pump();
    expect(scenario.box.worktree, isFalse);
    activate('worktree');
    await tester.pump();
    expect(scenario.box.worktree, isTrue);
    activate('agent');
    await tester.pumpAndSettle();
    expect(harnessChoicesActive(tester), isTrue);
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).focusNode.hasFocus,
      isTrue,
    );
    semantics.dispose();
  });

  for (final scale in [1.0, 1.8]) {
    testWidgets('prompt text, doors and names share one column at $scale', (
      tester,
    ) async {
      await _mount(tester, scale: scale, size: const Size(1600, 1000));
      final prompt = find.byKey(const ValueKey('new-harness-prompt'));
      final hint = find.text('Search projects');
      double baseline(Finder finder) {
        final render = tester.renderObject<RenderBox>(finder);
        return render
            .localToGlobal(
              Offset(
                0,
                render.getDryBaseline(
                  render.constraints,
                  TextBaseline.alphabetic,
                )!,
              ),
            )
            .dy;
      }

      expect(baseline(prompt), closeTo(baseline(hint), .1));
      // The doors lost their glyphs; their names start where the typed
      // text does, and no icon is left in the pointer column.
      final text = tester.getTopLeft(hint).dx;
      for (final id in [
        NewHarnessController.repositoryId,
        NewHarnessController.existingProjectId,
        NewHarnessController.newProjectId,
      ]) {
        expect(
          find.descendant(of: _option(id), matching: find.byType(Icon)),
          findsNothing,
        );
        final name = find.descendant(
          of: _option(id),
          matching: find.byType(Text),
        );
        expect(tester.getTopLeft(name.first).dx, closeTo(text, .5));
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'names stay single-line while full project paths remain searchable',
    (tester) async {
      final scenario = await _mount(tester);
      await typeHarnessQuery(tester, 'unique-parent');
      final option = scenario.box.options.singleWhere((row) => !row.synthetic);
      expect(option.title, 'M2:/work/a-unique-parent/repo');
      expect(
        find.descendant(of: _option(option.id), matching: find.byType(Text)),
        findsOneWidget,
      );
      expect(find.text(option.title), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.project.folder, '/work/a-unique-parent/repo');
      expect(scenario.creates, 0);
    },
  );

  testWidgets(
    'only the local machine carries a note and disabled choices explain refusal',
    (tester) async {
      final scenario = await _mount(tester);
      scenario.app.machineStates['studio']!.needsLink = true;
      await openLaunchRow(tester, 'machine');
      expect(
        find.descendant(of: _option('m'), matching: find.text('This machine')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: _option('studio'),
          matching: find.text('This machine'),
        ),
        findsNothing,
      );
      expect(find.text('Remote'), findsNothing);
      // The two things wrong with a machine need different answers — a link,
      // or a power button — so they still look different: an unlinked one in
      // the warning colour, an offline one with its word. The unlinked row
      // prints no word, but a screen reader is still told.
      expect(
        find.descendant(
          of: _option('studio'),
          matching: find.text('Link required'),
        ),
        findsNothing,
      );
      final studio = tester.widget<Text>(
        find
            .descendant(of: _option('studio'), matching: find.byType(Text))
            .first,
      );
      // Dark grey: darker than an idle row's faint, so it recedes.
      expect(
        studio.style!.color,
        terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        ).foreground.withValues(alpha: .28),
      );
      final handle = tester.ensureSemantics();
      expect(tester.getSemantics(_option('studio')).hint, 'Link required');
      handle.dispose();
      expect(
        find.descendant(of: _option('build'), matching: find.text('Offline')),
        findsOneWidget,
      );
      for (final (id, message) in [
        ('studio', 'not linked'),
        ('build', 'offline'),
      ]) {
        await tester.tap(_option(id));
        await tester.pump();
        expect(scenario.box.machineId, 'm');
        expect(scenario.box.error, contains(message));
        expect(harnessChoicesActive(tester), isTrue);
      }
      await tester.tap(_option('m'));
      await tester.pump();
      expect(scenario.box.machineId, 'm');
      expect(scenario.box.error, isNull);
      expect(find.byKey(const ValueKey('new-harness-status')), findsNothing);
    },
  );

  testWidgets(
    'branch metadata is hidden and unavailable remote branches cannot be applied',
    (tester) async {
      final scenario = await _mount(tester);
      await openLaunchRow(tester, 'worktree');
      expect(scenario.box.worktree, isFalse);
      await openLaunchRow(tester, 'branch');
      for (final option in scenario.box.options) {
        expect(
          find.descendant(of: _option(option.id), matching: find.byType(Text)),
          findsOneWidget,
        );
      }
      await tester.tap(_option('refs/remotes/origin/release'));
      await tester.pump();
      expect(scenario.box.branchRef, 'refs/heads/main');
      expect(scenario.box.error, contains('Turn Worktree on'));
      await tester.tap(_option('refs/heads/feature'));
      await tester.pump();
      expect(scenario.box.branchRef, 'refs/heads/feature');
      expect(scenario.box.opensWorktree, isTrue);
      expect(scenario.creates, 0);
    },
  );

  for (final engine in ['codex', 'claude', 'cursor', 'opencode']) {
    testWidgets(
      '$engine approvals are single-line and each value applies without starting',
      (tester) async {
        final scenario = await _mount(tester, engine: engine);
        await openLaunchRow(tester, 'approvals');
        final modes = scenario.box.options.toList();
        expect(modes.map((mode) => mode.id), switch (engine) {
          'codex' => ['readOnly', 'ask', 'auto', 'full'],
          'claude' => ['auto', 'acceptEdits', 'plan', 'ask', 'full'],
          _ => ['auto', 'ask'],
        });
        for (final mode in modes) {
          expect(
            find.descendant(of: _option(mode.id), matching: find.byType(Text)),
            findsOneWidget,
          );
          await tester.tap(_option(mode.id));
          await tester.pump();
          expect(scenario.box.mode, mode.id);
          expect(scenario.box.engine, engine);
          expect(scenario.creates, 0);
          await openLaunchRow(tester, 'approvals');
        }
      },
    );
  }

  testWidgets(
    'clicking approvals uses the chosen agent, not the list preview',
    (tester) async {
      final scenario = await _mount(tester);
      await focusLaunchRow(tester, 'agent');
      await tester.tap(_field('agent'));
      await tester.pump();
      await tester.tap(_option('claude'));
      await tester.pump();
      expect(scenario.box.engine, 'claude');
      expect(_field('profile'), findsNothing);
      await openLaunchRow(tester, 'advanced');
      await tester.tap(_field('approvals'));
      await tester.pump();
      expect(scenario.box.options.map((mode) => mode.id), [
        'auto',
        'acceptEdits',
        'plan',
        'ask',
        'full',
      ]);
      await tester.tap(_option('plan'));
      await tester.pump();
      expect(scenario.box.engine, 'claude');
      expect(scenario.box.mode, 'plan');

      // Browsing a different engine must not change the saved agent's settings.
      await tester.tap(_field('agent'));
      await tester.pump();
      await typeHarnessQuery(tester, 'Codex');
      expect(scenario.box.selected?.id, 'codex');
      await focusLaunchRow(tester, 'approvals');
      await tester.tap(_field('approvals'));
      await tester.pump();
      expect(scenario.box.options.map((mode) => mode.id), [
        'auto',
        'acceptEdits',
        'plan',
        'ask',
        'full',
      ]);
      await tester.tap(_option('ask'));
      await tester.pump();
      expect(scenario.box.engine, 'claude');
      expect(scenario.box.mode, 'ask');
      expect(scenario.creates, 0);
    },
  );

  testWidgets(
    'empty results explain Return and Escape retraces the project steps',
    (tester) async {
      final scenario = await _mount(tester);
      await openLaunchRow(tester, 'machine');
      await typeHarnessQuery(tester, 'nonexistent-machine');
      expect(find.text('No matches'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.pageDown);
      await key(tester, LogicalKeyboardKey.pageUp);
      expect(scenario.box.selected, isNull);
      expect(scenario.box.query, 'nonexistent-machine');
      expect(tester.takeException(), isNull);
      await key(tester, LogicalKeyboardKey.numpadEnter);
      expect(scenario.box.error, contains('No values match'));
      expect(scenario.box.machineId, 'm');
      await key(tester, LogicalKeyboardKey.escape);
      expect(scenario.box.query, isEmpty);
      expect(scenario.closes, 0);
      await key(tester, LogicalKeyboardKey.escape);
      expect(scenario.closes, 0);
      await key(tester, LogicalKeyboardKey.escape);
      expect(scenario.closes, 1);
    },
  );

  testWidgets('reverse Tab, key repeats and Page keys stay within setup', (
    tester,
  ) async {
    final scenario = await _mount(tester, engine: 'claude');
    await focusLaunchRow(tester, 'harness');
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    expect(
      tester.widget<Semantics>(_field('start')).properties.selected,
      isTrue,
    );
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    expect(
      tester.widget<Semantics>(_field('advanced')).properties.selected,
      isTrue,
    );
    await focusLaunchRow(tester, 'approvals');
    final originalMode = scenario.box.mode;
    await key(tester, LogicalKeyboardKey.pageDown);
    expect(scenario.box.mode, isNot(originalMode));
    await key(tester, LogicalKeyboardKey.pageUp);
    expect(scenario.box.mode, originalMode);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyRepeatEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    // Two steps up from Approvals: Model, then Options.
    expect(
      tester.widget<Semantics>(_field('advanced')).properties.selected,
      isTrue,
    );
    expect(FocusManager.instance.primaryFocus?.debugLabel, 'new-harness-form');
    expect(scenario.creates, 0);
  });

  testWidgets(
    'paste fills the active search and backspace removes a whole Unicode character',
    (tester) async {
      final scenario = await _mount(tester);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.getData') {
            return {'text': 'repo👩🏽‍💻'};
          }
          return null;
        },
      );
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump();
      expect(scenario.box.query, 'repo👩🏽‍💻');
      await key(tester, LogicalKeyboardKey.backspace);
      expect(scenario.box.query, 'repo');
      expect(scenario.creates, 0);
    },
  );

  testWidgets(
    'Store, profile linking and profile refresh are reachable by pointer',
    (tester) async {
      final scenario = await _mount(tester);
      await openLaunchRow(tester, 'harness');
      await typeHarnessQuery(tester, 'nothing-installed-with-this-name');
      await tester.tap(_option(NewHarnessController.storeId));
      await tester.pump();
      expect(scenario.stores, 1);
      await openLaunchRow(tester, 'profile');
      await tester.tap(_option(NewHarnessController.linkProfileId));
      await tester.pump();
      expect(scenario.links, 1);
      final connection = scenario.connections['m']!;
      final reads = connection.profileReads;
      await tester.tap(_option(NewHarnessController.refreshProfilesId));
      await tester.pumpAndSettle();
      expect(connection.profileReads, reads + 1);
      expect(scenario.creates, 0);
    },
  );

  testWidgets('an empty clone prompt validates without starting', (
    tester,
  ) async {
    final scenario = await _mount(tester);
    await tester.tap(_option(NewHarnessController.repositoryId));
    await tester.pump();
    expect(scenario.box.field, NewHarnessField.machine);
    await key(tester, LogicalKeyboardKey.enter);
    expect(scenario.box.field, NewHarnessField.projectRepository);
    await key(tester, LogicalKeyboardKey.enter);
    expect(scenario.box.error, isNotNull);
    expect(scenario.creates, 0);
    await key(tester, LogicalKeyboardKey.escape);
    expect(scenario.box.field, NewHarnessField.machine);
    await key(tester, LogicalKeyboardKey.escape);
    expect(scenario.box.field, NewHarnessField.projectMenu);
  });

  testWidgets('the three project actions carry no glyphs, and read as text', (
    tester,
  ) async {
    final scenario = await _mount(tester);
    // A terminal has no icons: the actions are words, like every other row.
    for (final id in [
      NewHarnessController.repositoryId,
      NewHarnessController.existingProjectId,
      NewHarnessController.newProjectId,
    ]) {
      expect(
        find.descendant(of: _option(id), matching: find.byType(Icon)),
        findsNothing,
      );
    }
    final project = scenario.box.options.firstWhere(
      (option) => !option.synthetic,
    );
    expect(
      find.descendant(of: _option(project.id), matching: find.byType(Icon)),
      findsNothing,
    );
  });

  testWidgets(
    'native text input supports paste, selection replacement and composition',
    (tester) async {
      final scenario = await _mount(tester);
      await tester.tap(_option(NewHarnessController.repositoryId));
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.enter);
      expect(tester.testTextInput.hasAnyClients, isTrue);
      expect(find.text('No matches'), findsNothing);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async => call.method == 'Clipboard.getData'
            ? {'text': 'https://github.com/example/moon'}
            : null,
      );
      final editor = tester.state<EditableTextState>(find.byType(EditableText));
      Actions.invoke(
        FocusManager.instance.primaryFocus!.context!,
        const PasteTextIntent(SelectionChangedCause.keyboard),
      );
      await tester.pumpAndSettle();
      expect(scenario.box.query, 'https://github.com/example/moon');
      editor.selectAll(SelectionChangedCause.keyboard);
      await tester.pump();
      final input = tester.widget<EditableText>(find.byType(EditableText));
      expect(input.controller.selection.start, 0);
      expect(input.controller.selection.end, scenario.box.query.length);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'hello',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      await tester.pump();
      expect(scenario.box.query, 'hello');
      expect(
        input.controller.value.composing,
        const TextRange(start: 0, end: 5),
      );
      expect(scenario.creates, 0);
    },
  );

  for (final shortcut in [
    LogicalKeyboardKey.enter,
    LogicalKeyboardKey.numpadEnter,
    LogicalKeyboardKey.escape,
    LogicalKeyboardKey.tab,
    LogicalKeyboardKey.arrowDown,
    LogicalKeyboardKey.arrowUp,
    LogicalKeyboardKey.pageDown,
    LogicalKeyboardKey.pageUp,
  ]) {
    testWidgets('${shortcut.keyLabel} leaves an IME candidate uncommitted', (
      tester,
    ) async {
      final scenario = await _mount(tester);
      await openLaunchRow(tester, 'agent');
      const candidate = TextEditingValue(
        text: 'cla',
        selection: TextSelection.collapsed(offset: 3),
        composing: TextRange(start: 0, end: 3),
      );
      tester.testTextInput.updateEditingValue(candidate);
      await tester.pump();
      final selected = scenario.box.selected?.id;
      await key(tester, shortcut);
      expect(scenario.box.engine, 'codex');
      expect(scenario.box.field, NewHarnessField.harness);
      expect(scenario.box.query, 'cla');
      expect(scenario.box.selected?.id, selected);
      expect(harnessChoicesActive(tester), isTrue);
      expect(scenario.creates, 0);
      expect(scenario.closes, 0);

      // Once the input method commits, Return accepts the visible choice.
      tester.testTextInput.updateEditingValue(
        candidate.copyWith(composing: TextRange.empty),
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.engine, 'claude');
      expect(harnessChoicesActive(tester), isFalse);
    });
  }

  testWidgets('typing on an idle field retains the first character', (
    tester,
  ) async {
    final scenario = await _mount(tester);
    await focusLaunchRow(tester, 'project');
    expect(harnessChoicesActive(tester), isFalse);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyR, character: 'r');
    await tester.pumpAndSettle();
    expect(scenario.box.query, 'r');
    expect(harnessChoicesActive(tester), isTrue);
    final input = tester.widget<EditableText>(find.byType(EditableText));
    expect(input.focusNode.hasFocus, isTrue);
    expect(
      input.controller.selection,
      const TextSelection.collapsed(offset: 1),
    );
    tester.testTextInput.enterText('repo');
    await tester.pump();
    await key(tester, LogicalKeyboardKey.enter);
    expect(scenario.box.project.folder, '/work/repo');
    expect(harnessChoicesActive(tester), isFalse);
    expect(scenario.creates, 0);
  });

  testWidgets('clicking the search prompt activates its choices and editor', (
    tester,
  ) async {
    final scenario = await _mount(tester);
    expect(harnessChoicesActive(tester), isTrue);
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
    expect(harnessChoicesActive(tester), isTrue);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    tester.testTextInput.enterText('repo');
    await tester.pump();
    expect(scenario.box.query, 'repo');
    await key(tester, LogicalKeyboardKey.escape);
    expect(scenario.box.query, isEmpty);
    expect(harnessChoicesActive(tester), isFalse);
    expect(scenario.closes, 0);
  });

  testWidgets('mouse scrolling can reach choices beyond the first nine', (
    tester,
  ) async {
    final scenario = await _mount(tester);
    await openLaunchRow(tester, 'agent');
    expect(scenario.box.options.length, greaterThan(9));
    final last = scenario.box.options.lastWhere((row) => !row.synthetic);
    final choices = find.byKey(const ValueKey('new-harness-choices'));
    await tester.scrollUntilVisible(
      _option(last.id),
      160,
      scrollable: find.descendant(
        of: choices,
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is Scrollable &&
              widget.axisDirection == AxisDirection.down,
        ),
      ),
    );
    expect(_option(last.id).hitTestable(), findsOneWidget);
    await tester.tap(_option(last.id));
    await tester.pump();
    expect(scenario.box.engine, last.id);
    expect(scenario.creates, 0);
  });

  for (final (door, input) in [
    (NewHarnessController.newProjectId, 'hello moon'),
    (NewHarnessController.repositoryId, 'https://github.com/example/moon.git'),
    (NewHarnessController.existingProjectId, '/work/my project'),
  ]) {
    testWidgets('$door accepts pasted input and returns focus to launch', (
      tester,
    ) async {
      final scenario = await _mount(tester);
      // Exercise remote path completion without reading the real filesystem.
      scenario.app.machineStates['m']!.localOnly = false;
      await tester.tap(_option(door));
      await tester.pump();
      expect(scenario.box.field, NewHarnessField.machine);
      await key(tester, LogicalKeyboardKey.enter);
      if (door == NewHarnessController.existingProjectId) {
        expect(find.text('Browse Folder'), findsOneWidget);
        expect(find.text('Open Folder'), findsNothing);
      }
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async =>
            call.method == 'Clipboard.getData' ? {'text': input} : null,
      );
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpAndSettle();
      expect(scenario.box.query, input);
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.field, NewHarnessField.launch);
      expect(harnessChoicesActive(tester), isFalse);
      expect(scenario.box.query, isEmpty);
      switch (door) {
        case NewHarnessController.newProjectId:
          expect(scenario.box.project.name, 'hello moon');
        case NewHarnessController.repositoryId:
          expect(scenario.box.project.repository?.name, 'moon');
        case NewHarnessController.existingProjectId:
          expect(scenario.box.project.folder, '/work/my project');
      }
      await focusLaunchRow(tester, 'agent');
      expect(scenario.box.field, NewHarnessField.harness);
      expect(scenario.creates, 0);
      expect(scenario.connections.values.expand((c) => c.starts), isEmpty);
    });
  }

  testWidgets(
    'delayed clipboard replies cannot overwrite a changed field or query',
    (tester) async {
      final scenario = await _mount(tester);
      var pending = Completer<Map<String, dynamic>>();
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async =>
            call.method == 'Clipboard.getData' ? pending.future : null,
      );
      await key(tester, LogicalKeyboardKey.keyV, ctrl: true);
      await focusLaunchRow(tester, 'agent');
      pending.complete({'text': 'stale project'});
      await tester.pump();
      expect(scenario.box.field, NewHarnessField.harness);
      expect(scenario.box.query, isEmpty);
      pending = Completer<Map<String, dynamic>>();
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await typeHarnessQuery(tester, 'claude');
      pending.complete({'text': 'stale agent'});
      await tester.pump();
      expect(scenario.box.query, 'claude');
      pending = Completer<Map<String, dynamic>>();
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pumpWidget(const SizedBox());
      pending.complete({'text': 'closed'});
      await tester.pump();
      expect(scenario.box.query, 'claude');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'clipboard errors are recoverable and empty paste preserves input',
    (tester) async {
      final scenario = await _mount(tester);
      var fail = true;
      var pasted = '';
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method != 'Clipboard.getData') return null;
          if (fail) throw PlatformException(code: 'unavailable');
          return {'text': pasted};
        },
      );
      await key(tester, LogicalKeyboardKey.keyV, ctrl: true);
      await tester.pump();
      expect(find.text('Could not paste. Try again.'), findsOneWidget);
      fail = false;
      await typeHarnessQuery(tester, 'repo');
      await key(tester, LogicalKeyboardKey.keyV, ctrl: true);
      expect(scenario.box.query, 'repo');
      pasted = '\r\nhello\nmoon';
      await key(tester, LogicalKeyboardKey.keyV, ctrl: true);
      await tester.pump();
      expect(scenario.box.query, 'repo hello moon');
    },
  );

  testWidgets('a delayed paste cannot replace a newer text selection', (
    tester,
  ) async {
    final scenario = await _mount(tester);
    await tester.tap(_option(NewHarnessController.newProjectId));
    await tester.pump();
    expect(scenario.box.field, NewHarnessField.machine);
    await key(tester, LogicalKeyboardKey.enter);
    await typeHarnessQuery(tester, 'hello moon');
    final pending = Completer<Map<String, dynamic>>();
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async =>
          call.method == 'Clipboard.getData' ? pending.future : null,
    );
    await key(tester, LogicalKeyboardKey.keyV, cmd: true);
    const selection = TextSelection(baseOffset: 0, extentOffset: 5);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(text: 'hello moon', selection: selection),
    );
    await tester.pump();
    pending.complete({'text': 'stale'});
    await tester.pump();
    expect(scenario.box.query, 'hello moon');
    expect(
      tester
          .widget<EditableText>(find.byType(EditableText))
          .controller
          .selection,
      selection,
    );
  });

  testWidgets('folder browser failure stays visible and retry restores focus', (
    tester,
  ) async {
    var attempts = 0;
    final scenario = await _mount(
      tester,
      onBrowse: (scenario) async {
        if (attempts++ == 0) throw PlatformException(code: 'unavailable');
        scenario.box.setFolder('/work/chosen folder');
      },
    );
    await tester.tap(_option(NewHarnessController.existingProjectId));
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.tap(_option(NewHarnessController.browseId));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('Could not browse folders. Try again.'), findsOneWidget);
    expect(scenario.box.project.folder, '/work/repo');
    expect(tester.testTextInput.hasAnyClients, isTrue);
    await tester.tap(_option(NewHarnessController.browseId));
    await tester.pumpAndSettle();
    expect(attempts, 2);
    expect(scenario.box.project.folder, '/work/chosen folder');
    expect(scenario.box.error, isNull);
    expect(scenario.box.field, NewHarnessField.projectMenu);
    expect(harnessChoicesActive(tester), isFalse);
    await focusLaunchRow(tester, 'agent');
    expect(scenario.box.field, NewHarnessField.harness);
    expect(scenario.creates, 0);
  });

  testWidgets('cancelled folder browser preserves the draft and input focus', (
    tester,
  ) async {
    final pending = Completer<void>();
    final scenario = await _mount(tester, onBrowse: (_) => pending.future);
    await tester.tap(_option(NewHarnessController.existingProjectId));
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.tap(_option(NewHarnessController.browseId));
    await tester.pump();
    pending.complete();
    await tester.pumpAndSettle();
    expect(scenario.box.project.folder, '/work/repo');
    expect(scenario.box.field, NewHarnessField.project);
    expect(harnessChoicesActive(tester), isTrue);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    await typeHarnessQuery(tester, '/work');
    expect(scenario.box.query, '/work');
    expect(scenario.closes, 0);
  });

  testWidgets('a folder browser failure after dismissal has no stale effect', (
    tester,
  ) async {
    final pending = Completer<void>();
    final scenario = await _mount(tester, onBrowse: (_) => pending.future);
    await tester.tap(_option(NewHarnessController.existingProjectId));
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.tap(_option(NewHarnessController.browseId));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    pending.completeError(PlatformException(code: 'unavailable'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(scenario.box.error, isNull);
    expect(scenario.box.project.folder, '/work/repo');
  });

  testWidgets('Git discovery does not flash a non-Git explanation', (
    tester,
  ) async {
    final pending = Completer<Map<String, dynamic>>();
    final scenario = await _mount(tester, gitReply: pending.future);
    expect(scenario.box.checkingGit, isTrue);
    expect(find.text('Not a Git repository'), findsNothing);
    await focusLaunchRow(tester, 'worktree');
    await tester.tap(_field('worktree'));
    await tester.pump();
    pending.complete(_git);
    await tester.pumpAndSettle();
    expect(scenario.box.checkingGit, isFalse);
    expect(find.text('[x]'), findsOneWidget);
    await tester.tap(_field('worktree'));
    await tester.pump();
    expect(scenario.box.worktree, isFalse);
    await tester.tap(_field('worktree'));
    await tester.pump();
    expect(scenario.box.worktree, isTrue);
  });

  testWidgets(
    'narrow layout Left leaves lists and prompts without a title row',
    (tester) async {
      final scenario = await _mount(tester, size: const Size(520, 520));
      await focusLaunchRow(tester, 'project');
      await tester.tap(_field('project'));
      await tester.pump();
      expect(harnessChoicesActive(tester), isTrue);
      expect(find.text('<'), findsNothing);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(harnessChoicesActive(tester), isFalse);
      await tester.tap(_field('project'));
      await tester.pump();
      await tester.tap(_option(NewHarnessController.existingProjectId));
      await tester.pump();
      expect(scenario.box.field, NewHarnessField.machine);
      await key(tester, LogicalKeyboardKey.enter);
      expect(scenario.box.field, NewHarnessField.project);
      expect(find.text('<'), findsNothing);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(scenario.box.field, NewHarnessField.projectMenu);
      expect(harnessChoicesActive(tester), isFalse);
      expect(scenario.creates, 0);
    },
  );

  testWidgets(
    'folder completion can switch machines and reverse Tab walks choices',
    (tester) async {
      final scenario = await _mount(tester);
      scenario.app.machineStates['m']!.localOnly = false;
      await tester.tap(_option(NewHarnessController.existingProjectId));
      await tester.pump();
      expect(scenario.box.field, NewHarnessField.machine);
      await key(tester, LogicalKeyboardKey.enter);
      await typeHarnessQuery(tester, '/work/my');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpAndSettle();
      final first = scenario.box.selected!.id;
      await key(tester, LogicalKeyboardKey.tab, shift: true);
      expect(scenario.box.selected!.id, isNot(first));
      await key(tester, LogicalKeyboardKey.tab);
      expect(scenario.box.selected!.id, first);
      await tester.tap(_option(NewHarnessController.changeMachineId));
      await tester.pump();
      expect(scenario.box.field, NewHarnessField.machine);
      expect(harnessChoicesActive(tester), isTrue);
      expect(scenario.creates, 0);
    },
  );

  testWidgets(
    'launch failure keeps keys active and retry starts exactly once',
    (tester) async {
      final scenario = await _mount(tester, git: false);
      final connection = scenario.connections['m']!;
      connection.failStart = true;
      await startHarness(tester);
      await tester.pumpAndSettle();
      expect(scenario.creates, 0);
      expect(scenario.box.error, contains('Fixture launch refused'));
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        'new-harness-form',
      );
      connection.failStart = false;
      await key(tester, LogicalKeyboardKey.numpadEnter);
      await tester.pumpAndSettle();
      expect(scenario.creates, 1);
      expect(connection.starts, hasLength(2));
    },
  );

  for (final (size, scale) in [
    (const Size(520, 520), 1.0),
    (const Size(600, 680), 2.0),
  ]) {
    testWidgets(
      'all fields and inline remote notes remain reachable at $size, $scale',
      (tester) async {
        final scenario = await _mount(tester, size: size, scale: scale);
        for (final name in [
          'project',
          'agent',
          'model',
          'branch',
          'approvals',
          'profile',
        ]) {
          await openLaunchRow(tester, name);
          expect(harnessChoicesActive(tester), isTrue, reason: name);
          expect(
            _option(scenario.box.selected!.id).hitTestable(),
            findsOneWidget,
            reason: name,
          );
          await key(tester, LogicalKeyboardKey.escape);
          expect(_field(name).hitTestable(), findsOneWidget);
        }
        await openLaunchRow(tester, 'start');
        expect(_field('start').hitTestable(), findsOneWidget);
        expect(scenario.creates, 0);
        expect(tester.takeException(), isNull);
      },
    );
  }
}
