import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/ssh_hosts.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// Pasting a folder path or a GitHub link into the project search
/// (docs/plans/2026-10-30-new-harness-paste-path-or-repository.md): one action
/// row, above the doors and already selected, so Enter does it.
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
  Completer<Map<String, dynamic>>? createReply;

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
            {'engine': 'codex', 'installed': true},
          ],
        };
      case 'fs_list_dir':
        final path = payload['path'] as String? ?? '/home/test';
        return {
          'path': path,
          'entries': [
            if (path == '/work')
              for (final name in ['api', 'repo']) {'name': name, 'isDir': true},
          ],
        };
      case 'agent_create':
        creates.add(Map.of(payload));
        return (createReply ??= Completer()).future;
    }
    return {};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Connection connection;
  late AppNotifier app;

  NewHarnessController search(
    String typed, {
    Map<String, String> hosts = const {},
  }) {
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/repo',
    )..useDesktopChoices(true);
    // Never this developer's own ~/.ssh/config.
    box.sshHosts = _Hosts(hosts);
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.projectMenu);
    box.setQuery(typed);
    return box;
  }

  setUp(() {
    connection = _Connection();
    app = createApp(connectionForTest: (_) => connection, connected: true);
    app.machineStates['m']!.agents = [];
    addTearDown(app.dispose);
  });

  Future<void> listed() => Future<void>.delayed(
    // A remote listing is debounced before it is asked for.
    const Duration(milliseconds: 150),
  );

  test('a project name searches as it always did', () {
    final box = search('repo');
    expect(
      box.options.where((row) => row.id.startsWith('project:paste')),
      isEmpty,
    );
  });

  test('a path to a folder opens it with one Enter', () async {
    final box = search('/work/api');
    await listed();
    expect(box.selected!.title, 'Open /work/api');
    box.accept();
    expect(box.project.folder, '/work/api');
  });

  test('a path that names no folder yet goes on in the folder browser, '
      'keeping what was typed', () async {
    final box = search('/work/ap');
    await listed();
    expect(box.selected!.title, 'Browse /work/');
    box.accept();
    expect(box.field, NewHarnessField.project);
    expect(box.query, '/work/ap');
  });

  test('a half-typed path a recent project matches keeps that project '
      'highlighted', () async {
    await app.projectHistory.select('m', '/work/team/payments-processing');
    final box = search('/work/team/payments');
    await listed();
    expect(box.selected!.project!.folder, '/work/team/payments-processing');
    expect(
      box.options.map((row) => row.id),
      isNot(contains(NewHarnessController.pasteBrowseId)),
    );
  });

  test('a browser link clones with one Enter', () {
    final box = search('https://github.com/autonomous-ai/openharness');
    expect(box.selected!.title, 'Clone autonomous-ai/openharness');
    expect(box.selected!.detail, contains('GitHub access'));
    box.accept();
    expect(box.project.repository!.slug, 'autonomous-ai/openharness');
  });

  test('an alias stays on this computer: others get the HTTPS link', () {
    final box = search('git@gh-work:org/repo.git');
    box.accept();
    expect(box.project.repository!.url, 'git@gh-work:org/repo.git');
    expect(box.cloudRepository, 'https://github.com/org/repo.git');
    expect(box.leadRepositoryUrl, 'https://github.com/org/repo.git');
  });

  test('an SSH alias says which account clones', () {
    final box = search('git@gh-work:org/repo.git');
    expect(box.selected!.title, 'Clone org/repo');
    expect(box.selected!.detail, contains('over SSH as gh-work'));
  });

  test('on this computer, an alias that is not GitHub is refused as it is '
      'typed', () async {
    app.machineStates['m']!.localOnly = true;
    final box = search(
      'git@gitlab-work:org/repo.git',
      hosts: {'gitlab-work': 'gitlab.com', 'gh-work': 'github.com'},
    );
    await Future<void>.delayed(Duration.zero);
    expect(box.selected!.title, "gitlab-work isn't a GitHub host");
    expect(box.selected!.enabled, isFalse);
    box.setQuery('git@gh-work:org/repo.git');
    await Future<void>.delayed(Duration.zero);
    expect(box.selected!.title, 'Clone org/repo');
    expect(box.selected!.enabled, isTrue);
  });

  test('a path ending in a slash browses that folder', () async {
    final box = search('/srv/');
    await listed();
    expect(box.selected!.title, 'Browse /srv/');
  });

  test('the GitHub prompt refuses the same alias', () async {
    app.machineStates['m']!.localOnly = true;
    final box = search('', hosts: {'gitlab-work': 'gitlab.com'});
    box.focusField(NewHarnessField.projectRepository);
    box.setQuery('git@gitlab-work:org/repo.git');
    await Future<void>.delayed(Duration.zero);
    expect(box.options.single.title, "gitlab-work isn't a GitHub host");
  });

  test('an alias read after the form closed changes nothing', () async {
    app.machineStates['m']!.localOnly = true;
    final answer = Completer<String?>();
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/repo',
    )..useDesktopChoices(true);
    box.sshHosts = _SlowHosts(answer.future);
    box.focusField(NewHarnessField.projectMenu);
    box.setQuery('git@gh-work:org/repo.git');
    box.dispose();
    answer.complete('gitlab.com');
    await Future<void>.delayed(Duration.zero);
  });

  test('a GitHub link that is no repository says so', () {
    final box = search('https://github.com/autonomous-ai');
    expect(box.selected!.title, 'Not a repository link');
    expect(box.selected!.enabled, isFalse);
  });

  test('owner/repo without a host is a search, never a clone', () {
    final box = search('team/api');
    expect(
      box.options.map((row) => row.title),
      isNot(contains(startsWith('Clone'))),
    );
  });

  test('another computer refused everywhere says so in one line', () async {
    final box = search('https://github.com/org/secret');
    box.accept();
    final outcome = box.create();
    await Future<void>.delayed(Duration.zero);
    connection.createReply!.complete({
      'creationId': connection.creates.single['creationId'],
      'state': 'failed',
      'failure': {
        'code': 'CLONE_FAILED',
        'detail': 'Could not access this repository.',
        'access': 'denied',
      },
    });
    expect(await outcome, NewHarnessOutcome.failed);
    expect(box.error, 'No access to org/secret on Test host.');
  });

  test('a clone through an alias is told once', () async {
    final told = <String>[];
    app.agentChangeNotice = told.add;
    final box = search('https://github.com/org/repo');
    box.accept();
    final outcome = box.create();
    await Future<void>.delayed(Duration.zero);
    connection.createReply!.complete({
      'creationId': connection.creates.single['creationId'],
      'state': 'created',
      'agent': {'id': 'a1', 'name': 'Repo', 'engine': 'codex'},
      'clonedVia': {'alias': 'gh-work'},
    });
    expect(await outcome, NewHarnessOutcome.created);
    expect(told, ['Cloned via gh-work']);
  });

  test('a clone says so while it runs', () async {
    final box = search('https://github.com/org/repo');
    box.accept();
    unawaited(box.create());
    await Future<void>.delayed(Duration.zero);
    expect(box.status, 'Cloning org/repo…');
  });
}

class _Hosts implements SshHosts {
  _Hosts(this.hosts);
  final Map<String, String> hosts;

  @override
  Future<String?> resolveHost(String alias) async => hosts[alias];

  @override
  Future<List<String>> githubAliases() async => const [];
}

class _SlowHosts extends _Hosts {
  _SlowHosts(this.answer) : super(const {});
  final Future<String?> answer;

  @override
  Future<String?> resolveHost(String alias) => answer;
}
