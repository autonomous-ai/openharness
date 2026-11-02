import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
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

  /// What this computer answers for `~/harnesses`, when it is asked.
  Map<String, dynamic> harnesses = const {'error': 'NOT_FOUND'};
  Completer<void>? harnessesHeld;

  /// What this computer answers for any other folder asked about by name.
  final folders = <String, Map<String, dynamic>>{};
  final asked = <String>[];

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
        asked.add(path);
        if (folders[path] case final answer?) {
          if (answer['error'] case final String code) {
            throw WsRequestFailure(
              responseType: 'fs_list_dir_result',
              code: code,
            );
          }
          return answer;
        }
        if (path == '/home/test/harnesses') {
          await harnessesHeld?.future;
          // A refusal arrives as WsConn throws it, never as a value.
          if (harnesses['error'] case final String code) {
            throw WsRequestFailure(
              responseType: 'fs_list_dir_result',
              code: code,
            );
          }
          return harnesses;
        }
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

  group('a hidden folder, which its parent does not list', () {
    const missing = {'error': 'NOT_FOUND'};

    test('opens on another computer when it is there', () async {
      connection.folders['/srv/.config'] = {
        'path': '/srv/.config',
        'entries': const [],
      };
      final box = search('/srv/.config');
      await listed();
      expect(box.selected!.title, 'Open /srv/.config');
      expect(box.selected!.project!.folder, '/srv/.config');
    });

    test('still browses when it is not', () async {
      connection.folders['/srv/.config'] = missing;
      final box = search('/srv/.config');
      await listed();
      expect(box.selected!.title, 'Browse /srv/');
    });

    test('a file by that name is no folder', () async {
      connection.folders['/srv/.env'] = {'error': 'NOT_A_DIRECTORY'};
      final box = search('/srv/.env');
      await listed();
      expect(box.selected!.title, 'Browse /srv/');
    });

    test('. and .. are not hidden folders', () async {
      final box = search('/srv/..');
      await listed();
      expect(box.selected!.title, 'Browse /srv/');
      expect(connection.asked, isNot(contains('/srv/..')));
    });

    test('is asked about once the typing pauses, once', () async {
      connection.folders['/srv/.config'] = {
        'path': '/srv/.config',
        'entries': const [],
      };
      final box = search('/srv/.c');
      box.setQuery('/srv/.config');
      await listed();
      expect(connection.asked, isNot(contains('/srv/.c')));
      box.setQuery('/srv/.config');
      await listed();
      expect(
        connection.asked.where((path) => path == '/srv/.config'),
        hasLength(1),
      );
    });

    test('an answer after the form closed changes nothing', () async {
      connection.folders['/srv/.config'] = {
        'path': '/srv/.config',
        'entries': const [],
      };
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/repo',
      )..useDesktopChoices(true);
      box.focusField(NewHarnessField.projectMenu);
      box.setQuery('/srv/.config');
      box.dispose();
      await listed();
      expect(connection.asked, isNot(contains('/srv/.config')));
    });

    test('another computer does not inherit the answer', () async {
      connection.folders['/srv/.config'] = {
        'path': '/srv/.config',
        'entries': const [],
      };
      final box = search('/srv/.config');
      await listed();
      expect(box.selected!.title, 'Open /srv/.config');
      connection.folders['/srv/.config'] = missing;
      const studio = Machine(
        machineId: 'n',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
      );
      app.machines = [...app.machines, studio];
      app.machineStates['n'] = MachineState(studio)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [];
      box.focusField(NewHarnessField.machine);
      box.setQuery('Studio');
      box.accept();
      box.focusField(NewHarnessField.projectMenu);
      box.setQuery('/srv/.config');
      expect(box.selected!.title, 'Browse /srv/');
    });
  });

  test(
    'an alias ssh cannot read is offered, and its launch checks again',
    () async {
      app.machineStates['m']!.localOnly = true;
      final answer = Completer<String?>();
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/repo',
      )..useDesktopChoices(true);
      box.sshHosts = _SlowHosts(answer.future);
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      box.setQuery('git@gh-work:org/repo.git');
      answer.complete(null);
      await Future<void>.delayed(Duration.zero);
      expect(box.selected!.title, 'Clone org/repo');
      expect(box.selected!.enabled, isTrue);
    },
  );

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

  group('Cloned via is told only for the clone of that creation', () {
    late AppNotifier local;
    late List<String> told;
    String? clonedVia;

    setUp(() {
      told = [];
      clonedVia = null;
      local = createApp(
        connectionForTest: (_) => connection,
        connected: true,
        prepareFolder: (_) async {
          if (clonedVia case final alias?) {
            local.rememberClonedVia('/home/test/harnesses/repo', alias);
          }
          return '/home/test/harnesses/repo';
        },
      );
      addTearDown(local.dispose);
      local.machineStates['m']!
        ..agents = []
        ..localOnly = true;
      local.agentChangeNotice = told.add;
    });

    Future<NewHarnessOutcome> start(Map<String, dynamic> reply) async {
      connection.createReply = null;
      connection.creates.clear();
      final box = NewHarnessController(
        local,
        machineId: 'm',
        engine: 'codex',
        folder: '/home/test',
        home: '/home/test',
      )..useDesktopChoices(true);
      box.sshHosts = _Hosts(const {});
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      box.setQuery('https://github.com/org/repo');
      box.accept();
      final outcome = box.create();
      await pumpEventQueue();
      connection.createReply!.complete({
        'creationId': connection.creates.single['creationId'],
        ...reply,
      });
      return outcome;
    }

    const created = {
      'state': 'created',
      'agent': {'id': 'a1', 'name': 'Repo', 'engine': 'codex'},
    };
    const failed = {
      'state': 'failed',
      'failure': {'code': 'INVALID_CWD', 'detail': 'No.'},
    };

    test('the clone that started the harness is told', () async {
      clonedVia = 'gh-work';
      expect(await start(created), NewHarnessOutcome.created);
      expect(told, ['Cloned via gh-work']);
    });

    test('a later start in that folder is not told', () async {
      clonedVia = 'gh-work';
      expect(await start(failed), NewHarnessOutcome.failed);
      clonedVia = null;
      expect(await start(created), NewHarnessOutcome.created);
      expect(told, isEmpty);
    });
  });

  test('a clone says so while it runs', () async {
    final box = search('https://github.com/org/repo');
    box.accept();
    unawaited(box.create());
    await Future<void>.delayed(Duration.zero);
    expect(box.status, 'Cloning org/repo…');
  });

  group('a terminal opens in a folder and clones nothing', () {
    NewHarnessController terminal(String typed) {
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'terminal',
        folder: '/work/repo',
      )..useDesktopChoices(true);
      box.sshHosts = _Hosts(const {});
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      box.setQuery(typed);
      return box;
    }

    test('a pasted link is refused, and says why', () {
      final box = terminal('https://github.com/org/repo');
      final row = box.options.first;
      expect(row.id, NewHarnessController.pasteInvalidId);
      expect(row.enabled, isFalse);
      expect(row.title, "A terminal can't clone");
      expect(row.detail, 'Choose an agent to clone org/repo');
      box.accept();
      expect(box.error, 'Choose an agent to clone org/repo.');
      expect(box.requiredChoice, isNull);
    });

    test('a pasted path still opens', () async {
      final box = terminal('/work');
      await listed();
      expect(box.options.first.id, isNot(NewHarnessController.pasteInvalidId));
      expect(box.options.first.enabled, isTrue);
    });

    test('changing to Terminal after choosing a clone asks again', () async {
      final box = search('https://github.com/org/repo');
      box.accept();
      expect(box.requiredChoice, isNull);
      box.focusField(NewHarnessField.harness);
      box.setQuery('Terminal');
      box.accept();
      expect(box.isTerminal, isTrue);
      expect(box.requiredChoice?.field, NewHarnessField.projectMenu);
      expect(
        box.requiredChoice?.message,
        "A terminal can't clone. Choose a folder or an agent.",
      );
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(connection.creates, isEmpty);
    });
  });

  group('the line only says Cloning when a clone will run', () {
    Future<List<String?>> linesWhileCreating(NewHarnessController box) async {
      final lines = <String?>[];
      box.addListener(() => lines.add(box.status));
      box.accept();
      unawaited(box.create());
      await Future<void>.delayed(Duration.zero);
      return lines;
    }

    test(
      'a checkout already there is used, so it never says Cloning',
      () async {
        connection.harnesses = {
          'path': '/home/test/harnesses',
          'entries': [
            {'name': 'repo', 'isDir': true},
          ],
        };
        final box = search('https://github.com/org/repo');
        final lines = await linesWhileCreating(box);
        expect(box.status, 'Starting harness…');
        expect(lines, isNot(contains('Cloning org/repo…')));
      },
    );

    test('the same name in another case may be the same folder', () async {
      connection.harnesses = {
        'path': '/home/test/harnesses',
        'entries': [
          {'name': 'Repo', 'isDir': true},
        ],
      };
      final box = search('https://github.com/org/repo');
      final lines = await linesWhileCreating(box);
      expect(lines, isNot(contains('Cloning org/repo…')));
    });

    test('a Harness OS checkout in ~/projects is used, not cloned', () async {
      connection.folders['/home/test/projects'] = {
        'path': '/home/test/projects',
        'entries': [
          {'name': 'repo', 'isDir': true},
        ],
      };
      final box = search('https://github.com/org/repo');
      final lines = await linesWhileCreating(box);
      expect(lines, isNot(contains('Cloning org/repo…')));
    });

    test('a ~/projects that cannot be read cannot say', () async {
      connection.folders['/home/test/projects'] = {
        'error': 'PERMISSION_DENIED',
      };
      final box = search('https://github.com/org/repo');
      final lines = await linesWhileCreating(box);
      expect(lines, isNot(contains('Cloning org/repo…')));
    });

    test('another folder in ~/harnesses does not stop it saying so', () async {
      connection.harnesses = {
        'path': '/home/test/harnesses',
        'entries': [
          {'name': 'other', 'isDir': true},
        ],
      };
      final box = search('https://github.com/org/repo');
      await linesWhileCreating(box);
      expect(box.status, 'Cloning org/repo…');
    });

    test('a first clone on a computer with no ~/harnesses says so', () async {
      final box = search('https://github.com/org/repo');
      await linesWhileCreating(box);
      expect(box.status, 'Cloning org/repo…');
    });

    test('a computer that cannot say is not told a clone is running', () async {
      connection.harnesses = {'error': 'UNAVAILABLE'};
      final box = search('https://github.com/org/repo');
      final lines = await linesWhileCreating(box);
      expect(box.status, 'Starting harness…');
      expect(lines, isNot(contains('Cloning org/repo…')));
    });

    test(
      'a listing cut short that does not show the name cannot say',
      () async {
        connection.harnesses = {
          'path': '/home/test/harnesses',
          'entries': const <Object>[],
          'truncated': true,
        };
        final box = search('https://github.com/org/repo');
        await linesWhileCreating(box);
        expect(box.status, 'Starting harness…');
      },
    );

    test('a hidden folder is never listed, so its name cannot say', () async {
      connection.harnesses = {
        'path': '/home/test/harnesses',
        'entries': const <Object>[],
      };
      final box = search('https://github.com/org/.github');
      await linesWhileCreating(box);
      expect(box.status, 'Starting harness…');
    });

    test('this computer looks at its own folder', () async {
      final home = Directory.systemTemp.createTempSync('harness-clone-line');
      addTearDown(() => home.deleteSync(recursive: true));
      Directory('${home.path}/harnesses/repo').createSync(recursive: true);
      final held = Completer<String>();
      final local = createApp(
        connectionForTest: (_) => connection,
        connected: true,
        // Never a real clone into this developer's own home.
        prepareFolder: (_) => held.future,
      );
      addTearDown(local.dispose);
      local.machineStates['m']!
        ..agents = []
        ..localOnly = true;
      NewHarnessController boxFor(String link) {
        final box = NewHarnessController(
          local,
          machineId: 'm',
          engine: 'codex',
          folder: home.path,
          home: home.path,
        )..useDesktopChoices(true);
        box.sshHosts = _Hosts(const {});
        addTearDown(box.dispose);
        box.focusField(NewHarnessField.projectMenu);
        box.setQuery(link);
        box.accept();
        unawaited(box.create());
        return box;
      }

      final reused = boxFor('https://github.com/org/repo');
      final cloned = boxFor('https://github.com/org/fresh');
      await pumpEventQueue();
      expect(reused.status, 'Starting harness…');
      expect(cloned.status, 'Cloning org/fresh…');
    });

    test('an answer after the creation failed changes nothing', () async {
      connection.harnessesHeld = Completer();
      final box = search('https://github.com/org/repo');
      box.accept();
      final outcome = box.create();
      await Future<void>.delayed(Duration.zero);
      expect(box.status, 'Starting harness…');
      connection.createReply!.complete({'error': 'INVALID_CWD'});
      await outcome;
      final settled = box.status;
      connection.harnessesHeld!.complete();
      await Future<void>.delayed(Duration.zero);
      expect(box.status, settled);
    });
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
