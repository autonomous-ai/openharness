import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/desktop_search_panel.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount, native, nativeChannel;
import 'support/launch_menu.dart' show focusLaunchRow, openLaunchRow;
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

// These scenarios run the actual workspace overlays and native method-channel
// dispatch. The only transport is this in-memory fixture: no user state or
// running daemon is involved.
class _DialogConnection extends WsConn {
  _DialogConnection(String machine)
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
  Completer<Map<String, dynamic>>? pendingStart;

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
      case 'codex_profiles_list':
        return {
          'profiles': [
            {'path': '/profiles/work', 'label': 'Work'},
          ],
        };
      case 'fs_list_dir':
        return {'path': payload['path'] ?? '/work', 'entries': []};
      case 'agent_create':
        starts.add(Map.of(payload));
        if (pendingStart case final pending?) return pending.future;
        throw const WsRequestFailure(
          responseType: 'agent_create_result',
          code: 'INVALID_ENGINE',
          detail: 'Fixture launch declined.',
        );
      default:
        return {};
    }
  }
}

class _Workspace {
  _Workspace(this.app, this.keymap, this.connections, this.input, this.folders);

  final AppNotifier app;
  final MemoryKeymap keymap;
  final Map<String, _DialogConnection> connections;
  final List<TerminalBinaryFrame> input;
  final _FolderPicker folders;

  Iterable<Map<String, dynamic>> get starts =>
      connections.values.expand((connection) => connection.starts);
}

class _FolderPicker extends FileSelectorPlatform {
  int opened = 0;
  Completer<String?>? pending;

  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) {
    opened++;
    return pending?.future ?? Future.value(null);
  }
}

final _form = find.byType(NewHarnessForm);
final _task = find.byKey(const ValueKey('new-harness-task'));
final _query = find.byKey(const ValueKey('new-harness-query'));
final _chooser = find.byKey(const ValueKey('new-harness-chooser-surface'));
final _search = find.byKey(const ValueKey('swarm-search-input'));

NewHarnessController _box(WidgetTester tester) =>
    tester.widget<NewHarnessForm>(_form).controller;

bool _ownsFocus(WidgetTester tester, Finder finder) {
  final element = tester.element(finder);
  var owned = FocusManager.instance.primaryFocus?.context == element;
  FocusManager.instance.primaryFocus?.context?.visitAncestorElements((parent) {
    if (parent == element) owned = true;
    return !owned;
  });
  return owned;
}

Future<_Workspace> _mount(
  WidgetTester tester, {
  bool nativeMenus = false,
  // Cmd-N above a terminal exercises the popup. Empty tabs now embed it.
  bool withTerminal = true,
  String? bindings,
}) async {
  final previousEntry = newHarnessOpensInBox;
  newHarnessOpensInBox = true;
  addTearDown(() => newHarnessOpensInBox = previousEntry);
  final previousFolderPicker = FileSelectorPlatform.instance;
  final folders = _FolderPicker();
  FileSelectorPlatform.instance = folders;
  addTearDown(() => FileSelectorPlatform.instance = previousFolderPicker);
  final connections = <String, _DialogConnection>{};
  final app = createApp(
    connectionForTest: (machine) =>
        connections.putIfAbsent(machine, () => _DialogConnection(machine)),
  );
  final map = MemoryKeymap();
  if (bindings != null) map.apply(bindings);
  addTearDown(app.dispose);
  addTearDown(map.dispose);
  seedMixedAgents(app);
  app.machineStates['m']!.localOnly = true;
  app.gitProjectReaderForTest = (_, _) async => {
    'isGit': true,
    'branch': 'main',
    'branches': [
      {'ref': 'refs/heads/main', 'name': 'main'},
      {'ref': 'refs/heads/feature', 'name': 'feature'},
    ],
  };
  await app.agentPreference.remember('codex');
  await app.projectHistory.select('m', '/work/openharness');
  final input = <TerminalBinaryFrame>[];
  if (withTerminal) app.adoptSessionForTest(terminal('a0', input));
  if (nativeMenus) {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      nativeChannel,
      (_) async => null,
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        nativeChannel,
        null,
      );
    });
  }
  await mount(tester, app, map, native: nativeMenus);
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });
  return _Workspace(app, map, connections, input, folders);
}

Future<void> _new(WidgetTester tester) async {
  await key(tester, LogicalKeyboardKey.keyN, cmd: true);
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pumpAndSettle();
  expect(_form, findsOneWidget);
  // These journeys start from the visible editor. The launch-entry suite
  // independently verifies the empty dialog's initial prompt focus.
  await _tabTo(tester, _task);
}

Future<void> _nativeCommand(WidgetTester tester, String command) async {
  final dispatched = native(tester, 'keymapCommand', {'command': command});
  await tester.pump();
  await dispatched;
  await tester.pump();
}

Future<void> _tabTo(WidgetTester tester, Finder target) async {
  for (var i = 0; i < 50 && !_ownsFocus(tester, target); i++) {
    await key(tester, LogicalKeyboardKey.tab);
  }
  expect(
    _ownsFocus(tester, target),
    isTrue,
    reason: 'The visible control must be reachable without the pointer.',
  );
}

const _nativeSmokeJourneys = {
  'Tab reaches the visible editor and Shift-Return never launches',
  'Tab and Shift-Tab remain inside the composer and reach controls',
  'Space opens a focused chooser without starting',
  'Return opens a focused chooser without starting',
  'agent and repo appear in order above the composer',
  'Tab leaves a chooser without applying its highlight',
  'Shift-Tab leaves a chooser without applying its highlight',
  'Escape closes only the chooser and returns to its control',
  'outside click closes only the chooser and returns to its control',
  'Cmd-P and Cmd-N replace each other without reviving cancelled edits',
  'focused Cmd-P preview control owns Return',
  'Return on Close search restores terminal focus without opening a result',
};

void main({bool nativeSmoke = false}) {
  void journey(String description, Future<void> Function(WidgetTester) body) {
    if (nativeSmoke && !_nativeSmokeJourneys.contains(description)) return;
    testWidgets(
      description,
      body,
      timeout: nativeSmoke ? const Timeout(Duration(seconds: 45)) : null,
    );
  }

  journey('Tab reaches the visible editor and Shift-Return never launches', (
    tester,
  ) async {
    final workspace = await _mount(tester, withTerminal: true);
    await _new(tester);
    expect(_ownsFocus(tester, _task), isTrue);
    await tester.enterText(_task, 'Review keyboard navigation');
    await key(tester, LogicalKeyboardKey.enter, shift: true);
    expect(workspace.starts, isEmpty);
    expect(workspace.input, isEmpty);
    expect(_form, findsOneWidget);
    expect(_ownsFocus(tester, _task), isTrue);
  });

  journey('the desktop box takes files: 📎 and drops', (tester) async {
    await _mount(tester);
    await _new(tester);
    expect(find.byKey(const ValueKey('new-harness-attach')), findsOneWidget);
    expect(find.byKey(const ValueKey('new-harness-drop')), findsOneWidget);
  });

  journey('Tab and Shift-Tab remain inside the composer and reach controls', (
    tester,
  ) async {
    await _mount(tester, withTerminal: true);
    await _new(tester);
    final seen = <String>{};
    for (var i = 0; i < 32; i++) {
      await key(tester, LogicalKeyboardKey.tab);
      expect(
        _ownsFocus(tester, _form),
        isTrue,
        reason:
            'Tab $i must stay in the dialog; focus is '
            '${FocusManager.instance.primaryFocus?.debugLabel}.',
      );
      for (final field in ['project', 'agent', 'model', 'approvals', 'start']) {
        if (_ownsFocus(
          tester,
          find.byKey(ValueKey('new-harness-field-$field')),
        )) {
          seen.add(field);
        }
      }
    }
    expect(
      seen,
      containsAll(['project', 'agent', 'model', 'approvals', 'start']),
    );
    for (var i = 0; i < 20; i++) {
      await key(tester, LogicalKeyboardKey.tab, shift: true);
      expect(
        _ownsFocus(tester, _form),
        isTrue,
        reason: 'Reverse traversal must stay in the same dialog.',
      );
    }
  });

  for (final activation in [
    LogicalKeyboardKey.space,
    LogicalKeyboardKey.enter,
  ]) {
    journey(
      '${activation == LogicalKeyboardKey.space ? 'Space' : 'Return'} opens a focused chooser without starting',
      (tester) async {
        final workspace = await _mount(tester);
        await _new(tester);
        await focusLaunchRow(tester, 'agent');
        await key(tester, activation);
        expect(_chooser, findsOneWidget);
        expect(_ownsFocus(tester, _query), isTrue);
        expect(workspace.starts, isEmpty);
      },
    );
  }

  journey('agent and repo appear in order above the composer', (tester) async {
    await _mount(tester);
    await _new(tester);
    final agent = find.byKey(const ValueKey('new-harness-field-agent'));
    final machine = find.byKey(const ValueKey('new-harness-machine'));
    final project = find.byKey(const ValueKey('new-harness-field-project'));
    expect(machine, findsNothing);
    expect(tester.getTopLeft(agent).dy, tester.getTopLeft(project).dy);
    expect(
      tester.getTopRight(agent).dx,
      lessThan(tester.getTopLeft(project).dx),
    );
    expect(
      tester.getBottomLeft(project).dy,
      lessThan(tester.getTopLeft(_task).dy),
    );
  });

  for (final reverse in [false, true]) {
    journey(
      '${reverse ? 'Shift-Tab' : 'Tab'} leaves a chooser without applying its highlight',
      (tester) async {
        final workspace = await _mount(tester);
        await _new(tester);
        await openLaunchRow(tester, 'agent');
        final box = _box(tester);
        final engine = box.engine;
        await key(tester, LogicalKeyboardKey.arrowDown);
        await key(tester, LogicalKeyboardKey.tab, shift: reverse);
        expect(_chooser, findsNothing);
        expect(box.engine, engine);
        expect(
          _ownsFocus(
            tester,
            find.byKey(
              ValueKey(
                reverse
                    ? 'new-harness-field-start'
                    : 'new-harness-field-project',
              ),
            ),
          ),
          isTrue,
        );
        expect(workspace.starts, isEmpty);
      },
    );
  }

  for (final dismissal in ['Escape', 'outside click']) {
    journey('$dismissal closes only the chooser and returns to its control', (
      tester,
    ) async {
      final workspace = await _mount(tester);
      await _new(tester);
      const task = 'Keep this task while I inspect another agent';
      await tester.enterText(_task, task);
      final original = _box(tester);
      final engine = original.engine;
      await openLaunchRow(tester, 'agent');
      await tester.enterText(_query, 'cla');
      if (dismissal == 'Escape') {
        await key(tester, LogicalKeyboardKey.escape);
      } else {
        await tester.tapAt(const Offset(10, 400));
        await tester.pump();
      }
      expect(_form, findsOneWidget);
      expect(_box(tester), same(original));
      expect(_chooser, findsNothing);
      expect(original.task, task);
      expect(original.engine, engine);
      expect(original.query, isEmpty);
      expect(tester.widget<TextField>(_task).controller!.text, task);
      expect(
        _ownsFocus(
          tester,
          find.byKey(const ValueKey('new-harness-field-agent')),
        ),
        isTrue,
        reason: 'Cancel returns to the control that opened the chooser.',
      );
      expect(workspace.starts, isEmpty);
    });
  }

  journey('accepting an agent preserves the task and does not submit it', (
    tester,
  ) async {
    final workspace = await _mount(tester);
    await _new(tester);
    await tester.enterText(_task, 'Keep the draft when changing agents');
    await openLaunchRow(tester, 'agent');
    await tester.enterText(_query, 'Claude');
    await key(tester, LogicalKeyboardKey.enter);
    expect(_chooser, findsNothing);
    expect(_box(tester).engine, 'claude');
    expect(_box(tester).task, 'Keep the draft when changing agents');
    expect(workspace.starts, isEmpty);
    expect(_form, findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    expect(
      workspace.starts,
      isEmpty,
      reason: 'A quick second Return after choosing must not submit the task.',
    );
  });

  for (final field in [
    'machine',
    'project',
    'model',
    'approvals',
    'branch',
    'profile',
  ]) {
    journey('outside-click dismissal preserves the $field chooser owner', (
      tester,
    ) async {
      final workspace = await _mount(tester);
      await _new(tester);
      await tester.enterText(_task, 'Inspect $field without losing this task');
      final box = _box(tester);
      final task = box.task;
      final opener = find.byKey(
        ValueKey(
          field == 'machine'
              ? 'new-harness-field-project'
              : 'new-harness-field-$field',
        ),
      );
      await tester.tap(opener);
      await tester.pump();
      if (field == 'machine') {
        await tester.tap(
          find.byKey(const ValueKey('new-harness-repo-machine')),
        );
        await tester.pump();
      }
      expect(_chooser, findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(
        workspace.starts,
        isEmpty,
        reason: 'The global Start chord must not accept and launch a chooser.',
      );
      await tester.tapAt(const Offset(10, 400));
      await tester.pump();
      if (field == 'machine') {
        expect(_chooser, findsOneWidget);
        await tester.tapAt(const Offset(10, 400));
        await tester.pump();
      }
      expect(_form, findsOneWidget);
      expect(_chooser, findsNothing);
      expect(_box(tester), same(box));
      expect(box.task, task);
      expect(_ownsFocus(tester, opener), isTrue);
      expect(workspace.starts, isEmpty);
    });
  }

  for (final (action, prompt) in [
    (NewHarnessController.newProjectId, NewHarnessField.projectName),
    (NewHarnessController.repositoryId, NewHarnessField.projectRepository),
  ]) {
    journey('$action uses the selected machine and Escape returns one level', (
      tester,
    ) async {
      final workspace = await _mount(tester);
      await _new(tester);
      await tester.enterText(_task, 'Keep my work while exploring projects');
      final box = _box(tester);
      final originalProject = box.project;
      final machine = box.machineId;
      await openLaunchRow(tester, 'project');
      await tester.tap(find.byKey(ValueKey('new-harness-option-$action')));
      await tester.pump();
      expect(
        box.field,
        prompt,
        reason: 'Machine was already chosen in the composer context row.',
      );
      expect(box.machineId, machine);
      expect(_chooser, findsOneWidget);
      expect(_ownsFocus(tester, _query), isTrue);
      await key(tester, LogicalKeyboardKey.escape);
      expect(box.field, NewHarnessField.projectMenu);
      expect(_chooser, findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      expect(_chooser, findsNothing);
      expect(_form, findsOneWidget);
      expect(box.project, originalProject);
      expect(box.task, 'Keep my work while exploring projects');
      expect(
        _ownsFocus(
          tester,
          find.byKey(const ValueKey('new-harness-field-project')),
        ),
        isTrue,
      );
      expect(workspace.starts, isEmpty);
    });
  }

  for (final path in <String?>[null, '/work/picked-repo']) {
    journey(
      'Open Folder goes directly to the native picker (${path == null ? 'cancel' : 'choose'})',
      (tester) async {
        final workspace = await _mount(tester);
        await _new(tester);
        await tester.enterText(
          _task,
          'Keep this message while choosing a repo',
        );
        final box = _box(tester);
        final project = box.project;
        workspace.folders.pending = Completer<String?>();
        await openLaunchRow(tester, 'project');
        await tester.tap(
          find.byKey(const ValueKey('new-harness-option-project:existing')),
        );
        await tester.pump();
        expect(workspace.folders.opened, 1);
        expect(workspace.starts, isEmpty);
        workspace.folders.pending!.complete(path);
        await tester.pumpAndSettle();
        expect(box.task, 'Keep this message while choosing a repo');
        expect(box.machineId, 'm');
        if (path == null) {
          expect(box.project, project);
          expect(box.field, NewHarnessField.projectMenu);
          expect(_chooser, findsOneWidget);
          expect(_ownsFocus(tester, _query), isTrue);
          await key(tester, LogicalKeyboardKey.escape);
        } else {
          expect(box.project.folder, path);
          expect(_chooser, findsNothing);
        }
        expect(_form, findsOneWidget);
        expect(
          _ownsFocus(
            tester,
            find.byKey(const ValueKey('new-harness-field-project')),
          ),
          isTrue,
        );
        expect(workspace.starts, isEmpty);
      },
    );
  }

  for (final dismissal in ['Escape', 'outside click']) {
    journey('composer closes on $dismissal and opens with an empty task', (
      tester,
    ) async {
      await _mount(tester);
      await _new(tester);
      const task = 'Unfinished review with a meaningful draft';
      await tester.enterText(_task, task);
      if (dismissal == 'Escape') {
        await key(tester, LogicalKeyboardKey.escape);
      } else {
        await tester.tapAt(const Offset(10, 400));
        await tester.pump();
      }
      expect(_form, findsNothing);
      await _new(tester);
      expect(_box(tester).task, isEmpty);
      expect(tester.widget<TextField>(_task).controller!.text, isEmpty);
      expect(_ownsFocus(tester, _task), isTrue);
    });
  }

  journey('Cmd-P and Cmd-N replace each other without reviving cancelled edits', (
    tester,
  ) async {
    final workspace = await _mount(tester, withTerminal: true);
    await _new(tester);
    await tester.enterText(_task, 'Resume after checking existing work');
    await openLaunchRow(tester, 'agent');
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    expect(_form, findsNothing);
    expect(_search, findsOneWidget);
    expect(_ownsFocus(tester, _search), isTrue);
    await _new(tester);
    expect(_search, findsNothing);
    expect(_chooser, findsNothing);
    expect(_box(tester).task, isEmpty);
    expect(_ownsFocus(tester, _task), isTrue);
    expect(workspace.input, isEmpty);
    expect(workspace.starts, isEmpty);
  });

  journey(
    'long mixed mouse and keyboard setup keeps the draft and dismisses one level',
    (tester) async {
      final workspace = await _mount(tester, withTerminal: true);
      await _new(tester);
      final defaults = _box(tester).draft;
      const task =
          'Explore the API first.\nKeep the UI simple — then discuss it.';
      await tester.enterText(_task, task);
      final original = _box(tester);
      final project = original.project;
      final machine = original.machineId;
      Finder field(String name) =>
          find.byKey(ValueKey('new-harness-field-$name'));

      void expectStableDraft() {
        expect(_form, findsOneWidget);
        expect(_box(tester), same(original));
        expect(original.task, task);
        expect(tester.widget<TextField>(_task).controller!.text, task);
        expect(original.project, project);
        expect(original.machineId, machine);
        expect(workspace.starts, isEmpty);
        expect(workspace.input, isEmpty);
        expect(tester.takeException(), isNull);
      }

      Future<void> open(Finder opener, {required bool keyboard}) async {
        if (keyboard) {
          await _tabTo(tester, opener);
          await key(tester, LogicalKeyboardKey.enter);
        } else {
          await tester.ensureVisible(opener);
          await tester.tap(opener);
        }
        await tester.pumpAndSettle();
        expect(_chooser, findsOneWidget);
        expect(_ownsFocus(tester, _query), isTrue);
        expectStableDraft();
      }

      Future<void> choose(
        String id,
        String query, {
        required bool keyboard,
      }) async {
        await tester.enterText(_query, query);
        await tester.pumpAndSettle();
        if (keyboard) {
          expect(original.selected?.id, id);
          await key(tester, LogicalKeyboardKey.enter);
        } else {
          final option = find.byKey(ValueKey('new-harness-option-$id'));
          await tester.ensureVisible(option);
          await tester.tap(option);
        }
        await tester.pumpAndSettle();
        expect(_chooser, findsNothing);
        expectStableDraft();
      }

      final chosenModes = <String, String>{};
      for (var round = 0; round < 4; round++) {
        final keyboard = round.isOdd;
        final engine = keyboard ? 'codex' : 'claude';
        await open(field('agent'), keyboard: keyboard);
        await choose(engine, engine, keyboard: !keyboard);
        expect(original.engine, engine);
        expect(original.mode, chosenModes[engine] ?? 'auto');
        expect(field('profile'), keyboard ? findsOneWidget : findsNothing);

        final (mode, modeLabel) = switch (round) {
          1 => ('full', 'Full access'),
          2 => ('auto', 'Auto-approve'),
          _ => ('ask', 'Ask first'),
        };
        await open(field('approvals'), keyboard: !keyboard);
        await choose(mode, modeLabel, keyboard: keyboard);
        expect(original.mode, mode);
        chosenModes[engine] = mode;

        if (engine == 'codex') {
          final profile = round == 1 ? '/profiles/work' : null;
          await open(field('profile'), keyboard: keyboard);
          await choose(
            profile == null ? 'profile:default' : 'profile:$profile',
            profile == null ? 'Default' : 'Work',
            keyboard: !keyboard,
          );
          expect(original.draft.profile?.path, profile);
        }

        final model = original.modelLabel;
        await open(field('model'), keyboard: !keyboard);
        await key(tester, LogicalKeyboardKey.arrowDown);
        await tester.tapAt(const Offset(10, 400));
        await tester.pumpAndSettle();
        expect(_chooser, findsNothing);
        expect(_ownsFocus(tester, field('model')), isTrue);
        expect(original.modelLabel, model);
        expectStableDraft();

        final worktree = original.worktree;
        if (keyboard) {
          await _tabTo(tester, field('worktree'));
          await key(tester, LogicalKeyboardKey.space);
        } else {
          await tester.tap(field('worktree'));
        }
        await tester.pumpAndSettle();
        expect(original.worktree, !worktree);
        expect(find.text('Worktree'), findsOneWidget);
        final branch = original.worktree ? 'feature' : 'main';
        await open(field('branch'), keyboard: keyboard);
        await choose('refs/heads/$branch', branch, keyboard: !keyboard);
        expect(original.branchRef, 'refs/heads/$branch');

        await open(field('project'), keyboard: !keyboard);
        final newFolder = find.byKey(
          const ValueKey('new-harness-option-project:name'),
        );
        await tester.ensureVisible(newFolder);
        await tester.tap(newFolder);
        await tester.pumpAndSettle();
        expect(original.field, NewHarnessField.projectName);
        final folderDraft = 'scratch-round-$round';
        await tester.enterText(_query, folderDraft);
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(_query).controller!.text, folderDraft);
        expect(_chooser, findsOneWidget);
        expectStableDraft();
        await tester.tap(
          find.byKey(const ValueKey('new-harness-chooser-back')),
        );
        await tester.pumpAndSettle();
        expect(original.field, NewHarnessField.projectMenu);
        expect(_chooser, findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(_chooser, findsNothing);
        expect(_ownsFocus(tester, field('project')), isTrue);
        expectStableDraft();

        final machineControl = find.byKey(
          const ValueKey('new-harness-field-project'),
        );
        await open(machineControl, keyboard: keyboard);
        await tester.tap(
          find.byKey(const ValueKey('new-harness-repo-machine')),
        );
        await tester.pumpAndSettle();
        expect(original.field, NewHarnessField.projectMenu);
        expect(
          find.byKey(const ValueKey('new-harness-machine-option-m')),
          findsOneWidget,
        );
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(_chooser, findsOneWidget);
        await tester.tapAt(const Offset(10, 400));
        await tester.pumpAndSettle();
        expect(_chooser, findsNothing);
        expect(_ownsFocus(tester, machineControl), isTrue);
        expectStableDraft();
      }

      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.pumpAndSettle();
      expect(_form, findsNothing);
      expect(_ownsFocus(tester, _search), isTrue);
      await tester.enterText(_search, 'review');
      await key(tester, LogicalKeyboardKey.arrowDown);
      await _new(tester);
      final restored = _box(tester).draft;
      expect(restored.task, isEmpty);
      expect(restored.engine, defaults.engine);
      expect(restored.machineId, defaults.machineId);
      expect(restored.project, defaults.project);
      expect(restored.permissionMode, defaults.permissionMode);
      expect(restored.profile?.path, defaults.profile?.path);
      expect(restored.worktree, defaults.worktree);
      expect(restored.branchRef, defaults.branchRef);
      expect(_ownsFocus(tester, _task), isTrue);
      expect(_chooser, findsNothing);
      expect(_search, findsNothing);
      expect(workspace.starts, isEmpty);
      expect(workspace.input, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  journey('remapped chooser keys and native cancel have the same hierarchy', (
    tester,
  ) async {
    final workspace = await _mount(
      tester,
      nativeMenus: true,
      bindings: '''{"bindings":[
        {"keys":"ctrl+j","command":"picker.next","when":"picker"},
        {"keys":"ctrl+k","command":"picker.previous","when":"picker"},
        {"keys":"ctrl+g","command":"picker.cancel","when":"picker"}
      ]}''',
    );
    await _new(tester);
    await tester.enterText(_task, 'Native menu and keyboard should agree');
    await openLaunchRow(tester, 'agent');
    final box = _box(tester);
    final initial = box.cursor;
    await key(tester, LogicalKeyboardKey.keyJ, ctrl: true);
    expect(box.cursor, isNot(initial));
    await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
    expect(box.cursor, initial);
    await _nativeCommand(tester, 'picker.cancel');
    expect(_chooser, findsNothing);
    expect(_form, findsOneWidget);
    expect(box.task, 'Native menu and keyboard should agree');
    await key(tester, LogicalKeyboardKey.keyG, ctrl: true);
    expect(_form, findsNothing);
    expect(workspace.starts, isEmpty);
  });

  for (final (command, field) in [
    ('creation.agent', NewHarnessField.harness),
    ('creation.project', NewHarnessField.projectMenu),
    ('creation.project_machine', NewHarnessField.projectMenu),
  ]) {
    journey('advertised $command remap opens its chooser from the task', (
      tester,
    ) async {
      final workspace = await _mount(
        tester,
        bindings:
            '{"bindings":[{"keys":"ctrl+alt+g","command":"$command","when":"picker"}]}',
      );
      await _new(tester);
      await tester.enterText(_task, 'Direct keyboard access to configuration');
      await key(tester, LogicalKeyboardKey.keyG, ctrl: true, alt: true);
      await tester.pumpAndSettle();
      expect(_chooser, findsOneWidget);
      expect(_box(tester).field, field);
      if (command == 'creation.project_machine') {
        expect(
          find.byKey(const ValueKey('new-harness-machine-option-m')),
          findsOneWidget,
        );
      } else {
        expect(_ownsFocus(tester, _query), isTrue);
      }
      expect(_box(tester).task, 'Direct keyboard access to configuration');
      expect(workspace.starts, isEmpty);
    });
  }

  journey('advertised creation.task remap returns from a chooser to the task', (
    tester,
  ) async {
    await _mount(
      tester,
      bindings: '{"bindings":[{"keys":"ctrl+alt+t","command":"creation.task","when":"picker"}]}',
    );
    await _new(tester);
    await tester.enterText(_task, 'Return here without cycling every control');
    await openLaunchRow(tester, 'agent');
    await key(tester, LogicalKeyboardKey.keyT, ctrl: true, alt: true);
    expect(_chooser, findsNothing);
    expect(_ownsFocus(tester, _task), isTrue);
    expect(_box(tester).task, 'Return here without cycling every control');
  });

  journey('native creation command uses the same focused form action', (
    tester,
  ) async {
    await _mount(tester, nativeMenus: true);
    await _new(tester);
    await _nativeCommand(tester, 'creation.project_machine');
    expect(_chooser, findsOneWidget);
    expect(_box(tester).field, NewHarnessField.projectMenu);
    expect(
      find.byKey(const ValueKey('new-harness-machine-option-m')),
      findsOneWidget,
    );
  });

  for (final (command, field) in [
    ('creation.project_new', NewHarnessField.projectName),
    ('creation.project_existing', NewHarnessField.projectMenu),
    ('creation.project_repository', NewHarnessField.projectRepository),
  ]) {
    journey('$command remap works in the project keymap context', (
      tester,
    ) async {
      final workspace = await _mount(
        tester,
        bindings:
            '{"bindings":[{"keys":"ctrl+alt+b","command":"$command","when":"project"}]}',
      );
      await _new(tester);
      await openLaunchRow(tester, 'project');
      final machine = _box(tester).machineId;
      await key(tester, LogicalKeyboardKey.keyB, ctrl: true, alt: true);
      await tester.pumpAndSettle();
      expect(_chooser, findsOneWidget);
      expect(_box(tester).field, field);
      expect(_box(tester).machineId, machine);
      expect(_ownsFocus(tester, _query), isTrue);
      expect(
        workspace.folders.opened,
        command == 'creation.project_existing' ? 1 : 0,
      );
      expect(workspace.starts, isEmpty);
    });
  }

  journey(
    'legacy options command opens Model and recent-project shortcuts preserve the task',
    (tester) async {
      final workspace = await _mount(
        tester,
        bindings: '''{"bindings":[
      {"keys":"ctrl+alt+o","command":"creation.options","when":"picker"},
      {"keys":"ctrl+alt+1","command":"creation.project_recent_1","when":"project"}
    ]}''',
      );
      await _new(tester);
      await tester.enterText(
        _task,
        'Keep task while applying direct shortcuts',
      );
      await key(tester, LogicalKeyboardKey.keyO, ctrl: true, alt: true);
      expect(_box(tester).field, NewHarnessField.model);
      expect(_chooser, findsOneWidget);
      expect(_ownsFocus(tester, _query), isTrue);
      expect(
        find.byKey(const ValueKey('new-harness-field-profile')),
        findsOneWidget,
      );
      await openLaunchRow(tester, 'project');
      final expected = _box(tester).options
          .firstWhere(
            (option) => !option.synthetic && option.project?.folder != null,
          )
          .project;
      await key(tester, LogicalKeyboardKey.digit1, ctrl: true, alt: true);
      expect(_chooser, findsNothing);
      expect(_box(tester).project, expected);
      expect(_box(tester).task, 'Keep task while applying direct shortcuts');
      expect(workspace.starts, isEmpty);
    },
  );

  journey(
    'machine shortcut from a project prompt keeps its nested return path',
    (tester) async {
      await _mount(
        tester,
        bindings: '''{"bindings":[
      {"keys":"ctrl+alt+m","command":"creation.project_machine","when":"picker"}
    ]}''',
      );
      await _new(tester);
      await openLaunchRow(tester, 'project');
      await tester.tap(
        find.byKey(const ValueKey('new-harness-option-project:name')),
      );
      await tester.pump();
      await tester.enterText(_query, 'keyboard-plans');
      await key(tester, LogicalKeyboardKey.keyM, ctrl: true, alt: true);
      expect(_box(tester).field, NewHarnessField.machine);
      await key(tester, LogicalKeyboardKey.escape);
      expect(_box(tester).field, NewHarnessField.projectName);
      expect(_box(tester).query, 'keyboard-plans');
      expect(_ownsFocus(tester, _query), isTrue);
    },
  );

  journey('default Control-O browses the current machine without launching', (
    tester,
  ) async {
    final app = createApp(connectionForTest: _DialogConnection.new);
    seedMixedAgents(app);
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    final map = MemoryKeymap();
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/openharness',
    );
    var browses = 0;
    addTearDown(app.dispose);
    addTearDown(map.dispose);
    addTearDown(box.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: KeymapProvider(
          keymap: map,
          child: KeymapHost(
            keymap: map,
            enabled: () => true,
            actions: const {},
            child: NewHarnessForm(
              controller: box,
              desktop: true,
              onClose: () {},
              onCreated: () {},
              onBrowse: () => browses++,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(_task, 'Browse without losing this task');
    await key(tester, LogicalKeyboardKey.keyO, ctrl: true);
    expect(browses, 1);
    expect(box.field, NewHarnessField.projectMenu);
    expect(_chooser, findsOneWidget);
    expect(_ownsFocus(tester, _query), isTrue);
    expect(box.task, 'Browse without losing this task');
    await key(tester, LogicalKeyboardKey.keyO, ctrl: true);
    expect(browses, 2);
    await tester.pumpWidget(const SizedBox());
  });

  for (final (door, field, draft) in [
    ('project:name', NewHarnessField.projectName, 'keyboard-plans'),
    ('project:repository', NewHarnessField.projectRepository, 'openai/codex'),
  ]) {
    for (final machine in ['m', 'studio']) {
      journey(
        '$field draft survives selecting ${machine == 'm' ? 'the same' : 'another'} machine where portable',
        (tester) async {
          final workspace = await _mount(
            tester,
            bindings: '{"bindings":[{"keys":"ctrl+alt+m","command":"creation.project_machine","when":"picker"}]}',
          );
          await _new(tester);
          await tester.enterText(
            _task,
            'Keep this task throughout the machine change',
          );
          await openLaunchRow(tester, 'project');
          await tester.tap(find.byKey(ValueKey('new-harness-option-$door')));
          await tester.pump();
          await tester.enterText(_query, draft);
          await key(tester, LogicalKeyboardKey.keyM, ctrl: true, alt: true);
          expect(_box(tester).field, NewHarnessField.machine);
          await tester.tap(find.byKey(ValueKey('new-harness-option-$machine')));
          await tester.pumpAndSettle();
          expect(_box(tester).machineId, machine);
          expect(_box(tester).field, field);
          expect(
            _box(tester).query,
            machine != 'm' && field == NewHarnessField.project ? '' : draft,
          );
          expect(_chooser, findsOneWidget);
          expect(_ownsFocus(tester, _query), isTrue);
          expect(
            _box(tester).task,
            'Keep this task throughout the machine change',
          );
          expect(workspace.starts, isEmpty);
        },
      );
    }
  }

  journey(
    'cancelling the remote folder browser preserves the repo and message',
    (tester) async {
      final workspace = await _mount(tester);
      await _new(tester);
      final box = _box(tester);
      final originalProject = box.project;
      await tester.enterText(
        _task,
        'Keep this message while browsing remotely',
      );
      workspace.app.machineStates['m']!.localOnly = false;
      await openLaunchRow(tester, 'project');
      await tester.tap(
        find.byKey(const ValueKey('new-harness-option-project:existing')),
      );
      await tester.pumpAndSettle();
      final browser = find.byKey(
        const ValueKey('desktop-remote-folder-dialog'),
      );
      expect(browser, findsOneWidget);
      expect(_form, findsNothing);
      await tester.enterText(
        find.descendant(of: browser, matching: find.byType(TextField)),
        '/work/review-draft',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(_form, findsOneWidget);
      expect(box.field, NewHarnessField.projectMenu);
      expect(box.project, originalProject);
      expect(box.task, 'Keep this message while browsing remotely');
      expect(_ownsFocus(tester, _query), isTrue);
      expect(workspace.folders.opened, 0);
      expect(workspace.starts, isEmpty);
    },
  );

  for (final owner in ['task', 'chooser']) {
    journey('IME owns editing, dismissal, and native commands in the $owner', (
      tester,
    ) async {
      final workspace = await _mount(tester, nativeMenus: true);
      await _new(tester);
      if (owner == 'chooser') await openLaunchRow(tester, 'agent');
      final editor = owner == 'task' ? _task : _query;
      await tester.tap(editor);
      const composing = TextEditingValue(
        text: '開発',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 0, end: 2),
      );
      tester.testTextInput.updateEditingValue(composing);
      await tester.pump();
      final original = _box(tester);
      for (final pressed in [
        LogicalKeyboardKey.escape,
        LogicalKeyboardKey.enter,
        LogicalKeyboardKey.arrowDown,
        LogicalKeyboardKey.tab,
      ]) {
        await key(tester, pressed);
      }
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      for (final command in [
        'picker.cancel',
        'picker.add_here',
        'harnesses.list',
        'creation.agent',
        'creation.project_machine',
        'creation.project_new',
        'creation.task',
        'creation.options',
      ]) {
        await _nativeCommand(tester, command);
      }
      expect(_form, findsOneWidget);
      expect(_box(tester), same(original));
      expect(tester.widget<TextField>(editor).controller!.value, composing);
      expect(_ownsFocus(tester, editor), isTrue);
      expect(_search, findsNothing);
      expect(workspace.starts, isEmpty);
      if (owner == 'chooser') expect(_chooser, findsOneWidget);
    });
  }

  journey(
    'pending Start rejects duplicate keyboard, native, and mouse starts',
    (tester) async {
      final workspace = await _mount(tester, nativeMenus: true);
      await _new(tester);
      await tester.enterText(_task, 'Start exactly once');
      // Local-only identity supplies the default machine, but creation must
      // use the fixture transport rather than the local folder preparer.
      workspace.app.machineStates['m']!.localOnly = false;
      final connection = workspace.connections['m']!;
      final reply = connection.pendingStart = Completer<Map<String, dynamic>>();
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      final box = _box(tester);
      expect(box.busy, isTrue);
      expect(workspace.starts, hasLength(1));
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await _nativeCommand(tester, 'picker.add_here');
      await _nativeCommand(tester, 'creation.project_machine');
      expect(_chooser, findsNothing);
      await tester.tap(find.byKey(const ValueKey('new-harness-field-start')));
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      expect(workspace.starts, hasLength(1));
      expect(workspace.starts.single['prompt'], 'Start exactly once');
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.tapAt(const Offset(10, 400));
      await tester.pump();
      expect(_form, findsOneWidget);
      expect(_search, findsNothing);
      reply.completeError(
        const WsRequestFailure(
          responseType: 'agent_create_result',
          code: 'INVALID_ENGINE',
          detail: 'Fixture launch declined.',
        ),
      );
      await tester.pumpAndSettle();
      expect(box.busy, isFalse);
      expect(box.task, 'Start exactly once');
      expect(box.error, isNotEmpty);
      expect(_form, findsOneWidget);
    },
  );

  journey('Cmd-P forward and reverse Tab cannot focus the dimmed workspace', (
    tester,
  ) async {
    await _mount(tester, withTerminal: true);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    final panel = find.byType(DesktopSearchPanel);
    for (final reverse in [false, true]) {
      for (var i = 0; i < 28; i++) {
        await key(tester, LogicalKeyboardKey.tab, shift: reverse);
        expect(
          _ownsFocus(tester, panel),
          isTrue,
          reason: 'Search traversal must remain in the active dialog.',
        );
      }
    }
  });

  for (final nativeAccept in [false, true]) {
    journey(
      'focused Cmd-P preview control owns ${nativeAccept ? 'native accept' : 'Return'}',
      (tester) async {
        final workspace = await _mount(
          tester,
          nativeMenus: nativeAccept,
          withTerminal: true,
        );
        await key(tester, LogicalKeyboardKey.keyP, cmd: true);
        await tester.enterText(_search, 'login');
        await tester.pump();
        final panel = tester.widget<DesktopSearchPanel>(
          find.byType(DesktopSearchPanel),
        );
        final selected = panel.search.selected?.id;
        final previewVisible = panel.search.previewVisible;
        await _tabTo(
          tester,
          find.byKey(const ValueKey('search-toggle-preview')),
        );
        if (nativeAccept) {
          await _nativeCommand(tester, 'picker.accept');
        } else {
          await key(tester, LogicalKeyboardKey.enter);
        }
        expect(
          _search,
          findsOneWidget,
          reason: 'A toolbar control must not open the highlighted harness.',
        );
        expect(panel.search.previewVisible, !previewVisible);
        expect(panel.search.selected?.id, selected);
        expect(panel.editing.text, 'login');
        expect(workspace.input, isEmpty);
      },
    );
  }

  journey(
    'Return on Close search restores terminal focus without opening a result',
    (tester) async {
      final workspace = await _mount(tester, withTerminal: true);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.enterText(_search, 'login');
      await _tabTo(tester, find.byTooltip('Close search'));
      await key(tester, LogicalKeyboardKey.enter);
      expect(_search, findsNothing);
      expect(
        tester
            .widget<TerminalView>(find.byType(TerminalView))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      expect(workspace.app.panes, hasLength(1));
      expect(workspace.input, isEmpty);
    },
  );

  for (final dismissal in ['Escape', 'outside click']) {
    journey('Cmd-P returns focus to the terminal after $dismissal', (
      tester,
    ) async {
      final workspace = await _mount(tester, withTerminal: true);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      expect(_search, findsOneWidget);
      await tester.enterText(_search, 'login');
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(find.byType(SwarmSearchResults), findsOneWidget);
      expect(workspace.input, isEmpty);
      if (dismissal == 'Escape') {
        await key(tester, LogicalKeyboardKey.escape);
      } else {
        await tester.tapAt(const Offset(10, 400));
        await tester.pump();
      }
      expect(_search, findsNothing);
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      expect(view.focusNode!.hasFocus, isTrue);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(workspace.input.single.bytes, [27, 91, 68]);
    });
  }
}
