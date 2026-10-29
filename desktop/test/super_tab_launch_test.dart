import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/first_task.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/launch_setup.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/state/lead_placement.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp, MemoryStore;

const tabId = '0123456789abcdef01234567';

class SuperTabFixtureConnection extends WsConn {
  SuperTabFixtureConnection(this.store, {bool local = false})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: local
            ? WsTransportKind.localPlaintext
            : WsTransportKind.cloudE2ee,
        localWsUri: local ? Uri.parse('ws://127.0.0.1:1/ws') : null,
      ) {
    server.state['id'] = tabId;
  }
  final MemoryStore store;
  final server = ConversationServer();
  final calls = <(String, Map<String, dynamic>)>[];
  final extraEngines = <String>[];
  final joins = <Map<String, dynamic>>[];

  /// Preparation operations this fixture has already answered: the daemon
  /// answers a new one with `preparing` and is ready only when it is read
  /// again (`cli/src/superTabs/contribution.ts`), so a client that gives up
  /// after one answer never sees anything ready.
  final prepared = <Object?>{};

  /// Preparation never finishes: every ask is answered `preparing`, as a setup
  /// still running on the machine answers.
  bool keepPreparing = false;

  /// The most agents preparation says this machine may run; null for a Harness
  /// from before setup reported it.
  int? maxAvailableAgents = 16;
  bool loseCreate = false, loseJoin = false;
  bool failNative = false;
  WsRequestFailure? backendFailure;

  /// [backendFailure] refuses only commands: an older backend still answers
  /// reads and rejects the command it does not know.
  bool backendFailureOnCommandsOnly = false;
  bool failResume = false;
  bool nativeSurface = false;
  bool failFiles = false, failCreation = false, changeAccountOnUpload = false;
  bool changeAccountOnProjectRead = false;
  late AppNotifier app;
  final sentFiles = <Uint8List>[];
  final terminalCalls = <(String, Map<String, dynamic>)>[];
  static const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  Map<String, dynamic>? native;
  String nativeName = 'Lead';
  Map<String, dynamic> nativeProject = {
    'cwd': '/work/project',
    'label': 'Project',
  };
  bool cancelledCreation = false;
  Future<Map<String, dynamic>> Function(String, Map<String, dynamic>)?
  creationRecovery;

  Future<void> event(String type, Map<String, dynamic> payload) =>
      app.handleMachineEventForTest('m', {'type': type, 'payload': payload});

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    terminalCalls.add((type, Map.of(payload)));
    if (type == 'terminal_open') {
      await event('terminal_ready', {
        'requestId': payload['requestId'],
        'protocolVersion': 3,
        'streamId': streamId,
        'agentId': 'native-lead',
      });
      await app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.keyframe,
            streamId: streamId,
            seq: 0,
            bytes: Uint8List.fromList(utf8.encode('›\r\n? for shortcuts')),
            compressed: false,
            cols: 100,
            rows: 30,
          ),
        )!,
      );
    }
    if (type == 'terminal_chunked_upload_begin') {
      if (changeAccountOnUpload) {
        app.currentUser = const CurrentUserProfile(
          id: 'different',
          email: 'different@example.com',
        );
        return false;
      }
      await event('terminal_chunked_upload_begin_result', {
        'streamId': streamId,
        'accepted': !failFiles,
      });
    }
    return true;
  }

  @override
  Future<bool> sendTerminalBinary(Uint8List raw) async {
    final frame = decodeTerminalLocal(raw)!;
    if (frame.kind == TerminalBinaryKind.pasteFile) {
      sentFiles.add(frame.bytes);
      await event('terminal_paste_file_result', {
        'streamId': streamId,
        'path': '/fixture/design.png',
      });
    }
    return true;
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, Map.of(payload)));
    if (nativeSurface && type == 'terminal_capabilities') {
      return {'protocolVersion': 3, 'backend': 'tmux', 'available': true};
    }
    if (nativeSurface && type == 'agents_list') {
      return {
        'agents': [if (native != null) native],
      };
    }
    if (type == 'super_tabs') {
      if (changeAccountOnProjectRead &&
          payload['method'] == 'GET' &&
          payload['path'] == '/api/super-tabs/$tabId/parts') {
        app.currentUser = const CurrentUserProfile(
          id: 'different',
          email: 'different@example.com',
        );
      }
      if (payload['action'] == 'backend' &&
          backendFailure != null &&
          !(backendFailureOnCommandsOnly && payload['method'] == 'GET')) {
        throw backendFailure!;
      }
      if (payload['action'] == 'wake') return {'ok': true};
      if (payload['action'] == 'prepareContribution') {
        if (prepared.add(payload['operationId']) || keepPreparing) {
          return {'ok': true, 'state': 'preparing'};
        }
        return {
          'ok': true,
          'state': 'ready',
          'cwd': '/work/project',
          'scope': 'swarm',
          'engines': ['claude', 'codex', 'pi'],
          'maxAgents': 8,
          if (maxAvailableAgents != null)
            'maxAvailableAgents': maxAvailableAgents,
        };
      }
      if (payload['action'] == 'prepareNative' ||
          payload['action'] == 'renewNative') {
        if (native?['status'] == 'stopped') {
          return {
            'error': 'SUPER_TAB_UNAVAILABLE',
            'detail': 'The exact contributed terminal is unavailable on this machine.',
          };
        }
        return failNative
            ? {
                'error': 'NATIVE_UNAVAILABLE',
                'detail': 'Fixture recording unavailable.',
              }
            : {'ok': true, 'inputContext': payload['contextId']};
      }
      if (payload['method'] == 'POST' &&
          (payload['path'] as String?)?.endsWith('/native') == true) {
        return {
          'ok': true,
          'value': {'contextId': (payload['body'] as Map)['operationId']},
        };
      }
      if (payload['path'] == '/api/super-tabs' && payload['method'] == 'POST') {
        final body = payload['body'] as Map;
        server.state['projects'] ??= [
          {
            ...projectFixture(
              'lead',
              'Swarm',
              'lead',
              visibility: body['projectVisibility'] as String? ?? 'public',
            ),
            'skillMode': 'default',
          },
        ];
        return {
          'ok': true,
          'value': {'id': tabId, 'revision': 0},
        };
      }
      final body = payload['body'] as Map<String, dynamic>?;
      if (body?['command'] case final Map command
          when command['type'] == 'agent.add') {
        joins.add(Map<String, dynamic>.from(body!));
        // As the backend: a deleted project's conversation is not found.
        if (!(server.state['conversations'] as List).cast<Map>().any(
          (g) => g['id'] == command['conversationId'],
        )) {
          throw const SuperTabFailure(
            'NOT_FOUND',
            'This conversation is unavailable.',
            statusCode: 404,
          );
        }
        if (!server.receipts.containsKey(body['operationId'])) {
          (server.state['agents'] as List).add({
            'id': 'lead-agent',
            'machineId': 'm',
            'harnessId': command['harnessId'],
            'name': command['name'],
            'contributorId': 'owner',
            'configuration': command['configuration'],
          });
          final group = (server.state['conversations'] as List)
              .cast<Map>()
              .firstWhere((g) => g['id'] == command['conversationId']);
          (server.state['agents'] as List).last['projectId'] =
              group['projectId'] ?? 'lead';
          (group['agentIds'] as List).add('lead-agent');
          if (command['lead'] == true) group['leadId'] = 'lead-agent';
          if (command['initialMessage'] is String) {
            server.append(
              command['initialMessage'] as String,
              conversationId: command['conversationId'] as String,
            );
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
    if (type == 'agent_resume') {
      // The real native test completes this request during a frame pump.
      expectSync(payload['agentId'], native!['id']);
      if (failResume) return {'error': 'RESUME_FAILED'};
      native = {
        ...native!,
        'status': 'active',
        'terminal': {'available': true},
      };
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'resumed': true,
        'agent': native,
      };
    }
    if (type == 'agent_create_status' || type == 'agent_create_cancel') {
      if (creationRecovery case final recover?) return recover(type, payload);
    }
    if (type == 'agent_create_cancel') {
      cancelledCreation = native == null;
      return {
        'creationId': payload['creationId'],
        'state': cancelledCreation ? 'cancelled' : 'created',
        'agent': native,
      };
    }
    if (type == 'agent_create') {
      // Match the native daemon: this refusal happens before a receipt or pane.
      if ((payload['prompt'] as String? ?? '').trim().length >
          kFirstTaskMaxLength) {
        throw const WsRequestFailure(
          responseType: 'agent_create_result',
          code: 'PROMPT_TOO_LONG',
          detail: 'First task exceeds the native limit.',
          payload: {},
        );
      }
      cancelledCreation = false;
      final records = store.values.entries.where(
        (e) => e.key.startsWith('super_tab.launch.'),
      );
      expect(records, hasLength(1));
      final saved = jsonDecode(records.single.value) as Map;
      expect(saved['phase'], 'starting');
      expect(saved['creationId'], payload['creationId']);
      native = {
        'id': 'native-lead',
        'name': nativeName,
        'engine': payload['engine'],
        'closeSupported': true,
        'terminal': {'available': true},
        'project': nativeProject,
      };
      if (loseCreate) {
        loseCreate = false;
        throw TimeoutException('Lost launch reply');
      }
    }
    if (type == 'agent_create' || type == 'agent_create_status') {
      if (failCreation) {
        return {
          'creationId': payload['creationId'],
          'state': 'failed',
          'failure': {'detail': 'Fixture engine unavailable'},
        };
      }
      return {
        'creationId': payload['creationId'],
        'state': cancelledCreation
            ? 'cancelled'
            : native == null
            ? 'missing'
            : 'created',
        'agent': native,
      };
    }
    return switch (type) {
      'git_project_info' => {'isGit': false, 'refreshed': true},
      'engines_probe' => {
        'engines': [
          {'engine': 'codex', 'installed': true, 'supportsCodexHome': true},
          {'engine': 'claude', 'installed': true},
          for (final engine in extraEngines)
            {'engine': engine, 'installed': true},
        ],
      },
      'codex_profiles_list' => {'profiles': <dynamic>[]},
      'dsh_list' => {'dsh': <dynamic>[]},
      'fs_list_dir' => {'path': '/work/project', 'entries': <dynamic>[]},
      _ => {},
    };
  }
}

class SuperTabLaunchFixture {
  SuperTabLaunchFixture({
    bool local = false,
    SuperTabFixtureConnection Function(MemoryStore)? connectionFactory,
    LocalCliDiscovery? discovery,
    Future<String> Function(ProjectFolderRequest request)? prepareFolder,
  }) {
    connection =
        connectionFactory?.call(store) ??
        SuperTabFixtureConnection(store, local: local);
    app = createApp(
      store: store,
      connectionForTest: (_) => connection,
      connected: true,
      localCliDiscovery: discovery,
      prepareFolder: prepareFolder,
    );
    app.machineStates['m']!
      ..localOnly = true
      ..terminalPasteFileAvailable = true
      ..terminalPasteRawAvailable = true
      ..agents = [];
    connection.app = app;
    app.gitProjectReaderForTest = (_, _) async => {
      'isGit': false,
      'refreshed': true,
    };
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.markSuperTabDraft(app.activeSwarmId);
    addTearDown(dispose);
  }
  final store = MemoryStore();
  late final AppNotifier app;
  late final SuperTabFixtureConnection connection;
  bool _disposed = false;

  /// Once. A widget test whose app read a machine list must call it itself: Flutter checks for pending timers (the
  /// list's safety net) before tear-downs run.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    app.dispose();
  }

  Future<NewHarnessController> box({
    String engine = 'codex',
    HarnessAttachments? attachments,
    bool newProject = false,
    String? task = 'Discuss the architecture.',
    String? harnessId,
  }) async {
    final integration = await SuperTabLaunch.open(
      app,
      app.activeSwarm,
      newProject ? 'new-project' : 'lead',
      newProject: newProject,
    );
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: engine,
      folder: '/work/project',
      task: task,
      harnessId: harnessId,
      integration: integration,
      attachments: attachments,
    );
    addTearDown(box.dispose);
    await Future<void>.delayed(Duration.zero);
    return box;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'Swarm members with no full mode retain their supported launch behavior',
    () async {
      for (final engine in ['opencode', 'hermes']) {
        final f = SuperTabLaunchFixture();
        f.connection.extraEngines.add(engine);
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
        final box = await f.box(engine: engine);
        expect(
          await box.create(),
          NewHarnessOutcome.created,
          reason: box.error,
        );
        final request = f.connection.calls
            .firstWhere((c) => c.$1 == 'agent_create')
            .$2;
        expect(request['permissionMode'], isNull);
        expect(request['bypassPermission'], isTrue);
        expect(
          box.agentSettingsFor(engine).map((o) => o.id),
          isNot(contains(NewHarnessController.permissionsId)),
        );
      }
    },
  );

  for (final engine in ['claude', 'codex']) {
    for (final kind in ['new Swarm', 'new project', 'member']) {
      test(
        '$kind launches $engine in full mode without permission choices',
        () async {
          final f = SuperTabLaunchFixture();
          await f.app.agentPreference.selectPermissionMode(engine, 'ask');
          await f.app.agentPreference.remember(
            engine,
            setup: LaunchSetup(engine: engine, permissionMode: 'ask'),
          );
          if (kind != 'new Swarm') {
            f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
          }
          final box = await f.box(
            engine: engine,
            newProject: kind == 'new project',
          );
          expect(
            box.agentSettingsFor(engine).map((o) => o.id),
            isNot(contains(NewHarnessController.permissionsId)),
          );
          box.advancedOpen = true;
          expect(box.fields, isNot(contains(NewHarnessField.mode)));
          box.openLaunchSetting(NewHarnessField.mode);
          expect(box.field, isNot(NewHarnessField.mode));
          expect(
            await box.create(),
            NewHarnessOutcome.created,
            reason: box.error,
          );
          final request = f.connection.calls
              .firstWhere((c) => c.$1 == 'agent_create')
              .$2;
          expect(request['permissionMode'], 'full');
          expect(request['swarmRole'], kind == 'member' ? 'dev' : 'lead');
          expect(
            request['swarmSkillMode'],
            kind == 'member' ? 'orchestration' : 'default',
          );
          await Future<void>.delayed(Duration.zero);
          final ordinary = NewHarnessController(
            f.app,
            machineId: 'm',
            engine: engine,
            folder: '/work/project',
          );
          addTearDown(ordinary.dispose);
          await Future<void>.delayed(Duration.zero);
          expect(
            ordinary.agentSettingsFor(engine).map((o) => o.id),
            contains(NewHarnessController.permissionsId),
          );
          expect(ordinary.mode, 'ask');
        },
      );
    }
  }

  test(
    'guest machine access cannot create a Swarm lead under the owner account',
    () async {
      final f = SuperTabLaunchFixture();
      final box = await f.box(engine: 'claude');
      f.app.machineStates['m']!.machine = const Machine(
        machineId: 'm',
        name: 'Shared Mac',
        authMode: MachineAuthMode.remote,
        machineShare: MachineShare(
          ownerName: 'Another owner',
          ownerEmail: 'another@example.com',
          via: 'email',
          added: true,
        ),
      );
      await expectLater(
        box.integration!.prepare('m', 'Start work'),
        throwsA(
          isA<SuperTabFailure>().having(
            (e) => e.code,
            'code',
            'CONTRIBUTION_REQUIRED',
          ),
        ),
      );
      expect(f.connection.server.posts, isEmpty);
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
    },
  );

  test(
    'a private first project does not expose its title as the swarm name',
    () async {
      final f = SuperTabLaunchFixture()..connection.nativeName = 'Private work';
      final box = await f.box();
      box.integration!.projectVisibility = 'private';
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      expect(f.app.activeSwarm.name, 'Swarm');
      final project = f.app.superTabs.peek(tabId)!.snapshot!.projects.single;
      expect(project.name, 'Private work');
      expect(project.isPrivate, isTrue);
      final rename = f.connection.server.posts
          .map((post) => post['command'] as Map)
          .singleWhere((command) => command['type'] == 'tab.rename');
      expect(rename['name'], 'Swarm');
    },
  );
  test(
    'a new private project keeps the swarm and its other conversations',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['name'] = 'Company';
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final localId = f.app.activeSwarmId;
      final box = await f.box(newProject: true);
      expect(box.actionLabel, 'New Project');
      box.integration!.projectVisibility = 'private';
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      expect(f.app.swarms, hasLength(1));
      expect(f.app.activeSwarmId, localId);
      expect(f.app.activeSwarm.name, 'Company');
      final c = f.app.superTabs.peek(tabId)!;
      final project = c.snapshot!.projects.last;
      expect(project.isPrivate, isTrue);
      expect(c.selectedId, project.leadConversationId);
      expect(c.snapshot!.conversation('offline'), isNotNull);
      expect(
        f.connection.joins.single['command'],
        containsPair('conversationId', project.leadConversationId),
      );
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create'),
        hasLength(1),
      );
      expect(
        f.connection.calls.where((c) => c.$2['path'] == '/api/super-tabs'),
        isEmpty,
      );
    },
  );

  test(
    'New Project lists the Swarm machines for its Product Manager, best first',
    () async {
      final f = SuperTabLaunchFixture();
      final now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> pool(
        String id,
        String name, {
        String contributor = 'owner',
        String device = 'Mac Studio',
        int max = 8,
        int running = 0,
        int age = 0,
        String? host,
        List<String> repositories = const [],
      }) => {
        'machineId': id,
        'name': name,
        'cwd': '/swarm/$id',
        'contributorId': contributor,
        'maxAgents': max,
        'paused': false,
        'hostMachineId': ?host,
        'observation': {
          'receivedAt': now - age,
          'resources': {'deviceType': device},
          'runningHarnessIds': [for (var i = 0; i < running; i++) 'h$i'],
          'readiness': {
            'checkouts': [
              for (final repository in repositories)
                {'folder': 'p1', 'repository': repository, 'git': true},
            ],
          },
        },
      };
      (f.connection.server.state['people'] as List).add({
        'id': 'diego',
        'email': 'diego@example.com',
        'role': 'collaborator',
      });
      f.connection.server.state['machines'] = [
        pool(
          'm',
          'Mac Studio',
          max: 32,
          running: 2,
          repositories: ['github.com/autonomous-ai/autonomous-os'],
        ),
        pool('laptop', 'Ken MacBook', device: 'MacBook Pro'),
        pool('rig', '2x 4090 Rig', contributor: 'diego', max: 16),
        pool('rig-team', 'Rig team', contributor: 'diego', host: 'rig'),
        pool('old', 'Old Mac', age: 10 * 60 * 1000),
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      final machines = box.integration!.leadMachines!;
      // Your own first, the unavailable ones included.
      expect(machines.map((m) => m.id), ['m', 'laptop', 'rig', 'old']);
      final studio = machines.first;
      expect(studio.name, 'Mac Studio');
      expect(studio.startable, isTrue);
      expect(studio.freeAgents, 30);
      expect(
        studio.has('git@github.com:autonomous-ai/autonomous-os.git'),
        isTrue,
      );
      expect(studio.maySleep, isFalse);
      expect(studio.folders, {
        'github.com/autonomous-ai/autonomous-os': '/swarm/m/p1',
      });
      expect(machines[1].maySleep, isTrue);
      expect(machines[1].unavailable, 'Not connected to this computer');
      // Its Team account's host has not said it can start a PM.
      expect(
        machines[2].unavailable,
        'Update Harness on 2x 4090 Rig to run a Product Manager there.',
      );
      expect(machines[3].online, isFalse);
      expect(bestLeadMachine(machines, null)?.id, 'm');
    },
  );

  test(
    'with its only machine full, New Project queues, and needs a remote',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'Mac Studio',
          'contributorId': 'owner',
          'maxAgents': 2,
          'paused': false,
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'runningHarnessIds': ['a', 'b'],
          },
        },
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      expect(box.integration!.leadMachines!.single.startable, isFalse);
      expect(box.leadQueued, isTrue);
      expect(await box.create(), NewHarnessOutcome.failed);
      // The Swarm clones the repo wherever it starts the PM.
      expect(
        box.error,
        'Choose a repo with a remote, so the Swarm can clone it for the Product Manager.',
      );
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      expect(f.connection.server.posts, isEmpty);
    },
  );

  Map<String, dynamic> studioPool({
    int available = 3,
    int max = 8,
    int running = 2,
    int age = 0,
  }) => {
    'machineId': 'm',
    'name': 'Mac Studio',
    'cwd': '/swarm/m',
    'contributorId': 'owner',
    'maxAgents': max,
    'availableSlots': available,
    'paused': false,
    'observation': {
      'receivedAt': DateTime.now().millisecondsSinceEpoch - age,
      'runningHarnessIds': [for (var i = 0; i < running; i++) 'h$i'],
    },
  };

  /// A machine row as the Swarm read sends it, with its derived figures.
  Map<String, dynamic> machineRow(
    String id,
    String name, {
    String contributor = 'diego',
    String? host,
    String kind = 'computer',
    int available = 4,
    bool lead = false,
    Map<String, dynamic> teamWork = const {'allowed': true},
  }) => {
    'machineId': id,
    'name': name,
    'cwd': '/swarm/$id',
    'contributorId': contributor,
    'maxAgents': 8,
    'availableSlots': available,
    'paused': false,
    'hostMachineId': ?host,
    'teamWork': teamWork,
    'observation': {
      'receivedAt': DateTime.now().millisecondsSinceEpoch,
      'sessionKind': kind,
      'runningHarnessIds': <String>[],
      if (lead) 'capabilities': ['leadStart'],
    },
  };

  void addDiego(SuperTabLaunchFixture f) =>
      (f.connection.server.state['people'] as List).add({
        'id': 'diego',
        'email': 'diego@example.com',
        'role': 'collaborator',
      });

  test('a teammate’s Mac takes the PM in its Team account', () async {
    final f = SuperTabLaunchFixture();
    addDiego(f);
    f.connection.server.state['machines'] = [
      machineRow('diego-mac', 'Diego MacBook'),
      machineRow(
        'diego-team',
        'Diego MacBook',
        host: 'diego-mac',
        kind: 'team',
        available: 3,
        lead: true,
      ),
    ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    final diego = box.integration!.leadMachines!
        .where((m) => m.id == 'diego-mac')
        .single;
    expect(diego.unavailable, isNull);
    expect(diego.startable, isTrue);
    expect(diego.freeAgents, 3);
    expect(diego.own, isFalse);
    expect(diego.native, isFalse);
    expect(diego.team, isTrue);
  });

  for (final (what, rows, reason) in [
    (
      'has no Team account',
      [machineRow('rig', '2x 4090 Rig', lead: true)],
      '2x 4090 Rig has no Harness Team account yet, so it runs only its owner’s projects.',
    ),
    (
      'fails its Team account’s privacy check',
      [
        machineRow('diego-mac', 'Diego MacBook'),
        machineRow(
          'diego-team',
          'Diego MacBook',
          host: 'diego-mac',
          kind: 'team',
          lead: true,
          teamWork: {
            'allowed': false,
            'code': 'PRIVACY_CHECK_FAILED',
            'reason': 'The Harness Team account on Diego MacBook is not private (sharing), so it runs only its owner’s projects.',
          },
        ),
      ],
      'The Harness Team account on Diego MacBook is not private (sharing), so it runs only its owner’s projects.',
    ),
    (
      'runs an older Harness',
      [
        machineRow('diego-mac', 'Diego MacBook'),
        machineRow(
          'diego-team',
          'Diego MacBook',
          host: 'diego-mac',
          kind: 'team',
        ),
      ],
      'Update Harness on Diego MacBook to run a Product Manager there.',
    ),
  ]) {
    test('a teammate’s machine that $what says why', () async {
      final f = SuperTabLaunchFixture();
      addDiego(f);
      f.connection.server.state['machines'] = rows;
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      final row = box.integration!.leadMachines!.where((m) => !m.own).single;
      expect(row.unavailable, reason);
      expect(row.startable, isFalse);
    });
  }

  test('your own machines come before a teammate’s with more room', () async {
    final f = SuperTabLaunchFixture();
    addDiego(f);
    f.connection.server.state['machines'] = [
      machineRow('diego-mac', 'Diego MacBook'),
      machineRow(
        'diego-team',
        'Diego MacBook',
        host: 'diego-mac',
        kind: 'team',
        available: 30,
        lead: true,
      ),
      machineRow('m', 'Mac Studio', contributor: 'owner', available: 2),
      // Yours, but this Desktop has no connection to it: the Swarm starts it.
      machineRow('far', 'Office Mini', contributor: 'owner', lead: true),
      machineRow('old', 'Old Mini', contributor: 'owner'),
    ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    final machines = box.integration!.leadMachines!;
    expect(machines.map((m) => m.id).take(3), ['m', 'far', 'diego-mac']);
    expect(machines.first.native, isTrue);
    final far = machines[1];
    expect((far.native, far.startable, far.team), (false, true, false));
    final old = machines.where((m) => m.id == 'old').single;
    expect(old.unavailable, 'Not connected to this computer');
  });

  /// Your machine knows the project folder's remote: an agent ran there.
  void knownRepo(SuperTabLaunchFixture f) =>
      f.app.machineStates['m']!.agents = [
        const Agent(
          id: 'earlier',
          name: 'Earlier',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'project',
            cwd: '/work/project',
            root: '/work/project',
            remote: 'git@github.com:autonomous-ai/lamp-os.git',
          ),
        ),
      ];

  List<Map> commandsOf(SuperTabLaunchFixture f, String type) => [
    for (final post in f.connection.server.posts)
      if ((post['command'] as Map)['type'] == type) post['command'] as Map,
  ];

  test(
    'New Project asks the Swarm to start the PM in a teammate’s Team account',
    () async {
      final f = SuperTabLaunchFixture();
      addDiego(f);
      knownRepo(f);
      f.connection.server.state['machines'] = [
        machineRow('diego-mac', 'Diego MacBook'),
        machineRow(
          'diego-team',
          'Diego MacBook',
          host: 'diego-mac',
          kind: 'team',
          lead: true,
        ),
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      box.chooseLeadMachine('diego-mac');
      expect(box.leadThroughSwarm, isTrue);
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final project = commandsOf(f, 'project.create').single;
      expect(project['brief'], 'Discuss the architecture.');
      final created = f.app.superTabs.peek(tabId)!.snapshot!.projects.last;
      // The PM the Swarm starts reads its request in its project's chat.
      final task = commandsOf(f, 'message.send').single;
      expect(task['conversationId'], created.leadConversationId);
      expect(task['text'], 'Discuss the architecture.');
      final start = commandsOf(f, 'lead.start').single;
      expect(start, {
        'type': 'lead.start',
        'projectId': created.id,
        'machineId': 'diego-mac',
        'engine': 'codex',
        'repositoryUrl': 'git@github.com:autonomous-ai/lamp-os.git',
      });
      expect(created.name, 'project');
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      expect(
        f.app.superTabs.peek(tabId)!.selectedId,
        created.leadConversationId,
      );
    },
  );

  test('with no machine free New Project queues the PM', () async {
    final f = SuperTabLaunchFixture();
    knownRepo(f);
    f.connection.server.state['machines'] = [
      machineRow('m', 'Mac Studio', contributor: 'owner', available: 0),
    ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    expect(box.leadQueued, isTrue);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    final start = commandsOf(f, 'lead.start').single;
    expect(start['machineId'], isNull);
    expect(start.containsKey('machineId'), isTrue);
    expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
  });

  test(
    'a refused Swarm start says why, and a retry posts the task once',
    () async {
      final f = SuperTabLaunchFixture();
      addDiego(f);
      knownRepo(f);
      f.connection.server.state['machines'] = [
        machineRow('diego-mac', 'Diego MacBook'),
        machineRow(
          'diego-team',
          'Diego MacBook',
          host: 'diego-mac',
          kind: 'team',
          lead: true,
        ),
      ];
      f.connection.server.leadRefusal = {
        'code': 'TEAM_ACCOUNT_REQUIRED',
        'message': 'Harness Team accounts take no work in this Swarm yet, so Diego MacBook runs only its owner’s projects.',
      };
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      box.chooseLeadMachine('diego-mac');
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(
        box.error,
        'Harness Team accounts take no work in this Swarm yet, so Diego MacBook runs only its owner’s projects.',
      );
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      expect(commandsOf(f, 'project.create'), hasLength(1));
      expect(commandsOf(f, 'message.send'), hasLength(1));
      final starts = [
        for (final post in f.connection.server.posts)
          if ((post['command'] as Map)['type'] == 'lead.start')
            post['operationId'],
      ];
      expect(starts, hasLength(2));
      expect(starts.toSet(), hasLength(2), reason: 'a refusal wrote nothing');
    },
  );

  test('files go to the PM’s chat with the task', () async {
    final f = SuperTabLaunchFixture();
    knownRepo(f);
    f.connection.server.state['machines'] = [
      machineRow('m', 'Mac Studio', contributor: 'owner', available: 0),
    ];
    SuperTabLaunch.uploadForTest = f.connection.server.upload;
    addTearDown(() => SuperTabLaunch.uploadForTest = null);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final files = HarnessAttachments()
      ..add([
        HarnessAttachment('plan.md', Uint8List.fromList([1, 2, 3])),
      ]);
    final box = await f.box(newProject: true, attachments: files);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    final created = f.app.superTabs.peek(tabId)!.snapshot!.projects.last;
    expect(
      f.connection.server.uploads.single['conversationId'],
      created.leadConversationId,
    );
    expect(commandsOf(f, 'message.send').single['attachmentIds'], [
      'attachment-1',
    ]);
  });

  test('free agents are the server’s count, not slots minus running', () async {
    final f = SuperTabLaunchFixture();
    // Eight slots and two running, but the server counts one free: its count
    // includes starts still pending and the Team account sharing the Mac.
    f.connection.server.state['machines'] = [studioPool(available: 1)];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    expect(box.integration!.leadMachines!.single.freeAgents, 1);
  });

  test('a server without availableSlots reads slots minus running', () async {
    final f = SuperTabLaunchFixture();
    // Eight slots, three harnesses running (a Buddy among them still holds
    // its slot): five can start, which is what the person is told.
    final pool = studioPool(running: 3)..remove('availableSlots');
    f.connection.server.state['machines'] = [pool];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    expect(box.integration!.leadMachines!.single.freeAgents, 5);
  });

  for (final (change, message) in [
    ('fills up', 'Mac Studio has no free agents. Choose another machine.'),
    ('goes offline', 'Mac Studio is offline. Choose another machine.'),
  ]) {
    test(
      'a machine that $change after the form opened is refused at submit',
      () async {
        final f = SuperTabLaunchFixture();
        f.connection.server.state['machines'] = [studioPool()];
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
        final box = await f.box(newProject: true);
        expect(box.integration!.leadMachines!.single.startable, isTrue);
        f.connection.server.state['machines'] = [
          change == 'fills up'
              ? studioPool(available: 0)
              : studioPool(age: 10 * 60 * 1000),
        ];
        expect(await box.create(), NewHarnessOutcome.failed);
        expect(box.error, message);
        expect(
          f.connection.calls.where((c) => c.$1 == 'agent_create'),
          isEmpty,
        );
      },
    );
  }

  test('a paused Swarm lists no machine as taking work', () async {
    final f = SuperTabLaunchFixture();
    f.connection.server.state['machines'] = [studioPool()];
    f.connection.server.state['paused'] = true;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    for (final machine in box.integration!.leadMachines!) {
      expect(machine.startable, isFalse, reason: machine.id);
      expect(machine.unavailable, 'New work is paused in this Swarm');
    }
  });

  test(
    'New Project reads the open Swarm instead of loading it again',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['machines'] = [studioPool()];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      await (await f.app.superTabs.open(tabId)).refresh();
      int partsReads() => f.connection.calls
          .where((c) => '${c.$2['path']}'.endsWith('/parts'))
          .length;
      final before = partsReads();
      final box = await f.box(newProject: true);
      expect(box.integration!.leadMachines!.first.id, 'm');
      expect(partsReads(), before);
    },
  );

  test('the Swarm’s model list rules out what it turns off', () async {
    final f = SuperTabLaunchFixture();
    f.connection.server.state['machines'] = [studioPool()];
    // As GET .../routing-policy answers (backend store.ts tabPolicy).
    f.connection.server.routingPolicy = {
      'policy': {
        'version': 1,
        'models': [
          {
            'engine': 'claude',
            'model': 'opus',
            'effort': 'high',
            'quality': 3,
            'cost': 3,
            'enabled': true,
          },
          {
            'engine': 'codex',
            'model': 'default',
            'effort': 'default',
            'quality': 3,
            'cost': 2,
            'enabled': false,
          },
          {
            'engine': 'claude',
            'model': 'sonnet',
            'effort': 'medium',
            'quality': 2,
            'cost': 2,
            'enabled': true,
          },
          {
            'engine': 'claude',
            'model': 'haiku',
            'effort': 'auto',
            'quality': 1,
            'cost': 1,
            'enabled': false,
          },
        ],
        'floor': {'low': 1, 'medium': 2, 'high': 3},
        'quotaReserve': 10,
        'notes': '',
        'localModels': {'quality': 1, 'enabled': false},
      },
      'warnings': <String>[],
      'overridden': <String>[],
      'override': null,
    };
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    final list = box.integration!.leadModels!;
    expect(list.refusal('claude', null), isNull);
    expect(list.refusal('claude', 'opus'), isNull);
    expect(
      list.refusal('claude', 'haiku'),
      'The Swarm’s model list turns off Claude haiku.',
    );
    expect(
      list.refusal('codex', null),
      'The Swarm’s model list has no enabled Codex model.',
    );
    expect(list.gridModels, isFalse);
  });

  test('without a model list nothing is ruled out', () async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    final list = box.integration!.leadModels!;
    expect(list.refusal('codex', null), isNull);
    expect(list.gridModels, isTrue);
  });

  test(
    'a Swarm that cannot be read at submit creates nothing and says so',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['machines'] = [studioPool()];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      f.connection.backendFailure = const WsRequestFailure(
        responseType: 'super_tabs_result',
        code: 'UNAVAILABLE',
        detail: 'The Swarm service is unavailable.',
        payload: {'status': 503},
      );
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(
        box.error,
        'Couldn’t check Mac Studio for the Product Manager: The Swarm service is unavailable. Try again.',
      );
      expect(
        f.connection.calls.where(
          (c) =>
              '${(c.$2['body'] as Map?)?['command']?['type']}' ==
              'project.create',
        ),
        isEmpty,
      );
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
    },
  );

  test('a PM’s forced worktree is not saved as the person’s setting', () async {
    final prepared = <ProjectFolderRequest>[];
    final f = SuperTabLaunchFixture(
      prepareFolder: (request) async {
        prepared.add(request);
        return '/work/project-pm';
      },
    );
    f.app.gitProjectReaderForTest = (_, _) async => {
      'isGit': true,
      'refreshed': true,
      'branch': 'main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main'},
      ],
    };
    f.app.agentPreference.successfulWorktree = false;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box(newProject: true);
    // What the form does when it opens: Desktop choices read Git there.
    box.useDesktopChoices(true);
    await Future<void>.delayed(Duration.zero);
    expect(box.isGitProject, isTrue);
    expect(box.worktree, isTrue);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(prepared.single.createsWorktree, isTrue);
    // Their next New Harness keeps their own setting.
    expect(f.app.agentPreference.successfulWorktree, isFalse);
  });

  test('a new Swarm keeps choosing among the person’s own machines', () async {
    final f = SuperTabLaunchFixture();
    final box = await f.box();
    expect(box.integration!.leadMachines, isNull);
  });

  test(
    'an unsupported project request keeps its draft and unlocks visibility',
    () async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(newProject: true);
      f.connection.backendFailureOnCommandsOnly = true;
      f.connection.backendFailure = const WsRequestFailure(
        responseType: 'super_tabs_result',
        code: 'VALIDATION_ERROR',
        detail: 'command.type: Invalid discriminator value. Expected machine.contribute',
        payload: {'status': 400},
      );
      final task = box.task;
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('Swarm service needs an update'));
      expect(box.error, isNot(contains('discriminator')));
      expect(box.task, task);
      expect(box.integration!.projectVisibilityLocked, isFalse);
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);

      f.connection.backendFailure = null;
      box.integration!.projectVisibility = 'private';
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      expect(
        f.app.superTabs.peek(tabId)!.snapshot!.projects.last.isPrivate,
        isTrue,
      );
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create'),
        hasLength(1),
      );
    },
  );

  test(
    'Swarm websocket refusals preserve authorization status and detail',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.backendFailure = const WsRequestFailure(
        responseType: 'super_tabs_result',
        code: 'FORBIDDEN',
        detail: 'You no longer have access to this Swarm.',
        payload: {'status': 403},
      );
      await expectLater(
        f.app.superTabMachineRequest('m', {'action': 'backend'}),
        throwsA(
          isA<SuperTabFailure>()
              .having((e) => e.code, 'code', 'FORBIDDEN')
              .having((e) => e.statusCode, 'status', 403)
              .having(
                (e) => e.message,
                'message',
                'You no longer have access to this Swarm.',
              ),
        ),
      );
    },
  );

  test(
    'a lost project creation reply keeps its visibility and original receipt',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['name'] = 'Company';
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      f.connection.server.loseReply = true;
      final box = await f.box(newProject: true);
      box.integration!.projectVisibility = 'private';
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.integration!.projectVisibilityLocked, isTrue);
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      final resumed = await f.box(newProject: true);
      expect(resumed.integration!.projectVisibility, 'private');
      expect(resumed.integration!.projectVisibilityLocked, isTrue);
      expect(
        await resumed.create(),
        NewHarnessOutcome.created,
        reason: resumed.error,
      );
      final creations = f.connection.server.posts
          .where((p) => (p['command'] as Map)['type'] == 'project.create')
          .toList();
      expect(creations, hasLength(2));
      expect(creations[0], creations[1]);
      expect(f.app.superTabs.peek(tabId)!.snapshot!.projects, hasLength(2));
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create'),
        hasLength(1),
      );
    },
  );
  test('switching accounts while files are being sent closes the background writer', () async {
    final f = SuperTabLaunchFixture()..connection.changeAccountOnUpload = true;
    final files = HarnessAttachments()
      ..add([
        HarnessAttachment('design.png', Uint8List.fromList([1])),
      ]);
    final box = await f.box(engine: 'claude', attachments: files);
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.error, contains('account changed'));
    expect(f.connection.sentFiles, isEmpty);
    expect(f.connection.terminalCalls.where((c) => c.$1 == 'message'), isEmpty);
    expect(
      f.connection.terminalCalls.where((c) => c.$1 == 'terminal_close'),
      hasLength(1),
    );
  });

  test('a confirmed failed creation makes a reopened form editable', () async {
    final f = SuperTabLaunchFixture()..connection.loseCreate = true;
    expect(await (await f.box()).create(), NewHarnessOutcome.failed);
    f.connection.failCreation = true;
    final recovered = await f.box();
    expect(await recovered.create(), NewHarnessOutcome.failed);
    expect(recovered.error, contains('Fixture engine unavailable'));
    expect(recovered.checking, isFalse);
    f.connection.failCreation = false;
    expect(
      await recovered.create(),
      NewHarnessOutcome.created,
      reason: recovered.error,
    );
  });

  test(
    'account changes clear an already open conversation synchronously',
    () async {
      final server = ConversationServer()
        ..append('Only the first account can see this.');
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: server.request,
      )..bind('owner');
      addTearDown(client.dispose);
      final controller = await client.open('tab');
      await controller.refresh();
      expect(controller.messages('lead'), hasLength(1));
      client.bind('different');
      expect(controller.snapshot, isNull);
      expect(controller.messages('lead'), isEmpty);
      expect(controller.canWrite, isFalse);
    },
  );
  for (final engine in ['claude', 'codex']) {
    test(
      '$engine files reach the background harness before its first request without creating a pane',
      () async {
        final f = SuperTabLaunchFixture();
        final files = HarnessAttachments()
          ..add([
            HarnessAttachment('design.png', Uint8List.fromList([1, 2, 3])),
          ]);
        final box = await f.box(engine: engine, attachments: files);
        expect(
          await box.create(),
          NewHarnessOutcome.created,
          reason: box.error,
        );
        expect(f.connection.sentFiles.single, [1, 2, 3]);
        expect(
          f.connection.calls
              .firstWhere((c) => c.$1 == 'agent_create')
              .$2['swarmRole'],
          'lead',
        );
        expect(
          f.connection.calls
              .firstWhere((c) => c.$1 == 'agent_create')
              .$2['prompt'],
          isNull,
        );
        expect(
          f.connection.terminalCalls
              .singleWhere((c) => c.$1 == 'message')
              .$2['content'],
          contains('messages lead'),
        );
        expect(f.connection.terminalCalls.last.$1, 'terminal_close');
        expect(f.app.activeSwarm.panes, isEmpty);
        expect(
          f.store.values.keys.where(
            (key) => key.startsWith('super_tab.launch.'),
          ),
          isEmpty,
        );
      },
    );
  }

  test('a reopened launch retains its staged files and never launches another harness', () async {
    final f = SuperTabLaunchFixture()..connection.loseCreate = true;
    final files = HarnessAttachments()
      ..add([
        HarnessAttachment('design.png', Uint8List.fromList([9, 8])),
      ]);
    final first = await f.box(engine: 'claude', attachments: files);
    expect(await first.create(), NewHarnessOutcome.failed);
    final recovered = await f.box();
    // The inventory arrives independently of the lost creation response.
    f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
    expect(
      await recovered.create(),
      NewHarnessOutcome.created,
      reason: recovered.error,
    );
    expect(f.connection.sentFiles.single, [9, 8]);
    expect(
      f.connection.calls.where((c) => c.$1 == 'agent_create'),
      hasLength(1),
    );
  });

  test('uncertain files are kept for recovery and never pasted again automatically', () async {
    final f = SuperTabLaunchFixture()..connection.failFiles = true;
    final files = HarnessAttachments()
      ..add([
        HarnessAttachment('design.png', Uint8List.fromList([1])),
      ]);
    final first = await f.box(engine: 'claude', attachments: files);
    expect(await first.create(), NewHarnessOutcome.failed);
    f.connection.failFiles = false;
    final recovered = await f.box();
    expect(await recovered.create(), NewHarnessOutcome.failed);
    expect(recovered.error, contains('file delivery was interrupted'));
    expect(
      f.connection.terminalCalls.where(
        (c) => c.$1 == 'terminal_chunked_upload_begin',
      ),
      hasLength(1),
    );
    expect(f.connection.sentFiles, isEmpty);
    expect(
      f.store.values.keys.where((key) => key.startsWith('super_tab.launch.')),
      hasLength(1),
    );
    expect(recovered.needsAttachmentReview, isTrue);
    expect(
      await recovered.create(resendAttachments: true),
      NewHarnessOutcome.created,
      reason: recovered.error,
    );
    expect(f.connection.sentFiles.single, [1]);
    expect(
      f.connection.calls.where((c) => c.$1 == 'agent_create'),
      hasLength(1),
    );
  });
  for (final engine in ['codex', 'claude']) {
    test(
      '$engine lead uses the native form and joins without opening a terminal or another tab',
      () async {
        final f = SuperTabLaunchFixture()..connection.nativeName = 'hi';
        final initialTab = f.app.activeSwarmId;
        final box = await f.box(engine: engine);
        expect(box.actionLabel, 'New Swarm');
        expect(
          await box.create(),
          NewHarnessOutcome.created,
          reason: box.error,
        );
        final creates = f.connection.calls.where((c) => c.$1 == 'agent_create');
        expect(creates, hasLength(1));
        expect(creates.single.$2['engine'], engine);
        expect(f.connection.joins.single['command']['name'], 'Lead');
        expect(creates.single.$2['prompt'], contains('messages lead'));
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

  test(
    'a lead in a GitHub checkout shares its repository for other machines',
    () async {
      // The daemon's frame carries origin in its canonical form, without a scheme.
      final f = SuperTabLaunchFixture()
        ..connection.nativeProject = {
          'name': 'project',
          'cwd': '/work/project/mobile',
          'root': '/work/project',
          'remote': 'github.com/example/project',
        };
      final box = await f.box(engine: 'claude');
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      expect(f.connection.joins.single['command']['project'], {
        'cwd': '/work/project',
        'repositoryUrl': 'https://github.com/example/project',
      });
    },
  );

  for (final engine in ['claude', 'codex']) {
    test('a Desktop $engine Swarm worker gets the DEV role', () async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(engine: engine);
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final create = f.connection.calls
          .firstWhere((c) => c.$1 == 'agent_create')
          .$2;
      expect(create['swarmRole'], 'dev');
      expect(create['prompt'], contains('swarm-dev'));
    });
  }

  test(
    'a Desktop Builder starts with the existing project skill mode',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['projects'] = [
        {...projectFixture('lead', 'Company', 'lead'), 'skillMode': 'default'},
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box();
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final create = f.connection.calls
          .firstWhere((c) => c.$1 == 'agent_create')
          .$2;
      expect(create['swarmRole'], 'dev');
      expect(create['swarmSkillMode'], 'default');
    },
  );

  test(
    'a Desktop agent joining a custom project sends its chosen role id',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['projects'] = [
        {
          ...projectFixture('lead', 'Company', 'lead'),
          'skillSet': 'custom',
          'skillMode': 'default',
          'roles': [
            {
              'id': 'lead',
              'name': 'Product Manager',
              'kind': 'lead',
              'version': 'v1',
            },
            {
              'id': 'dev',
              'name': 'Engineer',
              'kind': 'builder',
              'version': 'v1',
            },
            {
              'id': 'review',
              'name': 'Reviewer',
              'kind': 'reviewer',
              'version': 'v1',
            },
          ],
        },
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box();
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      expect(f.connection.joins.single['command']['roleId'], 'dev');
    },
  );

  testWidgets('new agent form lets a custom project choose a reviewer role', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.state['projects'] = [
      {
        ...projectFixture('lead', 'Company', 'lead'),
        'skillSet': 'custom',
        'skillMode': 'default',
        'roles': [
          {
            'id': 'lead',
            'name': 'Product Manager',
            'kind': 'lead',
            'version': 'v1',
          },
          {'id': 'dev', 'name': 'Engineer', 'kind': 'builder', 'version': 'v1'},
          {
            'id': 'review',
            'name': 'Security Reviewer',
            'kind': 'reviewer',
            'version': 'v1',
          },
        ],
      },
    ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = (await tester.runAsync(() => f.box()))!;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 1200,
            height: 800,
            child: NewHarnessForm(
              controller: box,
              desktop: true,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('new-harness-role')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('new-harness-role')));
    await tester.pump();
    await tester.tap(find.text('Security Reviewer').last);
    await tester.pump();
    expect(box.integration!.roleId, 'review');
    expect(box.integration!.swarmRole, 'review');
    expect(
      await tester.runAsync(() => box.create()),
      NewHarnessOutcome.created,
      reason: box.error,
    );
    final create = f.connection.calls
        .firstWhere((entry) => entry.$1 == 'agent_create')
        .$2;
    expect(create['swarmRole'], 'review');
    expect(f.connection.joins.single['command']['roleId'], 'review');
  });

  test('switching away from Custom resets a pending Reviewer launch', () async {
    final f = SuperTabLaunchFixture();
    final project = {
      ...projectFixture('lead', 'Company', 'lead'),
      'skillSet': 'custom',
      'skillMode': 'default',
      'roles': [
        {'id': 'dev', 'name': 'Engineer', 'kind': 'builder', 'version': 'v1'},
        {
          'id': 'review',
          'name': 'Reviewer',
          'kind': 'reviewer',
          'version': 'v1',
        },
      ],
    };
    f.connection.server.state['projects'] = [project];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await f.box();
    box.integration!.chooseRole('review');
    project['skillSet'] = 'default';
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    final create = f.connection.calls
        .firstWhere((entry) => entry.$1 == 'agent_create')
        .$2;
    expect(create['swarmSkillMode'], 'default');
    expect(create['swarmRole'], 'dev');
    expect(f.connection.joins.single['command'], isNot(contains('roleId')));
  });

  testWidgets('recovering a removed role keeps the form readable', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.connection.server.state['projects'] = [
      {
        ...projectFixture('lead', 'Company', 'lead'),
        'skillSet': 'custom',
        'skillMode': 'default',
        'roles': [
          {
            'id': 'lead',
            'name': 'Product Manager',
            'kind': 'lead',
            'version': 'v1',
          },
          {'id': 'dev', 'name': 'Engineer', 'kind': 'builder', 'version': 'v1'},
        ],
      },
    ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    f.store.values['super_tab.launch.owner.${f.app.activeSwarmId}.lead'] =
        jsonEncode({
          'operationId': 'saved-operation',
          'joinId': 'saved-join',
          'tabId': tabId,
          'conversationId': 'lead',
          'lead': false,
          'roleId': 'removed',
          'roleKind': 'builder',
          'phase': 'starting',
        });
    final box = (await tester.runAsync(() => f.box()))!;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NewHarnessForm(
            controller: box,
            desktop: true,
            onClose: () {},
            onCreated: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('new-harness-role')), findsOneWidget);
  });

  test(
    'a role changed before launch is rejected before native creation',
    () async {
      final f = SuperTabLaunchFixture();
      final project = {
        ...projectFixture('lead', 'Company', 'lead'),
        'skillSet': 'custom',
        'skillMode': 'default',
        'roles': [
          {
            'id': 'lead',
            'name': 'Product Manager',
            'kind': 'lead',
            'version': 'v1',
          },
          {'id': 'dev', 'name': 'Engineer', 'kind': 'builder', 'version': 'v1'},
        ],
      };
      f.connection.server.state['projects'] = [project];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box();
      project['roles'] = [
        {
          'id': 'lead',
          'name': 'Product Manager',
          'kind': 'lead',
          'version': 'v2',
        },
        {'id': 'dev', 'name': 'Reviewer', 'kind': 'reviewer', 'version': 'v2'},
      ];
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_create'),
        isEmpty,
      );
    },
  );

  test(
    'reopened unfinished form replaces a removed role with an available one',
    () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.state['projects'] = [
        {
          ...projectFixture('lead', 'Company', 'lead'),
          'skillSet': 'custom',
          'skillMode': 'default',
          'roles': [
            {
              'id': 'lead',
              'name': 'Product Manager',
              'kind': 'lead',
              'version': 'v1',
            },
            {
              'id': 'dev',
              'name': 'Engineer',
              'kind': 'builder',
              'version': 'v1',
            },
          ],
        },
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      f.store.values['super_tab.launch.owner.${f.app.activeSwarmId}.lead'] =
          jsonEncode({
            'operationId': 'saved-operation',
            'joinId': 'saved-join',
            'tabId': tabId,
            'conversationId': 'lead',
            'lead': false,
            'roleId': 'removed',
            'roleKind': 'builder',
          });
      final box = await f.box();
      expect(box.integration!.roleId, 'dev');
    },
  );

  test('account switch during role lookup closes the old launch', () async {
    final f = SuperTabLaunchFixture()
      ..connection.changeAccountOnProjectRead = true;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    await expectLater(
      f.box(),
      throwsA(
        isA<SuperTabFailure>().having(
          (failure) => failure.code,
          'code',
          'ACCOUNT_CHANGED',
        ),
      ),
    );
  });

  test('the lead prompt routes before starting or assigning work', () async {
    final f = SuperTabLaunchFixture()..connection.nativeName = 'hi';
    final box = await f.box(engine: 'claude');
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    final prompt =
        f.connection.calls
                .firstWhere((c) => c.$1 == 'agent_create')
                .$2['prompt']
            as String;
    expect(
      prompt,
      contains('Route only to start an agent or assign work, never your own'),
    );
    expect(prompt, contains('route GROUP'));
    expect(prompt, contains('size (small, medium or large)'));
    expect(prompt, contains('routeDecisionId'));
    expect(prompt, contains('overrideReason'));
    expect(prompt, contains('NO_CANDIDATE'));
    expect(prompt, contains('reuse, keep or stop'));
    expect(prompt, contains('prefer stop'));
    expect(prompt.length, lessThanOrEqualTo(2000));
  });

  test('a new Lead starts Claude Code or Codex; other agents stay open to the rest', () async {
    final f = SuperTabLaunchFixture();
    final lead = await f.box(engine: 'opencode');
    expect(lead.integration!.engines, ['claude', 'codex']);
    expect(lead.compatibleEngines, ['claude', 'codex']);
    expect(lead.engine, isIn(['claude', 'codex']));
    lead.focusField(NewHarnessField.harness);
    expect(lead.options.map((option) => option.id), ['claude', 'codex']);
    // Opened beside a Store harness's OpenCode pane, it inherits that agent and still gives way.
    final inherited = await f.box(
      engine: 'opencode',
      harnessId: 'store-harness',
    );
    expect(inherited.engine, isIn(['claude', 'codex']));

    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final member = NewHarnessController(
      f.app,
      machineId: 'm',
      engine: 'opencode',
      folder: '/work/project',
      integration: await SuperTabLaunch.open(f.app, f.app.activeSwarm, 'lead'),
    );
    addTearDown(member.dispose);
    await Future<void>.delayed(Duration.zero);
    expect(member.integration!.engines, isNull);
    expect(member.compatibleEngines, contains('opencode'));
    expect(member.engine, 'opencode');
  });

  test('the lead prompt asks for short plain replies, answered once', () async {
    final f = SuperTabLaunchFixture();
    final box = await f.box(engine: 'claude');
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    final prompt =
        f.connection.calls
                .firstWhere((c) => c.$1 == 'agent_create')
                .$2['prompt']
            as String;
    expect(prompt, contains('helpful colleague'));
    expect(prompt, contains('under 150 words'));
    expect(prompt, contains('UNIQUE_OPERATION_ID [--reply-to MESSAGE_ID]`'));
    expect(prompt, contains('answer each message once'));
    expect(prompt, contains('do not post again'));
    expect(prompt, isNot(contains('Report exact revisions')));
    expect(prompt, isNot(contains('email addresses')));
  });

  test('lost join acknowledgement retries the same contribution without a second native launch', () async {
    final f = SuperTabLaunchFixture()..connection.loseJoin = true;
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
      final f = SuperTabLaunchFixture()..connection.loseCreate = true;
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
