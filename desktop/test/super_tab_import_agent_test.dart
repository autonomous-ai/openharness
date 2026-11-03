import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/import_agent.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// This Mac's daemon: answers `agent_handoff_prepare` with [handoff].
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// Every request, by the machine asked, type and payload.
  final calls = <(String, String, Map<String, dynamic>)>[];

  /// The machine the app asks next: set by the fixture's connection.
  String asked = '';
  Map<String, dynamic> Function(Map<String, dynamic> payload) handoff = (_) => {
    'error': 'UNSUPPORTED',
  };

  /// Thrown instead of an answer: a daemon that does not answer in time.
  Object? fails;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((asked, type, Map.of(payload)));
    if (type == 'agent_handoff_prepare') {
      if (fails case final failure?) throw failure;
      return handoff(payload);
    }
    return const {};
  }

  /// Answers as a daemon that wrote the handoff of the agent it was asked
  /// about into [folder], as the Change agent handoff does
  /// (cli lib/agentHandoff.ts).
  void writes(
    Directory folder, {
    String record = '# Handoff\nWorking on the login fix.\n',
    String? transcript = '## Turn 1\nFix the login.\n',
    String? file,
  }) => handoff = (payload) {
    final base = '${payload['agentId']}-${payload['changeId']}';
    final dir = Directory('${folder.path}/.harness/handoff')
      ..createSync(recursive: true);
    File('${dir.path}/$base.md').writeAsStringSync(record);
    if (transcript != null) {
      File('${dir.path}/$base.transcript.md').writeAsStringSync(transcript);
    }
    return {
      'agentId': payload['agentId'],
      'file': file ?? '.harness/handoff/$base.md',
      'gitRepo': true,
      'cwd': folder.path,
      'degraded': <String>[],
    };
  };
}

/// An agent as this Mac's daemon lists it.
Agent _agent(
  String id, {
  String engine = 'claude',
  String status = 'active',
  String? sessionId = 'session',
  String? startedBy,
  String? parentAgentId,
  String cwd = '/work/api',
  String updatedAt = '2026-11-03T08:00:00.000Z',
}) => Agent.fromJson({
  'id': id,
  'name': 'fix-$id',
  'engine': engine,
  'status': status,
  'sessionId': ?sessionId,
  'startedBy': ?startedBy,
  'parentAgentId': ?parentAgentId,
  'project': {'name': 'api', 'cwd': cwd},
  'updatedAt': updatedAt,
  'terminal': {'available': true},
});

class ImportFixture {
  ImportFixture() {
    app = createApp(
      connected: true,
      connectionForTest: (id) => daemon..asked = id,
    );
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.machineStates['m']!.localOnly = true;
    for (final machine in const [
      // This Mac's Harness Team account, on the same account.
      Machine(
        machineId: 'team-m',
        authMode: MachineAuthMode.remote,
        name: 'Harness Team',
        sessionKind: 'team',
      ),
      // Another of the owner's computers.
      Machine(
        machineId: 'laptop',
        authMode: MachineAuthMode.remote,
        name: 'Laptop',
      ),
      // Someone else's computer, shared with the owner.
      Machine(
        machineId: 'shared',
        authMode: MachineAuthMode.remote,
        name: 'Mira',
        machineShare: MachineShare(
          ownerName: 'mira',
          ownerEmail: 'mira@example.com',
          via: 'person',
          added: true,
        ),
      ),
    ]) {
      app.machines = [...app.machines, machine];
      app.machineStates[machine.machineId] = MachineState(machine)
        ..agents = [_agent('${machine.machineId}-agent')];
    }
    server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
    server.state['machines'] = <dynamic>[macPool, teamPool];
  }

  final daemon = _Daemon();
  late final AppNotifier app;
  final server = ConversationServer();
  late final c = server.controller();

  final macPool = <String, dynamic>{
    'machineId': 'm',
    'name': 'Studio',
    'contributorId': 'owner',
    'scope': 'swarm',
    'cwd': '/Users/owner/.harness/swarm/tab',
  };
  final teamPool = <String, dynamic>{
    'machineId': 'team-m',
    'name': 'Studio',
    'contributorId': 'owner',
    'hostMachineId': 'm',
    'scope': 'swarm',
    'cwd': '/Users/Shared/harness-team/swarm/tab',
    'observation': {'receivedAt': 1},
  };

  /// This Mac's agents, as its daemon lists them.
  set agents(List<Agent> agents) => app.machineStates['m']!.agents = agents;

  Future<void> start() => c.refresh();

  void dispose() {
    c.dispose();
    app.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<ImportFixture> fixture() async {
    final f = ImportFixture();
    addTearDown(f.dispose);
    await f.start();
    return f;
  }

  group('which agents can be imported', () {
    test('only this Mac\'s own Claude Code and Codex agents, running or '
        'resumable, that no Swarm lists and the Swarm did not start', () async {
      final f = await fixture();
      f.agents = [
        _agent('claude', updatedAt: '2026-11-03T08:00:00.000Z'),
        _agent('codex', engine: 'codex', updatedAt: '2026-11-03T09:00:00.000Z'),
        _agent('opencode', engine: 'opencode'),
        _agent('terminal', engine: 'terminal'),
        // Listed by this Swarm: a teammate's agent and a Buddy.
        _agent('listed'),
        _agent('buddy'),
        // Started by the Swarm: an agent started it, from no harness here.
        _agent('swarm-started', startedBy: 'agent'),
        // Started by one of this Mac's own harnesses: the person's.
        _agent('child', startedBy: 'agent', parentAgentId: 'claude'),
        _agent('paused', status: 'stopped'),
        _agent('gone', status: 'stopped', sessionId: null),
      ];
      (f.server.state['agents'] as List).addAll([
        {
          'id': 'agent-listed',
          'projectId': 'lead',
          'name': 'Engineer',
          'machineId': 'm',
          'harnessId': 'listed',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
        {
          'id': 'agent-buddy',
          'projectId': 'lead',
          'name': 'Buddy',
          'buddyOf': {'personId': 'owner', 'generation': 'fixture'},
          'machineId': 'm',
          'harnessId': 'buddy',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ]);
      await f.c.refresh();

      final offered = importableAgents(f.app, f.c);
      // Newest first, all on this Mac.
      expect(
        [for (final a in offered) a.agent.id],
        ['codex', 'claude', 'child', 'paused'],
      );
      expect(offered.map((a) => a.machineId).toSet(), {'m'});
    });

    test('never an agent of the Team account, another computer or another '
        'person', () async {
      final f = await fixture();
      f.agents = [];
      expect(importableAgents(f.app, f.c), isEmpty);
    });

    test('nothing when this computer is not running Harness', () async {
      final f = await fixture();
      f.agents = [_agent('claude')];
      f.app.machineStates['m']!.localOnly = false;
      expect(importableAgents(f.app, f.c), isEmpty);
      expect(importUnavailable(f.app, f.c), isNotNull);
    });
  });

  group('where the new agent runs', () {
    test('this Mac\'s Team account in the Swarm: import is offered', () async {
      final f = await fixture();
      expect(importUnavailable(f.app, f.c), isNull);
    });

    test('no Team account for this Mac in the Swarm says how to set one up, '
        'and starts nowhere else', () async {
      final f = await fixture();
      f.server.state['machines'] = <dynamic>[f.macPool];
      await f.c.refresh();
      expect(importUnavailable(f.app, f.c), kImportNeedsTeamAccount);
      // A Team account of another Mac is not this Mac's.
      f.server.state['machines'] = <dynamic>[
        f.macPool,
        {...f.teamPool, 'hostMachineId': 'laptop'},
      ];
      await f.c.refresh();
      expect(importUnavailable(f.app, f.c), kImportNeedsTeamAccount);
    });

    test('a Team account that takes no work says why', () async {
      final f = await fixture();
      f.teamPool['teamWork'] = {
        'allowed': false,
        'code': 'PRIVACY_CHECK_FAILED',
        'reason': 'Its Team account failed the privacy check.',
      };
      await f.c.refresh();
      expect(
        importUnavailable(f.app, f.c),
        'Its Team account failed the privacy check.',
      );
    });

    test('this Mac not in the Swarm says to add it', () async {
      final f = await fixture();
      f.server.state['machines'] = <dynamic>[];
      await f.c.refresh();
      expect(importUnavailable(f.app, f.c), kImportNeedsThisMac);
    });
  });

  group('the handoff preview', () {
    late Directory folder;
    setUp(() async {
      folder = await Directory.systemTemp.createTemp('import-agent-');
      addTearDown(() => folder.delete(recursive: true));
    });

    test('this Mac\'s daemon prepares the Change agent handoff of the agent, '
        'and its two files are read whole', () async {
      final f = await fixture();
      f.agents = [_agent('fix', engine: 'codex', cwd: folder.path)];
      f.daemon.writes(folder, record: '# Handoff\nkey ****\n');
      final agent = importableAgents(f.app, f.c).single;

      final handoff = await prepareImportHandoff(f.app, agent);

      final (machine, type, payload) = f.daemon.calls.single;
      expect((machine, type), ('m', 'agent_handoff_prepare'));
      expect(payload['agentId'], 'fix');
      expect(payload['targetEngine'], 'codex');
      expect(payload['changeId'], matches(RegExp(r'^[0-9a-f]{32}$')));
      final change = payload['changeId'];
      expect(handoff.record.name, 'fix-$change.md');
      expect(handoff.record.text, '# Handoff\nkey ****\n');
      expect(handoff.record.size, 18);
      expect(handoff.transcript.name, 'fix-$change.transcript.md');
      expect(handoff.transcript.text, '## Turn 1\nFix the login.\n');
      expect(handoff.transcript.size, 25);
      // Nothing has left this Mac.
      expect(f.server.posts, isEmpty);
      expect(f.server.uploads, isEmpty);

      // Each preview is a new change.
      await prepareImportHandoff(f.app, agent);
      expect(f.daemon.calls.last.$3['changeId'], isNot(change));
    });

    for (final (why, reply, words) in [
      (
        'a held conversation',
        {'error': 'IDENTITY_UNAVAILABLE', 'held': true},
        'not confirmed yet',
      ),
      ('a busy daemon', {'error': 'BUSY'}, 'took too long'),
      ('an older daemon', {'error': 'UNSUPPORTED'}, 'Update Harness'),
      (
        'nothing to hand off',
        {'agentId': 'fix', 'file': null, 'gitRepo': true, 'degraded': []},
        'no conversation',
      ),
    ]) {
      test('$why says why and offers nothing to import', () async {
        final f = await fixture();
        f.agents = [_agent('fix', cwd: folder.path)];
        f.daemon.handoff = (_) => {...reply, 'cwd': folder.path};
        await expectLater(
          prepareImportHandoff(f.app, importableAgents(f.app, f.c).single),
          throwsA(
            isA<ImportFailure>()
                .having((e) => e.step, 'step', ImportStep.prepare)
                .having((e) => e.message, 'message', contains(words)),
          ),
        );
      });
    }

    test('a reply naming another file is refused', () async {
      final f = await fixture();
      f.agents = [_agent('fix', cwd: folder.path)];
      f.daemon.writes(folder, file: '../../.ssh/id_rsa');
      await expectLater(
        prepareImportHandoff(f.app, importableAgents(f.app, f.c).single),
        throwsA(isA<ImportFailure>()),
      );
    });

    test('a missing transcript says the files could not be read', () async {
      final f = await fixture();
      f.agents = [_agent('fix', cwd: folder.path)];
      f.daemon.writes(folder, transcript: null);
      await expectLater(
        prepareImportHandoff(f.app, importableAgents(f.app, f.c).single),
        throwsA(
          isA<ImportFailure>().having(
            (e) => e.message,
            'message',
            contains('Could not read'),
          ),
        ),
      );
    });

    test('a daemon that does not answer says so', () async {
      final f = await fixture();
      f.agents = [_agent('fix', cwd: folder.path)];
      f.daemon.fails = TimeoutException('no answer');
      await expectLater(
        prepareImportHandoff(f.app, importableAgents(f.app, f.c).single),
        throwsA(
          isA<ImportFailure>().having(
            (e) => e.message,
            'message',
            contains('took too long'),
          ),
        ),
      );
    });

    test(
      'what is previewed is what is shared: the files are read once',
      () async {
        final f = await fixture();
        f.agents = [_agent('fix', cwd: folder.path)];
        f.daemon.writes(folder);
        final handoff = await prepareImportHandoff(
          f.app,
          importableAgents(f.app, f.c).single,
        );
        File('${folder.path}/.harness/handoff/${handoff.record.name}')
            .writeAsStringSync('changed after the preview');
        expect(handoff.record.text, '# Handoff\nWorking on the login fix.\n');
      },
    );
  });
}
