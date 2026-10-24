import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp, MemoryStore;

const tabId = '0123456789abcdef01234567';

class SuperTabFixtureConnection extends WsConn {
  SuperTabFixtureConnection(this.store)
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
  bool failNative = false;
  bool failResume = false;
  bool nativeSurface = false;
  bool failFiles = false, failCreation = false, changeAccountOnUpload = false;
  bool holdPrepareContribution = false;
  late AppNotifier app;
  final sentFiles = <Uint8List>[];
  final terminalCalls = <(String, Map<String, dynamic>)>[];
  static const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  Map<String, dynamic>? native;
  String nativeName = 'Lead';

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
      if (payload['action'] == 'wake') return {'ok': true};
      if (payload['action'] == 'prepareContribution') {
        if (holdPrepareContribution) return {'ok': true, 'state': 'preparing'};
        return {
          'ok': true,
          'state': 'ready',
          'cwd': '/work/project',
          'engines': ['claude', 'codex', 'pi'],
          'maxAgents': 4,
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
            'name': command['name'],
            'contributorId': 'owner',
            'configuration': command['configuration'],
          });
          final group = (server.state['conversations'] as List)
              .cast<Map>()
              .firstWhere((g) => g['id'] == command['conversationId']);
          (group['agentIds'] as List).add('lead-agent');
          if (command['lead'] == true) group['leadId'] = 'lead-agent';
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
        'name': nativeName,
        'engine': payload['engine'],
        'closeSupported': true,
        'terminal': {'available': true},
        'project': {'cwd': '/work/project', 'label': 'Project'},
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

class SuperTabLaunchFixture {
  SuperTabLaunchFixture() {
    connection = SuperTabFixtureConnection(store);
    app = createApp(
      store: store,
      connectionForTest: (_) => connection,
      connected: true,
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
    addTearDown(app.dispose);
  }
  final store = MemoryStore();
  late final AppNotifier app;
  late final SuperTabFixtureConnection connection;

  Future<NewHarnessController> box({
    String engine = 'codex',
    HarnessAttachments? attachments,
  }) async {
    final integration = await SuperTabLaunch.open(app, app.activeSwarm, 'lead');
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: engine,
      folder: '/work/project',
      task: 'Discuss the architecture.',
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
              .$2['prompt'],
          isNull,
        );
        expect(
          f.connection.terminalCalls
              .singleWhere((c) => c.$1 == 'message')
              .$2['content'],
          contains('Discuss the architecture.'),
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
        expect(box.actionLabel, 'New Super Tab');
        expect(
          await box.create(),
          NewHarnessOutcome.created,
          reason: box.error,
        );
        final creates = f.connection.calls.where((c) => c.$1 == 'agent_create');
        expect(creates, hasLength(1));
        expect(creates.single.$2['engine'], engine);
        expect(f.connection.joins.single['command']['name'], 'Lead');
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

  test('the lead prompt routes before starting or assigning work', () async {
    final f = SuperTabLaunchFixture()..connection.nativeName = 'hi';
    final box = await f.box(engine: 'claude');
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    final prompt =
        f.connection.calls
                .firstWhere((c) => c.$1 == 'agent_create')
                .$2['prompt']
            as String;
    expect(prompt, contains('route GROUP'));
    expect(prompt, contains('routeDecisionId'));
    expect(prompt, contains('overrideReason'));
    expect(prompt, contains('NO_CANDIDATE'));
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
    expect(prompt, contains('like a helpful colleague'));
    expect(prompt, contains('under about 150 words'));
    expect(prompt, contains('UNIQUE_OPERATION_ID [--reply-to MESSAGE_ID]`'));
    expect(prompt, contains('post with --reply-to MESSAGE_ID'));
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
