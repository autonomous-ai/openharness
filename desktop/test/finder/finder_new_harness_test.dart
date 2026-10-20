import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_availability.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
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

  final asked = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    asked.add(type);
    return switch (type) {
      'git_project_info' => {'isGit': false},
      'dsh_list' => {'dsh': const []},
      _ => {},
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

  test('Finder asks for nothing an agent needs, and opens a tile', () async {
    final finder = box();
    await pumpEventQueue();
    expect(finder.isFinder, isTrue);
    expect(finder.fields, isNot(contains(NewHarnessField.model)));
    expect(finder.hasModes, isFalse);
    expect(finder.isGitProject, isFalse);

    expect(await finder.create(), NewHarnessOutcome.created);
    final pane = app.activeSwarm.panes.single;
    expect(pane.isFinder, isTrue);
    expect(pane.finderRoot, '/work/repo');
    expect(app.activeSwarm.focusedPaneId, pane.id);
    expect(connection.asked, isNot(contains('agent_create')));
  });

  test('Finder needs an existing folder', () async {
    final finder = box(folder: null);
    await pumpEventQueue();
    expect(finder.requiredChoice?.field, NewHarnessField.projectMenu);
    expect(await finder.create(), NewHarnessOutcome.failed);
    expect(app.activeSwarm.panes, isEmpty);
  });

  test('another machine offers Finder disabled and says why', () async {
    app.machineStates['m']!.localOnly = false;
    final finder = box();
    await pumpEventQueue();
    expect(await finder.create(), NewHarnessOutcome.failed);
    expect(finder.error, kFinderElsewhere);
    expect(app.activeSwarm.panes, isEmpty);
  });

  test('a Finder tile opens in a new tab and is never saved', () {
    final first = app.activeSwarm;
    // An empty tab would be reused as the new one; this one is in use.
    expect(app.openFinderPane('m', '/work'), isNull);
    expect(
      app.openFinderPane('m', '/work/repo', placement: HarnessPlacement.newTab),
      isNull,
    );
    expect(app.activeSwarm, isNot(same(first)));
    expect(app.activeSwarm.panes.single.finderRoot, '/work/repo');
    expect(first.panes.single.finderRoot, '/work');
    expect(app.activeSwarm.toJson()['panes'], isEmpty);
  });
}
