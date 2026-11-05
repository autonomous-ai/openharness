import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/super_tabs/new_repository.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;

/// The fixture's backend with New Repository's two routes (backend PR #3201,
/// plan Task 6): the organization check, and the ask that answers with the
/// sign-in's link. GitHub's callback is [answer], writing the outcome on the
/// project as the backend does.
class _GitHubConnection extends SuperTabFixtureConnection {
  _GitHubConnection(super.store);

  /// What the organization check answers; null answers 404, as a server from
  /// before New Repository.
  Map<String, dynamic>? owner = {'state': 'ready'};
  final ownerChecks = <String>[];

  /// The ask's refusal, as the backend gives it before any sign-in.
  SuperTabFailure? refuseAsk;
  final asks = <(String, Map<String, dynamic>)>[];
  int at = DateTime.now().millisecondsSinceEpoch;

  Map<String, dynamic> project(String id) => (server.state['projects'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((p) => p['id'] == id);

  /// GitHub's callback for the ask made at [when] (the last by default).
  void answer(
    String state, {
    int? when,
    String? url,
    bool? reachable,
    String? reason,
  }) {
    final (projectId, body) = asks.last;
    project(projectId)['repositoryCreation'] = {
      'owner': body['owner'],
      'name': body['name'],
      'private': body['private'],
      'by': 'owner',
      'at': when ?? at,
      'state': state,
      'repositoryUrl': ?url,
      'reachable': ?reachable,
      'reason': ?reason,
    };
    server.revision++;
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final path = payload['path'];
    if (type == 'super_tabs' && path is String) {
      final segments = Uri.parse(path).pathSegments;
      if (segments.length == 6 &&
          segments[3] == 'github' &&
          segments[4] == 'owners') {
        ownerChecks.add(segments[5]);
        final answer = owner;
        if (answer == null) {
          throw const SuperTabFailure(
            'BACKEND_UNAVAILABLE',
            'Not Found',
            statusCode: 404,
          );
        }
        return {'ok': true, 'value': answer};
      }
      if (segments.length == 7 &&
          segments[3] == 'projects' &&
          segments[5] == 'github' &&
          segments[6] == 'repository') {
        final body = Map<String, dynamic>.from(payload['body'] as Map);
        if (refuseAsk case final refusal?) throw refusal;
        asks.add((segments[4], body));
        at += 1000;
        project(segments[4])['repositoryCreation'] = {
          ...body,
          'by': 'owner',
          'at': at,
          'state': 'waiting',
        };
        server.revision++;
        return {
          'ok': true,
          'value': {
            'authorizeUrl':
                'https://github.test/login/oauth/authorize?state=$at',
            'at': at,
          },
        };
      }
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

const _ask = NewRepositoryAsk(owner: 'acme', name: 'notes');

void main() {
  late SuperTabLaunchFixture f;
  late _GitHubConnection github;
  late List<Uri> opened;

  setUp(() {
    f = SuperTabLaunchFixture(connectionFactory: _GitHubConnection.new);
    github = f.connection as _GitHubConnection;
    opened = [];
    SuperTabLaunch.openLinkForTest = (uri) async {
      opened.add(uri);
      return true;
    };
    addTearDown(() => SuperTabLaunch.openLinkForTest = null);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  });

  Future<HarnessLaunchIntegration> open({
    List<String> repositories = const [],
  }) async {
    final projects = github.server.state['projects'] as List? ?? [];
    for (final (i, url) in repositories.indexed) {
      projects.add({
        'id': 'used-$i',
        'name': 'Used $i',
        'ownerId': 'owner',
        'leadConversationId': 'used-$i-chat',
        'visibility': 'public',
        'members': const [],
        'repository': {'repositoryUrl': url},
      });
    }
    github.server.state['projects'] = projects;
    return SuperTabLaunch.open(
      f.app,
      f.app.activeSwarm,
      'new-project',
      newProject: true,
    );
  }

  List<Map> commandsOf(String type) => [
    for (final post in github.server.posts)
      if ((post['command'] as Map)['type'] == type) post['command'] as Map,
  ];

  /// Starts a create of [ask] and lets it reach GitHub.
  Future<Future<NewRepositoryCreated>> asking(
    HarnessLaunchIntegration integration, [
    NewRepositoryAsk ask = _ask,
  ]) async {
    final created = integration.createRepository!(ask, 'A notes app.');
    // Its failure is read by the test, never left unhandled meanwhile.
    created.ignore();
    await pumpEventQueue();
    return created;
  }

  /// GitHub's callback, then Check again.
  Future<void> answered(
    HarnessLaunchIntegration integration,
    String state, {
    int? when,
    String? url,
    bool? reachable,
    String? reason,
  }) async {
    github.answer(
      state,
      when: when,
      url: url,
      reachable: reachable,
      reason: reason,
    );
    await integration.checkRepositoryAgain!();
    await pumpEventQueue();
  }

  test(
    'offers the Swarm\'s organizations, and checks one as the server says',
    () async {
      final integration = await open(
        repositories: [
          'https://github.com/autonomous-ai/openharness',
          'https://github.com/Acme/site',
          'https://github.com/autonomous-ai/website',
        ],
      );
      expect(integration.newRepositoryOwners, ['autonomous-ai', 'Acme']);
      expect((await integration.checkRepositoryOwner!('Acme')).state, 'ready');
      github.owner = {
        'state': 'not-installed',
        'installUrl': 'https://github.com/apps/harness/installations/new',
      };
      final missing = await integration.checkRepositoryOwner!('acme');
      expect(missing.state, 'not-installed');
      expect(
        missing.installUrl,
        'https://github.com/apps/harness/installations/new',
      );
      expect(missing.problem, 'Harness isn’t on acme’s GitHub yet.');
      github.owner = {'state': 'not-accepted'};
      expect(
        (await integration.checkRepositoryOwner!('acme')).problem,
        startsWith('An owner of acme needs to accept'),
      );
      expect(github.ownerChecks, ['Acme', 'acme', 'acme']);
    },
  );

  test('hides New Repository where the server cannot create', () async {
    github.owner = {'state': 'not-configured'};
    expect(
      (await open(repositories: ['https://github.com/acme/site']))
          .newRepositoryOwners,
      isNull,
    );
  });

  test('hides New Repository on a server from before it', () async {
    github.owner = null;
    expect(
      (await open(repositories: ['https://github.com/acme/site']))
          .newRepositoryOwners,
      isNull,
    );
  });

  test('creates the project once, asks GitHub through the person\'s sign-in, and gives what was made', () async {
    final integration = await open();
    final created = await asking(integration);
    expect(commandsOf('project.create'), hasLength(1));
    final (projectId, body) = github.asks.single;
    expect(projectId, f.connection.server.state['projects'].last['id']);
    expect(body, {'owner': 'acme', 'name': 'notes', 'private': true});
    expect(opened, [
      Uri.parse('https://github.test/login/oauth/authorize?state=${github.at}'),
    ]);
    await answered(
      integration,
      'created',
      url: 'https://github.com/acme/notes',
      reachable: true,
    );
    final made = await created;
    expect(made.repositoryUrl, 'https://github.com/acme/notes');
    expect(made.reachable, isTrue);
  });

  test('an outcome of an older ask never finishes this one', () async {
    final integration = await open();
    final created = await asking(integration);
    var done = false;
    unawaited(created.then((_) => done = true));
    await answered(
      integration,
      'created',
      when: github.at - 1,
      url: 'https://github.com/acme/old',
    );
    expect(done, isFalse);
    await answered(
      integration,
      'created',
      url: 'https://github.com/acme/notes',
    );
    expect((await created).repositoryUrl, 'https://github.com/acme/notes');
  });

  for (final (state, reason, line) in [
    (
      'taken',
      null,
      'acme/notes already exists. Choose another name, or choose it under GitHub in Choose repo to use it.',
    ),
    (
      'refused',
      'Repository creation failed.',
      'GitHub didn’t let you create a repository in acme: Repository creation failed. Ask an owner of acme, or create it on GitHub and paste its link under GitHub in Choose repo.',
    ),
    ('failed', null, 'GitHub didn’t answer. Nothing was created.'),
    ('cancelled', null, 'Nothing was created.'),
  ]) {
    test('$state says its line, and a retry asks GitHub again', () async {
      final integration = await open();
      final created = await asking(integration);
      await answered(integration, state, reason: reason);
      await expectLater(
        created,
        throwsA(
          isA<SuperTabFailure>().having((e) => e.message, 'message', line),
        ),
      );
      final again = await asking(integration);
      expect(github.asks, hasLength(2));
      expect(commandsOf('project.create'), hasLength(1));
      await answered(
        integration,
        'created',
        url: 'https://github.com/acme/notes',
      );
      expect((await again).repositoryUrl, 'https://github.com/acme/notes');
    });
  }

  test('a retry after it was made never asks GitHub again', () async {
    final integration = await open();
    final created = await asking(integration);
    await answered(
      integration,
      'created',
      url: 'https://github.com/acme/notes',
      reachable: false,
    );
    await created;
    final again = await integration.createRepository!(_ask, 'A notes app.');
    expect(again.repositoryUrl, 'https://github.com/acme/notes');
    expect(again.reachable, isFalse);
    expect(github.asks, hasLength(1));
    expect(opened, hasLength(1));
  });

  test('the organization\'s refusals before sign-in say what its owner does (F4, F5)', () async {
    final integration = await open();
    github
      ..refuseAsk = const SuperTabFailure(
        'GITHUB_APP_NOT_INSTALLED',
        "Harness isn't on acme's GitHub yet.",
        statusCode: 409,
      )
      ..owner = {
        'state': 'not-installed',
        'installUrl': 'https://github.com/apps/harness/installations/new',
      };
    await expectLater(
      integration.createRepository!(_ask, 'A notes app.'),
      throwsA(
        isA<NewRepositoryRefusal>()
            .having(
              (e) => e.message,
              'message',
              'Harness isn’t on acme’s GitHub yet.',
            )
            .having(
              (e) => e.installUrl,
              'installUrl',
              'https://github.com/apps/harness/installations/new',
            ),
      ),
    );
    github.refuseAsk = const SuperTabFailure(
      'GITHUB_APP_PERMISSIONS',
      'An owner of acme needs to accept',
      statusCode: 409,
    );
    await expectLater(
      integration.createRepository!(_ask, 'A notes app.'),
      throwsA(
        isA<NewRepositoryRefusal>().having(
          (e) => e.message,
          'message',
          'An owner of acme needs to accept Harness’s new permission once: GitHub Settings → GitHub Apps → Harness.',
        ),
      ),
    );
    expect(opened, isEmpty);
  });

  test(
    'a project deleted while its person was in GitHub says so (F11)',
    () async {
      final integration = await open();
      final created = await asking(integration);
      final projectId = github.asks.single.$1;
      (github.server.state['projects'] as List).removeWhere(
        (p) => (p as Map)['id'] == projectId,
      );
      github.server.revision++;
      await integration.checkRepositoryAgain!();
      await expectLater(
        created,
        throwsA(
          isA<SuperTabFailure>().having(
            (e) => e.message,
            'message',
            'The project was deleted meanwhile. Nothing was created.',
          ),
        ),
      );
    },
  );
}
