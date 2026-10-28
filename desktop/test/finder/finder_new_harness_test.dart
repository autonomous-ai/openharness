import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_availability.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/ws/ws_conn.dart';

import '../swarm_state_test.dart' show createApp;

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

  final creates = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => switch (type) {
    'git_project_info' => {'isGit': true},
    'dsh_list' => {'dsh': const []},
    'agent_create' => _create(payload),
    _ => {},
  };

  Map<String, dynamic> _create(Map<String, dynamic> payload) {
    creates.add(Map.of(payload));
    return {
      'creationId': payload['creationId'],
      'state': 'created',
      'agent': {
        'id': 'chat',
        'name': 'Chat',
        'engine': payload['engine'],
        'terminalAvailable': true,
        'project': {'name': 'repo', 'cwd': payload['cwd']},
      },
    };
  }
}

void main() {
  late _Connection connection;
  late AppNotifier app;

  setUp(() {
    connection = _Connection();
    app = createApp(connectionForTest: (_) => connection, connected: true);
    app.machineStates['m']!
      ..agents = []
      ..localOnly = true;
    addTearDown(app.dispose);
  });

  NewHarnessController box({String? folder = '/work/repo', String? engine}) {
    final box = NewHarnessController(
      app,
      machineId: 'm',
      harnessId: 'finder',
      engine: engine,
      folder: folder,
    );
    addTearDown(box.dispose);
    return box;
  }

  test('Finder starts a chat in the folder and opens left of it', () async {
    final finder = box();
    await pumpEventQueue();
    expect(finder.isFinder, isTrue);
    expect(finder.harnessId, 'finder');
    expect(finder.isGitProject, isFalse, reason: 'no worktree: same folder');
    finder.task = 'Explain this repo';

    expect(await finder.create(), NewHarnessOutcome.created);
    final create = connection.creates.single;
    expect(create['engine'], finder.engine);
    expect(create['cwd'], '/work/repo');
    expect(create['prompt'], 'Explain this repo');

    final tab = app.activeSwarm;
    expect(tab.panes, hasLength(2));
    final [viewer, chat] = tab.panes;
    expect(viewer.isFinder, isTrue);
    expect(viewer.finderRoot, '/work/repo');
    expect(viewer.viewsAgent('m', 'chat'), isTrue);
    expect(chat.agentId, 'chat');
    expect(tab.focusedPaneId, chat.id, reason: 'the person types in the chat');
    expect(
      tab.paneSizes['2:manual'],
      same(PaneArrangement.viewerBesideTerminal),
    );
    expect(tab.toJson()['panes'], hasLength(1), reason: 'viewers are unsaved');
  });

  test('closing the Finder closes the group: its chat too', () async {
    expect(await box().create(), NewHarnessOutcome.created);
    final viewer = app.activeSwarm.panes.firstWhere((p) => p.isFinder);
    await app.requestClosePane(viewer.id);
    await pumpEventQueue();
    expect(app.allPanes, isEmpty);
  });

  test('closing the chat closes its Finder', () async {
    expect(await box().create(), NewHarnessOutcome.created);
    final chat = app.activeSwarm.panes.firstWhere((p) => p.agentId == 'chat');
    await app.closePane(chat.id);
    expect(app.allPanes.where((p) => p.isFinder), isEmpty);
  });

  test('the chat is chosen like a harness\'s agent, with model and mode', () {
    final finder = box(engine: 'codex');
    expect(finder.engine, 'codex');
    expect(finder.launchAgentLabel, 'Finder · Codex');
    expect(finder.fields, contains(NewHarnessField.model));
    expect(finder.hasModes, isTrue);

    finder.focusField(NewHarnessField.agent);
    final ids = [for (final option in finder.options) option.id];
    expect(ids, containsAll(['claude', 'codex']));
    expect(ids, isNot(anyOf(contains('finder'), contains('terminal'))));
    finder.applyOption(finder.options.firstWhere((o) => o.id == 'claude'));
    expect(finder.engine, 'claude');
    expect(finder.isFinder, isTrue);
  });

  test('picking Finder in the Harness list keeps the agent as its chat', () {
    final picker = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/repo',
    );
    addTearDown(picker.dispose);
    picker.focusField(NewHarnessField.harness);
    picker.applyOption(picker.options.firstWhere((o) => o.id == 'finder'));
    expect(picker.isFinder, isTrue);
    expect(picker.engine, 'codex');
    expect(picker.draft.harnessId, 'finder');

    picker.focusField(NewHarnessField.harness);
    picker.applyOption(picker.options.firstWhere((o) => o.id == 'claude'));
    expect(picker.isFinder, isFalse);
  });

  test('picking Finder after a shell gives it an agent as its chat', () {
    final picker = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'terminal',
      folder: '/work/repo',
    );
    addTearDown(picker.dispose);
    expect(picker.engine, 'terminal');
    picker.focusField(NewHarnessField.harness);
    picker.applyOption(picker.options.firstWhere((o) => o.id == 'finder'));
    expect(picker.isFinder, isTrue);
    expect(picker.engine, 'opencode', reason: 'nothing remembered, no account');
  });

  test('a shell cannot be a Finder\'s chat', () {
    expect(box(engine: 'terminal').engine, isNot('terminal'));
  });

  test('a chat shown again brings its Finder back, until closed', () async {
    expect(await box().create(), NewHarnessOutcome.created);
    final tab = app.activeSwarm;
    Future<void> synced() => app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {
        'agent': {
          'id': 'chat',
          'name': 'Chat',
          'engine': 'claude',
          'terminalAvailable': true,
        },
      },
    });
    // A restart restores the chat alone: viewers are never saved.
    tab.remove(tab.panes.firstWhere((p) => p.isFinder));
    await synced();
    expect(tab.panes.first.finderRoot, '/work/repo');
    expect(tab.panes, hasLength(2));

    await app.closePane(tab.panes.first.id);
    await synced();
    expect(tab.panes.where((p) => p.isFinder), isEmpty);
  });

  test('a full tab starts the chat and says the Finder did not open', () async {
    final tab = app.activeSwarm;
    for (var i = 1; i < AppNotifier.maxPanes; i++) {
      tab.panes.add(TerminalPane(id: 100 + i, machineId: 'm', agentId: 'b$i'));
    }
    final finder = box();
    expect(await finder.create(), NewHarnessOutcome.failed);
    expect(
      finder.error,
      'Chat started. This tab is full, so the Finder could not open beside '
      'the chat.',
    );
    expect(connection.creates, hasLength(1));
    expect(tab.panes.last.agentId, 'chat');
    expect(tab.panes.where((p) => p.isFinder), isEmpty);
  });

  test('Finder needs a folder', () async {
    final finder = box(folder: null);
    await pumpEventQueue();
    expect(finder.requiredChoice?.field, NewHarnessField.projectMenu);
  });

  test('another machine offers Finder disabled and says why', () async {
    app.machineStates['m']!.localOnly = false;
    final finder = box();
    await pumpEventQueue();
    expect(await finder.create(), NewHarnessOutcome.failed);
    expect(finder.error, kFinderElsewhere);
    expect(connection.creates, isEmpty);
  });
}
