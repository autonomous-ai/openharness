import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:path/path.dart' as p;

class _Connection extends WsConn {
  _Connection(String id)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creates = <Map<String, dynamic>>[];
  final checks = <String>[];
  int collisions = 0;
  bool loseReply = false;
  bool collisionAsFailure = false;
  bool wrongCollisionReceipt = false;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') {
      return {
        'engines': [
          {'engine': 'codex', 'installed': true},
          {'engine': 'claude', 'installed': true},
        ],
      };
    }
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'fs_list_dir') {
      return {'path': payload['path'] ?? '/fixture/$machineId', 'entries': []};
    }
    if (type == 'agent_create') {
      creates.add(Map.of(payload));
      if (collisions-- > 0) {
        if (collisionAsFailure) {
          throw const WsRequestFailure(
            responseType: 'agent_create_result',
            code: 'PROJECT_EXISTS',
            detail: 'That folder already exists.',
          );
        }
        return {
          'creationId': wrongCollisionReceipt
              ? 'another-request'
              : payload['creationId'],
          'state': 'failed',
          'failure': {
            'code': 'PROJECT_EXISTS',
            'detail': 'That folder already exists.',
          },
        };
      }
      if (loseReply) {
        loseReply = false;
        throw const WsRequestTimeout('agent_create');
      }
    } else if (type == 'agent_create_status') {
      checks.add(payload['creationId'] as String);
    } else {
      return {};
    }
    return {
      'creationId': payload['creationId'],
      'state': 'created',
      'agent': {
        'id': 'made-${creates.length}',
        'name': 'A new harness',
        'engine': 'codex',
      },
    };
  }
}

class _App extends AppNotifier {
  _App(this.root, Map<String, _Connection> connections)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (id) => connections[id]!,
      ) {
    machines = [
      for (final id in connections.keys)
        Machine(machineId: id, name: id, authMode: MachineAuthMode.remote),
    ];
    for (final machine in machines) {
      machineStates[machine.machineId] = MachineState(machine)
        ..localOnly = machine.machineId == 'local'
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
    }
    status = AppStatus.authenticated;
  }
  final String root;
  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) => request.prepareLocal(projectHome: root, label: label);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final at = DateTime(2026, 9, 20, 17, 22, 19);
  late Directory home;
  late _App app;
  late Map<String, _Connection> connections;
  setUp(() async {
    home = await Directory.systemTemp.createTemp('harness-generated-project-');
    connections = {
      for (final id in ['local', 'remote']) id: _Connection(id),
    };
    app = _App(p.join(home.path, 'harnesses'), connections);
  });
  tearDown(() async {
    app.dispose();
    for (final connection in connections.values) {
      await connection.close();
    }
    await home.delete(recursive: true);
  });

  NewHarnessController box([String machine = 'local']) => NewHarnessController(
    app,
    machineId: machine,
    engine: 'codex',
    autoProject: true,
    now: () => at,
    home: home.path,
    placement: HarnessPlacement.newTab,
  );

  test('the suggested folder is shown, survives a delay, and is the folder used by Start', () async {
    var clock = at;
    final draft = NewHarnessController(
      app,
      machineId: 'local',
      engine: 'codex',
      autoProject: true,
      now: () => clock,
      home: home.path,
      placement: HarnessPlacement.newTab,
    );
    addTearDown(draft.dispose);
    expect(draft.field, NewHarnessField.launch);
    expect(draft.projectLabel, '~/harnesses/codex-2026-09-20-17-22');
    expect(draft.needsProject, isFalse);
    clock = at.add(const Duration(minutes: 15));
    expect(await draft.create(), NewHarnessOutcome.created);
    final folder = connections['local']!.creates.single['cwd'] as String;
    expect(p.basename(folder), 'codex-2026-09-20-17-22');
    expect(await Directory(folder).exists(), isTrue);
  });

  test('two starts reserve unique folders and preserve an existing folder and its files', () async {
    final existing = Directory(p.join(app.root, 'codex-2026-09-20-17-22'));
    await existing.create(recursive: true);
    final keep = File(p.join(existing.path, 'keep.txt'));
    await keep.writeAsString('untouched');
    final a = box(), b = box();
    addTearDown(a.dispose);
    addTearDown(b.dispose);
    expect(await Future.wait([a.create(), b.create()]), [
      NewHarnessOutcome.created,
      NewHarnessOutcome.created,
    ]);
    expect(
      connections['local']!.creates
          .map((c) => p.basename(c['cwd'] as String))
          .toSet(),
      {'codex-2026-09-20-17-22-19', 'codex-2026-09-20-17-22-19-2'},
    );
    expect(await keep.readAsString(), 'untouched');
  });

  test(
    'the suggested name is prefilled; editing it makes it an explicit choice',
    () async {
      final draft = box();
      addTearDown(draft.dispose);
      draft.focusField(NewHarnessField.projectName);
      expect(draft.query, 'codex-2026-09-20-17-22');
      draft.accept();
      expect(draft.projectFolderRequest!.isGenerated, isTrue);
      draft.focusField(NewHarnessField.projectName);
      draft.setQuery('my new tool');
      draft.accept();
      expect(draft.projectFolderRequest!.isGenerated, isFalse);
      expect(draft.projectLabel, '~/harnesses/my-new-tool');
      draft.focusField(NewHarnessField.agent);
      draft.setQuery('Claude');
      draft.accept();
      expect(draft.projectLabel, '~/harnesses/my-new-tool');
      expect(await draft.create(), NewHarnessOutcome.created);
      expect(
        p.basename(connections['local']!.creates.single['cwd'] as String),
        'my-new-tool',
      );
    },
  );

  test('switching machines carries a fresh suggestion and restores each machine’s draft', () async {
    final draft = box();
    addTearDown(draft.dispose);
    final original = draft.project;
    draft.focusField(NewHarnessField.machine);
    draft.setQuery('remote');
    draft.accept();
    expect(draft.machineId, 'remote');
    expect(draft.projectFolderRequest!.isGenerated, isTrue);
    expect(draft.project.folder, isNull);
    draft.focusField(NewHarnessField.projectName);
    draft.setQuery('remote-work');
    draft.accept();
    draft.focusField(NewHarnessField.machine);
    draft.setQuery('local');
    draft.accept();
    expect(draft.project, original);
    draft.focusField(NewHarnessField.machine);
    draft.setQuery('remote');
    draft.accept();
    expect(draft.project.name, 'remote-work');
    expect(draft.projectFolderRequest!.isGenerated, isFalse);
  });

  test('remote collisions advance only an automatic name and use distinct receipts', () async {
    connections['remote']!.collisions = 2;
    final draft = box('remote');
    addTearDown(draft.dispose);
    expect(await draft.create(), NewHarnessOutcome.created);
    final calls = connections['remote']!.creates;
    expect(calls.map((c) => c['projectName']), [
      'codex-2026-09-20-17-22',
      'codex-2026-09-20-17-22-19',
      'codex-2026-09-20-17-22-19-2',
    ]);
    expect(calls.map((c) => c['creationId']).toSet(), hasLength(3));
  });

  test('a lost reply after collision checks that exact attempt without another start', () async {
    connections['remote']!
      ..collisions = 1
      ..loseReply = true;
    final draft = box('remote');
    addTearDown(draft.dispose);
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(draft.checking, isTrue);
    expect(connections['remote']!.creates, hasLength(2));
    expect(await draft.create(), NewHarnessOutcome.created);
    expect(connections['remote']!.creates, hasLength(2));
    expect(connections['remote']!.checks, [
      connections['remote']!.creates.last['creationId'],
    ]);
  });

  test(
    'a collision belonging to another receipt cannot trigger a new start',
    () async {
      connections['remote']!
        ..collisions = 1
        ..wrongCollisionReceipt = true;
      final draft = box('remote');
      addTearDown(draft.dispose);
      expect(await draft.create(), NewHarnessOutcome.failed);
      expect(draft.checking, isTrue);
      expect(connections['remote']!.creates, hasLength(1));
    },
  );

  test('a typed collision refusal leaves a custom name editable', () async {
    connections['remote']!
      ..collisions = 1
      ..collisionAsFailure = true;
    final draft = box('remote');
    addTearDown(draft.dispose);
    draft.focusField(NewHarnessField.projectName);
    draft.setQuery('payments');
    draft.accept();
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(draft.checking, isFalse);
    expect(draft.error, contains('already exists'));
    expect(connections['remote']!.creates, hasLength(1));
    draft.focusField(NewHarnessField.projectName);
    draft.setQuery('design-system');
    draft.accept();
    expect(await draft.create(), NewHarnessOutcome.created);
    expect(connections['remote']!.creates.last['projectName'], 'design-system');
  });

  test(
    'a user-chosen name is never silently numbered after a remote conflict',
    () async {
      connections['remote']!.collisions = 1;
      final draft = box('remote');
      addTearDown(draft.dispose);
      draft.focusField(NewHarnessField.projectName);
      draft.setQuery('payments');
      draft.accept();
      expect(await draft.create(), NewHarnessOutcome.failed);
      expect(draft.error, contains('already exists'));
      expect(connections['remote']!.creates, hasLength(1));
      expect(draft.project.name, 'payments');
    },
  );
}
