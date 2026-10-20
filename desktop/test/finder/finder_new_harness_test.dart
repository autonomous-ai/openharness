import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_availability.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
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

  NewHarnessController box({String? folder = '/work/repo'}) {
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'finder',
      folder: folder,
    );
    addTearDown(box.dispose);
    return box;
  }

  test('Finder starts a chat in the folder and opens left of it', () async {
    final finder = box();
    await pumpEventQueue();
    expect(finder.isFinder, isTrue);
    expect(finder.fields, isNot(contains(NewHarnessField.model)));
    expect(finder.isGitProject, isFalse, reason: 'no worktree: same folder');
    finder.task = 'Explain this repo';

    expect(await finder.create(), NewHarnessOutcome.created);
    final create = connection.creates.single;
    expect(create['engine'], finder.finderChat);
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

  test('closing the chat closes its Finder', () async {
    expect(await box().create(), NewHarnessOutcome.created);
    final chat = app.activeSwarm.panes.firstWhere((p) => p.agentId == 'chat');
    await app.closePane(chat.id);
    expect(app.allPanes.where((p) => p.isFinder), isEmpty);
  });

  test('a Finder is not remembered as the next box\'s agent', () async {
    expect(await box().create(), NewHarnessOutcome.created);
    await pumpEventQueue();
    expect(app.agentPreference.successfulLaunch?.engine, isNot('finder'));
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
