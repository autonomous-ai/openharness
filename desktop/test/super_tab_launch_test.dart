import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp, MemoryStore;

const tabId = '0123456789abcdef01234567';

class _Connection extends WsConn {
  _Connection(this.store)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      ) {
    server.state['id'] = tabId;
  }
  final MemoryStore store;
  final server = ConversationServer();
  final calls = <(String, Map<String, dynamic>)>[];
  final joins = <Map<String, dynamic>>[];
  bool loseCreate = false, loseJoin = false;
  Map<String, dynamic>? native;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, Map.of(payload)));
    if (type == 'super_tabs') {
      if (payload['action'] == 'wake') return {'ok': true};
      if (payload['path'] == '/api/super-tabs' && payload['method'] == 'POST') {
        return {
          'ok': true,
          'value': {'id': tabId, 'revision': 0},
        };
      }
      final body = payload['body'] as Map<String, dynamic>?;
      if (body?['command'] case final Map command
          when command['type'] == 'agent.add') {
        joins.add(Map<String, dynamic>.from(body!));
        if (!server.receipts.containsKey(body['operationId'])) {
          (server.state['agents'] as List).add({
            'id': 'lead-agent',
            'machineId': 'm',
            'harnessId': command['harnessId'],
            'name': 'Lead',
            'contributorId': 'owner',
            'configuration': command['configuration'],
          });
          if (command['initialMessage'] is String) {
            server.append(command['initialMessage'] as String);
          }
        }
      }
      final value = await server.request(
        payload['method'] as String,
        payload['path'] as String,
        body: body,
      );
      if (loseJoin &&
          body?['command'] is Map &&
          (body!['command'] as Map)['type'] == 'agent.add') {
        loseJoin = false;
        throw StateError('Lost the join reply after committing');
      }
      return {'ok': true, 'value': value};
    }
    if (type == 'agent_create') {
      final records = store.values.entries.where(
        (e) => e.key.startsWith('super_tab.launch.'),
      );
      expect(records, hasLength(1));
      final saved = jsonDecode(records.single.value) as Map;
      expect(saved['phase'], 'starting');
      expect(saved['creationId'], payload['creationId']);
      native = {
        'id': 'native-lead',
        'name': 'Lead',
        'engine': payload['engine'],
        'terminalAvailable': true,
        'project': {'cwd': '/work/project', 'label': 'Project'},
      };
      if (loseCreate) {
        loseCreate = false;
        throw TimeoutException('Lost launch reply');
      }
    }
    if (type == 'agent_create' || type == 'agent_create_status') {
      return {
        'creationId': payload['creationId'],
        'state': native == null ? 'missing' : 'created',
        'agent': native,
      };
    }
    return switch (type) {
      'git_project_info' => {'isGit': false, 'refreshed': true},
      'engines_probe' => {
        'engines': [
          {'engine': 'codex', 'installed': true, 'supportsCodexHome': true},
          {'engine': 'claude', 'installed': true},
        ],
      },
      'codex_profiles_list' => {'profiles': <dynamic>[]},
      'dsh_list' => {'dsh': <dynamic>[]},
      'fs_list_dir' => {'path': '/work/project', 'entries': <dynamic>[]},
      _ => {},
    };
  }
}

class _Fixture {
  _Fixture() {
    connection = _Connection(store);
    app = createApp(
      store: store,
      connectionForTest: (_) => connection,
      connected: true,
    );
    app.machineStates['m']!
      ..localOnly = true
      ..agents = [];
    app.gitProjectReaderForTest = (_, _) async => {
      'isGit': false,
      'refreshed': true,
    };
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.markSuperTabDraft(app.activeSwarmId);
    addTearDown(app.dispose);
  }
  final store = MemoryStore();
  late final AppNotifier app;
  late final _Connection connection;

  Future<NewHarnessController> box({String engine = 'codex'}) async {
    final integration = await SuperTabLaunch.open(app, app.activeSwarm, 'lead');
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: engine,
      folder: '/work/project',
      task: 'Discuss the architecture.',
      integration: integration,
    );
    addTearDown(box.dispose);
    await Future<void>.delayed(Duration.zero);
    return box;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final engine in ['codex', 'claude']) {
    test(
      '$engine lead uses the native form and joins without opening a terminal or another tab',
      () async {
        final f = _Fixture(), initialTab = f.app.activeSwarmId;
        final box = await f.box(engine: engine);
        expect(box.actionLabel, 'New Super Tab');
        expect(
          await box.create(),
          NewHarnessOutcome.created,
          reason: box.error,
        );
        final creates = f.connection.calls.where((c) => c.$1 == 'agent_create');
        expect(creates, hasLength(1));
        expect(creates.single.$2['engine'], engine);
        expect(
          creates.single.$2['prompt'],
          contains('Discuss the architecture.'),
        );
        expect(
          creates.single.$2['prompt'],
          contains('harness super-tab --tab $tabId'),
        );
        expect(f.app.swarms, hasLength(1));
        expect(f.app.activeSwarmId, initialTab);
        expect(f.app.activeSwarm.superTabId, tabId);
        expect(f.app.activeSwarm.panes, isEmpty);
        expect(
          f.connection.server.messages.single['text'],
          'Discuss the architecture.',
        );
      },
    );
  }

  test('lost join acknowledgement retries the same contribution without a second native launch', () async {
    final f = _Fixture()..connection.loseJoin = true;
    final box = await f.box();
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.checking, isTrue);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(
      f.connection.calls.where((c) => c.$1 == 'agent_create'),
      hasLength(1),
    );
    expect(f.connection.joins, hasLength(2));
    expect(f.connection.joins[0], f.connection.joins[1]);
    expect(f.connection.server.messages, hasLength(1));
  });

  test(
    'reopening after a lost native launch reply only checks its saved receipt',
    () async {
      final f = _Fixture()..connection.loseCreate = true;
      final first = await f.box();
      expect(await first.create(), NewHarnessOutcome.failed);
      final reopened = await f.box(engine: 'claude');
      expect(reopened.checking, isTrue);
      expect(
        await reopened.create(),
        NewHarnessOutcome.created,
        reason: reopened.error,
      );
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create'),
        hasLength(1),
      );
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create_status'),
        hasLength(1),
      );
      expect(
        (f.connection.joins.single['command']
            as Map)['configuration']['engine'],
        'codex',
      );
    },
  );

  test(
    'late account responses cannot open a previous account’s conversation',
    () async {
      final response = Completer<Object?>();
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: (_, _, {body}) => response.future,
      )..bind('first');
      addTearDown(client.dispose);
      final pending = client.request('GET', '/api/super-tabs');
      client.bind('second');
      response.complete({'tabs': []});
      await expectLater(
        pending,
        throwsA(predicate((e) => e.toString().contains('account changed'))),
      );
    },
  );
}
